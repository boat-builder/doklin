// The comment bridge for the HTML rendition view.
//
// The rendition renders in a sandboxed iframe (opaque origin — deliberately:
// its scripts must never reach the app or Tauri IPC), so the app cannot touch
// its DOM. Instead, `instrumentHtml` injects a small self-contained script +
// stylesheet into the markup fed to srcDoc; the script owns everything
// DOM-side (anchor resolution, highlights, the hover "add comment" bubble)
// and talks to the app over postMessage. Only the in-app preview is
// instrumented — publishing and syncing read the rendition from disk, so the
// bridge never leaks into the public copy.
//
// UX ground rules, decided deliberately (the rendition is arbitrary,
// possibly interactive HTML — tabs, accordions, links, its own JS):
//
//   1. The whole comment layer lives behind an explicit COMMENT MODE (the
//      app's floating "Comment" button; `visible` on the sync message). Mode
//      off — the default — is the pristine rendition: no highlights, no
//      hover affordance, no scrim. Readers who never comment never see the
//      machinery.
//   2. In comment mode the bridge dims the page with a scrim and cuts
//      spotlight holes over the hovered block and every commented element,
//      so the comment layer reads clearly against arbitrary markup.
//   3. A plain click is NEVER a "create comment" click. Creation goes through
//      a dedicated hover affordance: a small bubble button that appears at
//      the top-right of the block under the pointer. The page's own clicks
//      (links, buttons, onclick handlers) are never repurposed, so nothing
//      the rendition does collides with commenting.
//   4. Clicking a commented (highlighted) element ACTIVATES its thread — the
//      app opens the floating card at the element — but never
//      preventDefault()s; the page's own handler still runs. Both happen;
//      neither blocks the other.
//   5. External links are the one place the bridge overrides the page:
//      following a link inside the iframe would replace the rendition (and
//      the comment layer) with the linked site, so http(s)/mailto links open
//      in the system browser via the app instead. Same-page #hash links keep
//      their in-page behavior.
//   6. The bridge listens in the capture phase, so renditions that
//      stopPropagation() in their own handlers can't starve activation — and
//      since activation never blocks (rule 4), the reverse holds too.
//
// Known limits, accepted: a rendition carrying a strict CSP <meta> that
// forbids inline scripts disables the comment layer (the preview still
// renders); nested iframes / shadow DOM inside the rendition are not
// commentable. Anchors that no longer resolve after the AI regenerates the
// file surface as "orphaned" cards in the rail — never silently dropped.

import type { HtmlAnchor, HtmlThread } from "./htmlComments";

// What the app sends the bridge. `threads` carries anchors only — bodies stay
// app-side. Sent on ready and on every change (threads are few; simplicity
// over deltas).
export type BridgeSyncMsg = {
  dk: "doklin-comments";
  type: "sync";
  threads: { id: string; anchor: HtmlAnchor }[];
  activeId: string | null;
  visible: boolean;
};
export type BridgeScrollToMsg = { dk: "doklin-comments"; type: "scroll-to"; id: string };

// What the bridge sends the app. Rects are iframe-viewport-relative, which
// is exactly the overlay layer's coordinate space (the iframe and the
// overlay share the same box), so no scroll arithmetic crosses the boundary.
export type AnchorRect = { top: number; left: number; width: number; height: number };
export type BridgeReadyMsg = { dk: "doklin-comments"; type: "ready" };
export type BridgeLayoutMsg = {
  dk: "doklin-comments";
  type: "layout";
  rects: ({ id: string } & AnchorRect)[];
  orphans: string[];
};
export type BridgePickMsg = {
  dk: "doklin-comments";
  type: "pick";
  anchor: HtmlAnchor;
  rect: AnchorRect;
};
export type BridgeActivateMsg = {
  dk: "doklin-comments";
  type: "activate";
  id: string | null;
};
export type BridgeOpenMsg = { dk: "doklin-comments"; type: "open"; url: string };
export type BridgeOutMsg =
  | BridgeReadyMsg
  | BridgeLayoutMsg
  | BridgePickMsg
  | BridgeActivateMsg
  | BridgeOpenMsg;

export function isBridgeMsg(data: unknown): data is BridgeOutMsg {
  const d = data as { dk?: string; type?: string };
  return !!d && typeof d === "object" && d.dk === "doklin-comments" && typeof d.type === "string";
}

// Resolve threads (app-side model) to the wire shape the bridge needs.
export function bridgeThreads(threads: HtmlThread[]): BridgeSyncMsg["threads"] {
  return threads.map((t) => ({ id: t.id, anchor: t.anchor }));
}

/* ---------- The injected assets ---------- */

// Highlights use hardcoded colors (the light-theme accent): the iframe can't
// read the app's CSS variables, and renditions overwhelmingly assume a white
// canvas of their own. `!important` keeps the rendition's stylesheet from
// swallowing the layer.
const BRIDGE_STYLE = `
[data-dk-t] {
  outline: 2px solid rgba(47, 111, 221, 0.38) !important;
  outline-offset: 2px;
  border-radius: 3px;
  transition: outline-color 0.12s ease, background-color 0.12s ease;
}
[data-dk-active] {
  outline-color: rgba(47, 111, 221, 0.95) !important;
  background-color: rgba(47, 111, 221, 0.07) !important;
}
[data-dk-hidden] [data-dk-t] {
  outline: none !important;
  background-color: transparent !important;
}
[data-dk-hover] {
  outline: 1.5px dashed rgba(47, 111, 221, 0.45) !important;
  outline-offset: 2px;
  border-radius: 3px;
}
@keyframes dk-flash {
  0% { background-color: rgba(47, 111, 221, 0.25); }
  100% { background-color: rgba(47, 111, 221, 0.07); }
}
[data-dk-flash] {
  animation: dk-flash 0.9s ease-out;
}
/* Comment-mode scrim: dims the page, with spotlight holes cleared over the
   hovered block and every commented element (drawn on the canvas — clearRect
   handles overlapping holes, unlike an evenodd clip path). Sits under the
   bubble, over everything else. */
#dk-scrim {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  display: none;
  pointer-events: none;
  z-index: 2147483646;
}
#dk-scrim.dk-on {
  display: block;
}
#dk-bubble {
  position: fixed;
  z-index: 2147483647;
  width: 26px;
  height: 26px;
  padding: 0;
  display: none;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 8px;
  background: #ffffff;
  color: #2f6fdd;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.14);
  cursor: pointer;
}
#dk-bubble:hover {
  background: #eef3fd;
}
#dk-bubble.dk-on {
  display: inline-flex;
}
`;

// The bridge script. Plain ES2017, no dependencies, everything inside one
// IIFE. It is a string (not a serialized function) so nothing the bundler
// does to app code can change what runs inside the frame.
const BRIDGE_SCRIPT = `
(function () {
  "use strict";
  var NS = "doklin-comments";
  var parentWin = window.parent;
  if (!parentWin || parentWin === window) return;

  var threads = []; // [{id, anchor}] as last synced
  var visible = false; // comment mode is opt-in; stay dark until the app says otherwise
  var activeId = null;
  var resolved = {}; // id -> Element (may go stale; layout() re-resolves)
  var hoverEl = null;

  function post(msg) {
    msg.dk = NS;
    parentWin.postMessage(msg, "*");
  }

  function normText(el) {
    return (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120);
  }

  /* ----- anchors ----- */

  function pathOf(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var tag = node.tagName.toLowerCase();
      var i = 1;
      var sib = node.previousElementSibling;
      while (sib) {
        if (sib.tagName === node.tagName) i++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(tag + ":nth-of-type(" + i + ")");
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function anchorOf(el) {
    return { path: pathOf(el), tag: el.tagName.toLowerCase(), text: normText(el) };
  }

  // Structural path first; when regeneration reshuffled the structure, fall
  // back to matching the element's leading text among same-tag elements
  // (exact match, then prefix either way). Null = orphaned.
  function resolveAnchor(anchor) {
    var el = null;
    try {
      el = document.querySelector(anchor.path);
    } catch (e) {
      el = null;
    }
    if (el && el.tagName.toLowerCase() === anchor.tag) {
      if (!anchor.text || normText(el) === anchor.text || normText(el).indexOf(anchor.text) === 0) {
        return el;
      }
    }
    if (!anchor.text) return null;
    var candidates = document.getElementsByTagName(anchor.tag);
    var best = null;
    var bestScore = 0;
    for (var i = 0; i < candidates.length; i++) {
      var t = normText(candidates[i]);
      if (!t) continue;
      var score = 0;
      if (t === anchor.text) score = 3;
      else if (t.indexOf(anchor.text) === 0 || anchor.text.indexOf(t) === 0) score = 2;
      if (score > bestScore) {
        bestScore = score;
        best = candidates[i];
      }
    }
    return best;
  }

  /* ----- paint + layout ----- */

  var layoutQueued = false;
  function scheduleLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(function () {
      layoutQueued = false;
      layout();
    });
  }

  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  }

  function layout() {
    var old = document.querySelectorAll("[data-dk-t]");
    for (var i = 0; i < old.length; i++) {
      old[i].removeAttribute("data-dk-t");
      old[i].removeAttribute("data-dk-active");
    }
    var rects = [];
    var orphans = [];
    for (var j = 0; j < threads.length; j++) {
      var t = threads[j];
      var el = resolved[t.id];
      if (!el || !el.isConnected) {
        el = resolveAnchor(t.anchor);
        if (el) resolved[t.id] = el;
        else delete resolved[t.id];
      }
      if (!el) {
        orphans.push(t.id);
        continue;
      }
      el.setAttribute("data-dk-t", "1");
      if (t.id === activeId) el.setAttribute("data-dk-active", "1");
      var r = rectOf(el);
      r.id = t.id;
      rects.push(r);
    }
    document.documentElement.toggleAttribute("data-dk-hidden", !visible);
    drawScrim();
    post({ type: "layout", rects: rects, orphans: orphans });
  }

  /* ----- the comment-mode scrim ----- */

  var scrim = document.createElement("canvas");
  scrim.id = "dk-scrim";

  function drawScrim() {
    if (!visible) {
      scrim.classList.remove("dk-on");
      return;
    }
    scrim.classList.add("dk-on");
    var w = window.innerWidth;
    var h = window.innerHeight;
    var dpr = window.devicePixelRatio || 1;
    if (scrim.width !== Math.round(w * dpr) || scrim.height !== Math.round(h * dpr)) {
      scrim.width = Math.round(w * dpr);
      scrim.height = Math.round(h * dpr);
    }
    var ctx = scrim.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(15, 21, 32, 0.32)";
    ctx.fillRect(0, 0, w, h);
    // Spotlight holes: every commented element, plus the hovered block. The
    // inflation keeps the elements' outlines (offset 2px) inside the light.
    for (var i = 0; i < threads.length; i++) {
      var el = resolved[threads[i].id];
      if (el && el.isConnected) {
        var r = el.getBoundingClientRect();
        ctx.clearRect(r.left - 6, r.top - 6, r.width + 12, r.height + 12);
      }
    }
    if (hoverEl && hoverEl.isConnected) {
      var hr = hoverEl.getBoundingClientRect();
      ctx.clearRect(hr.left - 6, hr.top - 6, hr.width + 12, hr.height + 12);
    }
  }

  /* ----- hover bubble (the only "create" affordance; comment mode only) ----- */

  var bubble = document.createElement("button");
  bubble.id = "dk-bubble";
  bubble.type = "button";
  bubble.title = "Comment on this block";
  bubble.setAttribute("aria-label", "Comment on this block");
  bubble.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';

  // The block the pointer is over: the innermost element that lays out as a
  // block (anything but pure inline text flow) and isn't a page-sized wrapper
  // (commenting on "the whole page div" is never what a hover means; the cap
  // keeps wrappers out of reach).
  function blockOf(start) {
    var node = start;
    while (node && node.nodeType !== 1) node = node.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      if (node.id !== "dk-bubble") {
        var d = getComputedStyle(node).display;
        if (d !== "inline" && d !== "contents" && d !== "none") {
          var r = node.getBoundingClientRect();
          if (r.height > 4 && r.width > 4) {
            if (r.height <= window.innerHeight * 0.7) return node;
            return null; // page-sized wrapper: no bubble here
          }
        }
      }
      node = node.parentElement;
    }
    return null;
  }

  function setHover(el) {
    if (el === hoverEl) return;
    if (hoverEl) hoverEl.removeAttribute("data-dk-hover");
    hoverEl = el;
    if (!el) {
      bubble.classList.remove("dk-on");
      drawScrim();
      return;
    }
    el.setAttribute("data-dk-hover", "1");
    var r = el.getBoundingClientRect();
    bubble.style.top = Math.max(4, Math.min(r.top + 4, window.innerHeight - 32)) + "px";
    bubble.style.left = Math.max(4, Math.min(r.right - 30, window.innerWidth - 34)) + "px";
    bubble.classList.add("dk-on");
    drawScrim();
  }

  var hoverQueued = false;
  var lastPointer = null;
  document.addEventListener(
    "mousemove",
    function (e) {
      lastPointer = e;
      if (hoverQueued) return;
      hoverQueued = true;
      requestAnimationFrame(function () {
        hoverQueued = false;
        if (!visible) return; // outside comment mode there is no affordance
        if (!lastPointer) return;
        var target = lastPointer.target;
        if (target === bubble || bubble.contains(target)) return; // keep current hover
        setHover(blockOf(target));
      });
    },
    true
  );
  // Pointer left the window entirely (relatedTarget is null only then):
  // drop the hover affordance.
  document.addEventListener(
    "mouseout",
    function (e) {
      if (!e.relatedTarget) setHover(null);
    },
    true
  );

  bubble.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (!hoverEl) return;
    post({
      type: "pick",
      anchor: anchorOf(hoverEl),
      rect: rectOf(hoverEl)
    });
  });

  /* ----- clicks: activation + external links; never block the page ----- */

  function closestAnchored(el) {
    var node = el;
    while (node && node.nodeType !== 1) node = node.parentElement;
    while (node && node !== document.documentElement) {
      if (node.hasAttribute && node.hasAttribute("data-dk-t")) return node;
      node = node.parentElement;
    }
    return null;
  }

  document.addEventListener(
    "click",
    function (e) {
      if (e.target === bubble || bubble.contains(e.target)) return;

      // External links leave the rendition — route them to the system browser
      // instead of letting them replace the preview + comment layer. In-page
      // #hash links keep their default.
      var link = e.target && e.target.closest ? e.target.closest("a[href]") : null;
      if (link) {
        var href = link.getAttribute("href") || "";
        if (!/^#/.test(href)) {
          e.preventDefault();
          if (/^(https?:|mailto:)/i.test(link.href)) {
            post({ type: "open", url: link.href });
          }
          // Anything else (relative paths have nowhere to point from srcdoc)
          // is inert rather than a broken navigation.
        }
      }

      if (!visible) return;
      var hit = closestAnchored(e.target);
      if (hit) {
        var id = null;
        for (var i = 0; i < threads.length; i++) {
          if (resolved[threads[i].id] === hit) {
            id = threads[i].id;
            break;
          }
        }
        if (id && id !== activeId) post({ type: "activate", id: id });
      } else if (activeId) {
        post({ type: "activate", id: null });
      }
    },
    true
  );

  /* ----- app messages ----- */

  window.addEventListener("message", function (e) {
    if (e.source !== parentWin) return;
    var msg = e.data;
    if (!msg || msg.dk !== NS) return;
    if (msg.type === "sync") {
      threads = Array.isArray(msg.threads) ? msg.threads : [];
      activeId = typeof msg.activeId === "string" ? msg.activeId : null;
      visible = msg.visible !== false;
      if (!visible) setHover(null);
      scheduleLayout();
    } else if (msg.type === "scroll-to") {
      var el = resolved[msg.id];
      if (el && el.isConnected) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.removeAttribute("data-dk-flash");
        void el.offsetWidth; // restart the animation
        el.setAttribute("data-dk-flash", "1");
      }
    }
  });

  /* ----- keep layout fresh ----- */

  document.addEventListener("scroll", scheduleLayout, { capture: true, passive: true });
  window.addEventListener("resize", scheduleLayout);
  var mutations = new MutationObserver(function () {
    // Structure changed (the rendition's own JS, image swaps): stale element
    // cache entries are dropped lazily in layout() via isConnected.
    scheduleLayout();
  });

  function start() {
    document.body.appendChild(scrim);
    document.body.appendChild(bubble);
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: false
    });
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(scheduleLayout);
    }
    post({ type: "ready" });
    scheduleLayout();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
`;

// Inject the comment layer into rendition markup bound for the preview
// iframe. Injected at the end of <body> so the document's own DOM exists by
// the time the script runs; a fragment with no body/html tags just gets the
// assets appended. The LAST closing tag wins — a "</body>" inside a code
// sample earlier in the document must not attract the injection.
export function instrumentHtml(html: string): string {
  const assets = `<style>${BRIDGE_STYLE}</style><script>${BRIDGE_SCRIPT}</script>`;
  const lower = html.toLowerCase();
  const bodyClose = lower.lastIndexOf("</body");
  if (bodyClose !== -1) {
    return html.slice(0, bodyClose) + assets + html.slice(bodyClose);
  }
  const htmlClose = lower.lastIndexOf("</html");
  if (htmlClose !== -1) {
    return html.slice(0, htmlClose) + assets + html.slice(htmlClose);
  }
  return html + assets;
}
