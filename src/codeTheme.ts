// Code blocks' syntax colours, from the theme's tokens. Crepe draws code
// blocks with CodeMirror and ships One Dark as their only theme, whose ivory
// text and bright hues sat washed out on the light and paper themes' pale
// code blocks.
//
// CodeMirror's own default highlight style already sorts every syntax tag
// into a dozen colour roles; those roles are kept, each repainted in a token
// (--code-keyword, --code-string… in tokens.css), so the colours follow the
// theme through CSS alone. A role the map below doesn't name — one a
// CodeMirror update adds — draws in the block's ink rather than a colour
// picked for one background. The editor's chrome around the text (ink,
// gutter, cursor, selection, tooltips) is App.css's.

import { HighlightStyle, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";

/** CodeMirror's default colour for a role → the token that paints it here. */
const ROLES: Record<string, string> = {
  "#708": "var(--code-keyword)", // keywords
  "#219": "var(--code-special)", // atoms, booleans, urls, labels
  "#164": "var(--code-number)", // numbers and other literals
  "#a11": "var(--code-string)", // strings
  "#e40": "var(--code-special)", // regexps, escapes
  "#00f": "var(--code-def)", // a variable where it is defined
  "#30a": "var(--code-ink)", // local variables
  "#085": "var(--code-type)", // types, namespaces
  "#167": "var(--code-type)", // class names
  "#256": "var(--code-special)", // special variables, macros
  "#00c": "var(--code-def)", // a property where it is defined
  "#940": "var(--code-comment)", // comments
  "#f00": "var(--error-ink)", // invalid
  "#404740": "var(--code-comment)", // meta: directives, annotations
};

const style = HighlightStyle.define(
  defaultHighlightStyle.specs.map(({ color, ...spec }) => ({
    ...spec,
    color: (typeof color === "string" && ROLES[color]) || "inherit",
    ...(color === "#940" ? { fontStyle: "italic" } : {}),
  })),
);

/**
 * The code blocks' theme, for Crepe's CodeMirror feature. Wrapped as
 * `{ extension }` on purpose: Crepe deep-merges this option with its One Dark
 * default (lodash defaultsDeep), which would graft One Dark's parts onto an
 * array index by index. CodeMirror reads a wrapper by its `extension` field
 * alone, so nothing the merge adds beside it is ever installed.
 */
export const codeTheme = { extension: syntaxHighlighting(style) };
