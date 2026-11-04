//! Hostile test connector whose manifest is far over its limit.

use nemein_connector_sdk::{Context, Error, Guest, Manifest};

pub struct Boastful;

impl Guest for Boastful {
    fn describe() -> Manifest {
        Manifest {
            id: "test.boastful".into(),
            version: "1.0.0".into(),
            name: "n".repeat(10_000),
            description: String::new(),
            extensions: vec![],
        }
    }

    fn parse(_input: Vec<u8>, _ctx: Context) -> Result<String, Error> {
        Ok(String::new())
    }
}

#[cfg(target_arch = "wasm32")]
nemein_connector_sdk::export!(Boastful);
