//! The IPC vectors shared with the Node host (`test/fixtures/connector-frames.json`):
//! Node encodes requests that this crate decodes, and this crate encodes the
//! responses Node decodes.

use nemein_connector::frame::{self, Frame, Kind};
use nemein_connector::protocol::{self, ConnectorError, Manifest, RequestHeader, ResponseHeader};

fn vectors() -> serde_json::Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test/fixtures/connector-frames.json");
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn hex(text: &serde_json::Value) -> Vec<u8> {
    let text = text.as_str().unwrap();
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

#[test]
fn requests_from_node_decode_here() {
    for v in vectors()["request"].as_array().unwrap() {
        let bytes = hex(&v["frame"]);
        let decoded = frame::read(&mut bytes.as_slice(), Kind::Request).unwrap();
        let header: RequestHeader = serde_json::from_slice(&decoded.header).unwrap();
        let expected: RequestHeader = serde_json::from_value(v["header"].clone()).unwrap();
        assert_eq!(header, expected, "{}", v["name"]);
        let blobs: Vec<Vec<u8>> = v["blobs"].as_array().unwrap().iter().map(hex).collect();
        assert_eq!(decoded.blobs, blobs);
        // And this crate writes the same bytes.
        let mut again = Vec::new();
        frame::write(
            &mut again,
            Kind::Request,
            &protocol::request(&header, blobs[0].clone(), blobs[1].clone()),
        )
        .unwrap();
        assert_eq!(again, bytes, "{}", v["name"]);
    }
}

#[test]
fn responses_written_here_are_the_ones_node_reads() {
    for v in vectors()["response"].as_array().unwrap() {
        let header: ResponseHeader = serde_json::from_value(v["header"].clone()).unwrap();
        let blob = v["blobs"]
            .as_array()
            .unwrap()
            .first()
            .map(|b| String::from_utf8(hex(b)).unwrap());
        let built: Frame = match header {
            ResponseHeader::Ok { manifest } => protocol::ok(manifest, blob),
            ResponseHeader::ConnectorError { manifest, error } => {
                protocol::connector_error(Manifest { ..manifest }, ConnectorError { ..error })
            }
            ResponseHeader::HostError { code, message } => protocol::host_error(&code, &message),
        };
        let mut bytes = Vec::new();
        frame::write(&mut bytes, Kind::Response, &built).unwrap();
        assert_eq!(bytes, hex(&v["frame"]), "{}", v["name"]);
    }
}

#[test]
fn invalid_responses_are_refused_here_too() {
    for v in vectors()["invalid_response"].as_array().unwrap() {
        let bytes = hex(&v["frame"]);
        let result = frame::read(&mut bytes.as_slice(), Kind::Response);
        // The supervisor reads one frame and stops: trailing bytes are Node's check.
        if v["name"] == "bytes after the frame" {
            assert!(result.is_ok());
        } else {
            assert!(result.is_err(), "{}", v["name"]);
        }
    }
}
