//! The whole engine against an in-memory worker: the two-device matrix
//! (merges, conflicts, tombstones, renames, history, the CAS race), the
//! public map (mirroring, rename-follow, re-bind, folder re-point, the
//! custom-slug race, the root page), the flows (bind-once, upload and
//! download, resume in place), the timings (a touch settles faster than a
//! watched write), the worker-outdated state, presence, the edit bus, and
//! the worker as a third writer of the manifest (an agent's changes).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::bus::EditBus;
use super::config::{
    normalize_endpoint, read_cloud_file, read_marker, write_cloud_file, write_marker, CloudFile, Marker,
    WorkspaceEntry,
};
use super::engine::{
    next_wake, Engine, EngineCmd, EngineConfig, PublishRequest, WorkspaceState, DIRECTORY_MIN_GAP,
    ACTIVITY_FRESH, LEGACY_BATCH, POLL_INTERVAL, PRESENCE_BEAT,
};
use super::flows::{bind_domain, seed_download, seed_upload, wipe_all, FlowError};
use super::invite;
use super::manifest::*;
use super::remote::*;
use super::scan::{hash16, now_ms, random_id, scan_local};
use super::status::*;
use super::versions::{snapshot_id, VersionsEntry, VersionsIndex, CLOUD_GC_GRACE_MS, MIRROR_EVERY, NO_INDEX};
use crate::versions::store::{
    digest_of, hash_full, FileEntry, Index, Reason, Snapshot, SnapshotRow, Store, STORE_VERSION,
};

/* ---------- The in-memory worker ---------- */

/// A stand-in for the worker: the binding, a manifest with CAS-by-etag,
/// content-addressed blobs (each with the time it landed, so a grace period
/// is testable), presence and the polls that carry it. `racer` lets a test
/// inject "another device won the CAS between your fetch and your put";
/// `reject_schema` plays a worker that predates the app's manifest.
#[derive(Default)]
struct FakeWorker {
    bound: Option<WorkspaceRecord>,
    manifest: Manifest,
    etag: u64,
    blobs: HashMap<(String, String), (Vec<u8>, u64)>,
    presence: BTreeMap<String, PresenceEntry>,
    /// Lease key (lowercased path) -> who holds it, as the `leases` table
    /// does: one row per document, the upsert's three ways to win spelled out
    /// in `poll` below. `until` is on the real clock, so a test lapses one by
    /// writing it into the past.
    leases: BTreeMap<String, LeaseEntry>,
    /// A database that cannot answer: the poll still answers the etag, with
    /// no presence and `leases: null`.
    d1_down: bool,
    offline: bool,
    reject_schema: bool,
    worker_version: u32,
    features: Vec<String>,
    racer: Option<Manifest>,
    put_manifest_calls: u64,
    /// Every blob a device asked for — what "a move fetches no bytes" is
    /// counted in.
    blob_gets: u64,
    /// Every request that reached the worker — what "an idle Mac makes four
    /// requests a minute" is counted in.
    requests: u64,
    /// Every poll, with the beat it carried: `None` is a `GET`, which writes
    /// nothing. Since v7 there is no other way for a beat to arrive.
    polls: Vec<Option<Beat>>,
    /// How many times `/api/meta` was asked — the directory rides on it, so
    /// this is what makes "ask again, but not every cycle" testable.
    meta_calls: u64,
    /* The version store (docs/versioning.md §6.4): its own CAS'd index,
       immutable snapshots and blobs, with an upload time per blob so the
       cloud sweep's grace period is testable. */
    versions_index: Option<VersionsIndex>,
    versions_etag: u64,
    version_snapshots: HashMap<String, Vec<u8>>,
    version_blobs: HashMap<String, (Vec<u8>, u64)>,
    versions_racer: Option<VersionsIndex>,
    /* People and the credentials they hold (docs/cloud.md §8.1). The
       worker keeps only hashes; so does this — a code is looked up by its
       sha256 here exactly as it is there, which is what makes "the app hashes
       the canonical form" a thing a test can get wrong. */
    owner_token: String,
    /// By normalized email — a person is found by their address, so
    /// re-inviting one reaches the same row.
    members: BTreeMap<String, MemberRecord>,
    /// sha256(code) -> the pending invite. One per person, at most.
    invites: BTreeMap<String, InviteRecord>,
    /// token -> the row that resolves it. Deleting the entry is revoking it,
    /// and it bites on that Mac's next call because every call comes through
    /// `ready` — which is the whole of what a session would have been.
    tokens: BTreeMap<String, TokenRecord>,
    /// Agent id -> name (docs/cloud.md §8.3). All the engine ever learns of
    /// an agent: `/api/meta` lists them after the people, so an `a-` id in a
    /// manifest gets a name the same way an `m-` id does.
    agents: BTreeMap<String, String>,
    next_id: u64,
}

/// The owner's env secret, as the fake holds it: matched with no row read,
/// so it keeps working whatever happens to the people above.
const OWNER_TOKEN: &str = "owner-secret-token";

/// Who a bearer is, the way the worker decides it (docs/cloud.md §5.4).
#[derive(Clone, Copy, PartialEq, Debug)]
enum Caller {
    Owner,
    Member,
}

impl FakeWorker {
    fn etag_str(&self) -> String {
        format!("e{}", self.etag)
    }
}

type SharedWorker = Arc<Mutex<FakeWorker>>;

fn fake_worker() -> SharedWorker {
    Arc::new(Mutex::new(FakeWorker {
        worker_version: 1,
        features: vec![
            "sync".into(),
            "wipe".into(),
            "versions".into(),
            "members".into(),
            "presence".into(),
            "leases".into(),
        ],
        owner_token: OWNER_TOKEN.into(),
        ..Default::default()
    }))
}

#[derive(Clone)]
struct FakeRemote {
    be: SharedWorker,
    device_id: String,
    /// The bearer this device speaks with — the owner secret unless a test
    /// says otherwise, which is what most of them are.
    token: String,
}

impl FakeRemote {
    fn new(be: &SharedWorker, device_id: &str) -> Self {
        FakeRemote { be: be.clone(), device_id: device_id.to_string(), token: OWNER_TOKEN.to_string() }
    }

    /// A device holding a token somebody redeemed, rather than the secret.
    fn with_token(be: &SharedWorker, device_id: &str, token: &str) -> Self {
        FakeRemote { be: be.clone(), device_id: device_id.to_string(), token: token.to_string() }
    }

    fn check_offline(&self) -> RemoteResult<()> {
        let mut be = self.be.lock().unwrap();
        be.requests += 1;
        if be.offline {
            Err(RemoteError::Offline("fake worker down".into()))
        } else {
            Ok(())
        }
    }

    /// Offline, then the bearer. Every gated route goes through here, so a
    /// token nobody minted is refused everywhere at once — and the secret is
    /// matched first, with no row read, exactly as the worker matches it.
    fn ready(&self) -> RemoteResult<Caller> {
        self.check_offline()?;
        let be = self.be.lock().unwrap();
        if self.token == be.owner_token {
            return Ok(Caller::Owner);
        }
        if be.tokens.contains_key(&self.token) {
            return Ok(Caller::Member);
        }
        Err(RemoteError::Unauthorized)
    }

    /// The owner-only routes: bind, wipe, and everything under /api/auth.
    fn owner_only(&self) -> RemoteResult<()> {
        match self.ready()? {
            Caller::Owner => Ok(()),
            Caller::Member => Err(RemoteError::Forbidden),
        }
    }

    /// The next `<prefix>-<n>` id this fake hands out.
    fn mint_id(be: &mut FakeWorker, prefix: &str) -> String {
        be.next_id += 1;
        format!("{}-{:08x}", prefix, be.next_id)
    }
}

impl Remote for FakeRemote {
    fn meta(&self) -> impl std::future::Future<Output = RemoteResult<Meta>> + Send {
        let this = self.clone();
        async move {
            let caller = this.ready()?;
            let mut b = this.be.lock().unwrap();
            b.meta_calls += 1;
            // Identity, the way v6 answers it: a member's comes off the row
            // their token resolved to, and the owner's off whichever row
            // holds the role — none, on a domain where nobody adopted one.
            let me = match caller {
                Caller::Owner => b.members.values().find(|m| m.role == "owner").cloned(),
                Caller::Member => {
                    b.tokens.get(&this.token).and_then(|t| b.members.get(&t.email)).cloned()
                }
            };
            let you = Some(Identity {
                role: match caller {
                    Caller::Owner => "owner".into(),
                    Caller::Member => "member".into(),
                },
                member_id: me.as_ref().map(|m| m.id.clone()),
                email: me.as_ref().map(|m| m.email.clone()),
                name: me.map(|m| m.name).unwrap_or_else(|| "Owner".into()),
            });
            // People, then agents — `listDirectory` (cloud-worker/src/members.ts).
            let people = b
                .members
                .values()
                .map(|m| Person { id: m.id.clone(), name: m.name.clone() })
                .chain(b.agents.iter().map(|(id, name)| Person { id: id.clone(), name: name.clone() }))
                .collect();
            Ok(Meta {
                version: b.worker_version,
                features: b.features.clone(),
                workspace: b.bound.clone(),
                you,
                people,
            })
        }
    }

    fn bind(&self, name: &str, device_name: &str) -> impl std::future::Future<Output = RemoteResult<Bound>> + Send {
        let this = self.clone();
        let name = name.to_string();
        let device_name = device_name.to_string();
        async move {
            this.owner_only()?;
            let mut b = this.be.lock().unwrap();
            if let Some(w) = &b.bound {
                return Err(RemoteError::AlreadyBound(w.clone()));
            }
            b.manifest = Manifest { name: name.clone(), ..Default::default() };
            b.etag += 1;
            let record = WorkspaceRecord {
                id: format!("w-{}", b.etag),
                name,
                created_at: "2026-09-03T00:00:00Z".into(),
                created_by: CreatedBy { device_id: Some(this.device_id.clone()), device_name },
            };
            b.bound = Some(record.clone());
            Ok(Bound { workspace: record, manifest_etag: b.etag_str() })
        }
    }

    fn poll(&self, beat: Option<&Beat>) -> impl std::future::Future<Output = RemoteResult<PollResponse>> + Send {
        let this = self.clone();
        let beat = beat.cloned();
        async move {
            let caller = this.ready()?;
            let mut b = this.be.lock().unwrap();
            if beat.is_some() && !b.features.iter().any(|f| f == "presence") {
                // A worker before v7: the poll is GET-only.
                return Err(RemoteError::Other("http 405: method not allowed".into()));
            }
            b.polls.push(beat.clone());
            if b.d1_down {
                return Ok(PollResponse { manifest_etag: b.etag_str(), presence: BTreeMap::new(), leases: None });
            }
            let leasing = b.features.iter().any(|f| f == "leases");
            let now = now_ms();
            let me = this.device_id.clone();
            match beat {
                None => {}
                Some(Beat::Leave) => {
                    b.presence.remove(&me);
                    b.leases.retain(|_, l| l.device_id != me);
                }
                Some(Beat::Here { name, path, take }) => {
                    // Whose Mac it is, the way the worker decides: off the
                    // token for a member, off the adopted row for the owner.
                    let member_id = match caller {
                        Caller::Owner => b.members.values().find(|m| m.role == "owner").map(|m| m.id.clone()),
                        Caller::Member => b
                            .tokens
                            .get(&this.token)
                            .and_then(|t| b.members.get(&t.email))
                            .map(|m| m.id.clone()),
                    };
                    b.presence.insert(
                        me.clone(),
                        PresenceEntry { member_id: member_id.clone(), name: name.clone(), path: path.clone(), ts: now },
                    );
                    if leasing {
                        let key = path.as_deref().map(lease_key);
                        b.leases.retain(|k, l| l.device_id != me || Some(k) == key.as_ref());
                        if let Some(key) = key {
                            let free = b
                                .leases
                                .get(&key)
                                .map(|l| l.device_id == me || l.until <= now || take)
                                .unwrap_or(true);
                            if free {
                                b.leases.insert(
                                    key.clone(),
                                    LeaseEntry { path: key, device_id: me, member_id, name, until: now + 90_000 },
                                );
                            }
                        }
                    }
                }
            }
            let leases = leasing.then(|| b.leases.values().filter(|l| l.until > now).cloned().collect());
            Ok(PollResponse { manifest_etag: b.etag_str(), presence: b.presence.clone(), leases })
        }
    }

    fn fetch_manifest(
        &self,
        since: Option<&str>,
    ) -> impl std::future::Future<Output = RemoteResult<Option<(Manifest, String)>>> + Send {
        let this = self.clone();
        let since = since.map(String::from);
        async move {
            this.ready()?;
            let b = this.be.lock().unwrap();
            if since.as_deref() == Some(b.etag_str().as_str()) {
                return Ok(None);
            }
            Ok(Some((b.manifest.clone(), b.etag_str())))
        }
    }

    fn put_manifest(
        &self,
        manifest: &Manifest,
        base_etag: &str,
    ) -> impl std::future::Future<Output = RemoteResult<String>> + Send {
        let this = self.clone();
        let manifest = manifest.clone();
        let base = base_etag.to_string();
        async move {
            this.ready()?;
            let mut b = this.be.lock().unwrap();
            b.put_manifest_calls += 1;
            if b.reject_schema {
                return Err(RemoteError::Outdated(format!(
                    "manifest version {} is newer than this worker understands",
                    manifest.version
                )));
            }
            if let Some(racer) = b.racer.take() {
                b.manifest = racer;
                b.etag += 1;
            }
            if base != b.etag_str() {
                return Err(RemoteError::Conflict);
            }
            b.manifest = manifest;
            b.etag += 1;
            Ok(b.etag_str())
        }
    }

    fn get_blob(&self, file_id: &str, hash: &str) -> impl std::future::Future<Output = RemoteResult<Vec<u8>>> + Send {
        let this = self.clone();
        let key = (file_id.to_string(), hash.to_string());
        async move {
            this.ready()?;
            let mut b = this.be.lock().unwrap();
            b.blob_gets += 1;
            b.blobs.get(&key).map(|(bytes, _)| bytes.clone()).ok_or(RemoteError::NotFound)
        }
    }

    fn put_blob(
        &self,
        file_id: &str,
        hash: &str,
        bytes: Vec<u8>,
        _content_type: &str,
    ) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        let this = self.clone();
        let key = (file_id.to_string(), hash.to_string());
        async move {
            this.ready()?;
            this.be.lock().unwrap().blobs.entry(key).or_insert((bytes, 0));
            Ok(())
        }
    }

    fn list_blobs(&self, file_id: &str) -> impl std::future::Future<Output = RemoteResult<Vec<(String, u64)>>> + Send {
        let this = self.clone();
        let fid = file_id.to_string();
        async move {
            this.ready()?;
            let b = this.be.lock().unwrap();
            Ok(b.blobs.iter().filter(|((f, _), _)| *f == fid).map(|((_, h), (_, up))| (h.clone(), *up)).collect())
        }
    }

    fn delete_blob(&self, file_id: &str, hash: &str) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        let this = self.clone();
        let key = (file_id.to_string(), hash.to_string());
        async move {
            let mut b = this.be.lock().unwrap();
            b.requests += 1;
            b.blobs.remove(&key);
            Ok(())
        }
    }

    /* ----- the version store ----- */

    fn get_versions_index(
        &self,
    ) -> impl std::future::Future<Output = RemoteResult<Option<(VersionsIndex, String)>>> + Send {
        let this = self.clone();
        async move {
            this.ready()?;
            let b = this.be.lock().unwrap();
            Ok(b.versions_index.clone().map(|i| (i, format!("v{}", b.versions_etag))))
        }
    }

    fn put_versions_index(
        &self,
        base_etag: &str,
        index: &VersionsIndex,
    ) -> impl std::future::Future<Output = RemoteResult<String>> + Send {
        let this = self.clone();
        let base = base_etag.to_string();
        let index = index.clone();
        async move {
            this.ready()?;
            let mut b = this.be.lock().unwrap();
            // "Another device landed between your read and your write."
            if let Some(theirs) = b.versions_racer.take() {
                b.versions_index = Some(theirs);
                b.versions_etag += 1;
                return Err(RemoteError::Conflict);
            }
            let current =
                if b.versions_index.is_some() { format!("v{}", b.versions_etag) } else { NO_INDEX.to_string() };
            if base != current {
                return Err(RemoteError::Conflict);
            }
            b.versions_index = Some(index);
            b.versions_etag += 1;
            Ok(format!("v{}", b.versions_etag))
        }
    }

    fn get_version_snapshot(&self, id: &str) -> impl std::future::Future<Output = RemoteResult<Vec<u8>>> + Send {
        let this = self.clone();
        let id = id.to_string();
        async move {
            this.ready()?;
            let b = this.be.lock().unwrap();
            b.version_snapshots.get(&id).cloned().ok_or(RemoteError::NotFound)
        }
    }

    fn put_version_snapshot(&self, id: &str, gz: Vec<u8>) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        let this = self.clone();
        let id = id.to_string();
        async move {
            this.ready()?;
            // Immutable and create-only, exactly as the worker stores them.
            this.be.lock().unwrap().version_snapshots.entry(id).or_insert(gz);
            Ok(())
        }
    }

    fn delete_version_snapshot(&self, id: &str) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        let this = self.clone();
        let id = id.to_string();
        async move {
            let mut b = this.be.lock().unwrap();
            b.requests += 1;
            b.version_snapshots.remove(&id);
            Ok(())
        }
    }

    fn list_version_blobs(
        &self,
        cursor: Option<&str>,
    ) -> impl std::future::Future<Output = RemoteResult<(Vec<(String, u64)>, Option<String>)>> + Send {
        let this = self.clone();
        let at: usize = cursor.and_then(|c| c.parse().ok()).unwrap_or(0);
        async move {
            this.ready()?;
            let b = this.be.lock().unwrap();
            // A deliberately tiny page, so the caller's paging is exercised
            // by every sweep rather than by one test with a thousand blobs.
            const PAGE: usize = 2;
            let mut hashes: Vec<(String, u64)> =
                b.version_blobs.iter().map(|(h, (_, up))| (h.clone(), *up)).collect();
            hashes.sort();
            let page: Vec<(String, u64)> = hashes.iter().skip(at).take(PAGE).cloned().collect();
            let next = (at + PAGE < hashes.len()).then(|| (at + PAGE).to_string());
            Ok((page, next))
        }
    }

    fn get_version_blob(&self, hash: &str) -> impl std::future::Future<Output = RemoteResult<Vec<u8>>> + Send {
        let this = self.clone();
        let hash = hash.to_string();
        async move {
            this.ready()?;
            let b = this.be.lock().unwrap();
            b.version_blobs.get(&hash).map(|(bytes, _)| bytes.clone()).ok_or(RemoteError::NotFound)
        }
    }

    fn put_version_blob(&self, hash: &str, gz: Vec<u8>) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        let this = self.clone();
        let hash = hash.to_string();
        async move {
            this.ready()?;
            this.be.lock().unwrap().version_blobs.entry(hash).or_insert((gz, now_ms()));
            Ok(())
        }
    }

    fn delete_version_blob(&self, hash: &str) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        let this = self.clone();
        let hash = hash.to_string();
        async move {
            let mut b = this.be.lock().unwrap();
            b.requests += 1;
            b.version_blobs.remove(&hash);
            Ok(())
        }
    }

    fn wipe(&self) -> impl std::future::Future<Output = RemoteResult<WipeRound>> + Send {
        let this = self.clone();
        async move {
            this.owner_only()?;
            let mut b = this.be.lock().unwrap();
            let purged = (b.bound.is_some() as u64) + 1 + b.blobs.len() as u64;
            b.bound = None;
            b.manifest = Manifest::default();
            b.etag += 1;
            b.blobs.clear();
            b.presence.clear();
            b.versions_index = None;
            b.version_snapshots.clear();
            b.version_blobs.clear();
            // The wipe empties the database too (docs/cloud.md §5.7): the
            // domain is free for a new binding, and nobody is left on it.
            b.members.clear();
            b.invites.clear();
            b.tokens.clear();
            Ok(WipeRound { purged, remaining: false })
        }
    }

    fn create_invite(
        &self,
        email: &str,
        name: Option<&str>,
        code_hash: &str,
        expires_at: u64,
    ) -> impl std::future::Future<Output = RemoteResult<InviteRecord>> + Send {
        let this = self.clone();
        let email = email.trim().to_lowercase();
        let name = name.map(|n| n.to_string());
        let code_hash = code_hash.to_string();
        async move {
            this.owner_only()?;
            let mut b = this.be.lock().unwrap();
            let id = FakeRemote::mint_id(&mut b, "m");
            let member = b.members.entry(email.clone()).or_insert(MemberRecord {
                id,
                email: email.clone(),
                name: String::new(),
                role: "member".into(),
                created_at: now_ms(),
                ..Default::default()
            });
            if let Some(n) = name.as_deref().filter(|n| !n.is_empty()) {
                member.name = n.to_string();
            }
            let member = member.clone();
            // One pending invite per person: the old one stops working the
            // moment a new one is made.
            b.invites.retain(|_, held| held.email != email);
            let id = FakeRemote::mint_id(&mut b, "i");
            let record = InviteRecord {
                id,
                member_id: member.id,
                email,
                name: member.name,
                created_at: now_ms(),
                expires_at,
            };
            b.invites.insert(code_hash, record.clone());
            Ok(record)
        }
    }

    fn redeem(
        &self,
        code: &str,
        device_name: &str,
    ) -> impl std::future::Future<Output = RemoteResult<RedeemedToken>> + Send {
        let this = self.clone();
        // The fake looks a code up by its sha256, as the worker does — so a
        // canonical form the app got wrong would miss here too.
        let hash = hash_full(code.as_bytes());
        let device_name = device_name.to_string();
        async move {
            // No bearer: this is the route above the gate.
            this.check_offline()?;
            let mut b = this.be.lock().unwrap();
            let Some(invited) = b.invites.remove(&hash) else {
                return Err(RemoteError::Unauthorized);
            };
            // Removed either way — redeemed or found expired — which is what
            // makes "one-time" and "expiring" true without a reaper. Unknown
            // and expired answer identically: a caller learns whether a code
            // works, never whether it once existed.
            if invited.expires_at <= now_ms() {
                return Err(RemoteError::Unauthorized);
            }
            let member = b.members.get(&invited.email).cloned().unwrap_or_default();
            let token = format!("member-token-{}", FakeRemote::mint_id(&mut b, "k"));
            let token_id = FakeRemote::mint_id(&mut b, "t");
            b.tokens.insert(
                token.clone(),
                TokenRecord {
                    id: token_id.clone(),
                    member_id: member.id.clone(),
                    email: invited.email,
                    device_id: Some(this.device_id.clone()),
                    device_name: Some(device_name),
                    created_at: now_ms(),
                },
            );
            Ok(RedeemedToken { token, token_id, member })
        }
    }

    fn list_members(&self) -> impl std::future::Future<Output = RemoteResult<Vec<MemberRecord>>> + Send {
        let this = self.clone();
        async move {
            this.owner_only()?;
            let b = this.be.lock().unwrap();
            Ok(b.members
                .values()
                .map(|m| MemberRecord {
                    // Counted, not stored: a device count that could disagree
                    // with the tokens beside it would be a second truth.
                    devices: b.tokens.values().filter(|t| t.member_id == m.id).count() as u32,
                    ..m.clone()
                })
                .collect())
        }
    }

    fn adopt_owner(
        &self,
        email: &str,
        name: Option<&str>,
    ) -> impl std::future::Future<Output = RemoteResult<MemberRecord>> + Send {
        let this = self.clone();
        let email = email.trim().to_lowercase();
        let name = name.map(str::to_string);
        async move {
            this.owner_only()?;
            let mut b = this.be.lock().unwrap();
            let id = FakeRemote::mint_id(&mut b, "m");
            let member = b.members.entry(email.clone()).or_insert(MemberRecord {
                id,
                email: email.clone(),
                name: String::new(),
                role: "member".into(),
                created_at: now_ms(),
                ..Default::default()
            });
            if let Some(n) = name.as_deref().filter(|n| !n.is_empty()) {
                member.name = n.to_string();
            }
            member.role = "owner".into();
            let adopted = member.clone();
            // Exactly one row carries the role: adopting a new address demotes
            // the old one rather than deleting it, because that row may
            // already be named in a manifest.
            for other in b.members.values_mut() {
                if other.id != adopted.id {
                    other.role = "member".into();
                }
            }
            Ok(adopted)
        }
    }

    fn delete_member(&self, id: &str) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        let this = self.clone();
        let id = id.to_string();
        async move {
            this.owner_only()?;
            let mut b = this.be.lock().unwrap();
            let Some(email) = b.members.values().find(|m| m.id == id).map(|m| m.email.clone()) else {
                return Err(RemoteError::NotFound);
            };
            // The person and everything they can sign in with, together.
            b.tokens.retain(|_, t| t.member_id != id);
            b.invites.retain(|_, held| held.email != email);
            b.members.remove(&email);
            Ok(())
        }
    }

    fn list_invites(&self) -> impl std::future::Future<Output = RemoteResult<Vec<InviteRecord>>> + Send {
        let this = self.clone();
        async move {
            this.owner_only()?;
            let b = this.be.lock().unwrap();
            // Expired ones are filtered rather than swept: a row past its date
            // is dead on redeem, so listing it would be a lie.
            Ok(b.invites.values().filter(|i| i.expires_at > now_ms()).cloned().collect())
        }
    }

    fn delete_invite(&self, id: &str) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        let this = self.clone();
        let id = id.to_string();
        async move {
            this.owner_only()?;
            let mut b = this.be.lock().unwrap();
            let before = b.invites.len();
            b.invites.retain(|_, held| held.id != id);
            if b.invites.len() == before {
                return Err(RemoteError::NotFound);
            }
            Ok(())
        }
    }

    fn list_tokens(&self) -> impl std::future::Future<Output = RemoteResult<Vec<TokenRecord>>> + Send {
        let this = self.clone();
        async move {
            this.owner_only()?;
            let b = this.be.lock().unwrap();
            // The rows, never the keys they are filed under: the owner is told
            // who holds a credential, never what it is.
            Ok(b.tokens.values().cloned().collect())
        }
    }

    fn delete_token(&self, id: &str) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        let this = self.clone();
        let id = id.to_string();
        async move {
            this.owner_only()?;
            let mut b = this.be.lock().unwrap();
            let before = b.tokens.len();
            b.tokens.retain(|_, t| t.id != id);
            if b.tokens.len() == before {
                return Err(RemoteError::NotFound);
            }
            Ok(())
        }
    }
}

/* ---------- Event collector ---------- */

#[derive(Default)]
struct Collected(Mutex<Vec<(String, serde_json::Value)>>);

impl Events for Collected {
    fn emit_json(&self, event: &str, payload: serde_json::Value) {
        self.0.lock().unwrap().push((event.to_string(), payload));
    }
}

impl Collected {
    fn of(&self, event: &str) -> Vec<serde_json::Value> {
        self.0.lock().unwrap().iter().filter(|(e, _)| e == event).map(|(_, p)| p.clone()).collect()
    }
}

/* ---------- A device ---------- */

struct Device {
    engine: Engine<FakeRemote>,
    root: tempfile::TempDir,
    _state: tempfile::TempDir,
    /// `<app_data>` — where this device's version store lives.
    data: tempfile::TempDir,
    statuses: StatusTable,
    events: Arc<Collected>,
}

fn device(name: &str, be: &SharedWorker) -> Device {
    let root = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    device_at(name, be, root, state)
}

fn device_at(name: &str, be: &SharedWorker, root: tempfile::TempDir, state: tempfile::TempDir) -> Device {
    device_as(name, be, root, state, OWNER_TOKEN)
}

/// A device speaking with `token` rather than the owner's secret — an
/// invited Mac, once it has redeemed.
fn device_as(
    name: &str,
    be: &SharedWorker,
    root: tempfile::TempDir,
    state: tempfile::TempDir,
    token: &str,
) -> Device {
    std::fs::create_dir_all(state.path().join("base")).unwrap();
    let data = tempfile::tempdir().unwrap();
    let statuses: StatusTable = Arc::new(Mutex::new(BTreeMap::new()));
    let events = Arc::new(Collected::default());
    let engine = Engine::new(
        EngineConfig {
            ws_id: "w-test".into(),
            name: "Test".into(),
            root: root.path().to_path_buf(),
            domain: "notes.example.com".into(),
            endpoint: "https://notes.example.com".into(),
            state_dir: state.path().to_path_buf(),
            data_dir: data.path().to_path_buf(),
            device_id: format!("d-{}", name.to_lowercase()),
            device_name: name.to_string(),
            use_trash: false,
        },
        Arc::new(FakeRemote::with_token(be, &format!("d-{}", name.to_lowercase()), token)),
        events.clone(),
        statuses.clone(),
    );
    Device { engine, root, _state: state, data, statuses, events }
}

impl Device {
    fn abs(&self, rel: &str) -> PathBuf {
        self.root.path().join(rel)
    }
    fn write(&self, rel: &str, content: &str) {
        let abs = self.abs(rel);
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        std::fs::write(abs, content).unwrap();
    }
    fn read(&self, rel: &str) -> Option<String> {
        std::fs::read_to_string(self.abs(rel)).ok()
    }
    fn delete(&self, rel: &str) {
        let _ = std::fs::remove_file(self.abs(rel));
    }
    fn rename(&self, from: &str, to: &str) {
        let to_abs = self.abs(to);
        std::fs::create_dir_all(to_abs.parent().unwrap()).unwrap();
        std::fs::rename(self.abs(from), to_abs).unwrap();
    }
    fn files(&self) -> Vec<String> {
        scan_local(self.root.path()).unwrap().keys().cloned().collect()
    }
    async fn cycle(&mut self) {
        self.engine.cycle().await.expect("cycle failed");
    }
    fn status(&self) -> CloudStatus {
        self.statuses
            .lock()
            .unwrap()
            .get(&self.root.path().to_string_lossy().to_string())
            .cloned()
            .expect("no status yet")
    }
    fn phase(&self) -> Phase {
        self.status().phase
    }
    fn pages(&self) -> Vec<PublicPage> {
        self.status().public
    }
    fn page(&self, slug: &str) -> Option<PublicPage> {
        self.pages().into_iter().find(|p| p.slug == slug)
    }
    fn publish(&mut self, rel: &str, kind: PublicKind, slug: Option<&str>) -> Result<String, String> {
        self.engine.queue_publish(PublishRequest {
            rel: rel.into(),
            kind,
            slug: slug.map(String::from),
            title: None,
            desc: None,
        })
    }
    /* ----- the version store: what the versioner would have written ----- */

    fn store(&self) -> Store {
        crate::versions::store_for_root(self.data.path(), self.root.path())
    }

    /// Write a snapshot into this device's local store the way a capture
    /// would: the blobs, the snapshot file, then the index row. `files` is
    /// what the folder held at that moment.
    fn captured(&self, ts: u64, reason: Reason, files: &[(&str, &str)]) -> SnapshotRow {
        self.captured_as(ts, reason, files, false, None)
    }

    fn captured_as(
        &self,
        ts: u64,
        reason: Reason,
        files: &[(&str, &str)],
        pinned: bool,
        label: Option<&str>,
    ) -> SnapshotRow {
        let store = self.store();
        let mut map: BTreeMap<String, FileEntry> = BTreeMap::new();
        let mut bytes = 0u64;
        for (path, content) in files {
            let hash = hash_full(content.as_bytes());
            store.write_blob(&hash, content.as_bytes()).unwrap();
            bytes += content.len() as u64;
            map.insert((*path).to_string(), FileEntry { h: hash, s: content.len() as u64, m: ts });
        }
        let snap = Snapshot {
            version: STORE_VERSION,
            ts,
            reason,
            restored_from: None,
            by: self.engine.device_name_for_test().to_string(),
            files: map.clone(),
        };
        store.write_snapshot(&snap).unwrap();
        let row = SnapshotRow {
            ts,
            reason,
            files: files.len() as u64,
            bytes,
            digest: digest_of(&map),
            pinned,
            label: label.map(String::from),
            restored_from: None,
        };
        let mut index: Index = store.read_index();
        index.snapshots.push(row.clone());
        index.snapshots.sort_by_key(|r| r.ts);
        store.write_index(&index).unwrap();
        row
    }

    fn device_id(&self) -> String {
        self.engine.device_id_for_test().to_string()
    }

    fn publish_folder(&mut self, rel: &str, slug: &str, title: &str, desc: &str) -> Result<String, String> {
        self.engine.queue_publish(PublishRequest {
            rel: rel.into(),
            kind: PublicKind::Dir,
            slug: Some(slug.into()),
            title: Some(title.into()),
            desc: Some(desc.into()),
        })
    }
}

fn manifest_of(be: &SharedWorker) -> Manifest {
    be.lock().unwrap().manifest.clone()
}

fn public_of(be: &SharedWorker) -> BTreeMap<String, PublicEntry> {
    manifest_of(be).public
}

/* ---------- The sync matrix (ported) ---------- */

#[tokio::test]
async fn initial_push_then_second_device_pulls() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    a.write("notes/hello.md", "# hello\n");
    a.write("readme.md", "root doc\n");
    a.cycle().await;

    {
        let b = be.lock().unwrap();
        assert_eq!(b.manifest.files.len(), 2);
        assert_eq!(b.manifest.version, MANIFEST_VERSION);
        assert!(b.manifest.files.values().all(|f| f.rev == 1 && f.by == "Alice"));
    }

    let mut bdev = device("Bob", &be);
    bdev.cycle().await;
    assert_eq!(bdev.read("notes/hello.md").as_deref(), Some("# hello\n"));
    assert_eq!(bdev.read("readme.md").as_deref(), Some("root doc\n"));
    let applied = bdev.events.of(EV_APPLIED);
    assert_eq!(applied.len(), 1);
    assert_eq!(applied[0]["root"], bdev.root.path().to_string_lossy().to_string());
    assert_eq!(applied[0]["paths"].as_array().unwrap().len(), 2);
}

/// The manifest carries the current state and nothing else. Revisions still
/// count up — that is what tells another device its copy is behind — but a
/// file's past is the version store's, and since v3 the manifest has no
/// field to put one in.
#[tokio::test]
async fn edit_propagates_and_the_manifest_keeps_no_revisions() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    let mut b = device("Bob", &be);
    a.write("doc.md", "v1 content\n");
    a.cycle().await;
    b.cycle().await;

    for i in 2..=4 {
        a.write("doc.md", &format!("v{} content, longer and longer\n", i));
        a.cycle().await;
        b.cycle().await;
    }
    assert_eq!(b.read("doc.md").as_deref(), Some("v4 content, longer and longer\n"));

    let m = manifest_of(&be);
    let f = m.files.values().next().unwrap();
    assert_eq!(f.rev, 4);
    assert_eq!(m.version, MANIFEST_VERSION);
    // The domain never said who Alice is, so her Mac signs with its own name
    // — v3's `by` is a member id *when there is one*, not always.
    assert_eq!(f.by, "Alice");
    // What is on the wire, and nothing else: no `hist` to be empty.
    let json = serde_json::to_value(f).unwrap();
    assert_eq!(
        json.as_object().unwrap().keys().map(String::as_str).collect::<Vec<_>>(),
        vec!["by", "hash", "mtime", "path", "rev", "size"],
    );
}

/// A workspace carried over from v2 is full of `by` values that are device
/// names. They read, they show as they stand, and nothing rewrites them:
/// re-signing somebody else's revision would attribute their edit to
/// whichever Mac upgraded first. Only what this device writes is its own.
#[tokio::test]
async fn an_older_devices_attribution_is_read_and_never_rewritten() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    a.write("theirs.md", "v1 content\n");
    a.write("mine.md", "mine\n");
    a.cycle().await;

    // The other Mac's revision, signed the way its release signed things.
    let theirs = {
        let mut b = be.lock().unwrap();
        let (fid, f) = b
            .manifest
            .files
            .iter_mut()
            .find(|(_, f)| f.path == "theirs.md")
            .map(|(k, v)| (k.clone(), v))
            .unwrap();
        let bytes = b"v2 from the old build\n".to_vec();
        let hash = hash16(&bytes);
        f.rev += 1;
        f.hash = hash.clone();
        f.size = bytes.len() as u64;
        f.mtime = now_ms();
        f.by = "Old Mac".into();
        b.etag += 1;
        b.blobs.insert((fid.clone(), hash), (bytes, 0));
        fid
    };

    // It reads like any other revision, and the attribution stays theirs
    // through every cycle that does not touch the file.
    a.cycle().await;
    assert_eq!(a.read("theirs.md").as_deref(), Some("v2 from the old build\n"));
    a.write("mine.md", "mine, edited\n");
    a.cycle().await;
    assert_eq!(manifest_of(&be).files[&theirs].by, "Old Mac", "untouched, so unchanged");

    // Editing it is what re-signs it — as this Mac, because this domain has
    // never said who that is.
    a.write("theirs.md", "v3, written here\n");
    a.cycle().await;
    let f = &manifest_of(&be).files[&theirs];
    assert_eq!(f.rev, 3, "the revision counter still climbs");
    assert_eq!(f.by, "Alice");
}

#[tokio::test]
async fn concurrent_distinct_files_converge_via_cas_retry() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    let mut b = device("Bob", &be);
    a.write("a.md", "alpha v1\n");
    a.cycle().await;
    b.cycle().await;

    a.write("a.md", "alpha v2 — bigger\n");
    a.cycle().await;

    // A "third device" steals the CAS from Bob mid-put.
    {
        let mut be2 = be.lock().unwrap();
        let mut m = be2.manifest.clone();
        m.seq += 1;
        let bytes = b"from the racer\n".to_vec();
        let hash = hash16(&bytes);
        be2.blobs.insert(("f-racer".into(), hash.clone()), (bytes.clone(), 0));
        m.files.insert(
            "f-racer".into(),
            ManifestFile {
                path: "x.md".into(),
                rev: 1,
                hash,
                size: bytes.len() as u64,
                mtime: now_ms(),
                by: "Racer".into(),
            },
        );
        be2.racer = Some(m);
    }

    b.write("b.md", "bob's brand new file\n");
    b.cycle().await; // loses first CAS, retries, lands everything

    let be2 = be.lock().unwrap();
    let paths: Vec<String> = be2.manifest.files.values().map(|f| f.path.clone()).collect();
    assert!(paths.contains(&"a.md".to_string()));
    assert!(paths.contains(&"b.md".to_string()));
    assert!(paths.contains(&"x.md".to_string()));
    assert!(be2.put_manifest_calls >= 2, "bob must have retried the CAS");
    drop(be2);

    assert_eq!(b.read("a.md").as_deref(), Some("alpha v2 — bigger\n"));
    assert_eq!(b.read("x.md").as_deref(), Some("from the racer\n"));
}

#[tokio::test]
async fn same_file_different_lines_merges_clean() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    let mut b = device("Bob", &be);
    a.write("doc.md", "line one\nline two\nline three\n");
    a.cycle().await;
    b.cycle().await;

    a.write("doc.md", "line one — ALICE\nline two\nline three\n");
    a.cycle().await;
    b.write("doc.md", "line one\nline two\nline three — BOB\n");
    b.cycle().await;

    let merged = "line one — ALICE\nline two\nline three — BOB\n";
    assert_eq!(b.read("doc.md").as_deref(), Some(merged));
    a.cycle().await;
    assert_eq!(a.read("doc.md").as_deref(), Some(merged));
    assert_eq!(a.files().len(), 1);
    assert_eq!(b.files().len(), 1);
}

#[tokio::test]
async fn same_line_conflict_keeps_both_versions() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    let mut b = device("Bob", &be);
    a.write("doc.md", "shared line\n");
    a.cycle().await;
    b.cycle().await;

    a.write("doc.md", "alice's take on the line\n");
    a.cycle().await;
    b.write("doc.md", "bob's very different take\n");
    b.cycle().await;

    assert_eq!(b.read("doc.md").as_deref(), Some("bob's very different take\n"));
    let copies: Vec<String> = b.files().into_iter().filter(|p| p.contains("(conflict — Alice")).collect();
    assert_eq!(copies.len(), 1, "exactly one conflict copy, got {:?}", b.files());
    assert_eq!(b.read(&copies[0]).as_deref(), Some("alice's take on the line\n"));
    let conflicts = b.events.of(EV_CONFLICT);
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0]["path"], "doc.md");
    assert_eq!(conflicts[0]["by"], "Alice");
    assert_eq!(conflicts[0]["conflictPath"], copies[0]);

    a.cycle().await;
    assert_eq!(a.read("doc.md").as_deref(), Some("bob's very different take\n"));
    assert_eq!(a.read(&copies[0]).as_deref(), Some("alice's take on the line\n"));
}

#[tokio::test]
async fn delete_propagates() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    let mut b = device("Bob", &be);
    a.write("keep.md", "keeper\n");
    a.write("gone.md", "doomed\n");
    a.cycle().await;
    b.cycle().await;

    a.delete("gone.md");
    a.cycle().await;
    {
        let m = manifest_of(&be);
        assert_eq!(m.files.len(), 1);
        assert_eq!(m.tombstones.len(), 1);
    }
    b.cycle().await;
    assert!(b.read("gone.md").is_none());
    assert_eq!(b.read("keep.md").as_deref(), Some("keeper\n"));
}

#[tokio::test]
async fn local_edit_beats_remote_delete() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    let mut b = device("Bob", &be);
    a.write("doc.md", "original\n");
    a.cycle().await;
    b.cycle().await;

    a.delete("doc.md");
    a.cycle().await;
    b.write("doc.md", "bob kept working on this\n");
    b.cycle().await;

    assert_eq!(b.read("doc.md").as_deref(), Some("bob kept working on this\n"));
    assert_eq!(manifest_of(&be).files.len(), 1, "the edit resurrected the doc");
    a.cycle().await;
    assert_eq!(a.read("doc.md").as_deref(), Some("bob kept working on this\n"));
}

#[tokio::test]
async fn mass_delete_holds_until_confirmed() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    for i in 0..10 {
        a.write(&format!("doc{}.md", i), &format!("content number {}\n", i));
    }
    a.cycle().await;

    for i in 0..6 {
        a.delete(&format!("doc{}.md", i));
    }
    a.cycle().await;
    assert_eq!(manifest_of(&be).files.len(), 10, "deletes must be held");
    assert_eq!(a.phase(), Phase::PendingDeletes);
    assert_eq!(a.status().pending_deletes, 6);
    let pending = a.events.of(EV_PENDING_DELETES);
    assert_eq!(pending[0]["count"], 6);
    assert_eq!(pending[0]["total"], 10);

    a.engine.confirm_deletes();
    a.cycle().await;
    let m = manifest_of(&be);
    assert_eq!(m.files.len(), 4);
    assert_eq!(m.tombstones.len(), 6);
    assert_eq!(a.phase(), Phase::Idle);
}

#[tokio::test]
async fn rename_is_metadata_only_and_propagates() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    let mut b = device("Bob", &be);
    a.write("old-name.md", "stable content that does not change\n");
    a.cycle().await;
    b.cycle().await;

    let fid_before: String = manifest_of(&be).files.keys().next().unwrap().clone();
    let before = manifest_of(&be).files[&fid_before].clone();

    a.rename("old-name.md", "new-name.md");
    a.cycle().await;
    {
        let m = manifest_of(&be);
        assert_eq!(m.files.len(), 1, "a rename must not fork the file");
        let (fid, f) = m.files.iter().next().unwrap();
        assert_eq!(*fid, fid_before, "same identity across the rename");
        assert_eq!(f.path, "new-name.md");
        assert_eq!(f.rev, before.rev + 1, "a move is the next revision");
        // …of the same content: `mtime` says when that last changed, and the
        // document API reads it to tell an html version that has fallen
        // behind (cloud-worker/src/documents.ts, `htmlBehind`).
        assert_eq!((f.hash.as_str(), f.mtime), (before.hash.as_str(), before.mtime), "a move is not an edit");
    }

    b.cycle().await;
    assert!(b.read("old-name.md").is_none());
    assert_eq!(b.read("new-name.md").as_deref(), Some("stable content that does not change\n"));
}

#[tokio::test]
async fn offline_reports_and_recovers() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    a.write("doc.md", "important words\n");
    be.lock().unwrap().offline = true;
    assert!(a.engine.cycle().await.is_err());
    assert_eq!(a.phase(), Phase::Offline);
    assert!(a.status().last_sync_ms.is_none());

    be.lock().unwrap().offline = false;
    a.cycle().await;
    assert_eq!(a.phase(), Phase::Idle);
    assert!(a.status().last_sync_ms.is_some());
    assert_eq!(manifest_of(&be).files.len(), 1);
}

#[tokio::test]
async fn quiet_cycles_change_nothing() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    a.write("doc.md", "steady state\n");
    a.cycle().await;
    let (seq, etag, calls) = {
        let be2 = be.lock().unwrap();
        (be2.manifest.seq, be2.etag, be2.put_manifest_calls)
    };
    a.cycle().await;
    a.cycle().await;
    let be2 = be.lock().unwrap();
    assert_eq!(be2.manifest.seq, seq);
    assert_eq!(be2.etag, etag);
    assert_eq!(be2.put_manifest_calls, calls, "no-op cycles must not write");
}

#[tokio::test]
async fn raced_same_path_creates_deduped_deterministically() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    let mut b = device("Bob", &be);
    a.write("ideas.md", "alice ideas\n");
    b.write("ideas.md", "bob ideas — different\n");
    a.cycle().await;
    b.cycle().await;
    a.cycle().await;
    b.cycle().await;

    let m = manifest_of(&be);
    let mut paths: Vec<String> = m.files.values().map(|f| f.path.clone()).collect();
    paths.sort();
    let mut deduped = paths.clone();
    deduped.dedup();
    assert_eq!(paths, deduped, "no two files may share a path");
    let a_files = a.files();
    let b_files = b.files();
    assert_eq!(a_files, b_files, "device file sets must converge");
    let joined: String = a_files.iter().filter_map(|p| a.read(p)).collect();
    assert!(joined.contains("alice ideas") || joined.contains("bob ideas"));
}

/* ---------- The public map ---------- */

#[tokio::test]
async fn publish_mirrors_to_the_other_device() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    let mut b = device("Bob", &be);
    a.write("doc.md", "# doc\n");
    a.cycle().await;
    b.cycle().await;

    let slug = a.publish("doc.md", PublicKind::File, None).unwrap();
    assert!(valid_slug(&slug) && slug.len() == RANDOM_SLUG_LEN, "a random slug: {}", slug);
    // Visible at once, before any CAS.
    let page = a.page(&slug).expect("queued page shows in the effective view");
    assert!(page.alive);
    assert_eq!(page.path, "doc.md");

    a.cycle().await;
    assert!(a.engine.state.public_ops.is_empty(), "carried op must clear");
    {
        let public = public_of(&be);
        assert_eq!(public.len(), 1);
        let e = &public[&slug];
        assert_eq!(e.kind, PublicKind::File);
        assert!(manifest_of(&be).files.contains_key(e.file.as_ref().unwrap()));
        assert_eq!(e.path, "doc.md");
        assert_eq!(e.by, "Alice");
    }

    b.cycle().await;
    let seen = b.pages();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].slug, slug);
    assert_eq!(seen[0].path, "doc.md");
    assert!(seen[0].alive);
    assert_eq!(seen[0].by, "Alice");

    // Publishing it again from Bob keeps the one page.
    assert_eq!(b.publish("doc.md", PublicKind::File, None).unwrap(), slug);
}

#[tokio::test]
async fn page_follows_rename_and_survives_lost_cas() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    let mut b = device("Bob", &be);
    a.write("doc.md", "# doc\n");
    a.write("other.md", "# other\n");
    a.publish("doc.md", PublicKind::File, Some("page1")).unwrap();
    a.cycle().await;
    b.cycle().await;

    // Bob renames the published file — no ops anywhere, the page is
    // fileId-keyed and only its recorded path re-points.
    b.rename("doc.md", "sub/renamed.md");
    b.cycle().await;
    {
        let public = public_of(&be);
        assert_eq!(public["page1"].path, "sub/renamed.md");
    }
    a.cycle().await;
    assert_eq!(a.page("page1").unwrap().path, "sub/renamed.md");

    // A publish queued behind a lost CAS lands on the retry, on top of
    // whatever the winner wrote.
    a.publish("other.md", PublicKind::File, Some("page2")).unwrap();
    {
        let mut be2 = be.lock().unwrap();
        let mut raced = be2.manifest.clone();
        raced.seq += 1;
        raced.name = "Raced".into();
        be2.racer = Some(raced);
    }
    a.cycle().await;
    let m = manifest_of(&be);
    assert_eq!(m.name, "Raced", "the racer's write must survive");
    assert_eq!(m.public.len(), 2);
    assert_eq!(m.public["page2"].path, "other.md");
}

#[tokio::test]
async fn publish_only_change_commits_once_then_stays_quiet() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    a.write("doc.md", "# doc\n");
    a.cycle().await;

    let before = be.lock().unwrap().put_manifest_calls;
    a.publish("doc.md", PublicKind::File, Some("page1")).unwrap();
    a.cycle().await;
    let after_op = be.lock().unwrap().put_manifest_calls;
    assert_eq!(after_op, before + 1, "a publish alone must still commit");

    a.cycle().await;
    assert_eq!(be.lock().unwrap().put_manifest_calls, after_op, "a no-op cycle must not CAS");
}

#[tokio::test]
async fn deleted_file_page_goes_dead_then_rebinds_on_recreate() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    a.write("doc.md", "# doc\n");
    a.publish("doc.md", PublicKind::File, Some("page1")).unwrap();
    a.cycle().await;
    let old_fid = public_of(&be)["page1"].file.clone().unwrap();

    // Delete: the file tombstones, the page stays (it lives until stopped
    // explicitly) — flagged dead, so the Published list can say so.
    a.delete("doc.md");
    a.cycle().await;
    {
        let m = manifest_of(&be);
        assert!(m.files.is_empty());
        assert_eq!(m.public.len(), 1);
        assert_eq!(m.public["page1"].path, "doc.md");
        assert_eq!(m.public["page1"].file.as_deref(), Some(old_fid.as_str()));
    }
    let page = a.page("page1").unwrap();
    assert!(!page.alive);

    // Recreate at the same path: the page adopts the new fileId and keeps
    // flowing.
    a.write("doc.md", "# reborn\n");
    a.cycle().await;
    let m = manifest_of(&be);
    assert_eq!(m.public.len(), 1);
    let fid = m.public["page1"].file.clone().unwrap();
    assert_ne!(fid, old_fid, "recreated file gets a fresh fileId");
    assert!(m.files.contains_key(&fid));
    assert!(a.page("page1").unwrap().alive);
}

#[tokio::test]
async fn folder_page_repoints_when_the_folder_moves() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    let mut b = device("Bob", &be);
    a.write("Projects/Roadmap/a.md", "# a\n");
    a.write("Projects/Roadmap/b.md", "# b\n");
    a.write("Other.md", "# other\n");
    a.publish_folder("Projects/Roadmap", "roadmap", "Roadmap", "What we're building").unwrap();
    a.cycle().await;
    b.cycle().await;
    {
        let e = &public_of(&be)["roadmap"];
        assert_eq!(e.kind, PublicKind::Dir);
        assert_eq!(e.path, "Projects/Roadmap");
        assert_eq!(e.title.as_deref(), Some("Roadmap"));
        assert_eq!(e.desc.as_deref(), Some("What we're building"));
    }
    assert!(b.page("roadmap").unwrap().alive);

    // The folder moves wholesale: every file it held moved to one prefix.
    std::fs::rename(a.abs("Projects/Roadmap"), a.abs("Projects/Plans")).unwrap();
    a.cycle().await;
    assert_eq!(public_of(&be)["roadmap"].path, "Projects/Plans");
    b.cycle().await;
    let page = b.page("roadmap").unwrap();
    assert_eq!(page.path, "Projects/Plans");
    assert!(page.alive);
    assert_eq!(b.read("Projects/Plans/a.md").as_deref(), Some("# a\n"));

    // A move with an edit inside is not a whole-folder move: the page stays
    // where it was, and reads as dead until the user re-points it.
    std::fs::rename(a.abs("Projects/Plans"), a.abs("Projects/Later")).unwrap();
    a.write("Projects/Later/a.md", "# a, edited on the way\n");
    a.cycle().await;
    assert_eq!(public_of(&be)["roadmap"].path, "Projects/Plans");
    assert!(!a.page("roadmap").unwrap().alive);
}

#[tokio::test]
async fn publish_for_missing_file_waits_but_shows_in_effective_view() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    a.write("doc.md", "# doc\n");
    a.cycle().await;

    let before = be.lock().unwrap().put_manifest_calls;
    a.publish("later.md", PublicKind::File, Some("later")).unwrap();
    a.cycle().await;
    // Nothing to bind to yet: no CAS wasted, op still queued — but the
    // status already reports it, so the frontend sees the user's page.
    assert_eq!(be.lock().unwrap().put_manifest_calls, before);
    assert_eq!(a.engine.state.public_ops.len(), 1);
    assert!(a.page("later").is_some());

    a.write("later.md", "# here now\n");
    a.cycle().await;
    assert!(a.engine.state.public_ops.is_empty());
    let public = public_of(&be);
    assert_eq!(public["later"].path, "later.md");
    assert!(manifest_of(&be).files.contains_key(public["later"].file.as_ref().unwrap()));
}

#[tokio::test]
async fn root_page_is_one_entry_and_clears() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    let mut b = device("Bob", &be);
    a.write("home.md", "# home\n");
    a.write("about.md", "# about\n");
    a.publish("home.md", PublicKind::File, Some("home")).unwrap();
    a.publish("about.md", PublicKind::File, Some("about")).unwrap();
    a.engine.queue_set_root(Some("home".into())).unwrap();
    assert!(a.page("home").unwrap().root, "the root shows before the CAS");
    a.cycle().await;
    assert!(a.engine.state.root_op.is_none());
    assert!(public_of(&be)["home"].root);
    assert!(!public_of(&be)["about"].root);

    b.cycle().await;
    assert!(b.page("home").unwrap().root);
    b.engine.queue_set_root(Some("about".into())).unwrap();
    b.cycle().await;
    let public = public_of(&be);
    assert!(!public["home"].root);
    assert!(public["about"].root);

    b.engine.queue_set_root(None).unwrap();
    b.cycle().await;
    assert!(public_of(&be).values().all(|e| !e.root));
    assert!(b.engine.queue_set_root(Some("nope".into())).is_err());

    // Re-keying the root page (a custom slug for a page that has one)
    // carries the root flag and the original date to the new slug.
    b.engine.queue_set_root(Some("home".into())).unwrap();
    b.cycle().await;
    let at = public_of(&be)["home"].at;
    assert_eq!(b.publish("home.md", PublicKind::File, Some("start")).unwrap(), "start");
    assert!(b.page("start").unwrap().root, "the effective view carries it too");
    assert!(b.page("home").is_none());
    b.cycle().await;
    let public = public_of(&be);
    assert!(!public.contains_key("home"));
    assert!(public["start"].root);
    assert_eq!(public["start"].at, at);
    assert_eq!(public["start"].path, "home.md");
}

#[tokio::test]
async fn unpublish_removes_the_page_everywhere() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    let mut b = device("Bob", &be);
    a.write("doc.md", "# doc\n");
    a.publish("doc.md", PublicKind::File, Some("page1")).unwrap();
    a.cycle().await;
    b.cycle().await;
    assert!(b.page("page1").is_some());

    a.engine.queue_unpublish("page1").unwrap();
    assert!(a.page("page1").is_none(), "gone from the effective view at once");
    a.cycle().await;
    assert!(public_of(&be).is_empty());
    b.cycle().await;
    assert!(b.pages().is_empty());
    assert!(b.engine.queue_unpublish("page1").is_err());
}

#[tokio::test]
async fn custom_slug_race_suffixes_the_loser() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    let mut b = device("Bob", &be);
    a.write("a.md", "# a\n");
    a.write("b.md", "# b\n");
    a.cycle().await;
    b.cycle().await;

    // Alice takes "plan" for a.md; Bob, not having pulled, takes "plan" for
    // b.md. Bob's fold finds the slug taken by another page and yields.
    assert_eq!(a.publish("a.md", PublicKind::File, Some("plan")).unwrap(), "plan");
    a.cycle().await;
    assert_eq!(b.publish("b.md", PublicKind::File, Some("plan")).unwrap(), "plan");
    b.cycle().await;
    let public = public_of(&be);
    assert_eq!(public["plan"].path, "a.md");
    assert_eq!(public["plan-2"].path, "b.md");
    assert!(b.engine.state.public_ops.is_empty());
    assert_eq!(b.page("plan-2").unwrap().path, "b.md", "bob's status tells him his final slug");

    // A local check catches the taken slug once the device has pulled.
    assert!(a.publish("b.md", PublicKind::File, Some("plan")).is_err());

    // A random slug for a page another device already published yields to
    // that page rather than doubling it.
    let mut c = device("Carol", &be);
    c.cycle().await;
    let mut d = device("Dan", &be);
    d.write("a.md", "# a\n");
    let random = d.publish("a.md", PublicKind::File, None).unwrap();
    assert_ne!(random, "plan");
    d.cycle().await;
    let public = public_of(&be);
    assert_eq!(public.len(), 2, "no duplicate page for a.md");
    assert_eq!(public["plan"].path, "a.md");
    assert!(d.engine.state.public_ops.is_empty());
    let _ = c;
}

/* ---------- The flows ---------- */

#[tokio::test]
async fn bind_refused_when_bound() {
    let be = fake_worker();
    let alice = Arc::new(FakeRemote::new(&be, "d-alice"));
    let bob = Arc::new(FakeRemote::new(&be, "d-bob"));
    let bound = bind_domain(&alice, "Notes", "Alice's Mac").await.unwrap();
    assert_eq!(bound.workspace.name, "Notes");
    assert_eq!(bound.workspace.created_by.device_name, "Alice's Mac");
    assert!(!bound.manifest_etag.is_empty());

    match bind_domain(&bob, "Other", "Bob's Mac").await {
        Err(FlowError::AlreadyBound(w)) => {
            assert_eq!(w.id, bound.workspace.id);
            assert_eq!(w.name, "Notes");
        }
        other => panic!("second bind must be refused, got {:?}", other.map(|b| b.workspace)),
    }
    assert_eq!(manifest_of(&be).name, "Notes");
    let msg = super::flows::describe("notes.example.com", FlowError::AlreadyBound(bound.workspace.clone()));
    assert!(msg.contains("already holds \"Notes\""));
    assert!(msg.contains("Alice's Mac"));

    // Wipe frees it.
    let purged = wipe_all(&alice).await.unwrap();
    assert!(purged >= 1);
    assert!(be.lock().unwrap().bound.is_none());
    assert!(bind_domain(&bob, "Other", "Bob's Mac").await.is_ok());
}

#[tokio::test]
async fn join_downloads_what_connect_uploaded() {
    let be = fake_worker();
    let events: Arc<dyn Events> = Arc::new(Collected::default());
    let a_root = tempfile::tempdir().unwrap();
    let a_state = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(a_root.path().join("notes")).unwrap();
    std::fs::write(a_root.path().join("notes/hello.md"), "# hello\n").unwrap();
    std::fs::write(a_root.path().join("readme.md"), "root doc\n").unwrap();
    std::fs::write(a_root.path().join(".hidden.md"), "never\n").unwrap();

    let alice = Arc::new(FakeRemote::new(&be, "d-alice"));
    let bound = bind_domain(&alice, "Notes", "Alice's Mac").await.unwrap();
    let a_state_data = seed_upload(
        &alice,
        a_root.path(),
        a_state.path(),
        "Notes",
        &bound.manifest_etag,
        "Alice's Mac",
        &events,
        "a",
    )
    .await
    .unwrap();
    assert_eq!(a_state_data.files.len(), 2);
    assert_eq!(manifest_of(&be).files.len(), 2);
    assert!(a_state.path().join("base").read_dir().unwrap().count() == 2);

    let bob = Arc::new(FakeRemote::new(&be, "d-bob"));
    let parent = tempfile::tempdir().unwrap();
    let dest = parent.path().join("Notes");
    let b_state = tempfile::tempdir().unwrap();
    let b_state_data = seed_download(&bob, &dest, b_state.path(), &events).await.unwrap();
    assert_eq!(b_state_data.files.len(), 2);
    assert_eq!(std::fs::read_to_string(dest.join("notes/hello.md")).unwrap(), "# hello\n");
    assert_eq!(std::fs::read_to_string(dest.join("readme.md")).unwrap(), "root doc\n");
    assert!(!dest.join(".hidden.md").exists());

    // A non-empty destination is refused.
    assert!(seed_download(&bob, &dest, b_state.path(), &events).await.is_err());

    // Engines started on the seeded state have nothing to say.
    super::scan::write_json(&b_state.path().join("state.json"), &b_state_data).unwrap();
    let calls = be.lock().unwrap().put_manifest_calls;
    let mut b = device_at("Bob", &be, tempfile::TempDir::new().unwrap(), b_state);
    // The device helper made a fresh root; point the engine's state at the
    // downloaded folder by re-creating it there.
    drop(b);
    let b_state2 = tempfile::tempdir().unwrap();
    super::scan::write_json(&b_state2.path().join("state.json"), &b_state_data).unwrap();
    let dest_dir = tempfile::TempDir::new().unwrap();
    // Copy the downloaded files into the device's root, keeping mtimes
    // irrelevant: a snapshot mismatch only costs a hash, never a push.
    for rel in ["notes/hello.md", "readme.md"] {
        let target = dest_dir.path().join(rel);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::copy(dest.join(rel), target).unwrap();
    }
    b = device_at("Bob", &be, dest_dir, b_state2);
    b.cycle().await;
    assert_eq!(be.lock().unwrap().put_manifest_calls, calls, "a joined folder has nothing to push");
    assert_eq!(b.phase(), Phase::Idle);
}

#[tokio::test]
async fn resume_in_place_converges_without_conflict_copies() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    a.write("notes/one.md", "# one\n");
    a.write("notes/two.md", "# two\n");
    a.write("three.md", "# three\n");
    a.cycle().await;

    // Carol restored the same folder from a backup and has no engine state.
    let mut c = device("Carol", &be);
    c.write("notes/one.md", "# one\n");
    c.write("notes/two.md", "# two\n");
    c.write("three.md", "# three\n");
    c.write("only-here.md", "# new on carol's mac\n");
    let calls = be.lock().unwrap().put_manifest_calls;
    c.cycle().await;

    let mut files = c.files();
    files.sort();
    assert_eq!(files, vec!["notes/one.md", "notes/two.md", "only-here.md", "three.md"], "no conflict copies");
    assert_eq!(c.engine.state.files.len(), 4);
    let m = manifest_of(&be);
    assert_eq!(m.files.len(), 4);
    assert!(m.files.values().filter(|f| f.path != "only-here.md").all(|f| f.rev == 1), "identical files were not re-pushed");
    assert_eq!(be.lock().unwrap().put_manifest_calls, calls + 1, "one CAS, for the new file");

    // From here on Carol's folder syncs like any other.
    c.write("three.md", "# three, edited after the resume\n");
    c.cycle().await;
    assert_eq!(m.files.len(), 4);
    a.cycle().await;
    assert_eq!(a.read("three.md").as_deref(), Some("# three, edited after the resume\n"));
    assert_eq!(a.read("only-here.md").as_deref(), Some("# new on carol's mac\n"));
    assert_eq!(a.files().len(), 4);
}

/* ---------- The invite code and the redeem flow (docs/cloud.md §8.1) ---------- */

#[test]
fn a_minted_code_reads_back_the_way_it_was_written() {
    // The round trip that matters: what the app hashes when it mints an
    // invite has to be what it hashes when somebody types the code back in.
    for _ in 0..500 {
        let canonical = invite::random_code();
        assert_eq!(canonical.len(), 20, "100 bits, five to a character");
        assert!(
            !canonical.contains(['I', 'L', 'O', 'U']),
            "Crockford's alphabet drops the letters that read as digits: {}",
            canonical
        );
        let written = invite::format_code(&canonical);
        let groups: Vec<&str> = written.split('-').collect();
        assert_eq!(groups[0], "dkln", "self-identifying: {}", written);
        assert_eq!(groups.len(), 5, "the prefix and four groups: {}", written);
        assert!(groups[1..].iter().all(|g| g.len() == 5), "five to a group: {}", written);
        assert_eq!(invite::normalize_code(&written).as_deref(), Some(canonical.as_str()));
    }

    // Two codes in a row are two codes. (At 100 bits a collision here would
    // mean the randomness is not random, not that we got unlucky.)
    let mint: Vec<String> = (0..200).map(|_| invite::random_code()).collect();
    assert_eq!(mint.iter().collect::<BTreeSet<_>>().len(), 200);
    // Every character of the alphabet turns up: a mask that lost a bit would
    // still pass everything above while halving the entropy.
    let seen: BTreeSet<char> = mint.iter().flat_map(|c| c.chars()).collect();
    assert_eq!(seen.len(), 32, "all 32 Crockford characters, in 4000 of them");

    // Everything a chat client, a keyboard or a spreadsheet does to it.
    let canonical = "K7QM29XVR48TBHN3WGYD";
    for typed in [
        "dkln-K7QM2-9XVR4-8TBHN-3WGYD",
        "  dkln-k7qm2-9xvr4-8tbhn-3wgyd  ",
        "dkln k7qm2 9xvr4 8tbhn 3wgyd",
        "DKLN—K7QM2—9XVR4—8TBHN—3WGYD",
        "K7QM29XVR48TBHN3WGYD",
        "k7qm2-9xvr4-8tbhn-3wgyd",
    ] {
        assert_eq!(invite::normalize_code(typed).as_deref(), Some(canonical), "{}", typed);
    }
    // The confusables land where Crockford says they land.
    assert_eq!(invite::normalize_code("dkln-IL0M2-9XVR4-8TBHN-3WGYD").as_deref(), Some("110M29XVR48TBHN3WGYD"));
    assert_eq!(invite::normalize_code("dkln-o1om2-9xvr4-8tbhn-3wgyd").as_deref(), Some("010M29XVR48TBHN3WGYD"));

    // And what is not a code is not a code.
    for junk in ["", "dkln-", "K7QM29XVR48TBHN3WGY", "K7QM29XVR48TBHN3WGYDD", "K7QM29XVR48TBHN3WGY!", "hello"] {
        assert_eq!(invite::normalize_code(junk), None, "{:?} is not a code", junk);
    }
    // U is the one letter that is neither in the alphabet nor a confusable.
    assert_eq!(invite::normalize_code("dkln-U7QM2-9XVR4-8TBHN-3WGYD"), None);
}

#[test]
fn one_paste_fills_both_boxes() {
    let canonical = invite::random_code();
    let code = invite::format_code(&canonical);
    let line = invite::blob("https://notes.example.com", &code);
    assert_eq!(line, format!("doklin-invite https://notes.example.com {}", code));

    let both = invite::Pasted {
        endpoint: Some("https://notes.example.com".into()),
        code: Some(code.clone()),
    };
    assert_eq!(invite::parse_pasted(&line), both);
    // The line as a chat client delivers it: wrapped in a sentence, on its
    // own paragraph, with the full stop somebody typed after it.
    assert_eq!(
        invite::parse_pasted(&format!("Come and join us:\n\n  {}  .\n", line)),
        both,
        "a whole message carrying the line still parses"
    );
    // Either half on its own is worth filling in.
    assert_eq!(invite::parse_pasted(&code), invite::Pasted { endpoint: None, code: Some(code.clone()) });
    assert_eq!(
        invite::parse_pasted("notes.example.com"),
        invite::Pasted { endpoint: Some("https://notes.example.com".into()), code: None }
    );
    // The trap this design walks past: strip the punctuation out of
    // "https://notes.example.com" and what is left is twenty characters that
    // are every one of them in Crockford's alphabet — a perfectly good code.
    // Punctuation is what tells an address from a code, so the address never
    // lands in the code box.
    assert_eq!(invite::normalize_code("https://notes.example.com").as_deref(), Some("HTTPSN0TESEXAMP1EC0M"));
    assert_eq!(invite::parse_pasted("https://notes.example.com").code, None);
    // Nothing usable in, nothing out — the wizard leaves what was typed.
    assert_eq!(invite::parse_pasted("see you tomorrow"), invite::Pasted::default());
}

#[tokio::test]
async fn a_code_is_traded_for_a_token_of_this_macs_own() {
    let be = fake_worker();
    let alice = Arc::new(FakeRemote::new(&be, "d-alice"));
    let canonical = invite::random_code();
    let invited = alice
        .create_invite("  Bob@Example.com ", Some("Bob"), &invite::code_hash(&canonical), invite::expires_at(now_ms(), None))
        .await
        .unwrap();
    // The person is keyed by their address, normalized — inviting
    // "Bob@Example.com" again reaches this same row.
    assert_eq!(invited.email, "bob@example.com");
    assert_eq!(invited.name, "Bob");
    assert!(invited.expires_at > now_ms());

    // Bob's Mac has no credential at all, which is the point of the route.
    let bob = Arc::new(FakeRemote::with_token(&be, "d-bob", ""));
    let redeemed = bob.redeem(&canonical, "Bob's Mac").await.expect("the code works once");
    assert_eq!(redeemed.member.email, "bob@example.com");
    assert_eq!(redeemed.member.id, invited.member_id, "the same person the invite named");
    assert_eq!(redeemed.member.role, "member");
    assert!(!redeemed.token.is_empty());
    assert_ne!(redeemed.token, OWNER_TOKEN, "a member's credential is not the owner's");

    // The formatted code redeems too: both ends canonicalize first.
    let canonical2 = invite::random_code();
    alice
        .create_invite("carol@example.com", None, &invite::code_hash(&canonical2), invite::expires_at(now_ms(), None))
        .await
        .unwrap();
    let typed = invite::normalize_code(&format!("  {}  ", invite::format_code(&canonical2))).unwrap();
    assert!(bob.redeem(&typed, "Carol's Mac").await.is_ok());
}

#[tokio::test]
async fn a_code_works_once_and_a_stale_one_not_at_all() {
    let be = fake_worker();
    let alice = Arc::new(FakeRemote::new(&be, "d-alice"));
    let bob = Arc::new(FakeRemote::with_token(&be, "d-bob", ""));

    let first = invite::random_code();
    alice
        .create_invite("bob@example.com", Some("Bob"), &invite::code_hash(&first), invite::expires_at(now_ms(), None))
        .await
        .unwrap();
    assert!(bob.redeem(&first, "Bob's Mac").await.is_ok());
    // One-time: the row went with the redeem, so the second try cannot tell
    // itself apart from a code that never existed.
    assert!(matches!(bob.redeem(&first, "Bob's other Mac").await, Err(RemoteError::Unauthorized)));
    assert!(matches!(bob.redeem(&invite::random_code(), "Nobody's Mac").await, Err(RemoteError::Unauthorized)));

    // A second invite for the same person kills the one they had: a second
    // Mac never needs an invite, so a second invite is always "lost the code".
    let second = invite::random_code();
    let third = invite::random_code();
    alice
        .create_invite("dana@example.com", None, &invite::code_hash(&second), invite::expires_at(now_ms(), None))
        .await
        .unwrap();
    alice
        .create_invite("dana@example.com", None, &invite::code_hash(&third), invite::expires_at(now_ms(), None))
        .await
        .unwrap();
    assert!(matches!(bob.redeem(&second, "Dana's Mac").await, Err(RemoteError::Unauthorized)));
    assert!(bob.redeem(&third, "Dana's Mac").await.is_ok());

    // Expiring, and expired reads exactly like unknown.
    let stale = invite::random_code();
    alice
        .create_invite("erin@example.com", None, &invite::code_hash(&stale), invite::expires_at(now_ms(), None))
        .await
        .unwrap();
    for held in be.lock().unwrap().invites.values_mut() {
        held.expires_at = now_ms() - 1;
    }
    assert!(matches!(bob.redeem(&stale, "Erin's Mac").await, Err(RemoteError::Unauthorized)));
    // And it is gone: the only row time can delete is one somebody tried to
    // use, which is what makes "expiring" true without a reaper.
    assert!(be.lock().unwrap().invites.is_empty());

    // An invite may not be dated past what the worker accepts, whatever is
    // asked for.
    let far = invite::expires_at(now_ms(), Some(365));
    assert!(far <= now_ms() + u64::from(invite::MAX_DAYS) * 24 * 60 * 60 * 1000);
}

#[tokio::test]
async fn an_invited_mac_joins_and_syncs_with_its_own_token() {
    let be = fake_worker();
    let events: Arc<dyn Events> = Arc::new(Collected::default());
    let a_root = tempfile::tempdir().unwrap();
    let a_state = tempfile::tempdir().unwrap();
    std::fs::write(a_root.path().join("readme.md"), "root doc\n").unwrap();

    let alice = Arc::new(FakeRemote::new(&be, "d-alice"));
    let bound = bind_domain(&alice, "Notes", "Alice's Mac").await.unwrap();
    seed_upload(&alice, a_root.path(), a_state.path(), "Notes", &bound.manifest_etag, "Alice's Mac", &events, "a")
        .await
        .unwrap();

    let canonical = invite::random_code();
    alice
        .create_invite("bob@example.com", Some("Bob"), &invite::code_hash(&canonical), invite::expires_at(now_ms(), None))
        .await
        .unwrap();
    let redeemed = Arc::new(FakeRemote::with_token(&be, "d-bob", ""))
        .redeem(&canonical, "Bob's Mac")
        .await
        .unwrap();

    // From here the invitee's flow IS the second Mac's flow: the token goes
    // into the same download the panel's "Connect another Mac…" feeds.
    let bob = Arc::new(FakeRemote::with_token(&be, "d-bob", &redeemed.token));
    let parent = tempfile::tempdir().unwrap();
    let dest = parent.path().join("Notes");
    let b_state = tempfile::tempdir().unwrap();
    let state = seed_download(&bob, &dest, b_state.path(), &events).await.unwrap();
    assert_eq!(state.files.len(), 1);
    assert_eq!(std::fs::read_to_string(dest.join("readme.md")).unwrap(), "root doc\n");

    // And it writes: a member is not a limited account (docs/cloud.md §5.4).
    // What it cannot do is administer the domain.
    let (manifest, etag) = bob.fetch_manifest(None).await.unwrap().unwrap();
    assert!(bob.put_manifest(&manifest, &etag).await.is_ok(), "the manifest is not role-gated");
    assert!(matches!(bob.wipe().await, Err(RemoteError::Forbidden)));
    assert!(matches!(
        bob.create_invite("eve@example.com", None, &invite::code_hash(&invite::random_code()), invite::expires_at(now_ms(), None))
            .await,
        Err(RemoteError::Forbidden)
    ));

    // A token nobody minted is refused outright, wherever it is presented.
    let nobody = FakeRemote::with_token(&be, "d-eve", "not-a-token");
    assert!(matches!(nobody.meta().await, Err(RemoteError::Unauthorized)));
    assert!(matches!(nobody.fetch_manifest(None).await, Err(RemoteError::Unauthorized)));

    // The owner's secret never went near the database, so it still works.
    assert!(alice.meta().await.is_ok());
}

/* ---------- Attribution by person (docs/cloud.md §6.6) ---------- */

#[tokio::test]
async fn work_is_signed_with_a_person_once_the_domain_says_who_this_mac_is() {
    let be = fake_worker();
    let owner = FakeRemote::new(&be, "d-alice");
    let ada = owner.adopt_owner("ada@example.com", Some("Ada")).await.unwrap();

    let mut a = device("Alice", &be);
    // The probe is where identity arrives, and the probe is what happens
    // before this engine writes anything.
    a.engine.probe_worker().await;
    a.write("doc.md", "written by a person\n");
    a.cycle().await;
    a.publish("doc.md", PublicKind::File, Some("the-doc")).unwrap();
    a.cycle().await;

    let m = manifest_of(&be);
    let f = m.files.values().next().unwrap();
    assert_eq!(f.by, ada.id, "the manifest carries the id");
    assert!(is_directory_id(&f.by), "{} is not a member id", f.by);
    assert_eq!(m.public["the-doc"].by, ada.id, "a published page too");
    assert!(!f.by.contains("Alice"), "and never the Mac's name");

    // Nothing downstream is handed an id: the engine resolves what it emits
    // through the directory the same probe brought, so no surface needs a
    // second answer to "who is m-00000001".
    let status = a.status();
    assert_eq!(status.me, "Ada");
    assert_eq!(status.public[0].by, "Ada");

    // Deleting is attribution too.
    a.delete("doc.md");
    a.cycle().await;
    assert_eq!(manifest_of(&be).tombstones.values().next().unwrap().by, ada.id);
}

#[tokio::test]
async fn a_conflict_copy_is_named_after_the_person_not_the_id() {
    let be = fake_worker();
    let owner = FakeRemote::new(&be, "d-alice");
    owner.adopt_owner("ada@example.com", Some("Ada")).await.unwrap();
    let token = invite_and_redeem(&be, &owner, "bob@example.com", "Bob Mbeki", "d-bob").await;

    let mut a = device("Alice", &be);
    let mut b = device_as("Bob", &be, tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), &token);
    a.engine.probe_worker().await;
    b.engine.probe_worker().await;

    a.write("doc.md", "shared line\n");
    a.cycle().await;
    b.cycle().await;

    a.write("doc.md", "ada's take on the line\n");
    a.cycle().await;
    b.write("doc.md", "bob's very different take\n");
    b.cycle().await;

    // The copy is a real file with a real name: an id in it would help
    // nobody, so this is the one place the engine has to resolve.
    let copies: Vec<String> = b.files().into_iter().filter(|p| p.contains("(conflict — ")).collect();
    assert_eq!(copies.len(), 1, "exactly one conflict copy, got {:?}", b.files());
    assert!(copies[0].contains("(conflict — Ada"), "named after a person: {}", copies[0]);
    assert!(!copies[0].contains("m-"), "not after an id: {}", copies[0]);
    assert_eq!(b.events.of(EV_CONFLICT)[0]["by"], "Ada");

    // And the other way round, so it is the *author* being resolved rather
    // than whoever happens to be reading.
    b.write("doc.md", "bob again\n");
    b.cycle().await;
    a.write("doc.md", "ada again\n");
    a.cycle().await;
    let hers: Vec<String> = a.files().into_iter().filter(|p| p.contains("(conflict — ")).collect();
    assert!(hers.iter().any(|p| p.contains("(conflict — Bob Mbeki")), "got {:?}", hers);
}

#[tokio::test(start_paused = true)]
async fn a_manifest_naming_a_stranger_asks_the_domain_once_who_they_are() {
    let be = fake_worker();
    let owner = FakeRemote::new(&be, "d-alice");
    let mut a = device("Alice", &be);
    a.write("mine.md", "mine\n");
    a.cycle().await;
    let before = be.lock().unwrap().meta_calls;

    // Somebody joined and wrote something. Their id means nothing here yet,
    // and a name that only arrives on the next launch is not a name.
    let bob = owner.adopt_owner("bob@example.com", Some("Bob")).await.unwrap();
    let sign_as = |be: &SharedWorker, by: &str| {
        let mut b = be.lock().unwrap();
        let f = b.manifest.files.values_mut().next().unwrap();
        f.rev += 1;
        f.mtime = now_ms();
        f.by = by.to_string();
        b.etag += 1;
    };
    sign_as(&be, &bob.id);
    tokio::time::sleep(DIRECTORY_MIN_GAP + Duration::from_secs(1)).await;
    a.cycle().await;
    assert_eq!(be.lock().unwrap().meta_calls, before + 1, "the stranger is what asked");

    // An id belonging to nobody — a person since removed — never resolves.
    // That costs one ask per gap, and never one per cycle.
    sign_as(&be, "m-deadbeef");
    be.lock().unwrap().members.clear();
    let asked = be.lock().unwrap().meta_calls;
    for _ in 0..3 {
        a.cycle().await;
    }
    assert_eq!(be.lock().unwrap().meta_calls, asked, "not once a cycle");
    tokio::time::sleep(DIRECTORY_MIN_GAP + Duration::from_secs(1)).await;
    a.cycle().await;
    assert_eq!(be.lock().unwrap().meta_calls, asked + 1, "once a gap at the very most");

    // And it is shown exactly as it stands rather than becoming "someone":
    // the app never invents an author it does not have.
    a.write("mine.md", "mine again\n");
    a.publish("mine.md", PublicKind::File, Some("mine")).unwrap();
    a.cycle().await;
    assert_eq!(a.status().me, "Alice", "this Mac still signs with its own name");
    assert_eq!(a.status().public[0].by, "Alice");
}

/* ---------- The People panel (docs/cloud.md §7.2) ---------- */

/// Invite `email`, redeem the code on `device_id`, and answer the token that
/// Mac now holds — the whole of "somebody joined", as the two commands behind
/// the panel run it.
async fn invite_and_redeem(be: &SharedWorker, owner: &FakeRemote, email: &str, name: &str, device_id: &str) -> String {
    let code = invite::random_code();
    owner
        .create_invite(email, Some(name), &invite::code_hash(&code), invite::expires_at(now_ms(), None))
        .await
        .unwrap();
    FakeRemote::with_token(be, device_id, "")
        .redeem(&code, &format!("{}'s Mac", name))
        .await
        .unwrap()
        .token
}

#[tokio::test]
async fn the_owner_sees_everyone_and_what_each_of_them_holds() {
    let be = fake_worker();
    let owner = FakeRemote::new(&be, "d-alice");

    let bob_token = invite_and_redeem(&be, &owner, "bob@example.com", "Bob", "d-bob").await;
    // Bob lost the code for his second Mac and asked again: one more invite,
    // one more credential, the same person.
    invite_and_redeem(&be, &owner, "Bob@example.com", "Bob", "d-bob-2").await;
    // Carol was invited and has not redeemed yet.
    let carol_code = invite::random_code();
    let carol_invite = owner
        .create_invite("carol@example.com", Some("Carol"), &invite::code_hash(&carol_code), invite::expires_at(now_ms(), Some(3)))
        .await
        .unwrap();

    let members = owner.list_members().await.unwrap();
    let bob = members.iter().find(|m| m.email == "bob@example.com").expect("Bob is a person here");
    let carol = members.iter().find(|m| m.email == "carol@example.com").expect("Carol is too");
    assert_eq!(bob.devices, 2, "one row per Mac, counted from the tokens");
    assert_eq!(carol.devices, 0, "invited is not signed in");
    assert_eq!(bob.role, "member");

    // The pending list is what has not been traded in. Bob's two codes are
    // both spent, so neither is on it.
    let invites = owner.list_invites().await.unwrap();
    assert_eq!(invites.len(), 1);
    assert_eq!(invites[0].id, carol_invite.id);
    assert_eq!(invites[0].email, "carol@example.com");

    // Every signed-in Mac, named — and never the credential that names it.
    let devices = owner.list_tokens().await.unwrap();
    assert_eq!(devices.len(), 2);
    assert!(devices.iter().all(|t| t.member_id == bob.id));
    assert!(devices.iter().any(|t| t.device_id.as_deref() == Some("d-bob") && t.device_name.as_deref() == Some("Bob's Mac")));
    assert!(
        devices.iter().all(|t| t.id != bob_token),
        "the list names a credential; it does not carry one"
    );
    // The owner's own Macs are not in it at all: they authenticate with the
    // domain's env secret, which is matched against no row, so there is
    // nothing here to list and nothing to revoke but the secret itself.
    assert!(devices.iter().all(|t| t.device_id.as_deref() != Some("d-alice")));
}

#[tokio::test]
async fn people_tells_a_mac_which_door_it_came_in_by() {
    let be = fake_worker();
    let owner = FakeRemote::new(&be, "d-alice");
    let token = invite_and_redeem(&be, &owner, "bob@example.com", "Bob", "d-bob").await;

    let seen = super::people_of(&owner, "d-alice", "notes.example.com").await.unwrap();
    assert_eq!(seen.role, "owner");
    assert_eq!(seen.device_id, "d-alice");
    assert_eq!(seen.members.len(), 1);
    assert_eq!(seen.devices.len(), 1);

    // A member is refused the list, and that refusal IS the answer — the
    // panel shows them their own half instead of an error. Nothing on disk
    // said which door this Mac came in by; the domain did.
    let bob = FakeRemote::with_token(&be, "d-bob", &token);
    let mine = super::people_of(&bob, "d-bob", "notes.example.com").await.unwrap();
    assert_eq!(mine.role, "member");
    assert_eq!(mine.device_id, "d-bob");
    assert!(mine.members.is_empty() && mine.invites.is_empty() && mine.devices.is_empty());

    // A credential nobody minted is a failure, not a door.
    let nobody = FakeRemote::with_token(&be, "d-eve", "not-a-token");
    let err = super::people_of(&nobody, "d-eve", "notes.example.com").await.unwrap_err();
    assert!(err.contains("rejected this token"), "{}", err);

    // The trap in the sentences: a worker predating the identity routes has
    // no /api/auth to miss, so it 404s — which must not come back as "that
    // domain holds no workspace yet".
    let old = super::describe_people("notes.example.com", RemoteError::NotFound);
    assert!(old.contains("too old to hold people"), "{}", old);
    // And on the way back out, a 404 from a revoke is success: the row is
    // gone, which is what was asked for.
    assert!(super::revoked("notes.example.com", Err(RemoteError::NotFound)).is_ok());
}

#[tokio::test]
async fn a_revoked_mac_stops_syncing_on_its_very_next_call() {
    let be = fake_worker();
    let mut alice = device("Alice", &be);
    alice.write("readme.md", "root doc\n");
    alice.cycle().await;

    let owner = FakeRemote::new(&be, "d-alice");
    let token = invite_and_redeem(&be, &owner, "bob@example.com", "Bob", "d-bob").await;
    let mut bob = device_as("Bob", &be, tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), &token);
    bob.cycle().await;
    assert_eq!(bob.read("readme.md").as_deref(), Some("root doc\n"));

    // The owner finds that Mac in the list and takes it away.
    let row = owner
        .list_tokens()
        .await
        .unwrap()
        .into_iter()
        .find(|t| t.device_id.as_deref() == Some("d-bob"))
        .expect("Bob's Mac is listed");
    owner.delete_token(&row.id).await.unwrap();

    // It bites on the very next call: the bearer resolves through the table
    // the delete emptied, so there is no session to wait out.
    bob.write("late.md", "written after the revoke\n");
    let _ = bob.engine.cycle().await;
    assert_eq!(bob.phase(), Phase::Revoked);
    assert!(!manifest_of(&be).files.values().any(|f| f.path == "late.md"));
    // The person stays: a Mac was revoked, not a colleague.
    assert_eq!(owner.list_members().await.unwrap().len(), 1);
    assert!(owner.list_tokens().await.unwrap().is_empty());

    // And the owner's own sync never noticed any of it.
    alice.write("after.md", "still fine\n");
    alice.cycle().await;
    assert!(manifest_of(&be).files.values().any(|f| f.path == "after.md"));
}

#[tokio::test]
async fn revoking_a_person_takes_every_mac_and_the_code_they_had() {
    let be = fake_worker();
    let owner = FakeRemote::new(&be, "d-alice");
    let first = invite_and_redeem(&be, &owner, "bob@example.com", "Bob", "d-bob").await;
    let second = invite_and_redeem(&be, &owner, "bob@example.com", "Bob", "d-bob-2").await;
    invite_and_redeem(&be, &owner, "carol@example.com", "Carol", "d-carol").await;
    // A third code, minted and never used — it has to go with the person too.
    let pending = invite::random_code();
    owner
        .create_invite("bob@example.com", None, &invite::code_hash(&pending), invite::expires_at(now_ms(), None))
        .await
        .unwrap();

    let bob = owner.list_members().await.unwrap().into_iter().find(|m| m.email == "bob@example.com").unwrap();
    owner.delete_member(&bob.id).await.unwrap();

    let left = owner.list_members().await.unwrap();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].email, "carol@example.com");
    assert_eq!(left[0].devices, 1, "Carol kept her Mac");
    // Both of Bob's Macs, and the code he never used.
    for token in [&first, &second] {
        let mac = FakeRemote::with_token(&be, "d-bob", token);
        assert!(matches!(mac.meta().await, Err(RemoteError::Unauthorized)));
    }
    assert!(owner.list_invites().await.unwrap().is_empty());
    assert!(matches!(
        FakeRemote::with_token(&be, "d-bob", "").redeem(&pending, "Bob's third Mac").await,
        Err(RemoteError::Unauthorized)
    ));
    // Asking twice is not an error the panel should show: the row is gone,
    // which is what was asked for.
    assert!(super::revoked("notes.example.com", owner.delete_member(&bob.id).await).is_ok());
}

#[tokio::test]
async fn an_invite_can_be_withdrawn_before_anybody_trades_it_in() {
    let be = fake_worker();
    let owner = FakeRemote::new(&be, "d-alice");
    let code = invite::random_code();
    let invite = owner
        .create_invite("bob@example.com", Some("Bob"), &invite::code_hash(&code), invite::expires_at(now_ms(), None))
        .await
        .unwrap();
    assert_eq!(owner.list_invites().await.unwrap().len(), 1);

    owner.delete_invite(&invite.id).await.unwrap();
    assert!(owner.list_invites().await.unwrap().is_empty());
    assert!(matches!(
        FakeRemote::with_token(&be, "d-bob", "").redeem(&code, "Bob's Mac").await,
        Err(RemoteError::Unauthorized)
    ));

    // The person stays: they were invited, not signed in, and inviting them
    // again reaches the same row rather than making a second Bob.
    let people = owner.list_members().await.unwrap();
    assert_eq!(people.len(), 1);
    assert_eq!(people[0].devices, 0);
    let again = invite::random_code();
    let re = owner
        .create_invite("bob@example.com", None, &invite::code_hash(&again), invite::expires_at(now_ms(), None))
        .await
        .unwrap();
    assert_eq!(re.member_id, people[0].id);
    assert_eq!(re.name, "Bob", "a re-invite without a name does not rename anybody");
}

#[tokio::test]
async fn the_owner_adopts_an_identity_and_only_one_row_holds_it() {
    let be = fake_worker();
    let owner = FakeRemote::new(&be, "d-alice");
    // Before it: a domain bound by an app that never asked who was binding it.
    assert!(owner.list_members().await.unwrap().iter().all(|m| m.role != "owner"));

    let ada = owner.adopt_owner("ada@example.com", Some("Ada")).await.unwrap();
    assert_eq!(ada.role, "owner");
    assert_eq!(ada.name, "Ada");
    // Saying it again renames rather than duplicating: the address is the key.
    let renamed = owner.adopt_owner("  Ada@Example.com ", Some("Ada Lovelace")).await.unwrap();
    assert_eq!(renamed.id, ada.id);
    assert_eq!(renamed.name, "Ada Lovelace");
    assert_eq!(owner.list_members().await.unwrap().len(), 1);

    // Inviting the owner's own address must not demote them — the role
    // describes a person, and a member token would never confer it anyway.
    let code = invite::random_code();
    owner
        .create_invite("ada@example.com", None, &invite::code_hash(&code), invite::expires_at(now_ms(), None))
        .await
        .unwrap();
    let redeemed = FakeRemote::with_token(&be, "d-ada-2", "").redeem(&code, "Ada's other Mac").await.unwrap();
    assert_eq!(redeemed.member.role, "owner", "the row is unchanged");
    let mine = super::people_of(&FakeRemote::with_token(&be, "d-ada-2", &redeemed.token), "d-ada-2", "d").await.unwrap();
    assert_eq!(mine.role, "member", "but the credential it minted is an ordinary one");

    // A new address takes the role and the old row keeps its place: it may
    // already be named in a manifest.
    let grace = owner.adopt_owner("grace@example.com", Some("Grace")).await.unwrap();
    let all = owner.list_members().await.unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(all.iter().filter(|m| m.role == "owner").count(), 1);
    assert_eq!(all.iter().find(|m| m.role == "owner").unwrap().id, grace.id);
    assert_eq!(all.iter().find(|m| m.id == ada.id).unwrap().role, "member");
}

/* ---------- Timing, the worker-outdated state, presence ---------- */

#[tokio::test(start_paused = true)]
async fn touched_path_settles_faster_than_a_watched_one() {
    let be = fake_worker();
    let a = device("Alice", &be);
    let root = a.root.path().to_path_buf();
    let statuses = a.statuses.clone();
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel();
    let (fs_tx, fs_rx) = tokio::sync::mpsc::unbounded_channel();
    let Device { engine, root: root_dir, _state, .. } = a;
    let task = tokio::spawn(engine.run(cmd_rx, fs_rx));

    // Let the first contact finish.
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    let key = root.to_string_lossy().to_string();
    assert_eq!(statuses.lock().unwrap()[&key].phase, Phase::Idle);
    assert_eq!(statuses.lock().unwrap()[&key].worker_version, Some(1));

    let has = |name: &str| manifest_of(&be).files.values().any(|f| f.path == name);

    // The edit bus: settles in 1.5 s.
    std::fs::write(root.join("typed.md"), "typed in the app\n").unwrap();
    cmd_tx.send(EngineCmd::Touched("typed.md".into())).unwrap();
    tokio::time::sleep(Duration::from_millis(1400)).await;
    assert!(!has("typed.md"), "not before the touch settles");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(has("typed.md"), "pushed 1.5 s after the touch");

    // The watcher alone: settles in 5 s.
    std::fs::write(root.join("external.md"), "written by another program\n").unwrap();
    fs_tx.send(()).unwrap();
    tokio::time::sleep(Duration::from_millis(1600)).await;
    assert!(!has("external.md"), "a watched write waits the full settle");
    tokio::time::sleep(Duration::from_millis(3600)).await;
    assert!(has("external.md"), "pushed 5 s after the event");

    // Shutdown leaves presence: the last poll says so.
    assert!(be.lock().unwrap().presence.contains_key("d-alice"), "here, while it runs");
    cmd_tx.send(EngineCmd::Shutdown).unwrap();
    task.await.unwrap();
    assert!(be.lock().unwrap().presence.get("d-alice").is_none());
    assert_eq!(be.lock().unwrap().polls.last(), Some(&Some(Beat::Leave)));
    drop(root_dir);
}

/// A workspace `notify` can't attach to — no inotify left, a filesystem
/// without watch support, a root that vanished between the config being read
/// and the watcher starting — must still sync. `spawn_engine` drops the
/// debouncer in that case, and the sender it holds with it, so the engine
/// sees a closed channel from its very first turn.
#[tokio::test(start_paused = true)]
async fn an_engine_whose_watcher_never_started_still_syncs() {
    let be = fake_worker();
    let a = device("Alice", &be);
    let root = a.root.path().to_path_buf();
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel();
    let (fs_tx, fs_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    drop(fs_tx);
    let Device { engine, root: root_dir, _state, .. } = a;
    let task = tokio::spawn(engine.run(cmd_rx, fs_rx));

    // Let the first contact finish.
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }

    // The edit bus still carries everything the app itself writes.
    std::fs::write(root.join("typed.md"), "typed in the app\n").unwrap();
    cmd_tx.send(EngineCmd::Touched("typed.md".into())).unwrap();
    tokio::time::sleep(Duration::from_millis(1600)).await;
    assert!(
        manifest_of(&be).files.values().any(|f| f.path == "typed.md"),
        "a workspace with no watcher still syncs on the bus"
    );

    // A second one, well past the poll: the engine is still running, not
    // spinning on a channel that answers None forever.
    tokio::time::sleep(POLL_INTERVAL * 2).await;
    std::fs::write(root.join("later.md"), "and again\n").unwrap();
    cmd_tx.send(EngineCmd::Touched("later.md".into())).unwrap();
    tokio::time::sleep(Duration::from_millis(1600)).await;
    assert!(manifest_of(&be).files.values().any(|f| f.path == "later.md"));

    cmd_tx.send(EngineCmd::Shutdown).unwrap();
    task.await.unwrap();
    assert!(be.lock().unwrap().presence.get("d-alice").is_none(), "and it leaves properly");
    drop(root_dir);
}

#[tokio::test]
async fn a_426_pauses_with_the_right_phase() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    a.engine.probe_worker().await;
    be.lock().unwrap().reject_schema = true;
    a.write("doc.md", "# doc\n");
    a.cycle().await;
    assert_eq!(a.phase(), Phase::WorkerOutdated);
    assert!(a.status().error.unwrap().contains("worker update"));
    assert_eq!(a.status().worker_version, Some(1));
    assert!(manifest_of(&be).files.is_empty());

    // Nothing moves until the worker does — not even a cycle asked for.
    a.write("more.md", "# more\n");
    let calls = be.lock().unwrap().put_manifest_calls;
    a.cycle().await;
    assert_eq!(be.lock().unwrap().put_manifest_calls, calls);
    assert_eq!(a.phase(), Phase::WorkerOutdated);

    // The same worker answering meta again changes nothing…
    a.engine.probe_worker().await;
    a.cycle().await;
    assert_eq!(a.phase(), Phase::WorkerOutdated);

    // …an updated one resumes the sync.
    {
        let mut be2 = be.lock().unwrap();
        be2.reject_schema = false;
        be2.worker_version = 2;
    }
    a.engine.probe_worker().await;
    a.cycle().await;
    assert_eq!(a.phase(), Phase::Idle);
    assert_eq!(a.status().worker_version, Some(2));
    assert_eq!(manifest_of(&be).files.len(), 2);
}

/// "Check again" in the update card: a Probe command re-asks the worker, and
/// an engine parked on a 426 resumes — with the cycle it had been holding —
/// the moment a newer version answers.
#[tokio::test]
async fn a_probe_command_resumes_an_outdated_engine() {
    let be = fake_worker();
    let a = device("Alice", &be);
    let root = a.root.path().to_path_buf();
    let statuses = a.statuses.clone();
    let key = root.to_string_lossy().to_string();
    std::fs::write(root.join("doc.md"), "# doc\n").unwrap();
    be.lock().unwrap().reject_schema = true;
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel();
    let (_fs_tx, fs_rx) = tokio::sync::mpsc::unbounded_channel();
    let Device { engine, root: root_dir, _state, .. } = a;
    let task = tokio::spawn(engine.run(cmd_rx, fs_rx));
    let phase = |statuses: &StatusTable| statuses.lock().unwrap()[&key].phase;
    let settle = || async {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
    };

    settle().await;
    assert_eq!(phase(&statuses), Phase::WorkerOutdated);
    assert!(manifest_of(&be).files.is_empty());

    // The same worker answering again: still waiting, status re-emitted.
    cmd_tx.send(EngineCmd::Probe).unwrap();
    settle().await;
    assert_eq!(phase(&statuses), Phase::WorkerOutdated);
    assert_eq!(statuses.lock().unwrap()[&key].worker_version, Some(1));

    // The updated worker: the probe clears the pause and the cycle runs.
    {
        let mut be2 = be.lock().unwrap();
        be2.reject_schema = false;
        be2.worker_version = 2;
    }
    cmd_tx.send(EngineCmd::Probe).unwrap();
    settle().await;
    assert_eq!(phase(&statuses), Phase::Idle);
    assert_eq!(statuses.lock().unwrap()[&key].worker_version, Some(2));
    assert!(manifest_of(&be).files.values().any(|f| f.path == "doc.md"));

    cmd_tx.send(EngineCmd::Shutdown).unwrap();
    task.await.unwrap();
    drop(root_dir);
}

#[tokio::test]
async fn presence_reports_the_edited_path_and_the_others() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    let mut b = device("Bob", &be);
    a.engine.probe_worker().await;
    b.engine.probe_worker().await;
    a.write("doc.md", "# doc\n");
    a.cycle().await;
    b.cycle().await;

    // The beat is the poll's: a new path makes one due, and the poll that
    // follows carries it.
    a.engine.set_activity(Some(a.abs("doc.md").to_string_lossy().to_string()));
    a.engine.poll_for_test().await;
    {
        let p = &be.lock().unwrap().presence;
        assert_eq!(p["d-alice"].name, "Alice");
        assert_eq!(p["d-alice"].path.as_deref(), Some("doc.md"));
    }
    // A path outside the workspace reads as idle.
    a.engine.set_activity(Some("/elsewhere/x.md".into()));
    a.engine.poll_for_test().await;
    assert_eq!(be.lock().unwrap().presence["d-alice"].path, None);
    a.engine.set_activity(Some(a.abs("doc.md").to_string_lossy().to_string()));
    a.engine.poll_for_test().await;

    // Bob's poll shows Alice, never Bob himself.
    b.engine.poll_for_test().await;
    let seen = b.status().presence;
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].device_id, "d-alice");
    assert_eq!(seen[0].name, "Alice");
    assert_eq!(seen[0].device, "Alice");
    assert_eq!(seen[0].path.as_deref(), Some("doc.md"));
}

/// Three polls, one beat. The beat has no request of its own any more: it
/// rides the first poll at least `PRESENCE_BEAT` after the last one, and a
/// path that changes brings the poll forward rather than waiting for it.
#[tokio::test(start_paused = true)]
async fn the_beat_rides_every_third_poll_and_a_new_path_brings_the_poll_forward() {
    let be = fake_worker();
    let a = device("Alice", &be);
    let doc = a.abs("doc.md").to_string_lossy().to_string();
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel();
    let (_fs_tx, fs_rx) = tokio::sync::mpsc::unbounded_channel();
    let Device { engine, root: root_dir, _state, .. } = a;
    let task = tokio::spawn(engine.run(cmd_rx, fs_rx));
    let settle = || async {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
    };
    settle().await;

    // A Mac that has never beaten owes one, so it shows up once it has
    // synced instead of a poll later.
    assert_eq!(be.lock().unwrap().polls.len(), 1, "the first poll follows the first cycle");
    assert!(matches!(be.lock().unwrap().polls[0], Some(Beat::Here { path: None, .. })));

    // Idle: a poll every 15 s, a beat on every third.
    be.lock().unwrap().polls.clear();
    tokio::time::sleep(POLL_INTERVAL * 6 + Duration::from_millis(100)).await;
    let polls = be.lock().unwrap().polls.clone();
    assert_eq!(polls.len(), 6, "{polls:?}");
    let beats = polls.iter().filter(|p| p.is_some()).count();
    assert_eq!(beats, 2, "one in three: {polls:?}");
    assert!(polls[..2].iter().all(Option::is_none), "nothing owed for 45 s: {polls:?}");
    assert!(polls[2].is_some());

    // Opening a document is owed a beat at once, and gets one.
    be.lock().unwrap().polls.clear();
    cmd_tx.send(EngineCmd::SetActivity(Some(doc))).unwrap();
    settle().await;
    let polls = be.lock().unwrap().polls.clone();
    assert_eq!(polls.len(), 1, "the poll came forward: {polls:?}");
    assert!(matches!(&polls[0], Some(Beat::Here { path: Some(p), .. }) if p == "doc.md"));
    assert_eq!(be.lock().unwrap().presence["d-alice"].path.as_deref(), Some("doc.md"));

    // …and it does not restart the cadence from scratch: the next beat is a
    // whole beat later, not on the next poll.
    be.lock().unwrap().polls.clear();
    tokio::time::sleep(POLL_INTERVAL * 2 + Duration::from_millis(100)).await;
    assert!(be.lock().unwrap().polls.iter().all(Option::is_none));

    cmd_tx.send(EngineCmd::Shutdown).unwrap();
    task.await.unwrap();
    assert_eq!(be.lock().unwrap().polls.last(), Some(&Some(Beat::Leave)), "it says goodbye");
    assert!(!be.lock().unwrap().presence.contains_key("d-alice"));
    drop(root_dir);
}

/// The budget this phase exists for (docs/cloud.md §11.2): an idle Mac is
/// four polls a minute and nothing else. The beat used to be two more.
#[tokio::test(start_paused = true)]
async fn an_idle_device_makes_exactly_four_requests_a_minute() {
    let be = fake_worker();
    let a = device("Alice", &be);
    std::fs::write(a.root.path().join("doc.md"), "# doc\n").unwrap();
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel();
    let (_fs_tx, fs_rx) = tokio::sync::mpsc::unbounded_channel();
    let Device { engine, root: root_dir, _state, .. } = a;
    let task = tokio::spawn(engine.run(cmd_rx, fs_rx));

    // First contact, the first mirror and the one-time clean-up all happen in
    // the first minute or so; the window starts once they are behind it.
    tokio::time::sleep(Duration::from_secs(120) + Duration::from_millis(100)).await;
    let (before, beats_before) = {
        let b = be.lock().unwrap();
        (b.requests, b.polls.iter().filter(|p| p.is_some()).count())
    };
    tokio::time::sleep(Duration::from_secs(60)).await;
    let b = be.lock().unwrap();
    assert_eq!(b.requests - before, 4, "four polls a minute, the beat folded into them");
    let beats = b.polls.iter().filter(|p| p.is_some()).count() - beats_before;
    assert!((1..=2).contains(&beats), "and still beating, {beats} times");
    drop(b);

    cmd_tx.send(EngineCmd::Shutdown).unwrap();
    task.await.unwrap();
    drop(root_dir);
}

/// Every settled edit runs a cycle, and a cycle pushes the poll clock back
/// — so a Mac someone is typing on used to poll rarely, and a beat that only
/// rode the clock would go quiet exactly while they were editing. An owed
/// beat brings the poll forward after a cycle instead.
#[tokio::test(start_paused = true)]
async fn a_mac_being_typed_on_keeps_beating_while_its_cycles_hold_off_the_poll() {
    let be = fake_worker();
    let a = device("Alice", &be);
    let root = a.root.path().to_path_buf();
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel();
    let (_fs_tx, fs_rx) = tokio::sync::mpsc::unbounded_channel();
    let Device { engine, root: root_dir, _state, .. } = a;
    let task = tokio::spawn(engine.run(cmd_rx, fs_rx));
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }

    // A save every 4 s for three minutes: each settles 1.5 s later into a
    // cycle, so the 15 s poll clock never runs out on its own.
    be.lock().unwrap().polls.clear();
    for i in 0..45 {
        std::fs::write(root.join("typed.md"), format!("draft {i}\n")).unwrap();
        cmd_tx.send(EngineCmd::Touched("typed.md".into())).unwrap();
        tokio::time::sleep(Duration::from_secs(4)).await;
    }
    let beats = be.lock().unwrap().polls.iter().filter(|p| p.is_some()).count();
    // 180 s at one beat per 45 s, give or take where the window cuts.
    assert!(beats >= 3, "only {beats} beats in three minutes of typing — the TTL is 90 s");
    assert!(be.lock().unwrap().presence.contains_key("d-alice"));

    cmd_tx.send(EngineCmd::Shutdown).unwrap();
    task.await.unwrap();
    drop(root_dir);
}

/// A worker before v7 has no beat to take: its poll is GET-only, and a POST
/// would be a 405 every 45 s. The app polls quietly instead — this Mac is
/// invisible, the others are not, and sync is untouched — and the hourly
/// pass that waits for the version store waits for this too, so updating the
/// worker reaches a Mac that is already running.
#[tokio::test(start_paused = true)]
async fn a_worker_without_presence_is_polled_and_never_beaten_at_until_it_is_updated() {
    let be = fake_worker();
    be.lock().unwrap().features.retain(|f| f != "presence");
    let a = device("Alice", &be);
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel();
    let (_fs_tx, fs_rx) = tokio::sync::mpsc::unbounded_channel();
    let Device { engine, root: root_dir, _state, .. } = a;
    let task = tokio::spawn(engine.run(cmd_rx, fs_rx));
    tokio::time::sleep(POLL_INTERVAL * 8).await;
    {
        let b = be.lock().unwrap();
        assert!(b.polls.len() >= 7, "it polls: {}", b.polls.len());
        assert!(b.polls.iter().all(Option::is_none), "and never sends a beat this worker would refuse");
        assert!(b.presence.is_empty());
    }

    // The worker is updated; within the hour this Mac notices, unprompted.
    be.lock().unwrap().features.push("presence".into());
    tokio::time::sleep(MIRROR_EVERY + POLL_INTERVAL * 2).await;
    assert!(be.lock().unwrap().polls.iter().any(Option::is_some), "beating, without a restart");
    assert!(be.lock().unwrap().presence.contains_key("d-alice"));

    cmd_tx.send(EngineCmd::Shutdown).unwrap();
    task.await.unwrap();
    drop(root_dir);
}

/// "Who else is here" names people (docs/cloud.md §5.3): the worker says
/// whose Mac each one is and the engine puts the directory's name to it —
/// except your own other Mac, which is named as a Mac, because "Ada is
/// editing" tells Ada nothing.
#[tokio::test]
async fn presence_names_the_person_and_your_own_other_mac_by_its_name() {
    let be = fake_worker();
    let owner = FakeRemote::new(&be, "d-studio");
    owner.adopt_owner("ada@example.com", Some("Ada")).await.unwrap();
    let token = invite_and_redeem(&be, &owner, "bob@example.com", "Bob Mbeki", "d-bob").await;

    let mut studio = device("Studio", &be);
    let mut air = device("Air", &be); // Ada's second Mac: the owner's secret too
    let mut bob = device_as("Bob", &be, tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), &token);
    for d in [&mut studio, &mut air, &mut bob] {
        d.engine.probe_worker().await;
        d.cycle().await;
        d.engine.poll_for_test().await;
    }
    studio.engine.poll_for_test().await;

    let seen = studio.status().presence;
    let bob_here = seen.iter().find(|p| p.device_id == "d-bob").unwrap();
    assert_eq!(bob_here.name, "Bob Mbeki", "a person, not a Mac");
    assert_eq!(bob_here.device, "Bob");
    assert!(bob_here.member_id.as_deref().map(is_directory_id).unwrap_or(false));
    let air_here = seen.iter().find(|p| p.device_id == "d-air").unwrap();
    assert_eq!(air_here.name, "Air", "your own other Mac is told apart by its name");
    assert_eq!(air_here.member_id, studio.engine.me_for_test().map(String::from));

    // Bob sees Ada, twice, as Ada — once per Mac, each with its name.
    bob.engine.poll_for_test().await;
    let theirs = bob.status().presence;
    assert_eq!(theirs.iter().filter(|p| p.name == "Ada").count(), 2);
    assert_eq!(
        theirs.iter().map(|p| p.device.as_str()).collect::<BTreeSet<_>>(),
        ["Air", "Studio"].into_iter().collect()
    );
}

/// Someone who joined after this engine last probed is here before they are
/// in its directory. Their Mac's name stands in for them, and the engine asks
/// who they are — once, under the same gap as a stranger in the manifest.
#[tokio::test(start_paused = true)]
async fn a_stranger_here_is_shown_as_their_mac_and_asked_about_once() {
    let be = fake_worker();
    let owner = FakeRemote::new(&be, "d-studio");
    owner.adopt_owner("ada@example.com", Some("Ada")).await.unwrap();
    let mut studio = device("Studio", &be);
    studio.engine.probe_worker().await;
    studio.cycle().await;

    let token = invite_and_redeem(&be, &owner, "cy@example.com", "Cy", "d-cy").await;
    let mut cy = device_as("Laptop", &be, tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), &token);
    cy.engine.probe_worker().await;
    cy.cycle().await;
    cy.engine.poll_for_test().await;

    tokio::time::sleep(DIRECTORY_MIN_GAP + Duration::from_secs(1)).await;
    let before = be.lock().unwrap().meta_calls;
    studio.engine.poll_for_test().await;
    assert_eq!(be.lock().unwrap().meta_calls, before + 1, "a Mac here nobody can name is what asked");
    let here = &studio.status().presence[0];
    assert_eq!(here.name, "Cy", "and the answer names them on the same poll");
    assert_eq!(here.device, "Laptop");
    for _ in 0..3 {
        studio.engine.poll_for_test().await;
    }
    assert_eq!(be.lock().unwrap().meta_calls, before + 1, "not once a poll");
}

/// The beat is presence, not sync: a poll that fails takes its beat with it
/// and the next poll owes it again — no retry loop, no extra request.
#[tokio::test(start_paused = true)]
async fn a_beat_lost_with_its_poll_rides_the_next_one() {
    let be = fake_worker();
    let a = device("Alice", &be);
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel();
    let (_fs_tx, fs_rx) = tokio::sync::mpsc::unbounded_channel();
    let Device { engine, root: root_dir, _state, .. } = a;
    let task = tokio::spawn(engine.run(cmd_rx, fs_rx));
    tokio::time::sleep(PRESENCE_BEAT - Duration::from_secs(1)).await;

    be.lock().unwrap().offline = true;
    let before = be.lock().unwrap().requests;
    tokio::time::sleep(POLL_INTERVAL * 2).await;
    assert_eq!(be.lock().unwrap().requests - before, 2, "two polls refused, nothing hammering behind them");
    be.lock().unwrap().offline = false;
    be.lock().unwrap().polls.clear();
    tokio::time::sleep(POLL_INTERVAL).await;
    assert!(
        matches!(be.lock().unwrap().polls.first(), Some(Some(Beat::Here { .. }))),
        "the first poll back carries the beat it owed"
    );

    cmd_tx.send(EngineCmd::Shutdown).unwrap();
    task.await.unwrap();
    drop(root_dir);
}

/* ---------- Leases (docs/cloud.md §8.2) ---------- */

/// Two Macs with a document between them, both synced and probed.
async fn two_with_a_doc(be: &SharedWorker) -> (Device, Device) {
    let mut a = device("Alice", be);
    let mut b = device("Bob", be);
    a.engine.probe_worker().await;
    b.engine.probe_worker().await;
    a.write("doc.md", "# doc\n");
    a.cycle().await;
    b.cycle().await;
    (a, b)
}

fn open(d: &mut Device, rel: &str) {
    let abs = d.abs(rel).to_string_lossy().to_string();
    d.engine.set_activity(Some(abs));
}

fn beats(be: &SharedWorker) -> Vec<Beat> {
    be.lock().unwrap().polls.iter().flatten().cloned().collect()
}

/// Opening a document claims it on the beat its new path is owed — there is
/// no request of its own — and a second Mac opening it is refused and told
/// who has it, whatever case it spells the path in.
#[tokio::test]
async fn opening_a_document_claims_it_and_another_mac_sees_it_held() {
    let be = fake_worker();
    let (mut a, mut b) = two_with_a_doc(&be).await;

    open(&mut a, "doc.md");
    a.engine.poll_for_test().await;
    assert!(a.engine.holds_for_test("doc.md"), "the beat that names it claims it");
    assert!(a.status().leases.is_empty(), "your own lease is not a lock on you");

    open(&mut b, "DOC.md");
    b.engine.poll_for_test().await;
    assert!(!b.engine.holds_for_test("doc.md"), "refused: one document is one lock, in any case");
    assert_eq!(be.lock().unwrap().leases["doc.md"].device_id, "d-alice", "nothing moved");
    let held = b.status().leases;
    assert_eq!(held.len(), 1);
    assert_eq!(held[0].path, "doc.md");
    assert_eq!(held[0].device_id, "d-alice");
    assert_eq!(held[0].name, "Alice");
    assert!(!held[0].own);

    // Refused is not owed: Bob's next polls are plain GETs until it frees.
    be.lock().unwrap().polls.clear();
    b.engine.poll_for_test().await;
    b.engine.poll_for_test().await;
    assert!(be.lock().unwrap().polls.iter().all(Option::is_none), "{:?}", be.lock().unwrap().polls);
}

/// Moving on is letting go: the beat that names another document releases
/// this one, and the Mac that was waiting for it claims it on the poll after
/// it hears — while a Mac with nothing open holds nothing.
#[tokio::test]
async fn moving_on_lets_go_and_the_mac_waiting_claims_it_next() {
    let be = fake_worker();
    let (mut a, mut b) = two_with_a_doc(&be).await;
    open(&mut a, "doc.md");
    a.engine.poll_for_test().await;
    open(&mut b, "doc.md");
    b.engine.poll_for_test().await;
    assert!(!b.engine.holds_for_test("doc.md"));

    open(&mut a, "other.md");
    a.engine.poll_for_test().await;
    assert!(!a.engine.holds_for_test("doc.md"), "released by the beat that named something else");
    assert!(a.engine.holds_for_test("other.md"));

    be.lock().unwrap().polls.clear();
    b.engine.poll_for_test().await;
    assert_eq!(be.lock().unwrap().polls, vec![None], "nothing was owed when it asked");
    assert!(b.status().leases.iter().all(|l| l.path != "doc.md"), "and now it knows: free");
    b.engine.poll_for_test().await;
    assert!(
        matches!(be.lock().unwrap().polls.last(), Some(Some(Beat::Here { path: Some(p), take: false, .. })) if p == "doc.md"),
        "a free document it has open is owed a claim, and the next poll carries it"
    );
    assert!(b.engine.holds_for_test("doc.md"));

    a.engine.set_activity(None);
    a.engine.poll_for_test().await;
    assert!(be.lock().unwrap().leases.values().all(|l| l.device_id != "d-alice"), "nothing open, nothing held");
}

/// *Take over* claims a document somebody else holds, once — the flag rides
/// one beat and is spent — and the Mac it was taken from finds out on its
/// next poll and cannot take it back by merely having it open.
#[tokio::test(start_paused = true)]
async fn take_over_claims_a_held_document_once_and_the_holder_hears_on_its_next_poll() {
    let be = fake_worker();
    let (mut a, mut b) = two_with_a_doc(&be).await;
    open(&mut a, "doc.md");
    a.engine.poll_for_test().await;
    open(&mut b, "doc.md");
    b.engine.poll_for_test().await;
    assert!(!b.engine.holds_for_test("doc.md"));

    b.engine.take_over(b.abs("doc.md").to_string_lossy().to_string());
    b.engine.poll_for_test().await;
    assert!(matches!(beats(&be).last(), Some(Beat::Here { take: true, .. })));
    assert!(b.engine.holds_for_test("doc.md"), "taken");
    assert!(b.status().leases.is_empty());

    a.engine.poll_for_test().await;
    let held = a.status().leases;
    assert_eq!(held.iter().map(|l| l.device_id.as_str()).collect::<Vec<_>>(), ["d-bob"], "Alice hears on her next poll");
    assert!(!a.engine.holds_for_test("doc.md"));

    // A beat later, both renew what they have: Bob his lease, Alice nothing.
    tokio::time::advance(PRESENCE_BEAT).await;
    a.engine.poll_for_test().await;
    b.engine.poll_for_test().await;
    let last_two: Vec<Beat> = beats(&be).into_iter().rev().take(2).collect();
    assert!(last_two.iter().all(|b| matches!(b, Beat::Here { take: false, .. })), "take is spent once carried: {last_two:?}");
    assert_eq!(be.lock().unwrap().leases["doc.md"].device_id, "d-bob", "and having it open does not take it back");
}

/// Typing is what keeps a document yours. Each write the app makes to the
/// document being edited renews the editing, so the lease is carried on beat
/// after beat for as long as somebody types; a Mac left with it open lets go
/// `ACTIVITY_FRESH` after the last keystroke, and a write to some other file
/// does not count.
#[tokio::test(start_paused = true)]
async fn typing_keeps_a_document_and_walking_away_lets_it_go() {
    let be = fake_worker();
    let (mut a, _b) = two_with_a_doc(&be).await;
    open(&mut a, "doc.md");
    a.engine.poll_for_test().await;
    assert!(a.engine.holds_for_test("doc.md"));

    for _ in 0..4 {
        tokio::time::advance(ACTIVITY_FRESH - Duration::from_secs(60)).await;
        a.engine.touch_activity("doc.md");
        a.engine.poll_for_test().await;
    }
    assert!(a.engine.holds_for_test("doc.md"), "sixteen minutes of typing, still Alice's");
    assert!(matches!(beats(&be).last(), Some(Beat::Here { path: Some(p), .. }) if p == "doc.md"));

    tokio::time::advance(ACTIVITY_FRESH - Duration::from_secs(60)).await;
    a.engine.touch_activity("doc.meta.jsonl");
    a.engine.touch_activity("other.md");
    tokio::time::advance(Duration::from_secs(61)).await;
    a.engine.poll_for_test().await;
    assert!(!a.engine.holds_for_test("doc.md"), "walked away: let go");
    assert!(be.lock().unwrap().leases.is_empty());
    assert_eq!(be.lock().unwrap().presence["d-alice"].path, None, "and here, idle");
}

/// A lock nobody can confirm is no lock. A poll that fails takes the leases
/// it was showing with it, and an engine that is not hearing the domain —
/// paused here — shows none, so nothing it last heard keeps an editor
/// view-only.
#[tokio::test]
async fn a_lock_this_mac_cannot_hear_about_is_no_lock() {
    let be = fake_worker();
    let (mut a, mut b) = two_with_a_doc(&be).await;
    open(&mut a, "doc.md");
    a.engine.poll_for_test().await;
    b.engine.poll_for_test().await;
    assert_eq!(b.status().leases.len(), 1);

    be.lock().unwrap().offline = true;
    b.engine.poll_for_test().await;
    assert!(b.status().leases.is_empty(), "dropped with the poll that failed");
    be.lock().unwrap().offline = false;
    b.engine.poll_for_test().await;
    assert_eq!(b.status().leases.len(), 1, "and back with the next one");

    b.engine.set_paused(true);
    assert!(b.status().leases.is_empty(), "a paused engine is not listening");
    b.engine.set_paused(false);
    assert_eq!(b.status().leases.len(), 1);
}

/// A worker before v8, or one whose database cannot answer, has no lock to
/// give: the app shows none, and — the part that would cost — is never left
/// owing a claim, so an editing Mac still beats one poll in three.
#[tokio::test]
async fn a_worker_without_leases_or_a_database_shows_no_lock_and_is_not_claimed_at() {
    for older in [true, false] {
        let be = fake_worker();
        if older {
            be.lock().unwrap().features.retain(|f| f != "leases");
        }
        let (mut a, mut b) = two_with_a_doc(&be).await;
        be.lock().unwrap().d1_down = !older;
        open(&mut a, "doc.md");
        a.engine.poll_for_test().await;
        open(&mut b, "doc.md");
        b.engine.poll_for_test().await;
        assert!(b.status().leases.is_empty());
        assert!(be.lock().unwrap().leases.is_empty());

        be.lock().unwrap().polls.clear();
        for _ in 0..3 {
            a.engine.poll_for_test().await;
            b.engine.poll_for_test().await;
        }
        assert!(be.lock().unwrap().polls.iter().all(Option::is_none), "older={older}: nothing owed");
    }
}

/// A lease names whoever holds it the way presence does: the person, and your
/// own other Mac by its name — flagged, so the editor can say "open on your
/// other Mac" rather than name you to yourself.
#[tokio::test]
async fn a_lease_names_the_person_and_your_own_other_mac() {
    let be = fake_worker();
    let owner = FakeRemote::new(&be, "d-studio");
    owner.adopt_owner("ada@example.com", Some("Ada")).await.unwrap();
    let token = invite_and_redeem(&be, &owner, "bob@example.com", "Bob Mbeki", "d-bob").await;
    let mut studio = device("Studio", &be);
    let mut air = device("Air", &be);
    let mut bob = device_as("Bob", &be, tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), &token);
    for d in [&mut studio, &mut air, &mut bob] {
        d.engine.probe_worker().await;
        d.cycle().await;
    }
    open(&mut air, "a.md");
    air.engine.poll_for_test().await;
    open(&mut bob, "b.md");
    bob.engine.poll_for_test().await;
    studio.engine.poll_for_test().await;

    let held = studio.status().leases;
    let on_air = held.iter().find(|l| l.path == "a.md").unwrap();
    assert!(on_air.own, "Ada's other Mac");
    assert_eq!(on_air.name, "Air");
    let on_bob = held.iter().find(|l| l.path == "b.md").unwrap();
    assert!(!on_bob.own);
    assert_eq!(on_bob.name, "Bob Mbeki");
    assert_eq!(on_bob.device, "Bob");

    bob.engine.poll_for_test().await;
    let theirs = bob.status().leases;
    assert_eq!(theirs.len(), 1);
    assert_eq!((theirs[0].name.as_str(), theirs[0].own), ("Ada", false), "to Bob, it is Ada's");
}

/// The budget holds while somebody edits: holding a lease is renewing it on
/// the beat that was going out anyway, so a Mac with a document open is the
/// same four requests a minute as an idle one — and quitting lets go of it.
#[tokio::test(start_paused = true)]
async fn an_editing_mac_holding_its_document_still_makes_four_requests_a_minute() {
    let be = fake_worker();
    let a = device("Alice", &be);
    std::fs::write(a.root.path().join("doc.md"), "# doc\n").unwrap();
    let doc = a.abs("doc.md").to_string_lossy().to_string();
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel();
    let (_fs_tx, fs_rx) = tokio::sync::mpsc::unbounded_channel();
    let Device { engine, root: root_dir, _state, .. } = a;
    let task = tokio::spawn(engine.run(cmd_rx, fs_rx));
    cmd_tx.send(EngineCmd::SetActivity(Some(doc))).unwrap();

    tokio::time::sleep(Duration::from_secs(120) + Duration::from_millis(100)).await;
    assert_eq!(be.lock().unwrap().leases.get("doc.md").map(|l| l.device_id.as_str()), Some("d-alice"));
    let before = be.lock().unwrap().requests;
    tokio::time::sleep(Duration::from_secs(60)).await;
    assert_eq!(be.lock().unwrap().requests - before, 4, "the renewal rides the beat");
    assert!(be.lock().unwrap().leases.contains_key("doc.md"), "and keeps it");

    cmd_tx.send(EngineCmd::Shutdown).unwrap();
    task.await.unwrap();
    assert!(be.lock().unwrap().leases.is_empty(), "a quitting Mac's leave lets go of it");
    drop(root_dir);
}

/// A worker that takes beats but holds no leases (v7) still claims nothing
/// for an app that knows it, and the app owes it no claim — until it is
/// updated. The hourly pass that waits for `versions` and `presence` waits
/// for `leases` too, so a Mac that is already running learns it within the
/// hour, and stops asking once it has.
#[tokio::test(start_paused = true)]
async fn the_hourly_pass_asks_again_until_the_worker_holds_leases() {
    let be = fake_worker();
    be.lock().unwrap().features.retain(|f| f != "leases");
    let mut a = device("Alice", &be);
    a.engine.probe_worker().await;
    a.cycle().await;
    a.engine.mirror_versions().await;

    let asks = |be: &SharedWorker| be.lock().unwrap().meta_calls;
    tokio::time::advance(MIRROR_EVERY).await;
    let before = asks(&be);
    a.engine.mirror_versions().await;
    assert_eq!(asks(&be), before + 1, "a worker without leases is asked again on the hour");

    be.lock().unwrap().features.push("leases".into());
    tokio::time::advance(MIRROR_EVERY).await;
    a.engine.mirror_versions().await;
    assert_eq!(asks(&be), before + 2, "which is how the update is noticed");

    // Known now: a free document it has open is owed a claim at once.
    open(&mut a, "doc.md");
    a.engine.poll_for_test().await;
    assert!(a.engine.holds_for_test("doc.md"));
    tokio::time::advance(MIRROR_EVERY).await;
    a.engine.mirror_versions().await;
    assert_eq!(asks(&be), before + 2, "and nothing is missing, so nothing is asked");
}

/* ---------- The bus, the wake, the grammars, the config ---------- */

#[test]
fn bus_routes_a_touch_to_the_engine_whose_root_holds_it() {
    let bus = EditBus::default();
    let (a_tx, mut a_rx) = tokio::sync::mpsc::unbounded_channel();
    let (b_tx, mut b_rx) = tokio::sync::mpsc::unbounded_channel();
    bus.register(PathBuf::from("/ws/a"), a_tx);
    bus.register(PathBuf::from("/ws/b"), b_tx);

    assert!(bus.touch(std::path::Path::new("/ws/a/notes/x.md")));
    match a_rx.try_recv() {
        Ok(EngineCmd::Touched(rel)) => assert_eq!(rel, "notes/x.md"),
        _ => panic!("a must hear its touch"),
    }
    assert!(b_rx.try_recv().is_err(), "b hears nothing");

    assert!(!bus.touch(std::path::Path::new("/elsewhere/x.md")));
    assert!(!bus.touch(std::path::Path::new("/ws/a/.doklin/cloud.json")), "hidden paths never wake it");
    assert!(!bus.touch(std::path::Path::new("/ws/a/x.md.doklin-sync-tmp")));
    assert!(!bus.touch(std::path::Path::new("/ws/a")), "the root itself is not a file");
    assert!(a_rx.try_recv().is_err());

    bus.unregister(std::path::Path::new("/ws/a"));
    assert!(!bus.touch(std::path::Path::new("/ws/a/notes/x.md")));
}

#[tokio::test(start_paused = true)]
async fn next_wake_prefers_the_touch_settle() {
    let now = tokio::time::Instant::now();
    let poll = now + Duration::from_secs(15);
    assert_eq!(next_wake(poll, None, None), poll);
    assert_eq!(next_wake(poll, Some(now), None), now + Duration::from_secs(5));
    assert_eq!(next_wake(poll, Some(now), Some(now)), now + Duration::from_millis(1500));
    assert_eq!(next_wake(poll, None, Some(now)), now + Duration::from_millis(1500));
    let late = now + Duration::from_secs(20);
    assert_eq!(next_wake(poll, Some(late), None), poll, "the poll comes first when the hint is far off");
}

#[test]
fn slug_grammar_and_uniqueness() {
    assert!(valid_slug("plan"));
    assert!(valid_slug("2026-roadmap"));
    assert!(valid_slug("k7m2p9qx"));
    assert!(!valid_slug("ab"), "too short");
    assert!(!valid_slug("-plan"), "must start with a letter or digit");
    assert!(!valid_slug("Plan"), "lowercase only");
    assert!(!valid_slug("my page"));
    assert!(!valid_slug("api"), "reserved");
    assert!(!valid_slug("robots.txt"));
    assert!(!valid_slug(&"a".repeat(65)));
    assert!(valid_slug(&"a".repeat(64)));
    for _ in 0..20 {
        let s = random_slug();
        assert!(valid_slug(&s) && s.len() == RANDOM_SLUG_LEN, "{}", s);
    }
    let taken = ["plan", "plan-2"];
    assert_eq!(unique_slug("plan", |s| taken.contains(&s)), "plan-3");
    assert_eq!(unique_slug("free", |s| taken.contains(&s)), "free");
    let long = "x".repeat(64);
    let bumped = unique_slug(&long, |s| s == long);
    assert!(valid_slug(&bumped) && bumped.ends_with("-2"));
}

#[test]
fn path_grammar_and_text_caps() {
    assert!(valid_rel_path("a.md"));
    assert!(valid_rel_path("Projects/plan.md"));
    assert!(!valid_rel_path(""));
    assert!(!valid_rel_path("/abs.md"));
    assert!(!valid_rel_path("a/../b.md"));
    assert!(!valid_rel_path("./a.md"));
    assert!(!valid_rel_path("a//b.md"));
    assert!(!valid_rel_path("a\\b.md"));
    let deep = (0..13).map(|_| "d").collect::<Vec<_>>().join("/");
    assert!(!valid_rel_path(&deep));
    assert!(valid_rel_path(&deep[..deep.len() - 2]));

    assert_eq!(cap_utf16("héllo", 3), "hél");
    assert_eq!(cap_utf16("a😀b", 2), "a", "an astral char is two units");
    assert_eq!(cap_utf16("a😀b", 3), "a😀");
    assert_eq!(clean_name("  ", "Notes"), "Notes");
    assert_eq!(clean_name(&"n".repeat(100), "x").len(), MAX_NAME_LEN);
    assert_eq!(clean_text(Some("  a title "), 300).as_deref(), Some("a title"));
    assert_eq!(clean_text(Some("   "), 300), None);
    assert_eq!(clean_text(None, 300), None);
}

#[test]
fn dedupe_suffixes_the_younger_id() {
    let mut m = Manifest::default();
    for (fid, path) in [("f-bbb", "Notes/plan.md"), ("f-aaa", "notes/Plan.md")] {
        m.files.insert(
            fid.into(),
            ManifestFile { path: path.into(), rev: 1, hash: "0".repeat(16), size: 1, mtime: 0, by: "".into() },
        );
    }
    dedupe_paths(&mut m);
    assert_eq!(m.files["f-aaa"].path, "notes/Plan.md");
    assert_eq!(m.files["f-bbb"].path, "Notes/plan (-bbb).md");
    assert_eq!(m.files["f-bbb"].rev, 2);
}

#[test]
fn manifest_wire_shape_matches_the_worker() {
    let mut m = Manifest { name: "Notes".into(), seq: 3, ..Default::default() };
    m.public.insert(
        "home".into(),
        PublicEntry {
            kind: PublicKind::File,
            file: Some("f-1".into()),
            path: "Home.md".into(),
            title: None,
            desc: None,
            root: true,
            by: "Alice".into(),
            at: 5,
        },
    );
    m.public.insert(
        "docs".into(),
        PublicEntry {
            kind: PublicKind::Dir,
            file: None,
            path: "".into(),
            title: Some("Docs".into()),
            desc: None,
            root: false,
            by: "Alice".into(),
            at: 6,
        },
    );
    let v = serde_json::to_value(&m).unwrap();
    assert_eq!(v["version"], MANIFEST_VERSION);
    assert_eq!(v["public"]["home"]["kind"], "file");
    assert_eq!(v["public"]["home"]["root"], true);
    assert!(v["public"]["home"].get("title").is_none(), "absent, not null");
    assert_eq!(v["public"]["docs"]["kind"], "dir");
    assert!(v["public"]["docs"].get("file").is_none());
    assert!(v["public"]["docs"].get("root").is_none(), "false is omitted");
    let back: Manifest = serde_json::from_value(v).unwrap();
    assert_eq!(back, m);
    // A manifest the worker wrote (no tombstones/public keys at all) reads.
    let sparse: Manifest = serde_json::from_str(r#"{"version":2,"name":"N","seq":0,"files":{}}"#).unwrap();
    assert!(sparse.public.is_empty());
}

#[test]
fn cloud_file_and_marker_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    assert!(read_cloud_file(dir.path()).workspaces.is_empty());
    let mut file = CloudFile::default();
    file.upsert(WorkspaceEntry {
        root: "/Users/me/Notes".into(),
        domain: "notes.example.com".into(),
        endpoint: "https://notes.example.com".into(),
        ws_id: "w-1".into(),
        name: "Notes".into(),
        token: "t".into(),
    });
    // One entry per root, one per domain.
    file.upsert(WorkspaceEntry {
        root: "/Users/me/Notes".into(),
        domain: "other.example.com".into(),
        endpoint: "https://other.example.com".into(),
        ws_id: "w-2".into(),
        name: "Notes".into(),
        token: "t2".into(),
    });
    assert_eq!(file.workspaces.len(), 1);
    assert_eq!(file.workspaces[0].ws_id, "w-2");
    write_cloud_file(dir.path(), &file).unwrap();
    let back = read_cloud_file(dir.path());
    assert_eq!(back.version, 1);
    assert_eq!(back.by_root("/Users/me/Notes").unwrap().token, "t2");

    // Garbage reads as nothing connected; a half entry is dropped.
    std::fs::write(dir.path().join("cloud.json"), "{not json").unwrap();
    assert!(read_cloud_file(dir.path()).workspaces.is_empty());
    std::fs::write(
        dir.path().join("cloud.json"),
        r#"{"version":1,"workspaces":[{"root":"/x","domain":"d","endpoint":"https://d","wsId":"w","name":"n","token":""}]}"#,
    )
    .unwrap();
    assert!(read_cloud_file(dir.path()).workspaces.is_empty());

    let root = tempfile::tempdir().unwrap();
    assert!(read_marker(root.path()).is_none());
    let marker = Marker { domain: "notes.example.com".into(), ws_id: "w-1".into() };
    write_marker(root.path(), &marker).unwrap();
    assert_eq!(read_marker(root.path()), Some(marker));
    assert!(root.path().join(".doklin/cloud.json").exists());
    assert!(scan_local(root.path()).unwrap().is_empty(), "the marker is invisible to the scan");
    super::config::remove_marker(root.path());
    assert!(read_marker(root.path()).is_none());
}

#[test]
fn endpoints_normalize() {
    assert_eq!(normalize_endpoint("notes.example.com").unwrap(), "https://notes.example.com");
    assert_eq!(normalize_endpoint(" https://notes.example.com/ ").unwrap(), "https://notes.example.com");
    assert_eq!(
        normalize_endpoint("https://doklin-sherin.workers.dev").unwrap(),
        "https://doklin-sherin.workers.dev"
    );
    assert_eq!(normalize_endpoint("http://localhost:8787").unwrap(), "http://localhost:8787");
    assert!(normalize_endpoint("http://notes.example.com").is_err(), "https only off loopback");
    assert!(normalize_endpoint("https://notes.example.com/api").is_err(), "no path");
    assert!(normalize_endpoint("").is_err());
    assert_eq!(super::config::domain_of("https://notes.example.com").as_deref(), Some("notes.example.com"));
    assert_eq!(super::config::domain_of("http://localhost:8787").as_deref(), Some("localhost:8787"));
    assert_eq!(super::config::sanitize_folder_name("Notes / 2026"), "Notes - 2026");
    assert_eq!(super::config::sanitize_folder_name(" .. "), "Workspace");
}

/* ---------- The version store's mirror (docs/versioning-plan.md §6.2) ---------- */

const MINUTE: u64 = 60 * 1000;
const HOUR: u64 = 60 * MINUTE;
const DAY: u64 = 24 * HOUR;

/// A moment `ago` milliseconds back. The mirror reads the wall clock — the
/// ladder's whole job is to treat old snapshots differently from new ones —
/// so a test's timestamps have to be anchored to now, not to a constant.
fn ago(ms: u64) -> u64 {
    now_ms() - ms
}

fn cloud_index(be: &SharedWorker) -> VersionsIndex {
    be.lock().unwrap().versions_index.clone().unwrap_or_default()
}

fn cloud_ids(be: &SharedWorker) -> Vec<String> {
    cloud_index(be).snapshots.into_iter().map(|e| e.id).collect()
}

#[tokio::test]
async fn mirror_uploads_local_snapshots_and_their_blobs() {
    let be = fake_worker();
    let mut a = device("Air", &be);
    a.engine.probe_worker().await;
    let (first, second) = (ago(40 * MINUTE), ago(20 * MINUTE));
    a.captured(first, Reason::Seed, &[("Home.md", "one\n")]);
    a.captured(second, Reason::Interval, &[("Home.md", "one\ntwo\n")]);
    a.engine.mirror_versions().await;

    let index = cloud_index(&be);
    assert_eq!(index.version, 1);
    assert_eq!(index.horizon_days, None, "forever, until settings say otherwise");
    assert_eq!(
        cloud_ids(&be),
        vec![snapshot_id(first, &a.device_id()), snapshot_id(second, &a.device_id())],
        "oldest first, and named by when and by whom"
    );
    let seed = &index.snapshots[0];
    assert_eq!(seed.reason, "seed");
    assert_eq!(seed.device, a.device_id());
    assert_eq!(seed.files, 1);

    {
        let worker = be.lock().unwrap();
        assert_eq!(worker.version_snapshots.len(), 2, "both snapshots' bytes are up there");
        assert_eq!(worker.version_blobs.len(), 2, "and both versions of the file");
        for hash in [hash_full(b"one\n"), hash_full(b"one\ntwo\n")] {
            assert!(worker.version_blobs.contains_key(&hash), "the blob is keyed by its whole sha256");
        }
    }

    // The status says how much of this Mac's history the domain holds.
    let versions = a.status().versions.expect("the worker keeps version history");
    assert_eq!((versions.mirrored, versions.cloud), (2, 2));
    assert!(versions.last_mirror_ms.is_some());

    // A second pass has nothing to do and nothing to say differently.
    let before = be.lock().unwrap().versions_etag;
    a.engine.mirror_versions().await;
    assert_eq!(be.lock().unwrap().versions_etag, before, "an idempotent pass writes no index");
}

#[tokio::test]
async fn mirror_skips_a_snapshot_another_device_already_holds() {
    let be = fake_worker();
    let mut a = device("Air", &be);
    let mut b = device("Book", &be);
    a.engine.probe_worker().await;
    b.engine.probe_worker().await;

    // Both Macs see the same folder, so both capture the same content.
    a.captured(ago(4 * MINUTE), Reason::Seed, &[("Home.md", "one\n")]);
    a.engine.mirror_versions().await;
    b.captured(ago(3 * MINUTE), Reason::Closing, &[("Home.md", "one\n")]);
    b.engine.mirror_versions().await;
    assert_eq!(cloud_ids(&be).len(), 1, "the same workspace, twice over, goes up once");

    // Different content from the second Mac is a real version and does go.
    b.captured(ago(2 * MINUTE), Reason::Interval, &[("Home.md", "one\ntwo\n")]);
    b.engine.mirror_versions().await;
    assert_eq!(cloud_ids(&be).len(), 2);
    assert_eq!(cloud_index(&be).snapshots[1].device, b.device_id());

    // A named version is never skipped, however familiar its content: the
    // user marked that moment, and the name lives in the index.
    b.captured_as(ago(MINUTE), Reason::Manual, &[("Home.md", "one\ntwo\n")], true, Some("before the rewrite"));
    b.engine.mirror_versions().await;
    let index = cloud_index(&be);
    assert_eq!(index.snapshots.len(), 3);
    assert_eq!(index.snapshots[2].label.as_deref(), Some("before the rewrite"));
    assert!(index.snapshots[2].pinned);
}

#[tokio::test]
async fn mirror_survives_a_lost_index_cas() {
    let be = fake_worker();
    let mut a = device("Air", &be);
    let b = device("Book", &be);
    a.engine.probe_worker().await;
    let (mine, theirs_ts) = (ago(2 * MINUTE), ago(3 * MINUTE));
    a.captured(mine, Reason::Seed, &[("Home.md", "one\n")]);

    // The other Mac lands its own entry between our read and our write.
    let theirs = VersionsIndex {
        snapshots: vec![VersionsEntry {
            id: snapshot_id(theirs_ts, &b.device_id()),
            ts: theirs_ts,
            device: b.device_id(),
            reason: "interval".into(),
            files: 1,
            bytes: 4,
            digest: "0".repeat(64),
            ..Default::default()
        }],
        ..Default::default()
    };
    be.lock().unwrap().versions_racer = Some(theirs);

    a.engine.mirror_versions().await;
    let ids = cloud_ids(&be);
    assert_eq!(ids.len(), 2, "the loser re-reads and lands after the winner");
    assert!(ids.contains(&snapshot_id(mine, &a.device_id())));
    assert!(ids.contains(&snapshot_id(theirs_ts, &b.device_id())));
}

#[tokio::test]
async fn cloud_horizon_is_a_cas_on_the_cloud_index() {
    let be = fake_worker();
    let mut a = device("Air", &be);
    let b = device("Book", &be);
    a.engine.probe_worker().await;
    a.captured(ago(MINUTE), Reason::Seed, &[("Home.md", "one\n")]);
    a.engine.mirror_versions().await;
    assert_eq!(cloud_index(&be).horizon_days, None, "forever, until someone says otherwise");

    // The other Mac lands its own entry between our read and our write: the
    // horizon is one field of a shared object, so it goes in by CAS or not
    // at all — and the retry must not carry our stale copy of their rows.
    let theirs_ts = ago(3 * MINUTE);
    let theirs = VersionsIndex {
        snapshots: vec![VersionsEntry {
            id: snapshot_id(theirs_ts, &b.device_id()),
            ts: theirs_ts,
            device: b.device_id(),
            reason: "interval".into(),
            files: 1,
            bytes: 4,
            digest: "0".repeat(64),
            ..Default::default()
        }],
        ..Default::default()
    };
    be.lock().unwrap().versions_racer = Some(theirs);

    a.engine.set_cloud_horizon(Some(30)).await.expect("set the cloud horizon");
    let index = cloud_index(&be);
    assert_eq!(index.horizon_days, Some(30), "the loser re-read and landed it anyway");
    assert!(
        index.snapshots.iter().any(|e| e.id == snapshot_id(theirs_ts, &b.device_id())),
        "and kept what the winner wrote: {:?}",
        cloud_ids(&be)
    );

    // The panel says what the bucket now says, without waiting an hour for
    // the next pass to tell it.
    assert_eq!(a.status().versions.expect("the mirror").horizon_days, Some(30));

    // And the sweep is the thing that acts on it: a snapshot past thirty
    // days goes on the next pass, whatever the ladder would have kept.
    a.captured(ago(40 * DAY), Reason::Interval, &[("Home.md", "long ago\n")]);
    a.engine.mirror_versions().await;
    assert!(
        !cloud_index(&be).snapshots.iter().any(|e| e.ts <= ago(31 * DAY)),
        "nothing past the horizon survives: {:?}",
        cloud_index(&be).snapshots.iter().map(|e| e.ts).collect::<Vec<_>>()
    );

    // Forever is a real answer, not the absence of one.
    a.engine.set_cloud_horizon(None).await.expect("back to forever");
    assert_eq!(cloud_index(&be).horizon_days, None);
}

#[tokio::test]
async fn cloud_sweep_thins_on_the_cloud_horizon() {
    let be = fake_worker();
    let mut a = device("Air", &be);
    a.engine.probe_worker().await;

    // Six hours of one snapshot an hour, three days ago — past the ladder's
    // hourly band, where only the last of each day survives — then today's.
    let old = ago(3 * DAY);
    for n in 0..6u64 {
        a.captured(old + n * HOUR, Reason::Interval, &[("Home.md", &format!("draft {}\n", n))]);
    }
    let newest = ago(MINUTE);
    a.captured(newest, Reason::Interval, &[("Home.md", "the latest\n")]);
    a.engine.mirror_versions().await;

    let kept = cloud_index(&be).snapshots;
    assert!(kept.len() < 7, "three-day-old hourly snapshots thin to one a day");
    assert_eq!(kept.last().unwrap().ts, newest, "the newest state is never thinned");
    assert!(kept.iter().any(|e| e.ts == old + 5 * HOUR), "the last of that day survives");
    assert!(!kept.iter().any(|e| e.ts == old), "an earlier one in the same day does not");
    assert_eq!(
        be.lock().unwrap().version_snapshots.len(),
        kept.len(),
        "the objects the index dropped are deleted too"
    );

    // And the device does not put back what the sweep took: a second pass
    // uploads nothing, however many times it runs.
    let ids = cloud_ids(&be);
    a.engine.mirror_versions().await;
    a.engine.mirror_versions().await;
    assert_eq!(cloud_ids(&be), ids, "what the ladder thinned stays thinned");
}

#[tokio::test]
async fn cloud_sweep_spares_young_blobs() {
    let be = fake_worker();
    let mut a = device("Air", &be);
    a.engine.probe_worker().await;
    a.captured(ago(MINUTE), Reason::Seed, &[("Home.md", "one\n")]);
    a.engine.mirror_versions().await;

    // A blob nothing references: another device uploaded it and never won
    // the CAS naming the snapshot that holds it.
    let orphan = hash_full(b"a version in flight\n");
    be.lock().unwrap().version_blobs.insert(orphan.clone(), (vec![1, 2, 3], now_ms()));

    a.engine.state.last_cloud_sweep_ms = None; // due again
    a.engine.mirror_versions().await;
    assert!(be.lock().unwrap().version_blobs.contains_key(&orphan), "an hour's grace, so a race can finish");

    // Once it is old enough, and still referenced by nothing, it goes —
    // while the blob a retained snapshot names stays.
    be.lock().unwrap().version_blobs.get_mut(&orphan).unwrap().1 = now_ms() - CLOUD_GC_GRACE_MS - 1;
    a.engine.state.last_cloud_sweep_ms = None;
    a.engine.mirror_versions().await;
    let worker = be.lock().unwrap();
    assert!(!worker.version_blobs.contains_key(&orphan));
    assert!(worker.version_blobs.contains_key(&hash_full(b"one\n")), "what a snapshot names is kept");
}

#[tokio::test]
async fn no_versions_feature_means_no_mirror_and_a_null_status() {
    let be = fake_worker();
    be.lock().unwrap().features = vec!["sync".into(), "wipe".into()];
    let mut a = device("Air", &be);
    a.engine.probe_worker().await;
    a.captured(ago(MINUTE), Reason::Seed, &[("Home.md", "one\n")]);

    a.engine.probe_worker().await;
    a.engine.mirror_versions().await;
    assert!(be.lock().unwrap().versions_index.is_none(), "an older worker is never written to");
    assert!(be.lock().unwrap().version_blobs.is_empty());

    a.write("Home.md", "one\n");
    a.cycle().await;
    assert!(a.status().versions.is_none(), "and the status says so, which is what lights the badge");
    assert_eq!(a.phase(), Phase::Idle, "history is not the document: sync is unaffected");
}

#[tokio::test(start_paused = true)]
async fn a_worker_updated_mid_session_starts_mirroring_on_its_own() {
    let be = fake_worker();
    be.lock().unwrap().features = vec!["sync".into(), "wipe".into()];
    let mut a = device("Air", &be);
    a.engine.probe_worker().await;
    a.captured(ago(MINUTE), Reason::Seed, &[("Home.md", "one\n")]);
    a.engine.mirror_versions().await;
    assert!(be.lock().unwrap().versions_index.is_none());

    // The user follows the badge and updates the worker. Nothing tells this
    // engine — so the hourly pass asks again, and the mirror starts without
    // a restart. A per-cycle pass does not ask: that would be a request per
    // cycle, forever, on a domain that will never answer differently.
    be.lock().unwrap().features.push("versions".into());
    a.engine.mirror_versions().await;
    assert!(be.lock().unwrap().versions_index.is_none(), "not once per cycle");

    tokio::time::advance(MIRROR_EVERY).await;
    a.engine.mirror_versions().await;
    assert!(be.lock().unwrap().versions_index.is_some(), "the mirror starts on its own");
    assert!(a.status().versions.is_some(), "and the status stops saying the worker cannot");
}

#[tokio::test]
async fn read_through_caches_another_devices_snapshot() {
    let be = fake_worker();
    let mut a = device("Air", &be);
    let b = device("Book", &be);
    a.engine.probe_worker().await;
    let ts = ago(MINUTE);
    a.captured(ts, Reason::Interval, &[("Home.md", "written on the Air\n")]);
    a.engine.mirror_versions().await;
    let id = snapshot_id(ts, &a.device_id());

    // The other Mac has never seen this snapshot: it comes down once, and
    // is answered out of the cache after that.
    let store = b.store();
    assert!(store.read_cloud_snapshot(&id).is_none());
    let fetched = super::versions::snapshot(&FakeRemote::new(&be, &b.device_id()), &store, &id)
        .await
        .expect("the mirrored snapshot downloads");
    assert_eq!(fetched.files.get("Home.md").unwrap().h, hash_full(b"written on the Air\n"));
    assert!(store.read_cloud_snapshot(&id).is_some(), "and is kept, so the rail reads it for free");

    be.lock().unwrap().offline = true;
    assert!(
        super::versions::snapshot(&FakeRemote::new(&be, &b.device_id()), &store, &id).await.is_some(),
        "a cached snapshot is readable with the domain unreachable"
    );
}

/* ---------- The retired manifest history (docs/versioning-plan.md §9) ---------- */

/// The one-time clean-up: every `history/<fid>.json`, then every blob but
/// each file's current one, `LEGACY_BATCH` fileIds at a time — archives
/// first, because deleting the index before the data it names is the order
/// that is safe to interrupt.
#[tokio::test]
async fn legacy_cleanup_sweeps_the_retired_blob_backlog_across_polls() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    a.engine.probe_worker().await;

    // More files than one batch, so the pass genuinely has to come back.
    for i in 0..(LEGACY_BATCH + 5) {
        a.write(&format!("n{:03}.md", i), "first\n");
    }
    a.cycle().await;
    // Three get a second revision: the bucket now holds an old blob nothing
    // points at. One is deleted: everything it has is old.
    for i in 0..3 {
        a.write(&format!("n{:03}.md", i), "second, and rather longer\n");
    }
    let last = format!("n{:03}.md", LEGACY_BATCH + 4);
    a.delete(&last);
    a.cycle().await;

    let (fids, blobs_before) = {
        let b = be.lock().unwrap();
        let fids: Vec<String> =
            b.manifest.files.keys().chain(b.manifest.tombstones.keys()).cloned().collect();
        assert_eq!(fids.len(), LEGACY_BATCH + 5, "every file, the deleted one included");
        (fids, b.blobs.len())
    };
    assert_eq!(blobs_before, LEGACY_BATCH + 5 + 3, "one per file, plus three second revisions");

    // A batch per poll, and the bookmark is persisted between them.
    a.engine.poll_for_test().await;
    assert!(be.lock().unwrap().blobs.len() < blobs_before, "it has started");
    let held = serde_json::to_value(&a.engine.state).unwrap();
    assert!(held["legacy_cleanup"]["cursor"].is_string(), "the bookmark is persisted: {}", held["legacy_cleanup"]);
    a.engine.poll_for_test().await;
    a.engine.poll_for_test().await;

    assert!(a.engine.state.legacy_cleanup.done, "the backlog is finished");
    let b = be.lock().unwrap();
    assert_eq!(b.blobs.len(), LEGACY_BATCH + 4, "one blob per living file, and nothing for the deleted one");
    for (fid, f) in &b.manifest.files {
        assert!(b.blobs.contains_key(&(fid.clone(), f.hash.clone())), "{} lost its current bytes", f.path);
    }
    drop(b);
    assert_eq!(fids.len(), LEGACY_BATCH + 5);

    // Being done is persisted like every other step of it. A device that
    // forgot would walk the whole bucket again on its next launch.
    let finished = serde_json::to_value(&a.engine.state).unwrap();
    let reloaded: WorkspaceState = serde_json::from_value(finished.clone()).unwrap();
    assert!(reloaded.legacy_cleanup.done, "it must survive a restart: {}", finished["legacy_cleanup"]);
    assert!(finished["legacy_cleanup"].get("cursor").is_none(), "and drop the bookmark it no longer needs");

    // A workspace connected after this phase has no backlog to retire, and
    // says nothing about it until the pass actually starts.
    assert!(
        serde_json::to_value(WorkspaceState::default()).unwrap().get("legacy_cleanup").is_none(),
        "an untouched state file carries no flags",
    );
}

/// A device that was still deleting archives when this release arrived has a
/// bookmark into a pass that no longer exists. The blob sweep starts from the
/// beginning rather than inheriting it: it is idempotent, and skipping half
/// the backlog for ever is not.
#[tokio::test]
async fn a_bookmark_from_the_archive_pass_does_not_carry_into_the_blob_sweep() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    a.engine.probe_worker().await;
    for i in 0..3 {
        a.write(&format!("n{}.md", i), "first\n");
    }
    a.cycle().await;
    for i in 0..3 {
        a.write(&format!("n{}.md", i), "second, and rather longer\n");
    }
    a.cycle().await;
    let blobs_before = be.lock().unwrap().blobs.len();
    assert_eq!(blobs_before, 6, "three files, two revisions each");

    // What the older release left behind: the archive pass was mid-way.
    let last_fid = manifest_of(&be).files.keys().next_back().unwrap().clone();
    a.engine.state.legacy_cleanup.archives_done = false;
    a.engine.state.legacy_cleanup.cursor = Some(last_fid);

    a.engine.poll_for_test().await;
    assert!(a.engine.state.legacy_cleanup.archives_done, "there is only one pass now");
    a.engine.poll_for_test().await;
    assert_eq!(be.lock().unwrap().blobs.len(), 3, "every file swept, not just the ones past the old cursor");
}

/* ---------- The worker as a writer: what an agent changes (docs/cloud.md §8.4) ---------- */

/// The id an agent signs with: `a-` and eight hex, as the worker mints one
/// (cloud-worker/src/agents.ts).
const AGENT: &str = "a-1234abcd";

/// A sidecar as the app and the worker both write one (src/metaFile.ts): the
/// conversation behind the marker `#c7k2x9` in a document's markdown.
const THREAD: &str = "{\"t\":\"mthread\",\"id\":\"c7k2x9\",\"comments\":[{\"author\":\"Grok bot\",\"at\":1763000000000,\"body\":\"Is that still true?\"}]}\n";

/// A change made the way the worker's document API makes one
/// (cloud-worker/src/commit.ts): the manifest as it stands, changed through
/// the same verbs as its `Tx`, then replaced in one step — content first, one
/// `seq`, one new etag. An agent has no engine, so this is the whole of what
/// a Mac ever sees of one, and the tests below are worth exactly what this
/// mirror is. **Change both.**
struct WorkerTx {
    m: Manifest,
    by: String,
    /// One clock for the whole change, as in `Tx`.
    now: u64,
    staged: Vec<((String, String), Vec<u8>)>,
    dirty: bool,
}

impl WorkerTx {
    fn fid(&self, path: &str) -> String {
        self.m
            .files
            .iter()
            .find(|(_, f)| f.path == path)
            .map(|(fid, _)| fid.clone())
            .unwrap_or_else(|| panic!("the manifest has nothing at {}", path))
    }

    /// `Tx.write`: the next revision of `fid`, or a new file at `path` —
    /// one past its tombstone, if it has one, and the tombstone withdrawn.
    fn write(&mut self, fid: &str, path: &str, content: &str) -> ManifestFile {
        let bytes = content.as_bytes().to_vec();
        let hash = hash16(&bytes);
        let prev = self.m.files.get(fid).cloned();
        if let Some(p) = prev.as_ref().filter(|p| p.hash == hash) {
            return p.clone(); // the same bytes are not a new revision
        }
        let tomb_rev = self.m.tombstones.get(fid).map(|t| t.rev).unwrap_or(0);
        let file = ManifestFile {
            path: prev.as_ref().map(|p| p.path.clone()).unwrap_or_else(|| path.to_string()),
            rev: prev.as_ref().map(|p| p.rev).unwrap_or(0).max(tomb_rev) + 1,
            hash: hash.clone(),
            size: bytes.len() as u64,
            mtime: self.now,
            by: self.by.clone(),
        };
        self.staged.push(((fid.to_string(), hash), bytes));
        self.m.tombstones.remove(fid);
        self.m.files.insert(fid.to_string(), file.clone());
        self.dirty = true;
        file
    }

    /// A file that was not there, under a fresh id — `newFileId`, which is
    /// the engine's own `random_id("f")`.
    fn create(&mut self, path: &str, content: &str) -> String {
        let fid = random_id("f");
        self.write(&fid, path, content);
        fid
    }

    /// `Tx.move`: a new path and the next revision. The hash stays, and so
    /// does `mtime` — a move is not an edit.
    fn mv(&mut self, fid: &str, to: &str) {
        let Some(f) = self.m.files.get_mut(fid) else { return };
        if f.path == to {
            return;
        }
        f.path = to.to_string();
        f.rev += 1;
        f.by = self.by.clone();
        self.dirty = true;
    }

    /// `Tx.remove`: the entry goes, a tombstone one revision on stays.
    fn remove(&mut self, fid: &str) {
        let Some(f) = self.m.files.remove(fid) else { return };
        self.m.tombstones.insert(
            fid.to_string(),
            Tombstone { path: f.path, rev: f.rev + 1, ts: self.now, by: self.by.clone() },
        );
        self.dirty = true;
    }

    /// `keepPublic` (cloud-worker/src/agentDocs.ts) — the worker's half of
    /// the engine's `fold_public`: a page's path follows its file, and a
    /// page whose file is gone adopts a page-less file now at its path.
    fn keep_public(&mut self) {
        let mut referenced: BTreeSet<String> = BTreeSet::new();
        for e in self.m.public.values_mut().filter(|e| e.kind == PublicKind::File) {
            let Some(fid) = e.file.clone() else { continue };
            if let Some(live) = self.m.files.get(&fid).filter(|live| live.path != e.path) {
                e.path = live.path.clone();
                self.dirty = true;
            }
            referenced.insert(fid);
        }
        let dead: Vec<(String, String)> = self
            .m
            .public
            .iter()
            .filter(|(_, e)| e.kind == PublicKind::File)
            .filter(|(_, e)| e.file.as_ref().map(|f| !self.m.files.contains_key(f)).unwrap_or(true))
            .map(|(slug, e)| (slug.clone(), e.path.clone()))
            .collect();
        for (slug, path) in dead {
            let adopt = self
                .m
                .files
                .iter()
                .find(|(fid, f)| f.path == path && !referenced.contains(*fid))
                .map(|(fid, _)| fid.clone());
            if let Some(fid) = adopt {
                referenced.insert(fid.clone());
                self.m.public.get_mut(&slug).unwrap().file = Some(fid);
                self.dirty = true;
            }
        }
    }

    /// `postMove` on a folder: every file inside moves, a published folder
    /// at or beneath it follows, and the file pages are kept true.
    fn move_folder(&mut self, from: &str, to: &str) {
        let prefix = format!("{}/", from);
        let inside: Vec<(String, String)> = self
            .m
            .files
            .iter()
            .filter(|(_, f)| f.path.starts_with(&prefix))
            .map(|(fid, f)| (fid.clone(), format!("{}{}", to, &f.path[from.len()..])))
            .collect();
        for (fid, dest) in inside {
            self.mv(&fid, &dest);
        }
        for e in self.m.public.values_mut().filter(|e| e.kind == PublicKind::Dir) {
            if e.path == from || e.path.starts_with(&prefix) {
                e.path = format!("{}{}", to, &e.path[from.len()..]);
                self.dirty = true;
            }
        }
        self.keep_public();
    }

    /// `publish` on one document (cloud-worker/src/agentPages.ts).
    fn publish(&mut self, slug: &str, fid: &str) {
        let path = self.m.files[fid].path.clone();
        self.m.public.insert(
            slug.to_string(),
            PublicEntry {
                kind: PublicKind::File,
                file: Some(fid.to_string()),
                path,
                title: None,
                desc: None,
                root: false,
                by: self.by.clone(),
                at: self.now,
            },
        );
        self.dirty = true;
    }

    /// `repointPages`: a document's page belongs to its markdown when it has
    /// one, and to its html when it has not.
    fn repoint_pages(&mut self, from: &str, to: &str) {
        let path = self.m.files[to].path.clone();
        for e in self.m.public.values_mut().filter(|e| e.file.as_deref() == Some(from)) {
            e.file = Some(to.to_string());
            e.path = path.clone();
            self.dirty = true;
        }
    }
}

/// `commit()` up to the manifest PUT: the change is applied to the manifest
/// as it stands and its blobs are stored, and the manifest it would put is
/// handed back — `None` when the change left everything as it found it, in
/// which case the worker writes nothing. A test lands it when it likes:
/// at once (`worker_writes`), or in the middle of a Mac's own put (`racer`).
fn worker_would_write<T>(be: &SharedWorker, change: impl FnOnce(&mut WorkerTx) -> T) -> (T, Option<Manifest>) {
    let mut b = be.lock().unwrap();
    let mut tx =
        WorkerTx { m: b.manifest.clone(), by: AGENT.into(), now: now_ms(), staged: Vec::new(), dirty: false };
    let value = change(&mut tx);
    if !tx.dirty {
        return (value, None);
    }
    for (key, bytes) in tx.staged {
        b.blobs.entry(key).or_insert((bytes, 0));
    }
    tx.m.seq += 1;
    (value, Some(tx.m))
}

/// One write by the worker, landed: every file it touches under one new etag.
fn worker_writes<T>(be: &SharedWorker, change: impl FnOnce(&mut WorkerTx) -> T) -> T {
    let (value, next) = worker_would_write(be, change);
    if let Some(next) = next {
        let mut b = be.lock().unwrap();
        b.manifest = next;
        b.etag += 1;
    }
    value
}

fn fid_at(be: &SharedWorker, path: &str) -> String {
    manifest_of(be)
        .files
        .iter()
        .find(|(_, f)| f.path == path)
        .map(|(fid, _)| fid.clone())
        .unwrap_or_else(|| panic!("the manifest has nothing at {}", path))
}

/// A cycle that is only allowed to listen. What the worker wrote is applied
/// and this Mac says nothing back: no manifest PUT, so no new etag. That is
/// what makes an agent's write cost each Mac one cycle and not two — a Mac
/// that "corrected" the worker's manifest would wake every other Mac again
/// (docs/cloud.md §8.7).
async fn applies_quietly(d: &mut Device, be: &SharedWorker) {
    let (calls, etag) = {
        let b = be.lock().unwrap();
        (b.put_manifest_calls, b.etag)
    };
    d.cycle().await;
    let b = be.lock().unwrap();
    let who = d.engine.device_name_for_test();
    assert_eq!(b.put_manifest_calls, calls, "{} answered the worker's write with one of its own", who);
    assert_eq!(b.etag, etag, "{} moved the manifest", who);
    drop(b);
    assert_eq!(d.phase(), Phase::Idle);
}

/// Created: a file id of the engine's own shape, revision one, signed by the
/// agent. Every Mac downloads it and has nothing to add.
#[tokio::test]
async fn a_document_the_worker_created_arrives_on_every_mac() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    let mut b = device("Bob", &be);
    a.write("readme.md", "already here\n");
    a.cycle().await;
    b.cycle().await;
    let seq = manifest_of(&be).seq;

    let fid = worker_writes(&be, |tx| tx.create("Projects/plan.md", "# Plan\n\nwritten by an agent\n"));
    let written = manifest_of(&be);
    assert_eq!(written.seq, seq + 1);
    assert!(fid.len() == 14 && fid.starts_with("f-"), "an id as a Mac mints one: {}", fid);
    let f = &written.files[&fid];
    assert_eq!((f.rev, f.by.as_str()), (1, AGENT));

    for d in [&mut a, &mut b] {
        applies_quietly(d, &be).await;
        assert_eq!(d.read("Projects/plan.md").as_deref(), Some("# Plan\n\nwritten by an agent\n"));
        let applied = d.events.of(EV_APPLIED);
        assert_eq!(applied.last().unwrap()["paths"], serde_json::json!(["Projects/plan.md"]));
        // And it stays applied: the next cycle has nothing to do.
        applies_quietly(d, &be).await;
    }
    assert_eq!(manifest_of(&be), written, "exactly as the worker left it");

    // It is held as synced, so carrying on from it is an ordinary revision.
    a.write("Projects/plan.md", "# Plan\n\nand a person carried on from there\n");
    a.cycle().await;
    let f = &manifest_of(&be).files[&fid];
    assert_eq!((f.rev, f.by.as_str()), (2, "Alice"));
    b.cycle().await;
    assert_eq!(b.read("Projects/plan.md").as_deref(), Some("# Plan\n\nand a person carried on from there\n"));
}

/// Changed: the next revision, new content. A clean copy is replaced — and a
/// Mac that slept through several revisions lands on the last.
#[tokio::test]
async fn a_revision_the_worker_wrote_replaces_a_clean_copy() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    let mut b = device("Bob", &be);
    a.write("doc.md", "v1\n");
    a.cycle().await;
    b.cycle().await;
    let fid = fid_at(&be, "doc.md");
    let before = manifest_of(&be).files[&fid].clone();

    let f = worker_writes(&be, |tx| tx.write(&fid, "doc.md", "v2 — rewritten by the agent\n"));
    assert_eq!((f.path.as_str(), f.rev, f.by.as_str()), ("doc.md", before.rev + 1, AGENT));
    assert_ne!(f.hash, before.hash);
    assert_eq!(f.size, "v2 — rewritten by the agent\n".len() as u64);
    assert!(f.mtime >= before.mtime);
    for d in [&mut a, &mut b] {
        applies_quietly(d, &be).await;
        assert_eq!(d.read("doc.md").as_deref(), Some("v2 — rewritten by the agent\n"));
        assert_eq!(d.files(), vec!["doc.md"]);
    }

    worker_writes(&be, |tx| tx.write(&fid, "doc.md", "v3\n"));
    applies_quietly(&mut a, &be).await;
    worker_writes(&be, |tx| tx.write(&fid, "doc.md", "v4, the one Bob wakes up to\n"));
    for d in [&mut a, &mut b] {
        applies_quietly(d, &be).await;
        assert_eq!(d.read("doc.md").as_deref(), Some("v4, the one Bob wakes up to\n"));
    }
    assert_eq!(manifest_of(&be).files[&fid].rev, before.rev + 3);
}

/// Changed on both sides, in different places: the agent started a comment
/// thread — a marker in the first paragraph and the sidecar that holds what
/// was said, in one write — while somebody was typing further down. The
/// engine merges as it does with another Mac's edit and pushes the result as
/// its own revision; the sidecar stays the agent's.
#[tokio::test]
async fn what_the_worker_wrote_merges_with_what_was_typed_here_meanwhile() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    let mut b = device("Bob", &be);
    a.write("plan.md", "The boat ships in June.\n\nPaint is on order.\n\nSails are not.\n");
    a.cycle().await;
    b.cycle().await;
    let md = fid_at(&be, "plan.md");

    let meta = worker_writes(&be, |tx| {
        tx.write(
            &md,
            "plan.md",
            "The boat {==ships in June==}{>>#c7k2x9<<}.\n\nPaint is on order.\n\nSails are not.\n",
        );
        tx.create("plan.meta.jsonl", THREAD)
    });
    b.write("plan.md", "The boat ships in June.\n\nPaint is on order.\n\nSails are not — Bob is asking around.\n");
    b.cycle().await;

    let merged =
        "The boat {==ships in June==}{>>#c7k2x9<<}.\n\nPaint is on order.\n\nSails are not — Bob is asking around.\n";
    assert_eq!(b.read("plan.md").as_deref(), Some(merged));
    assert_eq!(b.read("plan.meta.jsonl").as_deref(), Some(THREAD));
    assert_eq!(b.files(), vec!["plan.md", "plan.meta.jsonl"], "merged, so no conflict copy");
    let m = manifest_of(&be);
    assert_eq!((m.files[&md].rev, m.files[&md].by.as_str()), (3, "Bob"), "the merge is Bob's, on top of the agent's");
    assert_eq!(m.files[&md].hash, hash16(merged.as_bytes()));
    assert_eq!((m.files[&meta].rev, m.files[&meta].by.as_str()), (1, AGENT));

    a.cycle().await;
    assert_eq!(a.read("plan.md").as_deref(), Some(merged));
    assert_eq!(a.read("plan.meta.jsonl").as_deref(), Some(THREAD));
}

/// Changed on both sides, on the same line: nothing is merged and nothing is
/// lost. What was typed here stays the document; the agent's text lands
/// beside it as a conflict copy named after the agent — by its name, which
/// the directory supplies the first time its id is seen.
#[tokio::test]
async fn the_same_line_changed_here_and_by_the_worker_keeps_both() {
    let be = fake_worker();
    be.lock().unwrap().agents.insert(AGENT.into(), "Grok bot".into());
    let mut a = device("Alice", &be);
    let mut b = device("Bob", &be);
    a.write("doc.md", "shared line\n");
    a.cycle().await;
    b.cycle().await;
    let fid = fid_at(&be, "doc.md");

    worker_writes(&be, |tx| tx.write(&fid, "doc.md", "the agent's take on the line\n"));
    a.write("doc.md", "alice's very different take\n");
    a.cycle().await;

    assert_eq!(a.read("doc.md").as_deref(), Some("alice's very different take\n"));
    let copies: Vec<String> = a.files().into_iter().filter(|p| p.contains("(conflict — ")).collect();
    assert_eq!(copies.len(), 1, "exactly one conflict copy, got {:?}", a.files());
    assert!(copies[0].contains("(conflict — Grok bot"), "named after the agent: {}", copies[0]);
    assert!(!copies[0].contains(AGENT), "not after its id: {}", copies[0]);
    assert_eq!(a.read(&copies[0]).as_deref(), Some("the agent's take on the line\n"));
    let conflicts = a.events.of(EV_CONFLICT);
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0]["path"], "doc.md");
    assert_eq!(conflicts[0]["by"], "Grok bot");
    assert_eq!(conflicts[0]["conflictPath"], copies[0]);

    // Both are Alice's to push: her text as the next revision, the copy as a
    // file of its own that every Mac gets.
    let m = manifest_of(&be);
    assert_eq!((m.files[&fid].rev, m.files[&fid].by.as_str()), (3, "Alice"));
    b.cycle().await;
    assert_eq!(b.read("doc.md").as_deref(), Some("alice's very different take\n"));
    assert_eq!(b.read(&copies[0]).as_deref(), Some("the agent's take on the line\n"));
}

/// A name taken on both sides before either knew: the agent created a
/// document where this Mac had one it had not synced yet. With no common
/// ancestor there is nothing to merge against, so it is the same-line rule —
/// and the Mac's text carries on under the id the worker minted.
#[tokio::test]
async fn a_document_the_worker_created_where_this_mac_had_an_unsynced_one_keeps_both() {
    let be = fake_worker();
    be.lock().unwrap().agents.insert(AGENT.into(), "Grok bot".into());
    let mut a = device("Alice", &be);
    a.write("readme.md", "already here\n");
    a.cycle().await;

    let fid = worker_writes(&be, |tx| tx.create("ideas.md", "the agent's ideas\n"));
    a.write("ideas.md", "alice's ideas — different\n");
    a.cycle().await;

    assert_eq!(a.read("ideas.md").as_deref(), Some("alice's ideas — different\n"));
    let copies: Vec<String> = a.files().into_iter().filter(|p| p.contains("(conflict — Grok bot")).collect();
    assert_eq!(copies.len(), 1, "exactly one conflict copy, got {:?}", a.files());
    assert_eq!(a.read(&copies[0]).as_deref(), Some("the agent's ideas\n"));

    let m = manifest_of(&be);
    assert_eq!((m.files[&fid].path.as_str(), m.files[&fid].rev, m.files[&fid].by.as_str()), ("ideas.md", 2, "Alice"));
    let mut paths: Vec<&str> = m.files.values().map(|f| f.path.as_str()).collect();
    paths.sort();
    assert_eq!(paths, vec![copies[0].as_str(), "ideas.md", "readme.md"], "no two files share a path");
}

/// Moved: a new path and the next revision, the same bytes — so the same
/// hash, and the same `mtime`, which says when the content last changed. A
/// Mac renames what it holds and asks the bucket for nothing.
#[tokio::test]
async fn a_move_the_worker_made_renames_in_place_and_downloads_nothing() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    let mut b = device("Bob", &be);
    a.write("notes/old-name.md", "stable content that does not change\n");
    a.cycle().await;
    b.cycle().await;
    let fid = fid_at(&be, "notes/old-name.md");
    let before = manifest_of(&be).files[&fid].clone();

    worker_writes(&be, |tx| tx.mv(&fid, "archive/2026/new-name.md"));
    let f = manifest_of(&be).files[&fid].clone();
    assert_eq!((f.path.as_str(), f.rev, f.by.as_str()), ("archive/2026/new-name.md", before.rev + 1, AGENT));
    assert_eq!((f.hash.as_str(), f.size, f.mtime), (before.hash.as_str(), before.size, before.mtime));

    let gets = be.lock().unwrap().blob_gets;
    for d in [&mut a, &mut b] {
        applies_quietly(d, &be).await;
        assert!(d.read("notes/old-name.md").is_none());
        assert_eq!(d.read("archive/2026/new-name.md").as_deref(), Some("stable content that does not change\n"));
        assert_eq!(d.files(), vec!["archive/2026/new-name.md"], "a move must not fork the file");
        // Nor does the renamed file read as edited on the next look.
        applies_quietly(d, &be).await;
    }
    assert_eq!(be.lock().unwrap().blob_gets, gets, "a rename moves no bytes");
    assert_eq!(manifest_of(&be).files[&fid], f, "exactly as the worker left it");
}

/// Moved there, edited here: the file follows the move, and what was typed
/// before the move was heard of is not forgotten — it goes up as the next
/// revision, at the new path.
#[tokio::test]
async fn an_edit_typed_here_rides_along_with_the_workers_move() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    let mut b = device("Bob", &be);
    a.write("doc.md", "line one\nline two\n");
    a.cycle().await;
    b.cycle().await;
    let fid = fid_at(&be, "doc.md");

    worker_writes(&be, |tx| tx.mv(&fid, "sub/doc.md"));
    let edited = "line one\nline two\nand a third thought, typed before the move was heard of\n";
    a.write("doc.md", edited);
    a.cycle().await;

    assert!(a.read("doc.md").is_none());
    assert_eq!(a.read("sub/doc.md").as_deref(), Some(edited));
    let f = manifest_of(&be).files[&fid].clone();
    assert_eq!(f.path, "sub/doc.md");
    assert_eq!(f.hash, hash16(edited.as_bytes()), "the edit was pushed, not left on one Mac");
    assert_eq!((f.rev, f.by.as_str()), (3, "Alice"));

    b.cycle().await;
    assert_eq!(b.read("sub/doc.md").as_deref(), Some(edited));
    assert_eq!(b.files(), vec!["sub/doc.md"]);
}

/// Removed: the entry is gone and a tombstone one revision on stands in its
/// place. A clean copy leaves the folder; one that was edited here stays and
/// goes back up as a file of its own — the edit wins, as it does against
/// another Mac's delete.
#[tokio::test]
async fn a_removal_the_worker_made_takes_a_clean_copy_and_spares_an_edited_one() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    let mut b = device("Bob", &be);
    a.write("keep.md", "keeper\n");
    a.write("gone.md", "doomed\n");
    a.cycle().await;
    b.cycle().await;
    let fid = fid_at(&be, "gone.md");
    let rev = manifest_of(&be).files[&fid].rev;

    let asked = now_ms();
    worker_writes(&be, |tx| tx.remove(&fid));
    let m = manifest_of(&be);
    assert!(!m.files.contains_key(&fid));
    let t = &m.tombstones[&fid];
    assert_eq!((t.path.as_str(), t.rev, t.by.as_str()), ("gone.md", rev + 1, AGENT));
    assert!(t.ts >= asked);

    applies_quietly(&mut a, &be).await;
    assert!(a.read("gone.md").is_none());
    assert_eq!(a.read("keep.md").as_deref(), Some("keeper\n"));

    b.write("gone.md", "doomed — but bob kept working on this\n");
    b.cycle().await;
    assert_eq!(b.read("gone.md").as_deref(), Some("doomed — but bob kept working on this\n"));
    let m = manifest_of(&be);
    let back = fid_at(&be, "gone.md");
    assert_ne!(back, fid, "it re-enters as a new file");
    assert_eq!((m.files[&back].rev, m.files[&back].by.as_str()), (1, "Bob"));
    a.cycle().await;
    assert_eq!(a.read("gone.md").as_deref(), Some("doomed — but bob kept working on this\n"));
}

/// A document is up to three files — markdown, html, and the sidecar that
/// holds its comments — and the worker changes them in one write or not at
/// all. A Mac sees each such write whole: the three arrive together, move
/// together without a byte fetched, and leave together.
#[tokio::test]
async fn a_document_with_its_html_and_sidecar_arrives_moves_and_leaves_whole() {
    const MD: &str = "# Plan\n\nThe boat {==ships in June==}{>>#c7k2x9<<}.\n";
    const HTML: &str = "<!doctype html><h1>Plan</h1><p>The boat ships in June.</p>\n";
    let be = fake_worker();
    let mut a = device("Alice", &be);
    let mut b = device("Bob", &be);
    a.write("readme.md", "root doc\n");
    a.cycle().await;
    b.cycle().await;

    // Created.
    let etag = be.lock().unwrap().etag;
    let parts = worker_writes(&be, |tx| {
        [
            (tx.create("Projects/plan.md", MD), ".md"),
            (tx.create("Projects/plan.html", HTML), ".html"),
            (tx.create("Projects/plan.meta.jsonl", THREAD), ".meta.jsonl"),
        ]
    });
    assert_eq!(be.lock().unwrap().etag, etag + 1, "three files, one write");
    applies_quietly(&mut a, &be).await;
    assert_eq!(
        a.files(),
        vec!["Projects/plan.html", "Projects/plan.md", "Projects/plan.meta.jsonl", "readme.md"]
    );
    let applied = a.events.of(EV_APPLIED);
    assert_eq!(applied.last().unwrap()["paths"].as_array().unwrap().len(), 3, "and one event for the document");

    // Moved.
    worker_writes(&be, |tx| {
        for (fid, ext) in &parts {
            tx.mv(fid, &format!("Archive/plan-2026{}", ext));
        }
    });
    assert_eq!(be.lock().unwrap().etag, etag + 2);
    let gets = be.lock().unwrap().blob_gets;
    applies_quietly(&mut a, &be).await;
    assert_eq!(be.lock().unwrap().blob_gets, gets, "renamed in place, all three");
    let moved = vec!["Archive/plan-2026.html", "Archive/plan-2026.md", "Archive/plan-2026.meta.jsonl", "readme.md"];
    assert_eq!(a.files(), moved);
    assert_eq!(a.read("Archive/plan-2026.md").as_deref(), Some(MD));
    assert_eq!(a.read("Archive/plan-2026.html").as_deref(), Some(HTML));
    assert_eq!(a.read("Archive/plan-2026.meta.jsonl").as_deref(), Some(THREAD));

    // Bob slept through both: he gets the document where it is now and never
    // hears of where it was.
    applies_quietly(&mut b, &be).await;
    assert_eq!(b.files(), moved);
    assert_eq!(b.read("Archive/plan-2026.meta.jsonl").as_deref(), Some(THREAD));

    // Removed.
    worker_writes(&be, |tx| {
        for (fid, _) in &parts {
            tx.remove(fid);
        }
    });
    let m = manifest_of(&be);
    assert_eq!(m.files.len(), 1);
    assert!(parts.iter().all(|(fid, _)| m.tombstones[fid].by == AGENT));
    for d in [&mut a, &mut b] {
        applies_quietly(d, &be).await;
        assert_eq!(d.files(), vec!["readme.md"], "a removal that arrives is not held like a mass delete made here");
    }

    // And a Mac that joins after all of it sees none of it.
    let mut c = device("Carol", &be);
    applies_quietly(&mut c, &be).await;
    assert_eq!(c.files(), vec!["readme.md"]);
}

/// Removed and written again. The worker's `write` takes a tombstoned id
/// back one revision past the tombstone — `max(prev, tombstone) + 1`, the
/// engine's own rule — while the document API, which mints a fresh id for a
/// document that is not there, leaves the old tombstone beside the new file.
/// Either way the document comes back, on a Mac that saw it go and on one
/// that slept through it.
#[tokio::test]
async fn a_document_written_again_after_its_removal_comes_back_everywhere() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    let mut b = device("Bob", &be);
    a.write("plan.md", "first life\n");
    a.cycle().await;
    b.cycle().await;
    let fid = fid_at(&be, "plan.md");

    // The same id, over its own tombstone.
    worker_writes(&be, |tx| tx.remove(&fid));
    assert_eq!(manifest_of(&be).tombstones[&fid].rev, 2);
    applies_quietly(&mut a, &be).await;
    assert!(a.read("plan.md").is_none());
    let f = worker_writes(&be, |tx| tx.write(&fid, "plan.md", "second life\n"));
    assert_eq!(f.rev, 3, "one past the tombstone, not one past nothing");
    assert!(manifest_of(&be).tombstones.is_empty(), "written again is not deleted");
    for d in [&mut a, &mut b] {
        applies_quietly(d, &be).await;
        assert_eq!(d.read("plan.md").as_deref(), Some("second life\n"));
    }

    // A fresh id at the same path, the old one's tombstone still standing.
    worker_writes(&be, |tx| tx.remove(&fid));
    applies_quietly(&mut a, &be).await;
    let reborn = worker_writes(&be, |tx| tx.create("plan.md", "third life\n"));
    let m = manifest_of(&be);
    assert_ne!(reborn, fid);
    assert_eq!(m.files[&reborn].rev, 1);
    assert_eq!(m.tombstones[&fid].rev, 4);
    for d in [&mut a, &mut b] {
        applies_quietly(d, &be).await;
        assert_eq!(d.read("plan.md").as_deref(), Some("third life\n"));
        assert_eq!(d.files(), vec!["plan.md"]);
    }
}

/// …and where this Mac had edited the document the worker then removed and
/// wrote afresh, the edit outlives the removal and meets the new document as
/// a text with no common ancestor: both stay.
#[tokio::test]
async fn an_edit_here_outlives_the_workers_removal_and_meets_what_was_written_in_its_place() {
    let be = fake_worker();
    be.lock().unwrap().agents.insert(AGENT.into(), "Grok bot".into());
    let mut a = device("Alice", &be);
    a.write("plan.md", "first life\n");
    a.cycle().await;
    let fid = fid_at(&be, "plan.md");

    worker_writes(&be, |tx| tx.remove(&fid));
    let reborn = worker_writes(&be, |tx| tx.create("plan.md", "the agent started over\n"));
    a.write("plan.md", "first life, and alice kept going\n");
    a.cycle().await;

    assert_eq!(a.read("plan.md").as_deref(), Some("first life, and alice kept going\n"));
    let copies: Vec<String> = a.files().into_iter().filter(|p| p.contains("(conflict — Grok bot")).collect();
    assert_eq!(copies.len(), 1, "exactly one conflict copy, got {:?}", a.files());
    assert_eq!(a.read(&copies[0]).as_deref(), Some("the agent started over\n"));
    let m = manifest_of(&be);
    assert!(!m.files.contains_key(&fid));
    assert_eq!((m.files[&reborn].rev, m.files[&reborn].by.as_str()), (2, "Alice"), "her text carries on as the new document");
    assert_eq!(m.files[&reborn].hash, hash16(b"first life, and alice kept going\n"));
}

/* ----- who did it ----- */

/// An agent signs with its id exactly as a person does, and the engine tells
/// an id the directory can resolve from a device name by its shape alone —
/// `AGENT_ID_RE` in cloud-worker/src/agents.ts.
#[test]
fn an_agents_id_is_one_the_directory_resolves() {
    assert!(is_directory_id(AGENT));
    assert!(is_directory_id("a-00000000"));
    assert!(is_directory_id("m-00000001"));
    for not in ["a-1234abc", "a-1234abcde", "a-1234ABCD", "a-1234abcg", "b-1234abcd", "a_1234abcd", "Grok bot", ""] {
        assert!(!is_directory_id(not), "{:?} is not an id", not);
    }
}

/// A worker a release behind lists no agents, and an agent removed since is
/// in nobody's directory: either way its id is all there is. It is shown as
/// it stands — legible, never "someone" — and costs one ask per gap, never
/// one per cycle. The name appears on the first ask that knows it.
#[tokio::test(start_paused = true)]
async fn an_agent_the_directory_cannot_name_is_shown_as_its_id_and_asked_about_once_a_gap() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    a.write("doc.md", "shared line\n");
    a.write("other.md", "untouched by Alice\n");
    a.cycle().await;
    let before = be.lock().unwrap().meta_calls;
    let other = fid_at(&be, "other.md");

    worker_writes(&be, |tx| {
        let doc = tx.fid("doc.md");
        tx.write(&doc, "doc.md", "the agent's take on the line\n");
        tx.write(&other, "other.md", "rewritten by the agent, and left that way\n");
    });
    a.write("doc.md", "alice's very different take\n");
    tokio::time::sleep(DIRECTORY_MIN_GAP + Duration::from_secs(1)).await;
    a.cycle().await;
    assert_eq!(be.lock().unwrap().meta_calls, before + 1, "the stranger is what asked");
    let copies: Vec<String> = a.files().into_iter().filter(|p| p.contains("(conflict — ")).collect();
    assert_eq!(copies.len(), 1, "exactly one conflict copy, got {:?}", a.files());
    assert!(copies[0].contains(&format!("(conflict — {}", AGENT)), "the id, as it stands: {}", copies[0]);
    assert_eq!(a.events.of(EV_CONFLICT)[0]["by"], AGENT);
    assert_eq!(a.read("other.md").as_deref(), Some("rewritten by the agent, and left that way\n"));

    // `other.md` goes on carrying the id, cycle after cycle.
    assert_eq!(manifest_of(&be).files[&other].by, AGENT);
    for _ in 0..3 {
        a.cycle().await;
    }
    assert_eq!(be.lock().unwrap().meta_calls, before + 1, "not once a cycle");
    tokio::time::sleep(DIRECTORY_MIN_GAP + Duration::from_secs(1)).await;
    a.cycle().await;
    assert_eq!(be.lock().unwrap().meta_calls, before + 2, "once a gap at the very most");

    // The worker is updated — or the agent is added — and the next ask
    // brings the name with it.
    be.lock().unwrap().agents.insert(AGENT.into(), "Grok bot".into());
    worker_writes(&be, |tx| tx.publish("launch", &other));
    tokio::time::sleep(DIRECTORY_MIN_GAP + Duration::from_secs(1)).await;
    a.cycle().await;
    assert_eq!(a.page("launch").unwrap().by, "Grok bot");
    assert_eq!(a.status().me, "Alice", "and this Mac is still itself");
}

/* ----- the public map rides the same write ----- */

/// A page follows its document. The worker re-points the path it snapshots
/// in the very write that moves the file (`keepPublic`), so the map a Mac
/// reads is already true and `fold_public` finds nothing to add.
#[tokio::test]
async fn a_page_follows_a_document_the_worker_moved_and_no_mac_has_to_say_so() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    let mut b = device("Bob", &be);
    a.write("doc.md", "# doc\n");
    a.publish("doc.md", PublicKind::File, Some("page1")).unwrap();
    a.cycle().await;
    b.cycle().await;
    let fid = fid_at(&be, "doc.md");

    worker_writes(&be, |tx| {
        tx.mv(&fid, "sub/renamed.md");
        tx.keep_public();
    });
    let entry = public_of(&be)["page1"].clone();
    assert_eq!(
        (entry.file.as_deref(), entry.path.as_str(), entry.by.as_str()),
        (Some(fid.as_str()), "sub/renamed.md", "Alice"),
        "the same page, still its publisher's, at the new path"
    );

    for d in [&mut a, &mut b] {
        applies_quietly(d, &be).await;
        let page = d.page("page1").unwrap();
        assert_eq!(page.path, "sub/renamed.md");
        assert!(page.alive);
    }
    assert_eq!(public_of(&be)["page1"], entry);
}

/// A published folder follows its folder: every file inside moves in the one
/// write, and the folder's entry with them.
#[tokio::test]
async fn a_folder_page_follows_a_folder_the_worker_moved() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    let mut b = device("Bob", &be);
    a.write("Projects/Roadmap/a.md", "# a\n");
    a.write("Projects/Roadmap/b.md", "# b\n");
    a.write("Other.md", "# other\n");
    a.publish_folder("Projects/Roadmap", "roadmap", "Roadmap", "What we're building").unwrap();
    a.cycle().await;
    b.cycle().await;

    let gets = be.lock().unwrap().blob_gets;
    worker_writes(&be, |tx| tx.move_folder("Projects/Roadmap", "Projects/Plans"));
    let entry = public_of(&be)["roadmap"].clone();
    assert_eq!((entry.kind, entry.path.as_str()), (PublicKind::Dir, "Projects/Plans"));
    assert_eq!(entry.title.as_deref(), Some("Roadmap"));

    for d in [&mut a, &mut b] {
        applies_quietly(d, &be).await;
        let page = d.page("roadmap").unwrap();
        assert_eq!(page.path, "Projects/Plans");
        assert!(page.alive);
        assert_eq!(d.files(), vec!["Other.md", "Projects/Plans/a.md", "Projects/Plans/b.md"]);
    }
    assert_eq!(be.lock().unwrap().blob_gets, gets);
    assert_eq!(public_of(&be)["roadmap"], entry);
}

/// What an agent publishes is a page like any other, under the agent's name
/// in the Published list. It outlives its document — dead, not gone — and
/// comes back when the worker writes a document at that path again.
#[tokio::test]
async fn a_page_the_agent_published_is_named_after_it_and_outlives_its_document() {
    let be = fake_worker();
    be.lock().unwrap().agents.insert(AGENT.into(), "Grok bot".into());
    let mut a = device("Alice", &be);
    a.write("doc.md", "# doc\n");
    a.cycle().await;
    let fid = fid_at(&be, "doc.md");

    worker_writes(&be, |tx| tx.publish("launch", &fid));
    applies_quietly(&mut a, &be).await;
    let page = a.page("launch").unwrap();
    assert_eq!((page.path.as_str(), page.by.as_str(), page.alive), ("doc.md", "Grok bot", true));

    worker_writes(&be, |tx| tx.remove(&fid));
    applies_quietly(&mut a, &be).await;
    assert!(a.read("doc.md").is_none());
    let page = a.page("launch").unwrap();
    assert_eq!((page.path.as_str(), page.alive), ("doc.md", false));
    assert_eq!(public_of(&be)["launch"].file.as_deref(), Some(fid.as_str()));

    let reborn = worker_writes(&be, |tx| {
        let fid = tx.create("doc.md", "# reborn\n");
        tx.keep_public();
        fid
    });
    assert_eq!(public_of(&be)["launch"].file.as_deref(), Some(reborn.as_str()));
    applies_quietly(&mut a, &be).await;
    assert_eq!(a.read("doc.md").as_deref(), Some("# reborn\n"));
    assert!(a.page("launch").unwrap().alive);
    assert_eq!(public_of(&be)["launch"].by, AGENT, "the page is still its publisher's");
}

/// An html-only document that gains its markdown: the page becomes the
/// markdown's in the write that creates it, and a Mac takes that as read.
#[tokio::test]
async fn a_page_moves_to_the_markdown_an_html_only_document_gains() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    a.write("deck.html", "<h1>Deck</h1>\n");
    a.publish("deck.html", PublicKind::File, Some("deck")).unwrap();
    a.cycle().await;
    let html = fid_at(&be, "deck.html");
    assert_eq!(public_of(&be)["deck"].file.as_deref(), Some(html.as_str()));

    let md = worker_writes(&be, |tx| {
        let md = tx.create("deck.md", "# Deck\n");
        tx.repoint_pages(&html, &md);
        md
    });
    applies_quietly(&mut a, &be).await;
    assert_eq!(a.files(), vec!["deck.html", "deck.md"]);
    let page = a.page("deck").unwrap();
    assert_eq!((page.path.as_str(), page.alive), ("deck.md", true));
    assert_eq!(public_of(&be)["deck"].file.as_deref(), Some(md.as_str()));
}

/* ----- the race for the manifest ----- */

/// The worker's write lands between a Mac's fetch and its put. The Mac loses
/// the compare-and-swap, starts again from what the worker wrote, and both
/// changes stand — the race two Macs run, with the same ending.
#[tokio::test]
async fn a_worker_write_that_wins_the_race_is_kept_and_so_is_the_macs() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    a.write("mine.md", "alice v1\n");
    a.write("theirs.md", "v1\n");
    a.cycle().await;
    let mine = fid_at(&be, "mine.md");
    let theirs = fid_at(&be, "theirs.md");
    let seq = manifest_of(&be).seq;

    let (created, raced) = worker_would_write(&be, |tx| {
        tx.write(&theirs, "theirs.md", "v2, by the agent\n");
        tx.create("new.md", "also the agent's\n")
    });
    let calls = {
        let mut b = be.lock().unwrap();
        b.racer = raced;
        b.put_manifest_calls
    };
    a.write("mine.md", "alice v2 — longer\n");
    a.cycle().await;

    assert_eq!(be.lock().unwrap().put_manifest_calls, calls + 2, "the first put lost, the second landed");
    let m = manifest_of(&be);
    assert_eq!(m.seq, seq + 2, "the worker's write, then Alice's on top of it");
    assert_eq!((m.files[&theirs].rev, m.files[&theirs].by.as_str()), (2, AGENT));
    assert_eq!((m.files[&created].rev, m.files[&created].by.as_str()), (1, AGENT));
    assert_eq!((m.files[&mine].rev, m.files[&mine].by.as_str()), (2, "Alice"));
    assert_eq!(a.read("theirs.md").as_deref(), Some("v2, by the agent\n"));
    assert_eq!(a.read("new.md").as_deref(), Some("also the agent's\n"));
    assert_eq!(a.read("mine.md").as_deref(), Some("alice v2 — longer\n"));
}

/// The same race on one document: what the Mac was about to push and what
/// the worker landed first meet on the retry, and merge.
#[tokio::test]
async fn a_worker_write_that_wins_the_race_on_the_same_document_is_merged_on_the_retry() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    let mut b = device("Bob", &be);
    a.write("doc.md", "line one\nline two\nline three\n");
    a.cycle().await;
    b.cycle().await;
    let fid = fid_at(&be, "doc.md");

    let (_, raced) =
        worker_would_write(&be, |tx| tx.write(&fid, "doc.md", "line one — AGENT\nline two\nline three\n"));
    be.lock().unwrap().racer = raced;
    a.write("doc.md", "line one\nline two\nline three — ALICE\n");
    a.cycle().await;

    let merged = "line one — AGENT\nline two\nline three — ALICE\n";
    assert_eq!(a.read("doc.md").as_deref(), Some(merged));
    assert_eq!(a.files().len(), 1, "no conflict copy");
    let f = manifest_of(&be).files[&fid].clone();
    assert_eq!((f.rev, f.by.as_str()), (3, "Alice"));
    assert_eq!(f.hash, hash16(merged.as_bytes()));
    b.cycle().await;
    assert_eq!(b.read("doc.md").as_deref(), Some(merged));
}
