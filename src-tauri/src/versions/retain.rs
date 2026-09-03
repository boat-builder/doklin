//! Retention (docs/versioning.md §6.2): the thinning ladder, and the sweep
//! that applies it. The ladder is the only reason a snapshot or a blob is
//! ever deleted — no other code path in the app removes anything from a
//! store.
//!
//! The ladder, by a snapshot's age: under an hour every one; under a day
//! the last in each UTC hour; under 30 days the last in each UTC day; under
//! a year the last in each ISO week; beyond that the last in each UTC
//! month. The newest snapshot and any pinned one always survive; anything
//! past the horizon goes.

use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Datelike, Timelike, Utc};

use super::store::{SnapshotRow, Store};

pub const HOUR_MS: u64 = 60 * 60 * 1000;
pub const DAY_MS: u64 = 24 * HOUR_MS;
/// The bands of the ladder, by age.
pub const ALL_WITHIN: u64 = HOUR_MS;
pub const HOURLY_WITHIN: u64 = DAY_MS;
pub const DAILY_WITHIN: u64 = 30 * DAY_MS;
pub const WEEKLY_WITHIN: u64 = 365 * DAY_MS;

/// A blob younger than this is never collected, whatever references it — so
/// a capture in flight can't have its bytes swept out from under it.
pub const GC_GRACE: Duration = Duration::from_secs(60 * 60);
/// How often a running versioner sweeps.
pub const SWEEP_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// Which bucket a snapshot falls in at a given age. `None` means "keep every
/// one" — the first hour.
fn bucket(ts: u64, age_ms: u64) -> Option<(u8, i32, u32, u32)> {
    let dt: DateTime<Utc> = DateTime::from_timestamp_millis(ts as i64).unwrap_or_else(|| DateTime::UNIX_EPOCH);
    if age_ms < ALL_WITHIN {
        None
    } else if age_ms < HOURLY_WITHIN {
        Some((1, dt.year(), dt.ordinal(), dt.hour()))
    } else if age_ms < DAILY_WITHIN {
        Some((2, dt.year(), dt.ordinal(), 0))
    } else if age_ms < WEEKLY_WITHIN {
        let week = dt.iso_week();
        Some((3, week.year(), week.week(), 0))
    } else {
        Some((4, dt.year(), dt.month(), 0))
    }
}

/// Which of `rows` survive at `now_ms`, given a horizon in days (None =
/// forever). Pure, deterministic and idempotent: `retain(retain(x))` is
/// `retain(x)`.
pub fn retain(rows: &[SnapshotRow], now_ms: u64, horizon_days: Option<u32>) -> BTreeSet<u64> {
    let mut keep = BTreeSet::new();
    let Some(newest) = rows.iter().map(|r| r.ts).max() else { return keep };
    // The newest state of the workspace is never a candidate for thinning:
    // it is the one a restore compares against.
    keep.insert(newest);

    let mut buckets: BTreeMap<(u8, i32, u32, u32), u64> = BTreeMap::new();
    for row in rows {
        if row.pinned {
            keep.insert(row.ts);
            continue;
        }
        let age = now_ms.saturating_sub(row.ts);
        if let Some(days) = horizon_days {
            if age > days as u64 * DAY_MS {
                continue;
            }
        }
        match bucket(row.ts, age) {
            None => {
                keep.insert(row.ts);
            }
            Some(key) => {
                let latest = buckets.entry(key).or_insert(0);
                if row.ts > *latest {
                    *latest = row.ts;
                }
            }
        }
    }
    keep.extend(buckets.values().copied());
    keep
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SweepReport {
    pub snapshots_dropped: usize,
    pub blobs_dropped: usize,
    pub bytes_freed: u64,
}

/// Apply the ladder to a store: rewrite the index, delete the snapshot files
/// it no longer names (orphans included), then delete every blob no retained
/// snapshot references and that is older than `GC_GRACE`.
///
/// The order is what makes a crash harmless: the index is the authority, and
/// it is written first and atomically.
pub fn sweep(store: &Store, index: &mut super::store::Index, now_ms: u64, horizon_days: Option<u32>) -> SweepReport {
    let mut report = SweepReport::default();
    let keep = retain(&index.snapshots, now_ms, horizon_days);
    // What the index named on the way in: a file it named and the ladder
    // dropped goes now, while a file it never named is an orphan from an
    // interrupted capture and gets the same grace a blob does.
    let named: BTreeSet<u64> = index.snapshots.iter().map(|r| r.ts).collect();

    report.snapshots_dropped = index.snapshots.iter().filter(|r| !keep.contains(&r.ts)).count();
    index.snapshots.retain(|r| keep.contains(&r.ts));
    index.last_sweep_ms = now_ms;
    let _ = store.write_index(index);

    let grace_before = SystemTime::now().checked_sub(GC_GRACE).unwrap_or(UNIX_EPOCH);
    let old_enough = |path: &std::path::Path| {
        std::fs::metadata(path).and_then(|m| m.modified()).map(|t| t < grace_before).unwrap_or(true)
    };

    for (ts, path) in store.snapshot_files() {
        if keep.contains(&ts) {
            continue;
        }
        if !named.contains(&ts) && !old_enough(&path) {
            continue;
        }
        report.bytes_freed += std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let _ = std::fs::remove_file(&path);
    }

    let mut referenced: BTreeSet<String> = BTreeSet::new();
    for ts in &keep {
        if let Some(snap) = store.read_snapshot(*ts) {
            referenced.extend(snap.files.into_values().map(|f| f.h));
        }
    }
    for (hash, path) in store.blob_files() {
        if !hash.is_empty() && referenced.contains(&hash) {
            continue;
        }
        if !old_enough(&path) {
            continue;
        }
        report.blobs_dropped += 1;
        report.bytes_freed += std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let _ = std::fs::remove_file(&path);
    }
    report
}
