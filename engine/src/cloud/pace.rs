//! What this device spends of the domain's requests, and when big work waits.
//!
//! The domain's worker runs on a Cloudflare account whose requests are
//! counted for the whole account and, on the free plan, capped per UTC day:
//! past the cap every request — every device's sync, every agent, every
//! public page — gets Cloudflare's error page until midnight UTC. A request
//! the worker refuses has already been counted, so the only thing that
//! protects the budget is a client that does not send. This is that client's
//! half.
//!
//! Two lanes. The *express* lane is what a person is waiting on: polls,
//! manifest reads and writes, and a cycle's transfers while there are no more
//! than `EXPRESS` of them. It never waits. The *bulk* lane is everything
//! past that — a folder of a thousand new documents, a colleague's big push
//! arriving, the version mirror, blob collection — and it draws on a token
//! bucket that refills at the plan's `bulkPerSecond`, so a big job goes out
//! at a pace instead of in a burst.
//!
//! Three modes, from what this device and everyone together spent today
//! (the numbers are the worker's, per plan — `cloud-worker/src/limits.ts`;
//! this file has none of its own):
//!   normal      both lanes run;
//!   bulk-waits  this device passed its allowance, or everyone together
//!               passed the first threshold: the bulk lane waits for 00:00
//!               UTC. Its own allowance its person may lift for the day;
//!   slow        this device passed its ceiling, or everyone passed the
//!               second threshold: no bulk, a poll a minute, a cycle a
//!               minute. Edits still go out.
//!
//! Every request this device sends to the domain is counted in one place
//! (`HttpRemote::auth` calls `Usage::count`), per UTC day, persisted beside
//! the workspace's sync state so a restart does not start the day again.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::time::Instant;

use super::scan::{now_ms, read_json, write_json};

/* ---------- Engine mechanics (not budgets: the worker's numbers are) ---------- */

/// A cycle with no more transfers than this is express: it goes at once.
pub(crate) const EXPRESS: usize = 50;
/// A bulk batch: at most this many files, and about this many bytes.
pub(crate) const BATCH_FILES: usize = 100;
pub(crate) const BATCH_BYTES: u64 = 8 * 1024 * 1024;
/// How many bulk requests can go out at once after a quiet spell.
const BUCKET: f64 = 200.0;
/// The fewest tokens a bulk batch waits for, unless less is left to send:
/// a batch of one every quarter second would cost a manifest write each.
pub(crate) const MIN_BATCH: usize = 25;
/// How often a request carries this device's count (`x-doklin-used`).
const REPORT_EVERY_MS: u64 = 15 * 60 * 1000;
const DAY_MS: u64 = 86_400_000;

/* ---------- The worker's numbers ---------- */

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Plan {
    #[default]
    Free,
    Paid,
}

/// The limits of the domain's plan, as `/api/meta` and every poll answer
/// carry them (`cloud-worker/src/limits.ts` — change both). `None` is "no
/// such limit" (Workers Paid).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub plan: Plan,
    /// The account's daily requests.
    #[serde(default)]
    pub cap: Option<u64>,
    pub bulk_per_second: f64,
    /// Past this many requests today — all of this device's, not only bulk
    /// ones — its bulk lane waits.
    #[serde(default)]
    pub device_bulk: Option<u64>,
    /// Past this many, it goes slow.
    pub device_ceiling: u64,
    #[serde(default)]
    pub fleet_bulk_waits: Option<u64>,
    #[serde(default)]
    pub fleet_slow: Option<u64>,
    /// The CLI's own allowance; the engine only passes it on.
    #[serde(default)]
    pub cli_daily: u64,
    /// The many-new-documents valve: this many in one pass is asked about.
    pub many_new: u64,
    /// Everyone's reported requests today; `None` when the database could
    /// not say.
    #[serde(default)]
    pub fleet_today: Option<u64>,
}

/* ---------- The counter ---------- */

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Day {
    /// Days since the epoch, UTC.
    day: u64,
    requests: u64,
    /// When a request last carried the count.
    reported_at: u64,
    /// The UTC day this device's person lifted its bulk wait for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    lifted: Option<u64>,
}

#[derive(Default)]
struct Counter {
    now: Day,
    path: Option<PathBuf>,
    dirty: bool,
}

/// This device's requests today on one domain. Cloned into every remote of
/// the workspace — its sections count together.
#[derive(Clone, Default)]
pub struct Usage(Arc<Mutex<Counter>>);

pub(crate) fn today() -> u64 {
    now_ms() / DAY_MS
}

/// The next 00:00 UTC, in epoch ms.
pub(crate) fn next_midnight_ms() -> u64 {
    (today() + 1) * DAY_MS
}

impl Usage {
    /// The count kept in `dir` (`usage.json`), or a fresh one.
    pub fn at(dir: &Path) -> Usage {
        let path = dir.join("usage.json");
        let now: Day = read_json(&path).unwrap_or_default();
        Usage(Arc::new(Mutex::new(Counter { now, path: Some(path), dirty: false })))
    }

    fn with<T>(&self, f: impl FnOnce(&mut Counter) -> T) -> T {
        let mut counter = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let day = today();
        if counter.now.day != day {
            counter.now = Day { day, ..Default::default() };
            counter.dirty = true;
        }
        f(&mut counter)
    }

    /// One more request. Answers the count to report when a report is due —
    /// what the request carries as `x-doklin-used`. A counter nobody keeps (a
    /// remote made for one command) never reports: it shares the engine's
    /// token, and the domain keeps one count per token — the engine's.
    pub fn count(&self) -> Option<u64> {
        self.with(|c| {
            c.now.requests += 1;
            c.dirty = true;
            let at = now_ms();
            if c.path.is_some() && at.saturating_sub(c.now.reported_at) >= REPORT_EVERY_MS {
                c.now.reported_at = at;
                return Some(c.now.requests);
            }
            None
        })
    }

    pub fn today(&self) -> u64 {
        self.with(|c| c.now.requests)
    }

    fn lifted(&self) -> bool {
        self.with(|c| c.now.lifted == Some(c.now.day))
    }

    fn lift(&self) {
        self.with(|c| {
            c.now.lifted = Some(c.now.day);
            c.dirty = true;
        })
    }

    /// Write the count down, when it moved.
    pub fn save(&self) {
        self.with(|c| {
            if let (true, Some(path)) = (c.dirty, &c.path) {
                if write_json(path, &c.now).is_ok() {
                    c.dirty = false;
                }
            }
        })
    }
}

/* ---------- The pacer ---------- */

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    Normal,
    BulkWaits,
    Slow,
}

/// Whose spending put the mode where it is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Cause {
    Device,
    Fleet,
}

/// One per workspace: every unit's bulk work draws on it.
pub(crate) struct Pacer {
    pub usage: Usage,
    limits: Option<Limits>,
    /// The UTC day `limits.fleet_today` was read on: yesterday's sum says
    /// nothing about today.
    fleet_day: u64,
    tokens: f64,
    refilled: Instant,
}

impl Pacer {
    pub(crate) fn new(usage: Usage) -> Self {
        Pacer { usage, limits: None, fleet_day: 0, tokens: BUCKET, refilled: Instant::now() }
    }

    pub(crate) fn set_limits(&mut self, limits: Limits) {
        self.fleet_day = today();
        self.limits = Some(limits);
    }

    pub(crate) fn limits(&self) -> Option<&Limits> {
        self.limits.as_ref()
    }

    pub(crate) fn fleet_today(&self) -> Option<u64> {
        self.limits.as_ref().and_then(|l| l.fleet_today).filter(|_| self.fleet_day == today())
    }

    /// Where today's spending puts this device.
    pub(crate) fn mode(&self) -> (Mode, Option<Cause>) {
        let Some(limits) = &self.limits else { return (Mode::Normal, None) };
        let mine = self.usage.today();
        let fleet = self.fleet_today().unwrap_or(0);
        let past = |n: Option<u64>, by: u64| n.is_some_and(|n| by >= n);
        if mine >= limits.device_ceiling {
            return (Mode::Slow, Some(Cause::Device));
        }
        if past(limits.fleet_slow, fleet) {
            return (Mode::Slow, Some(Cause::Fleet));
        }
        if past(limits.fleet_bulk_waits, fleet) {
            return (Mode::BulkWaits, Some(Cause::Fleet));
        }
        if past(limits.device_bulk, mine) && !self.usage.lifted() {
            return (Mode::BulkWaits, Some(Cause::Device));
        }
        (Mode::Normal, None)
    }

    pub(crate) fn bulk_open(&self) -> bool {
        self.mode().0 == Mode::Normal
    }

    /// Whether this device's person may lift the wait: it is their own
    /// allowance holding it, and they have not lifted it today.
    pub(crate) fn liftable(&self) -> bool {
        self.mode() == (Mode::BulkWaits, Some(Cause::Device))
    }

    pub(crate) fn lifted(&self) -> bool {
        self.usage.lifted()
    }

    /// Lift this device's bulk wait until 00:00 UTC. Never the ceiling, and
    /// never everyone's: those protect the others.
    pub(crate) fn lift(&mut self) {
        self.usage.lift();
        self.usage.save();
    }

    fn rate(&self) -> f64 {
        self.limits.as_ref().map(|l| l.bulk_per_second).filter(|r| *r > 0.0).unwrap_or(1.0)
    }

    fn refill(&mut self) {
        let now = Instant::now();
        let gained = now.saturating_duration_since(self.refilled).as_secs_f64() * self.rate();
        self.tokens = (self.tokens + gained).min(BUCKET);
        self.refilled = now;
    }

    /// Up to `want` bulk requests, now: as many as the bucket holds, none
    /// while the bulk lane waits, and none while it holds fewer than a
    /// batch's worth (`MIN_BATCH`, or `want` when that is less).
    pub(crate) fn take(&mut self, want: usize) -> usize {
        if want == 0 || !self.bulk_open() {
            return 0;
        }
        self.refill();
        let have = self.tokens.floor() as usize;
        if have < want.min(MIN_BATCH) {
            return 0;
        }
        let got = have.min(want);
        self.tokens -= got as f64;
        got
    }

    /// Tokens taken and not spent.
    pub(crate) fn give_back(&mut self, n: usize) {
        self.tokens = (self.tokens + n as f64).min(BUCKET);
    }

    /// How long until `take(want)` would answer something.
    pub(crate) fn wait_for(&mut self, want: usize) -> Duration {
        self.refill();
        let need = want.clamp(1, MIN_BATCH) as f64 - self.tokens;
        if need <= 0.0 {
            return Duration::ZERO;
        }
        Duration::from_secs_f64(need / self.rate())
    }
}
