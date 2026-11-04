//! The supervisor's side of one run: hand the request to an enclosed worker,
//! wait for one response frame within the wall clock, and kill the worker in
//! every outcome.
//!
//! The supervisor never parses what the worker says beyond frame lengths: the
//! response is relayed as bytes, and Node validates it outside the enclosure.

use crate::frame::{self, Frame, FrameError, Kind};
use crate::protocol::{self, code};
use std::io::{Read, Write};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

/// How a worker ended, as far as the enclosure can tell.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ending {
    /// It hit the committed memory limit.
    MemoryLimit,
    /// Anything else: a crash, an abort, or a clean exit without a frame.
    Other,
}

/// How a worker that ended without a frame ended, from what its job saw:
/// whether the job reported the memory limit, and its peak commit. The report
/// may be lost (only notification limits are delivered for sure), so a peak
/// of at least nine tenths of the limit counts as the limit too.
pub fn memory_verdict(reported: bool, peak: usize, limit: usize) -> Ending {
    if reported || peak >= limit / 10 * 9 {
        Ending::MemoryLimit
    } else {
        Ending::Other
    }
}

/// One enclosed worker process.
pub trait Worker: Send {
    /// The pipe to the worker's stdin; taken once.
    fn take_stdin(&mut self) -> Box<dyn Write + Send>;
    /// The pipe from the worker's stdout; taken once.
    fn take_stdout(&mut self) -> Box<dyn Read + Send>;
    /// Kills the worker and everything it could have started. Idempotent.
    fn kill(&mut self);
    /// After `kill` or an exit, why it ended.
    fn ending(&mut self) -> Ending;
}

/// What the supervisor learned while waiting.
pub enum Event {
    Response(Result<Frame, FrameError>),
    /// Node closed its end: nobody is waiting for the answer anymore.
    Cancelled,
}

/// Runs one request. Returns the frame to relay, or `None` when Node is gone.
///
/// `deadline` starts before the worker is created, so it covers process
/// start, compilation, instantiation, `describe`, `parse` and both pipes.
pub fn supervise(
    request: &Frame,
    spawn: impl FnOnce() -> Result<Box<dyn Worker>, String>,
    deadline: Duration,
    events: mpsc::Receiver<Event>,
    sender: mpsc::Sender<Event>,
) -> Option<Frame> {
    let start = Instant::now();
    let mut worker = match spawn() {
        Ok(worker) => worker,
        Err(message) => return Some(protocol::host_error(code::SANDBOX_UNAVAILABLE, &message)),
    };
    let mut stdin = worker.take_stdin();
    let mut stdout = worker.take_stdout();
    let request = request.clone();
    // A worker that never reads must not block the supervisor: write apart.
    std::thread::spawn(move || {
        let _ = frame::write(&mut stdin, Kind::Request, &request);
    });
    std::thread::spawn(move || {
        let _ = sender.send(Event::Response(frame::read(&mut stdout, Kind::Response)));
    });
    let remaining = deadline.saturating_sub(start.elapsed());
    let outcome = match events.recv_timeout(remaining) {
        Ok(Event::Response(Ok(frame))) => Some(frame),
        Ok(Event::Response(Err(FrameError::Truncated | FrameError::Io(_)))) => {
            // The worker ended without a whole frame; ask the enclosure why.
            worker.kill();
            Some(match worker.ending() {
                Ending::MemoryLimit => protocol::host_error(
                    code::MEMORY_LIMIT,
                    "el conector superó la memoria permitida",
                ),
                Ending::Other => protocol::host_error(
                    code::WORKER_CRASHED,
                    "el proceso del conector terminó sin responder",
                ),
            })
        }
        Ok(Event::Response(Err(error))) => Some(protocol::host_error(
            code::WORKER_PROTOCOL,
            &error.to_string(),
        )),
        Ok(Event::Cancelled) => None,
        Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => Some(
            protocol::host_error(code::TIMEOUT, "el conector superó el tiempo permitido"),
        ),
    };
    worker.kill();
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reported_limit_or_a_peak_near_it_is_the_memory_limit() {
        let limit = 256 * 1024 * 1024;
        // 268_435_456 / 10 * 9, in integers.
        let threshold = 241_591_905;
        assert_eq!(memory_verdict(false, 0, limit), Ending::Other);
        assert_eq!(memory_verdict(true, 0, limit), Ending::MemoryLimit);
        assert_eq!(memory_verdict(false, threshold, limit), Ending::MemoryLimit);
        assert_eq!(memory_verdict(false, threshold - 1, limit), Ending::Other);
        assert_eq!(memory_verdict(false, limit, limit), Ending::MemoryLimit);
    }
}
