//! The words this program prints for a person: sizes, times, lists. JSON
//! output never passes through here — it is the worker's answer as it came.

use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
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
