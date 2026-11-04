//! Entry point; see the crate documentation in `lib.rs`.

use nemein_connector::frame::{self, Kind};
use nemein_connector::limits::{DEADLINE_MS, MEMORY_BYTES};
use nemein_connector::protocol::{self, code};
use nemein_connector::supervise::{self, Event};
use std::io::{self, Read, Write};
use std::process::ExitCode;
use std::sync::mpsc;
use std::time::Duration;

/// Exit status when a response frame was written, whatever it says.
const ANSWERED: u8 = 0;
/// Node closed stdin before the answer: nothing was written.
const CANCELLED: u8 = 1;
/// The request itself was unreadable.
const BAD_REQUEST: u8 = 2;
/// This process refused to run a connector here.
const REFUSED: u8 = 3;

fn answer(frame: &frame::Frame) -> bool {
    frame::write(&mut io::stdout().lock(), Kind::Response, frame).is_ok()
}

fn exit_after(frame: &frame::Frame, status: u8) -> ExitCode {
    let _ = answer(frame);
    ExitCode::from(status)
}

/// `--deadline-ms N` and `--memory-mb N` may only lower the limits.
fn options(args: &[String]) -> Result<(Duration, usize), String> {
    let (mut deadline, mut memory) = (DEADLINE_MS, MEMORY_BYTES);
    let mut args = args.iter();
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .and_then(|v| v.parse::<u64>().ok())
            .ok_or_else(|| format!("{flag} necesita un número"))?;
        match flag.as_str() {
            "--deadline-ms" if (1..=DEADLINE_MS).contains(&value) => deadline = value,
            "--memory-mb" if (16..=256).contains(&value) => memory = value as usize * 1024 * 1024,
            _ => return Err(format!("opción no admitida: {flag} {value}")),
        }
    }
    Ok((Duration::from_millis(deadline), memory))
}

fn supervisor(args: &[String]) -> ExitCode {
    let (deadline, memory) = match options(args) {
        Ok(limits) => limits,
        Err(message) => {
            return exit_after(
                &protocol::host_error(code::REQUEST_INVALID, &message),
                BAD_REQUEST,
            )
        }
    };
    let request = match frame::read(&mut io::stdin().lock(), Kind::Request) {
        Ok(request) => request,
        Err(error) => {
            return exit_after(
                &protocol::host_error(code::REQUEST_INVALID, &error.to_string()),
                BAD_REQUEST,
            )
        }
    };
    if !cfg!(windows) {
        return exit_after(
            &protocol::host_error(
                code::UNSUPPORTED_PLATFORM,
                "los conectores sólo corren en Windows, dentro de su encierro",
            ),
            REFUSED,
        );
    }
    let (sender, events) = mpsc::channel();
    let cancel = sender.clone();
    // Node keeps stdin open until it has the answer; EOF means it went away.
    std::thread::spawn(move || {
        let mut rest = [0u8; 256];
        let mut stdin = io::stdin();
        while matches!(stdin.read(&mut rest), Ok(n) if n > 0) {}
        let _ = cancel.send(Event::Cancelled);
    });
    #[cfg(windows)]
    let spawn = || nemein_connector::sandbox::spawn_worker(memory);
    #[cfg(not(windows))]
    let spawn = || -> Result<Box<dyn supervise::Worker>, String> {
        let _ = memory;
        Err("sin encierro".to_owned())
    };
    match supervise::supervise(&request, spawn, deadline, events, sender) {
        Some(response) if answer(&response) => ExitCode::from(ANSWERED),
        _ => ExitCode::from(CANCELLED),
    }
}

fn worker() -> ExitCode {
    #[cfg(windows)]
    if let Err(message) = nemein_connector::sandbox::verify_enclosed() {
        return exit_after(
            &protocol::host_error(code::SANDBOX_UNAVAILABLE, &message),
            REFUSED,
        );
    }
    if !cfg!(windows) {
        return exit_after(
            &protocol::host_error(
                code::UNSUPPORTED_PLATFORM,
                "los conectores sólo corren en Windows, dentro de su encierro",
            ),
            REFUSED,
        );
    }
    let response = match frame::read(&mut io::stdin().lock(), Kind::Request) {
        // Wasm runs on a thread with an explicit stack, larger than its limit.
        Ok(request) => std::thread::Builder::new()
            .stack_size(nemein_connector::limits::WORKER_THREAD_STACK)
            .spawn(move || nemein_connector::execute::execute(&request))
            .ok()
            .and_then(|thread| thread.join().ok())
            .unwrap_or_else(|| {
                protocol::host_error(code::WORKER_CRASHED, "el hilo del conector falló")
            }),
        Err(error) => protocol::host_error(code::REQUEST_INVALID, &error.to_string()),
    };
    exit_after(&response, ANSWERED)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(String::as_str) {
        Some("worker") if args.len() == 1 => worker(),
        _ => supervisor(&args),
    };
    let _ = io::stdout().flush();
    code
}
