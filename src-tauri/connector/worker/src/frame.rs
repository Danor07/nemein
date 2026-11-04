//! Frames on stdin/stdout between Node, the supervisor and the worker.
//!
//! ```text
//! "NMC" version:u8=1 kind:u8 header_len:u32le header blob_count:u8 (blob_len:u32le blob)*
//! ```
//!
//! The header is UTF-8 JSON; blobs are raw bytes. Every length is checked
//! against its limit before a single byte of that field is read, and fields are
//! read incrementally, so a peer that declares a huge length or stops writing
//! never makes the reader allocate more than the limit.

use crate::limits::{COMPONENT_MAX, HEADER_MAX, INPUT_MAX, OUTPUT_MAX};
use std::io::{self, Read, Write};

pub const MAGIC: &[u8; 3] = b"NMC";
pub const VERSION: u8 = 1;

/// Which direction a frame travels, which fixes its blob limits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// Node → supervisor → worker: blobs are the component and the file.
    Request,
    /// Worker → supervisor → Node: at most one blob, the batch text.
    Response,
}

impl Kind {
    fn byte(self) -> u8 {
        match self {
            Kind::Request => b'Q',
            Kind::Response => b'R',
        }
    }

    /// Largest accepted size of each blob, by position.
    fn blob_limits(self) -> &'static [usize] {
        match self {
            Kind::Request => &[COMPONENT_MAX, INPUT_MAX],
            Kind::Response => &[OUTPUT_MAX],
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Frame {
    pub header: Vec<u8>,
    pub blobs: Vec<Vec<u8>>,
}

#[derive(Debug)]
pub enum FrameError {
    /// The stream ended inside the frame.
    Truncated,
    /// Wrong magic, version or kind.
    Malformed(&'static str),
    /// A declared length or count is over its limit; nothing of it was read.
    TooLarge(&'static str),
    Io(io::Error),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::Truncated => f.write_str("la trama terminó antes de tiempo"),
            FrameError::Malformed(what) => write!(f, "trama inválida: {what}"),
            FrameError::TooLarge(what) => write!(f, "trama demasiado grande: {what}"),
            FrameError::Io(e) => write!(f, "error de entrada/salida: {e}"),
        }
    }
}

fn read_exact_or_truncated(reader: &mut impl Read, buf: &mut [u8]) -> Result<(), FrameError> {
    reader.read_exact(buf).map_err(|e| match e.kind() {
        io::ErrorKind::UnexpectedEof => FrameError::Truncated,
        _ => FrameError::Io(e),
    })
}

fn read_u32(reader: &mut impl Read) -> Result<usize, FrameError> {
    let mut bytes = [0u8; 4];
    read_exact_or_truncated(reader, &mut bytes)?;
    Ok(u32::from_le_bytes(bytes) as usize)
}

/// Reads `len` bytes, growing the buffer only as data arrives.
fn read_field(reader: &mut impl Read, len: usize) -> Result<Vec<u8>, FrameError> {
    let mut field = Vec::new();
    reader
        .take(len as u64)
        .read_to_end(&mut field)
        .map_err(FrameError::Io)?;
    if field.len() == len {
        Ok(field)
    } else {
        Err(FrameError::Truncated)
    }
}

/// Reads exactly one frame of `kind`.
pub fn read(reader: &mut impl Read, kind: Kind) -> Result<Frame, FrameError> {
    let mut prefix = [0u8; 5];
    read_exact_or_truncated(reader, &mut prefix)?;
    if &prefix[..3] != MAGIC {
        return Err(FrameError::Malformed("firma"));
    }
    if prefix[3] != VERSION {
        return Err(FrameError::Malformed("versión"));
    }
    if prefix[4] != kind.byte() {
        return Err(FrameError::Malformed("tipo"));
    }
    let header_len = read_u32(reader)?;
    if header_len > HEADER_MAX {
        return Err(FrameError::TooLarge("encabezado"));
    }
    let header = read_field(reader, header_len)?;
    let mut count = [0u8; 1];
    read_exact_or_truncated(reader, &mut count)?;
    let limits = kind.blob_limits();
    if usize::from(count[0]) > limits.len() {
        return Err(FrameError::TooLarge("cantidad de bloques"));
    }
    let mut blobs = Vec::with_capacity(usize::from(count[0]));
    for limit in &limits[..usize::from(count[0])] {
        let len = read_u32(reader)?;
        if len > *limit {
            return Err(FrameError::TooLarge("bloque"));
        }
        blobs.push(read_field(reader, len)?);
    }
    Ok(Frame { header, blobs })
}

/// Writes one frame. Refuses to write what the reader would refuse to read.
pub fn write(writer: &mut impl Write, kind: Kind, frame: &Frame) -> io::Result<()> {
    let limits = kind.blob_limits();
    let too_large = frame.header.len() > HEADER_MAX
        || frame.blobs.len() > limits.len()
        || frame
            .blobs
            .iter()
            .zip(limits)
            .any(|(blob, limit)| blob.len() > *limit);
    if too_large {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "la trama supera sus límites",
        ));
    }
    let mut out = Vec::with_capacity(
        10 + frame.header.len() + frame.blobs.iter().map(|b| 4 + b.len()).sum::<usize>(),
    );
    out.extend_from_slice(MAGIC);
    out.push(VERSION);
    out.push(kind.byte());
    out.extend_from_slice(&(frame.header.len() as u32).to_le_bytes());
    out.extend_from_slice(&frame.header);
    out.push(frame.blobs.len() as u8);
    for blob in &frame.blobs {
        out.extend_from_slice(&(blob.len() as u32).to_le_bytes());
        out.extend_from_slice(blob);
    }
    writer.write_all(&out)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(kind: Kind, frame: &Frame) -> Vec<u8> {
        let mut out = Vec::new();
        write(&mut out, kind, frame).unwrap();
        out
    }

    fn frame(header: &[u8], blobs: &[&[u8]]) -> Frame {
        Frame {
            header: header.to_vec(),
            blobs: blobs.iter().map(|b| b.to_vec()).collect(),
        }
    }

    #[test]
    fn layout_is_exact() {
        let encoded = bytes(Kind::Response, &frame(b"{}", &[b"ab"]));
        assert_eq!(
            encoded,
            [
                b"NMC".as_slice(),
                &[1, b'R', 2, 0, 0, 0],
                b"{}",
                &[1, 2, 0, 0, 0],
                b"ab"
            ]
            .concat()
        );
        let request = bytes(Kind::Request, &frame(b"h", &[b"c", b""]));
        assert_eq!(request[4], b'Q');
        assert_eq!(
            read(&mut request.as_slice(), Kind::Request).unwrap(),
            frame(b"h", &[b"c", b""])
        );
    }

    #[test]
    fn rejects_wrong_prefix() {
        let good = bytes(Kind::Response, &frame(b"{}", &[]));
        for (index, what) in [(0, "firma"), (3, "versión"), (4, "tipo")] {
            let mut bad = good.clone();
            bad[index] ^= 0xff;
            match read(&mut bad.as_slice(), Kind::Response) {
                Err(FrameError::Malformed(found)) => assert_eq!(found, what),
                other => panic!("{other:?}"),
            }
        }
        // A request is not a response, even when well formed.
        let request = bytes(Kind::Request, &frame(b"{}", &[]));
        assert!(matches!(
            read(&mut request.as_slice(), Kind::Response),
            Err(FrameError::Malformed("tipo"))
        ));
    }

    #[test]
    fn every_truncation_is_detected() {
        let full = bytes(
            Kind::Request,
            &frame(b"{\"op\":1}", &[b"component", b"input"]),
        );
        for cut in 0..full.len() {
            assert!(
                matches!(
                    read(&mut &full[..cut], Kind::Request),
                    Err(FrameError::Truncated)
                ),
                "cut at {cut}"
            );
        }
        assert!(read(&mut full.as_slice(), Kind::Request).is_ok());
    }

    /// A reader that panics if asked for more than `allowed` bytes in total.
    struct Budget<'a> {
        data: &'a [u8],
        allowed: usize,
    }

    impl Read for Budget<'_> {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let n = buf.len().min(self.data.len());
            assert!(n <= self.allowed, "read past the declared limit");
            self.allowed -= n;
            buf[..n].copy_from_slice(&self.data[..n]);
            self.data = &self.data[n..];
            Ok(n)
        }
    }

    #[test]
    fn oversized_lengths_are_refused_before_reading() {
        let mut header = [b"NMC".as_slice(), &[1, b'R']].concat();
        header.extend_from_slice(&((HEADER_MAX + 1) as u32).to_le_bytes());
        header.extend(std::iter::repeat_n(b'x', 64));
        let mut reader = Budget {
            data: &header,
            allowed: 9,
        };
        assert!(matches!(
            read(&mut reader, Kind::Response),
            Err(FrameError::TooLarge("encabezado"))
        ));

        let mut blob = [b"NMC".as_slice(), &[1, b'R', 0, 0, 0, 0, 1]].concat();
        blob.extend_from_slice(&((OUTPUT_MAX + 1) as u32).to_le_bytes());
        blob.extend(std::iter::repeat_n(b'x', 64));
        let mut reader = Budget {
            data: &blob,
            allowed: 14,
        };
        assert!(matches!(
            read(&mut reader, Kind::Response),
            Err(FrameError::TooLarge("bloque"))
        ));

        let count = [b"NMC".as_slice(), &[1, b'R', 0, 0, 0, 0, 2]].concat();
        assert!(matches!(
            read(&mut count.as_slice(), Kind::Response),
            Err(FrameError::TooLarge("cantidad de bloques"))
        ));
        let count = [b"NMC".as_slice(), &[1, b'Q', 0, 0, 0, 0, 3]].concat();
        assert!(matches!(
            read(&mut count.as_slice(), Kind::Request),
            Err(FrameError::TooLarge("cantidad de bloques"))
        ));
    }

    #[test]
    fn limits_are_exact_per_position() {
        // The second request blob is the file: its limit is INPUT_MAX, not COMPONENT_MAX.
        let mut prefix = [b"NMC".as_slice(), &[1, b'Q', 0, 0, 0, 0, 2, 0, 0, 0, 0]].concat();
        prefix.extend_from_slice(&((INPUT_MAX + 1) as u32).to_le_bytes());
        assert!(matches!(
            read(&mut prefix.as_slice(), Kind::Request),
            Err(FrameError::TooLarge("bloque"))
        ));
        let mut prefix = [b"NMC".as_slice(), &[1, b'Q', 0, 0, 0, 0, 1]].concat();
        prefix.extend_from_slice(&((COMPONENT_MAX + 1) as u32).to_le_bytes());
        assert!(matches!(
            read(&mut prefix.as_slice(), Kind::Request),
            Err(FrameError::TooLarge("bloque"))
        ));
        // Exactly at the limit is accepted (declared, then truncated here).
        let mut prefix = [b"NMC".as_slice(), &[1, b'Q', 0, 0, 0, 0, 1]].concat();
        prefix.extend_from_slice(&(COMPONENT_MAX as u32).to_le_bytes());
        assert!(matches!(
            read(&mut prefix.as_slice(), Kind::Request),
            Err(FrameError::Truncated)
        ));
    }

    #[test]
    fn writer_refuses_what_readers_refuse() {
        let mut sink = Vec::new();
        let huge_header = Frame {
            header: vec![b' '; HEADER_MAX + 1],
            blobs: vec![],
        };
        assert!(write(&mut sink, Kind::Response, &huge_header).is_err());
        let two = frame(b"{}", &[b"a", b"b"]);
        assert!(write(&mut sink, Kind::Response, &two).is_err());
        let big = Frame {
            header: b"{}".to_vec(),
            blobs: vec![vec![0; OUTPUT_MAX + 1]],
        };
        assert!(write(&mut sink, Kind::Response, &big).is_err());
        assert!(sink.is_empty());
        let at_limit = Frame {
            header: vec![b' '; HEADER_MAX],
            blobs: vec![vec![1; INPUT_MAX]],
        };
        assert!(write(&mut sink, Kind::Response, &at_limit).is_ok());
        assert_eq!(
            read(&mut sink.as_slice(), Kind::Response).unwrap(),
            at_limit
        );
    }
}
