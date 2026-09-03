//! Everything the engine says to the worker, behind one trait so the whole
//! engine — merges, conflicts, tombstones, the public map, the flows — runs
//! in tests against an in-memory fake with the worker's CAS semantics
//! (tests.rs), and in the app against `HttpRemote`: the sync API of
//! cloud-worker/README.md, JSON over HTTPS with the owner token as bearer.
//! Nothing outside this module holds a token or opens a connection.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::manifest::{HistoryArchive, Manifest, PollResponse};

/* ---------- What the worker knows ---------- */

/// `workspace.json` — the binding, as `/api/meta` and a `409` report it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecord {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub created_by: CreatedBy,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedBy {
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub device_name: String,
}

/// `GET /api/meta`: liveness, the credential and "is this domain bound".
#[derive(Clone, Debug, Deserialize)]
pub struct Meta {
    pub version: u32,
    #[serde(default)]
    pub features: Vec<String>,
    #[serde(default)]
    pub workspace: Option<WorkspaceRecord>,
}

/// What a won bind answers with.
#[derive(Clone, Debug)]
pub struct Bound {
    pub workspace: WorkspaceRecord,
    /// The etag of the empty manifest the bind created — the base of the
    /// first real manifest.
    pub manifest_etag: String,
}

/// One round of `POST /api/admin/wipe`; repeat while `remaining`.
#[derive(Clone, Debug, Deserialize)]
pub struct WipeRound {
    #[serde(default)]
    pub purged: u64,
    #[serde(default)]
    pub remaining: bool,
}

/* ---------- Errors ---------- */

#[derive(Debug)]
pub enum RemoteError {
    /// Transport-level failure — the domain is unreachable, not wrong.
    Offline(String),
    /// Token rejected: rotated or revoked.
    Unauthorized,
    /// A member asked for an owner's route.
    Forbidden,
    /// Not bound, or the object is gone.
    NotFound,
    /// Manifest CAS lost: the retry path refetches the manifest rather than
    /// trusting the etag the worker answers with.
    Conflict,
    /// `426`: the worker predates this app's manifest schema — update it.
    Outdated(String),
    /// `409` on a bind: the domain already holds this workspace.
    AlreadyBound(WorkspaceRecord),
    Other(String),
}

impl std::fmt::Display for RemoteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RemoteError::Offline(m) => write!(f, "offline: {}", m),
            RemoteError::Unauthorized => write!(f, "unauthorized"),
            RemoteError::Forbidden => write!(f, "owner only"),
            RemoteError::NotFound => write!(f, "not found"),
            RemoteError::Conflict => write!(f, "manifest conflict"),
            RemoteError::Outdated(m) => write!(f, "worker outdated: {}", m),
            RemoteError::AlreadyBound(w) => write!(f, "already bound to \"{}\"", w.name),
            RemoteError::Other(m) => write!(f, "{}", m),
        }
    }
}

pub type RemoteResult<T> = Result<T, RemoteError>;

/* ---------- The trait ---------- */

/// Everything the engine needs from the worker. Methods return
/// `impl Future + Send` (rather than plain `async fn`) so the engine's task
/// stays spawnable on the multithreaded runtime.
pub trait Remote: Send + Sync + 'static {
    fn meta(&self) -> impl std::future::Future<Output = RemoteResult<Meta>> + Send;
    fn bind(
        &self,
        name: &str,
        device_name: &str,
    ) -> impl std::future::Future<Output = RemoteResult<Bound>> + Send;
    fn poll(&self) -> impl std::future::Future<Output = RemoteResult<PollResponse>> + Send;
    fn fetch_manifest(
        &self,
        since: Option<&str>,
    ) -> impl std::future::Future<Output = RemoteResult<Option<(Manifest, String)>>> + Send;
    fn put_manifest(
        &self,
        manifest: &Manifest,
        base_etag: &str,
    ) -> impl std::future::Future<Output = RemoteResult<String>> + Send;
    fn get_blob(
        &self,
        file_id: &str,
        hash: &str,
    ) -> impl std::future::Future<Output = RemoteResult<Vec<u8>>> + Send;
    fn put_blob(
        &self,
        file_id: &str,
        hash: &str,
        bytes: Vec<u8>,
        content_type: &str,
    ) -> impl std::future::Future<Output = RemoteResult<()>> + Send;
    /// (hash, uploaded-at ms) per stored revision of one file.
    fn list_blobs(
        &self,
        file_id: &str,
    ) -> impl std::future::Future<Output = RemoteResult<Vec<(String, u64)>>> + Send;
    fn delete_blob(
        &self,
        file_id: &str,
        hash: &str,
    ) -> impl std::future::Future<Output = RemoteResult<()>> + Send;
    fn get_history(
        &self,
        file_id: &str,
    ) -> impl std::future::Future<Output = RemoteResult<Option<HistoryArchive>>> + Send;
    fn put_history(
        &self,
        file_id: &str,
        archive: &HistoryArchive,
    ) -> impl std::future::Future<Output = RemoteResult<()>> + Send;
    /// "This device is here" — editing `path` when given, idle otherwise.
    fn put_presence(
        &self,
        name: &str,
        path: Option<&str>,
    ) -> impl std::future::Future<Output = RemoteResult<()>> + Send;
    fn delete_presence(&self) -> impl std::future::Future<Output = RemoteResult<()>> + Send;
    fn wipe(&self) -> impl std::future::Future<Output = RemoteResult<WipeRound>> + Send;
}

/* ---------- HTTP remote (the real worker) ---------- */

pub struct HttpRemote {
    client: reqwest::Client,
    endpoint: String,
    token: String,
    device_id: String,
}

impl HttpRemote {
    pub fn new(endpoint: &str, token: &str, device_id: &str) -> Self {
        HttpRemote {
            client: http_client(),
            endpoint: endpoint.trim_end_matches('/').to_string(),
            token: token.to_string(),
            device_id: device_id.to_string(),
        }
    }

    fn url(&self, tail: &str) -> String {
        format!("{}/api/{}", self.endpoint, tail)
    }

    /// The bearer plus the two attribution headers every request carries:
    /// which device speaks (presence, the binding's `createdBy`) and which
    /// app version (the logs).
    fn auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        req.header("authorization", format!("Bearer {}", self.token))
            .header("x-doklin-device", &self.device_id)
            .header("x-doklin-client", env!("CARGO_PKG_VERSION"))
    }
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .connect_timeout(Duration::from_secs(10))
        .build()
        .expect("reqwest client")
}

fn transport_err(e: reqwest::Error) -> RemoteError {
    RemoteError::Offline(e.to_string())
}

fn body_error(v: &serde_json::Value) -> Option<String> {
    v.get("error").and_then(|e| e.as_str()).map(String::from)
}

async fn expect_status(res: reqwest::Response) -> RemoteResult<reqwest::Response> {
    match res.status().as_u16() {
        200..=299 | 304 => Ok(res),
        401 => Err(RemoteError::Unauthorized),
        403 => Err(RemoteError::Forbidden),
        404 => Err(RemoteError::NotFound),
        409 => {
            let v = res.json::<serde_json::Value>().await.unwrap_or_default();
            match v.get("workspace").cloned().and_then(|w| serde_json::from_value(w).ok()) {
                Some(record) => Err(RemoteError::AlreadyBound(record)),
                None => Err(RemoteError::Other(body_error(&v).unwrap_or_else(|| "conflict".into()))),
            }
        }
        412 => Err(RemoteError::Conflict),
        426 => {
            let v = res.json::<serde_json::Value>().await.unwrap_or_default();
            Err(RemoteError::Outdated(
                body_error(&v).unwrap_or_else(|| "the worker predates this app's manifest".into()),
            ))
        }
        code => {
            let body = res.text().await.unwrap_or_default();
            let detail = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| body_error(&v))
                .unwrap_or_else(|| body.chars().take(200).collect());
            Err(RemoteError::Other(format!("http {}: {}", code, detail)))
        }
    }
}

impl Remote for HttpRemote {
    fn meta(&self) -> impl std::future::Future<Output = RemoteResult<Meta>> + Send {
        async move {
            let res = self.auth(self.client.get(self.url("meta"))).send().await.map_err(transport_err)?;
            let res = expect_status(res).await.map_err(|e| match e {
                // Only a worker answers /api/meta; anything else lives here.
                RemoteError::NotFound => RemoteError::Other("no Doklin cloud worker answers at that address".into()),
                other => other,
            })?;
            let v = res.json::<serde_json::Value>().await.map_err(|_| {
                RemoteError::Other("that address isn't a Doklin cloud worker".into())
            })?;
            serde_json::from_value::<Meta>(v)
                .map_err(|_| RemoteError::Other("that address isn't a Doklin cloud worker".into()))
        }
    }

    fn bind(
        &self,
        name: &str,
        device_name: &str,
    ) -> impl std::future::Future<Output = RemoteResult<Bound>> + Send {
        let body = json!({ "name": name, "deviceName": device_name });
        async move {
            let res = self
                .auth(self.client.post(self.url("workspace")))
                .header("content-type", "application/json")
                .body(serde_json::to_vec(&body).unwrap_or_default())
                .send()
                .await
                .map_err(transport_err)?;
            let res = expect_status(res).await?;
            let v = res.json::<serde_json::Value>().await.map_err(transport_err)?;
            let manifest_etag = v
                .get("manifestEtag")
                .and_then(|e| e.as_str())
                .unwrap_or_default()
                .to_string();
            let workspace: WorkspaceRecord = serde_json::from_value(v.clone())
                .map_err(|_| RemoteError::Other("bind returned no workspace record".into()))?;
            if manifest_etag.is_empty() || workspace.id.is_empty() {
                return Err(RemoteError::Other("bind returned no id/etag".into()));
            }
            Ok(Bound { workspace, manifest_etag })
        }
    }

    fn poll(&self) -> impl std::future::Future<Output = RemoteResult<PollResponse>> + Send {
        async move {
            let res = self.auth(self.client.get(self.url("poll"))).send().await.map_err(transport_err)?;
            let res = expect_status(res).await?;
            res.json::<PollResponse>().await.map_err(transport_err)
        }
    }

    fn fetch_manifest(
        &self,
        since: Option<&str>,
    ) -> impl std::future::Future<Output = RemoteResult<Option<(Manifest, String)>>> + Send {
        let since = since.map(String::from);
        async move {
            let mut req = self.client.get(self.url("manifest"));
            if let Some(s) = &since {
                req = req.query(&[("since", s.as_str())]);
            }
            let res = self.auth(req).send().await.map_err(transport_err)?;
            if res.status().as_u16() == 304 {
                return Ok(None);
            }
            let res = expect_status(res).await?;
            let etag = res
                .headers()
                .get("x-manifest-etag")
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_string();
            let manifest = res
                .json::<Manifest>()
                .await
                .map_err(|e| RemoteError::Other(format!("unreadable manifest: {}", e)))?;
            Ok(Some((manifest, etag)))
        }
    }

    fn put_manifest(
        &self,
        manifest: &Manifest,
        base_etag: &str,
    ) -> impl std::future::Future<Output = RemoteResult<String>> + Send {
        let body = serde_json::to_vec(manifest).unwrap_or_default();
        let base = base_etag.to_string();
        async move {
            let res = self
                .auth(self.client.put(self.url("manifest")))
                .header("x-base-etag", base)
                .header("content-type", "application/json")
                .body(body)
                .send()
                .await
                .map_err(transport_err)?;
            let res = expect_status(res).await?;
            let v = res.json::<serde_json::Value>().await.map_err(transport_err)?;
            Ok(v.get("etag").and_then(|e| e.as_str()).unwrap_or_default().to_string())
        }
    }

    fn get_blob(
        &self,
        file_id: &str,
        hash: &str,
    ) -> impl std::future::Future<Output = RemoteResult<Vec<u8>>> + Send {
        let url = self.url(&format!("blobs/{}/{}", file_id, hash));
        async move {
            let res = self.auth(self.client.get(url)).send().await.map_err(transport_err)?;
            let res = expect_status(res).await?;
            Ok(res.bytes().await.map_err(transport_err)?.to_vec())
        }
    }

    fn put_blob(
        &self,
        file_id: &str,
        hash: &str,
        bytes: Vec<u8>,
        content_type: &str,
    ) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        let url = self.url(&format!("blobs/{}/{}", file_id, hash));
        let ct = content_type.to_string();
        async move {
            let res = self
                .auth(self.client.put(url))
                .header("content-type", ct)
                .body(bytes)
                .send()
                .await
                .map_err(transport_err)?;
            expect_status(res).await.map(|_| ())
        }
    }

    fn list_blobs(
        &self,
        file_id: &str,
    ) -> impl std::future::Future<Output = RemoteResult<Vec<(String, u64)>>> + Send {
        let url = self.url(&format!("blobs/{}", file_id));
        async move {
            let res = self.auth(self.client.get(url)).send().await.map_err(transport_err)?;
            let res = expect_status(res).await?;
            let v = res.json::<serde_json::Value>().await.map_err(transport_err)?;
            let blobs = v
                .get("blobs")
                .and_then(|b| b.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|b| {
                            let hash = b.get("hash")?.as_str()?.to_string();
                            let uploaded = b
                                .get("uploaded")
                                .and_then(|u| u.as_str())
                                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                                .map(|d| d.timestamp_millis() as u64)
                                .unwrap_or(0);
                            Some((hash, uploaded))
                        })
                        .collect()
                })
                .unwrap_or_default();
            Ok(blobs)
        }
    }

    fn delete_blob(
        &self,
        file_id: &str,
        hash: &str,
    ) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        let url = self.url(&format!("blobs/{}/{}", file_id, hash));
        async move {
            let res = self.auth(self.client.delete(url)).send().await.map_err(transport_err)?;
            expect_status(res).await.map(|_| ())
        }
    }

    fn get_history(
        &self,
        file_id: &str,
    ) -> impl std::future::Future<Output = RemoteResult<Option<HistoryArchive>>> + Send {
        let url = self.url(&format!("history/{}", file_id));
        async move {
            let res = self.auth(self.client.get(url)).send().await.map_err(transport_err)?;
            match expect_status(res).await {
                Ok(res) => Ok(Some(res.json::<HistoryArchive>().await.map_err(transport_err)?)),
                Err(RemoteError::NotFound) => Ok(None),
                Err(e) => Err(e),
            }
        }
    }

    fn put_history(
        &self,
        file_id: &str,
        archive: &HistoryArchive,
    ) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        let url = self.url(&format!("history/{}", file_id));
        let body = serde_json::to_vec(archive).unwrap_or_default();
        async move {
            let res = self
                .auth(self.client.put(url))
                .header("content-type", "application/json")
                .body(body)
                .send()
                .await
                .map_err(transport_err)?;
            expect_status(res).await.map(|_| ())
        }
    }

    fn put_presence(
        &self,
        name: &str,
        path: Option<&str>,
    ) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        let body = match path {
            Some(p) => json!({ "name": name, "path": p }),
            None => json!({ "name": name }),
        };
        async move {
            let res = self
                .auth(self.client.put(self.url("presence")))
                .header("content-type", "application/json")
                .body(serde_json::to_vec(&body).unwrap_or_default())
                .send()
                .await
                .map_err(transport_err)?;
            expect_status(res).await.map(|_| ())
        }
    }

    fn delete_presence(&self) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        async move {
            let res = self
                .auth(self.client.delete(self.url("presence")))
                .send()
                .await
                .map_err(transport_err)?;
            expect_status(res).await.map(|_| ())
        }
    }

    fn wipe(&self) -> impl std::future::Future<Output = RemoteResult<WipeRound>> + Send {
        async move {
            let res = self
                .auth(self.client.post(self.url("admin/wipe")))
                .header("content-type", "application/json")
                .body(r#"{"confirm":"wipe"}"#)
                .send()
                .await
                .map_err(transport_err)?;
            let res = expect_status(res).await?;
            res.json::<WipeRound>().await.map_err(transport_err)
        }
    }
}
