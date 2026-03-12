"""
Wildcard Resolver — SD WebUI Extension (reForge / AUTOMATIC1111)
v4: wildcard chain stored in image metadata via extra_generation_params.
"""

import gradio as gr
import modules.scripts as scripts
import os
import json
import threading
from pathlib import Path

# ---------------------------------------------------------------------------
# Core logic
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
# Chain storage — JS POSTs the serialised chain just before generation.
# We keep one slot per tab (t2i / i2i) so concurrent use doesn't mix them.
# ---------------------------------------------------------------------------

_chain_lock  = threading.Lock()
_chain_store = {"t2i": "", "i2i": ""}


def store_chain(tab, chain):
    with _chain_lock:
        _chain_store[tab] = chain


def pop_chain(tab):
    """Return and clear the stored chain for this tab."""
    with _chain_lock:
        val = _chain_store.get(tab, "")
        _chain_store[tab] = ""
        return val


# ---------------------------------------------------------------------------
# FastAPI routes
# ---------------------------------------------------------------------------

def on_app_started(demo, app):
    from fastapi import Request
    from fastapi.responses import JSONResponse

    @app.get("/wildcard-resolver/entries")
    async def api_entries(name: str = ""):
        if not name:
            return JSONResponse({"entries": [], "error": "no name given"})
        wc_dir = get_wc_dir()
        path = find_wildcard_file(name, wc_dir)
        if not path:
            return JSONResponse({"entries": [], "error": f"'{name}' not found",
                                 "searched": wc_dir})
        entries = read_wildcard_entries(path)
        return JSONResponse({"entries": entries, "name": name})

    @app.get("/wildcard-resolver/wc-dir")
    async def api_wc_dir():
        return JSONResponse({"wc_dir": get_wc_dir()})

    @app.post("/wildcard-resolver/set-chain")
    async def api_set_chain(request: Request):
        """JS calls this just before generate with the resolution chain string."""
        try:
            body  = await request.json()
            tab   = body.get("tab", "t2i")
            chain = body.get("chain", "")
            if tab not in ("t2i", "i2i"):
                tab = "t2i"
            store_chain(tab, chain)
            return JSONResponse({"ok": True})
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)})

    print(f"[WildcardResolver] API routes registered. wc_dir={get_wc_dir()}")


try:
    from modules import script_callbacks
    script_callbacks.on_app_started(on_app_started)
except Exception as e:
    print(f"[WildcardResolver] WARNING: Could not register API: {e}")


# ---------------------------------------------------------------------------
# Gradio UI + generation hook
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
                'Right-click a resolved span to revert.'
                '</div>'
            )
            wc_dir_box = gr.Textbox(
                label="Wildcard directory",
                value=get_wc_dir,
                interactive=False,
                elem_id=f"wr_wc_dir_{tab_id}",
            )
            with gr.Row():
                refresh_btn = gr.Button("⟳ Refresh", size="sm")
                test_btn    = gr.Button("🔍 Test",    size="sm")
            status_box = gr.Textbox(
                label="", value="", interactive=False,
                elem_id=f"wr_status_{tab_id}", show_label=False,
            )

            def do_refresh():
                return get_wc_dir()

            def do_test(d):
                if not d or not Path(d).is_dir():
                    return f"❌ Not a directory: {d}"
                txts = []
                for root, _, files in os.walk(d):
                    txts += [f for f in files if f.endswith(".txt")]
                    if len(txts) >= 6:
                        break
                if txts:
                    return (f"✅ {len(txts)}+ .txt files found. "
                            f"e.g. {', '.join(txts[:5])}")
                return f"⚠️ No .txt wildcard files found in: {d}"

            refresh_btn.click(do_refresh, [], [wc_dir_box])
            test_btn.click(do_test, [wc_dir_box], [status_box])

        return []

    def process(self, p, *args):
        """Called before sampling — just note the tab for postprocess."""
        # Don't block here. The async JS POST may not have arrived yet because
        # reForge calls process() on a background thread while the main thread
        # (which would complete the HTTP POST) hasn't had a chance to run.
        # We do nothing here and read the chain in postprocess() instead.
        pass

    def postprocess(self, p, processed, *args):
        """Called after all images are generated — chain is guaranteed to have arrived."""
        tab   = "i2i" if getattr(p, "is_img2img", False) else "t2i"
        chain = pop_chain(tab)
        if chain:
            if not hasattr(p, "extra_generation_params") \
               or p.extra_generation_params is None:
                p.extra_generation_params = {}
            p.extra_generation_params["Wildcard chain"] = chain
            # Also write into each processed image's infotext
            try:
                processed.infotexts = [
                    info + f", Wildcard chain: {chain}"
                    for info in (processed.infotexts or [])
                ]
            except Exception:
                pass
            print(f"[WildcardResolver] Chain written to metadata ({len(chain)} chars)")
        else:
            print(f"[WildcardResolver] postprocess(): no chain for tab={tab}")
