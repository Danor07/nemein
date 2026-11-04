//! Native probe for the enclosure tests (`--features test-worker` only).
//!
//! `connector-sandbox-probe <file> <folder> <port>` tries what a connector must
//! never do and prints one JSON line: read a fictitious file, write into a
//! folder, connect to a local TCP port, start a process, and count the
//! environment variables it can see. Run enclosed, every attempt must fail; run
//! without the enclosure (the positive control), every attempt must succeed.

use std::io::Write;

fn outcome(ok: bool) -> &'static str {
    if ok {
        "allowed"
    } else {
        "denied"
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [file, folder, port] = args.as_slice() else {
        std::process::exit(2);
    };
    let read = std::fs::read(file).is_ok();
    let write = std::fs::write(
        std::path::Path::new(folder).join("probe-wrote-here.txt"),
        b"x",
    )
    .is_ok();
    let network =
        std::net::TcpStream::connect(("127.0.0.1", port.parse::<u16>().unwrap_or(1))).is_ok();
    let process = std::process::Command::new("cmd.exe")
        .args(["/c", "exit", "0"])
        .status()
        .is_ok();
    let environment = std::env::vars_os().count();
    let line = format!(
        r#"{{"read":"{}","write":"{}","network":"{}","process":"{}","environment":{environment}}}"#,
        outcome(read),
        outcome(write),
        outcome(network),
        outcome(process)
    );
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(line.as_bytes());
    let _ = stdout.flush();
}
