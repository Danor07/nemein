//! The supervisor's protocol against a misbehaving worker, on any platform.
//! The worker here is the unenclosed test double; the Windows enclosure has
//! its own tests in `sandbox.rs`.

mod common;

use common::{component, fixture, header, request, ProcessWorker};
use nemein_connector::protocol::{code, Op};
use nemein_connector::supervise::{supervise, Event, Worker};
use std::sync::mpsc;
use std::time::{Duration, Instant};

fn run(
    mode: &str,
    frame: &nemein_connector::frame::Frame,
    deadline: Duration,
) -> (Option<nemein_connector::frame::Frame>, Duration) {
    let (sender, events) = mpsc::channel();
    let start = Instant::now();
    let mode = mode.to_owned();
    let out = supervise(
        frame,
        move || ProcessWorker::start(&mode),
        deadline,
        events,
        sender,
    );
    (out, start.elapsed())
}

fn host_code(frame: &nemein_connector::frame::Frame) -> String {
    let h = header(frame);
    assert_eq!(h["status"], "host_error", "{h}");
    h["code"].as_str().unwrap().to_owned()
}

fn small_request() -> nemein_connector::frame::Frame {
    request(
        Op::Describe,
        b"not a component".to_vec(),
        Vec::new(),
        "",
        "1",
    )
}

#[test]
fn relays_a_real_run() {
    let frame = request(
        Op::Parse,
        component("nemein-example-bank-csv"),
        fixture("extracto.csv"),
        "",
        "1",
    );
    let (out, _) = run("execute", &frame, Duration::from_secs(10));
    let out = out.unwrap();
    assert_eq!(header(&out)["status"], "ok");
    assert_eq!(
        format!("{}\n", String::from_utf8(out.blobs[0].clone()).unwrap()),
        String::from_utf8(fixture("extracto.batch.json")).unwrap()
    );
}

#[test]
fn a_hanging_worker_times_out_and_is_killed() {
    let deadline = Duration::from_millis(400);
    let (out, elapsed) = run("hang", &small_request(), deadline);
    assert_eq!(host_code(&out.unwrap()), code::TIMEOUT);
    assert!(
        elapsed >= deadline && elapsed < deadline + Duration::from_secs(2),
        "{elapsed:?}"
    );
}

#[test]
fn a_worker_that_never_reads_cannot_block_the_supervisor() {
    // A full-size component does not fit any pipe buffer.
    let big = request(
        Op::Describe,
        vec![0u8; nemein_connector::limits::COMPONENT_MAX],
        Vec::new(),
        "",
        "1",
    );
    let (out, elapsed) = run("ignore", &big, Duration::from_millis(400));
    assert_eq!(host_code(&out.unwrap()), code::TIMEOUT);
    assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
}

#[test]
fn exits_and_truncations_are_crashes() {
    for mode in ["exit", "truncate"] {
        let (out, _) = run(mode, &small_request(), Duration::from_secs(5));
        assert_eq!(host_code(&out.unwrap()), code::WORKER_CRASHED, "{mode}");
    }
}

#[test]
fn oversized_or_garbage_answers_are_protocol_errors_without_reading_them() {
    for mode in ["huge", "garbage"] {
        let (out, elapsed) = run(mode, &small_request(), Duration::from_secs(5));
        assert_eq!(host_code(&out.unwrap()), code::WORKER_PROTOCOL, "{mode}");
        // Refused at the declared length, not after reading 24 MiB.
        assert!(elapsed < Duration::from_secs(3), "{mode}: {elapsed:?}");
    }
}

#[test]
fn cancellation_returns_nothing_and_kills_the_worker() {
    let (sender, events) = mpsc::channel();
    sender.send(Event::Cancelled).unwrap();
    let pid = std::sync::Arc::new(std::sync::Mutex::new(None));
    let seen = pid.clone();
    let out = supervise(
        &small_request(),
        move || {
            let worker = ProcessWorker::start("hang")?;
            *seen.lock().unwrap() = Some(());
            Ok(worker)
        },
        Duration::from_secs(5),
        events,
        sender,
    );
    assert!(out.is_none());
    assert!(pid.lock().unwrap().is_some());
}

#[test]
fn a_worker_that_cannot_be_enclosed_does_not_run() {
    let (sender, events) = mpsc::channel();
    let out = supervise(
        &small_request(),
        || -> Result<Box<dyn Worker>, String> { Err("sin AppContainer".into()) },
        Duration::from_secs(5),
        events,
        sender,
    );
    let out = out.unwrap();
    assert_eq!(host_code(&out), code::SANDBOX_UNAVAILABLE);
    assert_eq!(header(&out)["message"], "sin AppContainer");
}

#[test]
fn the_deadline_includes_process_start() {
    let (sender, events) = mpsc::channel();
    let start = Instant::now();
    let out = supervise(
        &small_request(),
        || {
            std::thread::sleep(Duration::from_millis(300));
            ProcessWorker::start("hang")
        },
        Duration::from_millis(400),
        events,
        sender,
    );
    assert_eq!(host_code(&out.unwrap()), code::TIMEOUT);
    // 300 ms of start-up left about 100 ms for the rest.
    assert!(
        start.elapsed() < Duration::from_millis(1_500),
        "{:?}",
        start.elapsed()
    );
}

#[test]
fn hanging_connectors_time_out_in_parse_and_in_describe() {
    let deadline = Duration::from_millis(1_500);
    let hang = request(
        Op::Parse,
        component("nemein-fixture-hostile"),
        Vec::new(),
        "hang",
        "1",
    );
    let (out, elapsed) = run("execute", &hang, deadline);
    assert_eq!(host_code(&out.unwrap()), code::TIMEOUT);
    assert!(elapsed < deadline + Duration::from_secs(2), "{elapsed:?}");
    let blocked = request(
        Op::Describe,
        component("nemein-fixture-hostile-describe"),
        Vec::new(),
        "",
        "1",
    );
    let (out, _) = run("execute", &blocked, deadline);
    assert_eq!(host_code(&out.unwrap()), code::TIMEOUT);
}

/// A component whose core module is one huge function: compiling it alone
/// takes longer than a short deadline, and the deadline still holds.
fn pathological_component(instructions: usize) -> Vec<u8> {
    let mut body = String::with_capacity(instructions * 24);
    for _ in 0..instructions {
        body.push_str("local.get 0 i32.const 1 i32.add local.set 0\n");
    }
    wat::parse_str(format!(
        "(component (core module (func (param i32) (local i32 i32) {body})))"
    ))
    .unwrap()
}

#[test]
fn pathological_compilation_is_bounded_by_the_deadline() {
    let bytes = pathological_component(400_000);
    assert!(bytes.len() <= nemein_connector::limits::COMPONENT_MAX);
    let frame = request(Op::Describe, bytes, Vec::new(), "", "1");
    let deadline = Duration::from_millis(250);
    let (out, elapsed) = run("execute", &frame, deadline);
    assert_eq!(host_code(&out.unwrap()), code::TIMEOUT);
    assert!(elapsed < deadline + Duration::from_secs(2), "{elapsed:?}");
}
