//! The real Windows enclosure: AppContainer (LPAC), Job and pipes. These tests
//! run only on Windows (CI job `Connector sandbox (Windows)`). All data is
//! fictitious and lives in temporary folders.
#![cfg(windows)]

mod common;

use common::{component, fixture, header, request};
use nemein_connector::frame::{self, Frame, Kind};
use nemein_connector::protocol::{code, Op};
use nemein_connector::sandbox;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
};

const SUPERVISOR: &str = env!("CARGO_BIN_EXE_nemein-connector");
const PROBE: &str = env!("CARGO_BIN_EXE_connector-sandbox-probe");

fn temp(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Starts the real supervisor, writes `request` and keeps stdin open.
fn start(request: &Frame, args: &[&str]) -> Child {
    let mut child = Command::new(SUPERVISOR)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    frame::write(child.stdin.as_mut().unwrap(), Kind::Request, request).unwrap();
    child
}

/// Runs one request through the real supervisor and returns its answer.
fn run(request: &Frame, args: &[&str]) -> (Frame, Duration) {
    let started = Instant::now();
    let mut child = start(request, args);
    let answer =
        frame::read(child.stdout.as_mut().unwrap(), Kind::Response).expect("one response frame");
    drop(child.stdin.take());
    let status = child.wait().unwrap();
    assert_eq!(status.code(), Some(0), "the supervisor answered");
    (answer, started.elapsed())
}

fn host_code(frame: &Frame) -> String {
    let h = header(frame);
    assert_eq!(h["status"], "host_error", "{h}");
    h["code"].as_str().unwrap().to_owned()
}

/// Direct children of `parent` named `nemein-connector.exe`.
fn children_of(parent: u32) -> Vec<u32> {
    let wanted: Vec<u16> = "nemein-connector.exe".encode_utf16().collect();
    let mut found = Vec::new();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more {
            let name_len = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            if entry.th32ParentProcessID == parent && entry.szExeFile[..name_len] == wanted[..] {
                found.push(entry.th32ProcessID);
            }
            more = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
    }
    found
}

/// True when `pid` is gone or ends within `wait`.
fn gone_within(pid: u32, wait: Duration) -> bool {
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return true;
        }
        let ended = WaitForSingleObject(handle, wait.as_millis() as u32) == WAIT_OBJECT_0;
        CloseHandle(handle);
        ended
    }
}

fn wait_for_child(parent: u32) -> u32 {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(pid) = children_of(parent).first() {
            return *pid;
        }
        assert!(Instant::now() < deadline, "the worker never started");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn the_example_runs_enclosed_and_answers_the_golden_batch() {
    let frame = request(
        Op::Parse,
        component("nemein-example-bank-csv"),
        fixture("extracto.csv"),
        "",
        "1",
    );
    let (answer, elapsed) = run(&frame, &[]);
    let h = header(&answer);
    assert_eq!(h["status"], "ok", "{h}");
    assert_eq!(
        format!("{}\n", String::from_utf8(answer.blobs[0].clone()).unwrap()),
        String::from_utf8(fixture("extracto.batch.json")).unwrap()
    );
    eprintln!("enclosed run of the example: {elapsed:?}");
}

#[test]
fn the_probe_is_denied_everything_enclosed_and_allowed_without_the_enclosure() {
    let secret_dir = temp("probe-secret");
    let secret = secret_dir.join("extracto-ficticio.txt");
    std::fs::write(&secret, "Banco Ficticio: saldo ficticio 1.000").unwrap();
    let writable = temp("probe-writable");
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port().to_string();
    let args = [
        secret.to_str().unwrap(),
        writable.to_str().unwrap(),
        port.as_str(),
    ];

    // Positive control: the same probe, unenclosed, can do all of it.
    let control = Command::new(PROBE).args(args).output().unwrap();
    let control: serde_json::Value = serde_json::from_slice(&control.stdout).unwrap();
    for capability in ["read", "write", "network", "process"] {
        assert_eq!(
            control[capability], "allowed",
            "control: {capability}: {control}"
        );
    }
    let _ = std::fs::remove_file(writable.join("probe-wrote-here.txt"));

    let mut enclosed =
        sandbox::spawn(Path::new(PROBE), &args, 256 * 1024 * 1024).expect("enclosed probe");
    drop(enclosed.take_stdin());
    let mut out = String::new();
    enclosed.take_stdout().read_to_string(&mut out).unwrap();
    enclosed.kill();
    let report: serde_json::Value =
        serde_json::from_str(&out).unwrap_or_else(|_| panic!("probe output: {out:?}"));
    for capability in ["read", "write", "network", "process"] {
        assert_eq!(
            report[capability], "denied",
            "enclosed: {capability}: {report}"
        );
    }
    assert_eq!(report["environment"], 1, "only SystemRoot: {report}");
    assert!(!writable.join("probe-wrote-here.txt").exists());
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

#[test]
fn the_memory_limit_is_reported() {
    // Compiling a large component needs far more than 24 MiB of commit.
    let mut body = String::new();
    for _ in 0..200_000 {
        body.push_str("local.get 0 i32.const 1 i32.add local.set 0\n");
    }
    let big = wat::parse_str(format!(
        "(component (core module (func (param i32) (local i32 i32) {body})))"
    ))
    .unwrap();
    let frame = request(Op::Describe, big, Vec::new(), "", "1");
    let (answer, _) = run(&frame, &["--memory-mb", "24"]);
    assert_eq!(host_code(&answer), code::MEMORY_LIMIT);
}

#[test]
fn the_worker_refuses_to_run_without_the_enclosure() {
    let mut child = Command::new(SUPERVISOR)
        .arg("worker")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let frame = request(
        Op::Describe,
        component("nemein-example-bank-csv"),
        Vec::new(),
        "",
        "1",
    );
    let _ = frame::write(child.stdin.as_mut().unwrap(), Kind::Request, &frame);
    let answer = frame::read(child.stdout.as_mut().unwrap(), Kind::Response).unwrap();
    assert_eq!(host_code(&answer), code::SANDBOX_UNAVAILABLE);
    assert_eq!(child.wait().unwrap().code(), Some(3));
}

#[test]
fn killing_the_supervisor_kills_the_worker() {
    let hang = request(
        Op::Parse,
        component("nemein-fixture-hostile"),
        Vec::new(),
        "hang",
        "1",
    );
    let mut supervisor = start(&hang, &[]);
    let worker = wait_for_child(supervisor.id());
    assert!(
        !gone_within(worker, Duration::from_millis(300)),
        "the worker is running"
    );
    supervisor.kill().unwrap();
    let _ = supervisor.wait();
    assert!(
        gone_within(worker, Duration::from_secs(5)),
        "KILL_ON_JOB_CLOSE ended the worker"
    );
}

#[test]
fn closing_stdin_cancels_the_run_and_kills_the_worker() {
    let hang = request(
        Op::Parse,
        component("nemein-fixture-hostile"),
        Vec::new(),
        "hang",
        "1",
    );
    let mut supervisor = start(&hang, &[]);
    let worker = wait_for_child(supervisor.id());
    let started = Instant::now();
    drop(supervisor.stdin.take());
    let status = supervisor.wait().unwrap();
    assert_eq!(status.code(), Some(1), "cancelled, nothing written");
    assert!(started.elapsed() < Duration::from_secs(5));
    let mut rest = Vec::new();
    supervisor
        .stdout
        .take()
        .unwrap()
        .read_to_end(&mut rest)
        .unwrap();
    assert!(rest.is_empty());
    assert!(gone_within(worker, Duration::from_secs(5)));
}

#[test]
fn rights_are_granted_on_the_binary_and_its_folder_only() {
    // Any enclosed run grants them; the data-like folder next to it gets none.
    let _ = run(
        &request(
            Op::Describe,
            component("nemein-example-bank-csv"),
            Vec::new(),
            "",
            "1",
        ),
        &[],
    );
    let sid = sandbox::container_sid().unwrap();
    let binary = std::fs::canonicalize(SUPERVISOR).unwrap();
    let folder = binary.parent().unwrap();
    let read_execute = 0x1200a9; // FILE_GENERIC_READ | FILE_GENERIC_EXECUTE
    assert_eq!(
        sandbox::effective_rights(&binary, &sid).unwrap() & read_execute,
        read_execute
    );
    assert_eq!(
        sandbox::effective_rights(folder, &sid).unwrap() & read_execute,
        read_execute
    );
    let data = temp("presupuesto-ficticio");
    std::fs::write(data.join("budget.db"), b"ficticio").unwrap();
    assert_eq!(sandbox::effective_rights(&data, &sid).unwrap(), 0);
    assert_eq!(
        sandbox::effective_rights(&data.join("budget.db"), &sid).unwrap(),
        0
    );
    // Not inherited: a new file next to the binary is not readable by the worker.
    let neighbour = folder.join("neighbour-ficticio.txt");
    std::fs::write(&neighbour, b"x").unwrap();
    assert_eq!(
        sandbox::effective_rights(&neighbour, &sid).unwrap() & read_execute,
        0
    );
    let _ = std::fs::remove_file(neighbour);
}

#[test]
fn oversized_and_truncated_requests_are_refused_by_the_supervisor() {
    let mut child = Command::new(SUPERVISOR)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(b"NMC\x01Q\xff\xff\xff\xff").unwrap();
    drop(stdin);
    let answer = frame::read(child.stdout.as_mut().unwrap(), Kind::Response).unwrap();
    assert_eq!(host_code(&answer), code::REQUEST_INVALID);
    assert_eq!(child.wait().unwrap().code(), Some(2));

    let mut child = Command::new(SUPERVISOR)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut whole = Vec::new();
    frame::write(
        &mut whole,
        Kind::Request,
        &request(Op::Describe, b"x".to_vec(), Vec::new(), "", "1"),
    )
    .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(&whole[..whole.len() - 1]).unwrap();
    drop(stdin);
    let answer = frame::read(child.stdout.as_mut().unwrap(), Kind::Response).unwrap();
    assert_eq!(host_code(&answer), code::REQUEST_INVALID);
    assert_eq!(child.wait().unwrap().code(), Some(2));
}
