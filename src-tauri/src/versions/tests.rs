//! What the versioner promises, tested without the app around it: the
//! cadence rule's consequences (pure, on a simulated clock), the ladder and
//! the sweep, the store's round trip, and the two states — disabled, too
//! large — where capture deliberately does nothing.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::FileTimes;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration as StdDuration, SystemTime};

use tempfile::TempDir;
use tokio::time::{Duration, Instant};

use crate::cloud::scan::MAX_SYNC_ENTRIES;
use crate::cloud::status::{Events, Revision};
use crate::cloud::versions::{snapshot_id, VersionsEntry};

use super::capture::{capture, Cadence, Captured, CAPTURE_MIN_INTERVAL, SESSION_IDLE};
use super::history::{self, FileVersion, MAX_DIFF_BYTES};
use super::retain::{retain, sweep, GC_GRACE};
use super::settings::Settings;
use super::status::{Phase, RestoreOutcome, EV_APPLIED};
use super::workspace::RestoreReport;
use super::store::{
    digest_of, gunzip, gzip, hash_full, FileEntry, Index, Reason, Snapshot, SnapshotRow, Store, STORE_VERSION,
};
use super::stores;
use super::{Clock, VersionBus, Versioner, VersionerCmd};

/* ---------- The fixture ---------- */

/// Every event the versioner emitted, in order — so a test can hold the
/// frontend contract to its word without a window in sight.
#[derive(Default)]
struct Recorder(Mutex<Vec<(String, serde_json::Value)>>);

impl Events for Recorder {
    fn emit_json(&self, event: &str, payload: serde_json::Value) {
        self.0.lock().unwrap().push((event.to_string(), payload));
    }
}

impl Recorder {
    fn last(&self, event: &str) -> Option<serde_json::Value> {
        self.0.lock().unwrap().iter().rev().find(|(name, _)| name == event).map(|(_, v)| v.clone())
    }
}

struct Fixture {
    root: TempDir,
    data: TempDir,
    clock: Arc<AtomicU64>,
    events: Arc<Recorder>,
    versioner: Versioner,
}

/// A folder, an empty store beside it, and a clock the test moves by hand.
fn fixture(now_ms: u64) -> Fixture {
    fixture_with(now_ms, Settings::default())
}

fn fixture_with(now_ms: u64, settings: Settings) -> Fixture {
    let root = TempDir::new().unwrap();
    let data = TempDir::new().unwrap();
    let clock = Arc::new(AtomicU64::new(now_ms));
    let ticker = clock.clone();
    let events = Arc::new(Recorder::default());
    let versioner = Versioner::new(
        Store::open(data.path(), "r-test", root.path()),
        "Test Mac".to_string(),
        &settings,
        Arc::new(Mutex::new(Default::default())),
        events.clone(),
        Clock(Arc::new(move || ticker.load(Ordering::SeqCst))),
    );
    Fixture { root, data, clock, events, versioner }
}

impl Fixture {
    fn write(&self, rel: &str, body: &str) {
        let path = self.root.path().join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn remove(&self, rel: &str) {
        std::fs::remove_file(self.root.path().join(rel)).unwrap();
    }

    fn at(&self, now_ms: u64) {
        self.clock.store(now_ms, Ordering::SeqCst);
    }

    /// Capture through the scan itself, so the test can see what it read.
    fn capture(&mut self, reason: Reason) -> Captured {
        let v = &mut self.versioner;
        let mut index = std::mem::take(&mut v.index);
        let mut last = std::mem::take(&mut v.last);
        let out = capture(&v.store, &mut index, &mut last, &v.by, reason, None, v.clock.now_ms());
        v.index = index;
        v.last = last;
        out.expect("capture")
    }

    fn store(&self) -> &Store {
        &self.versioner.store
    }

    fn rows(&self) -> &[SnapshotRow] {
        &self.versioner.index.snapshots
    }

    /// A snapshot another Mac mirrored, already in this store's cloud cache
    /// — which is where the rail reads one from after the engine has pulled
    /// it down. Answers the index entry that names it.
    fn mirrored(&self, ts: u64, device: &str, by: &str, files: &[(&str, &str)]) -> VersionsEntry {
        let mut map: BTreeMap<String, FileEntry> = BTreeMap::new();
        let mut bytes = 0u64;
        for (path, content) in files {
            map.insert(
                (*path).to_string(),
                FileEntry { h: hash_full(content.as_bytes()), s: content.len() as u64, m: ts },
            );
            bytes += content.len() as u64;
        }
        let snap = Snapshot {
            version: STORE_VERSION,
            ts,
            reason: Reason::Interval,
            restored_from: None,
            by: by.to_string(),
            files: map.clone(),
        };
        let id = snapshot_id(ts, device);
        let gz = gzip(&serde_json::to_vec(&snap).unwrap()).unwrap();
        self.store().write_cloud_snapshot(&id, &gz);
        VersionsEntry {
            id,
            ts,
            device: device.to_string(),
            reason: "interval".to_string(),
            files: files.len() as u64,
            bytes,
            digest: digest_of(&map),
            ..Default::default()
        }
    }

    fn blob(&self, hash: &str) -> Vec<u8> {
        gunzip(&std::fs::read(self.store().blob_path(hash)).unwrap()).unwrap()
    }

    /// One document's versions, newest first, as the rail asks for them.
    fn history(&mut self, rel: &str) -> Vec<FileVersion> {
        self.history_with(rel, &[])
    }

    /// The same, with what other devices mirrored folded into the walk.
    fn history_with(&mut self, rel: &str, cloud: &[VersionsEntry]) -> Vec<FileVersion> {
        let current = history::hash_on_disk(&self.root.path().join(rel));
        let v = &mut self.versioner;
        let retained = history::retained_set(&v.index, cloud);
        history::file_versions(&v.store, &retained, &mut v.cache, rel, current.as_deref())
    }

    /// A restore, with the write the app would do standing in for the one
    /// the versioner asks its caller for.
    fn restore(&mut self, rel: &str, ts: Option<u64>, hash: Option<String>) -> RestoreOutcome {
        let path = self.root.path().join(rel);
        self.versioner
            .restore_file(&path, ts, hash, None, &|path, contents| {
                std::fs::write(path, contents).map_err(|e| e.to_string())
            })
            .expect("restore")
    }

    /// A workspace restore, with the app's write and its trash standing in
    /// for the real ones — the same substitution `restore` makes for one
    /// file. Answers what moved.
    fn restore_all(&mut self, ts: u64, only: Option<&[String]>) -> RestoreReport {
        self.versioner
            .restore_snapshot(
                ts,
                only,
                &|path, bytes| std::fs::write(path, bytes).map_err(|e| e.to_string()),
                &|path| std::fs::remove_file(path).is_ok(),
            )
            .expect("restore the workspace")
    }

    fn on_disk(&self, rel: &str) -> Option<String> {
        std::fs::read_to_string(self.root.path().join(rel)).ok()
    }

    /// Hand the versioner to the task that drives it, keeping the temp
    /// directories alive for as long as the test needs them.
    fn shared(self) -> (TempDir, TempDir, Arc<Mutex<Versioner>>) {
        (self.root, self.data, Arc::new(Mutex::new(self.versioner)))
    }
}

/// Backdate a file so the sweep's grace period has passed for it.
fn age(path: &Path, secs: u64) {
    let when = SystemTime::now() - StdDuration::from_secs(secs);
    let file = std::fs::File::options().write(true).open(path).unwrap();
    file.set_times(FileTimes::new().set_modified(when)).unwrap();
}

const T0: u64 = 1_757_000_000_000;

/* ---------- Capture ---------- */

#[test]
fn seed_captures_on_first_start() {
    let mut f = fixture(T0);
    f.write("plan.md", "# plan\n");
    f.write("notes/one.md", "one\n");
    f.versioner.start();

    assert_eq!(f.rows().len(), 1, "the folder is recorded before anything is touched");
    let row = &f.rows()[0];
    assert_eq!(row.reason, Reason::Seed);
    assert_eq!(row.files, 2);
    assert_eq!(row.ts, T0);
    let snap = f.store().read_snapshot(T0).unwrap();
    assert_eq!(snap.by, "Test Mac");
    assert_eq!(snap.files.keys().collect::<Vec<_>>(), vec!["notes/one.md", "plan.md"]);
}

#[test]
fn identical_scan_writes_no_snapshot() {
    let mut f = fixture(T0);
    f.write("plan.md", "# plan\n");
    f.capture(Reason::Seed);
    f.at(T0 + 600_000);
    let second = f.capture(Reason::Interval);

    assert!(second.row.is_none(), "nothing changed, so nothing was written");
    assert_eq!(f.rows().len(), 1);
    assert_eq!(f.store().snapshot_files().len(), 1);
}

#[test]
fn stat_cache_skips_hashing_untouched_files() {
    let mut f = fixture(T0);
    f.write("a.md", "aaa\n");
    f.write("b.md", "bbb\n");
    let first = f.capture(Reason::Seed);
    assert_eq!((first.hashed, first.reused), (2, 0));

    f.at(T0 + 600_000);
    f.write("c.md", "ccc\n");
    let second = f.capture(Reason::Interval);
    assert_eq!((second.hashed, second.reused), (1, 2), "only the new file is read");
    assert_eq!(f.rows().len(), 2);
}

#[test]
fn blob_dedupes_across_paths() {
    let mut f = fixture(T0);
    f.write("one.md", "the very same bytes\n");
    f.write("copies/two.md", "the very same bytes\n");
    let out = f.capture(Reason::Seed);

    assert_eq!(out.hashed, 2);
    assert_eq!(out.blobs_written, 1, "one content, one blob");
    assert_eq!(f.store().blob_files().len(), 1);
}

#[test]
fn deleting_files_on_disk_removes_nothing_from_the_store() {
    let mut f = fixture(T0);
    f.write("gone.md", "please keep me\n");
    f.capture(Reason::Seed);
    let hash = f.store().read_snapshot(T0).unwrap().files["gone.md"].h.clone();

    f.at(T0 + 600_000);
    f.remove("gone.md");
    f.capture(Reason::Interval);

    assert_eq!(f.rows().len(), 2);
    assert_eq!(f.rows()[1].files, 0, "the newest snapshot knows the file is gone");
    assert_eq!(f.blob(&hash), b"please keep me\n", "and its bytes are still there");
}

#[test]
fn too_large_root_captures_nothing_and_reports_phase() {
    let mut f = fixture(T0);
    for i in 0..=MAX_SYNC_ENTRIES {
        f.write(&format!("n{}.md", i), "x");
    }
    f.versioner.start();

    assert_eq!(f.versioner.phase, Phase::TooLarge);
    assert!(f.versioner.error.as_deref().unwrap().contains("too large"));
    assert!(f.rows().is_empty(), "never a partial snapshot");
}

#[test]
fn disabled_captures_nothing_and_reports_phase() {
    let mut f = fixture_with(T0, Settings { enabled: false, ..Default::default() });
    f.write("plan.md", "# plan\n");
    f.versioner.start();
    assert_eq!(f.versioner.phase, Phase::Disabled);
    assert!(f.rows().is_empty());

    f.versioner.set_enabled(true);
    f.versioner.capture(Reason::Manual, None);
    assert_eq!(f.rows().len(), 1, "and it picks up again when it is turned back on");
}

#[test]
fn index_and_snapshot_round_trip_through_gzip() {
    let mut f = fixture(T0);
    f.write("plan.md", "# plan\n");
    f.write("notes/one.md", "one\n");
    f.versioner.start();
    f.at(T0 + 600_000);
    f.write("plan.md", "# plan, rewritten\n");
    f.versioner.capture_now(Reason::Manual, Some("  before the rewrite  ".into()), None).unwrap();

    let reopened = Store::open(f.data.path(), "r-test", f.root.path()).read_index();
    assert_eq!(reopened.snapshots.len(), 2);
    assert_eq!(reopened.root, f.root.path().to_string_lossy());
    let manual = &reopened.snapshots[1];
    assert_eq!(manual.reason, Reason::Manual);
    assert!(manual.pinned, "a version the user asked for is never thinned");
    assert_eq!(manual.label.as_deref(), Some("before the rewrite"));

    let snap = f.store().read_snapshot(manual.ts).unwrap();
    assert_eq!(snap.ts, manual.ts);
    assert_eq!(snap.files.len(), 2);
    assert_eq!(snap.files["plan.md"].s, 18);
}

/* ---------- The cadence ---------- */

/// Run the rule over a script: `edits(second)` says whether an edit landed
/// in that second. Answers what was captured, and when.
fn drive(edits: impl Fn(u64) -> bool, seconds: u64) -> Vec<(u64, Reason)> {
    let start = Instant::now();
    let mut cadence = Cadence::new(start);
    let mut out = Vec::new();
    for second in 0..=seconds {
        let now = start + Duration::from_secs(second);
        if edits(second) {
            cadence.touched(now);
        }
        if let Some(reason) = cadence.due(now) {
            out.push((second, reason));
        }
    }
    out
}

fn reasons(captures: &[(u64, Reason)]) -> Vec<Reason> {
    captures.iter().map(|(_, r)| *r).collect()
}

#[test]
fn burst_inside_an_interval_yields_one_snapshot() {
    // A minute of typing, then silence: the interval never comes up, and
    // the session's end is the only snapshot.
    let captures = drive(|s| s < 60, 600);
    assert_eq!(reasons(&captures), vec![Reason::Closing]);
    assert_eq!(captures[0].0, 59 + SESSION_IDLE.as_secs());
}

#[test]
fn steady_hour_yields_six_plus_closing() {
    // An edit every half minute for an hour, then the user stops. Six
    // intervals while it lasts, and one closing for the tail after the
    // sixth.
    let captures = drive(|s| s % 30 == 0 && s <= 3630, 4200);
    assert_eq!(
        reasons(&captures),
        vec![
            Reason::Interval,
            Reason::Interval,
            Reason::Interval,
            Reason::Interval,
            Reason::Interval,
            Reason::Interval,
            Reason::Closing
        ]
    );
    let intervals: Vec<u64> = captures.iter().filter(|(_, r)| *r == Reason::Interval).map(|(s, _)| *s).collect();
    assert_eq!(intervals, vec![600, 1200, 1800, 2400, 3000, 3600]);
    assert_eq!(captures[6].0, 3630 + SESSION_IDLE.as_secs());
}

#[test]
fn quiet_hour_yields_nothing() {
    assert!(drive(|_| false, 3600).is_empty(), "no edits, no snapshots");
}

#[test]
fn session_end_is_always_captured() {
    let captures = drive(|s| s == 0, 600);
    assert_eq!(reasons(&captures), vec![Reason::Closing]);
    assert_eq!(captures[0].0, SESSION_IDLE.as_secs(), "two minutes after the last edit, not before");
}

#[test]
fn write_loop_is_bounded_to_one_per_interval() {
    // Something rewriting a file every second: the session never ends, so
    // the only rule that fires is the interval.
    let captures = drive(|_| true, 3600);
    assert_eq!(captures.len(), 6);
    assert!(captures.iter().all(|(_, r)| *r == Reason::Interval));
    assert_eq!(captures[0].0, CAPTURE_MIN_INTERVAL.as_secs());
}

/* ---------- The ladder ---------- */

fn row(ts: u64) -> SnapshotRow {
    SnapshotRow { ts, digest: format!("d{}", ts), ..Default::default() }
}

/// Hourly snapshots for `hours`, ending at `end`.
fn hourly(end: u64, hours: u64) -> Vec<SnapshotRow> {
    (0..hours).map(|i| row(end - (hours - 1 - i) * 3_600_000)).collect()
}

#[test]
fn ladder_keeps_expected_counts_over_two_synthetic_years() {
    let end = T0;
    let rows = hourly(end, 2 * 365 * 24);
    let keep = retain(&rows, end, None);

    let count = |from_h: u64, to_h: u64| {
        keep.iter().filter(|ts| {
            let age = end - **ts;
            age >= from_h * 3_600_000 && age < to_h * 3_600_000
        })
        .count()
    };
    // The newest, then one an hour for a day, one a day for a month, one a
    // week for a year, one a month beyond that.
    // Exact, because the bands are bucketed by the calendar rather than by
    // elapsed time: a 29-day window touches 30 UTC days, and so on.
    assert_eq!(count(0, 1), 1, "the newest");
    assert_eq!(count(1, 24), 23, "hourly for the rest of the day");
    assert_eq!(count(24, 30 * 24), 30, "daily for the rest of the month");
    assert_eq!(count(30 * 24, 365 * 24), 49, "weekly for the rest of the year");
    assert_eq!(count(365 * 24, 2 * 365 * 24), 13, "monthly beyond that");
    assert_eq!(keep.len(), 116, "17,520 hourly snapshots thinned to 116");

    let thinned: Vec<SnapshotRow> = rows.iter().filter(|r| keep.contains(&r.ts)).cloned().collect();
    assert_eq!(retain(&thinned, end, None), keep, "the ladder is idempotent");
}

#[test]
fn ladder_never_drops_newest_or_pinned() {
    let end = T0;
    let mut rows = hourly(end, 24 * 400);
    // Something the user named, a year and a bit back.
    let pinned_ts = rows[10].ts;
    rows[10].pinned = true;
    let keep = retain(&rows, end, Some(30));

    assert!(keep.contains(&end), "the newest state is never a candidate");
    assert!(keep.contains(&pinned_ts), "nor is a version the user pinned — horizon or no horizon");
}

#[test]
fn horizon_drops_everything_older() {
    let end = T0;
    let rows = hourly(end, 24 * 120);
    let keep = retain(&rows, end, Some(30));
    let oldest = keep.iter().copied().min().unwrap();

    assert!(end - oldest <= 30 * 24 * 3_600_000, "nothing older than the horizon survives");
    assert!(keep.len() < retain(&rows, end, None).len(), "and the horizon is doing something");
}

/* ---------- The sweep ---------- */

#[test]
fn sweep_removes_dropped_and_orphaned_snapshots_then_unreferenced_blobs() {
    // Two snapshots inside one UTC hour: once they are old enough to fall
    // into the hourly band, only the later survives.
    let mut f = fixture(T0);
    f.write("a.md", "one\n");
    f.capture(Reason::Seed);
    let gone = f.store().read_snapshot(T0).unwrap().files["a.md"].h.clone();

    f.at(T0 + 60_000);
    f.write("a.md", "two, longer\n");
    f.capture(Reason::Interval);
    let kept = f.store().read_snapshot(T0 + 60_000).unwrap().files["a.md"].h.clone();

    // A snapshot file no index ever named — an interrupted capture.
    let orphan = f.store().snapshot_path(T0 - 3_600_000);
    std::fs::write(&orphan, b"not even gzip").unwrap();
    for (_, path) in f.store().blob_files() {
        age(&path, 2 * GC_GRACE.as_secs());
    }
    age(&orphan, 2 * GC_GRACE.as_secs());

    let now = T0 + 2 * 3_600_000;
    let mut index = std::mem::take(&mut f.versioner.index);
    let report = sweep(f.store(), &mut index, now, None);
    f.versioner.index = index;

    assert_eq!(report.snapshots_dropped, 1);
    assert_eq!(f.rows().len(), 1);
    assert_eq!(f.rows()[0].ts, T0 + 60_000);
    assert!(!f.store().snapshot_path(T0).exists(), "the dropped snapshot's file goes with it");
    assert!(!orphan.exists(), "so does an orphan");
    assert_eq!(report.blobs_dropped, 1);
    assert!(!f.store().blob_path(&gone).exists(), "the content only it referenced is collected");
    assert_eq!(f.blob(&kept), b"two, longer\n", "what the survivor references is untouched");
}

#[test]
fn sweep_spares_blobs_younger_than_grace() {
    let mut f = fixture(T0);
    f.write("a.md", "one\n");
    f.capture(Reason::Seed);
    let unreferenced = f.store().read_snapshot(T0).unwrap().files["a.md"].h.clone();

    f.at(T0 + 60_000);
    f.write("a.md", "two, longer\n");
    f.capture(Reason::Interval);

    // Same thinning as above, but the blobs were written moments ago: a
    // capture in flight must never have its bytes swept out from under it.
    let now = T0 + 2 * 3_600_000;
    let mut index = std::mem::take(&mut f.versioner.index);
    let report = sweep(f.store(), &mut index, now, None);
    f.versioner.index = index;

    assert_eq!(report.snapshots_dropped, 1);
    assert_eq!(report.blobs_dropped, 0);
    assert!(f.store().blob_path(&unreferenced).exists());
}

/* ---------- The task ---------- */

/// Start the versioner task over a folder holding one file, and answer the
/// store to look in, the channel to drive it with, and its handle.
async fn spawn(
    f: Fixture,
) -> (
    TempDir,
    TempDir,
    Store,
    tokio::sync::mpsc::UnboundedSender<VersionerCmd>,
    tokio::task::JoinHandle<()>,
) {
    let store = Store::open(f.data.path(), "r-test", f.root.path());
    let (root, data, state) = f.shared();
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel();
    let (fs_tx, fs_rx) = tokio::sync::mpsc::unbounded_channel();
    // The watcher's sender stays alive for the test; a versioner whose
    // watcher never started falls back to the edit bus alone.
    std::mem::forget(fs_tx);
    let task = tokio::spawn(super::run(state, cmd_rx, fs_rx));

    // A command is only answered once the task is past its start, so asking
    // for the snapshots is the barrier that says "the seed is on disk".
    let (reply, seeded) = tokio::sync::oneshot::channel();
    cmd_tx.send(VersionerCmd::Snapshots { reply }).unwrap();
    assert_eq!(seeded.await.unwrap().len(), 1, "the seed");
    (root, data, store, cmd_tx, task)
}

#[tokio::test]
async fn a_versioner_captures_the_session_on_the_way_out() {
    let f = fixture(T0);
    f.write("plan.md", "# plan\n");
    let root = f.root.path().to_path_buf();
    let (_root, _data, store, cmd_tx, task) = spawn(f).await;

    cmd_tx.send(VersionerCmd::Touched("plan.md".into())).unwrap();
    std::fs::write(root.join("plan.md"), "# plan, edited after the seed\n").unwrap();
    cmd_tx.send(VersionerCmd::Shutdown).unwrap();
    task.await.unwrap();

    let rows = store.read_index().snapshots;
    assert_eq!(rows.len(), 2, "the folder as it was found, then as the session left it");
    assert_eq!(rows[0].reason, Reason::Seed);
    assert_eq!(rows[1].reason, Reason::Closing);
    assert_eq!(rows[1].ts, T0 + 1, "two captures in one millisecond are still two versions");
}

#[tokio::test]
async fn a_flush_captures_what_is_pending_and_answers() {
    let f = fixture(T0);
    f.write("plan.md", "# plan\n");
    let root = f.root.path().to_path_buf();
    let (_root, _data, store, cmd_tx, task) = spawn(f).await;

    cmd_tx.send(VersionerCmd::Touched("plan.md".into())).unwrap();
    std::fs::write(root.join("plan.md"), "# plan, typed right up to the quit\n").unwrap();
    let (reply, answer) = tokio::sync::oneshot::channel();
    cmd_tx.send(VersionerCmd::Flush { reply }).unwrap();
    answer.await.unwrap();

    // Quitting mid-edit ends in a snapshot, and the flush answers only once
    // it is on disk.
    let rows = store.read_index().snapshots;
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1].reason, Reason::Closing);

    // Nothing is pending any more, so the way out adds nothing.
    cmd_tx.send(VersionerCmd::Shutdown).unwrap();
    task.await.unwrap();
    assert_eq!(store.read_index().snapshots.len(), 2);
}

/* ---------- The bus ---------- */

#[test]
fn edit_bus_routes_a_touch_to_the_versioner_whose_root_holds_it() {
    let bus = VersionBus::default();
    let (a_tx, mut a_rx) = tokio::sync::mpsc::unbounded_channel();
    let (b_tx, mut b_rx) = tokio::sync::mpsc::unbounded_channel();
    bus.register(std::path::PathBuf::from("/ws/a"), a_tx);
    bus.register(std::path::PathBuf::from("/ws/b"), b_tx);

    assert!(bus.touch(Path::new("/ws/a/notes/x.md")));
    match a_rx.try_recv() {
        Ok(VersionerCmd::Touched(rel)) => assert_eq!(rel, "notes/x.md"),
        _ => panic!("a must hear its touch"),
    }
    assert!(b_rx.try_recv().is_err(), "b hears nothing");

    assert!(!bus.touch(Path::new("/elsewhere/x.md")));
    assert!(!bus.touch(Path::new("/ws/a/.doklin/cloud.json")), "hidden paths never wake it");
    assert!(!bus.touch(Path::new("/ws/a/x.md.doklin-sync-tmp")));
    assert!(!bus.touch(Path::new("/ws/a")), "the root itself is not a file");
    assert!(a_rx.try_recv().is_err());

    bus.unregister(Path::new("/ws/a"));
    assert!(!bus.touch(Path::new("/ws/a/notes/x.md")));
}

/* ---------- Types the tests lean on ---------- */

#[test]
fn a_capture_is_ordered_after_the_one_before_it() {
    // Two captures in the same millisecond still produce two versions.
    let mut f = fixture(T0);
    f.write("a.md", "one\n");
    f.capture(Reason::Seed);
    f.write("a.md", "two, longer\n");
    let second = f.capture(Reason::Interval);
    assert_eq!(second.row.unwrap().ts, T0 + 1);

    let map: BTreeMap<u64, Reason> = f.rows().iter().map(|r| (r.ts, r.reason)).collect();
    assert_eq!(map.len(), 2);
}

#[test]
fn an_index_survives_a_store_that_was_never_written() {
    let data = TempDir::new().unwrap();
    let root = TempDir::new().unwrap();
    let index: Index = Store::open(data.path(), "r-nothing", root.path()).read_index();
    assert!(index.snapshots.is_empty());
    assert_eq!(index.root, root.path().to_string_lossy());
}

/* ---------- One file's history ---------- */

#[test]
fn equal_hashes_collapse_to_one_entry() {
    // Two snapshots either side of an edit to a DIFFERENT file: the
    // document itself has one version, dated when its content appeared —
    // "last changed on Tuesday", not "changed at every capture since".
    let mut f = fixture(T0);
    f.write("a.md", "one\n");
    f.write("other.md", "x\n");
    f.capture(Reason::Seed);
    f.at(T0 + 60_000);
    f.write("other.md", "x and more\n");
    f.capture(Reason::Interval);

    let versions = f.history("a.md");
    assert_eq!(versions.len(), 1, "one content, one row");
    assert_eq!(versions[0].ts, T0, "dated where the content first appeared");
    assert_eq!(versions[0].reason, "seed");
    assert_eq!(versions[0].by, "Test Mac");
    assert!(versions[0].current, "and it is what is on disk");
}

#[test]
fn a_named_version_is_never_collapsed_away() {
    // *Name this version* on a document nothing changed in has to leave a
    // row behind — that is the whole promise of naming a moment.
    let mut f = fixture(T0);
    f.write("a.md", "one\n");
    f.write("other.md", "x\n");
    f.capture(Reason::Seed);
    f.at(T0 + 60_000);
    f.write("other.md", "x and more\n");
    f.capture(Reason::Interval);
    f.versioner.set_pinned(T0 + 60_000, true, Some("Before the rewrite".to_string())).unwrap();

    let versions = f.history("a.md");
    assert_eq!(versions.len(), 2, "the named moment stands on its own");
    assert_eq!(versions[0].ts, T0 + 60_000);
    assert_eq!(versions[0].label.as_deref(), Some("Before the rewrite"));
    assert!(versions[0].pinned);
    assert_eq!(versions[1].ts, T0);
    assert_eq!(versions[0].hash, versions[1].hash, "same bytes, two moments");
}

#[test]
fn versions_follow_a_rename_backwards() {
    let mut f = fixture(T0);
    f.write("plan.md", "alpha\n");
    f.capture(Reason::Seed);

    f.at(T0 + 60_000);
    f.remove("plan.md");
    f.write("roadmap.md", "alpha\n");
    f.capture(Reason::Interval);

    f.at(T0 + 120_000);
    f.write("roadmap.md", "alpha and beta\n");
    f.capture(Reason::Interval);

    let versions = f.history("roadmap.md");
    assert_eq!(versions.len(), 2, "the history did not start over at the rename");
    assert_eq!(versions[0].path, "roadmap.md");
    assert_eq!(versions[1].path, "plan.md", "and it remembers what the file used to be called");
    assert_eq!(versions[1].ts, T0);
}

#[test]
fn a_recreated_path_starts_a_new_history() {
    let mut f = fixture(T0);
    f.write("keep.md", "k\n");
    f.write("note.md", "first\n");
    f.capture(Reason::Seed);

    f.at(T0 + 60_000);
    f.remove("note.md");
    f.capture(Reason::Interval);

    f.at(T0 + 120_000);
    f.write("note.md", "a different note\n");
    f.capture(Reason::Interval);

    let versions = f.history("note.md");
    assert_eq!(versions.len(), 1, "a new file at an old name is a new file");
    assert_eq!(versions[0].ts, T0 + 120_000);
}

#[test]
fn a_deleted_paths_history_is_still_reachable() {
    let mut f = fixture(T0);
    f.write("keep.md", "k\n");
    f.write("note.md", "first\n");
    f.capture(Reason::Seed);
    f.at(T0 + 60_000);
    f.write("note.md", "first and second\n");
    f.capture(Reason::Interval);
    f.at(T0 + 120_000);
    f.remove("note.md");
    f.capture(Reason::Interval);

    let versions = f.history("note.md");
    assert_eq!(versions.len(), 2, "the newest snapshots lost it; the older ones did not");
    assert!(!versions.iter().any(|v| v.current), "nothing on disk to be current");
    assert!(history::hash_on_disk(&f.root.path().join("note.md")).is_none());
}

#[test]
fn current_marks_the_version_on_disk() {
    let mut f = fixture(T0);
    f.write("a.md", "one\n");
    f.capture(Reason::Seed);
    f.at(T0 + 60_000);
    f.write("a.md", "two and two\n");
    f.capture(Reason::Interval);

    let versions = f.history("a.md");
    assert_eq!(versions.len(), 2);
    assert!(versions[0].current, "the newest is what is on disk");
    assert!(!versions[1].current);

    // Typed since the last capture: no version is the document any more.
    f.write("a.md", "three, three and three\n");
    assert!(!f.history("a.md").iter().any(|v| v.current));
}

/* ---------- Reading and comparing ---------- */

#[test]
fn diff_is_unified_and_capped() {
    let mut f = fixture(T0);
    f.write("a.md", "one\n");
    f.capture(Reason::Seed);
    f.at(T0 + 60_000);
    f.write("a.md", "two and two\n");
    f.capture(Reason::Interval);

    let versions = f.history("a.md");
    let (new, old) = (versions[0].hash.clone(), versions[1].hash.clone());

    let text = |hash: &str| history::read_version(f.store(), hash).unwrap();
    let patch = history::diff_texts(&text(&old), &text(&new)).unwrap();
    assert!(patch.contains("--- original"), "a unified patch: {}", patch);
    assert!(patch.contains("-one"), "{}", patch);
    assert!(patch.contains("+two and two"), "{}", patch);

    // The other side may be the file on disk — how the newest version is
    // compared against now.
    f.write("a.md", "three and three\n");
    let path = f.root.path().join("a.md");
    let against_now = history::diff_texts(&text(&new), &history::read_disk(&path).unwrap()).unwrap();
    assert!(against_now.contains("+three and three"), "{}", against_now);

    let big = String::from_utf8(vec![b'a'; MAX_DIFF_BYTES + 1]).unwrap();
    let refused = history::diff_texts(&text(&old), &big).unwrap_err();
    assert!(refused.contains("too large to compare"), "{}", refused);

    let gone = history::read_version(f.store(), "0".repeat(64).as_str()).unwrap_err();
    assert!(gone.contains("no longer in this folder's history"), "{}", gone);
}

#[test]
fn cloud_prefix_matches_dedupe_against_local() {
    let mut f = fixture(T0);
    f.write("a.md", "one\n");
    f.capture(Reason::Seed);
    f.at(T0 + 60_000);
    f.write("a.md", "two and two\n");
    f.capture(Reason::Interval);
    // Typed since: the file on disk is a state no snapshot holds.
    f.write("a.md", "three and three and three\n");
    let disk = history::hash_on_disk(&f.root.path().join("a.md")).unwrap();

    let local = f.history("a.md");
    assert_eq!(local.len(), 2);

    let revision = |hash: &str, time_ms: u64| Revision {
        rev: 1,
        hash: hash[..16].to_string(),
        size: 4,
        time_ms,
        by: "Other Mac".to_string(),
        current: false,
    };
    let cloud = vec![
        revision(&local[1].hash, T0),                       // the same bytes, shorter name
        revision(&disk, T0 + 120_000),                      // what is on disk, uncaptured here
        revision(&"f".repeat(64), T0 + 30_000),             // only the cloud reaches this one
    ];

    let merged = history::merge_cloud(local, &cloud, Some(&disk), "a.md");
    assert_eq!(merged.len(), 3, "two were already known: {:?}", merged);
    assert_eq!(merged[0].ts, T0 + 60_000, "newest first");
    assert_eq!(merged[1].ts, T0 + 30_000);
    assert_eq!(merged[1].source, "manifest", "a sync-manifest revision, not a mirrored version");
    assert_eq!(merged[1].by, "Other Mac");
    assert_eq!(merged[1].path, "a.md");
    assert_eq!(merged[2].ts, T0);
    assert!(merged.iter().filter(|v| v.source == "local").count() == 2);
}

/* ---------- Restore ---------- */

/// One document with two captured versions and a third state on disk that
/// no snapshot holds — what a restore actually finds in the wild.
fn with_unsaved_work() -> Fixture {
    let mut f = fixture(T0);
    f.write("a.md", "one\n");
    f.capture(Reason::Seed);
    f.at(T0 + 60_000);
    f.write("a.md", "two and two\n");
    f.capture(Reason::Interval);
    f.at(T0 + 120_000);
    f.write("a.md", "three, three and three\n");
    f
}

#[test]
fn restore_captures_the_state_it_leaves_then_the_state_it_made() {
    let mut f = with_unsaved_work();
    let oldest = f.history("a.md").pop().unwrap();
    let outcome = f.restore("a.md", Some(oldest.ts), Some(oldest.hash.clone()));

    assert_eq!(std::fs::read_to_string(f.root.path().join("a.md")).unwrap(), "one\n");
    let rows: Vec<(u64, Reason)> = f.rows().iter().map(|r| (r.ts, r.reason)).collect();
    assert_eq!(
        rows,
        vec![
            (T0, Reason::Seed),
            (T0 + 60_000, Reason::Interval),
            (T0 + 120_000, Reason::PreRestore),
            (T0 + 120_001, Reason::Restore),
        ],
    );

    let left = f.store().read_snapshot(T0 + 120_000).unwrap();
    assert_eq!(f.blob(&left.files["a.md"].h), b"three, three and three\n", "the typing is kept");
    let made = f.store().read_snapshot(T0 + 120_001).unwrap();
    assert_eq!(f.blob(&made.files["a.md"].h), b"one\n");

    assert_eq!(outcome.pre_restore_ts, Some(T0 + 120_000));
    assert_eq!(outcome.pre_restore_hash, Some(hash_full(b"three, three and three\n")));
    assert_eq!(outcome.ts, Some(T0 + 120_001));

    let applied = f.events.last(EV_APPLIED).expect("a restore tells the app what to reload");
    assert_eq!(applied["root"], f.root.path().to_string_lossy().to_string());
    assert_eq!(applied["paths"][0], f.root.path().join("a.md").to_string_lossy().to_string());
}

#[test]
fn restore_names_its_source() {
    let mut f = with_unsaved_work();
    let oldest = f.history("a.md").pop().unwrap();
    f.restore("a.md", Some(oldest.ts), Some(oldest.hash.clone()));

    let newest = f.rows().last().unwrap();
    assert_eq!(newest.reason, Reason::Restore);
    assert_eq!(newest.restored_from, Some(T0), "the rail can say where it came from");
    assert_eq!(f.history("a.md")[0].restored_from, Some(T0));
}

#[test]
fn restore_with_nothing_unsaved_dedupes_the_pre_restore_capture() {
    let mut f = fixture(T0);
    f.write("a.md", "one\n");
    f.capture(Reason::Seed);
    f.at(T0 + 60_000);
    f.write("a.md", "two and two\n");
    f.capture(Reason::Interval);

    let oldest = f.history("a.md").pop().unwrap();
    let outcome = f.restore("a.md", Some(oldest.ts), Some(oldest.hash.clone()));

    let rows: Vec<(u64, Reason)> = f.rows().iter().map(|r| (r.ts, r.reason)).collect();
    assert_eq!(
        rows,
        vec![(T0, Reason::Seed), (T0 + 60_000, Reason::Interval), (T0 + 60_001, Reason::Restore)],
        "nothing had changed, so nothing was written twice",
    );
    assert_eq!(outcome.pre_restore_ts, Some(T0 + 60_000), "the state it left is the snapshot already there");
    assert_eq!(outcome.pre_restore_hash, Some(hash_full(b"two and two\n")));
}

#[test]
fn undo_of_a_restore_is_a_restore_of_the_pre_restore_hash() {
    let mut f = with_unsaved_work();
    let oldest = f.history("a.md").pop().unwrap();
    let outcome = f.restore("a.md", Some(oldest.ts), Some(oldest.hash.clone()));
    assert_eq!(std::fs::read_to_string(f.root.path().join("a.md")).unwrap(), "one\n");

    // The toast's Undo: the same command, pointed at what the restore left.
    let undone = f.restore("a.md", outcome.pre_restore_ts, outcome.pre_restore_hash.clone());
    assert_eq!(
        std::fs::read_to_string(f.root.path().join("a.md")).unwrap(),
        "three, three and three\n",
        "the typing is back",
    );
    assert_eq!(f.rows().last().unwrap().reason, Reason::Restore);
    assert_eq!(f.rows().last().unwrap().restored_from, outcome.pre_restore_ts);
    assert_eq!(undone.pre_restore_hash, Some(hash_full(b"one\n")), "and the undo is itself undoable");
}

#[test]
fn restore_never_removes_a_snapshot() {
    let mut f = with_unsaved_work();
    let before: Vec<u64> = f.rows().iter().map(|r| r.ts).collect();
    let oldest = f.history("a.md").pop().unwrap();
    f.restore("a.md", Some(oldest.ts), Some(oldest.hash.clone()));
    f.restore("a.md", Some(T0 + 60_000), Some(hash_full(b"two and two\n")));

    let after: Vec<u64> = f.rows().iter().map(|r| r.ts).collect();
    for ts in &before {
        assert!(after.contains(ts), "{} went missing — a restore only ever appends", ts);
        assert!(f.store().snapshot_path(*ts).exists(), "and its snapshot file is still there");
    }
    assert!(after.len() > before.len());
    // Every state between the restored version and now is still an older
    // row, not an abandoned branch (docs/versioning-plan.md §12.3).
    let versions = f.history("a.md");
    assert!(versions.iter().any(|v| v.hash == hash_full(b"three, three and three\n")));
    assert!(versions.iter().any(|v| v.hash == hash_full(b"one\n")));
}

#[test]
fn read_through_lists_cloud_only_versions() {
    let mut f = fixture(T0);
    // This Mac was asleep for the first two of these; it only ever captured
    // the last one, and the two before it are in the bucket.
    let older = f.mirrored(T0, "d-book", "Sherin's MacBook", &[("a.md", "one\n")]);
    let middle = f.mirrored(T0 + 60_000, "d-book", "Sherin's MacBook", &[("a.md", "one and two\n")]);
    f.at(T0 + 120_000);
    f.write("a.md", "one, two and three\n");
    f.capture(Reason::Interval);

    let versions = f.history_with("a.md", &[older.clone(), middle.clone()]);
    assert_eq!(versions.len(), 3, "one walk, both stores: {:?}", versions);
    assert_eq!(
        versions.iter().map(|v| (v.ts, v.source.as_str())).collect::<Vec<_>>(),
        vec![(T0 + 120_000, "local"), (T0 + 60_000, "cloud"), (T0, "cloud")],
        "newest first, whichever store holds it"
    );
    assert_eq!(versions[1].by, "Sherin's MacBook", "a mirrored version says which Mac made it");
    assert_eq!(versions[1].reason, "interval", "and why — the other Mac recorded that too");
    assert!(versions[0].current, "the newest is what is on disk");
    assert_eq!(versions[2].hash, hash_full(b"one\n"));

    // A rename another Mac made is followed exactly like one made here.
    let renamed = f.mirrored(T0 - 60_000, "d-book", "Sherin's MacBook", &[("was.md", "one\n")]);
    let followed = f.history_with("a.md", &[renamed, older.clone(), middle.clone()]);
    assert_eq!(followed.len(), 3, "the oldest two hold the same bytes: {:?}", followed);
    assert_eq!(followed[2].ts, T0 - 60_000, "so the version dates from where the content appeared");
    assert_eq!(followed[2].path, "was.md", "under the name it had then");

    // The same snapshot on both sides is one row, not two: a mirrored copy
    // of what this Mac captured is the same moment, seen twice.
    let mine = f.rows().last().unwrap().clone();
    let echo = VersionsEntry {
        id: snapshot_id(mine.ts, "d-test"),
        ts: mine.ts,
        digest: mine.digest.clone(),
        ..Default::default()
    };
    assert_eq!(f.history_with("a.md", &[echo, older, middle]).len(), 3);
}


/* ---------- The workspace, as it was ---------- */

/// A folder with one captured moment and three kinds of drift since:
/// a file edited, a folder deleted, a file made.
fn with_drift() -> Fixture {
    let mut f = fixture(T0);
    f.write("keep.md", "same\n");
    f.write("a.md", "one\n");
    f.write("notes/b.md", "bee\n");
    f.capture(Reason::Seed);
    f.at(T0 + 60_000);
    f.write("a.md", "one changed\n");
    std::fs::remove_dir_all(f.root.path().join("notes")).unwrap();
    f.write("new.md", "made since\n");
    f
}

#[test]
fn snapshot_diff_classifies_changed_added_missing() {
    let f = with_drift();
    let diff = f.versioner.snapshot_diff(T0).expect("diff the seed against now");

    assert_eq!(diff.changed.len(), 1, "{:?}", diff.changed);
    assert_eq!(diff.changed[0].path, "a.md");
    assert_eq!(diff.changed[0].then_hash, hash_full(b"one\n"), "what a restore would write");
    assert_eq!(diff.changed[0].now_hash, hash_full(b"one changed\n"), "what is there now");
    assert_eq!(diff.added, vec!["new.md".to_string()], "on disk now, not then — a restore trashes it");
    assert_eq!(diff.missing, vec!["notes/b.md".to_string()], "then, not now — a restore brings it back");
    assert!(
        !diff.changed.iter().any(|c| c.path == "keep.md")
            && !diff.added.contains(&"keep.md".to_string())
            && !diff.missing.contains(&"keep.md".to_string()),
        "an unchanged file is in none of the three lists"
    );
}

#[test]
fn restore_snapshot_captures_first_then_writes_and_trashes() {
    let mut f = with_drift();
    f.at(T0 + 120_000);
    let report = f.restore_all(T0, None);

    assert_eq!(report.written, 2, "the edited file and the deleted one");
    assert_eq!(report.trashed, 1, "the file that was not there then");
    assert_eq!(report.pre_restore_ts, Some(T0 + 120_000));
    assert_eq!(f.on_disk("a.md").as_deref(), Some("one\n"));
    assert_eq!(f.on_disk("notes/b.md").as_deref(), Some("bee\n"), "the folder came back with it");
    assert!(!f.root.path().join("new.md").exists(), "and what was never there is gone");

    let rows: Vec<(u64, Reason)> = f.rows().iter().map(|r| (r.ts, r.reason)).collect();
    assert_eq!(
        rows,
        vec![(T0, Reason::Seed), (T0 + 120_000, Reason::PreRestore), (T0 + 120_001, Reason::Restore)],
        "the state it left and the state it made are both versions"
    );
    // Undo has everything it needs: the moment before is a snapshot like
    // any other, blobs and all.
    let left = f.store().read_snapshot(T0 + 120_000).unwrap();
    assert_eq!(f.blob(&left.files["a.md"].h), b"one changed\n");
    assert_eq!(f.blob(&left.files["new.md"].h), b"made since\n", "even the file that was trashed");
    let made = f.store().read_snapshot(T0 + 120_001).unwrap();
    assert_eq!(made.restored_from, Some(T0), "and the new state says where it came from");

    let applied = f.events.last(EV_APPLIED).expect("a restore tells the app what to reload");
    let paths: Vec<String> =
        applied["paths"].as_array().unwrap().iter().map(|p| p.as_str().unwrap().to_string()).collect();
    assert_eq!(paths.len(), 3, "everything that moved: {:?}", paths);
    assert!(paths.iter().any(|p| p.ends_with("/new.md")), "the trashed file too");
}

#[test]
fn restore_subset_touches_only_those_paths() {
    let mut f = with_drift();
    f.at(T0 + 120_000);
    let report = f.restore_all(T0, Some(&["a.md".to_string()]));

    assert_eq!((report.written, report.trashed), (1, 0));
    assert_eq!(f.on_disk("a.md").as_deref(), Some("one\n"));
    assert_eq!(f.on_disk("new.md").as_deref(), Some("made since\n"), "an unticked file is untouched");
    assert!(!f.root.path().join("notes/b.md").exists(), "and an unticked deletion stays deleted");
}

#[test]
fn deleted_lists_what_no_longer_exists() {
    let mut f = fixture(T0);
    f.write("a.md", "one\n");
    f.write("notes/b.md", "bee\n");
    f.capture(Reason::Seed);
    f.at(T0 + 60_000);
    f.write("notes/b.md", "bee two\n");
    f.capture(Reason::Interval);
    f.at(T0 + 120_000);
    f.remove("notes/b.md");
    f.write("c.md", "cee\n");
    f.capture(Reason::Closing);

    let gone = f.versioner.deleted().expect("read the deleted files");
    assert_eq!(gone.len(), 1, "only what is in the history and not on disk: {:?}", gone);
    assert_eq!(gone[0].path, "notes/b.md");
    assert_eq!(gone[0].last_seen_ms, T0 + 60_000, "the newest snapshot that still had it");
    assert_eq!(gone[0].hash, hash_full(b"bee two\n"), "with the content it had then");
    assert_eq!(gone[0].size, 8);

    // And it comes back to the path it had, with its history intact.
    f.restore("notes/b.md", Some(T0 + 60_000), Some(gone[0].hash.clone()));
    assert_eq!(f.on_disk("notes/b.md").as_deref(), Some("bee two\n"));
    assert!(f.versioner.deleted().unwrap().is_empty(), "and the row is gone");
    // Its history came back with it: the walk steps over the moments the
    // file was missing from, because the snapshot that brought it back says
    // where the content came from.
    let versions = f.history("notes/b.md");
    assert_eq!(
        versions.iter().map(|v| (v.ts, v.hash.clone())).collect::<Vec<_>>(),
        vec![(T0 + 60_000, hash_full(b"bee two\n")), (T0, hash_full(b"bee\n"))],
        "both moments, not just the restore"
    );
}

#[test]
fn restore_file_recreates_directories() {
    let mut f = fixture(T0);
    f.write("notes/deep/b.md", "bee\n");
    f.capture(Reason::Seed);
    f.at(T0 + 60_000);
    std::fs::remove_dir_all(f.root.path().join("notes")).unwrap();

    let gone = f.versioner.deleted().expect("read the deleted files");
    assert_eq!(gone.len(), 1);
    f.restore("notes/deep/b.md", Some(T0), Some(gone[0].hash.clone()));
    assert_eq!(f.on_disk("notes/deep/b.md").as_deref(), Some("bee\n"), "both folders came back");
}

/* ---------- Settings, the stores, and the copy you keep ---------- */

/// The names inside an archive, and their bytes.
fn archive_entries(path: &Path) -> BTreeMap<String, Vec<u8>> {
    use std::io::Read as _;
    let file = std::fs::File::open(path).expect("open the archive");
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
    let mut out = BTreeMap::new();
    for entry in archive.entries().expect("read the archive") {
        let mut entry = entry.expect("an entry");
        let name = entry.path().expect("a path").to_string_lossy().to_string();
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).expect("the entry's bytes");
        out.insert(name, bytes);
    }
    out
}

#[test]
fn horizon_change_is_applied_on_the_next_sweep() {
    // A store keeping forever, with three months between its snapshots. Each
    // edit changes the file's LENGTH: two writes in one mtime millisecond
    // are invisible to the stat cache when the size is also unchanged, and
    // this test is not the place to discover that.
    let mut f = fixture_with(T0, Settings { horizon_days: None, ..Default::default() });
    let day = 24 * 3_600_000u64;
    f.write("a.md", "one\n");
    f.capture(Reason::Seed);
    f.at(T0 + 100 * day);
    f.write("a.md", "one, then two\n");
    f.capture(Reason::Interval);
    f.at(T0 + 200 * day);
    f.write("a.md", "one, then two, then three\n");
    f.capture(Reason::Interval);

    f.versioner.sweep(true);
    assert_eq!(
        f.rows().iter().map(|r| r.ts).collect::<Vec<_>>(),
        vec![T0, T0 + 100 * day, T0 + 200 * day],
        "forever keeps one a month, and these are months apart"
    );

    f.versioner.set_horizon(Some(30)).expect("set the horizon");
    assert_eq!(
        f.rows().iter().map(|r| r.ts).collect::<Vec<_>>(),
        vec![T0 + 200 * day],
        "everything past thirty days goes, except the newest state"
    );

    // The answer is the store's, not the app's: a versioner built from
    // settings that still say forever reads thirty days off the index.
    let index = f.store().read_index();
    assert_eq!(index.horizon_days, Some(Some(30)), "and it is written down");
    let reopened = Versioner::new(
        Store::open(f.data.path(), "r-test", f.root.path()),
        "Test Mac".to_string(),
        &Settings { horizon_days: None, ..Default::default() },
        Arc::new(Mutex::new(Default::default())),
        f.events.clone(),
        Clock(Arc::new(|| T0)),
    );
    assert_eq!(reopened.horizon(), Some(30), "the store's own horizon outlives the session");
    assert_eq!(reopened.status().horizon_days, Some(30), "and that is what the surface reads");
}

#[test]
fn forget_refuses_an_open_root() {
    let mut f = fixture(T0);
    f.write("a.md", "one\n");
    f.capture(Reason::Seed);

    // A second store, for a folder that is about to stop existing.
    let orphan_root = TempDir::new().unwrap();
    let orphan = Store::open(f.data.path(), "r-gone", orphan_root.path());
    orphan
        .write_index(&Index {
            version: STORE_VERSION,
            root: orphan_root.path().to_string_lossy().to_string(),
            ..Default::default()
        })
        .unwrap();

    let listed = stores::list(f.data.path());
    assert_eq!(listed.len(), 2, "both stores, whatever is open: {:?}", listed);
    let here = listed.iter().find(|s| s.key == "r-test").expect("this Mac's store");
    assert!(here.exists, "its folder is right there");
    assert_eq!(here.snapshots, 1);
    assert_eq!(here.newest_ms, Some(T0));
    assert!(here.bytes > 0, "the index, the snapshot and the blob all count");

    drop(orphan_root);
    let listed = stores::list(f.data.path());
    assert!(!listed.iter().find(|s| s.key == "r-gone").expect("the orphan").exists, "its folder has gone");

    // The open one is refused; the orphan goes, and nothing else with it.
    let open: BTreeSet<String> = ["r-test".to_string()].into_iter().collect();
    let refused = stores::forget(f.data.path(), "r-test", &open).expect_err("an open root is refused");
    assert!(refused.contains("close its window"), "and says what to do about it: {}", refused);
    assert!(f.store().index_path().exists(), "nothing was touched");
    assert!(stores::forget(f.data.path(), "..", &open).is_err(), "and a key that isn't one never joins a path");

    stores::forget(f.data.path(), "r-gone", &open).expect("forget the orphan");
    assert_eq!(
        stores::list(f.data.path()).iter().map(|s| s.key.clone()).collect::<Vec<_>>(),
        vec!["r-test".to_string()],
        "one store left, and it is the open one"
    );
    assert!(f.on_disk("a.md").is_some(), "and the folder itself was never in question");
}

#[test]
fn export_holds_the_tree_and_the_store() {
    let mut f = fixture(T0);
    f.write("a.md", "one\n");
    f.write("notes/b.md", "bee\n");
    f.capture(Reason::Seed);
    f.at(T0 + 60_000);
    f.write("a.md", "one\ntwo\n");
    f.capture(Reason::Interval);

    let dest = TempDir::new().unwrap();
    let ticks: Arc<Mutex<Vec<(u64, u64)>>> = Arc::new(Mutex::new(Vec::new()));
    let heard = ticks.clone();
    let (path, report) = stores::export(f.root.path(), f.store(), dest.path(), "2026-09-05", &move |done, total| {
        heard.lock().unwrap().push((done, total));
    })
    .expect("export");

    let name = path.file_name().unwrap().to_string_lossy().to_string();
    assert!(name.ends_with(" — 2026-09-05.doklin-backup.tar.gz"), "named for the folder and the day: {}", name);

    let held = archive_entries(&path);
    assert_eq!(held.get("workspace/a.md").map(|b| b.as_slice()), Some(b"one\ntwo\n".as_slice()), "the tree as it is now");
    assert_eq!(held.get("workspace/notes/b.md").map(|b| b.as_slice()), Some(b"bee\n".as_slice()), "subfolders and all");
    assert!(held.contains_key("versions/index.json"), "and the store verbatim");
    assert_eq!(
        held.keys().filter(|n| n.starts_with("versions/snapshots/")).count(),
        2,
        "every snapshot file, not just the newest"
    );
    // Three versions of two files: "one\n", "one\ntwo\n" and "bee\n".
    assert_eq!(held.keys().filter(|n| n.starts_with("versions/blobs/")).count(), 3, "and every blob they name");

    assert_eq!(report.files as usize, held.len(), "the count is what went in");
    assert_eq!(report.bytes, std::fs::metadata(&path).unwrap().len(), "and the bytes are the file's");
    assert_eq!(
        ticks.lock().unwrap().last().copied(),
        Some((held.len() as u64, held.len() as u64)),
        "the progress event ends where it said it would"
    );
}
