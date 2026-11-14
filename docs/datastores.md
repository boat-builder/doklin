# Datastores (boards)

A datastore ("board" in the UI) is a folder: `store.jsonl` plus one card per
direct-child markdown file. Frontmatter = properties; body = an ordinary note.

## Cards

- Title = file name minus extension; `sanitizeTitle` maps `/` `:` to `-`.
  Rename via `movePath` (App.tsx) so sidecar, rendition, tabs and published
  address follow.
- `rank` = position in its column: a fractional-index key (`rank.ts`; plain
  string order, `a0 < a0V < a1`), so a move rewrites one line of one file.
  `rank` is never a field id.
- Values are option NAMES: renaming an option rewrites every card with it;
  deleting an option or field rewrites none.
- Clearing a property deletes its key; no keys and no opaque lines ⇒ no block.

## Frontmatter dialect (`src/store/frontmatter.ts`)

A block exists only when line 1 is `---` (trailing whitespace ok) and a later
line is `---`. Rust `head_len` (store.rs) applies the same rule; keep in step.

```
key: text          # string; '…' or "…" (\n \t \\ \")
n: 3               # number: -?(0|[1-9]\d*)(\.\d+)?
flag: true         # true | false
due: 2026-09-12    # dates are strings
tags: [a, "b, c"]  # flow list: the only list form written
also:              # block list: read only
  - a
empty:             # null (also null, ~)
```

- Keys: `[A-Za-z0-9_][A-Za-z0-9_ .+/-]*`.
- Anything else is an opaque line, kept verbatim: nested maps and multi-line
  scalars (with their indented run), comments, duplicate keys (first wins).
  Blank lines in the block are dropped on rewrite.
- `serializeFrontmatter` is canonical: `cardKeyOrder(def)` (fields in
  `store.jsonl` order, then `rank`), other keys alphabetically, then opaque
  lines; quotes only when needed. Equal state ⇒ equal bytes.

## `store.jsonl` (`src/store/storeFile.ts`)

```jsonl
{"doklin":"store","v":1,"name":"Projects"}
{"t":"field","id":"status","name":"Status","type":"select"}
{"t":"option","field":"status","name":"Done","rank":"a2","color":"green"}
{"t":"view","id":"v","kind":"table","name":"Open","groupBy":"","filter":[{"f":"status","op":"is_not","v":"Done"}]}
```

- Line 1 must be the header; it, not the name, makes a store
  (`is_store_dir`, `parseStoreDef`). Never a dotfile: those don't sync.
- Canonical order: header, fields by `id`, options by `(field, name)` (so a
  column move edits one line in place), views by `id`, unknown records
  verbatim. Fixed key order per record.
- Tolerant parse: bad lines skipped, first duplicate wins, unknown `t` kept;
  a kanban view without `groupBy` is dropped.
- Field types: `select multi_select text number date checkbox`. Groupable:
  `select`, `multi_select` (a column per value), `date` (the dates carried).
- Field `id` = the frontmatter key, slugged once (`newFieldId`), unchanged by
  renames. Option `color` is an `OPTION_COLORS` name, never hex; column order
  is option `rank`.
- View keys written only when set: `filter` (ANDed; ops `is is_not has empty
  not_empty`, case-insensitive, `has` = substring, empty `v` passes all),
  `sort` (`{f, dir}`), `show` (absent = every field), `hide`
  (column values), `excerpt` (only ever `false`; absent = on).

## Embed fence (`src/store/embedConfig.ts`, `src/storeEmbed.ts`)

````
```kanban
store: ./Projects
view: board
hide: [Done]
```
````

- Info string exactly `kanban` or `table`; anything else stays a code block.
  The language decides the kind; `view:` picks a saved view of that kind;
  `group:` / `hide:` override for this embed.
- Config grammar = `parseProps`; `store` resolves against the note
  (`linkTargetPath`).
- Must round-trip byte for byte: `$remark` retypes `code` to `storeEmbed` and
  back (`fenceEmbed`); one node, `kanban_embed`, for both kinds; never
  Crepe's code-block preview.
- The worker's raw-byte `storeFences` must agree with the editor's parse.

## Rules

- **Frontmatter boundary**: Milkdown never sees frontmatter. App.tsx
  `adoptFrontmatter` splits it on load; `writeToDisk` prepends `cardHeadRef`
  verbatim. An external change whose body equals `lastDiskMdRef` is
  properties-only: adopt block and snapshot, leave the editor.
- **Two halves, two splices**: `write_frontmatter` replaces only the block,
  `write_body` only the body, against the file as on disk, under the
  `expected` snapshot guard (`conflict`). Boards and headers own the block;
  `CardPeek.tsx` owns the body. Unlike `write_file`, neither primes the file
  watcher: open tabs must hear it.
- Only TS parses the dialect; `read_store` returns each card's raw block
  (16 KB window, same as the worker) and a 400-byte lead.
- **One derivation**: `src/store/board.ts` serves the tab, the embed and the
  published page. The cloud worker bundles `board.ts`, `embedConfig.ts`,
  `frontmatter.ts`, `rank.ts`, `storeFile.ts`: no Tauri, React or DOM there.
- `StoreModel` (model.ts) is a cache of disk: write, then the `watch_dir`
  rescan. One per folder via `acquireStore`/`releaseStore` (pair exactly
  once). Rescans wait for pending writes and compare bytes, not snapshots.
- Only a store tab edits views; embeds write no view state. A card already
  open in a tab opens the tab, never a peek.
- Drag is pointer-based (Tauri eats HTML5 drag); the embed node view
  cancels `dragstart` outside `.dk-embed-bar`.

## Sync, publishing, agents

- Sync collisions yield a `(conflict — …)` copy: a second card, or a
  `store.jsonl` copy listed in `read_store`'s `conflicts`.
- The worker reads at most `MAX_STORE_CARDS` cards
  (`cloud-worker/src/workspace.ts`); cut content is counted, never silently
  dropped. A published note publishes what its embeds show, published store
  or not. See [cloud-publishing.md](cloud-publishing.md).
- Agents see a board as a board, never its folder
  (`cloud-worker/src/agentBoards.ts`), written through the modules above. A
  card's page is the document `<board>/<card>` minus its block (`splitCard`);
  agent search skips properties. Views are human-only: agents get the first
  kanban view's grouping, no filter, sort or hide. See
  [cloud-people-agents.md](cloud-people-agents.md).

Tests: `node verify-harness/store.test.mjs`, `cargo test --lib store`.
