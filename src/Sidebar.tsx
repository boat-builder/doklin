import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type TreeNode =
  | { kind: "file"; name: string; path: string }
  | { kind: "dir"; name: string; path: string; children: TreeNode[] };

type Props = {
  root: string;
  currentPath: string | null;
  refreshToken: number;
  onOpenFile: (path: string) => void;
  onOpenFolder: () => void;
  onOpenFilePicker: () => void;
  onRevealInFinder: (path: string) => void;
  onSwitchToSearch: () => void;
};

const basename = (p: string) => p.split(/[\\/]/).pop() || p;

export default function Sidebar({
  root,
  currentPath,
  refreshToken,
  onOpenFile,
  onOpenFolder,
  onOpenFilePicker,
  onRevealInFinder,
  onSwitchToSearch,
}: Props) {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [menuOpen, setMenuOpen] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const node = await invoke<TreeNode>("list_md_tree", { path: root });
      setTree(node);
    } catch (e) {
      setError(String(e));
      setTree(null);
    } finally {
      setLoading(false);
    }
  }, [root]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshToken]);

  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const toggleCollapsed = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const rootName = useMemo(() => basename(root), [root]);

  return (
    <aside className="sidebar" aria-label="File browser">
      <SidebarHeader
        name={rootName}
        menuOpen={menuOpen}
        setMenuOpen={setMenuOpen}
        onOpenFolder={onOpenFolder}
        onOpenFile={onOpenFilePicker}
        onRevealInFinder={() => onRevealInFinder(root)}
        onRefresh={() => void refresh()}
        onSwitchToSearch={onSwitchToSearch}
      />
      <div className="sidebar-body">
        {error && <div className="sidebar-message sidebar-message-error">{error}</div>}
        {!error && loading && !tree && (
          <div className="sidebar-message">Loading…</div>
        )}
        {!error && tree && tree.kind === "dir" && tree.children.length === 0 && (
          <div className="sidebar-message">No markdown files</div>
        )}
        {!error && tree && tree.kind === "dir" && tree.children.length > 0 && (
          <ul className="tree" role="tree">
            {tree.children.map((child) => (
              <TreeItem
                key={child.path}
                node={child}
                depth={0}
                currentPath={currentPath}
                collapsed={collapsed}
                onToggle={toggleCollapsed}
                onOpenFile={onOpenFile}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function SidebarHeader({
  name,
  menuOpen,
  setMenuOpen,
  onOpenFolder,
  onOpenFile,
  onRevealInFinder,
  onRefresh,
  onSwitchToSearch,
}: {
  name: string;
  menuOpen: boolean;
  setMenuOpen: (v: boolean) => void;
  onOpenFolder: () => void;
  onOpenFile: () => void;
  onRevealInFinder: () => void;
  onRefresh: () => void;
  onSwitchToSearch: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, setMenuOpen]);

  return (
    <div ref={wrapRef} className="sidebar-header">
      <button
        className="sidebar-header-button"
        onClick={() => setMenuOpen(!menuOpen)}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        title="Workspace menu"
      >
        <span className="sidebar-header-name">{name}</span>
        <ChevronDownIcon />
      </button>
      <button
        className="sidebar-header-refresh"
        onClick={onSwitchToSearch}
        title="Search in folder (⌘⇧F)"
        aria-label="Search in folder"
      >
        <SearchIcon />
      </button>
      <button
        className="sidebar-header-refresh"
        onClick={onRefresh}
        title="Refresh"
        aria-label="Refresh file list"
      >
        <RefreshIcon />
      </button>
      {menuOpen && (
        <div className="sidebar-menu" role="menu">
          <button
            role="menuitem"
            className="sidebar-menu-item"
            onClick={() => {
              setMenuOpen(false);
              onOpenFolder();
            }}
          >
            Open folder…
          </button>
          <button
            role="menuitem"
            className="sidebar-menu-item"
            onClick={() => {
              setMenuOpen(false);
              onOpenFile();
            }}
          >
            Open file…
          </button>
          <button
            role="menuitem"
            className="sidebar-menu-item"
            onClick={() => {
              setMenuOpen(false);
              onRevealInFinder();
            }}
          >
            Reveal in Finder
          </button>
        </div>
      )}
    </div>
  );
}

function TreeItem({
  node,
  depth,
  currentPath,
  collapsed,
  onToggle,
  onOpenFile,
}: {
  node: TreeNode;
  depth: number;
  currentPath: string | null;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  if (node.kind === "file") {
    const active = node.path === currentPath;
    return (
      <li role="treeitem" aria-selected={active}>
        <button
          className={`tree-row tree-file ${active ? "is-active" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => onOpenFile(node.path)}
          title={node.path}
        >
          <FileIcon />
          <span className="tree-label">{stripMdExt(node.name)}</span>
        </button>
      </li>
    );
  }

  const isCollapsed = collapsed.has(node.path);
  return (
    <li role="treeitem" aria-expanded={!isCollapsed}>
      <button
        className="tree-row tree-dir"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onToggle(node.path)}
        title={node.path}
      >
        <span className={`tree-chevron ${isCollapsed ? "is-collapsed" : ""}`}>
          <ChevronRightIcon />
        </span>
        <span className="tree-label tree-dir-label">{node.name}</span>
      </button>
      {!isCollapsed && (
        <ul role="group">
          {node.children.map((c) => (
            <TreeItem
              key={c.path}
              node={c}
              depth={depth + 1}
              currentPath={currentPath}
              collapsed={collapsed}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function stripMdExt(name: string): string {
  return name.replace(/\.(md|markdown|mdown|mkd)$/i, "");
}

/* ---------- Icons ---------- */

function ChevronDownIcon() {
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
      <polyline points="6 9 12 15 18 9" />
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

function FileIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}
