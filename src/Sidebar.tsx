import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type TreeNode =
  | { kind: "file"; name: string; path: string }
  | { kind: "dir"; name: string; path: string; children: TreeNode[] };

// The explorer's selection (VS Code-style): the row last clicked or
// right-clicked, file or folder. Owned by App — it doubles as the creation
// context for saving drafts (the save dialog defaults into the selected
// folder / next to the selected file).
export type SidebarSelection = { path: string; kind: "file" | "dir" };

// Where an in-progress "New File…" / "New Folder…" will land. The input row is
// rendered inline inside `parentDir`, like VS Code's explorer.
type PendingCreate = { parentDir: string; kind: "file" | "dir" };

// A context-menu invocation: where it was opened and what it targets. "root"
// is a right-click on empty sidebar space (creation lands at the workspace root).
type MenuState = { x: number; y: number; target: { path: string; kind: "file" | "dir" | "root" } };

type Props = {
  root: string;
  currentPath: string | null;
  selection: SidebarSelection | null;
  refreshToken: number;
  onSelect: (sel: SidebarSelection | null) => void;
  onOpenFile: (path: string) => void;
  onOpenFolder: () => void;
  onOpenFilePicker: () => void;
  onRevealInFinder: (path: string) => void;
  onDeleteFile: (path: string) => void;
  onSwitchToSearch: () => void;
};

const basename = (p: string) => p.split(/[\\/]/).pop() || p;
const dirname = (p: string) => {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : p;
};
const MD_EXT_RE = /\.(md|markdown|mdown|mkd)$/i;

export default function Sidebar({
  root,
  currentPath,
  selection,
  refreshToken,
  onSelect,
  onOpenFile,
  onOpenFolder,
  onOpenFilePicker,
  onRevealInFinder,
  onDeleteFile,
  onSwitchToSearch,
}: Props) {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<MenuState | null>(null);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);

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

  // Begin inline creation inside `parentDir`, expanding it (and any collapsed
  // ancestors) so the input row is actually visible.
  const startCreate = useCallback(
    (kind: "file" | "dir", parentDir: string) => {
      setCtxMenu(null);
      setMenuOpen(false);
      setCollapsed((prev) => {
        const next = new Set(prev);
        let p = parentDir;
        while (p.length >= root.length) {
          next.delete(p);
          if (p === root) break;
          p = dirname(p);
        }
        return next;
      });
      setPendingCreate({ parentDir, kind });
    },
    [root],
  );

  // Where "New File" / "New Folder" should land for a given target: inside a
  // folder, next to a file, at the root for empty-space actions.
  const createDirFor = useCallback(
    (target: { path: string; kind: "file" | "dir" | "root" } | null) => {
      if (!target || target.kind === "root") return root;
      return target.kind === "dir" ? target.path : dirname(target.path);
    },
    [root],
  );

  // Commit the pending inline creation. Returns an error message to show under
  // the input, or null on success (the row closes; new files open in a tab).
  const commitCreate = useCallback(
    async (rawName: string): Promise<string | null> => {
      const pc = pendingCreate;
      if (!pc) return null;
      const name = rawName.trim();
      if (!name) return "A name is required.";
      if (/[/\\:]/.test(name)) return "Names can't contain /, \\ or :";
      if (name.startsWith(".")) return "Names can't start with a dot.";
      const fileName = pc.kind === "file" && !MD_EXT_RE.test(name) ? `${name}.md` : name;
      const path = `${pc.parentDir}/${fileName}`;
      try {
        await invoke(pc.kind === "file" ? "create_file" : "create_dir", { path });
      } catch (e) {
        return String(e);
      }
      setPendingCreate(null);
      await refresh();
      onSelect({ path, kind: pc.kind });
      if (pc.kind === "file") onOpenFile(path);
      return null;
    },
    [pendingCreate, refresh, onSelect, onOpenFile],
  );

  const cancelCreate = useCallback(() => setPendingCreate(null), []);

  const openRowMenu = useCallback(
    (e: React.MouseEvent, target: { path: string; kind: "file" | "dir" }) => {
      e.preventDefault();
      e.stopPropagation();
      onSelect(target); // right-click selects, like VS Code
      setCtxMenu({ x: e.clientX, y: e.clientY, target });
    },
    [onSelect],
  );

  const rootName = useMemo(() => basename(root), [root]);
  const showCreateAtRoot = pendingCreate?.parentDir === root;

  const ctxItems: ContextMenuItem[] = useMemo(() => {
    if (!ctxMenu) return [];
    const { target } = ctxMenu;
    const items: ContextMenuItem[] = [
      { label: "New File…", onClick: () => startCreate("file", createDirFor(target)) },
      { label: "New Folder…", onClick: () => startCreate("dir", createDirFor(target)) },
      {
        label: "Reveal in Finder",
        onClick: () => onRevealInFinder(target.kind === "root" ? root : target.path),
      },
    ];
    if (target.kind === "file") {
      items.push({
        label: "Delete",
        danger: true,
        onClick: () => onDeleteFile(target.path),
      });
    }
    return items;
  }, [ctxMenu, startCreate, createDirFor, onRevealInFinder, onDeleteFile, root]);

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
        onNewFile={() => startCreate("file", createDirFor(selection))}
        onNewFolder={() => startCreate("dir", createDirFor(selection))}
      />
      <div
        className="sidebar-body"
        onClick={(e) => {
          // Clicking empty space clears the selection (root becomes the
          // creation context again).
          if (e.target === e.currentTarget) onSelect(null);
        }}
        onContextMenu={(e) => {
          // Right-click on empty space targets the workspace root. Row-level
          // handlers stopPropagation, so reaching here means no row was hit.
          e.preventDefault();
          onSelect(null);
          setCtxMenu({ x: e.clientX, y: e.clientY, target: { path: root, kind: "root" } });
        }}
      >
        {error && <div className="sidebar-message sidebar-message-error">{error}</div>}
        {!error && loading && !tree && (
          <div className="sidebar-message">Loading…</div>
        )}
        {!error && tree && tree.kind === "dir" && tree.children.length === 0 && !showCreateAtRoot && (
          <div className="sidebar-message">No markdown files</div>
        )}
        {!error && tree && tree.kind === "dir" && (tree.children.length > 0 || showCreateAtRoot) && (
          <ul className="tree" role="tree">
            {showCreateAtRoot && pendingCreate && (
              <CreateRow
                depth={0}
                kind={pendingCreate.kind}
                onCommit={commitCreate}
                onCancel={cancelCreate}
              />
            )}
            {tree.children.map((child) => (
              <TreeItem
                key={child.path}
                node={child}
                depth={0}
                currentPath={currentPath}
                selection={selection}
                collapsed={collapsed}
                pendingCreate={pendingCreate}
                onToggle={toggleCollapsed}
                onOpenFile={onOpenFile}
                onSelect={onSelect}
                onRowMenu={openRowMenu}
                onCommitCreate={commitCreate}
                onCancelCreate={cancelCreate}
              />
            ))}
          </ul>
        )}
      </div>
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxItems}
          onClose={() => setCtxMenu(null)}
        />
      )}
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
  onNewFile,
  onNewFolder,
}: {
  name: string;
  menuOpen: boolean;
  setMenuOpen: (v: boolean) => void;
  onOpenFolder: () => void;
  onOpenFile: () => void;
  onRevealInFinder: () => void;
  onRefresh: () => void;
  onSwitchToSearch: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
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
        onClick={onNewFile}
        title="New file"
        aria-label="New file"
      >
        <NewFileIcon />
      </button>
      <button
        className="sidebar-header-refresh"
        onClick={onNewFolder}
        title="New folder"
        aria-label="New folder"
      >
        <NewFolderIcon />
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
  selection,
  collapsed,
  pendingCreate,
  onToggle,
  onOpenFile,
  onSelect,
  onRowMenu,
  onCommitCreate,
  onCancelCreate,
}: {
  node: TreeNode;
  depth: number;
  currentPath: string | null;
  selection: SidebarSelection | null;
  collapsed: Set<string>;
  pendingCreate: PendingCreate | null;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
  onSelect: (sel: SidebarSelection) => void;
  onRowMenu: (e: React.MouseEvent, target: { path: string; kind: "file" | "dir" }) => void;
  onCommitCreate: (name: string) => Promise<string | null>;
  onCancelCreate: () => void;
}) {
  const isSelected = selection?.path === node.path;

  if (node.kind === "file") {
    const active = node.path === currentPath;
    return (
      <li role="treeitem" aria-selected={active || isSelected}>
        <button
          className={`tree-row tree-file ${active ? "is-active" : ""} ${isSelected ? "is-selected" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => {
            onSelect({ path: node.path, kind: "file" });
            onOpenFile(node.path);
          }}
          onContextMenu={(e) => onRowMenu(e, { path: node.path, kind: "file" })}
          title={node.path}
        >
          <FileIcon />
          <span className="tree-label">{stripMdExt(node.name)}</span>
        </button>
      </li>
    );
  }

  const isCollapsed = collapsed.has(node.path);
  const creatingHere = pendingCreate?.parentDir === node.path;
  return (
    <li role="treeitem" aria-expanded={!isCollapsed} aria-selected={isSelected}>
      <button
        className={`tree-row tree-dir ${isSelected ? "is-selected" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => {
          onSelect({ path: node.path, kind: "dir" });
          onToggle(node.path);
        }}
        onContextMenu={(e) => onRowMenu(e, { path: node.path, kind: "dir" })}
        title={node.path}
      >
        <span className={`tree-chevron ${isCollapsed ? "is-collapsed" : ""}`}>
          <ChevronRightIcon />
        </span>
        <span className="tree-label tree-dir-label">{node.name}</span>
      </button>
      {!isCollapsed && (
        <ul role="group">
          {creatingHere && pendingCreate && (
            <CreateRow
              depth={depth + 1}
              kind={pendingCreate.kind}
              onCommit={onCommitCreate}
              onCancel={onCancelCreate}
            />
          )}
          {node.children.map((c) => (
            <TreeItem
              key={c.path}
              node={c}
              depth={depth + 1}
              currentPath={currentPath}
              selection={selection}
              collapsed={collapsed}
              pendingCreate={pendingCreate}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
              onSelect={onSelect}
              onRowMenu={onRowMenu}
              onCommitCreate={onCommitCreate}
              onCancelCreate={onCancelCreate}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// The inline name input for New File / New Folder, rendered in place inside
// the target directory (VS Code-style). Enter commits — a validation or
// backend error keeps the row open with the message under it; Esc cancels;
// clicking away commits a valid name and otherwise abandons the row.
function CreateRow({
  depth,
  kind,
  onCommit,
  onCancel,
}: {
  depth: number;
  kind: "file" | "dir";
  onCommit: (name: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards double-submit: Enter triggers commit AND blurs focus-follow-ups.
  const doneRef = useRef(false);

  const submit = useCallback(
    async (viaBlur: boolean) => {
      if (doneRef.current) return;
      if (!value.trim()) {
        if (viaBlur) {
          doneRef.current = true;
          onCancel();
        }
        return;
      }
      doneRef.current = true;
      const err = await onCommit(value);
      if (err) {
        doneRef.current = false;
        if (viaBlur) {
          onCancel(); // click-away abandons an invalid name instead of fighting focus
        } else {
          setError(err);
          inputRef.current?.focus();
        }
      }
    },
    [value, onCommit, onCancel],
  );

  return (
    <li role="treeitem" className="tree-create">
      <div className="tree-create-row" style={{ paddingLeft: 8 + depth * 14 }}>
        {kind === "dir" ? <NewFolderIcon /> : <FileIcon />}
        <input
          ref={inputRef}
          className="tree-create-input"
          type="text"
          value={value}
          placeholder={kind === "dir" ? "Folder name" : "File name"}
          autoFocus
          spellCheck={false}
          aria-label={kind === "dir" ? "New folder name" : "New file name"}
          aria-invalid={error != null}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit(false);
            } else if (e.key === "Escape") {
              e.preventDefault();
              doneRef.current = true;
              onCancel();
            }
            e.stopPropagation(); // keep app-level shortcuts (⌘N, ⌘⌫…) out of the input
          }}
          onBlur={() => void submit(true)}
        />
      </div>
      {error && (
        <div className="tree-create-error" style={{ marginLeft: 8 + depth * 14 }} role="alert">
          {error}
        </div>
      )}
    </li>
  );
}

type ContextMenuItem = { label: string; danger?: boolean; onClick: () => void };

// A fixed-position right-click menu. Reuses the sidebar dropdown's visual
// language; closes on outside click, Esc, or after running an item.
function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Keep the menu on-screen when invoked near the bottom/right edges.
  const estHeight = items.length * 30 + 12;
  const left = Math.min(x, window.innerWidth - 190);
  const top = Math.min(y, window.innerHeight - estHeight - 8);

  return (
    <div ref={menuRef} className="tree-context-menu" role="menu" style={{ left, top }}>
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          className={`sidebar-menu-item ${item.danger ? "is-danger" : ""}`}
          onClick={() => {
            onClose();
            item.onClick();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function stripMdExt(name: string): string {
  return name.replace(MD_EXT_RE, "");
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

function NewFileIcon() {
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
      <line x1="12" y1="12" x2="12" y2="18" />
      <line x1="9" y1="15" x2="15" y2="15" />
    </svg>
  );
}

function NewFolderIcon() {
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
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <line x1="12" y1="10" x2="12" y2="16" />
      <line x1="9" y1="13" x2="15" y2="13" />
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
