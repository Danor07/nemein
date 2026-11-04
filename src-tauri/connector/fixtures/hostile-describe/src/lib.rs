//! Hostile test connector whose `describe` never returns.

use nemein_connector_sdk::{Context, Error, Guest, Manifest};

pub struct Blocked;

impl Guest for Blocked {
    #[allow(clippy::empty_loop)]
    fn describe() -> Manifest {
        loop {}
    }

    fn parse(_input: Vec<u8>, _ctx: Context) -> Result<String, Error> {
        Ok(String::new())
    }
}

#[cfg(target_arch = "wasm32")]
nemein_connector_sdk::export!(Blocked);
