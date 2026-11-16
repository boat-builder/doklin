//! Everything the engine says to the worker, behind one trait so the whole
//! engine — merges, conflicts, tombstones, the public map, the flows — runs
//! in tests against an in-memory fake with the worker's CAS semantics
//! (tests.rs), and in the app against `HttpRemote`: the sync API of
//! cloud-worker/README.md, JSON over HTTPS with this device's token as bearer.
//! Nothing outside this module holds a token or opens a connection.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::manifest::{Beat, Manifest, PollResponse, PublicKind, SpaceEntry};
use super::pace::{Limits, Usage};
use super::versions::VersionsIndex;

/* ---------- What the worker knows ---------- */

/// `workspace.json` — the binding, as `/api/meta` and a `409` report it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecord {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub created_by: CreatedBy,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedBy {
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub device_name: String,
}

/// `GET /api/meta`: liveness, the credential, "is this domain bound", and
/// identity: who this bearer is and what everyone here is called.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Meta {
    pub version: u32,
    #[serde(default)]
    pub workspace: Option<WorkspaceRecord>,
    /// Who the bearer is. None when it is the domain's key, which is
    /// nobody's sign-in: the setup wizard probes with it before trading it
    /// for one of its own (`HttpRemote::recover`).
    #[serde(default)]
    pub you: Option<Identity>,
    /// The workspace's superadmin — whom to ask for what only they can do.
    /// None on a domain nobody has traded a key on yet.
    #[serde(default)]
    pub superadmin: Option<Person>,
    /// The directory: every person's id and display name, and nothing else.
    /// The People list — addresses, devices, roles — is a route of its own.
    #[serde(default)]
    pub people: Vec<Person>,
    /// The domain's plan's limits (`super::pace`), for a bearer that is
    /// somebody's sign-in. A worker that answers none predates them.
    #[serde(default)]
    pub limits: Option<Limits>,
}

/// Who the bearer is. `member_id` is the id this Mac's work is signed with.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    /// `superadmin`, `owner` or `member` — the role this person holds.
    pub role: String,
    /// What that role may do, as the worker's one table spells it
    /// (cloud-worker/src/roles.ts) — what the app hides the rest by.
    pub can: Vec<String>,
    /// Which row of the signed-in devices this credential is (`t-…`). What
    /// keeps the app from offering to sign out the Mac it is running on.
    pub token_id: String,
    pub member_id: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub name: String,
}

/// One row of the directory: an id, and what to call it — and for an agent,
/// whose it is.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Person {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// An agent's person, by member id. A worker before 23 says none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub person: Option<String>,
}

/// What a won bind answers with.
#[derive(Clone, Debug)]
pub struct Bound {
    pub workspace: WorkspaceRecord,
    /// The etag of the empty manifest the bind created — the base of the
    /// first real manifest.
    pub manifest_etag: String,
}

/* ---------- Who the workspace's people are ---------- */

/// A person, as the identity routes describe one. Never a credential: the
/// app is told who holds one, never what it is.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberRecord {
    pub id: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub name: String,
    /// `superadmin`, `owner` or `member`. It is the person's, and every
    /// device they are signed in on carries it: an owner makes another by
    /// changing this. The one superadmin is nobody's to change or remove.
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub created_at: u64,
    /// When a Mac of theirs last beat, and before any has, when they first
    /// traded a code in. `None`: nobody has ever signed in as them.
    #[serde(default)]
    pub last_seen_at: Option<u64>,
    /// How many Macs this person is signed in on, counted by the members
    /// route. Zero on a record that came from somewhere else — a redeem
    /// answers with the person, not with a census of them.
    #[serde(default)]
    pub devices: u32,
}

/// A pending invite, as `POST /api/auth/invites` answers. The code is not in
/// it and never comes back from the worker — the app is the only place it
/// ever exists in the clear.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteRecord {
    pub id: String,
    #[serde(default)]
    pub member_id: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub expires_at: u64,
}

/// What a redeemed code answers with: this device's own token, handed over
/// exactly once — the domain keeps only its sha256 from here on.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedeemedToken {
    pub token: String,
    #[serde(default)]
    pub token_id: String,
    #[serde(default)]
    pub member: MemberRecord,
}

/// One signed-in device — a Mac, an iPhone — as `GET /api/auth/devices`
/// lists it. Never the credential: its person, and an owner, are told who
/// holds one and may take it away, never what it is — a list of tokens would
/// be a list of keys.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRecord {
    pub id: String,
    #[serde(default)]
    pub member_id: String,
    #[serde(default)]
    pub email: String,
    /// The `x-doklin-device` id that redeemed it — how a device recognizes
    /// its own row in the list.
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub device_name: Option<String>,
    #[serde(default)]
    pub created_at: u64,
}

/* ---------- Agents ---------- */

/// An agent as the domain lists one: an identity that is not a person and
/// belongs to one, with what it may do, the machines it is logged in on and
/// the login code nobody has used yet. Never a credential.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRecord {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// `read`, `comment`, `edit`, `publish` — the ones its person ticked.
    /// `read` is always among them.
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub created_at: u64,
    /// When it last made a request, to the hour. None until it has.
    #[serde(default)]
    pub last_used_at: Option<u64>,
    /// Whose it is: the member it belongs to.
    #[serde(default)]
    pub member_id: String,
    /// Whether that is whoever asked. An agent that is somebody else's is
    /// listed to an owner, who may remove it and nothing more.
    #[serde(default)]
    pub mine: bool,
    #[serde(default)]
    pub machines: Vec<AgentMachine>,
    /// The login code nobody has used yet — only ever on one's own agent.
    #[serde(default)]
    pub code: Option<AgentCode>,
}

/// One machine an agent is logged in on: what `doklin login` left there,
/// named by what the machine calls itself.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMachine {
    pub id: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub created_at: u64,
}

/// A login code nobody has traded in yet. The code is not in it and never
/// comes back from the worker.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCode {
    pub id: String,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub expires_at: u64,
}

/// One public page, as an owner is told of it: what its address tells the
/// internet, and nothing of the section it was published from.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EveryPage {
    pub slug: String,
    pub kind: PublicKind,
    #[serde(default)]
    pub title: String,
    /// Who published it, as a name.
    #[serde(default)]
    pub by: String,
    #[serde(default)]
    pub at: u64,
    /// In the shared workspace, where everyone here can open its file.
    #[serde(default)]
    pub shared: bool,
}

/// `GET /api/pages`. `truncated` when more sections hold addresses than one
/// request reads.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EveryPages {
    #[serde(default)]
    pub pages: Vec<EveryPage>,
    #[serde(default)]
    pub truncated: bool,
}

/// One round of `POST /api/admin/wipe`; repeat while `remaining`.
#[derive(Clone, Debug, Deserialize)]
pub struct WipeRound {
    #[serde(default)]
    pub purged: u64,
    #[serde(default)]
    pub remaining: bool,
}

/* ---------- Errors ---------- */

#[derive(Debug)]
pub enum RemoteError {
    /// Transport-level failure — the domain is unreachable, not wrong.
    Offline(String),
    /// Token rejected: the domain does not know it — a rotated secret, a
    /// wiped domain, a database that could not answer.
    Unauthorized,
    /// An owner took this credential away: the person was removed, or this
    /// Mac signed out (`401 {removed: true}`). The one refusal that has this
    /// Mac delete its copy of the workspace, so it is
    /// never inferred — only read off the worker's own word.
    Removed,
    /// The caller's role may not do that (cloud-worker/src/roles.ts).
    Forbidden,
    /// Not bound, or the object is gone.
    NotFound,
    /// Manifest CAS lost: the retry path refetches the manifest rather than
    /// trusting the etag the worker answers with.
    Conflict,
    /// `426`: the worker predates this app's manifest schema — update it.
    Outdated(String),
    /// `409` on a bind: the domain already holds this workspace.
    AlreadyBound(WorkspaceRecord),
    /// `409 {taken}` on a manifest: these public addresses are another
    /// section's on this domain, so the manifest naming them was not stored.
    Taken(Vec<String>),
    /// `429`: the worker's loop catcher says this device is sending too
    /// much. The number is how many seconds it asked for (`Retry-After`).
    Slowed(u64),
    /// Cloudflare's own page for an account past its daily requests (error
    /// 1027): nothing on this domain answers until 00:00 UTC.
    DailyLimit,
    Other(String),
}

impl std::fmt::Display for RemoteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RemoteError::Offline(m) => write!(f, "offline: {}", m),
            RemoteError::Unauthorized => write!(f, "unauthorized"),
            RemoteError::Removed => write!(f, "your access to this workspace was removed"),
            RemoteError::Forbidden => write!(f, "only an owner can do that"),
            RemoteError::NotFound => write!(f, "not found"),
            RemoteError::Conflict => write!(f, "manifest conflict"),
            RemoteError::Outdated(m) => write!(f, "worker outdated: {}", m),
            RemoteError::AlreadyBound(w) => write!(f, "already bound to \"{}\"", w.name),
            RemoteError::Taken(slugs) => write!(f, "already taken on this domain: {}", slugs.join(", ")),
            RemoteError::Slowed(_) => write!(f, "the domain asked this device to slow down"),
            RemoteError::DailyLimit => write!(f, "today's Cloudflare requests are used up"),
            RemoteError::Other(m) => write!(f, "{}", m),
        }
    }
}

pub type RemoteResult<T> = Result<T, RemoteError>;

/* ---------- The trait ---------- */

/// Everything the engine needs from the worker. Methods return
/// `impl Future + Send` (rather than plain `async fn`) so the engine's task
/// stays spawnable on the multithreaded runtime.
pub trait Remote: Send + Sync + 'static {
    /// What this remote — and every space remote made from it — has sent
    /// today: counted as each request goes out.
    fn usage(&self) -> &Usage;
    fn meta(&self) -> impl std::future::Future<Output = RemoteResult<Meta>> + Send;
    fn bind(
        &self,
        name: &str,
        device_name: &str,
    ) -> impl std::future::Future<Output = RemoteResult<Bound>> + Send;
    /// The 15-second poll. With no beat it is a `GET` and writes nothing;
    /// with one it is a `POST` that also says this Mac is here, or leaving.
    fn poll(&self, beat: Option<&Beat>) -> impl std::future::Future<Output = RemoteResult<PollResponse>> + Send;

    /* ----- spaces ----- */

    /// This credential again, with every sync call — the manifest, the
    /// blobs, the version store — aimed at one space: `/api/spaces/<id>/…`,
    /// the same routes behind the domain's membership check. A `NotFound`
    /// from one means this person is not in it, or it is gone; the two are
    /// one answer.
    fn space(&self, id: &str) -> Self
    where
        Self: Sized;

    /// `PUT /api/spaces/private`: this person's Private, made if it was not
    /// there. Answers the same space every time.
    fn ensure_private(&self) -> impl std::future::Future<Output = RemoteResult<SpaceEntry>> + Send;

    /// `POST /api/spaces`: a restricted folder holding its maker and whoever
    /// else is named, by member id — people already in the workspace.
    fn create_space(
        &self,
        name: &str,
        members: &[String],
    ) -> impl std::future::Future<Output = RemoteResult<SpaceEntry>> + Send;

    /// `PATCH /api/spaces/<id>`: rename a restricted folder, for everyone
    /// in it.
    fn rename_space(&self, id: &str, name: &str) -> impl std::future::Future<Output = RemoteResult<()>> + Send;

    /// `PUT /api/spaces/<id>/members/<member>`: add a person to a restricted
    /// folder. Answers the folder as it now is.
    fn add_space_member(
        &self,
        id: &str,
        member: &str,
    ) -> impl std::future::Future<Output = RemoteResult<SpaceEntry>> + Send;

    /// `DELETE /api/spaces/<id>/members/<member>`: take a person out, the
    /// caller included. Refused for the last one in it.
    fn remove_space_member(
        &self,
        id: &str,
        member: &str,
    ) -> impl std::future::Future<Output = RemoteResult<()>> + Send;

    /// `DELETE /api/spaces/<id>`: one round of deleting a restricted folder
    /// and everything it stored; repeat while `remaining`.
    fn delete_space(&self, id: &str) -> impl std::future::Future<Output = RemoteResult<WipeRound>> + Send;
    fn fetch_manifest(
        &self,
        since: Option<&str>,
    ) -> impl std::future::Future<Output = RemoteResult<Option<(Manifest, String)>>> + Send;
    fn put_manifest(
        &self,
        manifest: &Manifest,
        base_etag: &str,
    ) -> impl std::future::Future<Output = RemoteResult<String>> + Send;
    fn get_blob(
        &self,
        file_id: &str,
        hash: &str,
    ) -> impl std::future::Future<Output = RemoteResult<Vec<u8>>> + Send;
    fn put_blob(
        &self,
        file_id: &str,
        hash: &str,
        bytes: Vec<u8>,
        content_type: &str,
    ) -> impl std::future::Future<Output = RemoteResult<()>> + Send;
    /* ----- the version store ----- */

    /// The index and its etag; None when the workspace has never mirrored.
    fn get_versions_index(
        &self,
    ) -> impl std::future::Future<Output = RemoteResult<Option<(VersionsIndex, String)>>> + Send;
    /// CAS the index. `base_etag` is `versions::NO_INDEX` ("*") to create
    /// one; a lost race is `RemoteError::Conflict`.
    fn put_versions_index(
        &self,
        base_etag: &str,
        index: &VersionsIndex,
    ) -> impl std::future::Future<Output = RemoteResult<String>> + Send;
    /// The snapshot's bytes, gzip'd as the device wrote them.
    fn get_version_snapshot(
        &self,
        id: &str,
    ) -> impl std::future::Future<Output = RemoteResult<Vec<u8>>> + Send;
    fn put_version_snapshot(
        &self,
        id: &str,
        gz: Vec<u8>,
    ) -> impl std::future::Future<Output = RemoteResult<()>> + Send;
    fn delete_version_snapshot(&self, id: &str) -> impl std::future::Future<Output = RemoteResult<()>> + Send;
    /// One page of the version blob inventory: (hash, uploaded-at ms) plus
    /// the cursor for the next page, if there is one.
    fn list_version_blobs(
        &self,
        cursor: Option<&str>,
    ) -> impl std::future::Future<Output = RemoteResult<(Vec<(String, u64)>, Option<String>)>> + Send;
    fn get_version_blob(&self, hash: &str) -> impl std::future::Future<Output = RemoteResult<Vec<u8>>> + Send;
    fn put_version_blob(
        &self,
        hash: &str,
        gz: Vec<u8>,
    ) -> impl std::future::Future<Output = RemoteResult<()>> + Send;
    fn delete_version_blob(&self, hash: &str) -> impl std::future::Future<Output = RemoteResult<()>> + Send;

    fn wipe(&self) -> impl std::future::Future<Output = RemoteResult<WipeRound>> + Send;

    /* ----- people ----- */

    /// `POST /api/auth/invites` (owner): put a pending invite on `email`,
    /// creating that person if the address is new, and replacing whatever
    /// invite they had. Only `sha256(code)` goes up — the code itself never
    /// leaves the app.
    fn create_invite(
        &self,
        email: &str,
        name: Option<&str>,
        code_hash: &str,
        expires_at: u64,
    ) -> impl std::future::Future<Output = RemoteResult<InviteRecord>> + Send;

    /// `POST /api/auth/join`: trade a code for this device's own token. The
    /// one call made with **no bearer at all**, because answering it is how
    /// a Mac gets one — so it is also the one call whose `Unauthorized` says
    /// "that code is no good", not "that token is".
    fn redeem(
        &self,
        code: &str,
        device_name: &str,
    ) -> impl std::future::Future<Output = RemoteResult<RedeemedToken>> + Send;

    /// `GET /api/auth/members`: everyone, with a role, a device count and a
    /// last-seen — the People list, which every person here may read.
    fn list_members(&self) -> impl std::future::Future<Output = RemoteResult<Vec<MemberRecord>>> + Send;

    /// `PATCH /api/auth/members/<id>` (owner): make someone an owner, or a
    /// member again. Every Mac they are signed in on carries the new role on
    /// its next request. The worker refuses the caller's own row and the
    /// superadmin's, with a sentence that says which.
    fn set_member_role(
        &self,
        id: &str,
        role: &str,
    ) -> impl std::future::Future<Output = RemoteResult<MemberRecord>> + Send;

    /// `DELETE /api/auth/members/<id>` (owner): the person and every
    /// credential they hold, in one batch. Each of their Macs is told so on
    /// its next request, and deletes its copy. Refused, like a role change,
    /// for the caller's own row and the superadmin's.
    fn delete_member(&self, id: &str) -> impl std::future::Future<Output = RemoteResult<()>> + Send;

    /// `GET /api/auth/invites` (owner): the pending, unexpired ones.
    fn list_invites(&self) -> impl std::future::Future<Output = RemoteResult<Vec<InviteRecord>>> + Send;

    /// `DELETE /api/auth/invites/<id>` (owner): withdraw a code before
    /// anybody trades it in.
    fn delete_invite(&self, id: &str) -> impl std::future::Future<Output = RemoteResult<()>> + Send;

    /// `POST /api/auth/devices/code`: a one-time code for another device of
    /// this person's own, replacing the pending code they had. Only
    /// `sha256(code)` goes up. `POST /api/auth/join` redeems it, as it does
    /// an invite — to the domain it is one, for somebody already here.
    fn device_code(
        &self,
        code_hash: &str,
        expires_at: u64,
    ) -> impl std::future::Future<Output = RemoteResult<()>> + Send;

    /// `GET /api/auth/devices`: this person's signed-in devices — for an
    /// owner, everybody's.
    fn list_devices(&self) -> impl std::future::Future<Output = RemoteResult<Vec<DeviceRecord>>> + Send;

    /// `DELETE /api/auth/devices/<id>` (its person, or an owner — but a
    /// superadmin's device is theirs alone): sign one device out. It takes effect on that device's very next request — the
    /// bearer resolves through the table, so there is no session to expire —
    /// and that device deletes its copy when it hears.
    fn sign_out_device(&self, id: &str) -> impl std::future::Future<Output = RemoteResult<()>> + Send;

    /// `DELETE /api/auth/session`: this device ending its own sign-in. The
    /// domain forgets it and tells it to delete nothing — leaving is not
    /// being shown the door.
    fn end_session(&self) -> impl std::future::Future<Output = RemoteResult<()>> + Send;
}

/* ---------- HTTP remote (the real worker) ---------- */

#[derive(Clone)]
pub struct HttpRemote {
    client: reqwest::Client,
    endpoint: String,
    token: String,
    device_id: String,
    app: String,
    /// `spaces/<id>/` when this remote is one space's (`Remote::space`), and
    /// empty for the shared workspace: what the sync routes sit under.
    scope: String,
    /// Where each request is counted. A remote made for one command, before
    /// a workspace has sync state, counts into a counter nobody keeps.
    usage: Usage,
}

impl HttpRemote {
    /// `app` is what `x-doklin-client` says: which app speaks, and which
    /// version of it (`Setup::client`).
    pub fn new(endpoint: &str, token: &str, device_id: &str, app: &str) -> Self {
        HttpRemote {
            client: http_client(),
            endpoint: endpoint.trim_end_matches('/').to_string(),
            token: token.to_string(),
            device_id: device_id.to_string(),
            app: app.to_string(),
            scope: String::new(),
            usage: Usage::default(),
        }
    }

    /// The same remote, counting into `usage` — the workspace's own count.
    pub fn counted(self, usage: Usage) -> Self {
        HttpRemote { usage, ..self }
    }

    fn url(&self, tail: &str) -> String {
        format!("{}/api/{}", self.endpoint, tail)
    }

    /// A sync route — manifest, blobs, versions — of whichever section this
    /// remote is aimed at.
    fn sync_url(&self, tail: &str) -> String {
        format!("{}/api/{}{}", self.endpoint, self.scope, tail)
    }

    /// The two attribution headers every request carries: which device
    /// speaks (presence, the binding's `createdBy`) and which app version
    /// (the logs). Never authority — `redeem` sends these and nothing else,
    /// because it has nothing else to send.
    fn tags(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        req.header("x-doklin-device", &self.device_id)
            .header("x-doklin-client", &self.app)
    }

    /// The bearer, plus the attribution headers — and the one place every
    /// request with a bearer is counted. Every so often one also says how
    /// many this device has sent today (`x-doklin-used`), which is how the
    /// domain knows what everyone together has spent.
    fn auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let req = self.tags(req).header("authorization", format!("Bearer {}", self.token));
        match self.usage.count() {
            Some(used) => req.header("x-doklin-used", used.to_string()),
            None => req,
        }
    }
}

impl HttpRemote {
    /// `DELETE /api/auth/<kind>/<id>` — the shape all three revocations
    /// take. A `404` is left as it is: the caller decides whether "already
    /// gone" is the same as done (mod.rs: it is).
    fn revoke<'a>(&'a self, kind: &str, id: &str) -> impl std::future::Future<Output = RemoteResult<()>> + Send + 'a {
        let url = self.url(&format!("auth/{}/{}", kind, id));
        async move {
            let res = self.auth(self.client.delete(url)).send().await.map_err(transport_err)?;
            expect_status(res).await.map(|_| ())
        }
    }

    /// One of the identity lists, by its route and the key its body carries.
    fn list_of<'a, T: serde::de::DeserializeOwned + 'a>(
        &'a self,
        kind: &'static str,
    ) -> impl std::future::Future<Output = RemoteResult<Vec<T>>> + Send + 'a {
        let url = self.url(&format!("auth/{}", kind));
        async move {
            let res = self.auth(self.client.get(url)).send().await.map_err(transport_err)?;
            let res = expect_status(res).await?;
            read_list(res, kind).await
        }
    }
}

/// Trading the domain's key. Inherent rather than part of [`Remote`] for the
/// reason the agent routes below are: the engine never trades — the
/// manager's commands do (mod.rs), holding an `HttpRemote` whose bearer is
/// the key.
impl HttpRemote {
    /// `POST /api/auth/recover`: trade the key this remote holds for this
    /// device's own sign-in, as the superadmin — `email`'s person, who
    /// becomes it. The key works once: a spent one, like a wrong one, is
    /// `Unauthorized`.
    pub async fn recover(&self, email: &str, name: Option<&str>, device_name: &str) -> RemoteResult<RedeemedToken> {
        let body = json!({ "email": email, "name": name, "deviceId": self.device_id, "deviceName": device_name });
        let res = self
            .auth(self.client.post(self.url("auth/recover")))
            .header("content-type", "application/json")
            .body(serde_json::to_vec(&body).unwrap_or_default())
            .send()
            .await
            .map_err(transport_err)?;
        let res = expect_status(res).await?;
        res.json::<RedeemedToken>().await.map_err(transport_err)
    }
}

/// A person's agent routes (`/api/auth/agents…`). Inherent rather than part
/// of [`Remote`]: that trait is what the *engine* needs, so that it can run
/// against an in-memory worker, and the engine never manages agents — only
/// the People view's commands do (mod.rs), and they hold an `HttpRemote`.
impl HttpRemote {
    /// `GET /api/auth/agents`: every agent, with its machines and pending code.
    pub async fn list_agents(&self) -> RemoteResult<Vec<AgentRecord>> {
        self.list_of("agents").await
    }

    /// `POST /api/auth/agents`: add an agent with its first login code on
    /// it. Only `sha256(code)` goes up, as with an invite.
    pub async fn create_agent(
        &self,
        name: &str,
        scopes: &[String],
        code_hash: &str,
        expires_at: u64,
    ) -> RemoteResult<AgentRecord> {
        let body = json!({ "name": name, "scopes": scopes, "codeHash": code_hash, "expiresAt": expires_at });
        let v = self.post_json("auth/agents", &body).await?;
        serde_json::from_value(v.get("agent").cloned().unwrap_or_default())
            .map_err(|e| RemoteError::Other(format!("the domain's answer wasn't an agent: {}", e)))
    }

    /// `POST /api/auth/agents/<id>`: rename it, or change what it may do.
    /// Takes effect on the agent's next request.
    pub async fn update_agent(&self, id: &str, name: Option<&str>, scopes: Option<&[String]>) -> RemoteResult<()> {
        let mut body = serde_json::Map::new();
        if let Some(name) = name {
            body.insert("name".into(), json!(name));
        }
        if let Some(scopes) = scopes {
            body.insert("scopes".into(), json!(scopes));
        }
        self.post_json(&format!("auth/agents/{}", id), &serde_json::Value::Object(body)).await.map(|_| ())
    }

    /// `POST /api/auth/agents/<id>/code`: a fresh login code, replacing any
    /// the agent had — for another machine, or after the first ran out.
    pub async fn new_agent_code(&self, id: &str, code_hash: &str, expires_at: u64) -> RemoteResult<AgentCode> {
        let body = json!({ "codeHash": code_hash, "expiresAt": expires_at });
        let v = self.post_json(&format!("auth/agents/{}/code", id), &body).await?;
        serde_json::from_value(v.get("code").cloned().unwrap_or_default())
            .map_err(|e| RemoteError::Other(format!("the domain's answer wasn't a login code: {}", e)))
    }

    /// `DELETE /api/auth/agents/<id>`: the agent and every token it holds.
    pub async fn delete_agent(&self, id: &str) -> RemoteResult<()> {
        self.revoke("agents", id).await
    }

    /// `DELETE /api/auth/agents/<id>/tokens/<tid>`: log one machine out.
    pub async fn delete_agent_machine(&self, agent_id: &str, token_id: &str) -> RemoteResult<()> {
        self.revoke(&format!("agents/{}/tokens", agent_id), token_id).await
    }

    /// `PUT /api/settings/plan`: the Cloudflare plan the domain's account is
    /// on, which the worker derives every limit from. The superadmin's.
    pub async fn set_plan(&self, plan: &str) -> RemoteResult<()> {
        let body = serde_json::to_vec(&json!({ "plan": plan })).unwrap_or_default();
        let res = self
            .auth(self.client.put(self.url("settings/plan")))
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await
            .map_err(transport_err)?;
        expect_status(res).await.map(|_| ())
    }

    /// `GET /api/pages`: every public address on the domain, whichever
    /// section published the page — an owner's to read.
    pub async fn list_every_page(&self) -> RemoteResult<EveryPages> {
        let res = self.auth(self.client.get(self.url("pages"))).send().await.map_err(transport_err)?;
        let res = expect_status(res).await?;
        res.json::<EveryPages>().await.map_err(transport_err)
    }

    /// `DELETE /api/pages/<slug>`: take a page down, whoever published it.
    pub async fn take_down_page(&self, slug: &str) -> RemoteResult<()> {
        let res = self.auth(self.client.delete(self.url(&format!("pages/{}", slug)))).send().await.map_err(transport_err)?;
        expect_status(res).await.map(|_| ())
    }

    /// POST a JSON body with the bearer and read the JSON answer.
    async fn post_json(&self, tail: &str, body: &serde_json::Value) -> RemoteResult<serde_json::Value> {
        let res = self
            .auth(self.client.post(self.url(tail)))
            .header("content-type", "application/json")
            .body(serde_json::to_vec(body).unwrap_or_default())
            .send()
            .await
            .map_err(transport_err)?;
        let res = expect_status(res).await?;
        res.json::<serde_json::Value>().await.map_err(transport_err)
    }
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .connect_timeout(Duration::from_secs(10))
        .build()
        .expect("reqwest client")
}

fn transport_err(e: reqwest::Error) -> RemoteError {
    RemoteError::Offline(e.to_string())
}

fn body_error(v: &serde_json::Value) -> Option<String> {
    v.get("error").and_then(|e| e.as_str()).map(String::from)
}

/// `{ "<key>": [...] }` — the shape every identity list answers with. A key
/// that is missing reads as an empty list: a domain with nobody on it and a
/// domain that named the array differently are not worth telling apart here,
/// because the routes that answer this are the ones `list_members` already
/// proved exist.
async fn read_list<T: serde::de::DeserializeOwned>(res: reqwest::Response, key: &str) -> RemoteResult<Vec<T>> {
    let v = res.json::<serde_json::Value>().await.map_err(transport_err)?;
    serde_json::from_value(v.get(key).cloned().unwrap_or_else(|| json!([])))
        .map_err(|e| RemoteError::Other(format!("the domain's {} didn't parse: {}", key, e)))
}

/// `{ "space": {...} }` — what the spaces routes answer a change with.
fn read_space_value(v: serde_json::Value) -> RemoteResult<SpaceEntry> {
    serde_json::from_value(v.get("space").cloned().unwrap_or_default())
        .map_err(|e| RemoteError::Other(format!("the domain's answer about that folder didn't parse: {}", e)))
}

async fn read_space(res: reqwest::Response) -> RemoteResult<SpaceEntry> {
    read_space_value(res.json::<serde_json::Value>().await.map_err(transport_err)?)
}

async fn expect_status(res: reqwest::Response) -> RemoteResult<reqwest::Response> {
    let status = res.status().as_u16();
    if matches!(status, 200..=299 | 304) {
        return Ok(res);
    }
    let retry_after = res
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok());
    let body = res.text().await.unwrap_or_default();
    let v: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
    // Cloudflare answers for an account past its daily requests before the
    // worker runs, with a page of its own. Its status is not documented, so
    // it is known by what it says.
    if v.is_null() && names_daily_limit(&body) {
        return Err(RemoteError::DailyLimit);
    }
    // The worker's own sentence for a status whose body carries one, so what
    // the user reads is what the worker said ("this domain has no database —
    // update the worker") rather than a code with a sentence stapled to it.
    let said = |fallback: &str| body_error(&v).unwrap_or_else(|| fallback.to_string());
    Err(match status {
        400 => RemoteError::Other(said("the domain refused that")),
        // Two refusals share the status, and only the body tells them apart:
        // `removed: true` is said of a credential an owner took away, and of
        // nothing else. Anything that is not exactly that — no body, a
        // proxy's page — is the ordinary one.
        401 => match v.get("removed").and_then(|r| r.as_bool()) {
            Some(true) => RemoteError::Removed,
            _ => RemoteError::Unauthorized,
        },
        403 => RemoteError::Forbidden,
        404 => RemoteError::NotFound,
        409 => {
            let taken: Option<Vec<String>> = v.get("taken").cloned().and_then(|t| serde_json::from_value(t).ok());
            match v.get("workspace").cloned().and_then(|w| serde_json::from_value(w).ok()) {
                Some(record) => RemoteError::AlreadyBound(record),
                None => match taken.filter(|slugs| !slugs.is_empty()) {
                    Some(slugs) => RemoteError::Taken(slugs),
                    None => RemoteError::Other(said("conflict")),
                },
            }
        }
        412 => RemoteError::Conflict,
        426 => RemoteError::Outdated(said("the worker predates this app's manifest")),
        429 => RemoteError::Slowed(retry_after.unwrap_or(60)),
        // Identity is the database, so a deployment with no `DB` binding says
        // so here rather than pretending nobody has been invited.
        503 => RemoteError::Other(said("the domain is unavailable")),
        code => RemoteError::Other(format!(
            "http {}: {}",
            code,
            body_error(&v).unwrap_or_else(|| body.chars().take(200).collect())
        )),
    })
}

/// Cloudflare's error page for error 1027 — an account's Workers past their
/// daily requests ("error code: 1027", "Error 1027").
pub(crate) fn names_daily_limit(body: &str) -> bool {
    body.contains("1027")
}

impl Remote for HttpRemote {
    fn usage(&self) -> &Usage {
        &self.usage
    }

    fn meta(&self) -> impl std::future::Future<Output = RemoteResult<Meta>> + Send {
        async move {
            let res = self.auth(self.client.get(self.url("meta"))).send().await.map_err(transport_err)?;
            let res = expect_status(res).await.map_err(|e| match e {
                // Only a worker answers /api/meta; anything else lives here.
                RemoteError::NotFound => RemoteError::Other("no Doklin cloud worker answers at that address".into()),
                other => other,
            })?;
            let v = res.json::<serde_json::Value>().await.map_err(|_| {
                RemoteError::Other("that address isn't a Doklin cloud worker".into())
            })?;
            serde_json::from_value::<Meta>(v)
                .map_err(|_| RemoteError::Other("that address isn't a Doklin cloud worker".into()))
        }
    }

    fn bind(
        &self,
        name: &str,
        device_name: &str,
    ) -> impl std::future::Future<Output = RemoteResult<Bound>> + Send {
        let body = json!({ "name": name, "deviceName": device_name });
        async move {
            let res = self
                .auth(self.client.post(self.url("workspace")))
                .header("content-type", "application/json")
                .body(serde_json::to_vec(&body).unwrap_or_default())
                .send()
                .await
                .map_err(transport_err)?;
            let res = expect_status(res).await?;
            let v = res.json::<serde_json::Value>().await.map_err(transport_err)?;
            let manifest_etag = v
                .get("manifestEtag")
                .and_then(|e| e.as_str())
                .unwrap_or_default()
                .to_string();
            let workspace: WorkspaceRecord = serde_json::from_value(v.clone())
                .map_err(|_| RemoteError::Other("bind returned no workspace record".into()))?;
            if manifest_etag.is_empty() || workspace.id.is_empty() {
                return Err(RemoteError::Other("bind returned no id/etag".into()));
            }
            Ok(Bound { workspace, manifest_etag })
        }
    }

    fn poll(&self, beat: Option<&Beat>) -> impl std::future::Future<Output = RemoteResult<PollResponse>> + Send {
        let body = beat.map(Beat::body);
        async move {
            let req = match &body {
                None => self.client.get(self.url("poll")),
                Some(body) => self
                    .client
                    .post(self.url("poll"))
                    .header("content-type", "application/json")
                    .body(serde_json::to_vec(body).unwrap_or_default()),
            };
            let res = self.auth(req).send().await.map_err(transport_err)?;
            let res = expect_status(res).await?;
            res.json::<PollResponse>().await.map_err(transport_err)
        }
    }

    fn space(&self, id: &str) -> Self {
        HttpRemote { scope: format!("spaces/{}/", id), ..self.clone() }
    }

    fn ensure_private(&self) -> impl std::future::Future<Output = RemoteResult<SpaceEntry>> + Send {
        async move {
            let res =
                self.auth(self.client.put(self.url("spaces/private"))).send().await.map_err(transport_err)?;
            read_space(expect_status(res).await?).await
        }
    }

    fn create_space(
        &self,
        name: &str,
        members: &[String],
    ) -> impl std::future::Future<Output = RemoteResult<SpaceEntry>> + Send {
        let body = json!({ "name": name, "members": members });
        async move { read_space_value(self.post_json("spaces", &body).await?) }
    }

    fn add_space_member(
        &self,
        id: &str,
        member: &str,
    ) -> impl std::future::Future<Output = RemoteResult<SpaceEntry>> + Send {
        let url = self.url(&format!("spaces/{}/members/{}", id, member));
        async move {
            let res = self.auth(self.client.put(url)).send().await.map_err(transport_err)?;
            read_space(expect_status(res).await?).await
        }
    }

    fn remove_space_member(
        &self,
        id: &str,
        member: &str,
    ) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        let url = self.url(&format!("spaces/{}/members/{}", id, member));
        async move {
            let res = self.auth(self.client.delete(url)).send().await.map_err(transport_err)?;
            expect_status(res).await.map(|_| ())
        }
    }

    fn delete_space(&self, id: &str) -> impl std::future::Future<Output = RemoteResult<WipeRound>> + Send {
        let url = self.url(&format!("spaces/{}", id));
        async move {
            let res = self.auth(self.client.delete(url)).send().await.map_err(transport_err)?;
            let res = expect_status(res).await?;
            res.json::<WipeRound>().await.map_err(transport_err)
        }
    }

    fn rename_space(&self, id: &str, name: &str) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        let url = self.url(&format!("spaces/{}", id));
        let body = serde_json::to_vec(&json!({ "name": name })).unwrap_or_default();
        async move {
            let res = self
                .auth(self.client.patch(url))
                .header("content-type", "application/json")
                .body(body)
                .send()
                .await
                .map_err(transport_err)?;
            expect_status(res).await.map(|_| ())
        }
    }

    fn fetch_manifest(
        &self,
        since: Option<&str>,
    ) -> impl std::future::Future<Output = RemoteResult<Option<(Manifest, String)>>> + Send {
        let since = since.map(String::from);
        async move {
            let mut req = self.client.get(self.sync_url("manifest"));
            if let Some(s) = &since {
                req = req.query(&[("since", s.as_str())]);
            }
            let res = self.auth(req).send().await.map_err(transport_err)?;
            if res.status().as_u16() == 304 {
                return Ok(None);
            }
            let res = expect_status(res).await?;
            let etag = res
                .headers()
                .get("x-manifest-etag")
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_string();
            let manifest = res
                .json::<Manifest>()
                .await
                .map_err(|e| RemoteError::Other(format!("unreadable manifest: {}", e)))?;
            Ok(Some((manifest, etag)))
        }
    }

    fn put_manifest(
        &self,
        manifest: &Manifest,
        base_etag: &str,
    ) -> impl std::future::Future<Output = RemoteResult<String>> + Send {
        let body = serde_json::to_vec(manifest).unwrap_or_default();
        let base = base_etag.to_string();
        async move {
            let res = self
                .auth(self.client.put(self.sync_url("manifest")))
                .header("x-base-etag", base)
                .header("content-type", "application/json")
                .body(body)
                .send()
                .await
                .map_err(transport_err)?;
            let res = expect_status(res).await?;
            let v = res.json::<serde_json::Value>().await.map_err(transport_err)?;
            Ok(v.get("etag").and_then(|e| e.as_str()).unwrap_or_default().to_string())
        }
    }

    fn get_blob(
        &self,
        file_id: &str,
        hash: &str,
    ) -> impl std::future::Future<Output = RemoteResult<Vec<u8>>> + Send {
        let url = self.sync_url(&format!("blobs/{}/{}", file_id, hash));
        async move {
            let res = self.auth(self.client.get(url)).send().await.map_err(transport_err)?;
            let res = expect_status(res).await?;
            Ok(res.bytes().await.map_err(transport_err)?.to_vec())
        }
    }

    fn put_blob(
        &self,
        file_id: &str,
        hash: &str,
        bytes: Vec<u8>,
        content_type: &str,
    ) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        let url = self.sync_url(&format!("blobs/{}/{}", file_id, hash));
        let ct = content_type.to_string();
        async move {
            let res = self
                .auth(self.client.put(url))
                .header("content-type", ct)
                .body(bytes)
                .send()
                .await
                .map_err(transport_err)?;
            expect_status(res).await.map(|_| ())
        }
    }

    fn get_versions_index(
        &self,
    ) -> impl std::future::Future<Output = RemoteResult<Option<(VersionsIndex, String)>>> + Send {
        async move {
            let res =
                self.auth(self.client.get(self.sync_url("versions/index"))).send().await.map_err(transport_err)?;
            match expect_status(res).await {
                Ok(res) => {
                    let etag = res
                        .headers()
                        .get("x-versions-etag")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or_default()
                        .to_string();
                    let index = res
                        .json::<VersionsIndex>()
                        .await
                        .map_err(|e| RemoteError::Other(format!("unreadable versions index: {}", e)))?;
                    Ok(Some((index, etag)))
                }
                Err(RemoteError::NotFound) => Ok(None),
                Err(e) => Err(e),
            }
        }
    }

    fn put_versions_index(
        &self,
        base_etag: &str,
        index: &VersionsIndex,
    ) -> impl std::future::Future<Output = RemoteResult<String>> + Send {
        let body = serde_json::to_vec(index).unwrap_or_default();
        let base = base_etag.to_string();
        async move {
            let res = self
                .auth(self.client.put(self.sync_url("versions/index")))
                .header("x-base-etag", base)
                .header("content-type", "application/json")
                .body(body)
                .send()
                .await
                .map_err(transport_err)?;
            let res = expect_status(res).await?;
            let v = res.json::<serde_json::Value>().await.map_err(transport_err)?;
            Ok(v.get("etag").and_then(|e| e.as_str()).unwrap_or_default().to_string())
        }
    }

    fn get_version_snapshot(&self, id: &str) -> impl std::future::Future<Output = RemoteResult<Vec<u8>>> + Send {
        let url = self.sync_url(&format!("versions/snapshots/{}", id));
        async move {
            let res = self.auth(self.client.get(url)).send().await.map_err(transport_err)?;
            let res = expect_status(res).await?;
            Ok(res.bytes().await.map_err(transport_err)?.to_vec())
        }
    }

    fn put_version_snapshot(
        &self,
        id: &str,
        gz: Vec<u8>,
    ) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        let url = self.sync_url(&format!("versions/snapshots/{}", id));
        async move {
            let res = self
                .auth(self.client.put(url))
                .header("content-type", "application/gzip")
                .body(gz)
                .send()
                .await
                .map_err(transport_err)?;
            expect_status(res).await.map(|_| ())
        }
    }

    fn delete_version_snapshot(&self, id: &str) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        let url = self.sync_url(&format!("versions/snapshots/{}", id));
        async move {
            let res = self.auth(self.client.delete(url)).send().await.map_err(transport_err)?;
            expect_status(res).await.map(|_| ())
        }
    }

    fn list_version_blobs(
        &self,
        cursor: Option<&str>,
    ) -> impl std::future::Future<Output = RemoteResult<(Vec<(String, u64)>, Option<String>)>> + Send {
        let cursor = cursor.map(String::from);
        async move {
            let mut req = self.client.get(self.sync_url("versions/blobs"));
            if let Some(c) = &cursor {
                req = req.query(&[("cursor", c.as_str())]);
            }
            let res = self.auth(req).send().await.map_err(transport_err)?;
            let res = expect_status(res).await?;
            let v = res.json::<serde_json::Value>().await.map_err(transport_err)?;
            let blobs = v
                .get("blobs")
                .and_then(|b| b.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|b| {
                            let hash = b.get("hash")?.as_str()?.to_string();
                            let uploaded = b
                                .get("uploaded")
                                .and_then(|u| u.as_str())
                                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                                .map(|d| d.timestamp_millis() as u64)
                                .unwrap_or(0);
                            Some((hash, uploaded))
                        })
                        .collect()
                })
                .unwrap_or_default();
            let next = v.get("cursor").and_then(|c| c.as_str()).map(String::from);
            Ok((blobs, next))
        }
    }

    fn get_version_blob(&self, hash: &str) -> impl std::future::Future<Output = RemoteResult<Vec<u8>>> + Send {
        let url = self.sync_url(&format!("versions/blobs/{}", hash));
        async move {
            let res = self.auth(self.client.get(url)).send().await.map_err(transport_err)?;
            let res = expect_status(res).await?;
            Ok(res.bytes().await.map_err(transport_err)?.to_vec())
        }
    }

    fn put_version_blob(&self, hash: &str, gz: Vec<u8>) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        let url = self.sync_url(&format!("versions/blobs/{}", hash));
        async move {
            let res = self
                .auth(self.client.put(url))
                .header("content-type", "application/gzip")
                .body(gz)
                .send()
                .await
                .map_err(transport_err)?;
            expect_status(res).await.map(|_| ())
        }
    }

    fn delete_version_blob(&self, hash: &str) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        let url = self.sync_url(&format!("versions/blobs/{}", hash));
        async move {
            let res = self.auth(self.client.delete(url)).send().await.map_err(transport_err)?;
            expect_status(res).await.map(|_| ())
        }
    }

    fn wipe(&self) -> impl std::future::Future<Output = RemoteResult<WipeRound>> + Send {
        async move {
            let res = self
                .auth(self.client.post(self.url("admin/wipe")))
                .header("content-type", "application/json")
                .body(r#"{"confirm":"wipe"}"#)
                .send()
                .await
                .map_err(transport_err)?;
            let res = expect_status(res).await?;
            res.json::<WipeRound>().await.map_err(transport_err)
        }
    }

    fn create_invite(
        &self,
        email: &str,
        name: Option<&str>,
        code_hash: &str,
        expires_at: u64,
    ) -> impl std::future::Future<Output = RemoteResult<InviteRecord>> + Send {
        let body = json!({ "email": email, "name": name, "codeHash": code_hash, "expiresAt": expires_at });
        async move {
            let res = self
                .auth(self.client.post(self.url("auth/invites")))
                .header("content-type", "application/json")
                .body(serde_json::to_vec(&body).unwrap_or_default())
                .send()
                .await
                .map_err(transport_err)?;
            let res = expect_status(res).await?;
            let v = res.json::<serde_json::Value>().await.map_err(transport_err)?;
            serde_json::from_value(v.get("invite").cloned().unwrap_or_default())
                .map_err(|e| RemoteError::Other(format!("the domain's answer wasn't an invite: {}", e)))
        }
    }

    fn redeem(
        &self,
        code: &str,
        device_name: &str,
    ) -> impl std::future::Future<Output = RemoteResult<RedeemedToken>> + Send {
        // No bearer: this is the route above the worker's auth gate. The
        // device id rides in the body rather than the header it usually
        // does, because nothing has authenticated it to read a header from.
        let body = json!({ "code": code, "deviceId": self.device_id, "deviceName": device_name });
        async move {
            let res = self
                .tags(self.client.post(self.url("auth/join")))
                .header("content-type", "application/json")
                .body(serde_json::to_vec(&body).unwrap_or_default())
                .send()
                .await
                .map_err(transport_err)?;
            let res = expect_status(res).await?;
            res.json::<RedeemedToken>().await.map_err(transport_err)
        }
    }
    fn list_members(&self) -> impl std::future::Future<Output = RemoteResult<Vec<MemberRecord>>> + Send {
        self.list_of("members")
    }

    fn set_member_role(
        &self,
        id: &str,
        role: &str,
    ) -> impl std::future::Future<Output = RemoteResult<MemberRecord>> + Send {
        let url = self.url(&format!("auth/members/{}", id));
        let body = json!({ "role": role });
        async move {
            let res = self
                .auth(self.client.patch(url))
                .header("content-type", "application/json")
                .body(serde_json::to_vec(&body).unwrap_or_default())
                .send()
                .await
                .map_err(transport_err)?;
            let res = expect_status(res).await?;
            let v = res.json::<serde_json::Value>().await.map_err(transport_err)?;
            serde_json::from_value(v.get("member").cloned().unwrap_or_default())
                .map_err(|e| RemoteError::Other(format!("the domain's answer wasn't a person: {}", e)))
        }
    }

    fn delete_member(&self, id: &str) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        self.revoke("members", id)
    }

    fn list_invites(&self) -> impl std::future::Future<Output = RemoteResult<Vec<InviteRecord>>> + Send {
        self.list_of("invites")
    }

    fn delete_invite(&self, id: &str) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        self.revoke("invites", id)
    }

    fn device_code(
        &self,
        code_hash: &str,
        expires_at: u64,
    ) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        let body = json!({ "codeHash": code_hash, "expiresAt": expires_at });
        async move {
            let res = self
                .auth(self.client.post(self.url("auth/devices/code")))
                .header("content-type", "application/json")
                .body(serde_json::to_vec(&body).unwrap_or_default())
                .send()
                .await
                .map_err(transport_err)?;
            expect_status(res).await.map(|_| ())
        }
    }

    fn list_devices(&self) -> impl std::future::Future<Output = RemoteResult<Vec<DeviceRecord>>> + Send {
        self.list_of("devices")
    }

    fn sign_out_device(&self, id: &str) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        self.revoke("devices", id)
    }

    fn end_session(&self) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        let url = self.url("auth/session");
        async move {
            let res = self.auth(self.client.delete(url)).send().await.map_err(transport_err)?;
            expect_status(res).await.map(|_| ())
        }
    }
}
