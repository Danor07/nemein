//! JSON headers of the request and response frames.
//!
//! Request header: `{"op":"describe"|"parse","config":"…","account_id":"…"}`,
//! blobs `[component, file]` (the file is empty for `describe`).
//!
//! Response header, one of:
//! - `{"status":"ok","manifest":{…}}`, with the batch text as its only blob
//!   for `parse` and no blob for `describe`;
//! - `{"status":"connector_error","manifest":{…},"error":{"code","message"}}`;
//! - `{"status":"host_error","code":"…","message":"…"}`.
//!
//! The Node host treats every response as untrusted: it validates the manifest
//! limits, compares it with the approved one, and validates the batch.

use crate::frame::{Frame, Kind};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Op {
    Describe,
    Parse,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RequestHeader {
    pub op: Op,
    pub config: String,
    pub account_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub id: String,
    pub version: String,
    pub name: String,
    pub description: String,
    pub extensions: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ConnectorError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum ResponseHeader {
    Ok {
        manifest: Manifest,
    },
    ConnectorError {
        manifest: Manifest,
        error: ConnectorError,
    },
    HostError {
        code: String,
        message: String,
    },
}

/// Stable codes of failures outside the connector's own `error` result.
pub mod code {
    pub const REQUEST_INVALID: &str = "REQUEST_INVALID";
    pub const COMPONENT_INVALID: &str = "COMPONENT_INVALID";
    pub const COMPONENT_HAS_IMPORTS: &str = "COMPONENT_HAS_IMPORTS";
    pub const COMPONENT_WRONG_WORLD: &str = "COMPONENT_WRONG_WORLD";
    pub const CONNECTOR_TRAP: &str = "CONNECTOR_TRAP";
    pub const MANIFEST_TOO_LARGE: &str = "MANIFEST_TOO_LARGE";
    pub const ERROR_TOO_LARGE: &str = "ERROR_TOO_LARGE";
    pub const OUTPUT_TOO_LARGE: &str = "OUTPUT_TOO_LARGE";
    pub const TIMEOUT: &str = "TIMEOUT";
    pub const MEMORY_LIMIT: &str = "MEMORY_LIMIT";
    pub const WORKER_CRASHED: &str = "WORKER_CRASHED";
    pub const WORKER_PROTOCOL: &str = "WORKER_PROTOCOL";
    pub const SANDBOX_UNAVAILABLE: &str = "SANDBOX_UNAVAILABLE";
    pub const UNSUPPORTED_PLATFORM: &str = "UNSUPPORTED_PLATFORM";
}

/// Longest host error message, so a header always fits its frame.
const HOST_MESSAGE_MAX: usize = 512;

fn response(header: &ResponseHeader, blob: Option<Vec<u8>>) -> Frame {
    // Serializing these plain structs cannot fail.
    let header = serde_json::to_vec(header).unwrap_or_default();
    Frame {
        header,
        blobs: blob.into_iter().collect(),
    }
}

/// A host failure, with its message cut to a bounded length on a char boundary.
pub fn host_error(code: &str, message: &str) -> Frame {
    let message: String = message.chars().take(HOST_MESSAGE_MAX).collect();
    response(
        &ResponseHeader::HostError {
            code: code.to_owned(),
            message,
        },
        None,
    )
}

pub fn ok(manifest: Manifest, batch: Option<String>) -> Frame {
    response(
        &ResponseHeader::Ok { manifest },
        batch.map(String::into_bytes),
    )
}

pub fn connector_error(manifest: Manifest, error: ConnectorError) -> Frame {
    response(&ResponseHeader::ConnectorError { manifest, error }, None)
}

/// The request frame Node writes; also used by tests.
pub fn request(header: &RequestHeader, component: Vec<u8>, input: Vec<u8>) -> Frame {
    Frame {
        header: serde_json::to_vec(header).unwrap_or_default(),
        blobs: vec![component, input],
    }
}

pub const REQUEST: Kind = Kind::Request;
pub const RESPONSE: Kind = Kind::Response;

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> Manifest {
        Manifest {
            id: "a.b".into(),
            version: "1".into(),
            name: "n".into(),
            description: String::new(),
            extensions: vec!["csv".into()],
        }
    }

    #[test]
    fn headers_have_the_documented_shape() {
        let ok = ok(manifest(), Some("{}".into()));
        assert_eq!(
            String::from_utf8(ok.header).unwrap(),
            r#"{"status":"ok","manifest":{"id":"a.b","version":"1","name":"n","description":"","extensions":["csv"]}}"#
        );
        assert_eq!(ok.blobs, vec![b"{}".to_vec()]);
        let failure = connector_error(
            manifest(),
            ConnectorError {
                code: "X".into(),
                message: "m".into(),
            },
        );
        assert!(String::from_utf8(failure.header)
            .unwrap()
            .starts_with(r#"{"status":"connector_error","#));
        let host = host_error(code::TIMEOUT, "t");
        assert_eq!(
            String::from_utf8(host.header).unwrap(),
            r#"{"status":"host_error","code":"TIMEOUT","message":"t"}"#
        );
        assert!(host.blobs.is_empty());
    }

    #[test]
    fn host_messages_are_bounded_on_char_boundaries() {
        let long = "é".repeat(HOST_MESSAGE_MAX + 10);
        let frame = host_error(code::COMPONENT_INVALID, &long);
        let header: ResponseHeader = serde_json::from_slice(&frame.header).unwrap();
        match header {
            ResponseHeader::HostError { message, .. } => {
                assert_eq!(message.chars().count(), HOST_MESSAGE_MAX)
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn request_header_rejects_unknown_fields_and_ops() {
        let parse = |text: &str| serde_json::from_str::<RequestHeader>(text);
        assert!(parse(r#"{"op":"parse","config":"","account_id":"1"}"#).is_ok());
        assert!(parse(r#"{"op":"describe","config":"","account_id":"1"}"#).is_ok());
        assert!(parse(r#"{"op":"run","config":"","account_id":"1"}"#).is_err());
        assert!(parse(r#"{"op":"parse","config":"","account_id":"1","extra":1}"#).is_err());
        assert!(parse(r#"{"op":"parse","config":""}"#).is_err());
    }
}
