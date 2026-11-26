// The browser version, from a signed-out page to the app: is this browser
// signed in (`GET /api/meta` says who it is, or 401), the sign-in screen when
// it is not, then the workspace read whole, the backend installed over it,
// and the same `App` the Mac runs. A link in the address stays there through
// the sign-in, and is taken by the app once it is up (address.ts).

import React from "react";
import ReactDOM from "react-dom/client";
import type { MetaAnswer } from "../../cloud-worker/src/wire";
import "../App.css";
import "./web.css";
import { installBackend } from "../backend";
import { applyTheme, readStoredTheme } from "../theme";
import { webBackend } from "./backend";
import { Unreachable, onOutdated, onSignedOut, refused, send } from "./http";
import { Saving } from "./saving";
import SignIn from "./SignIn";
import { Workspace } from "./workspace";

applyTheme(readStoredTheme());

const rootElement = document.getElementById("root") as HTMLElement;
const root = ReactDOM.createRoot(rootElement);

/** How the page reloads: once the app is up, keeping what waits (`Saving.reload`). */
let reload = (): void => location.reload();
let updated = false;

/** The domain was updated while this page was open: the worker refused a
 *  request as being of another release (http.ts), or a file the page asked
 *  for went with the release it came from. Everything beneath is inert, and
 *  one button reloads into the page the domain serves now. */
function Updated() {
  return (
    <div className="update-required" role="alertdialog" aria-modal="true" aria-labelledby="web-updated-title" data-testid="web-updated">
      <div className="update-required-card">
        <h1 id="web-updated-title" className="update-required-title">
          Doklin was updated
        </h1>
        <p className="update-required-text">
          Doklin on {location.host} was updated while this page was open. Reload it to keep going: what you typed is
          kept.
        </p>
        <button autoFocus className="modal-btn is-primary update-required-button" onClick={() => reload()}>
          Reload
        </button>
      </div>
    </div>
  );
}

function showUpdated(): void {
  if (updated) return;
  updated = true;
  rootElement.inert = true;
  ReactDOM.createRoot(document.body.appendChild(document.createElement("div"))).render(<Updated />);
}
onOutdated(showUpdated);
addEventListener("vite:preloadError", showUpdated);
// The app's shortcuts are the window's, so `inert` does not reach them:
// listening before the app does, this stops a key before any of them hears
// it. What the browser does with the key (Tab, Enter on the button) stays.
addEventListener(
  "keydown",
  (e) => {
    if (updated) e.stopImmediatePropagation();
  },
  true,
);

function Waiting() {
  return (
    <main className="web-screen" data-testid="web-waiting">
      <p className="web-text">Opening {location.host}…</p>
    </main>
  );
}

function Stopped({ sentence }: { sentence: string }) {
  return (
    <main className="web-screen">
      <div className="web-card">
        <h1 className="web-title">{location.host} didn’t open</h1>
        <p className="web-text" data-testid="web-stopped">
          {sentence}
        </p>
        <div className="modal-buttons">
          <button className="modal-btn is-primary" onClick={() => void start()}>
            Try again
          </button>
        </div>
      </div>
    </main>
  );
}

/** Who this browser is signed in as, or null when it is not signed in. */
async function whoAmI(): Promise<MetaAnswer | null> {
  const res = await send("GET", "/api/meta");
  if (res.status === 401) return null;
  if (!res.ok) throw await refused(res);
  return (await res.json()) as MetaAnswer;
}

async function start(): Promise<void> {
  root.render(<Waiting />);
  try {
    const meta = await whoAmI();
    if (!meta) {
      root.render(<SignIn onSignedIn={() => void start()} />);
      return;
    }
    // The app is the large part of the page: asked for only once there is
    // somebody to show it to, and while the workspace is being read.
    const app = import("../App");
    const ws = await Workspace.open(meta);
    const { default: App } = await app;
    // Signed out somewhere else, or taken off the workspace: the worker has
    // said to drop the cookie and what the page kept. Back to the sign-in.
    onSignedOut(() => location.reload());
    const saving = new Saving(ws);
    reload = () => saving.reload();
    // What a closed tab left unsent is taken over before the app reads a
    // document, so the one it opens shows what was typed.
    await saving.recover();
    installBackend(webBackend(ws, saving));
    saving.attend();
    ws.follow();
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  } catch (e) {
    const sentence =
      e instanceof Unreachable
        ? `${location.host} isn’t answering. Check your connection and try again.`
        : e instanceof Error
          ? e.message
          : String(e);
    root.render(<Stopped sentence={sentence} />);
  }
}

void start();
