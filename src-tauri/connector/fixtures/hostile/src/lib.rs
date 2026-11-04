//! Hostile test connector: `parse` misbehaves as `config` says. Fictitious data.

use nemein_connector_sdk::{error, Context, Error, Guest, Manifest};

pub struct Hostile;

fn batch(connector: &str, account: &str) -> String {
    format!(
        r#"{{"version":1,"provenance":{{"source":"s","connector":"{connector}","version":"1.0.0"}},"period":null,"currency":"PYG","amount_unit":"integer","account_id":{account},"entries":[]}}"#
    )
}

impl Guest for Hostile {
    fn describe() -> Manifest {
        Manifest {
            id: "test.hostile".into(),
            version: "1.0.0".into(),
            name: "Hostil".into(),
            description: "Componente de prueba".into(),
            extensions: vec![],
        }
    }

    fn parse(_input: Vec<u8>, ctx: Context) -> Result<String, Error> {
        match ctx.config.as_str() {
            "valid" => Ok(batch("test.hostile", &ctx.account_id)),
            "trap" => panic!("trampa a propósito"),
            #[allow(clippy::empty_loop)]
            "hang" => loop {},
            "grow" => {
                let mut hoard: Vec<Vec<u8>> = Vec::new();
                loop {
                    hoard.push(vec![1u8; 1 << 20]);
                }
            }
            "huge" => Ok("x".repeat(25_165_825)),
            "host-alloc" => Ok("x".repeat(100 * 1024 * 1024)),
            "invalid" => Ok("esto no es JSON".into()),
            "lie-provenance" => Ok(batch("otro.conector", &ctx.account_id)),
            "lie-account" => Ok(batch("test.hostile", "999")),
            "error" => Err(error("CONNECTOR_TEST", "error de prueba")),
            "big-error" => Err(error("CONNECTOR_TEST", "e".repeat(2_000))),
            "big-code" => Err(error(&"C".repeat(65), "m")),
            _ => Err(error("CONNECTOR_INVALID_CONFIG", "modo desconocido")),
        }
    }
}

#[cfg(target_arch = "wasm32")]
nemein_connector_sdk::export!(Hostile);
