//! Every request this program makes: HTTPS to the workspace's own domain,
//! the document API under `/api/agent/` (cloud-worker/src/agentApi.ts), with
//! the token a login left here as the bearer. Nothing else is contacted.
//!
//! A refusal from the worker is a sentence written to be acted on, so it is
//! passed through word for word; what this module adds is which exit code
//! the refusal means.

use std::collections::HashMap;
use std::io::Read;
use std::time::Duration;

use serde_json::Value;

use crate::creds::domain_of;
use crate::Failure;

/// The largest answer worth holding: a file is capped at 25 MB by the worker.
const MAX_ANSWER_BYTES: u64 = 32 * 1024 * 1024;

pub enum Body<'a> {
    Json(&'a Value),
    Bytes(&'a [u8]),
}

pub struct Reply {
    pub status: u16,
    /// The `x-doklin-*` headers, by name, percent-decoded.
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
        let mut req = self
            .agent
            .request(method, &url)
            .set("x-doklin-client", concat!("cli/", env!("CARGO_PKG_VERSION")));
        if let Some(token) = &self.token {
            req = req.set("authorization", &format!("Bearer {}", token));
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
            Ok(res) => read(res),
            Err(ureq::Error::Status(_, res)) => Err(self.refusal(read(res)?)),
            Err(ureq::Error::Transport(t)) => Err(Failure::other(format!("could not reach {}: {}", self.domain(), t))),
        }
    }

    /// What a non-2xx answer means, in an exit code and the worker's words.
    fn refusal(&self, reply: Reply) -> Failure {
        let detail: Option<Value> = serde_json::from_slice(&reply.bytes).ok();
        let said = detail.as_ref().and_then(|v| v.get("error")).and_then(Value::as_str).unwrap_or("").to_string();
        let too_old = || {
            format!(
                "the worker on {} is too old for this command — the workspace's owner can update it from Doklin's Cloud panel",
                self.domain()
            )
        };
        let (exit, message) = match reply.status {
            // The gate's own bare word: the token is not one the domain knows.
            401 if said == "unauthorized" && self.token.is_some() => (
                6,
                format!(
                    "this machine's login to {} no longer works — the agent was removed, or this machine was logged out. Ask for a new login line.",
                    self.domain()
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

fn read(res: ureq::Response) -> Result<Reply, Failure> {
    let status = res.status();
    let mut headers = HashMap::new();
    for name in res.headers_names() {
        if name.starts_with("x-doklin-") {
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
