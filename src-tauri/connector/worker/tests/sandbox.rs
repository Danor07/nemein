//! The real Windows enclosure: AppContainer (LPAC), Job and pipes. These tests
//! run only on Windows (CI job `Connector sandbox (Windows)`). All data is
//! fictitious and lives in temporary folders.
#![cfg(windows)]

mod common;

use common::{component, fixture, header, request};
use nemein_connector::frame::{self, Frame, Kind};
use nemein_connector::protocol::{code, Op};
use nemein_connector::sandbox;
use nemein_connector::supervise::{Ending, Worker};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::ptr::null_mut;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::JobObjects::IsProcessInJob;
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
};

fn supervisor() -> PathBuf {
    common::bin("nemein-connector")
}

fn probe() -> PathBuf {
    common::bin("connector-sandbox-probe")
}

fn temp(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Starts the real supervisor, writes `request` and keeps stdin open.
fn start(request: &Frame, args: &[&str]) -> Child {
    let mut child = Command::new(supervisor())
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
    let control = Command::new(probe()).args(args).output().unwrap();
    let control: serde_json::Value = serde_json::from_slice(&control.stdout).unwrap_or_else(|e| {
        panic!(
            "control output: {:?} ({e}), status {:?}",
            String::from_utf8_lossy(&control.stdout),
            control.status
        )
    });
    for capability in ["read", "write", "network", "process"] {
        assert_eq!(
            control[capability], "allowed",
            "control: {capability}: {control}"
        );
    }
    let _ = std::fs::remove_file(writable.join("probe-wrote-here.txt"));
    // The control's connection is waiting in the backlog; take it, so the
    // enclosed run is judged on its own.
    drop(listener.accept().unwrap());

    // Positive control for the enclosure report: the probe can tell an
    // AppContainer and the mitigations apart.
    assert_eq!(control["token"]["appcontainer"], 0, "control: {control}");
    assert_eq!(control["token"]["lpac"], 0, "control: {control}");
    assert_eq!(control["mitigations"]["win32k"], 0, "control: {control}");
    assert_eq!(
        control["mitigations"]["child_process"], 0,
        "control: {control}"
    );

    let memory = 256 * 1024 * 1024;
    let mut enclosed = sandbox::spawn(&probe(), &args, memory).expect("enclosed probe");
    drop(enclosed.take_stdin());
    let out = String::from_utf8(read_within(enclosed.take_stdout())).unwrap();
    let exit = enclosed.exit_code(5_000);
    // The job's own accounting, read before the job ends.
    let peak = enclosed.peak_memory();
    assert!(
        peak > 64 * 1024 && peak < memory,
        "peak commit of the probe: {peak}"
    );
    enclosed.kill();
    // The network attempt comes last. On windows-2022 the LPAC process does
    // not get an error back: it ends there, with exit code 65
    // (ERROR_NETWORK_ACCESS_DENIED). Either way, no connection may arrive.
    let finished = out.ends_with('}');
    let whole = if finished {
        out.clone()
    } else {
        format!("{out}}}")
    };
    let report: serde_json::Value = serde_json::from_str(&whole)
        .unwrap_or_else(|_| panic!("probe output: {out:?}, exit code {exit:x?}"));
    if finished {
        assert_eq!(exit, Some(0), "{report}");
        assert_eq!(report["network"], "denied", "{report}");
    } else {
        assert!(
            report.get("network").is_none() && !matches!(exit, None | Some(0)),
            "the probe stopped before the network attempt: {out:?}, exit code {exit:x?}"
        );
        eprintln!("enclosed probe ended at the network attempt, exit code {exit:?}");
    }
    listener.set_nonblocking(true).unwrap();
    assert!(
        matches!(listener.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock),
        "no connection reached the listener from the enclosure"
    );
    for capability in ["read", "write", "process"] {
        assert_eq!(
            report[capability], "denied",
            "enclosed: {capability}: {report}"
        );
    }
    // Only what the supervisor passes (LOCALAPPDATA, SystemRoot), plus the
    // temporary folders Windows gives an AppContainer; every path points
    // into the AppContainer's own folder, never the user's.
    let names: Vec<&str> = report["variables"]
        .as_array()
        .unwrap()
        .iter()
        .map(|name| name.as_str().unwrap())
        .collect();
    assert!(names.contains(&"SystemRoot"), "{report}");
    for name in &names {
        assert!(
            ["LOCALAPPDATA", "SystemRoot", "TEMP", "TMP"].contains(name),
            "{name}: {report}"
        );
    }
    for (name, value) in report["paths"].as_object().unwrap() {
        let value = value.as_str().unwrap().to_lowercase();
        assert!(
            value.contains(r"\packages\nemein.connectorworker"),
            "{name} is not the AppContainer's own folder: {report}"
        );
    }
    assert!(!writable.join("probe-wrote-here.txt").exists());

    // What the enclosure applied, read from inside and compared with the
    // documented values, not with the functions that built them.
    assert_eq!(
        report["token"],
        serde_json::json!({"appcontainer": 1, "lpac": 1, "capabilities": 0}),
        "{report}"
    );
    let job = &report["job"];
    // KILL_ON_JOB_CLOSE | ACTIVE_PROCESS | JOB_MEMORY | DIE_ON_UNHANDLED_EXCEPTION.
    assert_eq!(job["limits"], 0x2608, "{report}");
    assert_eq!(job["active_processes"], 1, "{report}");
    assert_eq!(job["memory"], memory, "{report}");
    // The eight UI classes, unless this test already runs inside a job.
    assert_eq!(job["ui"], if in_a_job() { 0 } else { 0xff }, "{report}");
    assert_eq!(enclosed.ui_restricted(), !in_a_job());
    let policy = |name: &str| report["mitigations"][name].as_i64().unwrap();
    // Bottom-up (bit 0) and high-entropy (bit 2) ASLR.
    assert_eq!(policy("aslr") & 0b101, 0b101, "{report}");
    for name in ["win32k", "extension_points", "fonts", "child_process"] {
        assert_eq!(policy(name) & 1, 1, "{name}: {report}");
    }
    // No remote images, no low-label images, System32 first.
    assert_eq!(policy("image_load") & 0b111, 0b111, "{report}");
}

/// A component whose compilation needs far more than 24 MiB of commit.
fn big_component() -> Vec<u8> {
    let mut body = String::new();
    for _ in 0..200_000 {
        body.push_str("local.get 0 i32.const 1 i32.add local.set 0\n");
    }
    wat::parse_str(format!(
        "(component (core module (func (param i32) (local i32 i32) {body})))"
    ))
    .unwrap()
}

/// Reads `reader` to its end on another thread, and fails the test if that
/// takes more than 30 s: a handle left open must fail, not hang the run.
fn read_within(mut reader: Box<dyn Read + Send>) -> Vec<u8> {
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = reader.read_to_end(&mut out);
        let _ = sender.send(out);
    });
    receiver
        .recv_timeout(Duration::from_secs(30))
        .expect("the pipe reached its end in time")
}

/// Whether this test process is inside a job, as CI runners may put it.
fn in_a_job() -> bool {
    let mut nested = 0;
    let read = unsafe { IsProcessInJob(GetCurrentProcess(), null_mut(), &mut nested) };
    assert_ne!(read, 0, "IsProcessInJob");
    nested != 0
}

#[test]
fn the_memory_limit_is_reported() {
    let frame = request(Op::Describe, big_component(), Vec::new(), "", "1");
    let (answer, _) = run(&frame, &["--memory-mb", "24"]);
    assert_eq!(host_code(&answer), code::MEMORY_LIMIT);
}

#[test]
fn lowered_limits_are_accepted_at_their_bounds() {
    let describe = request(
        Op::Describe,
        component("nemein-example-bank-csv"),
        Vec::new(),
        "",
        "1",
    );
    // The highest values are the defaults; 200 MiB is plenty for the example.
    for args in [
        &["--deadline-ms", "10000", "--memory-mb", "256"][..],
        &["--memory-mb", "200"],
    ] {
        let (answer, _) = run(&describe, args);
        assert_eq!(header(&answer)["status"], "ok", "{args:?}");
    }
    // One millisecond is not enough to start the worker.
    let (answer, _) = run(&describe, &["--deadline-ms", "1"]);
    assert_eq!(host_code(&answer), code::TIMEOUT);
    // The lowest memory is accepted: whatever the answer, `run` saw exit 0,
    // not the refusal of a bad option.
    let (answer, _) = run(&describe, &["--memory-mb", "16"]);
    assert_ne!(header(&answer)["code"], code::REQUEST_INVALID);
}

#[test]
fn a_worker_that_ends_without_answering_did_not_hit_the_memory_limit() {
    // The probe without arguments exits at once and writes nothing.
    let mut enclosed = sandbox::spawn(&probe(), &[], 256 * 1024 * 1024).expect("enclosed probe");
    drop(enclosed.take_stdin());
    assert!(read_within(enclosed.take_stdout()).is_empty());
    // It ran and refused its missing arguments itself.
    assert_eq!(enclosed.exit_code(5_000), Some(2));
    enclosed.kill();
    assert!(!enclosed.memory_reported());
    assert_eq!(enclosed.ending(), Ending::Other);
}

#[test]
fn kill_ends_the_worker_at_once() {
    let mut enclosed =
        sandbox::spawn(&supervisor(), &["worker"], 256 * 1024 * 1024).expect("enclosed worker");
    let hang = request(
        Op::Parse,
        component("nemein-fixture-hostile"),
        Vec::new(),
        "hang",
        "1",
    );
    frame::write(&mut enclosed.take_stdin(), Kind::Request, &hang).unwrap();
    assert_eq!(enclosed.exit_code(500), None, "the worker is running");
    enclosed.kill();
    // TerminateJobObject(job, 1), already waited for.
    assert_eq!(enclosed.exit_code(0), Some(1));
}

#[test]
fn the_job_itself_reports_the_memory_limit() {
    let limit = 24 * 1024 * 1024;
    let mut enclosed = sandbox::spawn(&supervisor(), &["worker"], limit).expect("enclosed worker");
    let frame = request(Op::Describe, big_component(), Vec::new(), "", "1");
    frame::write(&mut enclosed.take_stdin(), Kind::Request, &frame).unwrap();
    let _ = read_within(enclosed.take_stdout());
    enclosed.kill();
    let peak = enclosed.peak_memory();
    assert!(peak >= limit / 10 * 9, "peak commit at the limit: {peak}");
    assert!(enclosed.memory_reported(), "the job posted the limit");
}

#[test]
fn a_file_that_is_not_a_program_is_refused_with_the_system_error() {
    let dir = temp("not-a-program");
    let file = dir.join("conector-ficticio.txt");
    std::fs::write(&file, "no es un programa").unwrap();
    let error = sandbox::spawn(&file, &[], 64 * 1024 * 1024)
        .err()
        .expect("refused");
    let code: u32 = error
        .strip_prefix("CreateProcessW en el AppContainer: error ")
        .unwrap_or_else(|| panic!("{error}"))
        .parse()
        .unwrap_or_else(|_| panic!("{error}"));
    assert_ne!(code, 0, "{error}");
}

#[test]
fn the_worker_refuses_to_run_without_the_enclosure() {
    let mut child = Command::new(supervisor())
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
    let binary = std::path::absolute(supervisor()).unwrap();
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
    let mut child = Command::new(supervisor())
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

    let mut child = Command::new(supervisor())
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
