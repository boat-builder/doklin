# Tabs + Drafts — Follow-ups

Deferred work from the multi-document tabs/drafts MVP. None of these block the
feature; they're polish and robustness items. High-level only.

## 1. Preserve scroll position across tab switches

**What:** When switching tabs, remember each tab's scroll offset and restore it
when the tab becomes active again.

**Why:** The editor remounts on every switch (`key={loadKey}`), so the canvas
jumps back to the top each time. With tabs you flip between docs far more often
than before, so the reset is noticeable.

**How:** Keep a `Map<tabId, scrollTop>` in `App.tsx`. On switch, capture the
`.editor-wrap` scrollTop into the map before remounting; after the new editor
mounts, set `.editor-wrap.scrollTop` from the map for the incoming tab. Scroll is
DOM-level so it doesn't need editor internals.

## 2. Preserve cursor/selection across tab switches

**What:** Restore the caret position (and ideally undo history) when returning to
a tab.

**Why:** Same root cause as scroll — remount discards ProseMirror state. Cursor
loss is more annoying than scroll loss for active editing.

**How:** This needs an imperative handle on `Editor.tsx` (currently none). Expose
a ref API to read/set the ProseMirror selection (and possibly serialize undo
state), then snapshot/restore per tab on switch. Bigger lift than scroll; do it
after #1. The fuller version is keeping a live editor instance per tab instead of
remounting — much more memory/complexity, only if switch-jank really bites.

## 3. Tab drag-to-reorder — ✅ done

**What:** Drag tabs left/right to reorder them; persist the new order.

**Why:** Users expect to arrange tabs like in any browser/editor.

**How:** Add pointer drag handling in `TabBar.tsx` that reorders the `tabs`
array and calls a new `reorderTabs(nextOrder)` in `App.tsx` (which updates
`tabsRef`/state and `writeStoredSession`). Keep it dependency-free with native
pointer events, or a tiny dnd helper.

## 4. Tab overflow menu — ✅ done

**What:** When tabs exceed the bar width, show a chevron/“›” button that opens a
dropdown listing all open tabs to jump to.

**Why:** Today overflow is horizontal scroll only; with many tabs, finding one
off-screen is fiddly.

**How:** Detect overflow on `.tab-bar` (scrollWidth > clientWidth), render a
trailing button that opens a popover (reuse the Settings popover pattern) listing
`tabs` with click → `switchTab`. Mark the active one.

## 5. Missing-file "ghost tab" instead of silent drop

**What:** On session restore, a file tab whose path no longer exists is currently
dropped silently. Instead, keep it as a visibly-broken "not found" tab the user
can dismiss.

**Why:** Silently losing a tab can surprise users (e.g. an external drive was
unmounted at launch). A visible ghost tab is more honest and lets them decide.

**How:** In the startup restore loop in `App.tsx`, instead of skipping a failed
`read_file`, keep the tab and flag it (e.g. `missing: true`). Render it muted /
struck-through in `TabBar.tsx`; on activation show an empty "file not found"
state with a close action rather than loading content.

## 6. Robust quit flush — ✅ done

**What:** Guarantee the last keystrokes are written on app quit, not just
best-effort.

**Why:** The current `onCloseRequested`/`beforeunload` flush fires
`flushPendingAutosave()` but the underlying `write_file` is fire-and-forget — the
process can exit before it resolves if you type and immediately ⌘Q within the
600ms debounce.

**How:** In the Tauri window `onCloseRequested` handler, `preventDefault()`,
`await` the pending write (make `flushPendingAutosave` awaitable / return the
write promise), then destroy the window. Guard against double-close.

## 7. Live preview refresh in the drafts panel — ✅ done

**What:** Update each draft's one-line preview in the drafts panel as you type,
not just when tabs change.

**Why:** The panel currently refreshes on open and whenever the open tabs change
(`refreshDraftsPanel` keyed on `tabs`). A draft you're actively editing keeps a
stale preview — a brand-new draft shows "Empty draft" until you switch/close a
tab. `list_drafts` reads from disk, so the refresh also has to land *after* the
600ms autosave write, not on the keystroke.

**How:** Bump a refresh token from `writeToDisk` (or right after the autosave
flush) when the active doc is a draft, and add that token to the
`refreshDraftsPanel` effect deps. Debounce so it doesn't thrash. Alternatively,
update the active draft's row optimistically from `currentMarkdownRef` without a
disk round-trip.
