# Notifications plan

Not built. Delete this file once it is built; the rules move to `cloud.md`, `cloud-people-agents.md`, `ios.md` and `cloud-worker/README.md`.

Built on the sharing plan (`docs/sharing-plan.md`, not built either): its shares, "Shared with me" and its rights are the ones named here. Each release moves `WORKER_VERSION` and the D1 step once, from what `main` has when it is built.

How a person is mentioned in a note (people in `@`) is piece 4 of [`links-phase2-plan.md`](links-phase2-plan.md); release 2 here builds it together with the notification a mention sends.

## What people get

- **A Notifications list** in every app: a bell with the unread count at the top of the sidebar (Mac, browser), a fourth tab on the iPhone. Newest first; a click opens the thing and marks it read; *Mark all as read*.
- **Three kinds:** "Maya shared “Q3 plan” with you", "Dave asks to open “Marketing”" (with **Share** and **Dismiss**), and "Maya mentioned you in “Launch notes”".
- **Banners while an app runs:** a macOS banner when the workspace's window isn't in front, an in-app toast when it is; the same in a browser tab and on the iPhone while it is open.
- **An email digest** of what is still unread after a while, through whichever email provider the workspace's admin connects. Only to addresses that are proven: an invitation that arrived by email, or a confirm link.
- Read is the person's, not the device's: read on the Mac, read on the phone.

## Decided

By the user, 2026-11-26:

1. All three tiers are designed: the list, in-app push, email.
2. A digest names who did what and to which document ("Maya mentioned you in Q3 plan"), though the names pass through the team's email provider.
3. The digest's default is hourly.
4. For an app that is closed, email is enough for now. Web Push for the browser and iPhone push through a relay come in the near future (*Later: push to a closed app*).
5. How a mention is written in a note was left to me (`links-phase2-plan.md`, piece 4).

Mine, not yet objected to:

- The list is called **Notifications**, behind a bell.
- Three releases, each useful alone, after the sharing release: (1) the list, shares and requests, banners; (2) people in `@` and mention notifications; (3) email. Then the two pushes.
- A request goes to everyone who can open the share, since everyone on a share may add people. Whoever settles it settles it for all; the asker is told only when they are added.
- A person mentioned who can't open the document gets nothing; the editor offers to share it with them as they are picked.
- Five email providers first: Cloudflare Email Service, Amazon SES, Loops, Resend, Postmark. Others are added when someone needs one (each is a fetch of ~30 lines). No SMTP.

## The rule

**A notification shows only while its reader can open what it is about.** Taken off a share, or the share deleted: its notifications are gone from the list and the digest. Nothing in D1 names a document: a row holds ids, and each app names the thing as its person can open it now, as a link does.

## The worker

**D1** (`schema.ts`, one step):

```
notifications (id n-…, member_id, kind, actor, space_id, file_id, at, read_at, emailed_at, done_by)
              index (member_id, at); kind: shared | request | mention
```

- `actor`: a member id, or an agent's (an agent's write can mention).
- `space_id` + `file_id`: what it is about. `file_id` empty for a folder share.
- `done_by` (requests): who settled it, by sharing or dismissing.
- The daily sweep deletes rows older than 90 days. Removing a person deletes the rows that are theirs to read; rows they caused stay (the directory keeps their name).

**Who writes a row:**

| Kind | Written by | To |
| --- | --- | --- |
| `shared` | the people routes (`POST /api/spaces` with people, `PUT …/members/<id>`), in the same batch | each person added but the caller |
| `request` | `POST /api/requests` | everyone who can open the share but the asker |
| `mention` | `POST /api/notifications/mentions` (a Mac, an iPhone), a browser's save, an agent's write (*Mentions*) | each person mentioned who can open the document, but the writer and the writer's own person |

- A mention of one person by one actor in one file while the earlier row is unread moves that row's `at`; no second row.
- One pending request per person per share; asking again while one is pending writes nothing. At most 20 asks a day per person.

**Routes** (people only; browsers too, all in `ALSO`; agents get none):

```
GET  /api/notifications[?before=<at>]  {notifications: [{id, kind, actor, space, file, at, read, doneBy}],
     unread, more}; 50 a page, newest first, filtered by The rule
POST /api/notifications/read  {ids} | {all: true} → {unread}
POST /api/notifications/mentions  {items: [{space, file, people: [memberId]}]} → 202
POST /api/requests  {space, file?} → 202 {} — the same answer whether the share exists, is deleted,
     or never was
POST /api/requests/dismiss  {space, member} → 204; whoever can open the share
```

- **The poll** carries `notifications: {unread, latest}` (`latest`: the newest unread row's `at`) from one more statement in the batch it already sends: no new request. `null` when D1 fails, as `spaces` is.
- A request is settled when anyone adds the asker by the people route (their `shared` row is their answer) or dismisses it; every recipient's row gets `done_by`.

## Request access

- **Where:** wherever a link is refused because the person can't open it (`cloud_follow_link` on a Mac and an iPhone, `followLink` in a browser), for a link into a workspace this device is in. The refusal gets a **Request access** button.
- `cloud_request_access {url}` → `POST /api/requests {space, file}`. The app answers "If it's still there, the people on it will get your request." That sentence is the same for a share that exists and one that doesn't, so a request never tells a share apart from nothing.
- The recipients' row offers **Share** (the people route, adding the asker to that share) and **Dismiss**. Settled, it says who settled it and how.

## Mentions

What a mention is in a note, how a save writes it, the `@` list and what agents write: [`links-phase2-plan.md`](links-phase2-plan.md), piece 4. In short, the text says `@Maya Chen` and the sidecar's `{"t":"person",…}` record says whom it means. What follows is only the notification.

**A new mention** is a person of whom the document holds more mentions than the version it was last synced from, counted over its markdown and every comment body (`mentionCounts`, `src/docPeople.ts` ⇄ `engine/src/mentions.rs`, held to `verify-harness/mentions-fixture.json`: **change both**). Moving a mention, or taking one out while adding another, sends nothing.

- **A Mac and an iPhone:** the engine compares against its merge base when a push carrying the file lands. It queues the people in the unit's state (a quit or offline sends them later) and sends one `POST /api/notifications/mentions` per pass. None on a connect, a join or a resume (first contact). At most 20 documents a pass, so a bulk edit from outside the app can't page everyone.
- **A browser:** its save (`PUT /api/web/doc`) says whom it newly mentions; it has both versions already.
- **An agent:** the worker counts in `commit`, which already reads the old text for the marker check.
- Person records merge like link records (`engine/src/sidecar.rs` ⇄ `mergeMeta`, held by `comments-fixture.json`).

## The apps

- **Contract:** `CloudStatus.notifications: {unread, latest}` (`status.rs` ⇄ `src/cloud.ts` ⇄ `Payloads.swift`, **change all three**). `cloud_notifications {root, before?}`: the page, each row's thing named as its person can open it, offline-resolved from synced state as `follow` does. `cloud_notifications_read {root, ids | all}`, `cloud_request_access {url}`, `cloud_request_dismiss`. The browser answers each in `src/web/`, saying which engine function it follows.
- **Mac and browser** (one component in `src/`): the bell beside the workspace name, its list as a panel over the sidebar. Each row: avatar, sentence, the thing's section, time. A row opens its thing as a link does: one not here yet waits a poll.
- **iPhone:** a fourth tab, **Notifications**, with the unread count as its badge. The same rows and actions.

## In-app push

- A poll whose `notifications.latest` is newer than what this device last showed (kept in the engine's state): the engine reads the newest page and emits `cloud-notified {root, items}` with the new rows, named.
- **Mac:** a banner when no window of that workspace is in front; a toast and the bell's count when one is. Clicking a banner brings the window forward and opens the thing. It uses `UNUserNotificationCenter` through a macOS-only module, not `tauri-plugin-notification`, which posts through the deprecated `NSUserNotificationCenter` (reports of banners landing silently, suppressed when frontmost). Permission is asked the first time a banner would show. Trap: an unbundled `tauri dev` build can't post one; test with a bundled build under its own identifier.
- **Browser:** the tab's title carries the count ("(2) Acme"), plus a toast. The panel offers *Show notifications on this computer* (the Notification API, asked on that click), while a tab is open.
- **iPhone:** an in-app banner and the tab's badge while it is open; the app icon's badge, once notification permission is given.
- **How soon:** the poll's gap. 15 s while someone works, 1 min in the background, 5 min idle (`Engine::poll_gap`).
- Each device has *Show banners* on or off in Settings; macOS and iOS have their own switch too.

## Email

### Proven addresses

- `members.email_verified_at`, set when an invitation that was emailed is redeemed (the code reached that inbox), or a confirm link is opened. **Only proven addresses get email.**
- **Invite by email:** with mail set up, the invite dialog's default is *Send invitation email* (the line is still shown to copy). The device sends `code` in place of `codeHash`: the worker stores its hash as now and emails it, and never stores or logs the code. Device codes are never emailed and prove nothing. Mirrored invite code is untouched: the device still mints (`invite.rs` ⇄ `codes.ts`).
- The email's button is a link page, `https://doklin.cc/open#d=<domain>&i=<code>`: the app (`doklin://` fills the join screen, the person presses Join) or the browser (`/app#i=<code>` fills the sign-in), offered as for page links, with *Get Doklin* when neither applies. The code is after the `#`, so no server sees it. `i=` joins the link's keys in `link.rs`, `open.html`, `src/pageLink.ts`, the `Info.plist`s and `Workspaces.isPageLink`: **change all of them together.**
- **Somebody who joined from a pasted line** confirms in Settings (*Email me a confirm link*). The link goes to `https://<domain>/app/mail#t=<token>`, a page that sends the token to `POST /api/mail/confirm` on load.
- Tokens are `<member>.<kind>.<expiry>.<hmac>` under a key the worker makes once in `settings` (`mail_key`): no table. A confirm link lasts 7 days; an unsubscribe link lasts until the key changes.

### The mail interface (`cloud-worker/src/mail/`)

```ts
type Mail = { to: string; subject: string; text: string; html: string; unsubscribe: string };
type Mailer = { send(mail: Mail): Promise<void> };   // throws a sentence
```

| Provider | How | Needs |
| --- | --- | --- |
| Cloudflare Email Service | the `EMAIL` binding, `env.EMAIL.send({from, to, subject, html, text, headers})` | a sending domain on Cloudflare DNS, onboarded in the account. **On Workers Free it reaches only addresses each recipient verified with Cloudflare**; any address needs Workers Paid (3,000 a month included). Public beta. |
| Amazon SES | `POST /v2/email/outbound-emails`, `Content.Simple`, signed SigV4 (`aws4fetch`) | a verified domain, an IAM key, a region |
| Loops | `POST /api/v1/transactional`: no subject or html of ours; a template the admin builds once in Loops, with data variables Doklin fills (`subject`, `heading`, `body`, `button`, `unsubscribe`) | the template's id. To check before building: whether a Loops subject can be a data variable. |
| Resend | `POST /emails` | a verified domain, an API key |
| Postmark | `POST /email` (`X-Postmark-Server-Token`) | a confirmed sender, a server token |

**Configured** by the superadmin (`workspace.manage`), in Settings → Email:

- What isn't secret goes in D1 `settings` (`mail`: provider, from address, from name, region, template), by `PUT /api/settings/mail`. A wipe keeps it.
- The provider's key is a Worker secret, `MAIL_KEY` (SES: `<id>:<secret>`). The app hands the superadmin a prompt for an agent: make the key at the provider (the person does), then `wrangler secret put MAIL_KEY --name <worker>`. No app, browser or D1 row ever holds it. A secret survives the update script.
- **The trap:** the update script writes `wrangler.toml` whole, so the `[[send_email]]` binding is written on every deploy, by the setup prompt, the update script and the example alike (`cloudprompts.test.mjs` holds them). To check before building: a binding on an account that hasn't onboarded Email Service must not fail the deploy.
- `GET /api/settings/mail` says whether it is ready (key present, binding there), and on Workers Free that Cloudflare reaches only verified addresses. *Send a test email* (`POST /api/settings/mail/test`) mails the superadmin's own address and answers the provider's refusal as a sentence.

### The digest

- **The cron becomes hourly**: `crons = ["17 * * * *"]`, still one of the account's five on Free. `scheduled` sweeps in the 03:17 UTC run, as today, and sends the digest in every run.
- **Per person, each run:** email on, address proven, and unread rows never emailed that are at least 30 minutes old (seen in an app in time, never mailed). That is one email holding all of them, and those rows get `emailed_at`.
- **Each person picks** in Settings: *Hourly* (default), *Daily* (the run nearest 08:00 in the time zone their device gave when they chose it) or *Off*.
- **What it says:** subject "3 new in Acme"; a line per row ("Maya mentioned you in Q3 plan"), each a page link (`doklin.cc/open#…`), a request's to the list. The worker names each document from its section's manifest, one read per section a run. Text and plain html, no images or tracking.
- **Footer:** why they get it and *Turn off*. `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058), answered by `POST /api/mail/off`. The footer link goes to `/app/mail#t=…`, which asks for a click: link scanners fetch what an email links to.
- At most 40 emails a run (Free: 50 subrequests an invocation); the rest go in the next run.
- A failing provider leaves the rows unmailed and says why in Settings → Email (`settings.mail_error`, the last refusal).

## Limits

- The list costs no request: the poll carries the count. Reading a page is one request, and only when `latest` moves or the list is opened.
- A row is a D1 write per recipient; a request's batch is bounded by the people who can open the share.
- A Mac sends one mentions request per pass that has new mentions, counted like every request (`HttpRemote::auth`).
- The cron: 24 invocations a day. Email costs whatever the provider charges.

## Build order

**Release 1** (after the sharing release): the shared core, shares, requests and banners.
1. Worker: table, routes, the poll's field, the people routes' rows, the sweep. `cloud-worker/test/run.mjs`.
2. Engine: the commands, the poll's field, `cloud-notified`. `tests.rs`.
3. Mac and browser: the bell and list, Request access, banners (the macOS-only module), the browser's title and toast. A `verify-harness` drive.
4. iPhone: the tab, banners. Journeys on CI.

**Release 2:** people in `@` (`links-phase2-plan.md`, piece 4) and mention notifications.
1. `peopleToSave`, `src/docPeople.ts` and the fixtures; the list, the pill, the comment box.
2. Engine: person records in the sidecar merge, `mentions.rs`, the queue.
3. Worker: rule 3 for agents' writes, their counting, the browser's save, `doklin help documents`.
4. iPhone: the reader's pill.

**Release 3:** email.
1. Worker: `mail/` and the five adapters, settings routes, tokens, confirm and unsubscribe, the digest, the hourly cron.
2. Prompts, the update script, the example, `cloudprompts.test.mjs`.
3. Invite by email: the route, the dialog (Mac, browser, iPhone), `i=` across the link's places.
4. Settings → Email for the superadmin; email cadence for everyone.

## Later: push to a closed app

The user's, for the near future, after the three releases. These are outlines; each gets its design pass before it is built.

**Web Push, for a browser** (a release of its own):

- The worker sends it alone: no third party holds anything. It makes a VAPID key pair once and keeps it in D1 `settings`, where all the key can do is sign pushes to this domain's own subscribers.
- A service worker under `/app` (none today), and a subscription per browser sign-in: `push_subscriptions (endpoint PK, token_hash → tokens CASCADE, p256dh, auth, at)`. Signing that browser out drops it; a `404` or `410` from the push service deletes it.
- Every row written for a person is pushed to their subscriptions in `ctx.waitUntil`. The payload is end-to-end encrypted (RFC 8291, WebCrypto only; Workers libraries exist), so it may carry the sentence.
- Turned on from the list (*Notify me when this tab is closed*): the permission needs that click.
- Reaches Chrome, Edge and Firefox, and Safari on a Mac in a normal tab. A phone isn't offered the browser version.

**iPhone push, through a relay** (a release of its own):

- APNs takes pushes only from the key of the Apple account that publishes Doklin, so no team's worker can hold it. Every self-hosted app with official phone apps runs a relay for this: Mattermost, Rocket.Chat, Bitwarden, ntfy.
- **The relay is a worker on doklin.cc's own Cloudflare account** holding the key as a secret. It sees only a device token and a ping, as ntfy's does: no workspace, person or sentence. A team's worker sends it `{token}`; it posts a generic alert with `mutable-content` to APNs.
- **The phone writes the words:** a Notification Service Extension wakes for the alert, reads the newest rows from the phone's own domain with its Keychain sign-in (shared with the extension through an app group), and replaces the text. With no answer in time, the alert stays generic ("New in Doklin").
- The phone registers its APNs token with its domain (a column on its `tokens` row), so signing the device out ends its pushes.
- What it reverses: `live-sync-plan.md`'s "waking a suspended phone is out of scope", and "doklin.cc stores nothing" becomes "doklin.cc's relay stores nothing".
- Traps known now: APNs needs HTTP/2, which a deployed Worker's `fetch` reaches through Cloudflare but `wrangler dev` cannot. The relay must rate-limit per device token, since anyone holding one could ping it.
- A Mac app that is closed: not in either.

## Not in this plan

- Instant delivery (the Durable Object in `live-sync-plan.md`).
- More kinds: replies to a thread, edits to something followed, a person joining, `@everyone`.
- Muting one document or one share.
- SMTP, which would turn on `nodejs_compat` for the whole worker; bounces and complaints, left to the provider.
