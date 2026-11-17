//! A link to a page — what *Copy link* copies in the app — taken wherever a
//! document is, so a person can hand an agent the link itself, and written
//! from the ids a document's info names, so an agent can hand one back. The
//! format is written down in engine/src/cloud/link.rs (`PAGE`, `SCHEME`, the
//! keys): change both. A link names ids, never a path; the domain says where
//! they lead (`GET find`), so nothing here knows what a section is.

/// The address a link is sent as, before its `#`.
const PAGE: &str = "https://doklin.cc/open";

/// The addresses a link has before its `#`: as it is sent, and as the page
/// at doklin.cc hands it to the app.
const HEADS: &[&str] = &[PAGE, "http://doklin.cc/open", FOR_APP];

/// What the app is handed a link as.
const FOR_APP: &str = "doklin://open";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PageLink {
    pub domain: String,
    pub ws_id: String,
    /// The space the file is in; empty for the shared workspace.
    pub space: String,
    pub file: String,
    /// Everything after the `#`, as it came.
    fragment: String,
}

impl PageLink {
    /// The link to a file of a workspace on `domain`, in `space` ("" — the
    /// shared workspace — has no `s`).
    pub fn new(domain: &str, ws_id: &str, space: &str, file: &str) -> PageLink {
        let domain = domain.to_ascii_lowercase();
        let mut pairs = vec![("d", domain.as_str()), ("w", ws_id)];
        if !space.is_empty() {
            pairs.push(("s", space));
        }
        pairs.push(("f", file));
        let fragment = pairs.iter().map(|(k, v)| format!("{}={}", k, crate::http::encode(v))).collect::<Vec<_>>().join("&");
        PageLink { domain, ws_id: ws_id.to_string(), space: space.to_string(), file: file.to_string(), fragment }
    }

    /// The link as it is sent.
    pub fn url(&self) -> String {
        format!("{}#{}", PAGE, self.fragment)
    }

    /// The link in `text`, with the spaces and angle brackets a chat or a
    /// mail puts around one left off; None for anything else.
    pub fn parse(text: &str) -> Option<PageLink> {
        let text = text.trim();
        let text = text.strip_prefix('<').and_then(|t| t.strip_suffix('>')).unwrap_or(text).trim();
        let (head, fragment) = text.split_once('#')?;
        let head = head.to_ascii_lowercase();
        let head = head.strip_suffix('/').unwrap_or(&head);
        if !HEADS.contains(&head) {
            return None;
        }
        let (mut domain, mut ws_id, mut space, mut file) = (None, None, String::new(), None);
        for pair in fragment.split('&') {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            let value = crate::http::decode(&value.replace('+', " ")).trim().to_string();
            match key {
                "d" => domain = Some(value.to_ascii_lowercase()),
                "w" => ws_id = Some(value),
                "s" => space = value,
                "f" => file = Some(value),
                _ => {}
            }
        }
        let link = PageLink {
            domain: domain.filter(|d| !d.is_empty())?,
            ws_id: ws_id.filter(|w| !w.is_empty())?,
            space,
            file: file.filter(|f| !f.is_empty())?,
            fragment: fragment.to_string(),
        };
        Some(link)
    }

    /// The link as the app takes it from macOS.
    pub fn for_app(&self) -> String {
        format!("{}#{}", FOR_APP, self.fragment)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SENT: &str = "https://doklin.cc/open#d=notes.example.com&w=w-0a1b2c3d4e5f&s=s-1a2b3c4d&f=f-9c8b7a6d5e4f";

    #[test]
    fn a_link_reads_as_the_app_writes_it() {
        let link = PageLink::parse(SENT).unwrap();
        assert_eq!(
            (link.domain.as_str(), link.ws_id.as_str(), link.space.as_str(), link.file.as_str()),
            ("notes.example.com", "w-0a1b2c3d4e5f", "s-1a2b3c4d", "f-9c8b7a6d5e4f")
        );
        assert_eq!(link.for_app(), SENT.replace("https://doklin.cc/open", "doklin://open"));
        let shared = PageLink::parse("doklin://open#d=Notes.Example.com&w=w-0a1b2c3d4e5f&f=f-9c8b7a6d5e4f").unwrap();
        assert_eq!((shared.domain.as_str(), shared.space.as_str()), ("notes.example.com", ""));
        for text in [format!("  <{}>\n", SENT), SENT.replace("/open#", "/open/#"), SENT.replace("https://doklin.cc", "HTTP://DOKLIN.CC")] {
            assert_eq!(PageLink::parse(&text).map(|l| l.file), Some("f-9c8b7a6d5e4f".to_string()), "{}", text);
        }
        let port = PageLink::parse("https://doklin.cc/open#d=127.0.0.1%3A8787&w=w-0a1b2c3d4e5f&f=f-9c8b7a6d5e4f").unwrap();
        assert_eq!(port.domain, "127.0.0.1:8787");
    }

    #[test]
    fn a_link_is_written_as_the_app_writes_it() {
        assert_eq!(PageLink::new("notes.example.com", "w-0a1b2c3d4e5f", "s-1a2b3c4d", "f-9c8b7a6d5e4f").url(), SENT);
        let shared = PageLink::new("Notes.Example.com", "w-0a1b2c3d4e5f", "", "f-9c8b7a6d5e4f");
        assert_eq!(shared.url(), "https://doklin.cc/open#d=notes.example.com&w=w-0a1b2c3d4e5f&f=f-9c8b7a6d5e4f");
        let port = PageLink::new("127.0.0.1:8787", "w-0a1b2c3d4e5f", "p-1a2b3c4d", "f-9c8b7a6d5e4f");
        assert_eq!(port.url(), "https://doklin.cc/open#d=127.0.0.1%3A8787&w=w-0a1b2c3d4e5f&s=p-1a2b3c4d&f=f-9c8b7a6d5e4f");
        for link in [shared, port] {
            assert_eq!(PageLink::parse(&link.url()), Some(link));
        }
    }

    #[test]
    fn a_path_or_another_address_is_no_link() {
        for text in [
            "Projects/plan",
            "Restricted/Deals/q3.md",
            "https://doklin.cc/open",
            "https://doklin.cc/#d=notes.example.com&w=w-0a1b2c3d4e5f&f=f-9c8b7a6d5e4f",
            "https://notes.example.com/open#d=notes.example.com&w=w-0a1b2c3d4e5f&f=f-9c8b7a6d5e4f",
            "https://doklin.cc/open#d=notes.example.com&w=w-0a1b2c3d4e5f",
            "https://doklin.cc/open#w=w-0a1b2c3d4e5f&f=f-9c8b7a6d5e4f",
        ] {
            assert_eq!(PageLink::parse(text), None, "{}", text);
        }
    }
}
