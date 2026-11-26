//! Every request this program makes: HTTPS to the workspace's own domain,
//! the document API under `/api/agent/` (cloud-worker/src/agentApi.ts), with
//! the token a login left here as the bearer. Nothing else is contacted.
//!
//! A refusal from the worker is a sentence written to be acted on, so it is
//! passed through word for word; what this module adds is which exit code
//! the refusal means.
//!
//! Every request is counted before it goes (usage.rs), and none goes past
//! the domain's allowance. A `429` is waited out once; Cloudflare's page for
//! an account past today's requests stops at once. Either is exit 8.

use std::collections::HashMap;
use std::io::{IsTerminal, Read};
use std::time::Duration;

use serde_json::Value;

use crate::creds::domain_of;
use crate::text::{midnight_utc, now_ms};
use crate::{usage, Failure};

/// The largest answer worth holding: a file is capped at 25 MB by the worker.
const MAX_ANSWER_BYTES: u64 = 32 * 1024 * 1024;

/// The longest a `429` is waited out before its one retry — and the wait
/// when it says no time of its own.
const MAX_WAIT: Duration = Duration::from_secs(60);

#[derive(Clone, Copy)]
pub enum Body<'a> {
    Json(&'a Value),
    Bytes(&'a [u8]),
}

pub struct Reply {
    pub status: u16,
    /// The `x-doklin-*` headers and `retry-after`, by name, percent-decoded.
    pub headers: HashMap<String, String>,
    pub bytes: Vec<u8>,
}

impl Reply {
    pub fn json(&self) -> Result<Value, Failure> {
        serde_json::from_slice(&self.bytes).map_err(|_| Failure::other("the domain's answer was not what a Doklin worker sends"))
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }
}

pub struct Client {
    agent: ureq::Agent,
    endpoint: String,
    token: Option<String>,
}

impl Client {
    pub fn new(endpoint: &str, token: Option<&str>) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(15))
            .timeout(Duration::from_secs(120))
            .build();
        Client { agent, endpoint: endpoint.trim_end_matches('/').to_string(), token: token.map(String::from) }
    }

    fn domain(&self) -> &str {
        domain_of(&self.endpoint)
    }

    /// One request to `/api/agent/<route>`. A 2xx is the reply; anything
    /// else is a `Failure` carrying the worker's own sentence.
    pub fn send(
        &self,
        method: &str,
        route: &str,
        query: &[(&str, &str)],
        headers: &[(&str, &str)],
        body: Option<Body>,
    ) -> Result<Reply, Failure> {
        let mut url = format!("{}/api/agent/{}", self.endpoint, route);
        for (i, (key, value)) in query.iter().enumerate() {
            url.push(if i == 0 { '?' } else { '&' });
            url.push_str(key);
            url.push('=');
            url.push_str(&encode(value));
        }
        // `x-doklin-used` rides a signed-in request: the worker files the
        // count under its token. Never a login's, which holds no token yet,
        // or the one going away, whose row would go on counting today
        // beside the new one's.
        let reports = self.token.is_some() && route != "login";
        let mut waited = false;
        loop {
            let used = usage::count(self.domain(), reports)?;
            let reply = self.once(method, &url, headers, body, used)?;
            // ureq's own line between an answer and a refusal.
            if reply.status < 400 {
                return Ok(reply);
            }
            match classify(reply.status, reply.header("retry-after"), &reply.bytes) {
                Answer::Refusal => return Err(self.refusal(reply)),
                Answer::DailyLimit => {
                    return Err(Failure {
                        status: Some(reply.status),
                        ..Failure::limited(format!(
                            "today's Cloudflare requests for {} are used up — it answers again at {}",
                            self.domain(),
                            midnight_utc(now_ms())
                        ))
                    })
                }
                Answer::SlowDown(wait) if !waited => {
                    if std::io::stderr().is_terminal() {
                        eprintln!("doklin: {} asked this machine to slow down — asking again in {} s…", self.domain(), wait.as_secs());
                    }
                    std::thread::sleep(wait);
                    waited = true;
                }
                Answer::SlowDown(_) => {
                    return Err(Failure {
                        status: Some(reply.status),
                        detail: serde_json::from_slice(&reply.bytes).ok(),
                        ..Failure::limited(format!(
                            "{} says this machine is sending too many requests — wait a minute before the next one",
                            self.domain()
                        ))
                    })
                }
            }
        }
    }

    /// The request itself, once, and whatever the domain answered to it.
    /// `used` is the count it reports, when it is the one that does.
    fn once(&self, method: &str, url: &str, headers: &[(&str, &str)], body: Option<Body>, used: Option<u64>) -> Result<Reply, Failure> {
        let mut req = self
            .agent
            .request(method, url)
            .set("x-doklin-client", concat!("cli/", env!("CARGO_PKG_VERSION")));
        if let Some(token) = &self.token {
            req = req.set("authorization", &format!("Bearer {}", token));
        }
        if let Some(n) = used {
            req = req.set("x-doklin-used", &n.to_string());
        }
        for (name, value) in headers {
            req = req.set(name, value);
        }
        let sent = match body {
            Some(Body::Json(v)) => req.set("content-type", "application/json").send_bytes(v.to_string().as_bytes()),
            Some(Body::Bytes(b)) => req.set("content-type", "application/octet-stream").send_bytes(b),
            None => req.call(),
        };
        match sent {
            Ok(res) | Err(ureq::Error::Status(_, res)) => read(res),
            Err(ureq::Error::Transport(t)) => Err(Failure::other(format!("could not reach {}: {}", self.domain(), t))),
        }
    }

    /// What a non-2xx answer means, in an exit code and the worker's words.
    fn refusal(&self, reply: Reply) -> Failure {
        let detail: Option<Value> = serde_json::from_slice(&reply.bytes).ok();
        let said = detail.as_ref().and_then(|v| v.get("error")).and_then(Value::as_str).unwrap_or("").to_string();
        let too_old = || too_old(self.domain()).message;
        let (exit, message) = match reply.status {
            // The gate's own bare word: the token is not one the domain knows.
            401 if said == "unauthorized" && self.token.is_some() => (
                6,
                format!(
                    "this machine's login to {} no longer works — the agent was removed, or this machine was logged out. Ask for a new login line{}.",
                    self.domain(),
                    crate::creds::from_the_app(self.domain())
                ),
            ),
            401 => (6, said),
            403 => (4, said),
            // A route the worker has never heard of, as opposed to a document it cannot find.
            404 if said == "not found" || said.is_empty() => (7, too_old()),
            405 => (7, too_old()),
            404 => (3, said),
            409 | 412 | 428 => (5, said),
            // This doklin is older than the release the domain marks
            // mandatory, and every route says so before anything else
            // (cloud-worker/src/clients.ts — change both). The sentence says
            // how to update.
            410 if said.is_empty() => (9, format!("this doklin is too old for {} — update it", self.domain())),
            410 => (9, said),
            400 | 413 => (2, said),
            _ if said.is_empty() => (1, format!("{} answered {}", self.domain(), reply.status)),
            _ => (1, said),
        };
        Failure { exit, message, status: Some(reply.status), detail }
    }
}

/// Exit 7: the domain's worker is older than what this command asks of it —
/// a route it has never heard of, or an answer without what was asked for.
pub fn too_old(domain: &str) -> Failure {
    Failure {
        exit: 7,
        message: format!(
            "the worker on {} is too old for this command — the workspace's owner can update it from Doklin's Cloud panel",
            domain
        ),
        status: None,
        detail: None,
    }
}

/// What a non-2xx answer is, before it is a refusal.
#[derive(Debug, PartialEq)]
enum Answer {
    /// Cloudflare's own page for an account past today's requests (error
    /// 1027). Its status is not documented, so it is known by its body: not
    /// JSON, and it names the error.
    DailyLimit,
    /// `429`: wait this long, then ask once more.
    SlowDown(Duration),
    /// The worker's own refusal.
    Refusal,
}

fn classify(status: u16, retry_after: Option<&str>, body: &[u8]) -> Answer {
    if serde_json::from_slice::<Value>(body).is_err() && body.windows(4).any(|w| w == b"1027") {
        return Answer::DailyLimit;
    }
    if status == 429 {
        let said = retry_after.and_then(|s| s.trim().parse::<u64>().ok()).map(Duration::from_secs);
        return Answer::SlowDown(said.unwrap_or(MAX_WAIT).min(MAX_WAIT));
    }
    Answer::Refusal
}

fn read(res: ureq::Response) -> Result<Reply, Failure> {
    let status = res.status();
    let mut headers = HashMap::new();
    for name in res.headers_names() {
        if name.starts_with("x-doklin-") || name == "retry-after" {
            if let Some(value) = res.header(&name) {
                headers.insert(name.clone(), decode(value));
            }
        }
    }
    let mut bytes = Vec::new();
    res.into_reader()
        .take(MAX_ANSWER_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|e| Failure::other(format!("the answer was cut short: {}", e)))?;
    Ok(Reply { status, headers, bytes })
}

/// Percent-encode a query value: everything but the unreserved characters.
pub fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// Undo percent-encoding — how the worker sends a path in a header.
pub fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(byte) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORKER_429: &[u8] = "{\"error\":\"This device is sending too many requests — it will slow down by itself.\"}".as_bytes();

    #[test]
    fn a_429_is_waited_out_for_what_it_says_never_more_than_a_minute() {
        let wait = |after: Option<&str>| classify(429, after, WORKER_429);
        assert_eq!(wait(Some("60")), Answer::SlowDown(Duration::from_secs(60)));
        assert_eq!(wait(Some(" 5 ")), Answer::SlowDown(Duration::from_secs(5)));
        assert_eq!(wait(Some("0")), Answer::SlowDown(Duration::ZERO));
        assert_eq!(wait(Some("600")), Answer::SlowDown(MAX_WAIT));
        // No time, or one this program does not read (an HTTP date): the longest wait.
        assert_eq!(wait(None), Answer::SlowDown(MAX_WAIT));
        assert_eq!(wait(Some("Wed, 18 Nov 2026 07:28:00 GMT")), Answer::SlowDown(MAX_WAIT));
        assert_eq!(classify(429, Some("1"), b""), Answer::SlowDown(Duration::from_secs(1)));
    }

    #[test]
    fn cloudflare_s_daily_limit_page_is_known_by_its_body_whatever_its_status() {
        for status in [429, 500, 503, 530, 403] {
            assert_eq!(classify(status, None, b"error code: 1027"), Answer::DailyLimit, "{}", status);
        }
        let page = b"<!DOCTYPE html><html><head><title>Error 1027 | Worker exceeded free tier daily request limit</title></head></html>";
        assert_eq!(classify(429, Some("60"), page), Answer::DailyLimit, "never waited out: nothing changes before 00:00 UTC");
    }

    #[test]
    fn everything_else_is_the_worker_s_refusal() {
        // The worker's JSON may hold the digits — a revision, a size — and is still its own sentence.
        assert_eq!(classify(409, None, br#"{"error":"the document is at revision 1027 now"}"#), Answer::Refusal);
        assert_eq!(classify(502, None, b"<html><body>Bad gateway</body></html>"), Answer::Refusal);
        assert_eq!(classify(404, None, b""), Answer::Refusal);
        assert_eq!(classify(401, None, br#"{"error":"unauthorized"}"#), Answer::Refusal);
    }
}
