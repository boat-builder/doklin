// CriticMarkup editorial comments — pure string helpers (no editor deps).
//
// Comments are modelled in the editor as a first-class `critic_comment` inline
// mark (see criticMark.ts); CriticMarkup is just the on-disk markdown
// serialization of that mark:
//
//   {==highlighted text==}{>>the comment<<}
//
// These pure helpers cover the two places where the format is handled as a
// string: the remark round-trip (the shared regex) and the clean-copy transform.

// A full highlight+comment pair. Group 1 = anchor (highlighted text), group 2 =
// comment body. `[\s\S]` (not `.`) so either part can contain anything but the
// delimiters; non-greedy so adjacent markers don't merge into one match. The
// anchor must be non-empty; the body may be empty (a highlight with no note yet).
export const CRITIC_RE = /\{==([\s\S]+?)==\}\{>>([\s\S]*?)<<\}/g;

// The clean / "accept" transform: drop comments entirely, unwrap highlights to
// their plain text. This is what plain ⌘C copies, so a marked-up document never
// leaks braces to a reader.
//
// Comments are removed first (delimiters + content), then any remaining
// highlight wrapper is unwrapped — which also tidies a stray `{==..==}` that has
// no trailing comment.
export function stripComments(md: string): string {
  return md
    .replace(/\{>>[\s\S]*?<<\}/g, "")
    .replace(/\{==([\s\S]*?)==\}/g, "$1");
}
