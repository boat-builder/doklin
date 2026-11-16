//! The usage file: how many requests this machine has sent each domain
//! today, and the allowance that domain set for it.
//!
//! `~/.config/doklin/usage.json`, beside the credentials and kept the same
//! way: `{"<domain>": {day, requests, reportedAt, limits}}`. Every request is
//! counted here before it goes — a refused one has reached Cloudflare all
//! the same — by UTC day, as the worker counts, so the count starts again at
//! 00:00 UTC. The allowance is the domain's own number (`limits.cliDaily`,
//! from `GET /api/agent/me` and `login`): this program has none of its own,
//! and until a domain has said one, none applies.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::creds::{config_dir, write_private};
use crate::text::{midnight_utc, now_ms, number, DAY_MS};
use crate::Failure;

const FILE: &str = "usage.json";

/// How often a request carries `x-doklin-used`: the fleet's sum on the
/// worker is only as fresh as this.
const REPORT_EVERY_MS: u64 = 15 * 60 * 1000;

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// The UTC day `requests` counts.
    #[serde(default)]
    pub day: u64,
    #[serde(default)]
    pub requests: u64,
    /// When `x-doklin-used` last went out (epoch ms); 0 = not yet today.
    #[serde(default)]
    pub reported_at: u64,
    /// The domain's last `limits`, as it sent them.
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub limits: Value,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Usage(BTreeMap<String, Entry>);

impl Usage {
    /// `domain`'s entry for the day `now` is in, begun afresh when the day
    /// it counted is over. The limits outlast the day.
    fn today(&mut self, domain: &str, now: u64) -> &mut Entry {
        let day = now / DAY_MS;
        let entry = self.0.entry(domain.to_string()).or_default();
        if entry.day != day {
            *entry = Entry { day, limits: std::mem::take(&mut entry.limits), ..Entry::default() };
        }
        entry
    }

    /// One more request to `domain`, at `now`. Refused — exit 8, and nothing
    /// is sent — once today's allowance is spent; else counted. `Some(n)`
    /// when this request carries `x-doklin-used: n`: one that `reports`, at
    /// most every 15 minutes.
    pub fn spend(&mut self, domain: &str, now: u64, reports: bool) -> Result<Option<u64>, Failure> {
        let entry = self.today(domain, now);
        if let Some(allowance) = entry.limits.get("cliDaily").and_then(Value::as_u64) {
            if entry.requests >= allowance {
                return Err(Failure::limited(format!(
                    "this machine has sent its {} requests to {} for today — it can send again at {}",
                    number(allowance),
                    domain,
                    midnight_utc(now)
                )));
            }
        }
        entry.requests += 1;
        // A clock set back is a report owed, not a wait of hours.
        if reports && (now < entry.reported_at || now - entry.reported_at >= REPORT_EVERY_MS) {
            entry.reported_at = now;
            return Ok(Some(entry.requests));
        }
        Ok(None)
    }

    /// Keep the `limits` `domain` answered with; anything else keeps the last.
    pub fn remember(&mut self, domain: &str, limits: &Value) {
        if limits.is_object() {
            self.0.entry(domain.to_string()).or_default().limits = limits.clone();
        }
    }
}

/// The file in `dir`. One that is missing or does not parse is a count
/// begun afresh: what it held was a number, not a login.
pub fn load(dir: &Path) -> Usage {
    std::fs::read(dir.join(FILE)).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

pub fn save(dir: &Path, usage: &Usage) -> Result<(), Failure> {
    write_private(dir, FILE, &serde_json::to_vec_pretty(usage).unwrap_or_default())
}

/// Count one request to `domain` in the usage file (`Usage::spend`).
pub fn count(domain: &str, reports: bool) -> Result<Option<u64>, Failure> {
    let dir = config_dir()?;
    let mut usage = load(&dir);
    let report = usage.spend(domain, now_ms(), reports)?;
    save(&dir, &usage)?;
    Ok(report)
}

/// Keep the `limits` in a domain's answer, for the next request's allowance.
pub fn keep_limits(domain: &str, limits: &Value) -> Result<(), Failure> {
    if !limits.is_object() {
        return Ok(());
    }
    let dir = config_dir()?;
    let mut usage = load(&dir);
    usage.remember(domain, limits);
    save(&dir, &usage)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::os::unix::fs::PermissionsExt;

    /// 2025-11-16 00:00 UTC.
    const MIDNIGHT: u64 = 1_763_251_200_000;
    const MIN: u64 = 60 * 1000;
    const DOMAIN: &str = "notes.example.com";

    fn with_allowance(n: u64) -> Usage {
        let mut usage = Usage::default();
        usage.remember(DOMAIN, &json!({ "plan": "free", "cliDaily": n, "cap": 100_000 }));
        usage
    }

    fn entry<'a>(usage: &'a Usage, domain: &str) -> &'a Entry {
        usage.0.get(domain).expect("an entry")
    }

    #[test]
    fn every_request_counts_and_none_goes_past_the_allowance() {
        let mut usage = with_allowance(3);
        let now = MIDNIGHT + 9 * 60 * MIN;
        for _ in 0..3 {
            usage.spend(DOMAIN, now, false).expect("inside the allowance");
        }
        let refused = usage.spend(DOMAIN, now, true).expect_err("past the allowance");
        assert_eq!(refused.exit, 8);
        assert!(refused.message.starts_with("this machine has sent its 3 requests to notes.example.com for today — it can send again at "));
        assert!(refused.message.ends_with("00:00 UTC") || refused.message.ends_with("(00:00 UTC)"), "{}", refused.message);
        // A refused request is not sent, so it is not counted — and not reported.
        assert_eq!(entry(&usage, DOMAIN).requests, 3);
        assert_eq!(entry(&usage, DOMAIN).reported_at, 0);
    }

    #[test]
    fn no_allowance_until_the_domain_has_said_one() {
        let mut usage = Usage::default();
        for _ in 0..20_000 {
            usage.spend(DOMAIN, MIDNIGHT, false).expect("no allowance is known");
        }
        assert_eq!(entry(&usage, DOMAIN).requests, 20_000);
        // An answer without limits (an older worker) keeps what was known.
        let mut usage = with_allowance(2);
        usage.remember(DOMAIN, &Value::Null);
        usage.spend(DOMAIN, MIDNIGHT, false).unwrap();
        usage.spend(DOMAIN, MIDNIGHT, false).unwrap();
        assert_eq!(usage.spend(DOMAIN, MIDNIGHT, false).unwrap_err().exit, 8);
    }

    #[test]
    fn a_new_utc_day_starts_the_count_again_and_keeps_the_limits() {
        let mut usage = with_allowance(2);
        let late = MIDNIGHT + DAY_MS - 1; // 23:59:59.999 UTC
        usage.spend(DOMAIN, late, true).unwrap();
        usage.spend(DOMAIN, late, false).unwrap();
        assert_eq!(usage.spend(DOMAIN, late, false).unwrap_err().exit, 8);

        let next = MIDNIGHT + DAY_MS; // 00:00:00.000 UTC
        assert_eq!(usage.spend(DOMAIN, next, true).unwrap(), Some(1), "the first request of a day reports");
        let today = entry(&usage, DOMAIN);
        assert_eq!((today.day, today.requests), (next / DAY_MS, 1));
        assert_eq!(today.limits["cliDaily"], 2);
    }

    #[test]
    fn domains_are_counted_apart() {
        let mut usage = with_allowance(1);
        usage.spend(DOMAIN, MIDNIGHT, false).unwrap();
        assert_eq!(usage.spend(DOMAIN, MIDNIGHT, false).unwrap_err().exit, 8);
        usage.spend("other.example.com", MIDNIGHT, false).expect("another domain has its own count");
        assert_eq!(entry(&usage, "other.example.com").requests, 1);
    }

    #[test]
    fn the_count_is_reported_at_most_every_fifteen_minutes() {
        let mut usage = Usage::default();
        let t = MIDNIGHT + 10 * 60 * MIN;
        // A request that does not report (a login's) never moves the clock.
        assert_eq!(usage.spend(DOMAIN, t, false).unwrap(), None);
        assert_eq!(entry(&usage, DOMAIN).reported_at, 0);
        assert_eq!(usage.spend(DOMAIN, t, true).unwrap(), Some(2), "the first report says every request so far");
        assert_eq!(usage.spend(DOMAIN, t + MIN, true).unwrap(), None);
        assert_eq!(usage.spend(DOMAIN, t + 15 * MIN - 1, true).unwrap(), None);
        assert_eq!(usage.spend(DOMAIN, t + 15 * MIN, true).unwrap(), Some(5));
        assert_eq!(usage.spend(DOMAIN, t + 16 * MIN, true).unwrap(), None);
        // A clock set back reports at once rather than waiting for the old time.
        assert_eq!(usage.spend(DOMAIN, t, true).unwrap(), Some(7));
        // Each domain keeps its own clock.
        assert_eq!(usage.spend("other.example.com", t + 16 * MIN, true).unwrap(), Some(1));
    }

    #[test]
    fn the_file_is_private_and_reads_back_as_written() {
        let dir = std::env::temp_dir().join(format!("doklin-usage-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(load(&dir).0.len(), 0, "no file is a count begun afresh");

        let mut usage = with_allowance(5_000);
        usage.spend(DOMAIN, MIDNIGHT + MIN, true).unwrap();
        save(&dir, &usage).unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir.join(FILE)), 0o600);
        assert_eq!(mode(&dir), 0o700);

        let on_disk: Value = serde_json::from_slice(&std::fs::read(dir.join(FILE)).unwrap()).unwrap();
        assert_eq!(on_disk[DOMAIN]["day"], MIDNIGHT / DAY_MS);
        assert_eq!(on_disk[DOMAIN]["requests"], 1);
        assert_eq!(on_disk[DOMAIN]["reportedAt"], MIDNIGHT + MIN);
        assert_eq!(on_disk[DOMAIN]["limits"]["cliDaily"], 5_000);
        assert_eq!(entry(&load(&dir), DOMAIN).requests, 1);

        std::fs::write(dir.join(FILE), b"{ not json").unwrap();
        assert_eq!(load(&dir).0.len(), 0, "a file that does not parse is a count begun afresh");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
