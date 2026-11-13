//! The command line, read by hand: a few flags, some of which take a value,
//! and whatever is left. Small enough that a parser crate would be most of
//! the binary, and written here so every refusal is a sentence of our own.

use std::collections::HashMap;

use crate::Failure;

/// What one command accepts beyond the flags every command has.
pub struct Accepts {
    /// Flags that take a value: `--on "…"`, `-m "…"`.
    pub values: &'static [&'static str],
    /// Flags that are simply there or not: `--deep`, `--force`.
    pub switches: &'static [&'static str],
}

/// Flags every command accepts, wherever they appear on the line.
const GLOBAL_VALUES: &[&str] = &["workspace"];
const GLOBAL_SWITCHES: &[&str] = &["json", "dry-run", "help"];

/// The short spellings, and what each one means.
const SHORT: &[(&str, &str)] = &[("w", "workspace"), ("m", "message"), ("o", "output"), ("h", "help")];

#[derive(Debug, Default)]
pub struct Args {
    pub positionals: Vec<String>,
    values: HashMap<String, String>,
    switches: Vec<String>,
}

impl Args {
    pub fn value(&self, name: &str) -> Option<&str> {
        self.values.get(name).map(String::as_str)
    }

    pub fn has(&self, name: &str) -> bool {
        self.switches.iter().any(|s| s == name)
    }

    /// The positional at `i`, or a usage failure that names what is missing.
    pub fn need(&self, i: usize, what: &str) -> Result<&str, Failure> {
        self.positionals.get(i).map(String::as_str).ok_or_else(|| Failure::usage(format!("say {}", what)))
    }

    /// At most `n` positionals — one too many is a typo worth stopping for.
    pub fn at_most(&self, n: usize) -> Result<(), Failure> {
        match self.positionals.get(n) {
            Some(extra) => Err(Failure::usage(format!(
                "\"{}\" is one argument too many — put a name with spaces in quotes",
                extra
            ))),
            None => Ok(()),
        }
    }
}

/// Read `raw` (everything after the command word) against what the command
/// accepts. `--name value`, `--name=value` and the short forms all work, and
/// `--` ends the flags, for a document whose name begins with a dash.
pub fn parse(raw: &[String], accepts: &Accepts) -> Result<Args, Failure> {
    let mut args = Args::default();
    let mut i = 0;
    let mut flags_over = false;
    while i < raw.len() {
        let word = &raw[i];
        i += 1;
        if flags_over || !word.starts_with('-') || word == "-" {
            args.positionals.push(word.clone());
            continue;
        }
        if word == "--" {
            flags_over = true;
            continue;
        }
        let (name, inline) = match word.strip_prefix("--") {
            Some(long) => match long.split_once('=') {
                Some((n, v)) => (n.to_string(), Some(v.to_string())),
                None => (long.to_string(), None),
            },
            None => {
                let short = &word[1..];
                match SHORT.iter().find(|(s, _)| *s == short) {
                    Some((_, long)) => (long.to_string(), None),
                    None => return Err(Failure::usage(format!("there is no {} option", word))),
                }
            }
        };
        let takes_value = GLOBAL_VALUES.contains(&name.as_str()) || accepts.values.contains(&name.as_str());
        let is_switch = GLOBAL_SWITCHES.contains(&name.as_str()) || accepts.switches.contains(&name.as_str());
        if takes_value {
            let value = match inline {
                Some(v) => v,
                None => {
                    let v = raw.get(i).cloned().ok_or_else(|| Failure::usage(format!("--{} needs a value", name)))?;
                    i += 1;
                    v
                }
            };
            args.values.insert(name, value);
        } else if is_switch {
            if inline.is_some() {
                return Err(Failure::usage(format!("--{} takes no value", name)));
            }
            args.switches.push(name);
        } else {
            return Err(Failure::usage(format!("this command has no --{} option", name)));
        }
    }
    Ok(args)
}
