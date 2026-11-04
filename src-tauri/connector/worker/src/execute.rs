//! Runs one request against one component, inside the worker process.
//!
//! The worker is already enclosed when this runs. Everything here is defense
//! in depth on top of that: no imports, bounded guest memory and tables, a
//! small feature set, and sizes capped before anything leaves the process.

use crate::frame::Frame;
use crate::limits::*;
use crate::protocol::{self, code, ConnectorError, Manifest, Op, RequestHeader};
use wasmtime::component::{Component, Linker};
use wasmtime::{Config, Engine, Store, StoreLimits, StoreLimitsBuilder};

wasmtime::component::bindgen!({ path: "../sdk/wit", world: "connector" });

use exports::nemein::connector::api;

/// The engine every run uses. Proposals a connector does not need stay off;
/// threads and GC are not even compiled into this binary.
pub fn engine() -> wasmtime::Result<Engine> {
    let mut config = Config::new();
    config
        .wasm_component_model(true)
        .max_wasm_stack(GUEST_STACK_MAX)
        .wasm_memory64(false)
        .wasm_multi_memory(false)
        .wasm_relaxed_simd(false)
        .wasm_tail_call(false)
        .wasm_wide_arithmetic(false)
        .wasm_custom_page_sizes(false)
        .wasm_stack_switching(false);
    Engine::new(&config)
}

fn limits() -> StoreLimits {
    StoreLimitsBuilder::new()
        .memory_size(GUEST_MEMORY_MAX)
        .table_elements(GUEST_TABLE_ELEMENTS_MAX)
        .instances(GUEST_INSTANCES_MAX)
        .tables(GUEST_TABLES_MAX)
        .memories(GUEST_MEMORIES_MAX)
        .trap_on_grow_failure(true)
        .build()
}

/// First line of an error chain, bounded: enough to diagnose, never the
/// connector's data.
fn describe_error(error: &wasmtime::Error) -> String {
    format!("{error:#}")
        .lines()
        .next()
        .unwrap_or_default()
        .to_owned()
}

/// Counts top-level imports of any kind (functions, instances, types, modules,
/// components) without compiling. wasmtime's `imports()` does not list type
/// imports, and the contract allows none at all.
fn top_level_imports(bytes: &[u8]) -> Result<usize, String> {
    let mut depth = 0usize;
    let mut imports = 0usize;
    for payload in wasmparser::Parser::new(0).parse_all(bytes) {
        match payload.map_err(|e| e.to_string())? {
            wasmparser::Payload::Version { encoding, .. } => {
                if depth == 0 && encoding != wasmparser::Encoding::Component {
                    return Err("se esperaba un componente, no un módulo".into());
                }
                depth += 1;
            }
            wasmparser::Payload::End(_) => depth = depth.saturating_sub(1),
            wasmparser::Payload::ComponentImportSection(section) if depth == 1 => {
                imports += section.count() as usize;
            }
            _ => {}
        }
    }
    Ok(imports)
}

fn manifest_too_large(manifest: &Manifest) -> bool {
    let bytes = manifest.id.len()
        + manifest.version.len()
        + manifest.name.len()
        + manifest.description.len()
        + manifest.extensions.iter().map(String::len).sum::<usize>();
    bytes > MANIFEST_MAX || manifest.extensions.len() > MANIFEST_EXTENSIONS_MAX
}

fn error_too_large(error: &api::Error) -> bool {
    error.code.chars().count() > ERROR_CODE_MAX || error.message.chars().count() > ERROR_MESSAGE_MAX
}

/// Answers one request frame with one response frame. Never panics on input.
pub fn execute(request: &Frame) -> Frame {
    let header: RequestHeader = match serde_json::from_slice(&request.header) {
        Ok(header) => header,
        Err(_) => return protocol::host_error(code::REQUEST_INVALID, "encabezado inválido"),
    };
    let [component, input] = request.blobs.as_slice() else {
        return protocol::host_error(
            code::REQUEST_INVALID,
            "se esperaban el componente y el archivo",
        );
    };
    if header.config.len() > CONFIG_MAX || header.account_id.len() > ACCOUNT_ID_MAX {
        return protocol::host_error(code::REQUEST_INVALID, "contexto demasiado grande");
    }
    if header.op == Op::Describe && !input.is_empty() {
        return protocol::host_error(code::REQUEST_INVALID, "describe no recibe archivo");
    }
    let engine = match engine() {
        Ok(engine) => engine,
        Err(error) => return protocol::host_error(code::REQUEST_INVALID, &describe_error(&error)),
    };
    match top_level_imports(component) {
        Ok(0) => {}
        Ok(imports) => {
            return protocol::host_error(
                code::COMPONENT_HAS_IMPORTS,
                &format!("el componente declara {imports} imports"),
            )
        }
        Err(message) => return protocol::host_error(code::COMPONENT_INVALID, &message),
    }
    // Compiling reads and translates the component; it runs none of its code.
    let component = match Component::new(&engine, component) {
        Ok(component) => component,
        Err(error) => {
            return protocol::host_error(code::COMPONENT_INVALID, &describe_error(&error))
        }
    };
    // No second import check here: wasmtime's `imports()` lists a subset of
    // what the pre-scan above counted, which was zero.
    let mut store = Store::new(&engine, limits());
    store.limiter(|limits| limits);
    // Bounds what the host lifts out of the guest per call, results included:
    // a giant string fails here instead of exhausting the process.
    store.set_hostcall_fuel(HOSTCALL_FUEL);
    // An empty linker: there is nothing a connector could call.
    let connector = match Connector::instantiate(&mut store, &component, &Linker::new(&engine)) {
        Ok(connector) => connector,
        Err(error) => {
            return protocol::host_error(code::COMPONENT_WRONG_WORLD, &describe_error(&error))
        }
    };
    let api = connector.nemein_connector_api();
    let manifest = match api.call_describe(&mut store) {
        Ok(manifest) => Manifest {
            id: manifest.id,
            version: manifest.version,
            name: manifest.name,
            description: manifest.description,
            extensions: manifest.extensions,
        },
        Err(error) => return protocol::host_error(code::CONNECTOR_TRAP, &describe_error(&error)),
    };
    if manifest_too_large(&manifest) {
        return protocol::host_error(code::MANIFEST_TOO_LARGE, "el manifiesto supera su límite");
    }
    if header.op == Op::Describe {
        return protocol::ok(manifest, None);
    }
    let ctx = api::Context {
        config: header.config,
        account_id: header.account_id,
    };
    match api.call_parse(&mut store, input, &ctx) {
        Err(error) => protocol::host_error(code::CONNECTOR_TRAP, &describe_error(&error)),
        Ok(Ok(batch)) if batch.len() > OUTPUT_MAX => {
            protocol::host_error(code::OUTPUT_TOO_LARGE, "el lote supera su límite")
        }
        Ok(Ok(batch)) => protocol::ok(manifest, Some(batch)),
        Ok(Err(error)) if error_too_large(&error) => protocol::host_error(
            code::ERROR_TOO_LARGE,
            "el error del conector supera su límite",
        ),
        Ok(Err(error)) => protocol::connector_error(
            manifest,
            ConnectorError {
                code: error.code,
                message: error.message,
            },
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasmtime::ResourceLimiter;

    #[test]
    fn the_manifest_cap_counts_every_field_once() {
        let at = Manifest {
            id: "i".repeat(10),
            version: "v".repeat(20),
            name: "n".repeat(30),
            description: "d".repeat(MANIFEST_MAX - 10 - 20 - 30 - 15 - 25),
            extensions: vec!["e".repeat(15), "f".repeat(25)],
        };
        assert!(!manifest_too_large(&at));
        // One byte more in any single field crosses the cap.
        for field in 0..5 {
            let mut over = at.clone();
            match field {
                0 => over.id.push('i'),
                1 => over.version.push('v'),
                2 => over.name.push('n'),
                3 => over.description.push('d'),
                _ => over.extensions[1].push('f'),
            }
            assert!(manifest_too_large(&over), "field {field}");
        }
        let small = |count| Manifest {
            id: "i".into(),
            version: "1".into(),
            name: "n".into(),
            description: String::new(),
            extensions: vec!["csv".into(); count],
        };
        assert!(!manifest_too_large(&small(MANIFEST_EXTENSIONS_MAX)));
        assert!(manifest_too_large(&small(MANIFEST_EXTENSIONS_MAX + 1)));
    }

    #[test]
    fn the_error_cap_counts_characters() {
        let error = |code: String, message: String| api::Error { code, message };
        assert!(!error_too_large(&error(
            "C".repeat(ERROR_CODE_MAX),
            "ñ".repeat(ERROR_MESSAGE_MAX)
        )));
        assert!(error_too_large(&error(
            "C".repeat(ERROR_CODE_MAX + 1),
            "m".into()
        )));
        assert!(error_too_large(&error(
            "C".into(),
            "ñ".repeat(ERROR_MESSAGE_MAX + 1)
        )));
    }

    #[test]
    fn the_store_limits_are_the_documented_ones() {
        let mut limits = limits();
        assert!(limits.memory_growing(0, GUEST_MEMORY_MAX, None).unwrap());
        // trap_on_grow_failure: past the limit the guest traps.
        assert!(limits
            .memory_growing(0, GUEST_MEMORY_MAX + 1, None)
            .is_err());
        assert!(limits
            .table_growing(0, GUEST_TABLE_ELEMENTS_MAX, None)
            .unwrap());
        assert!(limits
            .table_growing(0, GUEST_TABLE_ELEMENTS_MAX + 1, None)
            .is_err());
        assert_eq!(limits.instances(), GUEST_INSTANCES_MAX);
        assert_eq!(limits.tables(), GUEST_TABLES_MAX);
        assert_eq!(limits.memories(), GUEST_MEMORIES_MAX);
    }

    #[test]
    fn errors_are_described_by_their_first_line() {
        let chained = wasmtime::Error::msg("causa").context("contexto");
        assert_eq!(describe_error(&chained), "contexto: causa");
        let lines = wasmtime::Error::msg("primera\nsegunda");
        assert_eq!(describe_error(&lines), "primera");
    }

    #[test]
    fn imports_after_a_nested_component_are_top_level() {
        // The nested component ends before the import: depth goes back to 1.
        let bytes = wat::parse_str(
            r#"(component
                 (component)
                 (type $r (record (field "a" string)))
                 (import "manifest" (type (eq $r))))"#,
        )
        .unwrap();
        assert_eq!(top_level_imports(&bytes), Ok(1));
        // Imports inside a nested component are not the outer one's.
        let nested = wat::parse_str(r#"(component (component (import "f" (func))))"#).unwrap();
        assert_eq!(top_level_imports(&nested), Ok(0));
    }
}
