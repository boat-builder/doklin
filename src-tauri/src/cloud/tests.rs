//! The whole engine against an in-memory worker: the two-device matrix
//! (merges, conflicts, tombstones, renames, history, the CAS race), the
//! public map (mirroring, rename-follow, re-bind, folder re-point, the
//! custom-slug race, the root page), the flows (bind-once, upload and
//! download, resume in place), the timings (a touch settles faster than a
//! watched write), the worker-outdated state, presence, and the edit bus.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::bus::EditBus;
use super::config::{
    normalize_endpoint, read_cloud_file, read_marker, write_cloud_file, write_marker, CloudFile, Marker,
    WorkspaceEntry,
};
use super::engine::{next_wake, Engine, EngineCmd, EngineConfig, PublishRequest, MANIFEST_HIST_MAX, POLL_INTERVAL};
use super::flows::{bind_domain, seed_download, seed_upload, wipe_all, FlowError};
use super::manifest::*;
use super::remote::*;
use super::scan::{hash16, now_ms, scan_local};
use super::status::*;

/* ---------- The in-memory worker ---------- */

/// A stand-in for the worker: the binding, a manifest with CAS-by-etag,
/// content-addressed blobs, history archives, presence. `racer` lets a test
/// inject "another device won the CAS between your fetch and your put";
/// `reject_schema` plays a worker that predates the app's manifest.
#[derive(Default)]
struct FakeWorker {
    bound: Option<WorkspaceRecord>,
    manifest: Manifest,
    etag: u64,
    blobs: HashMap<(String, String), Vec<u8>>,
    histories: HashMap<String, HistoryArchive>,
    presence: BTreeMap<String, PresenceEntry>,
    offline: bool,
    reject_schema: bool,
    worker_version: u32,
    racer: Option<Manifest>,
    put_manifest_calls: u64,
}

impl FakeWorker {
    fn etag_str(&self) -> String {
        format!("e{}", self.etag)
    }
}

type SharedWorker = Arc<Mutex<FakeWorker>>;

fn fake_worker() -> SharedWorker {
    Arc::new(Mutex::new(FakeWorker { worker_version: 1, ..Default::default() }))
}

#[derive(Clone)]
struct FakeRemote {
    be: SharedWorker,
    device_id: String,
}

impl FakeRemote {
    fn new(be: &SharedWorker, device_id: &str) -> Self {
        FakeRemote { be: be.clone(), device_id: device_id.to_string() }
    }

    fn check_offline(&self) -> RemoteResult<()> {
        if self.be.lock().unwrap().offline {
            Err(RemoteError::Offline("fake worker down".into()))
        } else {
            Ok(())
        }
    }
}

impl Remote for FakeRemote {
    fn meta(&self) -> impl std::future::Future<Output = RemoteResult<Meta>> + Send {
        let this = self.clone();
        async move {
            this.check_offline()?;
            let b = this.be.lock().unwrap();
            Ok(Meta {
                version: b.worker_version,
                features: vec!["sync".into(), "wipe".into()],
                workspace: b.bound.clone(),
            })
        }
    }

    fn bind(&self, name: &str, device_name: &str) -> impl std::future::Future<Output = RemoteResult<Bound>> + Send {
        let this = self.clone();
        let name = name.to_string();
        let device_name = device_name.to_string();
        async move {
            this.check_offline()?;
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

    fn poll(&self) -> impl std::future::Future<Output = RemoteResult<PollResponse>> + Send {
        let this = self.clone();
        async move {
            this.check_offline()?;
            let b = this.be.lock().unwrap();
            Ok(PollResponse { manifest_etag: b.etag_str(), presence: b.presence.clone() })
        }
    }

    fn fetch_manifest(
        &self,
        since: Option<&str>,
    ) -> impl std::future::Future<Output = RemoteResult<Option<(Manifest, String)>>> + Send {
        let this = self.clone();
        let since = since.map(String::from);
        async move {
            this.check_offline()?;
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
            this.check_offline()?;
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
                return Err(RemoteError::Conflict { etag: b.etag_str() });
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
            this.check_offline()?;
            let b = this.be.lock().unwrap();
            b.blobs.get(&key).cloned().ok_or(RemoteError::NotFound)
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
            this.check_offline()?;
            this.be.lock().unwrap().blobs.entry(key).or_insert(bytes);
            Ok(())
        }
    }

    fn list_blobs(&self, file_id: &str) -> impl std::future::Future<Output = RemoteResult<Vec<(String, u64)>>> + Send {
        let this = self.clone();
        let fid = file_id.to_string();
        async move {
            this.check_offline()?;
            let b = this.be.lock().unwrap();
            Ok(b.blobs.keys().filter(|(f, _)| *f == fid).map(|(_, h)| (h.clone(), 0u64)).collect())
        }
    }

    fn delete_blob(&self, file_id: &str, hash: &str) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        let this = self.clone();
        let key = (file_id.to_string(), hash.to_string());
        async move {
            this.be.lock().unwrap().blobs.remove(&key);
            Ok(())
        }
    }

    fn get_history(
        &self,
        file_id: &str,
    ) -> impl std::future::Future<Output = RemoteResult<Option<HistoryArchive>>> + Send {
        let this = self.clone();
        let fid = file_id.to_string();
        async move {
            this.check_offline()?;
            let b = this.be.lock().unwrap();
            Ok(b.histories.get(&fid).cloned())
        }
    }

    fn put_history(
        &self,
        file_id: &str,
        archive: &HistoryArchive,
    ) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        let this = self.clone();
        let fid = file_id.to_string();
        let archive = archive.clone();
        async move {
            this.be.lock().unwrap().histories.insert(fid, archive);
            Ok(())
        }
    }

    fn put_presence(&self, name: &str, path: Option<&str>) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        let this = self.clone();
        let entry = PresenceEntry { name: name.to_string(), path: path.map(String::from), ts: now_ms() };
        async move {
            this.check_offline()?;
            this.be.lock().unwrap().presence.insert(this.device_id.clone(), entry);
            Ok(())
        }
    }

    fn delete_presence(&self) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        let this = self.clone();
        async move {
            this.be.lock().unwrap().presence.remove(&this.device_id);
            Ok(())
        }
    }

    fn wipe(&self) -> impl std::future::Future<Output = RemoteResult<WipeRound>> + Send {
        let this = self.clone();
        async move {
            this.check_offline()?;
            let mut b = this.be.lock().unwrap();
            let purged = (b.bound.is_some() as u64) + 1 + b.blobs.len() as u64 + b.histories.len() as u64;
            b.bound = None;
            b.manifest = Manifest::default();
            b.etag += 1;
            b.blobs.clear();
            b.histories.clear();
            b.presence.clear();
            Ok(WipeRound { purged, remaining: false })
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
    statuses: StatusTable,
    events: Arc<Collected>,
}

fn device(name: &str, be: &SharedWorker) -> Device {
    let root = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    device_at(name, be, root, state)
}

fn device_at(name: &str, be: &SharedWorker, root: tempfile::TempDir, state: tempfile::TempDir) -> Device {
    std::fs::create_dir_all(state.path().join("base")).unwrap();
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
            device_id: format!("d-{}", name.to_lowercase()),
            device_name: name.to_string(),
            use_trash: false,
        },
        Arc::new(FakeRemote::new(be, &format!("d-{}", name.to_lowercase()))),
        events.clone(),
        statuses.clone(),
    );
    Device { engine, root, _state: state, statuses, events }
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

#[tokio::test]
async fn edit_propagates_and_builds_history() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    let mut b = device("Bob", &be);
    a.write("doc.md", "v1 content\n");
    a.cycle().await;
    b.cycle().await;

    a.write("doc.md", "v2 content, longer\n");
    a.cycle().await;
    b.cycle().await;
    assert_eq!(b.read("doc.md").as_deref(), Some("v2 content, longer\n"));

    let m = manifest_of(&be);
    let f = m.files.values().next().unwrap();
    assert_eq!(f.rev, 2);
    assert_eq!(f.hist.len(), 1);
    assert_eq!(f.hist[0].r, 1);
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
        be2.blobs.insert(("f-racer".into(), hash.clone()), bytes.clone());
        m.files.insert(
            "f-racer".into(),
            ManifestFile {
                path: "x.md".into(),
                rev: 1,
                hash,
                size: bytes.len() as u64,
                mtime: now_ms(),
                by: "Racer".into(),
                hist: vec![],
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

    a.rename("old-name.md", "new-name.md");
    a.cycle().await;
    {
        let m = manifest_of(&be);
        assert_eq!(m.files.len(), 1, "a rename must not fork the file");
        let (fid, f) = m.files.iter().next().unwrap();
        assert_eq!(*fid, fid_before, "same identity across the rename");
        assert_eq!(f.path, "new-name.md");
    }

    b.cycle().await;
    assert!(b.read("old-name.md").is_none());
    assert_eq!(b.read("new-name.md").as_deref(), Some("stable content that does not change\n"));
}

#[tokio::test]
async fn history_rolls_over_into_archive() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    a.write("doc.md", "revision 0 --------\n");
    a.cycle().await;
    for i in 1..=13 {
        a.write("doc.md", &format!("revision {} {}\n", i, "-".repeat(i)));
        a.cycle().await;
    }
    let be2 = be.lock().unwrap();
    let (fid, f) = be2.manifest.files.iter().next().unwrap();
    assert_eq!(f.rev, 14);
    assert_eq!(f.hist.len(), MANIFEST_HIST_MAX);
    assert!(f.hist.len() <= MAX_INLINE_HIST);
    let archive = be2.histories.get(fid).expect("archive exists after rollover");
    assert!(!archive.entries.is_empty());
    let mut revs: Vec<u64> = f.hist.iter().map(|h| h.r).collect();
    revs.extend(archive.entries.iter().map(|h| h.r));
    revs.sort_unstable();
    revs.dedup();
    assert_eq!(revs, (1..=13).collect::<Vec<u64>>());
    for h in f.hist.iter().map(|h| &h.h).chain(archive.entries.iter().map(|h| &h.h)) {
        assert!(be2.blobs.contains_key(&(fid.clone(), h.clone())));
    }
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

/* ---------- Timing, the worker-outdated state, presence, history ---------- */

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

    // Shutdown leaves presence.
    cmd_tx.send(EngineCmd::Shutdown).unwrap();
    task.await.unwrap();
    assert!(be.lock().unwrap().presence.get("d-alice").is_none());
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
    a.write("doc.md", "# doc\n");
    a.cycle().await;
    b.cycle().await;

    a.engine.set_activity(Some(a.abs("doc.md").to_string_lossy().to_string()));
    a.engine.presence_tick().await;
    {
        let p = &be.lock().unwrap().presence;
        assert_eq!(p["d-alice"].name, "Alice");
        assert_eq!(p["d-alice"].path.as_deref(), Some("doc.md"));
    }
    // A path outside the workspace reads as idle.
    a.engine.set_activity(Some("/elsewhere/x.md".into()));
    a.engine.presence_tick().await;
    assert_eq!(be.lock().unwrap().presence["d-alice"].path, None);
    a.engine.set_activity(Some(a.abs("doc.md").to_string_lossy().to_string()));
    a.engine.presence_tick().await;

    // Bob's poll shows Alice, never Bob himself.
    b.engine.presence_tick().await;
    b.engine.poll_for_test().await;
    let seen = b.status().presence;
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].device_id, "d-alice");
    assert_eq!(seen[0].name, "Alice");
    assert_eq!(seen[0].path.as_deref(), Some("doc.md"));
}

#[tokio::test]
async fn history_lists_every_revision_and_fetches_one() {
    let be = fake_worker();
    let mut a = device("Alice", &be);
    a.write("doc.md", "v1\n");
    a.cycle().await;
    a.write("doc.md", "v2 is longer\n");
    a.cycle().await;
    a.write("doc.md", "v3, longer still\n");
    a.cycle().await;

    let revs = a.engine.history("doc.md").await.unwrap();
    assert_eq!(revs.iter().map(|r| r.rev).collect::<Vec<_>>(), vec![3, 2, 1]);
    assert!(revs[0].current && !revs[1].current);
    assert!(revs.iter().all(|r| r.by == "Alice" && r.time_ms > 0));
    let v1 = revs.iter().find(|r| r.rev == 1).unwrap();
    assert_eq!(a.engine.revision("doc.md", &v1.hash).await.unwrap(), "v1\n");
    assert!(a.engine.revision("doc.md", "0000000000000000").await.unwrap_err().contains("cleaned up"));
    assert!(a.engine.history("never.md").await.unwrap_err().contains("hasn't synced"));
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
            ManifestFile { path: path.into(), rev: 1, hash: "0".repeat(16), size: 1, mtime: 0, by: "".into(), hist: vec![] },
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
