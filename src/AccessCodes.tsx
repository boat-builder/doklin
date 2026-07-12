// Access-codes editor for one share — the panel behind "Restrict access" in
// the share popover and the folder-share dialog. The backend is the source of
// truth (codes are fetched on mount and every change round-trips), this Mac's
// plaintext cache fills in the actual code strings for the ones created here.
// A code created on another Mac shows label-only: still revocable, never
// readable — the worker stores hashes, nothing can echo a code back.
//
// The flow is built around handing access to ONE person/group at a time: each
// code gets a label ("Acme", "Priya"), and each row copies either the bare
// code or a self-unlocking link (code in the #fragment — never in server
// logs). Revoking a row locks out exactly the visitors who used that code.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  addPageAccessCode,
  cachedAccessCode,
  clearPageAccess,
  fetchPageAccess,
  forgetAccessCodes,
  generateAccessCode,
  normalizeAccessCode,
  rememberAccessCode,
  removePageAccessCode,
  ShareWorkerOutdatedError,
  unlockShareUrl,
  type PageAccessCode,
  type ShareConnection,
} from "./share";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; codes: PageAccessCode[] }
  | { kind: "outdated" }
  | { kind: "error"; message: string };

export default function AccessCodes({
  connection,
  pageId,
  scope,
  onChanged,
  onOpenWorkerUpdate,
}: {
  connection: ShareConnection;
  pageId: string;
  // Adjusts the copy: a folder's codes cover its whole table of contents.
  scope: "page" | "folder";
  // Fired with the share's protected state after every successful change (and
  // the initial load), so the caller can keep its registry badge honest.
  onChanged: (isProtected: boolean) => void;
  // Routes the pre-v7-worker notice to the guided update dialog when App has
  // one to offer; null shows the notice without a button.
  onOpenWorkerUpdate: (() => void) | null;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [labelInput, setLabelInput] = useState("");
  const [codeInput, setCodeInput] = useState(() => generateAccessCode());
  const [busy, setBusy] = useState<"add" | "clear" | string | null>(null); // string = code id being revoked
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [copied, setCopied] = useState<string | null>(null); // "<codeId>:code" | "<codeId>:link"
  const [error, setError] = useState<string | null>(null);
  const labelRef = useRef<HTMLInputElement>(null);

  const setCodes = useCallback(
    (codes: PageAccessCode[]) => {
      setState({ kind: "ready", codes });
      onChanged(codes.length > 0);
    },
    [onChanged],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const access = await fetchPageAccess(connection, pageId);
        if (cancelled) return;
        setState({ kind: "ready", codes: access.codes });
        onChanged(access.protected);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ShareWorkerOutdatedError) setState({ kind: "outdated" });
        else setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
    // Load once per share; changes flow through the handlers below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id, pageId]);

  const add = useCallback(async () => {
    if (busy || state.kind !== "ready") return;
    const code = normalizeAccessCode(codeInput);
    if (code.length < 4) {
      setError("Codes need at least 4 characters.");
      return;
    }
    setBusy("add");
    setError(null);
    try {
      const label = labelInput.trim() || `Code ${state.codes.length + 1}`;
      const added = await addPageAccessCode(connection, pageId, label, code);
      rememberAccessCode(connection.id, pageId, added.id, code);
      setCodes([...state.codes, added]);
      setLabelInput("");
      setCodeInput(generateAccessCode());
      labelRef.current?.focus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [busy, state, codeInput, labelInput, connection, pageId, setCodes]);

  const revoke = useCallback(
    async (codeId: string) => {
      if (busy || state.kind !== "ready") return;
      setBusy(codeId);
      setError(null);
      try {
        await removePageAccessCode(connection, pageId, codeId);
        forgetAccessCodes(connection.id, pageId, codeId);
        setCodes(state.codes.filter((c) => c.id !== codeId));
        setConfirmRevoke(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [busy, state, connection, pageId, setCodes],
  );

  const clearAll = useCallback(async () => {
    if (busy || state.kind !== "ready") return;
    setBusy("clear");
    setError(null);
    try {
      await clearPageAccess(connection, pageId);
      forgetAccessCodes(connection.id, pageId);
      setCodes([]);
      setConfirmClear(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [busy, state, connection, pageId, setCodes]);

  const copy = useCallback(async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1600);
    } catch (e) {
      console.error("copy failed", e);
    }
  }, []);

  if (state.kind === "loading") {
    return <div className="share-access-status">Checking access…</div>;
  }
  if (state.kind === "outdated") {
    return (
      <div className="share-access-status">
        <p className="share-note">
          Access codes need a newer backend worker — a quick redeploy unlocks
          them, and your pages keep working meanwhile.
        </p>
        {onOpenWorkerUpdate && (
          <button className="share-btn is-primary" onClick={onOpenWorkerUpdate}>
            Update backend…
          </button>
        )}
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="share-access-status">
        <div className="share-error">{state.message}</div>
      </div>
    );
  }

  const codes = state.codes;
  const target = scope === "folder" ? "this folder and every page on it" : "this page";

  return (
    <div className="share-access">
      <div className="share-note">
        {codes.length === 0 ? (
          <>
            Anyone with the link can open {target}. Add an access code to put
            it behind a door — one code per person or group, so you can revoke
            one without resetting the rest.
          </>
        ) : (
          <>
            Visitors unlock {target} with any code below — once per browser,
            good for 30 days. Revoking a code locks out exactly the people
            using it.
          </>
        )}
      </div>

      {codes.length > 0 && (
        <ul className="share-access-list">
          {codes.map((c) => {
            const plain = cachedAccessCode(connection.id, pageId, c.id);
            return (
              <li key={c.id} className="share-access-row">
                <div className="share-access-row-head">
                  <span className="share-access-label" title={c.label}>
                    {c.label || "Access code"}
                  </span>
                  {confirmRevoke === c.id ? (
                    <span className="share-access-actions">
                      <span className="share-access-hint">Locks out its users.</span>
                      <button
                        className="share-btn is-danger"
                        onClick={() => void revoke(c.id)}
                        disabled={busy != null}
                      >
                        {busy === c.id ? "Revoking…" : "Revoke"}
                      </button>
                      <button className="share-btn" onClick={() => setConfirmRevoke(null)}>
                        Keep
                      </button>
                    </span>
                  ) : (
                    <button
                      className="share-access-remove"
                      onClick={() => setConfirmRevoke(c.id)}
                      title={`Revoke “${c.label}”`}
                      aria-label={`Revoke ${c.label}`}
                    >
                      <XIcon />
                    </button>
                  )}
                </div>
                {confirmRevoke !== c.id && (
                  <div className="share-access-row-code">
                    {plain ? (
                      <>
                        <code className="share-access-code" title={plain}>
                          {plain}
                        </code>
                        <button
                          className="share-access-copy"
                          onClick={() => void copy(`${c.id}:code`, plain)}
                          title="Copy the code"
                        >
                          {copied === `${c.id}:code` ? "Copied" : "Copy"}
                        </button>
                        <button
                          className="share-access-copy"
                          onClick={() =>
                            void copy(`${c.id}:link`, unlockShareUrl(connection, pageId, plain))
                          }
                          title="Copy a link with the code inside — it unlocks by itself"
                        >
                          {copied === `${c.id}:link` ? "Copied" : "Link + code"}
                        </button>
                      </>
                    ) : (
                      <span className="share-access-elsewhere">
                        created on another Mac — revocable here, readable there
                      </span>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="share-access-add">
        <input
          ref={labelRef}
          className="share-field-input"
          value={labelInput}
          onChange={(e) => setLabelInput(e.target.value)}
          placeholder={codes.length === 0 ? "Label — who's it for?" : "Label for another code"}
          maxLength={80}
          spellCheck={false}
          aria-label="Code label"
        />
        <div className="share-access-add-code">
          <input
            className="share-field-input share-access-code-input"
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
            }}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="Access code"
          />
          <button
            className="share-regen"
            onClick={() => setCodeInput(generateAccessCode())}
            title="Generate a new code"
            aria-label="Generate a new code"
          >
            <RefreshIcon />
          </button>
          <button
            className="share-btn is-primary"
            onClick={() => void add()}
            disabled={busy != null}
          >
            {busy === "add" ? "Adding…" : codes.length === 0 ? "Require code" : "Add"}
          </button>
        </div>
      </div>

      {codes.length > 0 && (
        <div className="share-access-clear">
          {confirmClear ? (
            <>
              <span className="share-access-hint">
                Everyone gets in with just the link again.
              </span>
              <button
                className="share-btn is-danger"
                onClick={() => void clearAll()}
                disabled={busy != null}
              >
                {busy === "clear" ? "Removing…" : "Remove"}
              </button>
              <button className="share-btn" onClick={() => setConfirmClear(false)}>
                Keep
              </button>
            </>
          ) : (
            <button className="share-all-link" onClick={() => setConfirmClear(true)}>
              Remove protection…
            </button>
          )}
        </div>
      )}

      {error && <div className="share-error">{error}</div>}
    </div>
  );
}

function XIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
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
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <polyline points="21 3 21 9 15 9" />
    </svg>
  );
}
