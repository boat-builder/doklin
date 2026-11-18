// The setup wizard. Three entrances:
//
//   connect  create a workspace: the open folder goes to a fresh domain —
//            name it, say who you are, choose where it lives (a domain of
//            your own or a free workers.dev address), copy the prompt (it
//            carries a key this app just minted), paste the endpoint the agent
//            printed, probe, connect & upload;
//   recover  the way back in for whoever controls the workspace's Cloudflare
//            account and has lost every device: the address and who you are,
//            a prompt that has an agent put a fresh key on the worker, probe,
//            download it here or resume this folder. Never how a device is
//            added while one is still in hand;
//   redeem   join a workspace with a line — the invite somebody sent, or the
//            one another device of your own made (Devices → Add a device):
//            paste it and click Join. The code is traded for a credential of
//            this Mac's own, the workspace downloads, and it opens.
//
// Connect and recover end the same way: the key is traded, once, for this
// Mac's own sign-in as the workspace's superadmin (`backend.cloud.recover`) — the
// person named here, who becomes it. Nothing keeps the key and nobody types
// it: the app mints it, the agent sets it, the app spends it.
//
// A workspace this Mac joins is never asked where it should go: it lands in
// ~/Doklin/<its name>, a folder of its own (the engine picks it —
// `cloud_join`), and opens as soon as it is down.
//
// Redeem runs the entrance backwards, and has to: /api/meta is inside the
// worker's auth gate, so a joining Mac cannot ask the domain anything until
// the redeem has minted it a token. A code, like a key, works once, so a step
// that fails after it has been spent keeps the credential and offers the step
// again — never another trade (`joined`). And a Mac whose open folder already
// is that workspace (it disconnected, and is back) is offered the resume
// below instead of a second copy.
//
// A Mac holds one copy of a domain's workspace, and every step after a trade
// refuses a second — so before a code or a key is traded, the wizard asks
// whether this Mac already has that domain (`backend.cloud.held`). If it does, the
// card says where: a copy that syncs is opened instead, and one that has
// stopped (its sign-in refused, its folder gone) is disconnected first, with
// what is to be traded still unspent.
//
// For the other two the probe — made with the key, which the worker answers
// on that route alone — decides what the domain is, and the wizard says so in
// words: fresh → "Connect & upload"; already holding a workspace → "Download
// it", plus "Resume syncing this folder" when the open folder carries that
// workspace's marker (a reinstall, a restore from a backup). There is no
// "bind anyway": a domain holds one workspace.

import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import { useDismiss } from "./dismiss";
import {
  BUNDLED_WORKER_VERSION,
  WORKER_COMPATIBILITY_DATE,
  timeAgo,
  type CloudHeld,
  type CloudMarker,
  type CloudProbe,
  type CloudProgressEvent,
} from "./cloud";
import {
  buildRecoverPrompt,
  buildSetupPrompt,
  cleanDomain,
  cleanWorkersName,
  endpointOf,
  resourceName,
  targetProblem,
  type CloudTarget,
} from "./cloudPrompts";
import { backend } from "./backend";

export type CloudSetupMode = "connect" | "recover" | "redeem";
/** A redeem or a recovery ends in a download or a resume: what the outcome
 *  names is what happened to the folder, not which door was used. */
export type CloudSetupOutcome = "connect" | "join" | "resume";

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
      <line x1="5" y1="5" x2="19" y2="19" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  );
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const basename = (p: string) => p.split(/[\\/]/).pop() || p;
/** The shape a mailbox has — the worker's own check (members.ts `normalizeEmail`). */
const looksLikeEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

type Probed = {
  endpoint: string;
  result: CloudProbe;
  /** The open folder's marker, read alongside the probe. */
  marker: CloudMarker | null;
};

type Work = { how: CloudSetupOutcome; progress: CloudProgressEvent | null };

/** This Mac's own sign-in, once a code or the key has been traded for it. */
type Joined = { endpoint: string; token: string; name: string };

export default function CloudSetup({
  mode,
  root,
  onClose,
  onConnected,
  onOpen,
}: {
  mode: CloudSetupMode;
  /** The open workspace folder, if any: what "connect" uploads, what "resume" adopts. */
  root: string | null;
  onClose: () => void;
  /** The workspace is syncing at `root` — the folder that was open, or the one a download created. */
  onConnected: (root: string, how: CloudSetupOutcome) => void;
  /** Open a workspace this Mac already syncs, instead of joining it again. */
  onOpen: (root: string) => void;
}) {
  const withKey = mode !== "redeem";
  const [name, setName] = useState(root ? basename(root) : "Notes");
  const [targetKind, setTargetKind] = useState<CloudTarget["kind"]>("domain");
  const [domainInput, setDomainInput] = useState("");
  const [nameInput, setNameInput] = useState("");
  // Who is at the keyboard: whoever trades the key is the superadmin.
  const [personName, setPersonName] = useState("");
  const [personEmail, setPersonEmail] = useState("");
  // Minted here for a connect or a recovery, and never typed.
  const [key, setKey] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [endpointInput, setEndpointInput] = useState("");
  const [endpointTouched, setEndpointTouched] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probed, setProbed] = useState<Probed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [work, setWork] = useState<Work | null>(null);
  // A connect or a resume ends on a card that says so; a download just opens.
  const [done, setDone] = useState<{ root: string; how: CloudSetupOutcome } | null>(null);
  const [copied, setCopied] = useState(false);
  // Redeem only: the code as typed or pasted, and whether it is being traded.
  const [code, setCode] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  // Set is what says this Mac already holds a credential — a code or a key
  // cannot be traded twice, so nothing after that point may offer to trade
  // it again, only to go on with what it bought.
  const [joined, setJoined] = useState<Joined | null>(null);
  // The copy of the domain this Mac already has, as asked for the address
  // `at`: it answers for that address only, so editing it lets it go.
  const [held, setHeld] = useState<{ at: string; copy: CloudHeld } | null>(null);
  const [lettingGo, setLettingGo] = useState(false);

  // Nothing closes while a step is running.
  const cardRef = useRef<HTMLDivElement>(null);
  useDismiss(() => {
    if (!work) onClose();
  }, cardRef);

  useEffect(() => {
    if (!withKey) return;
    let live = true;
    void backend.cloud.mintToken()
      .then((t) => {
        if (live && typeof t === "string" && t) setKey(t);
        else if (live) setKeyError("Couldn't make a key.");
      })
      .catch((e) => {
        if (live) setKeyError(`Couldn't make a key: ${errText(e)}`);
      });
    return () => {
      live = false;
    };
  }, [withKey]);

  // Upload / download progress while a flow runs.
  useEffect(
    () =>
      backend.cloud.onProgress((e) => {
        setWork((w) => (w ? { ...w, progress: e } : w));
      }),
    [],
  );

  const target: CloudTarget | null = useMemo(() => {
    if (targetKind === "domain") {
      const d = cleanDomain(domainInput);
      return d ? { kind: "domain", domain: d } : null;
    }
    const n = cleanWorkersName(nameInput);
    return n ? { kind: "workers-dev", name: n } : null;
  }, [targetKind, domainInput, nameInput]);
  const targetTyped = targetKind === "domain" ? domainInput.trim() !== "" : nameInput.trim() !== "";
  const targetError = target ? targetProblem(target) : targetTyped ? "That doesn't look right yet." : null;
  const cleanName = name.trim() || (root ? basename(root) : "Notes");
  const identityOk = looksLikeEmail(personEmail);

  // A domain of your own answers at https://<domain>; a workers.dev address
  // is only known once wrangler prints it, so that one is pasted. A recovery
  // starts from the address.
  const endpoint = endpointTouched || mode !== "connect" ? endpointInput : (target && endpointOf(target)) ?? "";
  const heldCopy = held && held.at === endpoint ? held.copy : null;

  const prompt = useMemo(() => {
    if (!key || !identityOk) return null;
    if (mode === "connect") {
      if (!target || targetError) return null;
      return buildSetupPrompt({
        target,
        key,
        workspaceName: cleanName,
        workerVersion: BUNDLED_WORKER_VERSION,
        compatibilityDate: WORKER_COMPATIBILITY_DATE,
      });
    }
    if (mode === "recover") {
      return cleanDomain(endpoint) ? buildRecoverPrompt({ endpoint, key }) : null;
    }
    return null;
  }, [mode, target, targetError, key, identityOk, cleanName, endpoint]);

  const copyPrompt = useCallback(async () => {
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* selectable text — copy by hand */
    }
  }, [prompt]);

  const probeWith = useCallback(
    async (at: string, bearer: string) => {
      setError(null);
      setProbed(null);
      setProbing(true);
      try {
        const [result, marker, copy] = await Promise.all([
          backend.cloud.probe(at, bearer),
          root ? backend.cloud.marker(root).catch(() => null) : Promise.resolve(null),
          backend.cloud.held(at),
        ]);
        setProbed({ endpoint: at, result, marker });
        setHeld(copy ? { at, copy } : null);
      } catch (e) {
        setError(errText(e));
      } finally {
        setProbing(false);
      }
    },
    [root],
  );
  const probe = useCallback(() => probeWith(endpoint, key), [probeWith, endpoint, key]);

  /**
   * This Mac's own sign-in: the one a code or the key already bought, or —
   * the first time — the key traded for it, as the person named here. The
   * key is spent by the trade, so whatever fails after it is retried with
   * what it bought.
   */
  const signIn = useCallback(
    async (at: string): Promise<Joined> => {
      if (joined) return joined;
      const r = await backend.cloud.recover(at, key, personEmail.trim(), personName.trim() || null);
      const got = { endpoint: r.endpoint, token: r.token, name: r.name || r.email };
      setJoined(got);
      return got;
    },
    [joined, key, personEmail, personName],
  );

  /** Download the workspace at `at` into its own folder under ~/Doklin and
   *  open it. Shared by every door that ends in a download. */
  const download = useCallback(
    async (at: string, bearer: string) => {
      setError(null);
      setWork({ how: "join", progress: null });
      try {
        onConnected(await backend.cloud.join(at, bearer), "join");
      } catch (e) {
        setError(errText(e));
      } finally {
        setWork(null);
      }
    },
    [onConnected],
  );

  const downloadHere = useCallback(async () => {
    if (!probed) return;
    setError(null);
    let got: Joined;
    try {
      got = await signIn(probed.endpoint);
    } catch (e) {
      setError(errText(e));
      return;
    }
    await download(got.endpoint, got.token);
  }, [probed, signIn, download]);

  /**
   * Join: trade the code for this Mac's own credential, then download with it.
   *
   * The two calls are deliberately separate: the code is spent the moment
   * the redeem answers, so a download that fails afterwards must leave the
   * credential in hand and offer the download again — never another redeem.
   */
  const redeem = useCallback(async () => {
    setError(null);
    setRedeeming(true);
    let got: Joined;
    try {
      // Asked before the trade, which would refuse to spend the code on a
      // domain this Mac already has.
      const copy = await backend.cloud.held(endpoint);
      if (copy) {
        setHeld({ at: endpoint, copy });
        return;
      }
      const r = await backend.cloud.redeem(endpoint, code);
      got = { endpoint: r.endpoint, token: r.token, name: r.name || r.email };
      setJoined(got);
      setEndpointInput(r.endpoint);
      setEndpointTouched(true);
    } catch (e) {
      setError(errText(e));
      return;
    } finally {
      setRedeeming(false);
    }
    // The open folder may already be that workspace — this Mac disconnected
    // and is coming back, or the folder was restored. Then it is resumed in
    // place or downloaded afresh, and that is the person's to say: the
    // outcome card offers both, with the credential the code just bought.
    if (root) {
      try {
        const [result, marker] = await Promise.all([backend.cloud.probe(got.endpoint, got.token), backend.cloud.marker(root)]);
        if (marker && result.workspace && marker.wsId === result.workspace.id) {
          setProbed({ endpoint: got.endpoint, result, marker });
          return;
        }
      } catch {
        /* nothing to resume that we can tell of — download, as for any join */
      }
    }
    await download(got.endpoint, got.token);
  }, [endpoint, code, download, root]);

  /**
   * Disconnect the copy that has stopped syncing, then go on: a join trades
   * its code now, a key door shows what the probe offered. The folder stays
   * where it is, as every Disconnect leaves it.
   */
  const letGo = useCallback(async () => {
    if (!heldCopy) return;
    setError(null);
    setLettingGo(true);
    try {
      await backend.cloud.disconnect(heldCopy.root);
      setHeld(null);
    } catch (e) {
      setError(errText(e));
      return;
    } finally {
      setLettingGo(false);
    }
    if (!withKey) await redeem();
  }, [heldCopy, withKey, redeem]);

  /** One paste fills both boxes: the line as it was sent, the whole message
   *  around it, or one half on its own — whatever the engine can find in it. */
  const pasteInvite = (field: "endpoint" | "code") => (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text").trim();
    if (!text) return;
    e.preventDefault();
    const asTyped = () => {
      if (field === "endpoint") {
        setEndpointInput(text);
        setEndpointTouched(true);
      } else {
        setCode(text);
      }
    };
    void backend.cloud.parseInvite(text)
      .then((p) => {
        if (p.endpoint) {
          setEndpointInput(p.endpoint);
          setEndpointTouched(true);
        }
        if (p.code) setCode(p.code);
        if (field === "endpoint" ? !p.endpoint : !p.code) asTyped();
      })
      .catch(asTyped);
  };

  const run = useCallback(
    async (how: CloudSetupOutcome, go: () => Promise<string>) => {
      setError(null);
      setWork({ how, progress: null });
      try {
        const at = await go();
        setDone({ root: at, how });
      } catch (e) {
        setError(errText(e));
      } finally {
        setWork(null);
      }
    },
    [],
  );

  const connect = () => {
    if (!root || !probed) return;
    void run("connect", async () => {
      const got = await signIn(probed.endpoint);
      await backend.cloud.connect(root, got.endpoint, got.token, cleanName);
      return root;
    });
  };
  const resume = () => {
    if (!root || !probed) return;
    void run("resume", async () => {
      const got = await signIn(probed.endpoint);
      await backend.cloud.resume(root, got.endpoint, got.token);
      return root;
    });
  };
  /* ---------- pieces ---------- */

  const workspace = probed?.result.workspace ?? null;
  const markerMatches = !!(probed && root && probed.marker && workspace && probed.marker.wsId === workspace.id);
  const versionNote = (() => {
    if (!probed) return null;
    const { workerVersion, bundledVersion } = probed.result;
    if (workerVersion < bundledVersion) {
      return `The worker is behind this app (v${workerVersion}, the app expects v${bundledVersion}) — connect, then update it from the Cloud panel.`;
    }
    if (workerVersion > bundledVersion) {
      return `The worker is newer than this app (v${workerVersion}) — update Doklin soon.`;
    }
    return null;
  })();

  const progressLine = (() => {
    if (!work) return null;
    const verb = work.how === "join" ? "Downloading" : work.how === "connect" ? "Uploading" : "Adopting";
    if (!work.progress) return `${verb}…`;
    return `${verb} ${work.progress.done} of ${work.progress.total}…`;
  })();

  // Once the key is spent, what it bought is what every retry goes on with.
  const spentNote = withKey && joined && error && (
    <p className="cloud-hint" data-testid="signed-in-as">
      You’re signed in as {joined.name} — the key is spent, and this Mac has a sign-in of its own.
      Try again here; closing now would mean running the prompt again with a fresh key.
    </p>
  );

  const outcome = probed && !done && (
    <div className="cloud-card" data-testid="probe-outcome">
      {workspace ? (
        <>
          <div className="cloud-card-title">
            {probeDomain(probed.endpoint)} already holds “{workspace.name}”
          </div>
          <p className="cloud-hint">
            Created on {workspace.createdBy.deviceName}
            {createdAgo(workspace.createdAt)}. A domain holds one workspace — download that one
            to this Mac{markerMatches ? ", or resume syncing this folder, which is that workspace" : ""}.
            {withKey && ` Either signs you in as ${personEmail.trim()}, its superadmin.`}
          </p>
        </>
      ) : (
        <>
          <div className="cloud-card-title">
            {probeDomain(probed.endpoint)} is up and holds nothing yet
          </div>
          <p className="cloud-hint">
            Worker v{probed.result.workerVersion}.{" "}
            {mode === "connect" && root
              ? `Connecting uploads everything in “${basename(root)}” — every note and file under it — and keeps it in step from then on. You’re its superadmin.`
              : mode === "recover"
                ? "There is nothing to recover here — create a workspace instead."
                : "Connect a folder to it from the Mac that has the notes."}
          </p>
        </>
      )}
      {versionNote && <p className="cloud-hint cloud-warn">{versionNote}</p>}
      {work ? (
        <div className="cloud-progress" role="progressbar" aria-label={progressLine ?? "Working"}>
          <div className="cloud-progress-text">{progressLine}</div>
          {work.progress && work.progress.total > 0 && (
            <div className="cloud-progress-bar">
              <span style={{ width: `${Math.round((100 * work.progress.done) / work.progress.total)}%` }} />
            </div>
          )}
        </div>
      ) : (
        <div className="modal-buttons">
          {!workspace && mode === "connect" && root && (
            <button className="modal-btn is-primary" onClick={connect} data-testid="connect-upload">
              Connect &amp; upload
            </button>
          )}
          {workspace && (
            <button className="modal-btn is-primary" onClick={() => void downloadHere()} data-testid="download-here">
              Download it
            </button>
          )}
          {workspace && markerMatches && (
            <button className="modal-btn" onClick={resume} data-testid="resume-folder">
              Resume syncing this folder
            </button>
          )}
        </div>
      )}
      {spentNote}
    </div>
  );

  // A copy this Mac already has takes the place of the Join button and of the
  // probe's outcome: nothing either offers could be done while it is here.
  const traded = withKey ? "key" : "code";
  const heldCard = heldCopy && !done && !work && (
    <div className="cloud-card" data-testid="held-copy">
      <div className="cloud-card-title">
        {heldCopy.syncs
          ? `This Mac already syncs “${heldCopy.name}”`
          : `This Mac’s copy of “${heldCopy.name}” has stopped syncing`}
      </div>
      <p className="cloud-hint">
        It’s in <code>{heldCopy.root}</code>. A Mac holds one copy of a workspace, so the {traded}{" "}
        hasn’t been used.{" "}
        {heldCopy.syncs
          ? "Open that copy instead."
          : `Disconnect it, and ${heldCopy.domain} comes down here afresh; the folder stays where it is.`}
      </p>
      <div className="modal-buttons">
        {heldCopy.syncs ? (
          <button className="modal-btn is-primary" data-testid="held-open" onClick={() => onOpen(heldCopy.root)}>
            Open it
          </button>
        ) : (
          <button
            className="modal-btn is-primary"
            data-testid="held-disconnect"
            disabled={lettingGo}
            onClick={() => void letGo()}
          >
            {lettingGo ? "Disconnecting…" : withKey ? "Disconnect it" : "Disconnect it and join"}
          </button>
        )}
      </div>
    </div>
  );

  const doneBlock = done && (
    <div className="cloud-card cloud-card--ok" data-testid="setup-done">
      <div className="cloud-card-title">Syncing</div>
      <p className="cloud-hint">
        {basename(done.root)} and {probeDomain(probed?.endpoint ?? endpoint)} stay in step from
        now on. The dot beside the workspace name shows the sync at a glance; the gear’s Cloud…
        item has the rest.
      </p>
      <div className="modal-buttons">
        <button className="modal-btn is-primary" onClick={() => onConnected(done.root, done.how)}>
          Done
        </button>
      </div>
    </div>
  );

  const endpointField = (
    <div className="modal-field">
      <div className="modal-field-label">{mode === "recover" ? "Address" : "Endpoint"}</div>
      <input
        className="modal-field-input"
        data-testid="endpoint-input"
        value={endpoint}
        placeholder={
          mode === "recover" || (targetKind === "domain" && mode === "connect")
            ? "https://notes.example.com"
            : "https://doklin-notes.example.workers.dev"
        }
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        disabled={!!joined}
        onChange={(e) => {
          setEndpointInput(e.target.value);
          setEndpointTouched(true);
          setProbed(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && mode === "connect" && endpoint && key && !probing) void probe();
        }}
      />
    </div>
  );

  const checkStep = (
    <>
      <div className="modal-buttons">
        <button
          className={`modal-btn ${probed ? "" : "is-primary"}`}
          data-testid="probe-button"
          disabled={!endpoint || !key || probing || !!work}
          onClick={() => void probe()}
        >
          {probing ? "Checking…" : "Check"}
        </button>
      </div>
      {error && <div className="modal-error" data-testid="setup-error">{error}</div>}
    </>
  );

  const identityFields = (
    <>
      <div className="modal-field">
        <div className="modal-field-label">Your name</div>
        <input
          className="modal-field-input"
          data-testid="person-name-input"
          value={personName}
          maxLength={80}
          disabled={!!joined}
          onChange={(e) => setPersonName(e.target.value)}
        />
      </div>
      <div className="modal-field">
        <div className="modal-field-label">Your email</div>
        <input
          className="modal-field-input"
          data-testid="person-email-input"
          value={personEmail}
          placeholder="you@example.com"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={!!joined}
          onChange={(e) => setPersonEmail(e.target.value)}
        />
      </div>
    </>
  );

  const promptStep = (what: string) => (
    <li className={`cloud-step ${prompt ? "" : "is-waiting"}`}>
      <div className="cloud-step-title">Copy the prompt for your agent</div>
      <div className="cloud-step-note">
        Run it in Claude Code, or any agent with a terminal. {what} It carries a key this app
        just made, which this Mac trades once for a sign-in of its own — so paste it only into an
        agent you run yourself.
      </div>
      {prompt && (
        <>
          <pre className="cloud-prompt" data-testid="setup-prompt">
            {prompt}
          </pre>
          <div className="modal-buttons">
            <button className="modal-btn is-primary" onClick={() => void copyPrompt()}>
              {copied ? "Copied ✓" : "Copy prompt"}
            </button>
          </div>
        </>
      )}
    </li>
  );

  const redeemStep = (
    <>
      <div className="modal-field">
        <div className="modal-field-label">Address</div>
        <input
          className="modal-field-input"
          data-testid="endpoint-input"
          value={endpoint}
          placeholder="https://notes.example.com"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={!!joined || redeeming}
          onPaste={pasteInvite("endpoint")}
          onChange={(e) => {
            setEndpointInput(e.target.value);
            setEndpointTouched(true);
          }}
        />
      </div>
      <div className="modal-field">
        <div className="modal-field-label">Code</div>
        <input
          className="modal-field-input modal-field-token"
          data-testid="code-input"
          value={code}
          placeholder="dkln-K7QM2-9XVR4-8TBHN-3WGYD"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={!!joined || redeeming}
          onPaste={pasteInvite("code")}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && endpoint && code && !redeeming && !joined) void redeem();
          }}
        />
      </div>
      {work ? (
        <div className="cloud-progress" role="progressbar" aria-label={progressLine ?? "Working"}>
          <div className="cloud-progress-text" data-testid="join-progress">
            {progressLine}
          </div>
          {work.progress && work.progress.total > 0 && (
            <div className="cloud-progress-bar">
              <span style={{ width: `${Math.round((100 * work.progress.done) / work.progress.total)}%` }} />
            </div>
          )}
        </div>
      ) : joined && probed ? (
        <p className="cloud-hint" data-testid="redeemed-as">
          You’re in as {joined.name} — the code is spent, and this Mac has a credential of its own.
          The folder that is open already is this workspace, so choose below. A code works once,
          so closing now would mean asking for a fresh one.
        </p>
      ) : joined ? (
        <>
          <p className="cloud-hint" data-testid="redeemed-as">
            You’re in as {joined.name} — the code is spent, and this Mac has a credential of its
            own. The download didn’t finish; try it again here. A code works once, so closing now
            would mean asking for a fresh one.
          </p>
          <div className="modal-buttons">
            <button
              className="modal-btn is-primary"
              data-testid="download-again"
              onClick={() => void download(joined.endpoint, joined.token)}
            >
              Download again
            </button>
          </div>
        </>
      ) : heldCopy ? (
        heldCard
      ) : (
        <div className="modal-buttons">
          <button
            className="modal-btn is-primary"
            data-testid="redeem-button"
            disabled={!endpoint || !code || redeeming}
            onClick={() => void redeem()}
          >
            {redeeming ? "Joining…" : "Join"}
          </button>
        </div>
      )}
      {error && <div className="modal-error" data-testid="setup-error">{error}</div>}
    </>
  );

  return (
    <div className="modal-overlay">
      <div
        ref={cardRef}
        className="modal cloud-modal cloud-modal--wide"
        role="dialog"
        aria-modal="true"
        aria-label={modalTitle(mode)}
      >
        <div className="modal-header">
          <div className="modal-title">{modalTitle(mode)}</div>
          <button className="modal-close" onClick={onClose} aria-label="Close" disabled={!!work}>
            <CloseIcon />
          </button>
        </div>
        <div className="cloud-body">
          {mode === "connect" ? (
            <ol className="cloud-steps">
              <li className="cloud-step">
                <div className="cloud-step-title">Name it, say who you are, and where it will live</div>
                <div className="cloud-step-note">
                  The name is what everyone you invite sees, and the landing page. You are its
                  superadmin: the one person who updates its worker, erases it, and lets somebody
                  who lost every device back in — whoever controls the Cloudflare account it is
                  on. A workspace lives at a domain — a subdomain of one you already use with
                  Cloudflare, or a free address Cloudflare hands out — and this folder becomes
                  what is in it.
                </div>
                <div className="modal-field">
                  <div className="modal-field-label">Workspace name</div>
                  <input
                    className="modal-field-input"
                    data-testid="name-input"
                    value={name}
                    maxLength={80}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                {identityFields}
                <div className="cloud-choices" role="radiogroup" aria-label="Where the cloud lives">
                  <button
                    role="radio"
                    aria-checked={targetKind === "domain"}
                    className={`cloud-choice ${targetKind === "domain" ? "is-active" : ""}`}
                    onClick={() => setTargetKind("domain")}
                  >
                    <span className="cloud-choice-name">A domain of my own</span>
                    <span className="cloud-choice-sub">notes.example.com — its zone on your Cloudflare account</span>
                  </button>
                  <button
                    role="radio"
                    aria-checked={targetKind === "workers-dev"}
                    className={`cloud-choice ${targetKind === "workers-dev" ? "is-active" : ""}`}
                    onClick={() => setTargetKind("workers-dev")}
                  >
                    <span className="cloud-choice-name">A free workers.dev address</span>
                    <span className="cloud-choice-sub">doklin-‹name›.‹your-subdomain›.workers.dev</span>
                  </button>
                </div>
                {targetKind === "domain" ? (
                  <div className="modal-field">
                    <div className="modal-field-label">Domain</div>
                    <input
                      className="modal-field-input"
                      data-testid="domain-input"
                      value={domainInput}
                      placeholder="notes.example.com"
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                      onChange={(e) => {
                        setDomainInput(e.target.value);
                        setProbed(null);
                      }}
                    />
                  </div>
                ) : (
                  <div className="modal-field">
                    <div className="modal-field-label">Name</div>
                    <input
                      className="modal-field-input"
                      data-testid="workers-name-input"
                      value={nameInput}
                      placeholder="sherin-notes"
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                      onChange={(e) => {
                        setNameInput(e.target.value);
                        setProbed(null);
                      }}
                    />
                  </div>
                )}
                {target && !targetError && (
                  <div className="cloud-step-note">
                    Worker, bucket and database: <code>{resourceName(target)}</code>
                  </div>
                )}
                {targetError && <div className="modal-error">{targetError}</div>}
                {keyError && <div className="modal-error">{keyError}</div>}
              </li>

              {promptStep(
                "It signs into Cloudflare, deploys the worker with its bucket and database under names derived from the domain, stores the key as the worker’s secret, and prints the endpoint.",
              )}

              <li className={`cloud-step ${prompt ? "" : "is-waiting"}`}>
                <div className="cloud-step-title">Paste the endpoint it printed</div>
                <div className="cloud-step-note">
                  The line that starts with <code>ENDPOINT:</code>. For a domain of your own it is
                  the domain itself; a workers.dev address includes your account’s subdomain.
                </div>
                {prompt && (
                  <>
                    {endpointField}
                    {checkStep}
                  </>
                )}
                {heldCard || outcome}
                {doneBlock}
              </li>
            </ol>
          ) : mode === "redeem" ? (
            <ol className="cloud-steps">
              <li className="cloud-step">
                <div className="cloud-step-title">Paste the line</div>
                <div className="cloud-step-note">
                  One line — the address and the code together — from whoever invited you, or
                  from another device of your own: there, the workspace menu → Devices… → Add a
                  device. Paste it into either box and both fill in. The workspace downloads to a
                  folder of its own in <code>~/Doklin</code> and opens; from then on it stays in
                  step with every other copy.
                </div>
                {redeemStep}
                {outcome}
                {doneBlock}
              </li>
            </ol>
          ) : (
            <ol className="cloud-steps">
              <li className="cloud-step">
                <div className="cloud-step-title">The workspace’s address, and who you are</div>
                <div className="cloud-step-note">
                  For whoever controls the workspace’s Cloudflare account and has lost every
                  device. An agent puts a fresh key on its worker, and this Mac trades it for a
                  sign-in of its own as the superadmin. An email that isn’t the superadmin’s now
                  makes you the superadmin in their place. To add a device while you still have
                  one, use Add a device there instead.
                </div>
                {endpointField}
                {identityFields}
                {keyError && <div className="modal-error">{keyError}</div>}
              </li>

              {promptStep("It signs into Cloudflare and sets the key as the worker’s secret — nothing else.")}

              <li className={`cloud-step ${prompt ? "" : "is-waiting"}`}>
                <div className="cloud-step-title">When it prints KEY SET, get back in</div>
                <div className="cloud-step-note">
                  The workspace lands in a folder of its own in <code>~/Doklin</code>, named after
                  it, opens, and stays in step from then on.
                  {root ? " A folder that already is that workspace can be resumed in place instead." : ""}
                </div>
                {prompt && checkStep}
                {heldCard || outcome}
                {doneBlock}
              </li>
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}

/** What the dialog calls itself, which is the door that was used. */
function modalTitle(mode: CloudSetupMode): string {
  if (mode === "connect") return "Create a workspace";
  return mode === "redeem" ? "Join a workspace" : "Recover a workspace";
}

/** The host of an endpoint, for prose. */
function probeDomain(endpoint: string): string {
  return cleanDomain(endpoint) ?? endpoint;
}

/** ", 12 d ago" from an ISO timestamp; nothing when it doesn't parse. */
function createdAgo(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? `, ${timeAgo(t)}` : "";
}
