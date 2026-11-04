//! Test double of the enclosed worker: same protocol, no enclosure. Built only
//! with `--features test-worker`, so it never reaches an installer. Modes:
//!
//! - `execute`: read the request and answer with the real `execute`;
//! - `hang`: read the request and never answer;
//! - `exit`: read the request and exit without answering;
//! - `truncate`: answer half of a valid frame, then exit;
//! - `huge`: declare a blob over the limit and keep writing;
//! - `garbage`: answer bytes that are not a frame;
//! - `ignore`: never read the request, never answer.

use nemein_connector::frame::{self, Kind};
use nemein_connector::limits::OUTPUT_MAX;
use nemein_connector::{execute, protocol};
use std::io::{self, Read, Write};

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    let mut stdout = io::stdout().lock();
    if mode == "ignore" {
        loop {
            std::thread::park();
        }
    }
    let request = frame::read(&mut io::stdin().lock(), Kind::Request);
    match (mode.as_str(), request) {
        ("execute", Ok(request)) => {
            let _ = frame::write(&mut stdout, Kind::Response, &execute::execute(&request));
        }
        ("hang", _) => loop {
            std::thread::park();
        },
        ("exit", _) => std::process::exit(7),
        ("truncate", _) => {
            let mut whole = Vec::new();
            let ok = protocol::host_error("X", "y");
            let _ = frame::write(&mut whole, Kind::Response, &ok);
            let _ = stdout.write_all(&whole[..whole.len() / 2]);
        }
        ("huge", _) => {
            let _ = stdout.write_all(b"NMC\x01R\x02\x00\x00\x00{}\x01");
            let _ = stdout.write_all(&((OUTPUT_MAX + 1) as u32).to_le_bytes());
            let chunk = vec![b'x'; 1 << 16];
            while stdout.write_all(&chunk).is_ok() {}
        }
        ("garbage", _) => {
            let _ = stdout.write_all(b"HTTP/1.1 200 OK\r\n\r\n");
        }
        (_, Err(error)) => {
            let _ = frame::write(
                &mut stdout,
                Kind::Response,
                &protocol::host_error("REQUEST_INVALID", &error.to_string()),
            );
        }
        (other, _) => panic!("modo desconocido: {other}"),
    }
    let _ = stdout.flush();
    let _ = io::stdin().read(&mut [0u8; 1]);
}
