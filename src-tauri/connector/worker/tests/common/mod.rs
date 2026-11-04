//! Shared test helpers: build guest components with the recipe, and run the
//! test worker as a plain child process.
#![allow(dead_code)]

use nemein_connector::frame::Frame;
use nemein_connector::protocol::{self, Op, RequestHeader};
use nemein_connector::supervise::{Ending, Worker};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Mutex, OnceLock};

/// Builds a guest package for wasm32 and wraps it as a component, once per
/// package and test binary.
pub fn component(package: &str) -> Vec<u8> {
    static BUILT: OnceLock<Mutex<HashMap<String, Vec<u8>>>> = OnceLock::new();
    let cache = BUILT.get_or_init(Default::default);
    let mut cache = cache.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(bytes) = cache.get(package) {
        return bytes.clone();
    }
    let target = Path::new(env!("CARGO_TARGET_TMPDIR")).join("guest");
    let status = Command::new(env!("CARGO"))
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join(".."))
        .args([
            "build",
            "--locked",
            "-q",
            "--profile",
            "guest",
            "--target",
            "wasm32-unknown-unknown",
            "-p",
            package,
        ])
        .arg("--target-dir")
        .arg(&target)
        .status()
        .expect("cargo build");
    assert!(status.success(), "building {package}");
    let core = std::fs::read(
        target
            .join("wasm32-unknown-unknown/guest")
            .join(format!("{}.wasm", package.replace('-', "_"))),
    )
    .unwrap();
    let bytes = nemein_connector_tools::componentize(&core).expect("componentize");
    cache.insert(package.to_owned(), bytes.clone());
    bytes
}

pub fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../examples/fictitious-bank-csv/fixtures")
            .join(name),
    )
    .unwrap()
}

pub fn request(op: Op, component: Vec<u8>, input: Vec<u8>, config: &str, account: &str) -> Frame {
    protocol::request(
        &RequestHeader {
            op,
            config: config.to_owned(),
            account_id: account.to_owned(),
        },
        component,
        input,
    )
}

pub fn header(frame: &Frame) -> serde_json::Value {
    serde_json::from_slice(&frame.header).expect("JSON header")
}

pub fn test_worker() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_connector-test-worker"))
}

/// The test worker as an unenclosed child process.
pub struct ProcessWorker {
    pub child: Child,
    stdin: Option<ChildStdin>,
    stdout: Option<ChildStdout>,
}

impl ProcessWorker {
    pub fn start(mode: &str) -> Result<Box<dyn Worker>, String> {
        let mut child = Command::new(test_worker())
            .arg(mode)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(Box::new(ProcessWorker {
            stdin: child.stdin.take(),
            stdout: child.stdout.take(),
            child,
        }))
    }
}

impl Worker for ProcessWorker {
    fn take_stdin(&mut self) -> Box<dyn Write + Send> {
        Box::new(self.stdin.take().expect("stdin taken once"))
    }
    fn take_stdout(&mut self) -> Box<dyn Read + Send> {
        Box::new(self.stdout.take().expect("stdout taken once"))
    }
    fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
    fn ending(&mut self) -> Ending {
        Ending::Other
    }
}
