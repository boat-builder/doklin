// One old version of the open document, shown where the document is
// (docs/versioning-plan.md §5.4, §12.3.1). The live editor stays mounted
// and hidden behind this; what renders here is the same editor in read-only
// mode, so an old version reads exactly like the document it is a version
// of — and, crucially, has no write path at all. Nothing typed here can be
// autosaved over the newer text, because nothing can be typed.
//
// The three exits are on the banner: restore it, copy it out beside the
// original, or go back to now.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Editor from "./Editor";
import { cloudRevision } from "./cloud";
import { versionsDiff, versionsRead, type FileVersion } from "./versions";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** "Tue 2 Sep, 14:32" — the moment the banner names. */
export function momentLabel(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  })}, ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

/** What a copy is called: the conflict copies' naming from merge.rs — a dot
 *  in the time, because a colon is not a filename on every disk. */
export function copyName(path: string, ms: number, n = 1): string {
  const dot = path.lastIndexOf(".");
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const hasExt = dot > slash + 1;
  const stem = hasExt ? path.slice(0, dot) : path;
  const ext = hasExt ? path.slice(dot) : "";
  const d = new Date(ms);
  const day = d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const time = `${String(d.getHours()).padStart(2, "0")}.${String(d.getMinutes()).padStart(2, "0")}`;
  const suffix = n > 1 ? `version ${day} ${time} ${n}` : `version ${day} ${time}`;
  return `${stem} (${suffix})${ext}`;
}

const basename = (p: string) => p.split(/[\\/]/).pop() || p;

/** A unified patch, line by line, so additions and removals can be read at
 *  a glance. The rendered block-level diff inside the editor is §12.3.2's
 *  refinement; this is the correct, cheap first cut for a markdown tool. */
function DiffView({ patch }: { patch: string }) {
  const lines = patch.split("\n");
  return (
    <pre className="version-diff" data-testid="version-diff">
      {lines.map((line, i) => {
        const kind = line.startsWith("+++") || line.startsWith("---")
          ? "is-file"
          : line.startsWith("@@")
            ? "is-hunk"
            : line.startsWith("+")
              ? "is-add"
              : line.startsWith("-")
                ? "is-del"
                : "";
        return (
          <div className={`version-diff-line ${kind}`} key={i}>
            {line === "" ? " " : line}
          </div>
        );
      })}
    </pre>
  );
}

export default function VersionPreview({
  docPath,
  root,
  version,
  newer,
  onBack,
  onRestore,
  onOpenFile,
  onError,
}: {
  docPath: string;
  /** The store this version lives in — every version command is keyed by it. */
  root: string;
  version: FileVersion;
  /** The version one step newer, which *Show changes* compares against;
   *  null for the newest, which is compared against the file on disk. */
  newer: FileVersion | null;
  onBack: () => void;
  /** The app owns the restore: it is one Rust command, never a capture and
   *  a write from here. The loaded text rides along for a version this Mac's
   *  own store doesn't hold. */
  onRestore: (version: FileVersion, text: string | null) => void;
  onOpenFile: (path: string) => void;
  onError: (message: string) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [showChanges, setShowChanges] = useState(false);
  const [patch, setPatch] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);

  // A sync-manifest revision is named by a 16-character hash the version
  // store can't resolve, so it can be read and restored but not compared.
  // A mirrored version is fetched like a local one and compares fine.
  const comparable = version.source !== "manifest" && (newer == null || newer.source !== "manifest");

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setFailed(null);
    void (async () => {
      try {
        const loaded =
          version.source === "manifest"
            ? await cloudRevision(docPath, version.hash)
            : await versionsRead(root, version.hash);
        if (!cancelled) setText(loaded);
      } catch (e) {
        if (!cancelled) setFailed(errText(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docPath, root, version]);

  useEffect(() => {
    if (!showChanges || !comparable) return;
    let cancelled = false;
    setPatch(null);
    void (async () => {
      try {
        const p = await versionsDiff(root, {
          path: docPath,
          from: version.hash,
          to: newer?.hash ?? null,
        });
        if (!cancelled) setPatch(p);
      } catch (e) {
        if (!cancelled) setPatch(`⚠ ${errText(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showChanges, comparable, root, docPath, version, newer]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onBack();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onBack]);

  const makeCopy = useCallback(async () => {
    if (text == null || copying) return;
    setCopying(true);
    try {
      let target = copyName(docPath, version.ts);
      for (let n = 2; n < 50; n += 1) {
        if (!(await invoke<boolean>("path_exists", { path: target }))) break;
        target = copyName(docPath, version.ts, n);
      }
      await invoke("write_file", { path: target, contents: text, expected: null });
      onOpenFile(target);
    } catch (e) {
      onError(`Couldn't make a copy: ${errText(e)}`);
    } finally {
      setCopying(false);
    }
  }, [text, copying, docPath, version.ts, onOpenFile, onError]);

  return (
    <div className="version-preview" data-testid="version-preview">
      <div className="version-banner" data-testid="version-banner">
        <span className="version-banner-text">
          Viewing the version from <strong>{momentLabel(version.ts)}</strong>
          {version.path !== basename(docPath) && version.path.split("/").pop() !== basename(docPath) && (
            <span className="version-banner-was"> · then called {version.path}</span>
          )}
        </span>
        <span className="version-banner-actions">
          <button
            className="version-banner-btn is-primary"
            data-testid="restore-version"
            disabled={text == null}
            onClick={() => onRestore(version, version.source === "local" ? null : text)}
          >
            Restore this version
          </button>
          <button
            className="version-banner-btn"
            data-testid="copy-version"
            disabled={text == null || copying}
            onClick={() => void makeCopy()}
          >
            {copying ? "Copying…" : "Make a copy"}
          </button>
          {comparable && (
            <button
              className={`version-banner-btn ${showChanges ? "is-on" : ""}`}
              data-testid="show-changes"
              aria-pressed={showChanges}
              onClick={() => setShowChanges((v) => !v)}
            >
              Show changes
            </button>
          )}
          <button className="version-banner-btn" data-testid="back-to-now" onClick={onBack}>
            Back to now
          </button>
        </span>
      </div>

      <div className="version-preview-body">
        {failed && <div className="version-preview-hint">{failed}</div>}
        {!failed && text == null && <div className="version-preview-hint">Opening that version…</div>}
        {!failed && text != null && showChanges && comparable && (
          patch == null ? <div className="version-preview-hint">Comparing…</div> : <DiffView patch={patch} />
        )}
        {!failed && text != null && !(showChanges && comparable) && (
          // The same editor the user writes in, with writing off: an old
          // version reads exactly like the document it is a version of.
          <Editor
            key={`${version.ts}-${version.hash}`}
            initialMarkdown={text}
            onChange={() => {}}
            readOnly
            commentsVisible={false}
          />
        )}
      </div>
    </div>
  );
}
