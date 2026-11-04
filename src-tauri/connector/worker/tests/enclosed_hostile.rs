//! Hostile components through the real supervisor and enclosure (Windows).
//! They exercise the worker's limits more than the enclosure, so they live
//! apart from `sandbox.rs`, which the Windows mutation run uses.
#![cfg(windows)]

mod common;

use common::{component, header, request};
use nemein_connector::frame::{self, Frame, Kind};
use nemein_connector::protocol::{code, Op};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const SUPERVISOR: &str = env!("CARGO_BIN_EXE_nemein-connector");

fn run(request: &Frame, args: &[&str]) -> (Frame, Duration) {
    let started = Instant::now();
    let mut child = Command::new(SUPERVISOR)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    frame::write(child.stdin.as_mut().unwrap(), Kind::Request, request).unwrap();
    let answer =
        frame::read(child.stdout.as_mut().unwrap(), Kind::Response).expect("one response frame");
    drop(child.stdin.take());
    assert_eq!(child.wait().unwrap().code(), Some(0));
    (answer, started.elapsed())
}

fn host_code(frame: &Frame) -> String {
    let h = header(frame);
    assert_eq!(h["status"], "host_error", "{h}");
    h["code"].as_str().unwrap().to_owned()
}

#[test]
fn hostile_components_are_contained() {
    let hostile = component("nemein-fixture-hostile");
    let deadline = ["--deadline-ms", "3000"];
    let hang = request(Op::Parse, hostile.clone(), Vec::new(), "hang", "1");
    let (answer, elapsed) = run(&hang, &deadline);
    assert_eq!(host_code(&answer), code::TIMEOUT);
    assert!(elapsed < Duration::from_secs(8), "{elapsed:?}");

    let blocked = request(
        Op::Describe,
        component("nemein-fixture-hostile-describe"),
        Vec::new(),
        "",
        "1",
    );
    assert_eq!(host_code(&run(&blocked, &deadline).0), code::TIMEOUT);

    assert_eq!(
        host_code(
            &run(
                &request(Op::Parse, hostile.clone(), Vec::new(), "grow", "1"),
                &[]
            )
            .0
        ),
        code::CONNECTOR_TRAP
    );
    assert_eq!(
        host_code(
            &run(
                &request(Op::Parse, hostile.clone(), Vec::new(), "huge", "1"),
                &[]
            )
            .0
        ),
        code::OUTPUT_TOO_LARGE
    );
    assert_eq!(
        host_code(
            &run(
                &request(Op::Parse, hostile.clone(), Vec::new(), "host-alloc", "1"),
                &[]
            )
            .0
        ),
        code::CONNECTOR_TRAP
    );
    let manifest = request(
        Op::Describe,
        component("nemein-fixture-hostile-manifest"),
        Vec::new(),
        "",
        "1",
    );
    assert_eq!(host_code(&run(&manifest, &[]).0), code::MANIFEST_TOO_LARGE);
    let invalid = run(
        &request(Op::Parse, hostile, Vec::new(), "invalid", "1"),
        &[],
    )
    .0;
    assert_eq!(header(&invalid)["status"], "ok");
    assert_eq!(invalid.blobs[0], b"esto no es JSON");
}
