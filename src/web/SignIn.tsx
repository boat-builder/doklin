// The browser version's sign-in: the line somebody was sent — an invite, or
// the code for another device of one's own that *Add a device* shows — traded
// for this browser's sign-in (`POST /api/web/session`, cloud-worker/src/web.ts).
// What comes back is a cookie this script never sees; the code is spent.

import { useCallback, useState } from "react";
import { normalizeCode } from "../../cloud-worker/src/layout";
import { Unreachable, deviceId, deviceName, refused, send } from "./http";

/** The word an invite line starts with (`KEYWORD`, engine/src/cloud/invite.rs). */
const KEYWORD = "doklin-invite";

/** The two halves of an invite found in a paste: the line itself, a whole
 *  message carrying it, or the code alone. Punctuation decides which half a
 *  word is, as the engine reads one (`parse_pasted`, invite.rs — change
 *  both): a word carrying `.`, `/` or `:` is an address and never a code. */
export function parsePasted(text: string): { host: string | null; code: string | null } {
  let host: string | null = null;
  let code: string | null = null;
  for (const raw of text.split(/\s+/)) {
    const word = raw.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "");
    if (!word || word.toLowerCase() === KEYWORD) continue;
    if (/[./:]/.test(word)) {
      if (host === null) {
        try {
          host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(word) ? word : `https://${word}`).host || null;
        } catch {
          // not an address after all
        }
      }
    } else {
      code ??= normalizeCode(word);
    }
  }
  return { host, code };
}

export default function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = useCallback(async () => {
    const { host, code } = parsePasted(text);
    if (host && host !== location.host) {
      setError(`That invite is for ${host}. Open https://${host}/app and paste it there.`);
      return;
    }
    if (!code) {
      setError("There is no invite code in that. Paste the whole line you were sent.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await send("POST", "/api/web/session", {
        body: { code, deviceId: deviceId(), deviceName: deviceName() },
      });
      if (res.ok) {
        onSignedIn();
        return;
      }
      setError(
        res.status === 401
          ? "That code isn't valid. A code works once and for a limited time: ask for a new one."
          : (await refused(res)).message,
      );
    } catch (e) {
      setError(e instanceof Unreachable ? `${location.host} isn't answering. Check your connection and try again.` : String(e));
    }
    setBusy(false);
  }, [text, onSignedIn]);

  return (
    <main className="web-screen">
      <form
        className="web-card"
        onSubmit={(e) => {
          e.preventDefault();
          void signIn();
        }}
      >
        <h1 className="web-title">Sign in to {location.host}</h1>
        <p className="web-text">
          Paste the invite you were sent. Already in this workspace on another device? In Doklin there, open Devices
          and choose Add a device, then paste the line it shows.
        </p>
        <div className="modal-field">
          <label className="modal-field-label" htmlFor="web-invite">
            Invite
          </label>
          <textarea
            id="web-invite"
            className="modal-field-input web-invite"
            data-testid="web-invite"
            rows={2}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            placeholder="doklin-invite https://… dkln-…"
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void signIn();
              }
            }}
          />
        </div>
        {error && (
          <div className="modal-error" data-testid="web-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-buttons">
          <button className="modal-btn is-primary" type="submit" data-testid="web-sign-in" disabled={busy || !text.trim()}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </div>
      </form>
    </main>
  );
}
