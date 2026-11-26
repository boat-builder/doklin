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
use std::io::IsTerminal;
use std::sync::Arc;
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
        let agent = ureq::Agent::config_builder()
            .tls_config(tls())
            .timeout_connect(Some(Duration::from_secs(15)))
            .timeout_global(Some(Duration::from_secs(120)))
            // A refusal is an answer like any other: a status and the worker's sentence.
            .http_status_as_error(false)
            .build()
            .new_agent();
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
            // Below 400 is an answer; the rest is a refusal, a wait or a limit.
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
        let mut req = ureq::http::Request::builder()
            .method(method)
            .uri(url)
            .header("x-doklin-client", concat!("cli/", env!("CARGO_PKG_VERSION")));
        if let Some(token) = &self.token {
            req = req.header("authorization", format!("Bearer {}", token));
        }
        if let Some(n) = used {
            req = req.header("x-doklin-used", n.to_string());
        }
        for (name, value) in headers {
            req = req.header(*name, *value);
        }
        match body {
            Some(Body::Json(v)) => self.run(req.header("content-type", "application/json").body(v.to_string())),
            Some(Body::Bytes(b)) => self.run(req.header("content-type", "application/octet-stream").body(b)),
            None => self.run(req.body(())),
        }
    }

    fn run(&self, req: Result<ureq::http::Request<impl ureq::AsSendBody>, ureq::http::Error>) -> Result<Reply, Failure> {
        let req = req.map_err(|e| Failure::other(format!("that request could not be made: {}", e)))?;
        match self.agent.run(req) {
            Ok(res) => read(res),
            Err(e) if unknown_issuer(&e) => Err(Failure::other(format!(
                "could not reach {}: its certificate is signed by an authority this machine does not trust — if HTTPS here goes through a proxy with a CA of its own, {}",
                self.domain(),
                TRUST_IT
            ))),
            Err(e) => Err(Failure::other(format!("could not reach {}: {}", self.domain(), e))),
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

/// Who may sign a domain's certificate: whoever the machine trusts, as for
/// every program on it. On a Mac the OS checks it — Apple's own check, so a
/// CA a company installs counts. Elsewhere it is the system's CA store, or
/// `SSL_CERT_FILE` / `SSL_CERT_DIR` in its place when either is set, as curl,
/// git and Go read them. No roots are bundled. (A proxy is ureq's to find, in
/// `HTTPS_PROXY` and `NO_PROXY`, as curl does.)
fn tls() -> ureq::tls::TlsConfig {
    ureq::tls::TlsConfig::builder()
        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
        .unversioned_rustls_crypto_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .build()
}

/// How a CA comes to be trusted here, said where an unknown one is refused.
/// macOS-only: the Mac's is Keychain Access, which the OS's check reads.
#[cfg(target_os = "macos")]
const TRUST_IT: &str = "add that CA in Keychain Access and set it to Always Trust";
#[cfg(not(target_os = "macos"))]
const TRUST_IT: &str = "add it to this machine's CA certificates, or set SSL_CERT_FILE to its PEM file";

/// A certificate no trusted root signed. The handshake's refusal comes as
/// rustls's own error, or inside the `io::Error` the handshake returned.
fn unknown_issuer(e: &ureq::Error) -> bool {
    let tls = match e {
        ureq::Error::Rustls(tls) => Some(tls),
        ureq::Error::Io(io) => io.get_ref().and_then(|e| e.downcast_ref::<rustls::Error>()),
        _ => None,
    };
    matches!(tls, Some(rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer)))
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

fn read(res: ureq::http::Response<ureq::Body>) -> Result<Reply, Failure> {
    let status = res.status().as_u16();
    let mut headers = HashMap::new();
    for (name, value) in res.headers() {
        let name = name.as_str();
        if name.starts_with("x-doklin-") || name == "retry-after" {
            if let Ok(value) = value.to_str() {
                // The first of a name, as it was always read.
                headers.entry(name.to_string()).or_insert_with(|| decode(value));
            }
        }
    }
    let bytes = res
        .into_body()
        .into_with_config()
        .limit(MAX_ANSWER_BYTES)
        .read_to_vec()
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
