//! Where the local console answers: the same rule as the CLI's `PORT` (apps/cli/lib/paths.ts) —
//! `AGENTS_MULTI_PORT`, then `CLAUDE_MULTI_PORT`, else 7331 — always on 127.0.0.1.

use url::Url;

use crate::amenv::am_var;

pub const DEFAULT_PORT: u16 = 7331;

/// The console's port, from the variables `get` returns. The first variable that is set wins, as in
/// `amEnv()`; a value that is not a port falls back to the default, with a warning.
pub fn port_from(get: impl Fn(&str) -> Option<String>) -> u16 {
    let Some((name, value)) = am_var(&get, "PORT") else {
        return DEFAULT_PORT;
    };
    match value.trim().parse::<u16>() {
        Ok(port) if port != 0 => port,
        _ => {
            eprintln!("agents-multi: {name}={value:?} is not a port, using {DEFAULT_PORT}");
            DEFAULT_PORT
        }
    }
}

/// The console's port, from the environment.
pub fn port() -> u16 {
    port_from(|name| std::env::var(name).ok())
}

/// The console's root URL; its origin is the only remote one the window may show.
pub fn url(port: u16) -> Url {
    Url::parse(&format!("http://127.0.0.1:{port}/")).expect("a loopback URL with a port is valid")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |name| {
            pairs
                .iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    fn default_without_variables() {
        assert_eq!(port_from(env(&[])), 7331);
    }

    #[test]
    fn agents_multi_wins_over_claude_multi() {
        assert_eq!(
            port_from(env(&[
                ("CLAUDE_MULTI_PORT", "7400"),
                ("AGENTS_MULTI_PORT", "7500")
            ])),
            7500
        );
        assert_eq!(port_from(env(&[("CLAUDE_MULTI_PORT", "7400")])), 7400);
    }

    #[test]
    fn invalid_value_falls_back_to_default() {
        assert_eq!(
            port_from(env(&[
                ("AGENTS_MULTI_PORT", "nope"),
                ("CLAUDE_MULTI_PORT", "7400")
            ])),
            7331
        );
        assert_eq!(port_from(env(&[("AGENTS_MULTI_PORT", "0")])), 7331);
        assert_eq!(port_from(env(&[("AGENTS_MULTI_PORT", "70000")])), 7331);
    }

    #[test]
    fn url_is_loopback_root() {
        assert_eq!(url(7331).as_str(), "http://127.0.0.1:7331/");
    }
}
