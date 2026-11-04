//! The binary's own checks: off Windows it reads the request and refuses with
//! a clear answer, never running a connector without its enclosure; on every
//! system, bad requests and options are answered before anything runs.

use nemein_connector::frame::{self, Kind};
use nemein_connector::protocol::{self, Op, RequestHeader};
use std::io::Write;
use std::process::{Command, Stdio};

const BINARY: &str = env!("CARGO_BIN_EXE_nemein-connector");

fn run(args: &[&str], input: &[u8]) -> (Option<i32>, serde_json::Value) {
    let mut child = Command::new(BINARY)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let _ = child.stdin.take().unwrap().write_all(input);
    let output = child.wait_with_output().unwrap();
    let answer =
        frame::read(&mut output.stdout.as_slice(), Kind::Response).expect("one response frame");
    (
        output.status.code(),
        serde_json::from_slice(&answer.header).unwrap(),
    )
}

fn valid_request() -> Vec<u8> {
    let header = RequestHeader {
        op: Op::Describe,
        config: String::new(),
        account_id: "1".into(),
    };
    let mut bytes = Vec::new();
    frame::write(
        &mut bytes,
        Kind::Request,
        &protocol::request(&header, b"x".to_vec(), Vec::new()),
    )
    .unwrap();
    bytes
}

#[test]
#[cfg(not(windows))]
fn supervisor_and_worker_refuse_off_windows() {
    for args in [
        &[][..],
        &["worker"],
        &["--deadline-ms", "10"],
        &["--memory-mb", "16"],
    ] {
        let (status, header) = run(args, &valid_request());
        assert_eq!(status, Some(3), "{args:?}");
        assert_eq!(header["code"], "UNSUPPORTED_PLATFORM", "{args:?}");
        assert!(header["message"].as_str().unwrap().contains("Windows"));
    }
}

#[test]
fn bad_requests_and_options_are_answered_before_anything_runs() {
    let (status, header) = run(&[], b"NMC\x01Q\xff\xff\xff\xff");
    assert_eq!(
        (status, header["code"].as_str()),
        (Some(2), Some("REQUEST_INVALID"))
    );
    let truncated = valid_request();
    let (status, _) = run(&[], &truncated[..truncated.len() - 1]);
    assert_eq!(status, Some(2));
    for args in [
        &["--deadline-ms", "0"][..],
        &["--deadline-ms", "10001"],
        &["--memory-mb", "15"],
        &["--memory-mb", "257"],
        &["--memory-mb"],
        &["--memory-mb", "x"],
        &["--other", "1"],
        &["worker", "extra"],
    ] {
        let (status, header) = run(args, &valid_request());
        assert_eq!(status, Some(2), "{args:?}");
        assert_eq!(header["code"], "REQUEST_INVALID", "{args:?}");
    }
}
