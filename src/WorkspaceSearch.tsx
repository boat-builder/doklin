import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type SearchMatch = { line: number; column: number; preview: string };
type FileMatches = { path: string; name: string; matches: SearchMatch[] };

type Props = {
  root: string;
  query: string;
  onQueryChange: (q: string) => void;
  caseSensitive: boolean;
  onToggleCase: () => void;
  // Open a result: load the file in a tab and seed the in-file find with the
  // query so the matching text is highlighted (WYSIWYG has no line to jump to).
  onOpenResult: (path: string, query: string) => void;
  onBackToFiles: () => void;
  // Bumped on ⌘⇧F (or the Search toggle) to focus the input.
  focusToken: number;
};

const SEARCH_DEBOUNCE_MS = 250;
const basename = (p: string) => p.split(/[\\/]/).pop() || p;

export default function WorkspaceSearch({
  root,
  query,
  onQueryChange,
  caseSensitive,
  onToggleCase,
  onOpenResult,
  onBackToFiles,
  focusToken,
}: Props) {
  const [results, setResults] = useState<FileMatches[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusToken]);

  // Debounced search whenever the query, case-sensitivity, or workspace changes.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      try {
        const res = await invoke<FileMatches[]>("search_workspace", {
          root,
          query: q,
          caseSensitive,
        });
        if (cancelled) return;
        setResults(res);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setResults([]);
        setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [root, query, caseSensitive]);

  const totals = useMemo(() => {
    const files = results.length;
    const matches = results.reduce((n, f) => n + f.matches.length, 0);
    return { files, matches };
  }, [results]);

  const toggleCollapsed = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <aside className="sidebar ws-search" aria-label="Search workspace">
      <div className="sidebar-header ws-search-header">
        <button
          className="sidebar-header-button"
          onClick={onBackToFiles}
          title="Back to files"
        >
          <BackIcon />
          <span className="sidebar-header-name">Search</span>
        </button>
      </div>

      <div className="ws-search-input-row">
        <input
          ref={inputRef}
          className="ws-search-input"
          type="text"
          placeholder="Search in folder"
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onBackToFiles();
            }
          }}
        />
        <button
          className={`ws-search-case ${caseSensitive ? "is-active" : ""}`}
          onClick={onToggleCase}
          title="Match case"
          aria-pressed={caseSensitive}
        >
          Aa
        </button>
      </div>

      <div className="sidebar-body ws-search-body">
        {error && <div className="sidebar-message sidebar-message-error">{error}</div>}
        {!error && loading && (
          <div className="sidebar-message">Searching…</div>
        )}
        {!error && !loading && query.trim() && results.length === 0 && (
          <div className="sidebar-message">No results</div>
        )}
        {!error && !loading && results.length > 0 && (
          <>
            <div className="ws-search-summary">
              {totals.matches} {totals.matches === 1 ? "result" : "results"} in{" "}
              {totals.files} {totals.files === 1 ? "file" : "files"}
            </div>
            <ul className="ws-result-list">
              {results.map((file) => {
                const isCollapsed = collapsed.has(file.path);
                return (
                  <li key={file.path} className="ws-result-file">
                    <button
                      className="ws-result-file-header"
                      onClick={() => toggleCollapsed(file.path)}
                      title={file.path}
                    >
                      <span
                        className={`tree-chevron ${isCollapsed ? "is-collapsed" : ""}`}
                      >
                        <ChevronRightIcon />
                      </span>
                      <span className="ws-result-file-name">
                        {stripMdExt(file.name)}
                      </span>
                      <span className="ws-result-file-count">{file.matches.length}</span>
                    </button>
                    {!isCollapsed && (
                      <ul className="ws-result-matches">
                        {file.matches.map((m, i) => (
                          <li key={`${file.path}:${m.line}:${i}`}>
                            <button
                              className="ws-result-row"
                              onClick={() => onOpenResult(file.path, query.trim())}
                              title={`${basename(file.path)}:${m.line}`}
                            >
                              <span className="ws-result-line">{m.line}</span>
                              <span className="ws-result-preview">
                                {highlight(m.preview, query.trim(), caseSensitive)}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </aside>
  );
}

function stripMdExt(name: string): string {
  return name.replace(/\.(md|markdown|mdown|mkd)$/i, "");
}

// Wrap occurrences of `query` in <mark> for the preview line. Case-insensitive
// match by default; the matched substring keeps its original casing.
function highlight(text: string, query: string, caseSensitive: boolean) {
  if (!query) return text;
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const parts: Array<string | { m: string }> = [];
  let i = 0;
  let idx = hay.indexOf(needle);
  while (idx !== -1) {
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push({ m: text.slice(idx, idx + needle.length) });
    i = idx + needle.length;
    idx = hay.indexOf(needle, i);
  }
  if (i < text.length) parts.push(text.slice(i));
  return parts.map((p, k) =>
    typeof p === "string" ? (
      <span key={k}>{p}</span>
    ) : (
      <mark key={k} className="ws-result-hit">
        {p.m}
      </mark>
    ),
  );
}

function BackIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}
