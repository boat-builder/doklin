# Tabs + Drafts — Follow-ups

Deferred work from the multi-document tabs/drafts MVP. One item remains; it
doesn't block the feature. High-level only.

## Preserve cursor/selection across tab switches

**What:** Restore the caret position (and ideally undo history) when returning to
a tab.

**Why:** The editor remounts on every switch (`key={loadKey}`), which discards
ProseMirror state. Cursor loss is more annoying than scroll loss for active
editing (scroll restore already landed).

**How:** Expose a ref API on `Editor.tsx` to read/set the ProseMirror selection
(and possibly serialize undo state), then snapshot/restore per tab on switch —
the `onReady` hook added for scroll restore is the natural restore point, and
stored positions must be clamped against the freshly loaded doc (the file may
have changed on disk between switches). The fuller version is keeping a live
editor instance per tab instead of remounting — much more memory/complexity,
only if switch-jank really bites.
