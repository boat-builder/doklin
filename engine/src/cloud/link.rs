//! A link to a page: what one person sends another so that the page opens in
//! Doklin wherever the link is clicked — a chat, a mail, a browser, a note.
//!
//! ```text
//! https://doklin.cc/open#d=notes.example.com&w=w-0a1b2c3d4e5f&s=s-1a2b3c4d&f=f-9c8b7a6d5e4f
//! ```
//!
//! - **Everything is after the `#`.** A browser never sends that part to a
//!   server, so doklin.cc, its logs and a chat app's preview bot never learn
//!   which workspace or which page a link is. doklin.cc only hands the link
//!   on: an iPhone opens it straight from Apple's association file, anything
//!   else through the page at that address, which passes it to the app as
//!   `doklin://open#…` or, on a computer, to the browser version on the
//!   link's own domain, `https://<d>/app#…` (site/public/open.html and
//!   site/public/.well-known/apple-app-site-association).
//! - **Ids, never a path or a title.** A rename or a move inside its section
//!   keeps the link working, and a link spells out no folder's name.
//! - **An address, never access.** What lets somebody open it is being in
//!   that section of that workspace; nothing in a link lets anybody in.
//!
//! `d` is the domain (what the app names when this device is not in the
//! workspace), `w` the workspace's id (a domain wiped and set up again is
//! another workspace), `s` the space — absent for the shared workspace — and
//! `f` the file's id. Unknown keys are ignored, so a later key is no reason
//! for an older app to refuse a link.
//!
//! The page's address, the scheme and the key names are also in
//! site/public/open.html, the address and the key names in
//! src/web/address.ts (the browser version makes a link, follows one, and
//! reads one in its own address), the scheme in src-tauri/Info.plist and
//! ios/Info.plist, and the address in ios/Doklin.entitlements: **change
//! all of them together.**

use url::Url;

/// The address every link has, before its `#`.
pub const PAGE: &str = "https://doklin.cc/open";
/// The host of [`PAGE`].
const HOST: &str = "doklin.cc";
/// The path of [`PAGE`].
const PATH: &str = "/open";
/// The scheme the app is registered for. `doklin://open#…` is a link as the
/// page hands it to the app.
pub const SCHEME: &str = "doklin";

/// One page of one workspace, as a link names it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PageLink {
    pub domain: String,
    pub ws_id: String,
    /// The space the file is in; None is the shared workspace.
    pub space: Option<String>,
    pub file: String,
}

impl PageLink {
    /// The link as it is copied and sent.
    pub fn url(&self) -> String {
        let mut pairs = url::form_urlencoded::Serializer::new(String::new());
        pairs.append_pair("d", &self.domain);
        pairs.append_pair("w", &self.ws_id);
        if let Some(space) = &self.space {
            pairs.append_pair("s", space);
        }
        pairs.append_pair("f", &self.file);
        format!("{}#{}", PAGE, pairs.finish())
    }

    /// The link in `text`: the address as it is sent, or as the page hands it
    /// to the app. Spaces around it, and the angle brackets a mail client
    /// wraps a link in, are left off. None for anything else — another
    /// address, or a link missing what it needs to name a page.
    pub fn parse(text: &str) -> Option<PageLink> {
        let text = text.trim();
        let text = text.strip_prefix('<').and_then(|t| t.strip_suffix('>')).unwrap_or(text).trim();
        let url = Url::parse(text).ok()?;
        let ours = match url.scheme() {
            "https" | "http" => {
                url.host_str().is_some_and(|h| h.eq_ignore_ascii_case(HOST))
                    && url.port().is_none()
                    && (url.path() == PATH || url.path().strip_suffix('/') == Some(PATH))
            }
            // A scheme of its own has no path to speak of: `doklin://open`.
            s if s == SCHEME => url.host_str() == Some("open") && matches!(url.path(), "" | "/"),
            _ => false,
        };
        if !ours {
            return None;
        }
        let (mut domain, mut ws_id, mut space, mut file) = (None, None, None, None);
        for (key, value) in url::form_urlencoded::parse(url.fragment()?.as_bytes()) {
            let value = value.trim().to_string();
            match key.as_ref() {
                "d" => domain = Some(value.to_ascii_lowercase()),
                "w" => ws_id = Some(value),
                "s" => space = Some(value),
                "f" => file = Some(value),
                _ => {}
            }
        }
        let link = PageLink { domain: domain?, ws_id: ws_id?, space: space.filter(|s| !s.is_empty()), file: file? };
        let well_formed = is_domain(&link.domain)
            && is_id(&link.ws_id)
            && is_id(&link.file)
            && link.space.as_deref().map_or(true, is_space_id);
        well_formed.then_some(link)
    }
}

/// A host, with a port when it has one: what cloud.json calls a domain. The
/// link page sends a browser to nothing else (`isDomain`,
/// site/public/open.html): change both.
fn is_domain(s: &str) -> bool {
    let (host, port) = match s.rsplit_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (s, None),
    };
    !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                && !label.starts_with('-')
                && !label.ends_with('-')
        })
        && port.map_or(true, |p| !p.is_empty() && p.len() <= 5 && p.bytes().all(|b| b.is_ascii_digit()))
}

/// A workspace's or a file's id: the worker's `ID_RE`
/// (cloud-worker/src/layout.ts).
fn is_id(s: &str) -> bool {
    let bytes = s.as_bytes();
    (3..=64).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// A space's id: the worker's `SPACE_ID_RE` (cloud-worker/src/layout.ts).
fn is_space_id(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() == 10
        && matches!(bytes[0], b's' | b'p')
        && bytes[1] == b'-'
        && bytes[2..].iter().all(|&b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(space: Option<&str>) -> PageLink {
        PageLink {
            domain: "notes.example.com".into(),
            ws_id: "w-0a1b2c3d4e5f".into(),
            space: space.map(String::from),
            file: "f-9c8b7a6d5e4f".into(),
        }
    }

    #[test]
    fn a_link_names_its_page_after_the_hash_and_reads_back() {
        let shared = link(None);
        assert_eq!(shared.url(), "https://doklin.cc/open#d=notes.example.com&w=w-0a1b2c3d4e5f&f=f-9c8b7a6d5e4f");
        assert_eq!(PageLink::parse(&shared.url()), Some(shared));
        let restricted = link(Some("s-1a2b3c4d"));
        assert_eq!(
            restricted.url(),
            "https://doklin.cc/open#d=notes.example.com&w=w-0a1b2c3d4e5f&s=s-1a2b3c4d&f=f-9c8b7a6d5e4f"
        );
        assert_eq!(PageLink::parse(&restricted.url()), Some(restricted));
    }

    #[test]
    fn the_app_reads_a_link_as_the_page_hands_it_on() {
        let handed = "doklin://open#d=notes.example.com&w=w-0a1b2c3d4e5f&s=p-1a2b3c4d&f=f-9c8b7a6d5e4f";
        assert_eq!(PageLink::parse(handed), Some(link(Some("p-1a2b3c4d"))));
        assert_eq!(PageLink::parse("doklin://open/#d=notes.example.com&w=w-0a1b2c3d4e5f&f=f-9c8b7a6d5e4f"), Some(link(None)));
    }

    #[test]
    fn a_link_survives_what_people_and_mail_clients_do_to_it() {
        let sent = link(None).url();
        for text in [
            format!("  {}\n", sent),
            format!("<{}>", sent),
            sent.replace("https://doklin.cc", "http://DOKLIN.cc"),
            sent.replace("/open#", "/open/#"),
            sent.replace("d=notes.example.com", "d=Notes.Example.com"),
            format!("{}&t=thread-later", sent),
            sent.replace("&f=", "&x=1&f="),
        ] {
            assert_eq!(PageLink::parse(&text), Some(link(None)), "{}", text);
        }
        let with_port =
            PageLink::parse("https://doklin.cc/open#d=127.0.0.1%3A8787&w=w-0a1b2c3d4e5f&f=f-9c8b7a6d5e4f").unwrap();
        assert_eq!(with_port.domain, "127.0.0.1:8787");
        assert_eq!(PageLink::parse(&with_port.url()), Some(with_port));
    }

    /// The address, the scheme and the app are said again outside the
    /// engine — by the page links go through, the file that lets an iPhone
    /// skip it, and each app's registration — and each must say them as
    /// this file does.
    #[test]
    fn everything_that_says_where_a_link_goes_says_it_as_this_does() {
        let page = include_str!("../../../site/public/open.html");
        assert!(page.contains(&format!("\"{}://open\"", SCHEME)), "open.html hands a link on as {}://open", SCHEME);
        assert!(page.contains("\"/app#\""), "open.html sends a browser to the domain's /app");
        let browser = include_str!("../../../src/web/address.ts");
        assert!(browser.contains(&format!("const PAGE = \"{}\";", PAGE)), "the browser version makes a link at {}", PAGE);
        for key in ["\"d\"", "\"w\"", "\"f\""] {
            assert!(page.contains(&format!("link.get({})", key)), "open.html reads {}", key);
            assert!(browser.contains(&format!("link.get({})", key)), "the browser version reads {}", key);
        }
        let scheme = format!("<string>{}</string>", SCHEME);
        assert!(include_str!("../../../src-tauri/Info.plist").contains(&scheme), "the Mac app is registered for it");
        assert!(include_str!("../../../ios/Info.plist").contains(&scheme), "the iPhone app is registered for it");
        let cli = include_str!("../../../cli/src/link.rs");
        assert!(cli.contains(&format!("\"{}\"", PAGE)) && cli.contains(&format!("\"{}://open\"", SCHEME)), "the CLI reads a link as this does");
        let phone = include_str!("../../../ios/DoklinKit/Sources/DoklinKit/Models/Workspaces.swift");
        assert!(
            phone.contains(&format!("== \"{}\"", HOST)) && phone.contains(&format!("[\"{}\", \"{}/\"]", PATH, PATH)) && phone.contains(&format!("case \"{}\":", SCHEME)),
            "the iPhone tells a link from a web page as this does"
        );
        let entitlements = include_str!("../../../ios/Doklin.entitlements");
        assert!(entitlements.contains(&format!("<string>applinks:{}</string>", HOST)), "the iPhone app claims {}", HOST);

        // Apple's file names the app as the Xcode project does: team, then bundle id.
        let project = include_str!("../../../ios/Doklin.xcodeproj/project.pbxproj");
        let setting = |key: &str| {
            project
                .lines()
                .filter_map(|line| line.trim().strip_prefix(&format!("{} = ", key)))
                .map(|value| value.trim_end_matches(';').to_string())
                .find(|value| !value.ends_with(".uitests"))
                .unwrap_or_else(|| panic!("no {} in the Xcode project", key))
        };
        let app = format!("{}.{}", setting("DEVELOPMENT_TEAM"), setting("PRODUCT_BUNDLE_IDENTIFIER"));
        let association: serde_json::Value =
            serde_json::from_str(include_str!("../../../site/public/.well-known/apple-app-site-association")).unwrap();
        let details = &association["applinks"]["details"][0];
        assert_eq!(details["appIDs"], serde_json::json!([app]));
        let paths: Vec<&str> = details["components"].as_array().unwrap().iter().filter_map(|c| c["/"].as_str()).collect();
        assert!(paths.contains(&PATH), "the association file sends {} to the app: {:?}", PATH, paths);
        assert_eq!(PAGE, format!("https://{}{}", HOST, PATH));
    }

    /// The page links go through offers the browser version to the devices
    /// the browser version itself lets in: one question, asked in two files.
    #[test]
    fn the_link_page_calls_a_phone_what_the_browser_version_does() {
        fn said(source: &str, statement: &str) -> String {
            let from = source.find(statement).unwrap_or_else(|| panic!("no `{}`", statement));
            let to = from + source[from..].find(';').unwrap();
            source[from..to].split_whitespace().collect::<Vec<_>>().join(" ")
        }
        let page = include_str!("../../../site/public/open.html");
        let gate = include_str!("../../../src/web/gate.js");
        for statement in ["var short =", "var handheld ="] {
            assert_eq!(said(page, statement), said(gate, statement), "open.html and gate.js: change both");
        }
    }

    #[test]
    fn anything_else_is_not_a_link() {
        for text in [
            "",
            "doklin.cc/open#d=notes.example.com&w=w-0a1b2c3d4e5f&f=f-9c8b7a6d5e4f",
            "https://doklin.cc/open",
            "https://doklin.cc/open#",
            "https://doklin.cc/#d=notes.example.com&w=w-0a1b2c3d4e5f&f=f-9c8b7a6d5e4f",
            "https://doklin.cc/opener#d=notes.example.com&w=w-0a1b2c3d4e5f&f=f-9c8b7a6d5e4f",
            "https://doklin.cc:8443/open#d=notes.example.com&w=w-0a1b2c3d4e5f&f=f-9c8b7a6d5e4f",
            "https://evil.example/open#d=notes.example.com&w=w-0a1b2c3d4e5f&f=f-9c8b7a6d5e4f",
            "https://notes.example.com/open#d=notes.example.com&w=w-0a1b2c3d4e5f&f=f-9c8b7a6d5e4f",
            "doklin://join#d=notes.example.com&w=w-0a1b2c3d4e5f&f=f-9c8b7a6d5e4f",
            "mailto:open#d=notes.example.com&w=w-0a1b2c3d4e5f&f=f-9c8b7a6d5e4f",
            // Missing what it needs, or not what an id looks like.
            "https://doklin.cc/open#d=notes.example.com&w=w-0a1b2c3d4e5f",
            "https://doklin.cc/open#w=w-0a1b2c3d4e5f&f=f-9c8b7a6d5e4f",
            "https://doklin.cc/open#d=notes.example.com&f=f-9c8b7a6d5e4f",
            "https://doklin.cc/open#d=notes.example.com&w=W-0A&f=f-9c8b7a6d5e4f",
            "https://doklin.cc/open#d=notes.example.com&w=w-0a1b2c3d4e5f&f=..%2Fsecret",
            "https://doklin.cc/open#d=notes.example.com&w=w-0a1b2c3d4e5f&s=Finance&f=f-9c8b7a6d5e4f",
            "https://doklin.cc/open#d=notes.example.com%2Fx&w=w-0a1b2c3d4e5f&f=f-9c8b7a6d5e4f",
            "https://doklin.cc/open#d=-bad-.example.com&w=w-0a1b2c3d4e5f&f=f-9c8b7a6d5e4f",
        ] {
            assert_eq!(PageLink::parse(text), None, "{}", text);
        }
    }
}
