//! Every HTTPS client the apps build — the sync engine's, and the Mac app's
//! downloads. The OS decides which certificates to trust: Apple's own check,
//! as every app on a Mac and an iPhone gets, so a CA a company installs (by
//! MDM, a profile or Keychain Access) is trusted here too, and one Apple
//! distrusts is not. No roots are bundled.

use std::sync::Arc;

use rustls_platform_verifier::BuilderVerifierExt;

/// A client builder whose certificates the OS checks.
pub fn builder() -> reqwest::ClientBuilder {
    let tls = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .expect("ring speaks TLS 1.2 and 1.3")
        .with_platform_verifier()
        .expect("the OS's certificate check")
        .with_no_client_auth();
    reqwest::Client::builder().use_preconfigured_tls(tls)
}

#[cfg(test)]
mod tests {
    use std::io::Read;
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    use rcgen::{BasicConstraints, CertificateParams, DnType, IsCa, Issuer, KeyPair, KeyUsagePurpose};
    use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};

    /// A domain whose certificate a CA made here signed — one the OS has
    /// never heard of. Keeps whether any request arrived.
    fn unknown_ca_domain() -> (String, Arc<Mutex<bool>>) {
        let mut ca = CertificateParams::new(Vec::<String>::new()).unwrap();
        ca.distinguished_name.push(DnType::CommonName, "Doklin test CA");
        ca.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        ca.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        let issuer = Issuer::new(ca, KeyPair::generate().unwrap());
        let key = KeyPair::generate().unwrap();
        let cert = CertificateParams::new(vec!["127.0.0.1".to_string()]).unwrap().signed_by(&key, &issuer).unwrap();
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from(cert.der().to_vec())],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
            )
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("https://{}/api/meta", listener.local_addr().unwrap());
        let asked = Arc::new(Mutex::new(false));
        let seen = asked.clone();
        std::thread::spawn(move || {
            let Ok((tcp, _)) = listener.accept() else { return };
            let mut tls = rustls::StreamOwned::new(rustls::ServerConnection::new(Arc::new(config)).unwrap(), tcp);
            let mut byte = [0u8; 1];
            // A client that refuses the certificate ends the handshake here.
            if let Ok(1) = tls.read(&mut byte) {
                *seen.lock().unwrap() = true;
            }
        });
        (url, asked)
    }

    /// The rustls refusal somewhere in an error's causes.
    fn refusal(e: &(dyn std::error::Error + 'static)) -> Option<rustls::Error> {
        let mut cause = Some(e);
        while let Some(e) = cause {
            if let Some(tls) = e.downcast_ref::<rustls::Error>() {
                return Some(tls.clone());
            }
            // An `io::Error`'s `source()` steps over the error it carries.
            let carried = e.downcast_ref::<std::io::Error>().and_then(|io| io.get_ref()).map(|e| e as &(dyn std::error::Error + 'static));
            cause = carried.or_else(|| e.source());
        }
        None
    }

    #[tokio::test]
    async fn a_ca_the_os_does_not_trust_is_refused_before_anything_is_sent() {
        let (url, asked) = unknown_ca_domain();
        let err = super::builder().build().unwrap().get(&url).send().await.expect_err("an unknown CA was trusted");
        assert!(
            matches!(refusal(&err), Some(rustls::Error::InvalidCertificate(_))),
            "refused for the certificate, not something else: {:?}",
            err
        );
        assert!(!*asked.lock().unwrap(), "nothing is sent to a domain whose certificate is not trusted");
    }
}
