/**
 * Wildcard Resolver — SD WebUI Extension JS  v3
 * Fixes: LoRA/angle-bracket entries invisible in popup (innerHTML eating <tags>)
 *        Wildcard tokens highlighted purple in prompt
 *        Resolved spans highlighted orange (stackable, text stays legible)
 */

(function () {
  "use strict";

  const WRAP = "~~";
  const COLORS = {
    bg2:      "#1a1e28",
    bg3:      "#222636",
    bg4:      "#2a2f42",
    accent:   "#7eb8f7",
    warn:     "#f59e0b",
    text0:    "#e8eaf0",
    text2:    "#606880",
    wc_hl:    "#4a1f7a",       // wildcard token bg  (purple, 3× stronger)
    wc_hl_fg: "#e0c8ff",       // wildcard token fg  (bright purple-white)
    wc_hl_locked:    "#6b0f4a",  // locked wildcard token bg (magenta)
    wc_hl_locked_fg: "#ffb3f0",  // locked wildcard token fg (bright magenta-white)
    // Resolved span: semi-transparent orange, stackable. 3× original alpha.
    res_hl:   "rgba(245,158,11,0.29)",   // per-layer orange tint (stacks multiplicatively)
    res_hl_locked: "rgba(220,50,50,0.32)",  // red tint for locked resolved spans
    res_border: "#92400e",               // underline colour
    // Angle-bracket tokens <lora:...> etc — green highlight in popup + overlay
    ab_hl:    "#0f3d1a",       // green bg
    ab_hl_fg: "#6ee7a0",       // green fg
  };

  // ── Persistent search-mode ───────────────────────────────────────────────
  const SEARCH_MODE_KEY = "wr_search_mode";
  function getSearchMode()      { return localStorage.getItem(SEARCH_MODE_KEY) || "highlight"; }
  function saveSearchMode(mode) { localStorage.setItem(SEARCH_MODE_KEY, mode); }

  // ── Selection memory (wcName → last chosen entry, per textarea) ───────────
  const selMemByKey  = new Map();
  const lockMemByKey = new Map();

  function getSelMem(ta) {
    const key = getStableKey(ta);
    if (!selMemByKey.has(key)) selMemByKey.set(key, new Map());
    return selMemByKey.get(key);
  }

  // lockMem stores wildcards whose chosen entry is permanently locked.
  // Locked entries are always applied by autoResolveMemory regardless of
  // whether the wildcard is currently visible in the prompt.
  function getLockMem(ta) {
    const key = getStableKey(ta);
    if (!lockMemByKey.has(key)) lockMemByKey.set(key, new Map());
    return lockMemByKey.get(key);
  }

  // Returns true if wcName is locked OR if its selMem chain contains any locked wildcard.
  // visited prevents infinite loops in cyclic selMem chains.
  function hasLockInChain(ta, wcName, visited) {
    if (!visited) visited = new Set();
    if (visited.has(wcName)) return false;
    visited.add(wcName);
    const lockMem = getLockMem(ta);
    if (lockMem.has(wcName)) return true;
    // Walk selMem: if this name resolves to something containing ~~tokens~~, recurse
    const selMem = getSelMem(ta);
    if (!selMem.has(wcName)) return false;
    const resolved = selMem.get(wcName);
    const wcRe = /~~([^\s]+?)~~/g;
    let m;
    while ((m = wcRe.exec(resolved)) !== null) {
      if (hasLockInChain(ta, m[1], visited)) return true;
    }
    return false;
  }

  // ── Safe HTML escape (fixes LoRA / angle-bracket entries) ─────────────────
  function escHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Turn a raw entry string into safe HTML:
  //   ~~wildcard~~  → purple highlight
  //   <lora:...>    → green highlight
  //   everything else → escaped plain text
  function entryToHtml(entry) {
    const parts = entry.split(/(~~[^\s]+?~~|<[^>]+>)/g);
    return parts.map(p => {
      if (/^~~[^\s]+?~~$/.test(p)) {
        return `<span style="color:${COLORS.wc_hl_fg};background:${COLORS.wc_hl};`
             + `border-radius:2px;padding:0 2px;">${escHtml(p)}</span>`;
      }
      if (/^<[^>]+>$/.test(p)) {
        return `<span style="color:${COLORS.ab_hl_fg};background:${COLORS.ab_hl};`
             + `border-radius:2px;padding:0 2px;">${escHtml(p)}</span>`;
      }
      return escHtml(p);
    }).join("");
  }

  // ── Wildcard regex ─────────────────────────────────────────────────────────
  function findWildcardAt(text, idx) {
    const re = /~~([^\s]+?)~~/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index <= idx && idx <= m.index + m[0].length) {
        return { name: m[1], start: m.index, end: m.index + m[0].length };
      }
    }
    return null;
  }

  // ── Per-textarea state ─────────────────────────────────────────────────────
  // Keyed by the stable parent element ID, not the textarea element itself.
  // Gradio/Svelte can replace the textarea DOM node on re-render, which would
  // lose WeakMap state. The parent container ID is stable across re-renders.
  const stateByKey = new Map();

  const SELECTOR_FOR_TA = new Map(); // ta element → its selector string

  function getStableKey(ta) {
    if (ta.dataset.wrKey) return ta.dataset.wrKey;
    if (SELECTOR_FOR_TA.has(ta)) {
      const sel = SELECTOR_FOR_TA.get(ta);
      ta.dataset.wrKey = sel;
      return sel;
    }
    // Last resort: match by querying
    for (const sel of PROMPT_SELECTORS) {
      if (document.querySelector(sel) === ta) {
        ta.dataset.wrKey = sel;
        return sel;
      }
    }
    return "unknown_ta";
  }

  function getState(ta) {
    const key = getStableKey(ta);
    if (!stateByKey.has(key)) stateByKey.set(key, { resolutions: [] });
    return stateByKey.get(key);
  }
  function makeId() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  // ── Span / offset tracking ─────────────────────────────────────────────────

  // Walk up the parentId chain and grow each ancestor's .end by delta.
  // Called when inserting a new child so ancestors cover the expanded content
  // instead of being incorrectly shifted by shiftResolutions.
  function growAncestors(state, startId, delta) {
    if (delta === 0) return;
    let cur = state.resolutions.find(r => r.id === startId);
    while (cur && cur.parentId) {
      const parent = state.resolutions.find(r => r.id === cur.parentId);
      if (!parent) break;
      parent.end += delta;
      cur = parent;
    }
  }

  // Return the set of IDs of all ancestors of the given resolution id.
  function getAncestorIds(state, id) {
    const ids = new Set();
    let cur = state.resolutions.find(r => r.id === id);
    while (cur && cur.parentId) {
      ids.add(cur.parentId);
      cur = state.resolutions.find(r => r.id === cur.parentId);
    }
    return ids;
  }
  function shiftResolutions(state, afterPos, delta, skipIds) {
    if (delta === 0) return;
    const skip = skipIds ? new Set(skipIds) : null;
    for (const r of state.resolutions) {
      if (skip && skip.has(r.id)) continue;
      if (r.start >= afterPos)    {
        r.start += delta; r.end += delta;
      } else if (r.end >= afterPos) {
        r.end += delta;
      }
    }
  }

  function findResAt(state, idx) {
    // Collect all resolutions that contain idx
    const candidates = state.resolutions.filter(
      r => r.start <= idx && idx < r.end
    );
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    // Build set of IDs that are ancestors of another candidate —
    // we want the innermost (most-child) resolution, so exclude any
    // resolution that has a descendant also in the candidate set.
    const candidateIds = new Set(candidates.map(r => r.id));
    const isAncestor = id => {
      // Walk up from each candidate's parentId chain; if we reach `id`, it's an ancestor
      for (const r of candidates) {
        let cur = r.parentId;
        while (cur) {
          if (cur === id) return true;
          const parent = state.resolutions.find(x => x.id === cur);
          cur = parent ? parent.parentId : null;
        }
      }
      return false;
    };

    // Filter to non-ancestors first
    const nonAncestors = candidates.filter(r => !isAncestor(r.id));
    const pool = nonAncestors.length > 0 ? nonAncestors : candidates;

    // Among remaining, pick smallest span (most precise); tie-break by smallest start (most specific position)
    return pool.reduce((best, r) => {
      const bestSize = best.end - best.start;
      const rSize    = r.end - r.start;
      if (rSize < bestSize) return r;
      if (rSize === bestSize && r.start > best.start) return r;
      return best;
    });
  }

  function getDescendants(state, id) {
    const out = [];
    (function walk(pid) {
      for (const r of state.resolutions)
        if (r.parentId === pid) { out.push(r.id); walk(r.id); }
    })(id);
    return out;
  }

  // ── Set textarea value + fire Gradio events ────────────────────────────────
  function setVal(ta, val) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, val);
    ta.dispatchEvent(new Event("input",  { bubbles: true }));
    ta.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ── Revert ─────────────────────────────────────────────────────────────────
  function revert(ta, resId) {
    const state = getState(ta);
    const res = state.resolutions.find(r => r.id === resId);
    if (!res) return;
    // Remove this resolution AND all its descendants
    const desc = getDescendants(state, resId);
    state.resolutions = state.resolutions.filter(r => r.id !== resId && !desc.includes(r.id));
    // Build new text and shift sibling resolutions
    const newText = ta.value.slice(0, res.start) + res.originalToken + ta.value.slice(res.end);
    const delta   = res.originalToken.length - (res.end - res.start);
    shiftResolutions(state, res.end, delta);
    // Set _wrPrevLen BEFORE setVal so input handler sees delta=0
    ta._wrPrevLen = newText.length;
    setVal(ta, newText);

    updateOverlay(ta);
  }
  // ── Fetch entries from API ─────────────────────────────────────────────────
  async function fetchEntries(wcName) {
    try {
      const res = await fetch(`/wildcard-resolver/entries?name=${encodeURIComponent(wcName)}`);
      if (!res.ok) return { entries: [], error: `HTTP ${res.status}` };
      return await res.json();
    } catch (e) {
      return { entries: [], error: String(e) };
    }
  }

  // ── Overlay: highlight resolved spans + wildcard tokens ───────────────────
  // Uses the "backdrop div" trick: a transparent div sits behind the textarea,
  // mirrors its text with styled spans, giving visible highlights.
  // The textarea itself gets a transparent background so the overlay shows through.

  const overlayByKey = new Map();

  function getOverlayContainer(ta) {
    const key = getStableKey(ta);
    if (overlayByKey.has(key)) {
      // Return existing overlay — but re-sync its position since ta may be new
      return overlayByKey.get(key);
    }

    // Wrapper must be position:relative
    const parent = ta.parentElement;
    if (getComputedStyle(parent).position === "static") parent.style.position = "relative";

    const mirror = document.createElement("div");
    mirror.className = "wr-mirror";

    // Copy all text-affecting styles from textarea
    const cs = getComputedStyle(ta);
    const copyProps = [
      "fontFamily","fontSize","fontWeight","fontStyle","letterSpacing",
      "lineHeight","textAlign","padding","paddingTop","paddingRight",
      "paddingBottom","paddingLeft","borderWidth","boxSizing",
      "whiteSpace","wordBreak","overflowWrap","tabSize",
    ];
    copyProps.forEach(p => { mirror.style[p] = cs[p]; });

    Object.assign(mirror.style, {
      position:      "absolute",
      top:           ta.offsetTop + "px",
      left:          ta.offsetLeft + "px",
      width:         ta.offsetWidth + "px",
      height:        ta.offsetHeight + "px",
      border:        "1px solid transparent",
      overflow:      "hidden",
      pointerEvents: "none",
      zIndex:        "0",
      color:         "transparent",   // text invisible — only highlights show
      whiteSpace:    "pre-wrap",
      wordBreak:     "break-word",
    });

    // Make textarea background transparent so overlay shows through
    ta.style.background = "transparent";
    ta.style.position   = "relative";
    ta.style.zIndex     = "1";

    parent.insertBefore(mirror, ta);
    overlayByKey.set(key, mirror);

    // Keep overlay sized with textarea
    new ResizeObserver(() => {
      mirror.style.width  = ta.offsetWidth  + "px";
      mirror.style.height = ta.offsetHeight + "px";
      mirror.style.top    = ta.offsetTop    + "px";
      mirror.style.left   = ta.offsetLeft   + "px";
    }).observe(ta);

    ta.addEventListener("scroll", () => { mirror.scrollTop = ta.scrollTop; });

    return mirror;
  }

  function updateOverlay(ta) {
    const mirror = getOverlayContainer(ta);
    const state  = getState(ta);
    const text   = ta.value;

    if (state.resolutions.length === 0 && !/~~[^\s]+?~~/.test(text) && !/<[^>]+>/.test(text)) {
      mirror.innerHTML = "";
      return;
    }

    const spans = [...state.resolutions].sort((a, b) => a.start - b.start);

    // 1. Find wildcard token ranges
    const wcRanges = [];
    const wcRe = /~~([^\s]+?)~~/g;
    let m;
    while ((m = wcRe.exec(text)) !== null) {
      wcRanges.push({ start: m.index, end: m.index + m[0].length, type: "wc", name: m[1] });
    }

    // 2. Find angle-bracket token ranges <...>
    const abRanges = [];
    const abRe = /<[^>]+>/g;
    while ((m = abRe.exec(text)) !== null) {
      abRanges.push({ start: m.index, end: m.index + m[0].length, type: "ab" });
    }

    const events = [];
    for (const sp of spans) {
      if (sp.orangeTransparent) continue;   // pure-wildcard replacement — no orange layer
      events.push({ pos: sp.start, kind: "open",  type: "res", resId: sp.id });
      events.push({ pos: sp.end,   kind: "close", type: "res", resId: sp.id });
    }
    for (const wc of wcRanges) {
      events.push({ pos: wc.start, kind: "open",  type: "wc", wcName: wc.name });
      events.push({ pos: wc.end,   kind: "close", type: "wc", wcName: wc.name });
    }
    for (const ab of abRanges) {
      events.push({ pos: ab.start, kind: "open",  type: "ab" });
      events.push({ pos: ab.end,   kind: "close", type: "ab" });
    }
    events.sort((a, b) => a.pos - b.pos || (a.kind === "close" ? -1 : 1));

    let html        = "";
    let cursor      = 0;
    let resDepth    = 0;
    let inWc        = false;
    let inWcLocked  = false;
    let inAb        = false;
    const _lockMem = getLockMem(ta);
    const _lockedResIds = new Set(
      state.resolutions
        .filter(r => _lockMem.has(r.originalToken.replace(/^~~|~~$/g, "")))
        .map(r => r.id)
    );
    // Build merged locked ranges: union of all locked resolution spans.
    // Any position inside these ranges shows red instead of orange.
    const _lockedRanges = [];
    for (const r of state.resolutions) {
      if (_lockedResIds.has(r.id) && r.end > r.start) {
        _lockedRanges.push([r.start, r.end]);
      }
    }
    _lockedRanges.sort((a, b) => a[0] - b[0]);
    function posIsLocked(pos) {
      for (const [ls, le] of _lockedRanges) {
        if (pos >= ls && pos < le) return true;
        if (ls > pos) break;
      }
      return false;
    }

    function flushText(to) {
      if (to <= cursor) return;
      const chunk = escHtml(text.slice(cursor, to));
      if (inWcLocked) {
        html += `<span style="background:${COLORS.wc_hl_locked};">${chunk}</span>`;
      } else if (inWc) {
        html += `<span style="background:${COLORS.wc_hl};">${chunk}</span>`;
      } else if (inAb) {
        html += `<span style="background:${COLORS.ab_hl};">${chunk}</span>`;
      } else if (resDepth > 0) {
        // If cursor falls inside a locked range, use red; otherwise orange.
        const col = posIsLocked(cursor) ? COLORS.res_hl_locked : COLORS.res_hl;
        html += `<span style="background:${col};">`.repeat(resDepth)
              + chunk + `</span>`.repeat(resDepth);
      } else {
        html += chunk;
      }
      cursor = to;
    }

    let i = 0;
    while (i < events.length) {
      const pos = events[i].pos;
      flushText(pos);
      while (i < events.length && events[i].pos === pos) {
        const ev = events[i];
        if (ev.type === "res") {
          if (ev.kind === "open")  resDepth++;
          else                     resDepth = Math.max(0, resDepth - 1);
        } else if (ev.type === "wc") {
          inWc       = (ev.kind === "open");
          inWcLocked = inWc && hasLockInChain(ta, ev.wcName);
        } else if (ev.type === "ab") {
          inAb = (ev.kind === "open");
        }
        i++;
      }
    }
    flushText(text.length);

    mirror.innerHTML = html;
    mirror.scrollTop = ta.scrollTop;
  }

  // ── Popup ──────────────────────────────────────────────────────────────────
  let activePopup = null;
  function closePopup() { if (activePopup) { activePopup.remove(); activePopup = null; } }

  function showPopup(entries, wcName, cx, cy, onSelect, ta) {
    closePopup();

    // ── Outer shell (does NOT scroll — sticky header needs this) ──────────────
    const popup = document.createElement("div");
    Object.assign(popup.style, {
      position:   "fixed", zIndex: "99999",
      background: COLORS.bg2, border: `1px solid ${COLORS.bg4}`,
      borderRadius: "6px",
      minWidth: "280px", maxWidth: "540px",
      maxHeight: "460px",
      display: "flex", flexDirection: "column",
      boxShadow: "0 8px 32px rgba(0,0,0,0.75)",
      fontFamily: "ui-monospace,Consolas,monospace", fontSize: "13px",
      overflow: "hidden",   // clip corners; inner list scrolls
    });

    // ── Header row: name + count ───────────────────────────────────────────────
    const hdr = document.createElement("div");
    Object.assign(hdr.style, {
      padding: "7px 12px", borderBottom: `1px solid ${COLORS.bg4}`,
      color: COLORS.accent, fontWeight: "600",
      display: "flex", justifyContent: "space-between", alignItems: "center",
      flexShrink: "0",
    });
    const countSpan = document.createElement("span");
    countSpan.style.cssText = `color:${COLORS.text2};font-size:11px;`;
    countSpan.textContent = `${entries.length} entries · ↑↓ Enter Esc`;
    hdr.innerHTML = `<span>${escHtml(WRAP + wcName + WRAP)}</span>`;
    hdr.appendChild(countSpan);
    popup.appendChild(hdr);

    // ── Search bar row ─────────────────────────────────────────────────────────
    const searchRow = document.createElement("div");
    Object.assign(searchRow.style, {
      display: "flex", alignItems: "center", gap: "6px",
      padding: "6px 10px", borderBottom: `1px solid ${COLORS.bg4}`,
      flexShrink: "0", background: COLORS.bg2,
    });

    const searchInput = document.createElement("input");
    searchInput.type        = "text";
    searchInput.placeholder = "search…";
    Object.assign(searchInput.style, {
      flex: "1", background: COLORS.bg3, border: `1px solid ${COLORS.bg4}`,
      borderRadius: "4px", color: COLORS.text0, padding: "4px 8px",
      fontSize: "12px", outline: "none", fontFamily: "inherit",
    });

    // Toggle button: 🔍 = highlight mode (show all, mark matches)
    //                ≡  = filter mode   (show only matching lines)
    // Mode is persisted in localStorage.
    const toggleBtn = document.createElement("button");
    const _initMode = getSearchMode();
    toggleBtn.dataset.mode = _initMode;
    Object.assign(toggleBtn.style, {
      background: COLORS.bg4, border: `1px solid ${COLORS.bg4}`,
      borderRadius: "4px", color: _initMode === "filter" ? "#a78bfa" : COLORS.accent,
      padding: "3px 7px", cursor: "pointer", fontSize: "13px",
      lineHeight: "1", flexShrink: "0",
    });
    toggleBtn.title    = "Toggle: highlight matches / show only matches";
    toggleBtn.textContent = _initMode === "filter" ? "≡" : "🔍";

    toggleBtn.addEventListener("click", () => {
      const next = toggleBtn.dataset.mode === "highlight" ? "filter" : "highlight";
      toggleBtn.dataset.mode = next;
      toggleBtn.textContent  = next === "highlight" ? "🔍" : "≡";
      toggleBtn.style.color  = next === "highlight" ? COLORS.accent : "#a78bfa";
      saveSearchMode(next);
      applySearch(searchInput.value);
    });

    // Forget-stale button: removes selMem entries for wildcards not currently
    // present as ~~token~~ anywhere in the textarea's current value.
    const forgetBtn = document.createElement("button");
    Object.assign(forgetBtn.style, {
      background: COLORS.bg4, border: `1px solid ${COLORS.bg4}`,
      borderRadius: "4px", color: COLORS.text2,
      padding: "3px 7px", cursor: "pointer", fontSize: "13px", lineHeight: "1", flexShrink: "0",
    });
    forgetBtn.title = "Forget remembered choices for wildcards no longer in the prompt";
    forgetBtn.textContent = "🗑";
    forgetBtn.addEventListener("click", () => {
      const selMem  = getSelMem(ta);
      const lockMem = getLockMem(ta);
      const curText = ta.value;
      let removed = 0;
      for (const [name] of [...selMem]) {
        if (!curText.includes(`~~${name}~~`)) { selMem.delete(name); removed++; }
      }
      // Also clear stale lock entries
      for (const [name] of [...lockMem]) {
        if (!curText.includes(`~~${name}~~`)) { lockMem.delete(name); removed++; }
      }
      forgetBtn.textContent = removed > 0 ? `✓${removed}` : "🗑";
      setTimeout(() => { forgetBtn.textContent = "🗑"; }, 1200);
      updateOverlay(ta);
    });

    searchRow.appendChild(searchInput);
    searchRow.appendChild(toggleBtn);
    searchRow.appendChild(forgetBtn);
    popup.appendChild(searchRow);

    // ── Scrollable list ────────────────────────────────────────────────────────
    const list = document.createElement("div");
    Object.assign(list.style, {
      overflowY: "auto", flexGrow: "1", padding: "4px 0",
    });

    // Build item elements once; search shows/hides or re-renders them
    const items = [];   // { el, entry, visible } — tracks currently visible subset
    let focused = -1;   // index into the *visible* items array

    entries.forEach((entry) => {
      const el = document.createElement("div");
      Object.assign(el.style, {
        padding: "5px 14px", cursor: "pointer", color: COLORS.text0,
        whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: "1.4",
      });
      el.innerHTML = entryToHtml(entry);
      el.addEventListener("mouseenter", () => {
        const vi = visibleItems().indexOf(el);
        if (vi >= 0) setFocus(vi);
      });
      el.addEventListener("click", () => { closePopup(); onSelect(entry); });
      list.appendChild(el);
      items.push({ el, entry });
    });

    popup.appendChild(list);

    // ── Focus helpers (operate on currently visible subset) ───────────────────
    function visibleItems() {
      return items.filter(it => it.el.style.display !== "none").map(it => it.el);
    }

    function setFocus(i) {
      const vis = visibleItems();
      if (focused >= 0 && vis[focused]) vis[focused].style.background = "";
      focused = i;
      if (i >= 0 && vis[i]) {
        vis[i].style.background = COLORS.bg3;
        vis[i].scrollIntoView({ block: "nearest" });
      }
    }

    // ── Search / highlight logic ───────────────────────────────────────────────
    // Highlight a search term inside an already-safe HTML string.
    // We need to highlight within the rendered text only, not inside tag attrs.
    function highlightTerm(safeHtml, term) {
      if (!term) return safeHtml;
      // Work on text nodes only: split on HTML tags, process text runs
      const safeTerm = escHtml(term);   // term already escaped for comparison
      const re = new RegExp(escapeRegex(safeTerm), "gi");
      // Split the html into [tag, text, tag, text, ...]
      return safeHtml.replace(/((?:<[^>]+>)+|[^<]+)/g, chunk => {
        if (chunk.startsWith("<")) return chunk;   // it's a tag — leave alone
        return chunk.replace(re, match =>
          `<mark style="background:#854d0e;color:#fde68a;border-radius:2px;">${match}</mark>`
        );
      });
    }

    function escapeRegex(s) {
      return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function applySearch(raw) {
      const term    = raw.trim().toLowerCase();
      const mode    = toggleBtn.dataset.mode;   // "highlight" | "filter"
      focused = -1;

      items.forEach(it => {
        const matches = !term || it.entry.toLowerCase().includes(term);

        if (mode === "filter") {
          it.el.style.display = matches ? "" : "none";
          // Show match highlight even in filter mode
          it.el.innerHTML = matches
            ? (term ? highlightTerm(entryToHtml(it.entry), term) : entryToHtml(it.entry))
            : "";
        } else {
          // highlight mode — show all, mark matching text
          it.el.style.display = "";
          it.el.innerHTML = term && matches
            ? highlightTerm(entryToHtml(it.entry), term)
            : entryToHtml(it.entry);
        }
      });

      // Update count in header
      const shown = term
        ? items.filter(it => it.entry.toLowerCase().includes(term)).length
        : entries.length;
      countSpan.textContent = `${shown}/${entries.length} · ↑↓ Enter Esc`;
    }

    searchInput.addEventListener("input", () => applySearch(searchInput.value));

    // ── Mount & position ───────────────────────────────────────────────────────
    document.body.appendChild(popup);
    activePopup = popup;

    const pw = 300, ph = 460;
    let x = Math.min(cx, window.innerWidth  - pw - 10);
    let y = cy + 20;
    if (y + ph > window.innerHeight - 10) y = cy - ph - 10;
    if (y < 10) y = 10;
    popup.style.left = x + "px";
    popup.style.top  = y + "px";

    // Focus the search input immediately
    setTimeout(() => searchInput.focus(), 0);

    // ── Keyboard navigation ────────────────────────────────────────────────────
    const onKey = e => {
      if (!activePopup) return;

      // Let the search input handle normal typing — only intercept nav keys
      if (e.key === "Escape") {
        closePopup();
        document.removeEventListener("keydown", onKey, true);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocus(Math.min(focused + 1, visibleItems().length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocus(Math.max(focused - 1, 0));
      } else if (e.key === "Enter") {
        const vis = visibleItems();
        if (focused >= 0 && vis[focused]) {
          e.preventDefault();
          // Find the original entry for this element
          const hit = items.find(it => it.el === vis[focused]);
          if (hit) {
            closePopup();
            document.removeEventListener("keydown", onKey, true);
            onSelect(hit.entry);
          }
        } else if (vis.length === 1) {
          // Only one result — Enter selects it automatically
          e.preventDefault();
          const hit = items.find(it => it.el === vis[0]);
          if (hit) {
            closePopup();
            document.removeEventListener("keydown", onKey, true);
            onSelect(hit.entry);
          }
        }
      }
    };
    document.addEventListener("keydown", onKey, true);

    setTimeout(() => {
      document.addEventListener("click", function oc(e) {
        if (activePopup && !activePopup.contains(e.target)) {
          closePopup();
          document.removeEventListener("click", oc, true);
        }
      }, true);
    }, 0);
  }

  // ── Context menu (right-click: revert + inline repick with search) ─────────
  // Strategy: fetch entries FIRST (async), THEN build and mount the menu in one
  // synchronous step so there is no "loading" gap and no dismiss-race.
  let activeCtx = null;
  function closeCtx() { if (activeCtx) { activeCtx.remove(); activeCtx = null; } }

  // applyChoice: replace the current resolution with a newly chosen entry.
  // Shared between the ctx menu entry list and future callers.
  function applyChoice(ta, res, chosen) {
    const state         = getState(ta);
    const wcName        = res.originalToken.replace(/^~~|~~$/g, "");
    // Check lock BEFORE any state mutation
    if (getLockMem(ta).has(wcName)) return;
    const savedParentId = res.parentId;
    const savedStart    = res.start;
    const savedEnd      = res.end;
    const descIds       = getDescendants(state, res.id);
    state.resolutions   = state.resolutions.filter(
      r => !descIds.includes(r.id) && r.id !== res.id
    );
    getSelMem(ta).set(wcName, chosen);
    const newText = ta.value.slice(0, savedStart) + chosen + ta.value.slice(savedEnd);
    const delta   = chosen.length - (savedEnd - savedStart);
    // Skip ancestors when shifting; grow them instead
    {
      const idsToSkip = new Set();
      let cur = savedParentId ? state.resolutions.find(r => r.id === savedParentId) : null;
      while (cur) { idsToSkip.add(cur.id); cur = cur.parentId ? state.resolutions.find(r => r.id === cur.parentId) : null; }
      shiftResolutions(state, savedEnd, delta, idsToSkip);
      cur = savedParentId ? state.resolutions.find(r => r.id === savedParentId) : null;
      while (cur) { cur.end += delta; cur = cur.parentId ? state.resolutions.find(r => r.id === cur.parentId) : null; }
    }
    const newRes = {
      id: makeId(), parentId: savedParentId,
      originalToken:   res.originalToken,
      replacementText: chosen,
      start: savedStart, end: savedStart + chosen.length,
      orangeTransparent: /^~~[^\s]+?~~$/.test(chosen.trim()),
    };
    state.resolutions.push(newRes);
    ta._wrPrevLen = newText.length;
    setVal(ta, newText);
    autoResolveMemory(ta, newRes, chosen);
    updateOverlay(ta);
    ta.focus();
  }

  async function showCtx(ta, res, cx, cy) {
    closeCtx();

    const state  = getState(ta);
    const wcName = res.originalToken.replace(/^~~|~~$/g, "");
    const desc   = getDescendants(state, res.id);

    // Fetch entries first — build menu only after data is ready
    const data = await fetchEntries(wcName);
    const entries = (data && data.entries) ? data.entries : [];

    // ── Build menu ────────────────────────────────────────────────────────────
    const menu = document.createElement("div");
    Object.assign(menu.style, {
      position: "fixed", zIndex: "99998",
      background: COLORS.bg2, border: `1px solid ${COLORS.bg4}`,
      borderRadius: "6px", boxShadow: "0 4px 16px rgba(0,0,0,0.6)",
      fontFamily: "ui-monospace,Consolas,monospace", fontSize: "13px",
      padding: "4px 0", minWidth: "260px", maxWidth: "420px",
      maxHeight: "440px", display: "flex", flexDirection: "column",
    });

    // ── Revert row ────────────────────────────────────────────────────────────
    const subLabel = desc.length ? `Also reverts ${desc.length} nested resolution(s)` : null;
    const revertEl = document.createElement("div");
    Object.assign(revertEl.style, {
      padding: "7px 14px", cursor: "pointer", color: COLORS.warn, flexShrink: "0",
    });
    revertEl.innerHTML = `<div>↩ Revert to ${escHtml(res.originalToken)}</div>` +
      (subLabel ? `<div style="font-size:11px;color:${COLORS.text2};">${escHtml(subLabel)}</div>` : "");
    revertEl.addEventListener("mouseenter", () => { revertEl.style.background = COLORS.bg3; });
    revertEl.addEventListener("mouseleave", () => { revertEl.style.background = ""; });
    revertEl.addEventListener("click", () => { closeCtx(); revert(ta, res.id); });
    menu.appendChild(revertEl);

    // ── Divider + search bar + entry list ─────────────────────────────────────
    if (entries.length > 0) {
      const div1 = document.createElement("div");
      div1.style.cssText = `height:1px;background:${COLORS.bg4};margin:4px 0;flex-shrink:0;`;
      menu.appendChild(div1);

      // Search row — identical to the popup search bar
      const searchRow = document.createElement("div");
      Object.assign(searchRow.style, {
        display: "flex", alignItems: "center", gap: "6px",
        padding: "6px 10px", borderBottom: `1px solid ${COLORS.bg4}`,
        flexShrink: "0", background: COLORS.bg2,
      });
      const searchInput = document.createElement("input");
      searchInput.type = "text"; searchInput.placeholder = "search…";
      Object.assign(searchInput.style, {
        flex: "1", background: COLORS.bg3, border: `1px solid ${COLORS.bg4}`,
        borderRadius: "4px", color: COLORS.text0, padding: "4px 8px",
        fontSize: "12px", outline: "none", fontFamily: "inherit",
      });
      const ctxToggle = document.createElement("button");
      const _ctxMode = getSearchMode();
      ctxToggle.dataset.mode = _ctxMode;
      Object.assign(ctxToggle.style, {
        background: COLORS.bg4, border: `1px solid ${COLORS.bg4}`,
        borderRadius: "4px", color: _ctxMode === "filter" ? "#a78bfa" : COLORS.accent,
        padding: "3px 7px", cursor: "pointer", fontSize: "13px", lineHeight: "1", flexShrink: "0",
      });
      ctxToggle.title = "Toggle: highlight matches / show only matches";
      ctxToggle.textContent = _ctxMode === "filter" ? "≡" : "🔍";
      ctxToggle.addEventListener("click", () => {
        const next = ctxToggle.dataset.mode === "highlight" ? "filter" : "highlight";
        ctxToggle.dataset.mode = next;
        ctxToggle.textContent  = next === "highlight" ? "🔍" : "≡";
        ctxToggle.style.color  = next === "highlight" ? COLORS.accent : "#a78bfa";
        saveSearchMode(next);
        applyCtxSearch(searchInput.value);
      });
      // "Use native menu next" one-shot button
      const nativeBtn = document.createElement("button");
      Object.assign(nativeBtn.style, {
        background: COLORS.bg4, border: `1px solid ${COLORS.bg4}`,
        borderRadius: "4px", color: COLORS.text2,
        padding: "3px 7px", cursor: "pointer", fontSize: "13px", lineHeight: "1", flexShrink: "0",
      });
      nativeBtn.title    = "Use native right-click menu on next right-click";
      nativeBtn.textContent = "⋮";
      nativeBtn.addEventListener("click", () => {
        ta._wrNativeNext = true;
        closeCtx();
      });

      // Lock/unlock button — toggles lockMem for this wildcard
      const lockMem2  = getLockMem(ta);
      const isLocked  = lockMem2.has(wcName);
      const lockBtn   = document.createElement("button");
      Object.assign(lockBtn.style, {
        background: COLORS.bg4, border: `1px solid ${COLORS.bg4}`,
        borderRadius: "4px", color: isLocked ? "#f87171" : COLORS.text2,
        padding: "3px 7px", cursor: "pointer", fontSize: "13px", lineHeight: "1", flexShrink: "0",
      });
      lockBtn.title       = isLocked ? "Unlock this wildcard" : "Lock this wildcard to its current entry";
      lockBtn.textContent = isLocked ? "🔒" : "🔓";
      lockBtn.addEventListener("click", () => {
        const lm = getLockMem(ta);
        if (lm.has(wcName)) {
          lm.delete(wcName);
          lockBtn.textContent = "🔓";
          lockBtn.style.color = COLORS.text2;
          lockBtn.title = "Lock this wildcard to its current entry";
        } else {
          lm.set(wcName, res.replacementText);
          // Also update selMem so memory stays consistent
          getSelMem(ta).set(wcName, res.replacementText);
          lockBtn.textContent = "🔒";
          lockBtn.style.color = "#f87171";
          lockBtn.title = "Unlock this wildcard";
        }
        updateOverlay(ta);
      });

      searchRow.appendChild(searchInput);
      searchRow.appendChild(ctxToggle);
      searchRow.appendChild(nativeBtn);
      searchRow.appendChild(lockBtn);
      menu.appendChild(searchRow);

      // Entry list
      const listEl = document.createElement("div");
      Object.assign(listEl.style, { overflowY: "auto", flexGrow: "1", padding: "2px 0" });

      const ctxItems = [];
      entries.forEach(entry => {
        const el = document.createElement("div");
        const isCurrent = entry === res.replacementText;
        Object.assign(el.style, {
          padding: "4px 14px", paddingLeft: isCurrent ? "11px" : "14px",
          cursor: "pointer", color: COLORS.text0, fontSize: "12px",
          whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: "1.35", flexShrink: "0",
          background: isCurrent ? "rgba(126,184,247,0.13)" : "",
          borderLeft:  isCurrent ? `3px solid ${COLORS.accent}` : "",
        });
        el.innerHTML = entryToHtml(entry);
        el.addEventListener("mouseenter", () => { el.style.background = COLORS.bg3; });
        el.addEventListener("mouseleave", () => {
          el.style.background = isCurrent ? "rgba(126,184,247,0.13)" : "";
        });
        el.addEventListener("click", () => { closeCtx(); applyChoice(ta, res, entry); });
        listEl.appendChild(el);
        ctxItems.push({ el, entry });
      });
      menu.appendChild(listEl);

      // Search helpers (same logic as popup)
      function escapeRegex(str) { return str.replace(/[.*+?^${}()|\[\]\\]/g, "\$&"); }
      function highlightTerm(safeHtml, term) {
        if (!term) return safeHtml;
        const re = new RegExp(escapeRegex(escHtml(term)), "gi");
        return safeHtml.replace(/((?:<[^>]+>)+|[^<]+)/g, chunk =>
          chunk.startsWith("<") ? chunk :
          chunk.replace(re, m => `<mark style="background:#854d0e;color:#fde68a;border-radius:2px;">${m}</mark>`)
        );
      }
      function applyCtxSearch(raw) {
        const term = raw.trim().toLowerCase();
        const mode = ctxToggle.dataset.mode;
        ctxItems.forEach(it => {
          const matches = !term || it.entry.toLowerCase().includes(term);
          if (mode === "filter") {
            it.el.style.display = matches ? "" : "none";
            it.el.innerHTML = matches ? (term ? highlightTerm(entryToHtml(it.entry), term) : entryToHtml(it.entry)) : "";
          } else {
            it.el.style.display = "";
            it.el.innerHTML = term && matches ? highlightTerm(entryToHtml(it.entry), term) : entryToHtml(it.entry);
          }
        });
      }
      searchInput.addEventListener("input", () => applyCtxSearch(searchInput.value));
      setTimeout(() => searchInput.focus(), 0);
    }

    document.body.appendChild(menu);
    activeCtx = menu;

    const menuW = 280, menuH = 440;
    let x = cx;
    x = Math.min(x, window.innerWidth - menuW - 10);
    if (x < 10) x = 10;
    let y = cy;
    if (y + menuH > window.innerHeight - 10) y = window.innerHeight - menuH - 10;
    if (y < 10) y = 10;
    menu.style.left = x + "px";
    menu.style.top  = y + "px";

    // Dismiss on click outside
    setTimeout(() => {
      document.addEventListener("click", function oc(e) {
        if (activeCtx && !activeCtx.contains(e.target)) {
          closeCtx();
          document.removeEventListener("click", oc, true);
        }
      }, true);
    }, 0);
  }
  // ── Auto-resolve wildcards using selection memory ────────────────────────
  // Public entry point: called after inserting `chosen` as parentRes's text.
  // Builds the fully-substituted text entirely in memory, updates state, then
  // fires setVal exactly once so Gradio only sees one authoritative value.
  function autoResolveMemory(ta, parentRes, chosen) {
    const state  = getState(ta);
    const selMem = getSelMem(ta);
    const _lmKeys = [...getLockMem(ta).keys()];
    const _smKeys = [...selMem.keys()];

    // ctx holds the working textarea text as we build substitutions
    const ctx = { text: ta.value };
    _autoResolveMem(ta, state, selMem, parentRes, chosen, ctx);

    if (ctx.text !== ta.value) {
      ta._wrPrevLen = ctx.text.length;
      setVal(ta, ctx.text);
    }
  }

  // Internal recursive worker — mutates ctx.text and state.resolutions in place.
  // Never calls setVal; caller does that once at the top level.
  function _autoResolveMem(ta, state, selMem, parentRes, chosen, ctx) {
    const wcRe = /~~([^\s]+?)~~/g;
    let m;
    const tokens = [];
    while ((m = wcRe.exec(chosen)) !== null)
      tokens.push({ name: m[1], token: m[0], localStart: m.index });
    if (tokens.length === 0) return;

    const lockMem = getLockMem(ta);
    const toApply = tokens.filter(t => lockMem.has(t.name) || selMem.has(t.name));
    if (toApply.length === 0) return;

    const childQueue = [];

    for (const tok of [...toApply].reverse()) {
      // Locked entries always win over selMem
      const remembered = lockMem.has(tok.name) ? lockMem.get(tok.name) : selMem.get(tok.name);
      const absStart   = parentRes.start + tok.localStart;
      const absEnd     = absStart + tok.token.length;


      if (ctx.text.slice(absStart, absEnd) !== tok.token) {
        continue;
      }

      const delta   = remembered.length - tok.token.length;
      ctx.text      = ctx.text.slice(0, absStart) + remembered + ctx.text.slice(absEnd);

      const childRes = {
        id: makeId(), parentId: parentRes.id,
        originalToken:   tok.token,
        replacementText: remembered,
        start: absStart, end: absStart + remembered.length,
        orangeTransparent: /^~~[^\s]+?~~$/.test(remembered.trim()),
      };

      // Shift non-ancestors; grow ancestors
      const ancestorSet = new Set();
      { let anc = parentRes; while (anc) { ancestorSet.add(anc.id); anc = anc.parentId ? state.resolutions.find(r => r.id === anc.parentId) : null; } }
      for (const r of state.resolutions) {
        if (ancestorSet.has(r.id)) continue;
        if      (r.start >= absEnd)  { r.start += delta; r.end += delta; }
        else if (r.end   >= absEnd)  { r.end   += delta; }
      }
      for (const ancId of ancestorSet) {
        const anc = state.resolutions.find(r => r.id === ancId);
        if (anc && anc.end >= absEnd) anc.end += delta;
      }

      state.resolutions.push(childRes);
      childQueue.push({ childRes, remembered });
    }

    for (const { childRes, remembered } of childQueue) {
      _autoResolveMem(ta, state, selMem, childRes, remembered, ctx);
    }
  }
  // ── Chain serialisation ────────────────────────────────────────────────────
  // Encodes the current resolution tree into the ~~wc~~<<contents>> format.
  // Only called from the generate-button hook, not on every keystroke.

  function serialiseChainFromState(ta, state) {
    console.log(`[WildcardResolver] serialiseChain: key=${ta.dataset.wrKey}, resolutions=${state.resolutions.length}`);
    if (state.resolutions.length === 0) return "";

    // Build a lookup: id → resolution
    const byId = {};
    for (const r of state.resolutions) byId[r.id] = r;

    // Get the top-level resolutions (no parent, or parent not in current state)
    const currentIds = new Set(state.resolutions.map(r => r.id));
    const roots = state.resolutions.filter(
      r => !r.parentId || !currentIds.has(r.parentId)
    );

    // Recursively serialise one resolution node.
    // Returns the ~~token~~<<serialised-contents>> string.
    function serialiseNode(res) {
      // Get direct children of this resolution, sorted by position
      const children = state.resolutions
        .filter(r => r.parentId === res.id)
        .sort((a, b) => a.start - b.start);

      // Build the replacement text with child nodes substituted in
      let contents = res.replacementText;

      // Walk children in reverse order so substitution offsets stay valid.
      // We substitute each child's originalToken within `contents` with the
      // serialised child — but `contents` is the replacementText string,
      // and child positions are in the *current textarea*, not in replacementText.
      // So we re-find each child's originalToken in contents and replace it.
      // We go right-to-left by position in the current textarea.
      const childrenRev = [...children].reverse();
      for (const child of childrenRev) {
        const serialisedChild = serialiseNode(child);
        // Find the first occurrence of child.originalToken in contents
        // (there should be exactly one, since the user selected it from that wildcard)
        const idx = contents.indexOf(child.originalToken);
        if (idx !== -1) {
          contents = contents.slice(0, idx) + serialisedChild
                   + contents.slice(idx + child.originalToken.length);
        }
      }

      return `${res.originalToken}<<${contents}>>`;
    }

    // The final chain is built over the full textarea value, substituting
    // each root resolution's originalToken with its serialised form.
    let result = ta.value;
    const rootsRev = [...roots].sort((a, b) => b.start - a.start);
    for (const root of rootsRev) {
      const serialised = serialiseNode(root);
      result = result.slice(0, root.start) + serialised + result.slice(root.end);
    }
    return result;
  }

  function serialiseChain(ta) {
    return serialiseChainFromState(ta, getState(ta));
  }

  // ── Paste parser ───────────────────────────────────────────────────────────
  // Parses ~~wc~~<<contents>> strings back into resolution state + final prompt.
  // Only fires when pasted text has ≥2 "~~", ≥1 "<<", and ≥1 ">>".

  // Low-level: find the matching ">>" for a "<<" starting at `openPos` in `s`.
  // Returns the index of the first char of the closing ">>", or -1 if not found.
  function findMatchingClose(s, openPos) {
    let depth = 0;
    let i     = openPos;
    while (i < s.length - 1) {
      if (s[i] === '<' && s[i+1] === '<') { depth++; i += 2; continue; }
      if (s[i] === '>' && s[i+1] === '>') {
        depth--;
        if (depth === 0) return i;
        i += 2; continue;
      }
      i++;
    }
    return -1;
  }

  // Parse a chain string into a tree of { token, contents, children[] } nodes.
  // `s` is a string that may contain ~~wc~~<<...>> annotations mixed with plain text.
  // Returns { finalText, nodes } where nodes are the top-level resolution records.
  function parseChainString(s) {
    // We walk through `s` finding ~~token~~<< ... >> patterns.
    // Everything outside those patterns is plain text.
    // Returns { finalText: string, resNodes: [{originalToken, replacementText, children}] }

    function parseSegment(seg) {
      // Returns { finalText, resNodes }
      const resNodes  = [];
      let   finalText = "";
      let   i         = 0;

      while (i < seg.length) {
        // Look for ~~name~~
        const wcStart = seg.indexOf("~~", i);
        if (wcStart === -1) {
          // No more wildcards — rest is plain text
          finalText += seg.slice(i);
          break;
        }

        // Append text before the wildcard
        finalText += seg.slice(i, wcStart);

        const wcEnd2 = seg.indexOf("~~", wcStart + 2);
        if (wcEnd2 === -1) {
          // Unclosed ~~, treat as plain text
          finalText += seg.slice(wcStart);
          break;
        }

        const tokenEnd   = wcEnd2 + 2;            // index after closing ~~
        const token      = seg.slice(wcStart, tokenEnd); // e.g. "~~character~~"

        // Check if immediately followed by <<
        if (seg[tokenEnd] === '<' && seg[tokenEnd + 1] === '<') {
          // Find matching >>
          const closePos = findMatchingClose(seg, tokenEnd);
          if (closePos === -1) {
            // Malformed — treat remainder as plain text
            finalText += seg.slice(wcStart);
            break;
          }
          // Inner content is between << and >>
          const innerContent = seg.slice(tokenEnd + 2, closePos);

          // Recursively parse inner content
          const inner = parseSegment(innerContent);

          resNodes.push({
            originalToken:   token,
            replacementText: innerContent,   // raw replacement (still has nested annotations)
            cleanReplacement: inner.finalText, // with annotations stripped
            children:        inner.resNodes,
          });

          // The final text uses the fully-resolved inner text
          finalText += inner.finalText;
          i = closePos + 2;  // skip past >>
        } else {
          // ~~token~~ with no << following — it's an unresolved wildcard in the final text
          finalText += token;
          i = tokenEnd;
        }
      }

      return { finalText, resNodes };
    }

    return parseSegment(s);
  }

  // Apply a parsed chain to a textarea: set the final prompt text and reconstruct
  // the resolution state so revert works correctly.
  function applyParsedChain(ta, parsed) {
    const state = getState(ta);
    state.resolutions = [];

    // We need to walk the node tree and register resolutions with correct
    // char offsets into the final prompt text.
    // finalText is already computed; we need to find where each node's
    // cleanReplacement lands within it.

    function registerNodes(nodes, parentId, textSoFar) {
      // textSoFar is the final text; we scan it to find each node's position.
      // Nodes appear in order, so we walk left-to-right.
      let searchFrom = 0;

      for (const node of nodes) {
        // Find cleanReplacement in textSoFar starting from searchFrom
        const pos = textSoFar.indexOf(node.cleanReplacement, searchFrom);
        if (pos === -1) continue;  // can't locate — skip

        const resId = makeId();
        state.resolutions.push({
          id:              resId,
          parentId:        parentId,
          originalToken:   node.originalToken,
          replacementText: node.cleanReplacement,
          start:           pos,
          end:             pos + node.cleanReplacement.length,
          orangeTransparent: /^~~[^\s]+?~~$/.test(node.cleanReplacement.trim()),
        });

        // Register children within this node's cleanReplacement slice
        if (node.children.length > 0) {
          registerNodes(node.children, resId, node.cleanReplacement);
          // Shift children's offsets to be absolute in finalText
          const addedOffset = pos;
          for (const r of state.resolutions) {
            if (r.parentId === resId) {
              r.start += addedOffset;
              r.end   += addedOffset;
            }
          }
        }

        searchFrom = pos + node.cleanReplacement.length;
      }
    }

    registerNodes(parsed.resNodes, null, parsed.finalText);
    setVal(ta, parsed.finalText);
    updateOverlay(ta);
  }

  // Quick bail-out check before attempting a full parse
  function looksLikeChain(text) {
    const wcCount = (text.match(/~~/g) || []).length;
    return wcCount >= 2
      && text.includes("<<")
      && text.includes(">>");
  }

  // ── Generate-button hook: POST chain to Python before image generation ─────
  // We intercept the Generate button click, serialise, POST, then let it proceed.

  // ── Chain sentinel constants (must match Python) ──────────────────────────
  const CHAIN_START = "||WRC||";
  const CHAIN_END   = "||/WRC||";

  function hookGenerateButton(posPromptTa, tabPrefix) {
    const btnId    = tabPrefix === "i2i" ? "img2img_generate"     : "txt2img_generate";
    const posSelec = tabPrefix === "i2i" ? "#img2img_prompt textarea"
                                         : "#txt2img_prompt textarea";

    const guardKey = `wr_gen_hooked_${tabPrefix}`;
    if (window[guardKey]) return;
    window[guardKey] = true;

    console.log(`[WildcardResolver] hookGenerateButton: looking for #${btnId}`);

    function onGenerateClick() {
      // Find state — try exact key first, then scan all states
      let posState = stateByKey.get(posSelec);
      if (!posState || posState.resolutions.length === 0) {
        for (const [k, v] of stateByKey) {
          if (v.resolutions.length > 0 && k.includes(
              tabPrefix === "i2i" ? "img2img_prompt" : "txt2img_prompt")) {
            posState = v;
            break;
          }
        }
      }

      const liveTa = document.querySelector(posSelec);
      if (!liveTa) return;

      // Ensure the live textarea element has its stable key registered so
      // getLockMem / getSelMem resolve to the same maps used at hook time.
      // Gradio can replace the DOM node; the selector string is the stable identity.
      if (!liveTa.dataset.wrKey) {
        liveTa.dataset.wrKey = posSelec;
        SELECTOR_FOR_TA.set(liveTa, posSelec);
      }

      // Build chain from UI resolutions (may be empty string if none)
      const hasResolutions = posState && posState.resolutions.length > 0;
      let chain = hasResolutions ? serialiseChainFromState(liveTa, posState) : "";

      // Append any locked wildcards not already covered by the chain.
      // These are serialised as ~~name~~<<locked_value>> so the Python
      // override hook can read and apply them even with no UI resolutions.
      const lockMem = getLockMem(liveTa);
      if (lockMem.size > 0) {
        // Find wc names already in chain so we don't duplicate
        const inChain = new Set();
        const wcRe = /~~([^\s]+?)~~/g;
        let m2;
        while ((m2 = wcRe.exec(chain)) !== null) inChain.add(m2[1]);
        let lockSuffix = "";
        for (const [name, value] of lockMem) {
          if (!inChain.has(name)) {
            lockSuffix += `~~${name}~~<<${value}>>`;
          }
        }
        chain += lockSuffix;
      }

      if (!chain) return;

      console.log(`[WildcardResolver] Injecting chain (${chain.length} chars) into prompt`);

      // Strip any leftover sentinel from a previous generate
      let current = liveTa.value;
      const prev = current.indexOf(CHAIN_START);
      if (prev !== -1) current = current.slice(0, prev);

      // Inject sentinel AND fire Gradio's reactive events so its internal Svelte
      // store picks up the new value.  Without input/change, Gradio reads its
      // own cached state — not the raw DOM value — and Python never sees the
      // sentinel.  We guard our own input-handler with _wrInjectingSentinel so
      // it skips resolution-offset mutation during these synthetic events.
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, "value").set;
      const injectedValue = current + CHAIN_START + chain + CHAIN_END;
      liveTa._wrInjectingSentinel = true;
      liveTa._wrPrevLen = injectedValue.length;
      setter.call(liveTa, injectedValue);
      liveTa.dispatchEvent(new Event("input",  { bubbles: true }));
      liveTa.dispatchEvent(new Event("change", { bubbles: true }));
      liveTa._wrInjectingSentinel = false;
      console.log(`[WildcardResolver] Prompt tail after injection: "${liveTa.value.slice(-80)}"`);

      // Strip sentinel back after 2 s so the user never sees it linger.
      // Do NOT fire input/change here — Gradio has already consumed the prompt
      // for generation, and firing events now would cause sd-dynamic-prompts to
      // re-resolve the prompt mid-batch, corrupting the tracer's record counts.
      setTimeout(() => {
        const ta2 = document.querySelector(posSelec);
        if (!ta2) return;
        const s = ta2.value.indexOf(CHAIN_START);
        if (s !== -1) {
          const cleanVal = ta2.value.slice(0, s);
          ta2._wrInjectingSentinel = true;
          ta2._wrPrevLen = cleanVal.length;
          setter.call(ta2, cleanVal);
          // No input/change dispatch — generation is already in progress
          ta2._wrInjectingSentinel = false;
          updateOverlay(ta2);
        }
      }, 2000);
    }

    let attempts = 0;
    const poll = setInterval(() => {
      const btn = document.getElementById(btnId);
      if (btn) {
        clearInterval(poll);
        btn.addEventListener("click", onGenerateClick, { capture: true });
        console.log(`[WildcardResolver] ✓ Hooked generate button: #${btnId}`);
      }
      if (++attempts > 30) clearInterval(poll);
    }, 500);
  }

  // ── Hook a single textarea ─────────────────────────────────────────────────
  function hookTextarea(ta, sel) {
    if (ta.dataset.wrHooked) return;
    ta.dataset.wrHooked = "1";
    ta.dataset.wrKey    = sel;
    SELECTOR_FOR_TA.set(ta, sel);  // register before any getState call
    console.log("[WildcardResolver] Hooked textarea:", sel);

    // Initialise overlay
    getOverlayContainer(ta);

    // Track textarea length and caret position BEFORE each edit so we can
    // compute the exact edit anchor when the input event fires.
    ta._wrPrevLen    = ta.value.length;
    ta._wrPreEditPos = 0;
    ta.addEventListener("keydown",   () => { ta._wrPreEditPos = ta.selectionStart; });
    ta.addEventListener("mousedown", () => { ta._wrPreEditPos = ta.selectionStart; });

    // On every user edit, shift resolution bounds to match.
    ta.addEventListener("input", () => {
      // Skip state mutation during our own sentinel injection/removal
      if (ta._wrInjectingSentinel) { updateOverlay(ta); return; }
      const state = getState(ta);
      if (state.resolutions.length > 0) {
        const newLen = ta.value.length;
        const oldLen = ta._wrPrevLen;
        const delta  = newLen - oldLen;
        if (delta !== 0) {
          // For insertions the edit started at (cursor - delta).
          // For deletions/replacements it started at the pre-edit caret position.
          const editPos = delta > 0
            ? ta.selectionStart - delta
            : ta._wrPreEditPos;
          shiftResolutions(state, editPos, delta);
        }
      }
      ta._wrPrevLen    = ta.value.length;
      ta._wrPreEditPos = ta.selectionStart;
      updateOverlay(ta);
    });
    ta.addEventListener("change", () => {
      ta._wrPrevLen    = ta.value.length;
      ta._wrPreEditPos = ta.selectionStart;
      updateOverlay(ta);
    });

    // ── Paste: detect and apply chain strings ──────────────────────────────
    ta.addEventListener("paste", e => {
      const pasted = (e.clipboardData || window.clipboardData).getData("text");

      // Quick bail-out: don't parse unless it looks like a chain string.
      // This keeps normal paste at full speed.
      if (!looksLikeChain(pasted)) return;

      // Let the default paste happen first so the textarea value updates,
      // then immediately overwrite with the parsed result.
      setTimeout(() => {
        // The textarea now contains the pasted text (possibly inserted mid-prompt).
        // For simplicity we only restore chains when the entire textarea content
        // is (or contains) the chain string — find it and replace that span.
        const fullText = ta.value;
        const chainStart = fullText.indexOf(pasted);
        if (chainStart === -1) return;  // can't locate — bail

        const parsed = parseChainString(pasted);
        if (!parsed.resNodes.length) return;  // nothing to restore

        // Replace the pasted chain region with the clean final text
        const before  = fullText.slice(0, chainStart);
        const after   = fullText.slice(chainStart + pasted.length);
        const newFull = before + parsed.finalText + after;

        // Rebuild state: clear existing resolutions, re-register with offset
        const state = getState(ta);
        state.resolutions = [];

        // Offset all positions by `before.length`
        const offset = before.length;

        function registerNodes(nodes, parentId, contextText, contextOffset) {
          let searchFrom = 0;
          for (const node of nodes) {
            const pos = contextText.indexOf(node.cleanReplacement, searchFrom);
            if (pos === -1) continue;

            const absStart = contextOffset + pos;
            const absEnd   = absStart + node.cleanReplacement.length;
            const resId    = makeId();

            state.resolutions.push({
              id:              resId,
              parentId:        parentId,
              originalToken:   node.originalToken,
              replacementText: node.cleanReplacement,
              start:           absStart,
              end:             absEnd,
              orangeTransparent: /^~~[^\s]+?~~$/.test(node.cleanReplacement.trim()),
            });

            if (node.children.length > 0) {
              registerNodes(node.children, resId, node.cleanReplacement, absStart);
            }

            searchFrom = pos + node.cleanReplacement.length;
          }
        }

        registerNodes(parsed.resNodes, null, parsed.finalText, offset);

        setVal(ta, newFull);
        updateOverlay(ta);
      }, 0);
    });

    // Double-click → show popup
    ta.addEventListener("dblclick", async e => {
      await new Promise(r => setTimeout(r, 40));
      const idx = ta.selectionStart;
      const wc  = findWildcardAt(ta.value, idx);
      if (!wc) return;

      e.preventDefault();
      e.stopPropagation();

      const state    = getState(ta);
      const parentId = (findResAt(state, wc.start) || {}).id || null;

      const data = await fetchEntries(wc.name);

      if (!data.entries || data.entries.length === 0) {
        showPopup(
          [`⚠ ${data.error || "No entries found"}`],
          wc.name, e.clientX, e.clientY, () => {}, ta
        );
        return;
      }

      showPopup(data.entries, wc.name, e.clientX, e.clientY, chosen => {
        const wc2     = findWildcardAt(ta.value, ta.selectionStart) || wc;
        const tokenAt = ta.value.slice(wc2.start, wc2.end);
        if (tokenAt !== `${WRAP}${wc2.name}${WRAP}`) return;

        // If locked, block repicking entirely
        if (getLockMem(ta).has(wc2.name)) return;
        // Remember this choice for future auto-resolution
        getSelMem(ta).set(wc2.name, chosen);

        const newText = ta.value.slice(0, wc2.start) + chosen + ta.value.slice(wc2.end);
        const delta   = chosen.length - (wc2.end - wc2.start);

        const res = {
          id: makeId(), parentId,
          originalToken:   `${WRAP}${wc2.name}${WRAP}`,
          replacementText: chosen,
          start: wc2.start,
          end:   wc2.start + chosen.length,
          orangeTransparent: /^~~[^\s]+?~~$/.test(chosen.trim()),
        };

        // Shift non-ancestor resolutions; grow ancestors to cover new content
        const ancestorIds = getAncestorIds(state, res.id || '');
        // res not in state yet so we derive ancestors from parentId chain manually
        {
          const idsToSkip = new Set();
          let cur = parentId ? state.resolutions.find(r => r.id === parentId) : null;
          while (cur) { idsToSkip.add(cur.id); cur = cur.parentId ? state.resolutions.find(r => r.id === cur.parentId) : null; }
          shiftResolutions(state, wc2.end, delta, idsToSkip);
          // Grow each ancestor's end
          cur = parentId ? state.resolutions.find(r => r.id === parentId) : null;
          while (cur) { cur.end += delta; cur = cur.parentId ? state.resolutions.find(r => r.id === cur.parentId) : null; }
        }
        state.resolutions.push(res);

        // Set _wrPrevLen before setVal so input handler sees delta=0
        ta._wrPrevLen = newText.length;
        setVal(ta, newText);

        // Auto-resolve any wildcards in `chosen` that have remembered entries
        autoResolveMemory(ta, res, chosen);

        updateOverlay(ta);
        ta.focus();
      }, ta);
    });

    // Right-click → extension menu (unless _wrNativeNext one-shot flag is set).
    // The ⋮ button in the extension menu sets _wrNativeNext so the very next
    // right-click bypasses the extension menu and shows only the native one.
    ta.addEventListener("contextmenu", e => {
      // One-shot native passthrough
      if (ta._wrNativeNext) {
        ta._wrNativeNext = false;
        return;  // let browser handle normally
      }
      const state = getState(ta);
      const res   = findResAt(state, ta.selectionStart);
      if (!res) return;   // not on resolved span — native menu only
      e.preventDefault();
      showCtx(ta, res, e.clientX, e.clientY);
    });
    // Only hook the generate button from the POSITIVE prompt textarea.
    // Neg-prompt and img2img secondary textareas must not add duplicate hooks.
    const isPositivePrompt = ta.closest("#txt2img_prompt, #img2img_prompt");
    if (isPositivePrompt) {
      const tabPrefix = ta.closest("#img2img_prompt") ? "i2i" : "t2i";
      console.log(`[WildcardResolver] Positive prompt hooked, tabPrefix=${tabPrefix}, will look for generate button`);
      hookGenerateButton(ta, tabPrefix);
    } else {
      console.log(`[WildcardResolver] Skipping generate hook for non-positive-prompt textarea`);
    }
  }

  // ── Find and hook all prompt textareas ────────────────────────────────────
  const PROMPT_SELECTORS = [
    "#txt2img_prompt textarea",
    "#txt2img_neg_prompt textarea",
    "#img2img_prompt textarea",
    "#img2img_neg_prompt textarea",
  ];

  function hookAll() {
    PROMPT_SELECTORS.forEach(sel => {
      const el = document.querySelector(sel);
      if (el) hookTextarea(el, sel);
    });
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  if (typeof onUiLoaded !== "undefined") {
    onUiLoaded(() => {
      hookAll();
      let attempts = 0;
      const poll = setInterval(() => {
        hookAll();
        if (++attempts >= 10) clearInterval(poll);
      }, 1000);
    });
  } else {
    const tryInit = () => {
      hookAll();
      let attempts = 0;
      const poll = setInterval(() => {
        hookAll();
        if (++attempts >= 20) clearInterval(poll);
      }, 1000);
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", tryInit);
    } else {
      setTimeout(tryInit, 1500);
    }
  }

  document.addEventListener("click", e => {
    if (e.target.closest("button[role='tab'], .tab-nav button")) {
      setTimeout(hookAll, 800);
    }
  });

  console.log("[WildcardResolver] Script loaded.");

})();
