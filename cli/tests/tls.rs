//! Whose certificates the built `doklin` trusts: a loopback HTTPS stand-in
//! for a worker, its certificate signed by a CA made for the test — as a
//! proxy that re-signs HTTPS signs one. The machine's own trust decides: on
//! Linux a CA named by `SSL_CERT_FILE` counts; on a Mac only the OS's own
//! check does, which a test cannot add a CA to without asking.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::{Arc, Mutex};

use rcgen::{BasicConstraints, CertificateParams, DnType, IsCa, Issuer, KeyPair, KeyUsagePurpose};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use serde_json::Value;

/// A CA of the test's own, and its PEM in `dir`. Named apart: two CAs of one
/// name are one issuer to a client, and a signature check fails instead.
fn ca(dir: &Path, name: &str) -> (Issuer<'static, KeyPair>, PathBuf) {
    let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
    params.distinguished_name.push(DnType::CommonName, format!("Doklin test {}", name));
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    let key = KeyPair::generate().unwrap();
    let cert = params.self_signed(&key).unwrap();
    let pem = dir.join(format!("{}.pem", name));
    std::fs::write(&pem, cert.pem()).unwrap();
    (Issuer::new(params, key), pem)
}

/// An HTTPS worker on 127.0.0.1, its certificate signed by `ca`, that
/// answers one request with `body` and keeps the request line.
struct Fake {
    endpoint: String,
    seen: Arc<Mutex<Vec<String>>>,
}

impl Fake {
    fn serve(ca: &Issuer<'static, KeyPair>, status: u16, body: &'static str) -> Fake {
        let key = KeyPair::generate().unwrap();
        let cert = CertificateParams::new(vec!["127.0.0.1".to_string()]).unwrap().signed_by(&key, ca).unwrap();
        let config = rustls::ServerConfig::builder_with_provider(rustls::crypto::ring::default_provider().into())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from(cert.der().to_vec())],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
            )
            .unwrap();
        let config = Arc::new(config);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("https://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let kept = seen.clone();
        std::thread::spawn(move || {
            let Ok((tcp, _)) = listener.accept() else { return };
            let mut tls = rustls::StreamOwned::new(rustls::ServerConnection::new(config).unwrap(), tcp);
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            // A client that refuses the certificate ends the handshake here.
            while !head.ends_with(b"\r\n\r\n") {
                match tls.read(&mut byte) {
                    Ok(1) => head.push(byte[0]),
                    _ => return,
                }
            }
            let head = String::from_utf8_lossy(&head).to_lowercase();
            let length = head
                .lines()
                .find_map(|l| l.strip_prefix("content-length:"))
                .and_then(|n| n.trim().parse::<usize>().ok())
                .unwrap_or(0);
            let mut rest = vec![0u8; length];
            let _ = tls.read_exact(&mut rest);
            kept.lock().unwrap().push(head.lines().next().unwrap_or("").to_string());
            let _ = write!(
                tls,
                "HTTP/1.1 {} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                status,
                body.len(),
                body
            );
            tls.conn.send_close_notify();
            let _ = tls.flush();
        });
        Fake { endpoint, seen }
    }

    fn requests(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }
}

fn home(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("doklin-cli-tls-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// `doklin <args>`, piped (so it answers in JSON), with `home` as its HOME
/// and `cert_file` as the only store it is told of.
fn doklin(home: &Path, cert_file: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_doklin"))
        .args(args)
        .env("HOME", home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .env("SSL_CERT_FILE", cert_file)
        .env_remove("SSL_CERT_DIR")
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap()
}

fn refusal(out: &Output) -> Value {
    serde_json::from_slice(&out.stderr).unwrap_or_else(|_| panic!("not a JSON refusal: {}", String::from_utf8_lossy(&out.stderr)))
}

const NOT_VALID: &str = "{\"error\":\"That login code is not valid.\"}";

#[cfg(not(target_os = "macos"))]
#[test]
fn a_ca_named_by_ssl_cert_file_is_trusted() {
    let home = home("trusted");
    let (proxy, pem) = ca(&home, "proxy");
    let worker = Fake::serve(&proxy, 401, NOT_VALID);
    let out = doklin(&home, &pem, &["login", &worker.endpoint, "dkla-TEST"]);
    assert_eq!(out.status.code(), Some(6), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(refusal(&out)["error"], "That login code is not valid.", "the worker's own sentence, so the handshake held");
    assert_eq!(worker.requests(), vec!["post /api/agent/login http/1.1"]);
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_ca_nobody_named_says_how_to_name_it() {
    let home = home("unknown");
    let (proxy, _) = ca(&home, "proxy");
    let (_, other) = ca(&home, "other");
    let worker = Fake::serve(&proxy, 401, NOT_VALID);
    let out = doklin(&home, &other, &["login", &worker.endpoint, "dkla-TEST"]);
    assert_eq!(out.status.code(), Some(1));
    let said = refusal(&out)["error"].as_str().unwrap().to_string();
    assert!(said.contains("signed by an authority this machine does not trust"), "{}", said);
    let how = if cfg!(target_os = "macos") { "Keychain Access" } else { "SSL_CERT_FILE" };
    assert!(said.contains(how), "{}", said);
    assert!(worker.requests().is_empty(), "nothing is sent to a domain whose certificate is not trusted");
    let _ = std::fs::remove_dir_all(&home);
}

#[cfg(not(target_os = "macos"))]
#[test]
fn a_machine_that_trusts_no_ca_sends_nothing() {
    let home = home("none");
    let (proxy, _) = ca(&home, "proxy");
    let empty = home.join("empty.pem");
    std::fs::write(&empty, "").unwrap();
    let worker = Fake::serve(&proxy, 401, NOT_VALID);
    let out = doklin(&home, &empty, &["login", &worker.endpoint, "dkla-TEST"]);
    assert_eq!(out.status.code(), Some(1));
    let said = refusal(&out)["error"].as_str().unwrap().to_string();
    assert!(said.starts_with(&format!("could not reach {}", worker.endpoint.trim_start_matches("https://"))), "{}", said);
    assert!(worker.requests().is_empty());
    let _ = std::fs::remove_dir_all(&home);
}
