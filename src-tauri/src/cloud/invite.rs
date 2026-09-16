//! The invite code and the paste blob (docs/teams-plan.md §3.1, §10): the
//! grammar both ends of an invite agree on, and the only place this app ever
//! holds a code in the clear.
//!
//! A code is a **capability, not a passphrase**: 100 bits, one-time,
//! expiring, carrying no identity of its own. At 100 bits guessing is off
//! the table rather than throttled, which is what lets the design do without
//! an attempt cap, a lockout and the counter to store them. Entropy is free;
//! a counter is not.
//!
//! The email is the identity and never the secret; the code is the secret
//! and never the identity. Nothing here writes a code to disk: it is minted,
//! shown once, hashed, and the hash is all that goes up — a worker log, a D1
//! backup and the request body are all incapable of letting anyone in.
//!
//! [`normalize_code`] is mirrored by `normalizeCode` in
//! cloud-worker/src/members.ts — the app hashes the canonical form when it
//! mints an invite and the worker hashes the canonical form when it redeems
//! one, so the two must agree character for character. **Change both.**

use serde::Serialize;

use super::config::normalize_endpoint;
use crate::versions::store::hash_full;

/// Crockford's base32: no I, no L, no O, no U. A code cannot spell a word,
/// and the letters that get read back as digits are simply not in it — I and
/// L are 1, O is 0, which is the whole reason he dropped them.
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// 20 characters × 5 bits = 100 bits.
const CODE_LEN: usize = 20;
/// Written in groups of five, the way a licence key is.
const GROUP: usize = 5;
/// What a code announces itself as, so the app knows one by looking at it
/// and a leaked one is greppable.
const PREFIX: &str = "dkln";
/// The word a blob opens with. Deliberately not a URL scheme: nothing is
/// registered to open it, and a link that goes nowhere is worse than a line
/// of text that says what it is (§10 — a `doklin://` link is not the route).
const KEYWORD: &str = "doklin-invite";

/// How long a fresh invite is good for when nobody says otherwise.
pub const DEFAULT_DAYS: u32 = 7;
/// The worker refuses anything dated further out than this
/// (`MAX_INVITE_TTL_MS` in cloud-worker/src/members.ts — change both): a
/// year of "pending" is not a pending invite, it is a credential nobody is
/// watching.
pub const MAX_DAYS: u32 = 30;

const DAY_MS: u64 = 24 * 60 * 60 * 1000;

/// A fresh code in its canonical form — the twenty characters, uppercase.
///
/// Thirteen bytes of randomness, of which the first 100 bits become the
/// twenty characters: every five-bit slice of a uniform byte string is
/// itself uniform, so there is no modulo bias here to reject-sample away.
pub fn random_code() -> String {
    let mut buf = [0u8; 13];
    let _ = getrandom::getrandom(&mut buf);
    (0..CODE_LEN)
        .map(|i| {
            let bit = i * 5;
            let window = (u16::from(buf[bit / 8]) << 8) | u16::from(buf[bit / 8 + 1]);
            ALPHABET[usize::from((window >> (11 - bit % 8)) & 31)] as char
        })
        .collect()
}

/// A canonical code as it is written and read aloud:
/// `dkln-K7QM2-9XVR4-8TBHN-3WGYD`.
pub fn format_code(canonical: &str) -> String {
    let chars: Vec<char> = canonical.chars().collect();
    let groups: Vec<String> = chars.chunks(GROUP).map(|g| g.iter().collect()).collect();
    format!("{}-{}", PREFIX, groups.join("-"))
}

/// A code as it is hashed: the twenty characters, uppercase, no prefix and
/// no separators. `dkln-K7QM2-9XVR4-8TBHN-3WGYD`, `dkln k7qm2 9xvr4 8tbhn
/// 3wgyd` and the bare twenty all canonicalize to the same string, so a code
/// that survived an autocorrect, a line wrap or a spreadsheet still redeems.
/// None when it is not a code at all.
pub fn normalize_code(raw: &str) -> Option<String> {
    let bare: String =
        raw.trim().to_ascii_uppercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    // The prefix only comes off a string long enough to have carried one. (A
    // bare code can never begin "DKLN" — L is not in the alphabet — but the
    // length says so without leaning on that.)
    let body = if bare.len() == CODE_LEN + PREFIX.len() && bare.starts_with("DKLN") {
        &bare[PREFIX.len()..]
    } else {
        &bare[..]
    };
    if body.len() != CODE_LEN {
        return None;
    }
    let canonical: String = body
        .chars()
        .map(|c| match c {
            'I' | 'L' => '1',
            'O' => '0',
            other => other,
        })
        .collect();
    if canonical.bytes().all(|b| ALPHABET.contains(&b)) {
        Some(canonical)
    } else {
        None
    }
}

/// `sha256(canonical)`, hex — the only form of a code that ever leaves this
/// Mac, and what the worker stores.
pub fn code_hash(canonical: &str) -> String {
    hash_full(canonical.as_bytes())
}

/// When an invite minted now runs out, clamped to what the worker accepts.
pub fn expires_at(now_ms: u64, days: Option<u32>) -> u64 {
    now_ms + u64::from(days.unwrap_or(DEFAULT_DAYS).clamp(1, MAX_DAYS)) * DAY_MS
}

/// The one line the owner sends:
/// `doklin-invite https://notes.example.com dkln-K7QM2-9XVR4-8TBHN-3WGYD`.
///
/// One line, three words, no link to click and nothing a chat client can
/// mangle. The address is written in full because it is the harmless half —
/// following it lands on the workspace's own landing page — while the code
/// beside it is the half that matters.
pub fn blob(endpoint: &str, code: &str) -> String {
    format!("{} {} {}", KEYWORD, endpoint, code)
}

/// The two halves of an invite found in whatever was pasted (docs/cloud.md
/// §6.8). Either may be missing: the wizard fills what it finds and leaves
/// the rest to the person.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pasted {
    pub endpoint: Option<String>,
    pub code: Option<String>,
}

/// Read an invite out of a paste: the blob itself, a whole chat message
/// carrying it, or just one of the two halves on its own.
///
/// Punctuation decides which half a word is, and it has to: strip the dots
/// and slashes out of `https://notes.example.com` and what is left is twenty
/// characters that are all in Crockford's alphabet — a perfectly good
/// *code*. So a word carrying `.`, `/` or `:` is an address and is never
/// read as a code, and a word without them is never read as an address.
pub fn parse_pasted(text: &str) -> Pasted {
    let mut found = Pasted::default();
    for word in text.split_whitespace() {
        // Whatever a sentence wrapped the word in — angle brackets, a comma,
        // the full stop that ends the line — comes off the outside; the
        // colons and slashes inside an address stay.
        let word = word.trim_matches(|c: char| !c.is_ascii_alphanumeric());
        if word.is_empty() || word.eq_ignore_ascii_case(KEYWORD) {
            continue;
        }
        if word.contains(['.', '/', ':']) {
            if found.endpoint.is_none() {
                found.endpoint = normalize_endpoint(word).ok();
            }
        } else if found.code.is_none() {
            found.code = normalize_code(word).map(|c| format_code(&c));
        }
    }
    found
}
