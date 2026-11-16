//! The words this program prints for a person: sizes, times, lists. JSON
//! output never passes through here — it is the worker's answer as it came.

use std::time::{SystemTime, UNIX_EPOCH};

/// A UTC day in milliseconds: day `n` is `floor(ms / DAY_MS)`, the worker's reckoning.
pub const DAY_MS: u64 = 86_400_000;

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// `5,000`.
pub fn number(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, d) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(d);
    }
    out
}

/// When the UTC day after `ms` begins, on this machine's clock:
/// `05:30 (00:00 UTC)` — or `00:00 UTC` where the two are the same.
pub fn midnight_utc(ms: u64) -> String {
    match local_clock((ms / DAY_MS + 1) * DAY_MS) {
        Some(clock) if clock != "00:00" => format!("{} (00:00 UTC)", clock),
        _ => "00:00 UTC".to_string(),
    }
}

/// `05:30`: the wall clock here at `ms`, in the system's time zone.
fn local_clock(ms: u64) -> Option<String> {
    let secs = libc::time_t::try_from(ms / 1000).ok()?;
    // SAFETY: `tm` is plain data that localtime_r fills in, and both
    // pointers outlive the call.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    let filled = unsafe { libc::localtime_r(&secs, &mut tm) };
    (!filled.is_null()).then(|| format!("{:02}:{:02}", tm.tm_hour, tm.tm_min))
}

pub fn size(bytes: u64) -> String {
    match bytes {
        b if b < 1024 => format!("{} B", b),
        b if b < 1024 * 1024 => format!("{:.1} KB", b as f64 / 1024.0),
        b => format!("{:.1} MB", b as f64 / (1024.0 * 1024.0)),
    }
}

/// "3 min ago", "2 d ago" — how long since `ms`.
pub fn ago(ms: u64) -> String {
    let secs = now_ms().saturating_sub(ms) / 1000;
    match secs {
        s if s < 60 => "just now".to_string(),
        s if s < 3600 => format!("{} min ago", s / 60),
        s if s < 86_400 => format!("{} h ago", s / 3600),
        s if s < 86_400 * 60 => format!("{} d ago", s / 86_400),
        s => format!("{} mo ago", s / (86_400 * 30)),
    }
}

/// `2026-11-13 09:12` (UTC) from epoch milliseconds, with no calendar crate:
/// the days-to-civil arithmetic is short and exact.
pub fn stamp(ms: u64) -> String {
    if ms == 0 {
        return "an unknown time".to_string();
    }
    let secs = ms / 1000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    format!("{:04}-{:02}-{:02} {:02}:{:02} UTC", year, month, day, rem / 3600, (rem % 3600) / 60)
}

/// "a", "a and b", "a, b and c".
pub fn list(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {}", rest.join(", "), last),
    }
}

pub fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{} {}", n, if n == 1 { one } else { many })
}

/// The long word for a version.
pub fn version_word(v: &str) -> &'static str {
    if v == "html" {
        "html"
    } else {
        "markdown"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_are_grouped_in_thousands() {
        let shown: Vec<String> = [0, 7, 999, 1000, 5000, 15_000, 100_000, 1_234_567].into_iter().map(number).collect();
        assert_eq!(shown, ["0", "7", "999", "1,000", "5,000", "15,000", "100,000", "1,234,567"]);
    }

    #[test]
    fn the_reset_is_the_next_utc_midnight_in_local_time() {
        // Whatever the zone this runs in, the sentence names 00:00 UTC, and a
        // local clock beside it only when that clock says something else.
        let said = midnight_utc(1_763_251_200_000 + 3_600_000);
        assert!(said == "00:00 UTC" || (said.ends_with(" (00:00 UTC)") && !said.starts_with("00:00")), "{}", said);
        let clock = local_clock(1_763_251_200_000).expect("a local clock");
        assert!(clock.len() == 5 && clock.as_bytes()[2] == b':', "{}", clock);
    }
}
