"""
Wildcard Resolver — SD WebUI Extension (reForge / AUTOMATIC1111)
Provides the interactive ~~wildcard~~ double-click popup in the prompt box,
plus the /wildcard-resolver/ API endpoints the JS popup depends on.

process() hook: reads the ||WRC||chain||/WRC|| injected by the JS, parses
the pre-resolved wildcard choices, and overrides dynamic-prompts so those
exact choices are used during generation (enabling the lock feature).
"""

import gradio as gr
import modules.scripts as scripts
import os
import re
import threading
import json
from pathlib import Path


# ---------------------------------------------------------------------------
# Wildcard file discovery
# ---------------------------------------------------------------------------

def find_wildcard_file(name, wc_dir):
    for root, dirs, files in os.walk(wc_dir):
        for f in files:
            if Path(f).stem.lower() == name.lower() and f.endswith(".txt"):
                return os.path.join(root, f)
    return None


def read_wildcard_entries(filepath):
    try:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except Exception:
        return []
    seen = set()
    result = []
    for line in lines:
        s = line.strip()
        if s and s not in seen:
            seen.add(s)
            result.append(s)
    return result


def get_wc_dir():
    config_path = Path.home() / ".wildcard_editor" / "config.json"
    if config_path.exists():
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            d = cfg.get("wc_dir", "")
            if d and Path(d).is_dir():
                return d
        except Exception:
            pass
    try:
        ext_dir = Path(__file__).resolve().parent.parent
        candidate = ext_dir.parent / "sd-dynamic-prompts" / "wildcards"
        if candidate.is_dir():
            return str(candidate)
    except Exception:
        pass
    return str(Path.home())


# ---------------------------------------------------------------------------
# Chain parsing
# ---------------------------------------------------------------------------

CHAIN_START = "||WRC||"
CHAIN_END   = "||/WRC||"
WC_RE       = re.compile(r'~~([^\s]+?)~~')


def _strip_annotations(s):
    """Remove ~~wc~~<<...>> annotations, returning just the final resolved text."""
    result = ""
    i = 0
    while i < len(s):
        m = WC_RE.search(s, i)
        if not m:
            result += s[i:]
            break
        result += s[i:m.start()]
        after = m.end()
        if after < len(s) - 1 and s[after] == '<' and s[after + 1] == '<':
            depth = 0; j = after; close = -1
            while j < len(s) - 1:
                if s[j] == '<' and s[j+1] == '<':   depth += 1; j += 2
                elif s[j] == '>' and s[j+1] == '>':
                    depth -= 1
                    if depth == 0: close = j; break
                    j += 2
                else: j += 1
            if close == -1:
                result += s[m.start():]
                break
            result += _strip_annotations(s[after + 2:close])
            i = close + 2
        else:
            result += m.group(0)
            i = after
    return result


def parse_chain_resolutions(chain_str):
    """
    Parse a ~~wc~~<<chosen>> annotated chain string into a dict of:
        { wc_name: raw_replacement_text }
    where raw_replacement_text still contains ~~sub~~ tokens (not yet resolved),
    matching exactly what dynamic-prompts' _get_wildcard_choice_generator yields.
    First occurrence of each name wins (outermost).
    """
    results = {}

    def parse_seg(s, pos):
        while pos < len(s):
            m = WC_RE.search(s, pos)
            if not m:
                break
            name  = m.group(1)
            after = m.end()
            if after < len(s) - 1 and s[after] == '<' and s[after + 1] == '<':
                depth = 0; i = after; close = -1
                while i < len(s) - 1:
                    if s[i] == '<' and s[i+1] == '<':   depth += 1; i += 2
                    elif s[i] == '>' and s[i+1] == '>':
                        depth -= 1
                        if depth == 0: close = i; break
                        i += 2
                    else: i += 1
                if close == -1:
                    pos = after
                    continue
                inner = s[after + 2:close]
                # The raw replacement is inner with sub-annotations stripped
                # to leave ~~sub~~ tokens intact (as yielded by the wildcard file)
                raw = _strip_annotations_keep_wc(inner)
                if name not in results:
                    results[name] = raw
                parse_seg(inner, 0)
                pos = close + 2
            else:
                pos = after

    parse_seg(chain_str, 0)
    return results


def _strip_annotations_keep_wc(s):
    """
    Like _strip_annotations but keeps ~~wc~~ tokens — strips only the
    <<...>> annotation bodies, reconstructing the raw wildcard file line.
    e.g. "~~subwildcard2~~<<contents>> text ~~subwildcard3~~<<contents>>"
      -> "~~subwildcard2~~ text ~~subwildcard3~~"
    """
    result = ""
    i = 0
    while i < len(s):
        m = WC_RE.search(s, i)
        if not m:
            result += s[i:]
            break
        result += s[i:m.start()] + m.group(0)  # keep the ~~token~~
        after = m.end()
        if after < len(s) - 1 and s[after] == '<' and s[after + 1] == '<':
            depth = 0; j = after; close = -1
            while j < len(s) - 1:
                if s[j] == '<' and s[j+1] == '<':   depth += 1; j += 2
                elif s[j] == '>' and s[j+1] == '>':
                    depth -= 1
                    if depth == 0: close = j; break
                    j += 2
                else: j += 1
            if close == -1:
                i = after
                continue
            i = close + 2   # skip the <<...>> annotation
        else:
            i = after
    return result


# ---------------------------------------------------------------------------
# dynamic-prompts override patch
# ---------------------------------------------------------------------------

_override_lock   = threading.Lock()
_active_override = {}   # { wc_name: raw_value } for current generation
_orig_get_wildcard_random = None
_orig_get_wildcard_base   = None


def _install_override_patch():
    """Patch RandomSampler._get_wildcard to use _active_override when set."""
    global _orig_get_wildcard_random, _orig_get_wildcard_base
    try:
        from dynamicprompts.samplers.random import RandomSampler
        from dynamicprompts.samplers.base   import Sampler
    except ImportError:
        print("[WildcardResolver] sd-dynamic-prompts not found — override patch skipped")
        return

    if getattr(RandomSampler._get_wildcard, '_wr_patched', False):
        return  # already patched

    # Capture whatever is currently on RandomSampler._get_wildcard.
    # If wildcard-tracer loaded first, this is the tracer's patched version.
    _orig_get_wildcard_random = RandomSampler._get_wildcard

    # Try to grab the tracer's RECORDER now, at patch-install time.
    # Method 1: extract from the closure of the tracer's patched function,
    #           which closes over `recorder = self` (the RECORDER instance).
    #           This works regardless of what module key A1111 used.
    # Method 2: scan sys.modules for any module with a RECORDER attribute.
    _tracer_recorder = None
    try:
        import sys, inspect
        # Method 1: closure extraction from _orig (the tracer's patched function)
        orig_fn = _orig_get_wildcard_random
        if hasattr(orig_fn, '__closure__') and orig_fn.__closure__:
            for cell in orig_fn.__closure__:
                try:
                    obj = cell.cell_contents
                    if hasattr(obj, 'record') and hasattr(obj, 'start') and hasattr(obj, 'snapshot'):
                        _tracer_recorder = obj
                        print("[WildcardResolver] Found tracer RECORDER via closure extraction")
                        break
                except ValueError:
                    pass  # empty cell

        # Method 2: sys.modules scan as fallback
        if _tracer_recorder is None:
            for _key in list(sys.modules.keys()):
                _mod = sys.modules.get(_key)
                if _mod and hasattr(_mod, 'RECORDER') and 'wildcard_tracer' in _key:
                    _tracer_recorder = _mod.RECORDER
                    print(f"[WildcardResolver] Found tracer RECORDER via sys.modules[{_key!r}]")
                    break

        if _tracer_recorder is None:
            print("[WildcardResolver] Tracer RECORDER not found at patch time — "
                  "will attempt per-call lookup")
    except Exception as _e:
        print(f"[WildcardResolver] Tracer lookup error: {_e}")

    def overriding_get_wildcard(self_s, command, context):
        with _override_lock:
            overrides = dict(_active_override)

        if not overrides:
            yield from _orig_get_wildcard_random(self_s, command, context)
            return

        # Resolve the wildcard path to get its name
        try:
            wildcard_path = next(iter(context.sample_prompts(command.wildcard, 1))).text
        except Exception:
            yield from _orig_get_wildcard_random(self_s, command, context)
            return

        # Strip any leading directory components for the lookup key
        wc_name = wildcard_path.split('/')[-1].split('\\')[-1]

        if wc_name in overrides:
            raw_value = overrides[wc_name]
            print(f"[WildcardResolver] OVERRIDE {wc_name!r} -> {repr(raw_value)[:60]}")

            # Record this resolution in the tracer so its stride calculation
            # sees the same number of records as a non-locked run.
            # subwildcard5 is locked → no tracer _get_wildcard call fires for it
            # → without this record, _count_records_for undercounts and assigns
            # wrong slices to each image.
            recorder = _tracer_recorder
            if recorder is None:
                # Per-call fallback in case tracer loaded after resolver
                try:
                    import sys as _sys
                    for _k in _sys.modules:
                        _m = _sys.modules[_k]
                        if hasattr(_m, 'RECORDER') and _k.endswith('wildcard_tracer'):
                            recorder = _m.RECORDER
                            break
                except Exception:
                    pass

            if recorder is not None:
                try:
                    recorder.record(wc_name, raw_value)
                except Exception as _e:
                    print(f"[WildcardResolver] Tracer record error: {_e}")
            else:
                print(f"[WildcardResolver] WARNING: tracer RECORDER not found, "
                      f"wildcard chain metadata will be wrong for locked wildcards")

            ctx2 = context.with_variables(command.variables)
            yield from ctx2.sample_prompts(raw_value, 1)
        else:
            yield from _orig_get_wildcard_random(self_s, command, context)

    overriding_get_wildcard._wr_patched = True
    RandomSampler._get_wildcard = overriding_get_wildcard
    print("[WildcardResolver] Patched RandomSampler._get_wildcard for overrides")


def _set_overrides(resolutions):
    with _override_lock:
        _active_override.clear()
        _active_override.update(resolutions)
    if resolutions:
        print(f"[WildcardResolver] Active overrides: {list(resolutions.keys())}")


def _clear_overrides():
    with _override_lock:
        _active_override.clear()


# ---------------------------------------------------------------------------
# FastAPI routes (used by the JS popup)
# ---------------------------------------------------------------------------

def on_app_started(demo, app):
    from fastapi.responses import JSONResponse

    @app.get("/wildcard-resolver/entries")
    async def api_entries(name: str = ""):
        if not name:
            return JSONResponse({"entries": [], "error": "no name given"})
        wc_dir = get_wc_dir()
        path   = find_wildcard_file(name, wc_dir)
        if not path:
            return JSONResponse({"entries": [], "error": f"'{name}' not found"})
        return JSONResponse({"entries": read_wildcard_entries(path), "name": name})

    @app.get("/wildcard-resolver/wc-dir")
    async def api_wc_dir():
        return JSONResponse({"wc_dir": get_wc_dir()})

    _install_override_patch()
    print(f"[WildcardResolver] API routes registered. wc_dir={get_wc_dir()}")


try:
    from modules import script_callbacks
    script_callbacks.on_app_started(on_app_started)
except Exception as e:
    print(f"[WildcardResolver] WARNING: Could not register API: {e}")


# ---------------------------------------------------------------------------
# Script
# ---------------------------------------------------------------------------

class WildcardResolverScript(scripts.Script):

    def title(self):
        return "Wildcard Resolver"

    def show(self, is_img2img):
        return scripts.AlwaysVisible

    def ui(self, is_img2img):
        tab_id = "i2i" if is_img2img else "t2i"
        with gr.Accordion("🃏 Wildcard Resolver", open=False,
                          elem_id=f"wr_accordion_{tab_id}"):
            gr.HTML(
                '<div style="font-size:12px;color:#a0a8c0;font-family:monospace;'
                'padding:4px 0 8px 0;">'
                '<b>Usage:</b> Double-click any '
                '<code style="background:#2a1f42;color:#c4b5fd;padding:1px 4px;'
                'border-radius:3px;">~~wildcard~~</code>'
                ' in the prompt to choose an entry. '
                'Right-click a resolved span to revert.</div>'
            )
            wc_dir_box = gr.Textbox(
                label="Wildcard directory", value=get_wc_dir,
                interactive=False, elem_id=f"wr_wc_dir_{tab_id}",
            )
            with gr.Row():
                refresh_btn = gr.Button("⟳ Refresh", size="sm")
                test_btn    = gr.Button("🔍 Test",    size="sm")
            status_box = gr.Textbox(
                label="", value="", interactive=False,
                elem_id=f"wr_status_{tab_id}", show_label=False,
            )
            def do_refresh(): return get_wc_dir()
            def do_test(d):
                if not d or not Path(d).is_dir():
                    return f"❌ Not a directory: {d}"
                txts = []
                for root, _, files in os.walk(d):
                    txts += [f for f in files if f.endswith(".txt")]
                    if len(txts) >= 6: break
                return (f"✅ {len(txts)}+ .txt files found. e.g. {', '.join(txts[:5])}"
                        if txts else f"⚠️ No .txt files in: {d}")
            refresh_btn.click(do_refresh, [], [wc_dir_box])
            test_btn.click(do_test, [wc_dir_box], [status_box])
        return []

    def before_process(self, p, *args):
        """
        Extract the ||WRC||chain||/WRC|| sentinel from the prompt (injected by JS),
        parse the pre-resolved wildcard choices, and activate overrides so
        dynamic-prompts uses those exact values instead of random ones.
        """
        prompt = getattr(p, "prompt", "") or ""
        print(f"[WildcardResolver] before_process fired. prompt[:120]={repr(prompt[:120])}")
        print(f"[WildcardResolver] sentinel present: {CHAIN_START in prompt}")

        self._apply_sentinel(p)

    def process(self, p, *args):
        """
        Fallback sentinel extraction — runs after before_process in case
        sd-dynamic-prompts consumed the prompt in its own before_process first.
        If the sentinel was already stripped by before_process this is a no-op.
        """
        prompt = getattr(p, "prompt", "") or ""
        if CHAIN_START in prompt:
            print(f"[WildcardResolver] process() fallback: sentinel still present, extracting now")
            self._apply_sentinel(p)

    def _apply_sentinel(self, p):
        """Shared sentinel extraction + override activation logic."""
        prompt = getattr(p, "prompt", "") or ""

        cs = prompt.find(CHAIN_START)
        ce = prompt.find(CHAIN_END, cs) if cs != -1 else -1

        if cs == -1 or ce == -1:
            _clear_overrides()
            return

        # Strip sentinel from the prompt so SD never sees it
        chain_str = prompt[cs + len(CHAIN_START):ce]
        clean     = prompt[:cs] + prompt[ce + len(CHAIN_END):]
        p.prompt  = clean
        print(f"[WildcardResolver] Stripped sentinel. clean prompt[:80]={repr(clean[:80])}")
        print(f"[WildcardResolver] chain_str[:120]={repr(chain_str[:120])}")

        # Also fix all_prompts if present (batch generation)
        if hasattr(p, "all_prompts") and isinstance(p.all_prompts, list):
            cleaned = []
            for s in p.all_prompts:
                cs2 = s.find(CHAIN_START)
                ce2 = s.find(CHAIN_END, cs2) if cs2 != -1 else -1
                if cs2 != -1 and ce2 != -1:
                    cleaned.append(s[:cs2] + s[ce2 + len(CHAIN_END):])
                else:
                    cleaned.append(s)
            p.all_prompts = cleaned

        resolutions = parse_chain_resolutions(chain_str)
        print(f"[WildcardResolver] Parsed {len(resolutions)} resolutions: {list(resolutions.keys())}")
        _set_overrides(resolutions)

    def postprocess(self, p, processed, *args):
        _clear_overrides()
        print("[WildcardResolver] Overrides cleared")
