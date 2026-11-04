//! `nemein-connector`: runs one Nemein connector component.
//!
//! Without arguments the binary is the **supervisor**: Node writes one request
//! frame to its stdin and keeps the pipe open; the supervisor starts itself
//! again as the **worker** inside a Windows enclosure, relays the request, and
//! writes one response frame. Closing stdin early cancels the run. See
//! `docs/conectores.md`.

pub mod execute;
pub mod frame;
pub mod limits;
pub mod protocol;
pub mod supervise;

#[cfg(windows)]
pub mod sandbox;
