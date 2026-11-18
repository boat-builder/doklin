//! The invite code and the paste blob: the
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
//! cloud-worker/src/layout.ts — the app hashes the canonical form when it
//! mints an invite and the worker hashes the canonical form when it redeems
//! one, so the two must agree character for character. **Change both.**
//!
//! A browser makes the same codes with no engine behind it
//! (src/web/codes.ts): the alphabet, the prefixes, the two lines and the
//! lifetimes here are written there again, and the tests below read that
//! file. **Change both.**

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
/// of text that says what it is.
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
    code_of(&buf)
}

/// The twenty characters thirteen bytes spell: five bits each, from the
/// first (`codeOf`, src/web/codes.ts — change both).
fn code_of(buf: &[u8; 13]) -> String {
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
    grouped(PREFIX, canonical)
}

/// `<prefix>-XXXXX-XXXXX-XXXXX-XXXXX`: groups of five, the way a licence key
/// is written.
fn grouped(prefix: &str, canonical: &str) -> String {
    let chars: Vec<char> = canonical.chars().collect();
    let groups: Vec<String> = chars.chunks(GROUP).map(|g| g.iter().collect()).collect();
    format!("{}-{}", prefix, groups.join("-"))
}

/* ---------- An agent's login code ---------- */

/// What an agent's login code announces itself as. A different word from an
/// invite's on purpose: the two are redeemed by different routes into
/// different tables, and a code pasted into the wrong one should be told so
/// rather than looked up and missed (`normalizeAgentCode`,
/// cloud-worker/src/agents.ts — change both).
const AGENT_PREFIX: &str = "dkla";

/// How long a login code is good for. Short on purpose: the line it travels
/// in is pasted into chats and prompts, and a code that has been used or has
/// run out is worth nothing to whoever reads the transcript later. The worker
/// accepts up to a day (`MAX_AGENT_CODE_TTL_MS`) only so two clocks that
/// disagree by a few minutes do not refuse each other.
pub const AGENT_CODE_MINUTES: u64 = 60;

/// A canonical code as an agent's login code is written:
/// `dkla-K7QM2-9XVR4-8TBHN-3WGYD`. Minted by [`random_code`] and hashed by
/// [`code_hash`], exactly as an invite is — only the word in front differs.
pub fn format_agent_code(canonical: &str) -> String {
    grouped(AGENT_PREFIX, canonical)
}

/// When a login code minted now runs out.
pub fn agent_code_expires_at(now_ms: u64) -> u64 {
    now_ms + AGENT_CODE_MINUTES * 60 * 1000
}

/// How long a device code is good for. It is made on one device to be pasted
/// on the one beside it, so an hour is already generous; the worker accepts
/// up to a day (`MAX_DEVICE_CODE_TTL_MS`, cloud-worker/src/members.ts) only
/// so two clocks that disagree do not refuse each other.
pub const DEVICE_CODE_MINUTES: u64 = 60;

/// When a device code minted now runs out.
pub fn device_code_expires_at(now_ms: u64) -> u64 {
    now_ms + DEVICE_CODE_MINUTES * 60 * 1000
}

/// The one line the owner hands to whoever sets the bot up — or pastes
/// straight into the agent's chat: `doklin login https://notes.example.com
/// dkla-K7QM2-9XVR4-8TBHN-3WGYD`. It is the command itself, so there is
/// nothing to explain alongside it.
pub fn agent_login_line(endpoint: &str, code: &str) -> String {
    format!("doklin login {} {}", endpoint, code)
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

/// The two halves of an invite found in whatever was pasted.
/// Either may be missing: the wizard fills what it finds and leaves
/// the rest to the person.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pasted {
    pub endpoint: Option<String>,
    pub code: Option<String>,
}

/// Read an invite out of a paste: the blob itself, a whole chat message
/// carrying it, or just one of the two halves on its own. The browser's
/// sign-in reads one the same way (`parsePasted`, src/web/SignIn.tsx):
/// **change both.**
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The bytes whose five-bit groups count from 0 to 19, and the code they
    /// spell. verify-harness/webcodes.test.mjs holds the browser to the same
    /// pair.
    const COUNTING: [u8; 13] = [0x00, 0x44, 0x32, 0x14, 0xC7, 0x42, 0x54, 0xB6, 0x35, 0xCF, 0x84, 0x65, 0x30];

    #[test]
    fn thirteen_bytes_spell_twenty_characters_five_bits_each() {
        assert_eq!(code_of(&COUNTING), "0123456789ABCDEFGHJK");
        assert_eq!(code_of(&[0xFF; 13]), "ZZZZZZZZZZZZZZZZZZZZ");
        assert_eq!(normalize_code(&format_code(&code_of(&COUNTING))).as_deref(), Some("0123456789ABCDEFGHJK"));
    }

    /// A browser makes these codes too: what it was written with is what is
    /// declared above, and the two lines are the two this writes.
    #[test]
    fn a_browser_makes_codes_as_this_does() {
        let web = include_str!("../../../src/web/codes.ts");
        let says = |line: String| assert!(web.contains(&line), "src/web/codes.ts has no `{}`: change both", line);
        says(format!("const ALPHABET = \"{}\";", std::str::from_utf8(ALPHABET).unwrap()));
        says(format!("const CODE_LEN = {};", CODE_LEN));
        says(format!("const GROUP = {};", GROUP));
        says(format!("const PREFIX = \"{}\";", PREFIX));
        says(format!("const AGENT_PREFIX = \"{}\";", AGENT_PREFIX));
        says(format!("const KEYWORD = \"{}\";", KEYWORD));
        says(format!("const DEFAULT_DAYS = {};", DEFAULT_DAYS));
        says(format!("const MAX_DAYS = {};", MAX_DAYS));
        says(format!("const DEVICE_CODE_MINUTES = {};", DEVICE_CODE_MINUTES));
        says(format!("const AGENT_CODE_MINUTES = {};", AGENT_CODE_MINUTES));
        // The lines, as a template string writes what `blob` and
        // `agent_login_line` format.
        let as_template = |line: String| format!("`{}`", line);
        says(as_template(blob("${endpoint}", "${code}").replace(KEYWORD, "${KEYWORD}")));
        says(as_template(agent_login_line("${endpoint}", "${code}")));
    }
}
