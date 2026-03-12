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
    // Resolved span: semi-transparent orange, stackable. 3× original alpha.
    res_hl:   "rgba(245,158,11,0.29)",   // per-layer orange tint (stacks multiplicatively)
    res_border: "#92400e",               // underline colour
    // Angle-bracket tokens <lora:...> etc — green highlight in popup + overlay
    ab_hl:    "#0f3d1a",       // green bg
    ab_hl_fg: "#6ee7a0",       // green fg
  };

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
  const stateMap = new WeakMap();
  function getState(ta) {
    if (!stateMap.has(ta)) stateMap.set(ta, { resolutions: [] });
    return stateMap.get(ta);
  }
  function makeId() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  // ── Span / offset tracking ─────────────────────────────────────────────────
  function shiftResolutions(state, afterPos, delta) {
    for (const r of state.resolutions) {
      if (r.start >= afterPos)   { r.start += delta; r.end += delta; }
      else if (r.end > afterPos) { r.end += delta; }
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
    const desc = getDescendants(state, resId);
    state.resolutions = state.resolutions.filter(r => !desc.includes(r.id));
    const newText = ta.value.slice(0, res.start) + res.originalToken + ta.value.slice(res.end);
    const delta   = res.originalToken.length - (res.end - res.start);
    state.resolutions = state.resolutions.filter(r => r.id !== resId);
    shiftResolutions(state, res.end, delta);
    setVal(ta, newText);
    updateOverlay(ta);
    ta.setSelectionRange(res.start, res.start + res.originalToken.length);
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

  const overlayMap = new WeakMap();

  function getOverlayContainer(ta) {
    if (overlayMap.has(ta)) return overlayMap.get(ta);

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
    overlayMap.set(ta, mirror);

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
      wcRanges.push({ start: m.index, end: m.index + m[0].length, type: "wc" });
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
      events.push({ pos: sp.start, kind: "open",  type: "res" });
      events.push({ pos: sp.end,   kind: "close", type: "res" });
    }
    for (const wc of wcRanges) {
      events.push({ pos: wc.start, kind: "open",  type: "wc" });
      events.push({ pos: wc.end,   kind: "close", type: "wc" });
    }
    for (const ab of abRanges) {
      events.push({ pos: ab.start, kind: "open",  type: "ab" });
      events.push({ pos: ab.end,   kind: "close", type: "ab" });
    }
    events.sort((a, b) => a.pos - b.pos || (a.kind === "close" ? -1 : 1));

    let html     = "";
    let cursor   = 0;
    let resDepth = 0;
    let inWc     = false;
    let inAb     = false;

    function flushText(to) {
      if (to <= cursor) return;
      const chunk = escHtml(text.slice(cursor, to));
      if (inWc) {
        html += `<span style="background:${COLORS.wc_hl};">${chunk}</span>`;
      } else if (inAb) {
        html += `<span style="background:${COLORS.ab_hl};">${chunk}</span>`;
      } else if (resDepth > 0) {
        // Emit one span per depth level — each adds another alpha layer,
        // so depth=2 renders as rgba^2, depth=3 as rgba^3, etc.
        const open  = `<span style="background:${COLORS.res_hl};">`.repeat(resDepth);
        const close = `</span>`.repeat(resDepth);
        html += open + chunk + close;
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
          inWc = (ev.kind === "open");
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

  function showPopup(entries, wcName, cx, cy, onSelect) {
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
    // We store the mode on the button as a dataset flag.
    const toggleBtn = document.createElement("button");
    toggleBtn.dataset.mode = "highlight";   // "highlight" | "filter"
    Object.assign(toggleBtn.style, {
      background: COLORS.bg4, border: `1px solid ${COLORS.bg4}`,
      borderRadius: "4px", color: COLORS.accent,
      padding: "3px 7px", cursor: "pointer", fontSize: "13px",
      lineHeight: "1", flexShrink: "0",
    });
    toggleBtn.title    = "Toggle: highlight matches / show only matches";
    toggleBtn.textContent = "🔍";

    toggleBtn.addEventListener("click", () => {
      toggleBtn.dataset.mode = toggleBtn.dataset.mode === "highlight" ? "filter" : "highlight";
      toggleBtn.textContent  = toggleBtn.dataset.mode === "highlight" ? "🔍" : "≡";
      toggleBtn.style.color  = toggleBtn.dataset.mode === "highlight" ? COLORS.accent : COLORS.accent2 || "#a78bfa";
      applySearch(searchInput.value);
    });

    searchRow.appendChild(searchInput);
    searchRow.appendChild(toggleBtn);
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

  // ── Context menu (right-click revert) ─────────────────────────────────────
  let activeCtx = null;
  function closeCtx() { if (activeCtx) { activeCtx.remove(); activeCtx = null; } }

  function showCtx(ta, res, cx, cy) {
    closeCtx();
    const menu = document.createElement("div");
    Object.assign(menu.style, {
      position: "fixed", zIndex: "99998",
      background: COLORS.bg2, border: `1px solid ${COLORS.bg4}`,
      borderRadius: "6px", boxShadow: "0 4px 16px rgba(0,0,0,0.6)",
      fontFamily: "ui-monospace,Consolas,monospace", fontSize: "13px",
      padding: "4px 0", minWidth: "220px",
    });

    const state = getState(ta);
    const desc  = getDescendants(state, res.id);

    const addItem = (label, sub, color, fn) => {
      const el = document.createElement("div");
      Object.assign(el.style, { padding: "7px 14px", cursor: "pointer", color: color || COLORS.text0 });
      // label is trusted internal text, but escHtml the token just in case
      el.innerHTML = `<div>${label}</div>` + (sub ? `<div style="font-size:11px;color:${COLORS.text2};">${escHtml(sub)}</div>` : "");
      el.addEventListener("mouseenter", () => { el.style.background = COLORS.bg3; });
      el.addEventListener("mouseleave", () => { el.style.background = ""; });
      el.addEventListener("click",      () => { closeCtx(); fn(); });
      menu.appendChild(el);
    };

    const subLabel = desc.length ? `Also reverts ${desc.length} nested resolution(s)` : null;
    addItem(`↩ Revert to ${escHtml(res.originalToken)}`, subLabel, COLORS.warn, () => revert(ta, res.id));

    const divider = document.createElement("div");
    divider.style.cssText = `height:1px;background:${COLORS.bg4};margin:4px 0;`;
    menu.appendChild(divider);

    addItem("Copy text", null, null, () => {
      navigator.clipboard.writeText(ta.value.slice(res.start, res.end)).catch(() => {});
    });
    addItem("Leave as-is", null, COLORS.text2, () => {});

    document.body.appendChild(menu);
    activeCtx = menu;

    let x = Math.min(cx, window.innerWidth - 240);
    let y = cy;
    if (y + 140 > window.innerHeight) y = cy - 140;
    menu.style.left = x + "px";
    menu.style.top  = y + "px";

    setTimeout(() => {
      document.addEventListener("click", function oc(e) {
        if (activeCtx && !activeCtx.contains(e.target)) {
          closeCtx();
          document.removeEventListener("click", oc, true);
        }
      }, true);
    }, 0);
  }

  // ── Chain serialisation ────────────────────────────────────────────────────
  // Encodes the current resolution tree into the ~~wc~~<<contents>> format.
  // Only called from the generate-button hook, not on every keystroke.

  function serialiseChain(ta) {
    const state = getState(ta);
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
    const rootsRev = [...roots].sort((a, b) => b.start - a.start); // right to left
    for (const root of rootsRev) {
      const serialised = serialiseNode(root);
      result = result.slice(0, root.start) + serialised + result.slice(root.end);
    }
    return result;
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

  function hookGenerateButton(posPromptTa, tabPrefix) {
    const btnId    = tabPrefix === "i2i" ? "img2img_generate"     : "txt2img_generate";
    const negSelec = tabPrefix === "i2i" ? "#img2img_neg_prompt textarea"
                                         : "#txt2img_neg_prompt textarea";

    // Guard: only ever attach one listener per button
    const guardKey = `wr_gen_hooked_${tabPrefix}`;
    if (window[guardKey]) return;
    window[guardKey] = true;

    function onGenerateClick() {
      // Collect chain from positive prompt
      let chain = serialiseChain(posPromptTa);

      // Also collect from neg-prompt if it has resolutions
      const negTa = document.querySelector(negSelec);
      if (negTa) {
        const negChain = serialiseChain(negTa);
        if (negChain) {
          chain = chain ? `${chain} |neg| ${negChain}` : negChain;
        }
      }

      if (!chain) {
        console.log("[WildcardResolver] No resolved wildcards — skipping chain POST.");
        return;
      }

      console.log(`[WildcardResolver] Posting chain (${chain.length} chars) for tab ${tabPrefix}`);

      fetch("/wildcard-resolver/set-chain", {
        method:    "POST",
        headers:   { "Content-Type": "application/json" },
        body:      JSON.stringify({ tab: tabPrefix, chain }),
        keepalive: true,
      }).then(r => r.json())
        .then(d => console.log("[WildcardResolver] set-chain response:", d))
        .catch(err => console.warn("[WildcardResolver] set-chain failed:", err));
    }

    let attempts = 0;
    const poll = setInterval(() => {
      const btn = document.getElementById(btnId);
      if (btn) {
        clearInterval(poll);
        btn.addEventListener("click", onGenerateClick, { capture: true });
        console.log(`[WildcardResolver] Hooked generate button: ${btnId}`);
      }
      if (++attempts > 30) clearInterval(poll);
    }, 500);
  }

  // ── Hook a single textarea ─────────────────────────────────────────────────
  function hookTextarea(ta) {
    if (ta.dataset.wrHooked) return;
    ta.dataset.wrHooked = "1";
    console.log("[WildcardResolver] Hooked textarea:", ta.id || ta.closest("[id]")?.id || "(no id)");

    // Initialise overlay
    getOverlayContainer(ta);

    // Keep overlay in sync as user types
    ta.addEventListener("input",  () => updateOverlay(ta));
    ta.addEventListener("change", () => updateOverlay(ta));

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
          wc.name, e.clientX, e.clientY, () => {}
        );
        return;
      }

      showPopup(data.entries, wc.name, e.clientX, e.clientY, chosen => {
        const wc2     = findWildcardAt(ta.value, ta.selectionStart) || wc;
        const tokenAt = ta.value.slice(wc2.start, wc2.end);
        if (tokenAt !== `${WRAP}${wc2.name}${WRAP}`) return;

        const newText = ta.value.slice(0, wc2.start) + chosen + ta.value.slice(wc2.end);
        const delta   = chosen.length - (wc2.end - wc2.start);

        const res = {
          id: makeId(), parentId,
          originalToken:   `${WRAP}${wc2.name}${WRAP}`,
          replacementText: chosen,
          start: wc2.start,
          end:   wc2.start + chosen.length,
          // If the replacement is exclusively one wildcard token (nothing else),
          // don't add an orange layer — the token itself will get purple highlight
          // and the child resolution will carry its own orange when resolved.
          orangeTransparent: /^~~[^\s]+?~~$/.test(chosen.trim()),
        };

        shiftResolutions(state, wc2.end, delta);
        state.resolutions.push(res);

        setVal(ta, newText);
        updateOverlay(ta);
        ta.focus();
        ta.setSelectionRange(res.start, res.end);
      });
    });

    // Right-click → revert menu
    ta.addEventListener("contextmenu", e => {
      const state = getState(ta);
      const res   = findResAt(state, ta.selectionStart);
      if (!res) return;
      e.preventDefault();
      e.stopPropagation();
      showCtx(ta, res, e.clientX, e.clientY);
    });

    // Only hook the generate button from the POSITIVE prompt textarea.
    // Neg-prompt and img2img secondary textareas must not add duplicate hooks.
    const isPositivePrompt = ta.closest("#txt2img_prompt, #img2img_prompt");
    if (isPositivePrompt) {
      const tabPrefix = ta.closest("#img2img_prompt") ? "i2i" : "t2i";
      hookGenerateButton(ta, tabPrefix);
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
      if (el) hookTextarea(el);
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
