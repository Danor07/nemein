//! Guest SDK for `nemein:connector@1.0.0` components.
//!
//! A connector implements [`Guest`] and calls [`export!`] once. It compiles to
//! `wasm32-unknown-unknown`; `nemein-componentize` then wraps the core module as
//! a component without imports. See `docs/conectores.md`.
//!
//! The SDK only builds the batch text. The host remains the single authority: it
//! validates every batch with `validateImportBatch`, the account and the
//! provenance before anything reaches the budget.

#![deny(unsafe_code)]

// Lets the generated paths name this crate the same way from inside and outside.
extern crate self as nemein_connector_sdk;

mod batch;
mod json;

/// Bindings generated from `wit/world.wit`. Public only so [`export!`] can reach
/// them from the connector crate.
#[doc(hidden)]
#[allow(unsafe_code)]
pub mod bindings {
    wit_bindgen::generate!({
        path: "wit",
        world: "connector",
        pub_export_macro: true,
        export_macro_name: "export",
        default_bindings_module: "nemein_connector_sdk::bindings",
        runtime_path: "nemein_connector_sdk::__wit_bindgen::rt",
        additional_derives: [PartialEq, Eq],
    });
}

#[doc(hidden)]
pub use wit_bindgen as __wit_bindgen;

pub use batch::{Batch, Entry, Period};
pub use bindings::export;
pub use bindings::exports::nemein::connector::api::{Context, Error, Guest, Manifest};

use sha2::{Digest, Sha256};

/// Largest integer that JSON numbers carry exactly (`Number.MAX_SAFE_INTEGER`).
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Code for a context the host should never send; reaching it is a host bug.
pub const INVALID_CONTEXT: &str = "CONNECTOR_INVALID_CONTEXT";

/// Builds an [`Error`] with a stable code and a message for the owner.
pub fn error(code: &str, message: impl Into<String>) -> Error {
    Error {
        code: code.to_owned(),
        message: message.into(),
    }
}

/// Reads `context.account-id`: the canonical decimal of a positive safe integer.
///
/// Signs, spaces, leading zeros and values above [`MAX_SAFE_INTEGER`] are
/// rejected instead of normalized, so the batch declares exactly the account the
/// host chose.
pub fn account_id(text: &str) -> Result<u64, Error> {
    let bytes = text.as_bytes();
    let canonical = matches!(bytes.first(), Some(b'1'..=b'9'))
        && bytes.len() <= 16
        && bytes.iter().all(u8::is_ascii_digit);
    match text.parse::<u64>() {
        Ok(value) if canonical && value <= MAX_SAFE_INTEGER => Ok(value),
        _ => Err(error(
            INVALID_CONTEXT,
            "La cuenta de destino no es un identificador válido.",
        )),
    }
}

/// Stable movement identity: lower-case hex SHA-256 of the compact JSON array of
/// `parts`, the same bytes as `JSON.stringify(parts)` in JavaScript.
///
/// Include a namespace that never changes between versions, the destination
/// account and the source's own stable reference. Never include the component
/// hash, the connector version, the period or a row position: a new version must
/// recognize what an older one already imported.
pub fn entry_id(parts: &[&str]) -> String {
    let mut text = String::from("[");
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            text.push(',');
        }
        json::push_string(&mut text, part);
    }
    text.push(']');
    hex(&Sha256::digest(text.as_bytes()))
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(DIGITS[usize::from(byte >> 4)]));
        out.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_id_accepts_only_canonical_safe_integers() {
        assert_eq!(account_id("1").unwrap(), 1);
        assert_eq!(account_id("42").unwrap(), 42);
        assert_eq!(account_id("9007199254740991").unwrap(), MAX_SAFE_INTEGER);
        for text in [
            "",
            "0",
            "01",
            "+1",
            "-1",
            " 1",
            "1 ",
            "1.0",
            "1e3",
            "9007199254740992",
            "10000000000000000",
            "99999999999999999999",
            "١",
        ] {
            let failure = account_id(text).unwrap_err();
            assert_eq!(failure.code, INVALID_CONTEXT, "{text:?}");
            assert!(!failure.message.is_empty());
        }
    }

    #[test]
    fn entry_id_hashes_the_json_array() {
        // printf '["a","b"]' | sha256sum, and JSON.stringify in Node.
        assert_eq!(
            entry_id(&["a", "b"]),
            "0473ef2dc0d324ab659d3580c1134e9d812035905c4781fdd6d529b0c6860e13"
        );
        assert_eq!(
            entry_id(&[]),
            "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
        );
        assert_ne!(entry_id(&["a", "b"]), entry_id(&["ab"]));
        assert_ne!(entry_id(&["a,b"]), entry_id(&["a", "b"]));
    }

    #[test]
    fn hex_is_lower_case_and_padded() {
        assert_eq!(hex(&[0x00, 0x0f, 0xa0, 0xff]), "000fa0ff");
    }

    #[test]
    fn error_keeps_code_and_message() {
        let e = error("CONNECTOR_X", "mensaje");
        assert_eq!(
            (e.code.as_str(), e.message.as_str()),
            ("CONNECTOR_X", "mensaje")
        );
    }
}
