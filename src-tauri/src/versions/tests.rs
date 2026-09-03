//! What the versioner promises, tested without the app around it: the
//! cadence rule's consequences (pure, on a simulated clock), the ladder and
//! the sweep, the store's round trip, and the two states — disabled, too
//! large — where capture deliberately does nothing.

use std::collections::BTreeMap;
use std::fs::FileTimes;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration as StdDuration, SystemTime};

use tempfile::TempDir;
use tokio::time::{Duration, Instant};

use crate::cloud::scan::MAX_SYNC_ENTRIES;
use crate::cloud::status::Events;

use super::capture::{capture, Cadence, Captured, CAPTURE_MIN_INTERVAL, SESSION_IDLE};
use super::retain::{retain, sweep, GC_GRACE};
use super::settings::Settings;
use super::status::Phase;
use super::store::{gunzip, Index, Reason, SnapshotRow, Store};
use super::{Clock, VersionBus, Versioner, VersionerCmd};

/* ---------- The fixture ---------- */

struct Silent;

impl Events for Silent {
    fn emit_json(&self, _event: &str, _payload: serde_json::Value) {}
}

struct Fixture {
    root: TempDir,
    data: TempDir,
    clock: Arc<AtomicU64>,
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
    let versioner = Versioner::new(
        Store::open(data.path(), "r-test", root.path()),
        "Test Mac".to_string(),
        &settings,
        Arc::new(Mutex::new(Default::default())),
        Arc::new(Silent),
        Clock(Arc::new(move || ticker.load(Ordering::SeqCst))),
    );
    Fixture { root, data, clock, versioner }
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

    fn blob(&self, hash: &str) -> Vec<u8> {
        gunzip(&std::fs::read(self.store().blob_path(hash)).unwrap()).unwrap()
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
