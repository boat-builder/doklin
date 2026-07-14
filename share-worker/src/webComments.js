// Anchored web comments on html renditions — the browser-side scripts.
//
// The public page frames the rendition in a sandboxed iframe (opaque origin,
// same layout the app uses), so commenting on an ELEMENT of the rendition
// needs two cooperating scripts exchanged over postMessage:
//
//   COMMENT_BRIDGE_SCRIPT — injected into the /raw response (comment-capable
//     sessions only; see serveRawHtml). Owns everything inside the frame:
//     resolving stored anchors to elements, painting highlights, the hover
//     "comment on this block" bubble, and scroll-to-element reveals.
//
//   SHELL_COMMENTS_SCRIPT — inlined in the page shell next to the
//     server-rendered comments section. Feeds the frame its anchor list,
//     turns a bubble pick into hidden form fields + a visible "Commenting
//     on: …" chip above the composer, and connects list ↔ document both
//     ways (click a highlighted element → its comment flashes in the list;
//     "Show in document" → the element flashes in the frame).
//
// Everything here is progressive enhancement. The comments section itself is
// plain server-rendered HTML with form posts — view, post, and delete all
// work with JS disabled exactly like the markdown page's comments; anchored
// entries then read through their quote line. These scripts only add the
// pointing.
//
// The interaction rules mirror the app's html comment layer deliberately:
// creation only via the dedicated hover bubble (a plain click is never
// repurposed), clicking a highlighted element never preventDefault()s (the
// rendition's own handlers still run), and anchors that no longer resolve
// simply stay list-only — never dropped. The anchor format ({path, tag,
// text}) is byte-compatible with the app's sidecar anchors, so a comment
// left on the web points at the same element when the app renders it.

// Resolution + hover logic matches src/htmlBridge.ts; the divergence is
// intentional and small: no rail (positions aren't reported out), no link
// interception (the shell page is an ordinary browser tab).
export const COMMENT_BRIDGE_SCRIPT = `
(function () {
  "use strict";
  var NS = "doklin-web-comments";
  var parentWin = window.parent;
  if (!parentWin || parentWin === window) return;

  var anchors = []; // [{id, anchor}] as last synced from the shell
  var resolved = {}; // id -> Element
  var hoverEl = null;

  function post(msg) {
    msg.dk = NS;
    parentWin.postMessage(msg, "*");
  }

  function normText(el) {
    return (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120);
  }

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

  var paintQueued = false;
  function schedulePaint() {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(function () {
      paintQueued = false;
      paint();
    });
  }

  function paint() {
    var old = document.querySelectorAll("[data-dkw-c]");
    for (var i = 0; i < old.length; i++) old[i].removeAttribute("data-dkw-c");
    for (var j = 0; j < anchors.length; j++) {
      var a = anchors[j];
      var el = resolved[a.id];
      if (!el || !el.isConnected) {
        el = resolveAnchor(a.anchor);
        if (el) resolved[a.id] = el;
        else delete resolved[a.id];
      }
      if (el) el.setAttribute("data-dkw-c", "1");
    }
  }

  /* ----- hover bubble (the only "create" affordance) ----- */

  var bubble = document.createElement("button");
  bubble.id = "dkw-bubble";
  bubble.type = "button";
  bubble.title = "Comment on this block";
  bubble.setAttribute("aria-label", "Comment on this block");
  bubble.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';

  function blockOf(start) {
    var node = start;
    while (node && node.nodeType !== 1) node = node.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      if (node.id !== "dkw-bubble") {
        var d = getComputedStyle(node).display;
        if (d !== "inline" && d !== "contents" && d !== "none") {
          var r = node.getBoundingClientRect();
          if (r.height > 4 && r.width > 4) {
            if (r.height <= window.innerHeight * 0.7) return node;
            return null;
          }
        }
      }
      node = node.parentElement;
    }
    return null;
  }

  function setHover(el) {
    if (el === hoverEl) return;
    if (hoverEl) hoverEl.removeAttribute("data-dkw-hover");
    hoverEl = el;
    if (!el) {
      bubble.classList.remove("dkw-on");
      return;
    }
    el.setAttribute("data-dkw-hover", "1");
    var r = el.getBoundingClientRect();
    bubble.style.top = Math.max(4, Math.min(r.top + 4, window.innerHeight - 32)) + "px";
    bubble.style.left = Math.max(4, Math.min(r.right - 30, window.innerWidth - 34)) + "px";
    bubble.classList.add("dkw-on");
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
        if (!lastPointer) return;
        var target = lastPointer.target;
        if (target === bubble || bubble.contains(target)) return;
        setHover(blockOf(target));
      });
    },
    true
  );
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
      anchor: { path: pathOf(hoverEl), tag: hoverEl.tagName.toLowerCase(), text: normText(hoverEl) },
      quote: (hoverEl.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 300)
    });
  });

  /* ----- clicks: open the comment in the shell list; never block the page ----- */

  document.addEventListener(
    "click",
    function (e) {
      if (e.target === bubble || bubble.contains(e.target)) return;
      var node = e.target;
      while (node && node.nodeType !== 1) node = node.parentElement;
      while (node && node !== document.documentElement) {
        if (node.hasAttribute && node.hasAttribute("data-dkw-c")) {
          for (var i = 0; i < anchors.length; i++) {
            if (resolved[anchors[i].id] === node) {
              post({ type: "open", id: anchors[i].id });
              return;
            }
          }
          return;
        }
        node = node.parentElement;
      }
    },
    true
  );

  /* ----- shell messages ----- */

  window.addEventListener("message", function (e) {
    if (e.source !== parentWin) return;
    var msg = e.data;
    if (!msg || msg.dk !== NS) return;
    if (msg.type === "sync") {
      anchors = Array.isArray(msg.anchors) ? msg.anchors : [];
      schedulePaint();
    } else if (msg.type === "reveal") {
      var el = resolved[msg.id];
      if (el && el.isConnected) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.removeAttribute("data-dkw-flash");
        void el.offsetWidth;
        el.setAttribute("data-dkw-flash", "1");
      }
    }
  });

  var mutations = new MutationObserver(schedulePaint);

  function start() {
    document.body.appendChild(bubble);
    mutations.observe(document.body, { childList: true, subtree: true, characterData: true });
    post({ type: "ready" });
    schedulePaint();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
`;

// Styles injected into the rendition alongside the bridge. Hardcoded accent
// (the frame can't read the shell's CSS variables); !important keeps the
// rendition's own stylesheet from swallowing the layer.
export const FRAME_COMMENT_CSS = `
[data-dkw-c] {
  outline: 2px solid rgba(47, 111, 221, 0.38) !important;
  outline-offset: 2px;
  border-radius: 3px;
  cursor: pointer;
}
[data-dkw-hover] {
  outline: 1.5px dashed rgba(47, 111, 221, 0.45) !important;
  outline-offset: 2px;
  border-radius: 3px;
}
@keyframes dkw-flash {
  0% { background-color: rgba(47, 111, 221, 0.25); }
  100% { background-color: transparent; }
}
[data-dkw-flash] {
  animation: dkw-flash 1.1s ease-out;
}
#dkw-bubble {
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
#dkw-bubble:hover { background: #eef3fd; }
#dkw-bubble.dkw-on { display: inline-flex; }
`;

// Inject the bridge into rendition markup bound for /raw. Before the LAST
// closing tag (a "</body>" inside a code sample earlier in the document must
// not attract the injection) — same rule as the app's instrumentHtml.
export function injectCommentBridge(html) {
  const assets = `<style>${FRAME_COMMENT_CSS}</style><script>${COMMENT_BRIDGE_SCRIPT}</script>`;
  const lower = html.toLowerCase();
  const bodyClose = lower.lastIndexOf("</body");
  if (bodyClose !== -1) return html.slice(0, bodyClose) + assets + html.slice(bodyClose);
  const htmlClose = lower.lastIndexOf("</html");
  if (htmlClose !== -1) return html.slice(0, htmlClose) + assets + html.slice(htmlClose);
  return html + assets;
}

// The shell page's side of the handshake. Reads the anchor list from
// #dkw-data (JSON, rendered next to the comments section), syncs the frame
// whenever the bridge says ready (each frame load), and wires:
//   pick   → hidden anchor/quote fields + the "Commenting on" chip + focus
//   open   → scroll + flash the comment's list item
//   reveal → asks the frame to scroll + flash the element
export const SHELL_COMMENTS_SCRIPT = `
(function () {
  "use strict";
  var NS = "doklin-web-comments";
  var frame = document.querySelector(".raw-frame-flow, .raw-frame");
  var dataEl = document.getElementById("dkw-data");
  if (!frame || !dataEl) return;
  var anchors = [];
  try {
    anchors = JSON.parse(dataEl.textContent || "[]");
  } catch (e) {}

  function send(msg) {
    msg.dk = NS;
    if (frame.contentWindow) frame.contentWindow.postMessage(msg, "*");
  }

  var form = document.querySelector(".comment-form");
  var chip = document.getElementById("dkw-chip");
  var chipQuote = document.getElementById("dkw-chip-quote");
  var field = function (n) {
    return form ? form.querySelector('input[name="' + n + '"]') : null;
  };

  function clearPick() {
    ["anchor_path", "anchor_tag", "anchor_text", "quote"].forEach(function (n) {
      var f = field(n);
      if (f) f.value = "";
    });
    if (chip) chip.hidden = true;
  }

  window.addEventListener("message", function (e) {
    if (e.source !== frame.contentWindow) return;
    var msg = e.data;
    if (!msg || msg.dk !== NS) return;
    if (msg.type === "ready") {
      send({ type: "sync", anchors: anchors });
    } else if (msg.type === "pick" && form && msg.anchor) {
      var p = field("anchor_path"), t = field("anchor_tag"), x = field("anchor_text"), q = field("quote");
      if (p) p.value = String(msg.anchor.path || "");
      if (t) t.value = String(msg.anchor.tag || "");
      if (x) x.value = String(msg.anchor.text || "");
      if (q) q.value = String(msg.quote || "");
      if (chip && chipQuote) {
        chipQuote.textContent = String(msg.quote || msg.anchor.text || "this block");
        chip.hidden = false;
      }
      form.scrollIntoView({ block: "center", behavior: "smooth" });
      var ta = form.querySelector("textarea");
      if (ta) ta.focus();
    } else if (msg.type === "open") {
      var li = document.getElementById("c-" + msg.id);
      if (li) {
        li.scrollIntoView({ block: "center", behavior: "smooth" });
        li.classList.remove("is-flash");
        void li.offsetWidth;
        li.classList.add("is-flash");
      }
    }
  });

  var clear = document.getElementById("dkw-chip-clear");
  if (clear) clear.addEventListener("click", clearPick);
  // A posted comment consumes the pick; back-navigation restores form fields,
  // so clear them once the page is interactive.
  clearPick();

  // "Show in document" buttons are server-rendered but inert without JS.
  var reveals = document.querySelectorAll(".comment-reveal");
  for (var i = 0; i < reveals.length; i++) {
    reveals[i].classList.add("is-live");
    reveals[i].addEventListener("click", function (e) {
      send({ type: "reveal", id: e.currentTarget.getAttribute("data-comment-id") });
    });
  }
})();
`;
