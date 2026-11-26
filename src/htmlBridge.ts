// The comment bridge for the HTML rendition view.
//
// The rendition renders in a sandboxed iframe (opaque origin — deliberately:
// its scripts must never reach the app or Tauri IPC), so the app cannot touch
// its DOM. Instead, `instrumentHtml` adds one self-contained script to the
// markup fed to the frame. The script is the app's eyes inside the frame: it
// finds each thread's place in the page as drawn, says where that is, marks
// commented words, reads a selection and offers parts of the page to pick.
// Everything a person presses — the cards, the markers, the Comment button —
// is the app's, drawn outside the frame (HtmlView.tsx). Only the in-app
// preview is instrumented: publishing and syncing read the rendition from
// disk, so the script never reaches a public copy.
//
// Ground rules (the rendition is arbitrary, possibly interactive HTML — tabs,
// accordions, links, its own JS):
//
//   1. The page is left as it was found. Words are marked with the browser's
//      highlight registry (CSS.highlights), which paints ranges without
//      wrapping them; the script's rules are an adopted sheet; the script
//      takes its own element out as it starts. It sets no attribute and adds
//      no element, so the page's styles and scripts see their own markup and
//      nothing else. (Document zoom is the one thing it writes: a style on
//      <body>.)
//   2. Outside picking, the page's clicks are its own. A click on commented
//      words opens their thread, and the page's own handler still runs.
//   3. Picking is a mode the reader enters (C). While it is on, the page's
//      clicks, links and selection are paused, and a click anywhere in a
//      part picks it.
//   4. Links are the one place the script overrides the page: following a
//      link inside the frame would replace the rendition with what it leads
//      to, so the app follows it instead, as it follows one in a note — a
//      web address in the system browser, a document in the app (⌘ or Ctrl
//      held: a new tab). Same-page #hash links keep their in-page behavior.
//   5. The script listens in the capture phase, so a rendition that
//      stopPropagation()s in its own handlers can't starve it.
//
// FINDING A PLACE. A thread is on words, or on a part as a whole (HtmlAnchor,
// htmlComments.ts). The content decides where it is; ids and the structural
// path only say where to look first, and a find that is not exact is said so
// (`changed`), never passed off as the place.
//
//   The page is read as one run of text: its text nodes in order, without
//   what nobody reads (script, style, …), every stretch of whitespace one
//   space, and a space between two blocks or across a <br> even where the
//   markup has none. So a reflowed paragraph is the same paragraph.
//
//   Words are looked for three ways: as written (of several, the one whose
//   surroundings are most like the ones the comment was made with); folded
//   (case, curly quotes and dashes made plain); and the closest run, for
//   words that were since reworded a little.
//
//   A thread on words: as written or folded, inside the nearest of its ids
//   the page still has, then in the whole page — `found`. Then the closest
//   run, inside that id and then in the whole page — `changed`. Then its part
//   by the rule below — `part`. Else `lost`.
//
//   A thread on a part: the elements with its tag whose text agrees with the
//   anchor's (equal, or one begins with the other, or both empty), inside the
//   nearest of its ids and then in the whole page. Of those: the one at its
//   path; else the one with the first of its ids; else, with text to go by,
//   the best match, the innermost first. Else `lost`.
//
// The worker and the iPhone answer the same questions from the file as
// written (cloud-worker/src/htmlText.ts, HtmlText.swift), and all three are
// held to verify-harness/comments-fixture.json (`places`) — change all three.
//
// Known limits, accepted: a rendition carrying a strict CSP <meta> that
// forbids inline scripts has no comment layer (the preview still renders);
// nested iframes and shadow DOM inside the rendition are not commentable; a
// browser without the highlight registry (Safari before 17.2) marks no words,
// and the app outlines them instead while their card is open.

import {
  ANCHOR_CONTEXT_LEN,
  ANCHOR_IDS_MAX,
  ANCHOR_ID_LEN,
  ANCHOR_QUOTE_LEN,
  ANCHOR_TEXT_LEN,
  type HtmlAnchor,
  type HtmlThread,
} from "./htmlComments";
import type { AppShortcut } from "./keys";

/* ---------- What the app sends the script ---------- */

// Everything the script needs to know, sent on ready and whenever any of it
// changes (threads are few; simplicity over deltas). `threads` carries
// anchors only — bodies stay app-side. `visible` is whether comments are
// shown at all, `picking` whether the reader is picking a part, and `zoom`
// the document-zoom factor (⌘+ / ⌘-), applied inside the frame.
export type BridgeSyncMsg = {
  dk: "doklin-comments";
  type: "sync";
  threads: { id: string; anchor: HtmlAnchor }[];
  visible: boolean;
  picking: boolean;
  activeId: string | null;
  hoverId: string | null;
  zoom: number;
};
// Which thread is open and which is under the pointer: a repaint, nothing
// found again.
export type BridgeFocusMsg = {
  dk: "doklin-comments";
  type: "focus";
  activeId: string | null;
  hoverId: string | null;
};
// While picking: the part around the one outlined (1), or back in (-1).
export type BridgeWidenMsg = { dk: "doklin-comments"; type: "widen"; by: 1 | -1 };
// Bring a thread's place into view (opening a closed <details> around it).
export type BridgeRevealMsg = { dk: "doklin-comments"; type: "reveal"; id: string };
// Scroll the page from outside it: the wheel over the cards.
export type BridgeScrollByMsg = { dk: "doklin-comments"; type: "scroll-by"; dy: number };
// Drop the page's selection: its words have become a thread.
export type BridgeDeselectMsg = { dk: "doklin-comments"; type: "deselect" };
// Split-view scroll sync: the app drives the iframe's document scroll to a
// proportional offset (0..1 of the scrollable range). The script leaves the
// ratio out of its report of that move, so sync never echoes.
export type BridgeScrollSyncMsg = {
  dk: "doklin-comments";
  type: "scroll-sync";
  ratio: number;
};
export type BridgeInMsg =
  | BridgeSyncMsg
  | BridgeFocusMsg
  | BridgeWidenMsg
  | BridgeRevealMsg
  | BridgeScrollByMsg
  | BridgeDeselectMsg
  | BridgeScrollSyncMsg;

/* ---------- What the script sends the app ---------- */

// A box on the PAGE, in the frame's viewport pixels: where it is in the
// document, not on screen. The app moves its layers by the page's scroll
// (`scroll`), so nothing is measured again while the page only scrolls.
export type Box = { top: number; left: number; width: number; height: number };

// What a part is, and what it is called.
export type PartKind =
  | "block"
  | "section"
  | "heading"
  | "paragraph"
  | "list"
  | "item"
  | "table"
  | "row"
  | "picture"
  | "drawing"
  | "button";
export type PartLabel = { kind: PartKind; title: string };

// How a thread's place was found: the words as they were (or its part, for a
// thread on a part); words close to them; not the words but the part they
// were in; nothing.
export type PlaceState = "found" | "changed" | "part" | "lost";
export type BridgePlace = {
  id: string;
  state: PlaceState;
  /** How far down the page it sits. Absent when lost, or shown nowhere. */
  top?: number;
  /** The marked words' box. */
  words?: Box;
  /** The part's box: the part commented on, or the one the words fell back to. */
  part?: Box;
  label?: PartLabel;
  /** Folded away (a closed <details>, a hidden tab): `top` is the nearest thing shown. */
  hidden?: boolean;
};

export type BridgeReadyMsg = { dk: "doklin-comments"; type: "ready" };
export type BridgeLayoutMsg = {
  dk: "doklin-comments";
  type: "layout";
  places: BridgePlace[];
  scrollX: number;
  scrollY: number;
  /** How tall the page is: its end, which nothing scrolls past. */
  pageHeight: number;
  /** Whether commented words are tinted in the page (the highlight registry exists). */
  painted: boolean;
};
// The page scrolled. `ratio` (0..1 of the scrollable range) is there for a
// USER scroll only, for driving the opposite split pane.
export type BridgeScrollMsg = {
  dk: "doklin-comments";
  type: "scroll";
  x: number;
  y: number;
  ratio?: number;
};
// The reader's selection: where a thread on it would go, the words' box and
// their first line's. `anchor: null` when there is none any more.
export type BridgeSelectMsg = {
  dk: "doklin-comments";
  type: "select";
  anchor: HtmlAnchor | null;
  box?: Box;
  first?: Box;
};
// While picking: the part under the pointer (`pickhover`), and the one
// clicked (`pick`). `anchor: null` when there is no part there.
export type BridgePickMsg = {
  dk: "doklin-comments";
  type: "pick" | "pickhover";
  anchor: HtmlAnchor | null;
  box?: Box;
  label?: PartLabel;
};
// The thread whose marked words are under the pointer.
export type BridgeHoverMsg = { dk: "doklin-comments"; type: "hover"; id: string | null };
// A click on the page outside picking: the thread whose words were clicked,
// or null for anywhere else.
export type BridgeActivateMsg = {
  dk: "doklin-comments";
  type: "activate";
  id: string | null;
};
// A link clicked: `href` as the markup writes it (a path is relative to the
// document, which the frame has no address for), `url` as the frame resolved
// it (a web address), and whether ⌘ or Ctrl asked for a new tab.
export type BridgeFollowMsg = {
  dk: "doklin-comments";
  type: "follow";
  href: string;
  url: string;
  newTab: boolean;
};
// Any pointerdown inside the rendition. The iframe swallows clicks (separate
// browsing context), so this is how the app knows to move pane focus there.
export type BridgeGestureMsg = { dk: "doklin-comments"; type: "gesture" };
// One of the app's shortcuts (`APP_SHORTCUTS`, keys.ts) pressed while focus
// sits inside the frame. Key events don't cross the frame boundary either,
// so without this they would go dead the moment the reader clicks the page.
export type BridgeShortcutMsg = { dk: "doklin-comments"; type: "shortcut"; shortcut: AppShortcut };
// A comment key pressed inside the frame: "c" (pick a part), "C" (show or
// hide comments), "m" (⌘⌥M: comment on the selected words) or "Escape".
export type BridgeKeyMsg = { dk: "doklin-comments"; type: "key"; key: "c" | "C" | "m" | "Escape" };
// The computed colour the rendition paints its canvas with (may be
// transparent), re-sent whenever it changes. The frame's scrollbar gutter
// lies outside that canvas and shows the iframe element's own backdrop, so
// the app paints the backdrop to match — otherwise macOS's always-visible
// scrollbars run a white strip down a page of any other colour.
export type BridgeCanvasMsg = { dk: "doklin-comments"; type: "canvas"; color: string };
export type BridgeOutMsg =
  | BridgeReadyMsg
  | BridgeLayoutMsg
  | BridgeScrollMsg
  | BridgeSelectMsg
  | BridgePickMsg
  | BridgeHoverMsg
  | BridgeActivateMsg
  | BridgeFollowMsg
  | BridgeGestureMsg
  | BridgeShortcutMsg
  | BridgeKeyMsg
  | BridgeCanvasMsg;

export function isBridgeMsg(data: unknown): data is BridgeOutMsg {
  const d = data as { dk?: string; type?: string };
  return !!d && typeof d === "object" && d.dk === "doklin-comments" && typeof d.type === "string";
}

// Resolve threads (app-side model) to the wire shape the script needs.
export function bridgeThreads(threads: HtmlThread[]): BridgeSyncMsg["threads"] {
  return threads.map((t) => ({ id: t.id, anchor: t.anchor }));
}

/* ---------- The injected script ---------- */

// Plain ES2017, no dependencies, everything inside one IIFE. It is a string
// (not a serialized function) so nothing the bundler does to app code can
// change what runs inside the frame. `String.raw`, so a backslash below is
// the script's own.
//
// The marks use hardcoded colours (the light theme's accent, translucent):
// the frame can't read the app's CSS variables, and a translucent tint reads
// on a light page and a dark one alike without touching the words' colour.
const BRIDGE_SCRIPT = String.raw`
(function () {
  "use strict";
  var NS = "doklin-comments";
  var host = window.parent;
  if (!host || host === window) return;
  // The page's markup is its author's and nothing else's: the script's own
  // element is gone before anything of the page's can read it.
  var own = document.currentScript;
  if (own && own.parentNode) own.parentNode.removeChild(own);

  var TEXT_LEN = ${ANCHOR_TEXT_LEN};
  var QUOTE_LEN = ${ANCHOR_QUOTE_LEN};
  var CONTEXT = ${ANCHOR_CONTEXT_LEN};
  var IDS_MAX = ${ANCHOR_IDS_MAX};
  var ID_LEN = ${ANCHOR_ID_LEN};
  // Elements that are words in a line, never a block of their own.
  var INLINE = { A: 1, ABBR: 1, B: 1, BDI: 1, BDO: 1, BIG: 1, CITE: 1, CODE: 1, DEL: 1, DFN: 1, EM: 1, FONT: 1, I: 1, INS: 1, KBD: 1, LABEL: 1, MARK: 1, Q: 1, S: 1, SAMP: 1, SMALL: 1, SPAN: 1, STRIKE: 1, STRONG: 1, SUB: 1, SUP: 1, TIME: 1, TT: 1, U: 1, VAR: 1, WBR: 1 };
  // Elements nobody reads: their text is not part of what the page says.
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TEXTAREA: 1, TITLE: 1, DESC: 1 };
  // Drawn things: a part however they are laid out.
  var GRAPHIC = { IMG: 1, PICTURE: 1, SVG: 1, CANVAS: 1, VIDEO: 1, IFRAME: 1, OBJECT: 1, EMBED: 1 };
  // Pieces of a row or a table, never a part by themselves.
  var PIECE = { TD: 1, TH: 1, THEAD: 1, TBODY: 1, TFOOT: 1, COLGROUP: 1, COL: 1, CAPTION: 1 };

  var threads = []; // [{id, anchor}] as last synced
  var resolved = {}; // id -> {state, range?, element?, rects?}
  var visible = false; // comments are shown
  var picking = false;
  var activeId = null;
  var hoverId = null;
  var zoom = 1; // document zoom (⌘+ / ⌘-), driven by the app
  var rectK = 1; // getBoundingClientRect -> viewport px (see measureRectK)
  var model = null; // the page as text; rebuilt when the page changes
  var selectionRange = null;
  var saidSelection = false;
  // While picking: the smallest part under the pointer, how many parts out
  // from it the reader has gone with the up arrow, and the part that makes.
  var pickBase = null;
  var pickUp = 0;
  var pickTarget = null;
  var saidHover = null;

  function post(msg) {
    msg.dk = NS;
    try { host.postMessage(msg, "*"); } catch (e) { /* the app has gone */ }
  }

  function tag(element) { return element && element.tagName ? String(element.tagName).toUpperCase() : ""; }
  function squash(text) { return String(text || "").replace(/\s+/g, " ").trim(); }

  /* ----- the page as one run of text ----- */

  function blockOf(node) {
    var element = node.parentNode;
    while (element && element.nodeType === 1 && INLINE[tag(element)]) element = element.parentNode;
    return element;
  }

  // text: the run. nodes: its text nodes. first[k]: where node k begins in
  // it. charNode / charOffset: for each character, its node and where in the
  // node it is (-1 for a space the markup did not write).
  function buildModel() {
    var root = document.body || document.documentElement;
    var chunks = [];
    var nodes = [];
    var first = [];
    var charNode = [];
    var charOffset = [];
    var length = 0;
    var lastSpace = true;
    var boundary = false;
    var previousBlock = null;
    function push(text, node, offset) {
      chunks.push(text);
      charNode.push(node);
      charOffset.push(offset);
      length += 1;
    }
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: function (node) {
        if (node.nodeType === 1 && SKIP[tag(node)]) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === 1) {
        if (tag(node) === "BR") boundary = true;
        continue;
      }
      var data = node.data;
      if (!data) continue;
      // Words in two blocks, or either side of a line break, are apart even
      // where the markup puts no space between them.
      var block = blockOf(node);
      if ((boundary || (previousBlock !== null && block !== previousBlock)) && !lastSpace) {
        push(" ", -1, 0);
        lastSpace = true;
      }
      boundary = false;
      previousBlock = block;
      var at = nodes.length;
      nodes.push(node);
      first.push(length);
      for (var i = 0; i < data.length; i += 1) {
        var code = data.charCodeAt(i);
        if (code === 8203 || code === 8204 || code === 8205 || code === 65279 || code === 173) continue;
        if (code === 32 || code === 160 || (code >= 9 && code <= 13) || code === 8239 || code === 8201) {
          if (!lastSpace) { push(" ", at, i); lastSpace = true; }
        } else {
          push(data.charAt(i), at, i);
          lastSpace = false;
        }
      }
    }
    var index = new Map();
    for (var k = 0; k < nodes.length; k += 1) index.set(nodes[k], k);
    return { text: chunks.join(""), nodes: nodes, index: index, first: first, charNode: charNode, charOffset: charOffset, folded: null };
  }

  function getModel() {
    if (!model) model = buildModel();
    return model;
  }

  // The same text with case and typographic marks folded, a character for a
  // character, so an offset in one is the same offset in the other.
  function fold(text) {
    var out = "";
    for (var i = 0; i < text.length; i += 1) {
      var code = text.charCodeAt(i);
      var ch = text.charAt(i);
      if (code === 8216 || code === 8217 || code === 8242) ch = "'";
      else if (code === 8220 || code === 8221 || code === 8243) ch = '"';
      else if (code >= 8208 && code <= 8213) ch = "-";
      else {
        var lower = ch.toLowerCase();
        if (lower.length === 1) ch = lower;
      }
      out += ch;
    }
    return out;
  }

  function folded(m) {
    if (m.folded === null) m.folded = fold(m.text);
    return m.folded;
  }

  // Where a point in the document falls in the text.
  function toModel(m, container, offset) {
    if (container.nodeType === 3 && m.index.has(container)) {
      var found = m.index.get(container);
      var at = m.first[found];
      while (at < m.charNode.length && m.charNode[at] === found && m.charOffset[at] < offset) at += 1;
      return at;
    }
    var point = document.createRange();
    try { point.setStart(container, offset); } catch (e) { return 0; }
    point.collapse(true);
    var low = 0;
    var high = m.nodes.length;
    while (low < high) {
      var mid = (low + high) >> 1;
      var where;
      try { where = point.comparePoint(m.nodes[mid], 0); } catch (e) { where = 1; }
      if (where < 0) low = mid + 1; else high = mid;
    }
    return low < m.nodes.length ? m.first[low] : m.text.length;
  }

  function rangeFor(m, from, to) {
    while (from < to && m.charNode[from] === -1) from += 1;
    while (to > from && m.charNode[to - 1] === -1) to -= 1;
    if (to <= from) return null;
    var range = document.createRange();
    try {
      range.setStart(m.nodes[m.charNode[from]], m.charOffset[from]);
      range.setEnd(m.nodes[m.charNode[to - 1]], m.charOffset[to - 1] + 1);
    } catch (e) { return null; }
    return range;
  }

  // The stretch of the text that sits inside an element.
  function spanOf(m, element) {
    var count = m.nodes.length;
    var low = 0;
    var high = count;
    while (low < high) {
      var mid = (low + high) >> 1;
      var relation = element.compareDocumentPosition(m.nodes[mid]);
      if ((relation & 2) && !(relation & 16)) low = mid + 1; else high = mid;
    }
    var start = low;
    high = count;
    while (low < high) {
      var middle = (low + high) >> 1;
      var position = element.compareDocumentPosition(m.nodes[middle]);
      if (position & 16) low = middle + 1; else high = middle;
    }
    return [start < count ? m.first[start] : m.text.length, low < count ? m.first[low] : m.text.length];
  }

  /* ----- parts ----- */

  function ownId(element) {
    var id = element.getAttribute ? element.getAttribute("id") : null;
    return id ? String(id) : "";
  }

  // Whether an element is laid out as a box of its own.
  function shaped(element) {
    var name = tag(element);
    if (name === "HTML" || name === "BODY" || PIECE[name] || element.ownerSVGElement) return false;
    if (GRAPHIC[name]) return true;
    var display = null;
    try { display = String(window.getComputedStyle(element).display || ""); } catch (e) { display = null; }
    if (display === null) return !INLINE[name];
    return display !== "" && display !== "none" && display !== "inline" && display !== "contents";
  }

  // The words inside an element, without the space either side of them.
  function wordsOf(m, element) {
    var span = spanOf(m, element);
    var from = span[0];
    var to = span[1];
    while (from < to && m.text.charAt(from) === " ") from += 1;
    while (to > from && m.text.charAt(to - 1) === " ") to -= 1;
    return [from, to];
  }

  // What a picture is called: its alt text, else its file name.
  function pictureText(element) {
    var alt = squash(element.getAttribute("alt"));
    if (alt) return alt.slice(0, TEXT_LEN);
    var src = String(element.getAttribute("src") || "");
    if (/^\s*data:/i.test(src)) return "";
    src = src.split("#")[0].split("?")[0];
    return squash(src.slice(src.lastIndexOf("/") + 1)).slice(0, TEXT_LEN);
  }

  // The start of what a part says: what an anchor keeps of it (text).
  function partText(m, element) {
    if (tag(element) === "IMG") return pictureText(element);
    var words = wordsOf(m, element);
    return m.text.slice(words[0], Math.min(words[1], words[0] + TEXT_LEN));
  }

  // A part is a box of its own with something to be found by: words, an id,
  // or a picture's name.
  function isPart(m, element) {
    if (!shaped(element)) return false;
    if (ownId(element)) return true;
    if (tag(element) === "IMG") return pictureText(element) !== "";
    var words = wordsOf(m, element);
    return words[1] > words[0];
  }

  function nearestPart(m, node) {
    var element = node && node.nodeType === 1 ? node : node && node.parentNode;
    while (element && element.nodeType === 1) {
      var name = tag(element);
      if (name === "HTML" || name === "BODY") return null;
      if (isPart(m, element)) return element;
      element = element.parentNode;
    }
    return null;
  }

  // The part a part's words lead back to: itself, or the part inside it that
  // holds all the same words. It is what a thread kept by those words is
  // found as (pickPart takes the innermost), so it is what is offered under
  // the pointer too.
  function settle(m, element) {
    if (ownId(element) || tag(element) === "IMG") return element;
    var words = wordsOf(m, element);
    var range = words[1] > words[0] ? rangeFor(m, words[0], words[1]) : null;
    if (!range) return element;
    return nearestPart(m, range.commonAncestorContainer) || element;
  }

  // The smallest part around a node that a comment can be put on.
  function partAt(m, node) {
    var part = nearestPart(m, node);
    return part ? settle(m, part) : null;
  }

  // The next part out from one: a part around it that its id or its own
  // words can keep, rather than a wrapper whose words are all the inner one's.
  function wider(m, element) {
    var up = element.parentNode;
    while (up && up.nodeType === 1) {
      var part = nearestPart(m, up);
      if (!part) return null;
      if (settle(m, part) === part) return part;
      up = part.parentNode;
    }
    return null;
  }

  /* ----- anchors ----- */

  function pathOf(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var name = node.tagName.toLowerCase();
      var i = 1;
      var sib = node.previousElementSibling;
      while (sib) {
        if (sib.tagName === node.tagName) i++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(name + ":nth-of-type(" + i + ")");
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  // The ids of an element and of everything around it, nearest first.
  function idsAround(node) {
    var out = [];
    var element = node && node.nodeType === 1 ? node : node && node.parentNode;
    while (element && element.nodeType === 1 && out.length < IDS_MAX) {
      var name = tag(element);
      var id = ownId(element);
      if (id && name !== "HTML" && name !== "BODY") out.push(id.slice(0, ID_LEN));
      element = element.parentNode;
    }
    return out;
  }

  // Where a thread on a part goes. The ids are read from what the thread is
  // really on (around): the part itself, or the words commented on inside it.
  function partAnchor(m, part, around) {
    var anchor = part
      ? { path: pathOf(part), tag: part.tagName.toLowerCase(), text: partText(m, part) }
      : { path: "", tag: "body", text: "" };
    var ids = idsAround(around || part);
    if (ids.length) anchor.ids = ids;
    return anchor;
  }

  // Where a thread on some words goes: the smallest part that holds them all
  // (none, for words that sit in the page's body itself), and the words.
  function wordsAnchor(m, from, to, around) {
    var anchor = partAnchor(m, nearestPart(m, around), around);
    anchor.quote = m.text.slice(from, to);
    anchor.prefix = m.text.slice(Math.max(0, from - CONTEXT), from);
    anchor.suffix = m.text.slice(to, to + CONTEXT);
    return anchor;
  }

  /* ----- finding words ----- */

  function sharedEnd(a, b) {
    var n = 0;
    while (n < a.length && n < b.length && a.charAt(a.length - 1 - n) === b.charAt(b.length - 1 - n)) n += 1;
    return n;
  }

  function sharedStart(a, b) {
    var n = 0;
    while (n < a.length && n < b.length && a.charAt(n) === b.charAt(n)) n += 1;
    return n;
  }

  // Every place the words are, and of those the one whose surroundings are
  // most like the ones the comment was made with. Between two that are alike
  // in that too, the one in the part the comment was made in (near).
  function findExact(text, quote, from, to, prefix, suffix, near) {
    var best = null;
    var bestScore = -1;
    var at = text.indexOf(quote, from);
    var seen = 0;
    while (at !== -1 && at + quote.length <= to && seen < 400) {
      var score = 0;
      if (prefix) score += sharedEnd(text.slice(Math.max(0, at - CONTEXT), at), prefix);
      if (suffix) score += sharedStart(text.slice(at + quote.length, at + quote.length + CONTEXT), suffix);
      if (near && at >= near[0] && at + quote.length <= near[1]) score += 0.5;
      if (score > bestScore) { bestScore = score; best = [at, at + quote.length]; }
      seen += 1;
      at = text.indexOf(quote, at + 1);
    }
    return best;
  }

  // The closest run to a pattern in a sequence, by edits, with a free start:
  // Sellers' algorithm, carrying where each run began. Of two runs as close,
  // the first.
  function closest(pattern, count, same, allowed) {
    var n = pattern.length;
    var distance = new Array(n + 1);
    var start = new Array(n + 1);
    var j;
    for (j = 0; j <= n; j += 1) { distance[j] = j; start[j] = 0; }
    var best = allowed + 1;
    var bestStart = -1;
    var bestEnd = -1;
    for (var i = 1; i <= count; i += 1) {
      var diagonal = distance[0];
      var diagonalStart = start[0];
      distance[0] = 0;
      start[0] = i;
      for (j = 1; j <= n; j += 1) {
        var up = distance[j];
        var upStart = start[j];
        var cost = diagonal + (same(j - 1, i - 1) ? 0 : 1);
        var from = diagonalStart;
        if (up + 1 < cost) { cost = up + 1; from = upStart; }
        if (distance[j - 1] + 1 < cost) { cost = distance[j - 1] + 1; from = start[j - 1]; }
        diagonal = up;
        diagonalStart = upStart;
        distance[j] = cost;
        start[j] = from;
      }
      if (distance[n] < best && i > start[n]) { best = distance[n]; bestStart = start[n]; bestEnd = i; }
    }
    return bestStart < 0 ? null : [bestStart, bestEnd];
  }

  // Words reworded a little: for four words or more, up to a third of them
  // changed; for 6 to 80 characters, up to 30% of the characters; otherwise
  // nothing is close enough to say.
  function findClose(m, quote, from, to) {
    var text = folded(m);
    var wanted = fold(quote);
    var words = wanted.split(" ");
    if (words.length >= 4) {
      var tokens = [];
      var starts = [];
      var ends = [];
      var at = from;
      while (at < to && tokens.length < 30000) {
        while (at < to && text.charAt(at) === " ") at += 1;
        var begin = at;
        while (at < to && text.charAt(at) !== " ") at += 1;
        if (at > begin) { tokens.push(text.slice(begin, at)); starts.push(begin); ends.push(at); }
      }
      if (words.length > 300 || tokens.length === 0) return null;
      var run = closest(words, tokens.length, function (a, b) { return words[a] === tokens[b]; }, Math.floor(words.length * 0.34));
      return run ? [starts[run[0]], ends[run[1] - 1]] : null;
    }
    if (wanted.length < 6 || wanted.length > 80 || to - from > 200000) return null;
    var hit = closest(wanted, to - from, function (a, b) { return wanted.charCodeAt(a) === text.charCodeAt(from + b); }, Math.max(1, Math.floor(wanted.length * 0.3)));
    if (!hit) return null;
    var first = from + hit[0];
    var last = from + hit[1];
    while (first < last && text.charAt(first) === " ") first += 1;
    while (last > first && text.charAt(last - 1) === " ") last -= 1;
    return last > first ? [first, last] : null;
  }

  /* ----- finding a place ----- */

  // The nearest of an anchor's ids that the page still has.
  function scopeOf(anchor) {
    var ids = anchor.ids || [];
    for (var i = 0; i < ids.length; i += 1) {
      var element = document.getElementById(ids[i]);
      if (element && tag(element) !== "HTML" && tag(element) !== "BODY") return element;
    }
    return null;
  }

  function atPath(anchor) {
    if (!anchor.path) return null;
    try { return document.querySelector(anchor.path); } catch (e) { return null; }
  }

  // How well a part's text agrees with an anchor's: 2 the same, 1 one begins
  // with the other, 0 not at all. Two with no text agree.
  function agrees(wanted, text) {
    if (wanted === text) return 2;
    if (wanted && text && (text.indexOf(wanted) === 0 || wanted.indexOf(text) === 0)) return 1;
    return 0;
  }

  function pickPart(m, anchor, root) {
    var name = anchor.tag.toUpperCase();
    var pathHit = atPath(anchor);
    var firstId = anchor.ids && anchor.ids.length ? anchor.ids[0] : "";
    var list = [];
    if (tag(root) === name) list.push(root);
    var inside = root.getElementsByTagName(anchor.tag);
    for (var i = 0; i < inside.length; i += 1) list.push(inside[i]);
    var onPath = null;
    var byId = null;
    var best = null;
    var bestScore = 0;
    for (var k = 0; k < list.length; k += 1) {
      var element = list[k];
      var score = agrees(anchor.text, partText(m, element));
      if (!score) continue;
      if (element === pathHit) onPath = element;
      if (firstId && !byId && ownId(element) === firstId) byId = element;
      // The best match, and of two as good where one holds the other, the inner.
      if (anchor.text && (score > bestScore || (score === bestScore && best && best.contains(element)))) {
        best = element;
        bestScore = score;
      }
    }
    return onPath || byId || best;
  }

  function findPart(m, anchor) {
    if (!anchor.tag || anchor.tag === "body" || anchor.tag === "html") return null;
    var scope = scopeOf(anchor);
    var part = scope ? pickPart(m, anchor, scope) : null;
    return part || pickPart(m, anchor, document.body || document.documentElement);
  }

  function resolveOne(anchor, m) {
    if (!anchor.quote) {
      var part = findPart(m, anchor);
      return part ? { state: "found", element: part } : { state: "lost" };
    }
    var whole = [0, m.text.length];
    var scope = scopeOf(anchor);
    var spans = scope ? [spanOf(m, scope), whole] : [whole];
    var made = atPath(anchor);
    var near = made && made.tagName.toLowerCase() === anchor.tag ? spanOf(m, made) : null;
    var hit = null;
    var state = "found";
    var i;
    for (i = 0; i < spans.length && !hit; i += 1) {
      hit = findExact(m.text, anchor.quote, spans[i][0], spans[i][1], anchor.prefix, anchor.suffix, near);
      if (!hit) hit = findExact(folded(m), fold(anchor.quote), spans[i][0], spans[i][1], fold(anchor.prefix || ""), fold(anchor.suffix || ""), near);
    }
    for (i = 0; i < spans.length && !hit; i += 1) {
      hit = findClose(m, anchor.quote, spans[i][0], spans[i][1]);
      if (hit) state = "changed";
    }
    var range = hit ? rangeFor(m, hit[0], hit[1]) : null;
    if (range) return { state: state, range: range };
    var around = findPart(m, anchor);
    return around ? { state: "part", element: around } : { state: "lost" };
  }

  function resolveAll() {
    var next = {};
    if (visible) {
      var m = getModel();
      for (var i = 0; i < threads.length; i += 1) {
        try { next[threads[i].id] = resolveOne(threads[i].anchor, m); } catch (e) { next[threads[i].id] = { state: "lost" }; }
      }
    }
    resolved = next;
  }

  /* ----- marking ----- */

  var registry = typeof Highlight === "function" && window.CSS && CSS.highlights ? CSS.highlights : null;
  var MARK_RULES =
    "::highlight(dk-comment){background-color:rgba(47,111,221,0.16);text-decoration:underline 2px rgba(47,111,221,0.45)}" +
    "::highlight(dk-comment-hot){background-color:rgba(47,111,221,0.32);text-decoration:underline 2px rgba(47,111,221,0.95)}";
  // While picking, only the pointer changes. Nothing can be selected then
  // anyway (the presses that would start a selection are swallowed below),
  // and user-select: none is not used to say so: WebKit stops painting a
  // highlight on text that has it, so every commented word would lose its
  // tint for as long as the reader was picking.
  var PICK_RULES = "*{cursor:crosshair !important}";
  var pickSheet = null;

  function adopt(rules) {
    try {
      var sheet = new CSSStyleSheet();
      sheet.replaceSync(rules);
      document.adoptedStyleSheets = Array.prototype.concat.call(document.adoptedStyleSheets || [], [sheet]);
      return sheet;
    } catch (e) { return null; }
  }

  function drop(sheet) {
    try {
      document.adoptedStyleSheets = Array.prototype.filter.call(document.adoptedStyleSheets || [], function (each) { return each !== sheet; });
    } catch (e) { /* nothing to take back */ }
  }

  if (registry) adopt(MARK_RULES);

  // Each kind of mark is one Highlight, put in the registry once and then
  // emptied and filled as what is marked changes.
  var marks = {};
  function mark(name, ranges, priority) {
    if (!registry) return;
    var highlight = marks[name];
    if (!highlight) {
      highlight = marks[name] = new Highlight();
      highlight.priority = priority;
      registry.set(name, highlight);
    }
    highlight.clear();
    for (var i = 0; i < ranges.length; i += 1) highlight.add(ranges[i]);
  }

  function paint() {
    var plain = [];
    var hot = [];
    if (visible) {
      for (var i = 0; i < threads.length; i += 1) {
        var entry = resolved[threads[i].id];
        if (!entry || !entry.range) continue;
        if (threads[i].id === activeId || threads[i].id === hoverId) hot.push(entry.range);
        else plain.push(entry.range);
      }
    }
    mark("dk-comment", plain, 0);
    mark("dk-comment-hot", hot, 1);
  }

  /* ----- document zoom ----- */

  // The rendition scales with CSS zoom, not a transform: zoom is a
  // layout-level scale, so text re-flows and re-renders crisply at the new
  // size (a transform rasterizes once and stretches the bitmap — see the
  // WKWebView blur that rules transforms out for zoom UIs).
  function applyZoom(z) {
    zoom = typeof z === "number" && z > 0 ? z : 1;
    document.body.style.zoom = zoom === 1 ? "" : String(zoom);
    measureRectK();
  }

  // Boxes cross to the app in VIEWPORT pixels (its layers share the frame's
  // box but none of its zoom). Spec-compliant zoom already reports
  // getBoundingClientRect that way; implementations predating the 2024 zoom
  // spec report unzoomed layout pixels instead. Rather than bet on the
  // engine, measure a known-width probe inside the zoomed subtree: it comes
  // back as 100*zoom under the new behavior (factor 1) and 100 under the old
  // one (factor zoom).
  function measureRectK() {
    if (zoom === 1) {
      rectK = 1;
      return;
    }
    var probe = document.createElement("div");
    probe.style.cssText =
      "position:absolute;top:0;left:0;width:100px;height:0;visibility:hidden;pointer-events:none";
    document.body.appendChild(probe);
    var w = probe.getBoundingClientRect().width;
    document.body.removeChild(probe);
    rectK = w > 0 ? (100 * zoom) / w : 1;
  }

  /* ----- where things are ----- */

  // Every box the script says goes through here, so the zoom correction is
  // applied exactly once, in one place — and it is a box on the page, not on
  // screen.
  function box(rect) {
    return {
      top: rect.top * rectK + window.scrollY,
      left: rect.left * rectK + window.scrollX,
      width: rect.width * rectK,
      height: rect.height * rectK
    };
  }

  function visibleRects(range) {
    var out = [];
    var rects = range.getClientRects();
    for (var i = 0; i < rects.length && out.length < 60; i += 1) {
      if (rects[i].width > 0 && rects[i].height > 0) out.push(box(rects[i]));
    }
    return out;
  }

  function bounds(rects) {
    var top = Infinity, left = Infinity, right = -Infinity, bottom = -Infinity;
    for (var i = 0; i < rects.length; i += 1) {
      top = Math.min(top, rects[i].top);
      left = Math.min(left, rects[i].left);
      right = Math.max(right, rects[i].left + rects[i].width);
      bottom = Math.max(bottom, rects[i].top + rects[i].height);
    }
    return { top: top, left: left, width: right - left, height: bottom - top };
  }

  // Whether a node is drawn at all. A closed <details> keeps its content
  // laid out in some browsers, with boxes that are nowhere a reader can
  // see, so boxes alone do not say.
  function drawn(node) {
    var element = node && node.nodeType === 1 ? node : node && node.parentNode;
    if (!element || element.nodeType !== 1) return false;
    if (typeof element.checkVisibility === "function") {
      try { if (!element.checkVisibility()) return false; } catch (e) { /* judged by its boxes */ }
    }
    var inner = element;
    for (var up = element.parentNode; up && up.nodeType === 1; inner = up, up = up.parentNode) {
      if (tag(up) === "DETAILS" && !up.open && tag(inner) !== "SUMMARY") return false;
    }
    return true;
  }

  // The nearest thing around a node that is on screen, for a place folded
  // away inside a closed part of the page.
  function shownAround(node) {
    var element = node && node.nodeType === 1 ? node : node && node.parentNode;
    while (element && element.nodeType === 1) {
      if (drawn(element)) {
        var rect = element.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) return box(rect);
      }
      element = element.parentNode;
    }
    return null;
  }

  // What a part is, and what it is called: its own words for a paragraph, a
  // heading or a row; the heading inside it, or else its first words, for a
  // part that holds others.
  function labelOf(element) {
    var name = tag(element);
    var kind = "block";
    if (name === "TABLE") kind = "table";
    else if (name === "TR") kind = "row";
    else if (name === "IMG" || name === "PICTURE") kind = "picture";
    else if (name === "SVG" || name === "CANVAS" || name === "FIGURE" || name.indexOf("-") > 0) kind = "drawing";
    else if (/^H[1-6]$/.test(name)) kind = "heading";
    else if (name === "P" || name === "BLOCKQUOTE" || name === "PRE") kind = "paragraph";
    else if (name === "UL" || name === "OL" || name === "DL") kind = "list";
    else if (name === "LI" || name === "DT" || name === "DD") kind = "item";
    else if (name === "BUTTON") kind = "button";
    else if (ownId(element) || /^(SECTION|ARTICLE|MAIN|ASIDE|HEADER|FOOTER|NAV)$/.test(name)) kind = "section";
    var own = kind === "heading" || kind === "paragraph" || kind === "item" || kind === "row" || kind === "button";
    var title = "";
    try {
      var heading = own ? null : element.querySelector("h1,h2,h3,h4,h5,h6,caption,figcaption,summary");
      title = squash(element.getAttribute("aria-label") || (heading && heading.textContent) || element.getAttribute("title") || "");
      if (!title) title = name === "IMG" ? pictureText(element) : partText(getModel(), element);
    } catch (e) { title = ""; }
    return { kind: kind, title: title.slice(0, 90) };
  }

  var measureQueued = false;
  function measure() {
    measureQueued = false;
    var places = [];
    for (var i = 0; i < threads.length; i += 1) {
      var entry = resolved[threads[i].id];
      if (!entry) continue;
      var row = { id: threads[i].id, state: entry.state };
      entry.rects = null;
      if (entry.range) {
        var rects = drawn(entry.range.startContainer) ? visibleRects(entry.range) : [];
        if (rects.length) {
          entry.rects = rects;
          row.words = bounds(rects);
          row.top = rects[0].top;
        } else {
          row.hidden = true;
          var around = shownAround(entry.range.startContainer);
          if (around) row.top = around.top;
        }
      }
      if (entry.element) {
        var rect = entry.element.getBoundingClientRect();
        row.label = labelOf(entry.element);
        if (drawn(entry.element) && (rect.width > 0 || rect.height > 0)) {
          row.part = box(rect);
          row.top = row.part.top;
        } else {
          row.hidden = true;
          var near = shownAround(entry.element.parentNode);
          if (near) row.top = near.top;
        }
      }
      places.push(row);
    }
    var root = document.documentElement;
    post({
      type: "layout",
      places: places,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      pageHeight: (document.scrollingElement || root).scrollHeight,
      painted: !!registry
    });
  }

  function queueMeasure() {
    if (measureQueued) return;
    measureQueued = true;
    (window.requestAnimationFrame || window.setTimeout)(measure, 16);
  }

  // The page changed: read it again, find every place again.
  var refreshTimer = null;
  function refresh() {
    refreshTimer = null;
    model = null;
    resolveAll();
    paint();
    measure();
  }
  function queueRefresh() {
    if (refreshTimer !== null) return;
    refreshTimer = window.setTimeout(refresh, 120);
  }

  /* ----- what the reader does ----- */

  function noSelection() {
    selectionRange = null;
    if (saidSelection) { saidSelection = false; post({ type: "select", anchor: null }); }
  }

  function readSelection() {
    var selection = document.getSelection ? document.getSelection() : null;
    if (picking || !selection || selection.rangeCount === 0 || selection.isCollapsed) { noSelection(); return; }
    var picked = selection.getRangeAt(0);
    var m = getModel();
    var from = toModel(m, picked.startContainer, picked.startOffset);
    var to = toModel(m, picked.endContainer, picked.endOffset);
    while (from < to && m.text.charAt(from) === " ") from += 1;
    while (to > from && m.text.charAt(to - 1) === " ") to -= 1;
    if (to - from > QUOTE_LEN) {
      to = from + QUOTE_LEN;
      while (to > from && m.text.charAt(to - 1) === " ") to -= 1;
    }
    var range = to > from ? rangeFor(m, from, to) : null;
    var rects = range ? visibleRects(range) : [];
    if (!range || !rects.length) { noSelection(); return; }
    selectionRange = range;
    saidSelection = true;
    post({
      type: "select",
      anchor: wordsAnchor(m, from, to, range.commonAncestorContainer),
      box: bounds(rects),
      first: rects[0]
    });
  }

  var selectionTimer = null;
  function queueSelection() {
    if (selectionTimer !== null) window.clearTimeout(selectionTimer);
    selectionTimer = window.setTimeout(function () { selectionTimer = null; readSelection(); }, 90);
  }

  // The thread whose marked words are at a point on screen. Of two threads on
  // the same words, the one on fewer of them.
  function threadAt(x, y) {
    var px = x + window.scrollX;
    var py = y + window.scrollY;
    var hit = null;
    var smallest = Infinity;
    for (var i = 0; i < threads.length; i += 1) {
      var entry = resolved[threads[i].id];
      if (!entry || !entry.rects) continue;
      var inside = false;
      var area = 0;
      for (var r = 0; r < entry.rects.length; r += 1) {
        var rect = entry.rects[r];
        area += rect.width * rect.height;
        if (px >= rect.left && px <= rect.left + rect.width && py >= rect.top && py <= rect.top + rect.height) inside = true;
      }
      if (inside && area < smallest) { smallest = area; hit = threads[i].id; }
    }
    return hit;
  }

  // A part as the app is told of it: where a thread on it would go, where it
  // is, and what it is.
  function describe(m, element) {
    return { anchor: partAnchor(m, element), box: box(element.getBoundingClientRect()), label: labelOf(element) };
  }

  function sayPickTarget() {
    if (!pickTarget) { post({ type: "pickhover", anchor: null }); return; }
    var said = describe(getModel(), pickTarget);
    said.type = "pickhover";
    post(said);
  }

  function clearPick() {
    pickBase = null;
    pickUp = 0;
    pickTarget = null;
  }

  // The up arrow for the part around the one outlined, down to come back in.
  function widen(by) {
    if (!picking || !pickBase || !pickTarget) return;
    var m = getModel();
    if (by > 0) {
      var next = wider(m, pickTarget);
      if (!next) return;
      pickUp += 1;
      pickTarget = next;
    } else {
      if (pickUp === 0) return;
      pickUp -= 1;
      pickTarget = pickBase;
      for (var i = 0; i < pickUp; i += 1) pickTarget = wider(m, pickTarget) || pickTarget;
    }
    sayPickTarget();
  }

  function setPicking(on) {
    if (on === picking) return;
    picking = on;
    clearPick();
    if (picking && !pickSheet) pickSheet = adopt(PICK_RULES);
    if (!picking && pickSheet) { drop(pickSheet); pickSheet = null; }
    if (picking) {
      var selection = document.getSelection ? document.getSelection() : null;
      if (selection) selection.removeAllRanges();
      noSelection();
    }
  }

  var moveQueued = false;
  var lastMove = null;
  function onMove() {
    moveQueued = false;
    if (!lastMove) return;
    if (picking) {
      var base = partAt(getModel(), lastMove.target);
      if (base === pickBase) return;
      pickBase = base;
      pickUp = 0;
      pickTarget = base;
      sayPickTarget();
      return;
    }
    if (!visible) return;
    var over = threadAt(lastMove.x, lastMove.y);
    if (over !== saidHover) { saidHover = over; post({ type: "hover", id: over }); }
  }

  document.addEventListener("mousemove", function (event) {
    lastMove = { x: event.clientX, y: event.clientY, target: event.target };
    if (moveQueued) return;
    moveQueued = true;
    (window.requestAnimationFrame || window.setTimeout)(onMove, 16);
  }, true);

  document.addEventListener("mouseleave", function () {
    lastMove = null;
    if (picking) { clearPick(); post({ type: "pickhover", anchor: null }); }
    else if (saidHover !== null) { saidHover = null; post({ type: "hover", id: null }); }
  });

  // The app can't see pointer events inside the sandboxed frame; report them
  // so a click into this pane can move split focus here. Registered before
  // the picking swallow below, so a press while picking still says so.
  document.addEventListener("pointerdown", function () { post({ type: "gesture" }); }, true);

  // While picking, the page's own presses are paused: nothing it listens for
  // fires, no link is followed, nothing is selected.
  function swallow(event) {
    if (!picking) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
  }
  ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "contextmenu"].forEach(function (name) {
    document.addEventListener(name, swallow, true);
  });

  document.addEventListener("click", function (event) {
    if (picking) {
      swallow(event);
      var m = getModel();
      var base = partAt(m, event.target);
      // What is outlined, widened or not, when the click lands where the
      // outline was drawn from.
      var picked = base && base === pickBase ? pickTarget : base;
      if (!picked) { post({ type: "pick", anchor: null }); return; }
      var said = describe(m, picked);
      said.type = "pick";
      post(said);
      return;
    }

    // Links leave the rendition through the app, which follows them as it
    // follows one in a note, instead of letting them replace the preview.
    // In-page #hash links keep their default.
    var link = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (link) {
      var href = link.getAttribute("href") || "";
      if (!/^#/.test(href)) {
        event.preventDefault();
        if (event.button === 0 && !event.altKey && !event.shiftKey) {
          post({ type: "follow", href: href, url: link.href, newTab: event.metaKey || event.ctrlKey });
        }
      }
    }

    if (!visible) return;
    var selection = document.getSelection ? document.getSelection() : null;
    if (selection && !selection.isCollapsed) return; // a drag that selected words is not a click on them
    post({ type: "activate", id: threadAt(event.clientX, event.clientY) });
  }, true);

  document.addEventListener("selectionchange", queueSelection);
  document.addEventListener("mouseup", queueSelection, true);
  document.addEventListener("keyup", queueSelection, true);

  // Once the reader clicks into the rendition, keystrokes stop at the frame
  // boundary — the app's window listeners never see them. Two kinds are
  // passed out, and nothing else (this is not a general key tunnel out of
  // arbitrary markup): the app's shortcuts, by name (APP_SHORTCUTS, keys.ts),
  // and the comment keys (C, ⇧C, ⌘⌥M, Esc). The page keeps the rest: ⌘F, ⌘S,
  // ⌘⌫, ⌘C / ⌘X / ⌘V and ⌘Z are its own here.
  //
  // Matched as the window's key handlers match them (App.tsx: the ⌘[ / ⌘]
  // handler, then onKey, branch for branch and in its order) — change both.
  function appShortcut(e) {
    if ((e.code === "BracketLeft" || e.code === "BracketRight") && !e.altKey && !e.shiftKey) {
      return e.code === "BracketLeft" ? "back" : "forward";
    }
    var k = String(e.key || "").toLowerCase();
    if (k === "f") return e.shiftKey ? "search" : null;
    if (k === "s" && !e.shiftKey) return null;
    if ((k === "n" || k === "t") && !e.shiftKey) return "new-tab";
    if (k === "w" && !e.shiftKey) return "close-tab";
    if (k === "backspace") return null;
    if ((k === "c" || k === "x" || k === "v") && !e.shiftKey && !e.altKey) return null;
    if (e.code === "KeyO") {
      if (e.altKey) return e.shiftKey ? "open-folder-window" : "open-file-window";
      return e.shiftKey ? "open-folder" : "open-file";
    }
    if (e.code === "Tab" && e.ctrlKey) return e.shiftKey ? "previous-tab" : "next-tab";
    if (e.code === "Backquote" && e.metaKey) return e.shiftKey ? "previous-window" : "next-window";
    if (e.code === "Backslash" && e.shiftKey) return "split";
    if (k === "\\") return "sidebar";
    if (e.code === "KeyH" && e.altKey) return "history";
    if (e.code === "Equal" || e.code === "NumpadAdd") return "zoom-in";
    if (e.code === "Minus" || e.code === "NumpadSubtract") return "zoom-out";
    if (e.code === "Digit0" || e.code === "Numpad0") return "zoom-reset";
    return null;
  }
  document.addEventListener("keydown", function (event) {
    if (event.metaKey || event.ctrlKey) {
      // ⌘⌥M before the app's shortcuts, as the window's onKey has it.
      if (event.altKey && event.code === "KeyM") {
        event.preventDefault();
        post({ type: "key", key: "m" });
        return;
      }
      var shortcut = appShortcut(event);
      if (shortcut === null) return;
      event.preventDefault();
      post({ type: "shortcut", shortcut: shortcut });
      return;
    }
    if (event.altKey) return;
    // A key typed into a box of the page's own is the page's.
    var target = event.target;
    var name = tag(target);
    if (name === "INPUT" || name === "TEXTAREA" || name === "SELECT" || (target && target.isContentEditable)) return;
    var key = String(event.key || "");
    if (picking && (key === "ArrowUp" || key === "ArrowDown") && !event.shiftKey) {
      event.preventDefault();
      widen(key === "ArrowUp" ? 1 : -1);
      return;
    }
    if (key === "Escape") post({ type: "key", key: "Escape" });
    else if (key === "c" || key === "C") post({ type: "key", key: event.shiftKey ? "C" : "c" });
  }, true);

  /* ----- the page's scroll ----- */

  var scrollSyncMuteUntil = 0;
  window.addEventListener("scroll", function (event) {
    // A box inside the page scrolled: places moved on the page itself.
    if (event.target !== document && event.target !== window) { queueMeasure(); return; }
    var said = { type: "scroll", x: window.scrollX, y: window.scrollY };
    if (Date.now() >= scrollSyncMuteUntil) { // not the app's own scroll-sync move
      var doc = document.scrollingElement || document.documentElement;
      var range = doc.scrollHeight - doc.clientHeight;
      said.ratio = range > 0 ? doc.scrollTop / range : 0;
    }
    post(said);
  }, { capture: true, passive: true });

  function reveal(id) {
    var entry = resolved[id];
    if (!entry) return;
    var node = entry.range ? entry.range.startContainer : entry.element;
    var element = node && node.nodeType === 1 ? node : node && node.parentNode;
    if (!element) return;
    var opened = false;
    for (var up = element; up && up.nodeType === 1; up = up.parentNode) {
      if (tag(up) === "DETAILS" && !up.open) { up.open = true; opened = true; }
    }
    if (opened) measure();
    var rect = entry.range ? entry.range.getBoundingClientRect() : entry.element.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    var view = window.innerHeight;
    if (rect.top * rectK >= 48 && rect.bottom * rectK <= view - 72) return;
    var target = entry.range ? element : entry.element;
    if (!target || !target.scrollIntoView) return;
    // A tall part is brought to its top; words are brought to the middle.
    try { target.scrollIntoView({ behavior: "smooth", block: rect.height * rectK > view * 0.6 ? "start" : "center" }); }
    catch (e) { target.scrollIntoView(); }
  }

  /* ----- app messages ----- */

  window.addEventListener("message", function (event) {
    if (event.source !== host) return;
    var msg = event.data;
    if (!msg || msg.dk !== NS) return;
    if (msg.type === "sync") {
      threads = Array.isArray(msg.threads) ? msg.threads : [];
      visible = msg.visible === true;
      activeId = typeof msg.activeId === "string" ? msg.activeId : null;
      hoverId = typeof msg.hoverId === "string" ? msg.hoverId : null;
      var z = typeof msg.zoom === "number" && msg.zoom > 0 ? msg.zoom : 1;
      if (z !== zoom) applyZoom(z);
      setPicking(msg.picking === true);
      resolveAll();
      paint();
      measure();
    } else if (msg.type === "focus") {
      activeId = typeof msg.activeId === "string" ? msg.activeId : null;
      hoverId = typeof msg.hoverId === "string" ? msg.hoverId : null;
      paint();
    } else if (msg.type === "widen") {
      if (msg.by === 1 || msg.by === -1) widen(msg.by);
    } else if (msg.type === "reveal") {
      if (typeof msg.id === "string") reveal(msg.id);
    } else if (msg.type === "deselect") {
      var selection = document.getSelection ? document.getSelection() : null;
      if (selection) selection.removeAllRanges();
      noSelection();
    } else if (msg.type === "scroll-by") {
      if (typeof msg.dy === "number" && isFinite(msg.dy)) window.scrollBy(0, msg.dy);
    } else if (msg.type === "scroll-sync") {
      // Split-view sync drives our document scroll. The move is still said
      // (the app's layers follow it), without the ratio, so the two panes
      // never echo.
      var doc = document.scrollingElement || document.documentElement;
      var range = doc.scrollHeight - doc.clientHeight;
      if (range > 0 && typeof msg.ratio === "number") {
        scrollSyncMuteUntil = Date.now() + 250;
        doc.scrollTop = Math.max(0, Math.min(1, msg.ratio)) * range;
      }
    }
  });

  /* ----- the page's canvas colour, for the frame's backdrop ----- */

  // CSS paints the canvas with the root's background, or with <body>'s when
  // the root has none. Re-checked whenever the page's look can change: a
  // theme class or inline style on <html>/<body>, a stylesheet swap, the OS
  // appearance flipping, or a background transition settling.
  var canvasSent = null;
  function reportCanvas() {
    var root = getComputedStyle(document.documentElement);
    var src = root;
    var bg = root.backgroundColor;
    if ((bg === "transparent" || bg === "rgba(0, 0, 0, 0)") && root.backgroundImage === "none") {
      src = getComputedStyle(document.body);
    }
    var color = src.backgroundColor;
    if (color === canvasSent) return;
    canvasSent = color;
    post({ type: "canvas", color: color });
  }
  var paintChanges = new MutationObserver(reportCanvas);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", reportCanvas);
  document.addEventListener("transitionend", function (event) {
    if (event.target === document.documentElement || event.target === document.body) reportCanvas();
  }, true);

  /* ----- keeping places true ----- */

  window.addEventListener("resize", queueMeasure);
  document.addEventListener("toggle", queueMeasure, true);
  document.addEventListener("load", queueMeasure, true);
  document.addEventListener("transitionend", queueMeasure, true);
  document.addEventListener("animationend", queueMeasure, true);

  function start() {
    try {
      // Structure or words changed (the rendition's own JS): read the page again.
      new MutationObserver(queueRefresh).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    } catch (e) { /* places are found on sync only */ }
    try {
      var resize = new ResizeObserver(queueMeasure);
      resize.observe(document.documentElement);
      resize.observe(document.body);
    } catch (e) { /* places follow scroll and load only */ }
    paintChanges.observe(document.documentElement, { attributes: true });
    paintChanges.observe(document.body, { attributes: true });
    paintChanges.observe(document.head, { childList: true, subtree: true, characterData: true });
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) document.fonts.ready.then(queueMeasure);
    post({ type: "ready" });
    reportCanvas();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
  window.addEventListener("load", queueRefresh);
})();
`;

// Add the script to rendition markup bound for the preview frame, at the end
// of <body> so the document's own DOM exists by the time it runs; a fragment
// with no body/html tags just gets it appended. The LAST closing tag wins — a
// "</body>" inside a code sample earlier in the document must not attract
// the injection.
export function instrumentHtml(html: string): string {
  const assets = `<script>${BRIDGE_SCRIPT}</script>`;
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
