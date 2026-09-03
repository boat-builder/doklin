// A document's version history, as a right rail (docs/versioning-plan.md
// §5.4, §12.3). Google Docs' shape, for Google Docs' reason: the list is
// the retention ladder made visible — every version for today and
// yesterday, one row per day further back — and the document itself never
// leaves the screen. Selecting a row previews it in place; VersionPreview
// is the other half.
//
// The rail reads and never writes, with one exception: *Name this version*,
// which pins a moment so the ladder can never thin it away.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  versionsCaptureNow,
  versionsHistory,
  versionReasonWord,
  type FileHistory,
  type FileVersion,
} from "./versions";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** "Today" / "Yesterday" / "Tue 2 Sep" / "2 Sep 2025" — the heading a group
 *  of versions sits under. */
export function dayLabel(ms: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: sameYear ? "short" : undefined,
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
  });
}

const timeLabel = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** The date a trust line names: "Every change since 3 Jun". */
export const sinceLabel = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** Newest first, grouped into days. Today and yesterday are open: that is
 *  where a reader is looking for "the one from just before lunch". */
export function groupByDay(versions: FileVersion[], now = Date.now()) {
  const groups: { day: number; label: string; versions: FileVersion[] }[] = [];
  for (const version of versions) {
    const day = startOfDay(version.ts);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.versions.push(version);
    else groups.push({ day, label: dayLabel(version.ts, now), versions: [version] });
  }
  return groups;
}

const isRecent = (day: number, now = Date.now()) => startOfDay(now) - day <= DAY_MS;

function PinIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M14 3l7 7-3 1-3.5 3.5L14 21l-4.5-4.5L4 21l4.5-5.5L4 11l6.5-.5L14 7l-1-4z" />
    </svg>
  );
}

export default function HistoryRail({
  docPath,
  selected,
  onSelect,
  onClose,
  reloadToken,
  onError,
}: {
  /** The document whose versions these are — absolute. */
  docPath: string;
  /** The version being previewed, by timestamp; null while the live
   *  document is showing. */
  selected: number | null;
  /** A row was clicked. The store's root rides along (every other version
   *  command is keyed by it), and so does the version one step newer, which
   *  is what *Show changes* compares against. */
  onSelect: (version: FileVersion, root: string, newer: FileVersion | null) => void;
  onClose: () => void;
  /** Bumped by the app after a restore, so the rail shows the new rows. */
  reloadToken: number;
  onError?: (message: string) => void;
}) {
  const [history, setHistory] = useState<FileHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [naming, setNaming] = useState("");
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await versionsHistory(docPath);
      setHistory(next);
      setError(null);
    } catch (e) {
      setHistory(null);
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [docPath]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load, reloadToken]);

  const versions = useMemo(() => history?.versions ?? [], [history]);
  const groups = useMemo(() => groupByDay(versions), [versions]);
  const counts = useMemo(
    () => ({
      here: versions.filter((v) => v.source === "local").length,
      cloud: versions.filter((v) => v.source === "cloud").length,
    }),
    [versions],
  );
  const oldest = versions.length ? versions[versions.length - 1].ts : null;
  // The row above each one, by timestamp — the other side of its diff.
  const newerOf = useMemo(
    () => new Map(versions.map((v, i) => [v.ts, i > 0 ? versions[i - 1] : null])),
    [versions],
  );

  const nameThisVersion = useCallback(async () => {
    const label = naming.trim();
    if (!label || !history?.root || saving) return;
    setSaving(true);
    try {
      await versionsCaptureNow(history.root, { reason: "manual", label });
      setNaming("");
      await load();
    } catch (e) {
      onError?.(errText(e));
    } finally {
      setSaving(false);
    }
  }, [naming, history, saving, load, onError]);

  return (
    <aside className="history-rail" aria-label="Version history" data-testid="history-rail">
      <div className="history-rail-head">
        <div className="history-rail-title">Version history</div>
        <button className="history-rail-close" onClick={onClose} aria-label="Close version history">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
            <line x1="5" y1="5" x2="19" y2="19" />
            <line x1="19" y1="5" x2="5" y2="19" />
          </svg>
        </button>
      </div>

      {/* The trust line (§12.3.7): the promise is a sentence the user can
          read, not a feature they have to find. */}
      <div className="history-rail-trust" data-testid="history-trust">
        {oldest != null ? `Every change since ${sinceLabel(oldest)}` : "No versions yet"}
        {counts.cloud > 0 && (
          <span className="history-rail-where">
            {" · "}
            {counts.here} here · {counts.cloud} in the cloud
          </span>
        )}
      </div>

      <div className="history-rail-name">
        <input
          ref={nameRef}
          className="history-rail-name-input"
          placeholder="Name this version"
          aria-label="Name this version"
          data-testid="name-version-input"
          value={naming}
          disabled={!history?.root || saving}
          onChange={(e) => setNaming(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void nameThisVersion();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setNaming("");
              nameRef.current?.blur();
            }
          }}
        />
      </div>

      <div className="history-rail-list">
        {loading && <div className="history-rail-hint">Reading this folder's history…</div>}
        {error && (
          <div className="history-rail-hint history-rail-error" data-testid="history-error">
            {error}
          </div>
        )}
        {!loading && !error && versions.length === 0 && (
          <div className="history-rail-hint" data-testid="history-empty">
            No versions of this document yet. One is kept a couple of minutes after you stop typing.
          </div>
        )}
        {groups.map((group) => {
          const open = isRecent(group.day) || expanded.has(group.day);
          return (
            <div className="history-day" key={group.day}>
              <button
                className={`history-day-head ${open ? "is-open" : ""}`}
                data-testid="history-day"
                aria-expanded={open}
                onClick={() =>
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(group.day)) next.delete(group.day);
                    else next.add(group.day);
                    return next;
                  })
                }
              >
                <span className="history-day-label">{group.label}</span>
                <span className="history-day-count">{group.versions.length}</span>
              </button>
              {open && (
                <ul className="history-versions">
                  {group.versions.map((version) => (
                    <li key={`${version.ts}-${version.hash}`}>
                      <button
                        className={`history-version ${selected === version.ts ? "is-active" : ""} ${
                          version.current ? "is-current" : ""
                        }`}
                        data-testid="history-version"
                        data-ts={version.ts}
                        data-source={version.source}
                        aria-current={selected === version.ts}
                        onClick={() =>
                          history && onSelect(version, history.root, newerOf.get(version.ts) ?? null)
                        }
                      >
                        <span className="history-version-line">
                          <span className="history-version-time">{timeLabel(version.ts)}</span>
                          {version.pinned && (
                            <span className="history-version-pin" title="Named — never thinned">
                              <PinIcon />
                            </span>
                          )}
                          {version.current && <span className="history-version-now">current</span>}
                        </span>
                        {version.label && (
                          <span className="history-version-label" data-testid="history-version-label">
                            {version.label}
                          </span>
                        )}
                        <span className="history-version-meta">
                          {[version.by, versionReasonWord(version)].filter(Boolean).join(" · ")}
                        </span>
                        {version.restoredFrom != null && (
                          <span className="history-version-meta" data-testid="history-restored-from">
                            restored from {dayLabel(version.restoredFrom)} {timeLabel(version.restoredFrom)}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
