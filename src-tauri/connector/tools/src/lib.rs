//! Build and inspection tooling for `nemein:connector@1.0.0` components.
//!
//! Everything here reads bytes; nothing executes a connector. The recipe is
//! `wasm32-unknown-unknown` plus `wit-component`, without WASI or adapters, and
//! every component it produces must have no imports at all.

use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fmt;
use std::path::{Path, PathBuf};
use wasmparser::{Encoding, Parser, Payload, Validator, WasmFeatures};

/// The only export of the world: the `api` instance with `describe` and `parse`.
/// Its function types are checked when the host instantiates it with typed
/// bindings; this module only reads names.
pub const WORLD_EXPORTS: [&str; 1] = ["nemein:connector/api@1.0.0"];

/// A rejected input, with a stable code for tests and scripts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolError {
    pub code: &'static str,
    pub message: String,
}

impl fmt::Display for ToolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ToolError {}

fn fail(code: &'static str, message: impl Into<String>) -> ToolError {
    ToolError {
        code,
        message: message.into(),
    }
}

pub const INVALID_WASM: &str = "INVALID_WASM";
pub const NOT_A_COMPONENT: &str = "NOT_A_COMPONENT";
pub const NOT_A_MODULE: &str = "NOT_A_MODULE";
pub const HAS_IMPORTS: &str = "HAS_IMPORTS";
pub const WRONG_EXPORTS: &str = "WRONG_EXPORTS";
pub const ENCODE_FAILED: &str = "ENCODE_FAILED";
pub const UNSUPPORTED_SOURCE: &str = "UNSUPPORTED_SOURCE";

/// What a binary declares, read without compiling or running it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Inspection {
    /// `true` for a component, `false` for a core module.
    pub component: bool,
    /// Top-level imports: for a component, what the host would have to provide.
    pub imports: Vec<String>,
    /// Top-level exports, sorted.
    pub exports: Vec<String>,
    /// Imports of every core module inside, as `module::name`.
    pub core_imports: Vec<String>,
}

/// Validates `bytes` and lists their imports and exports.
pub fn inspect(bytes: &[u8]) -> Result<Inspection, ToolError> {
    Validator::new_with_features(WasmFeatures::default())
        .validate_all(bytes)
        .map_err(|e| fail(INVALID_WASM, format!("binario WebAssembly inválido: {e}")))?;
    let invalid = |e: wasmparser::BinaryReaderError| fail(INVALID_WASM, e.to_string());
    let mut inspection = Inspection {
        component: false,
        imports: Vec::new(),
        exports: Vec::new(),
        core_imports: Vec::new(),
    };
    // Nested modules and components each start with Version and finish with End.
    let mut depth = 0usize;
    for payload in Parser::new(0).parse_all(bytes) {
        match payload.map_err(invalid)? {
            Payload::Version { encoding, .. } => {
                if depth == 0 {
                    inspection.component = encoding == Encoding::Component;
                }
                depth += 1;
            }
            Payload::End(_) => depth -= 1,
            Payload::ComponentImportSection(section) if depth == 1 => {
                for import in section {
                    inspection
                        .imports
                        .push(import.map_err(invalid)?.name.name.to_owned());
                }
            }
            Payload::ComponentExportSection(section) if depth == 1 => {
                for export in section {
                    inspection
                        .exports
                        .push(export.map_err(invalid)?.name.name.to_owned());
                }
            }
            Payload::ImportSection(section) => {
                for import in section.into_imports() {
                    let import = import.map_err(invalid)?;
                    let name = format!("{}::{}", import.module, import.name);
                    if depth == 1 {
                        inspection.imports.push(name.clone());
                    }
                    inspection.core_imports.push(name);
                }
            }
            Payload::ExportSection(section) if depth == 1 => {
                for export in section {
                    inspection
                        .exports
                        .push(export.map_err(invalid)?.name.to_owned());
                }
            }
            _ => {}
        }
    }
    inspection.exports.sort();
    Ok(inspection)
}

/// Accepts only a component without imports that exports exactly the world.
pub fn check_connector(bytes: &[u8]) -> Result<Inspection, ToolError> {
    let inspection = inspect(bytes)?;
    if !inspection.component {
        return Err(fail(
            NOT_A_COMPONENT,
            "se esperaba un componente, no un módulo",
        ));
    }
    if !inspection.imports.is_empty() {
        return Err(fail(
            HAS_IMPORTS,
            format!("el componente importa {}", inspection.imports.join(", ")),
        ));
    }
    if inspection.exports != WORLD_EXPORTS {
        return Err(fail(
            WRONG_EXPORTS,
            format!(
                "el componente exporta [{}] en lugar de [{}]",
                inspection.exports.join(", "),
                WORLD_EXPORTS.join(", ")
            ),
        ));
    }
    Ok(inspection)
}

/// Wraps a core module built with the SDK as a component.
///
/// The module itself must import nothing: a WASI import means the recipe was not
/// followed, and no adapter is ever linked to satisfy it.
pub fn componentize(core: &[u8]) -> Result<Vec<u8>, ToolError> {
    let module = inspect(core)?;
    if module.component {
        return Err(fail(
            NOT_A_MODULE,
            "se esperaba un módulo núcleo, no un componente",
        ));
    }
    if !module.imports.is_empty() {
        return Err(fail(
            HAS_IMPORTS,
            format!("el módulo importa {}", module.imports.join(", ")),
        ));
    }
    let component = wit_component::ComponentEncoder::default()
        .validate(true)
        .module(core)
        .and_then(|encoder| encoder.encode())
        .map_err(|e| fail(ENCODE_FAILED, format!("{e:#}")))?;
    check_connector(&component)?;
    Ok(component)
}

/// Lower-case hex SHA-256, the identity of a component's bytes.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The registry source folders of every dependency in `cargo metadata` output.
///
/// Their absolute paths end up in panic locations, so the recipe remaps them.
/// Only registry and path packages are supported: another source kind would
/// leave an unremapped path and break reproducibility, so it is refused.
pub fn registry_roots(metadata: &serde_json::Value) -> Result<BTreeSet<PathBuf>, ToolError> {
    let packages = metadata["packages"]
        .as_array()
        .ok_or_else(|| fail(UNSUPPORTED_SOURCE, "cargo metadata sin packages"))?;
    let mut roots = BTreeSet::new();
    for package in packages {
        let Some(source) = package["source"].as_str() else {
            continue;
        };
        let manifest = package["manifest_path"].as_str().map(Path::new);
        let root = manifest.and_then(Path::parent).and_then(Path::parent);
        match root {
            Some(root) if source.starts_with("registry+") || source.starts_with("sparse+") => {
                roots.insert(root.to_path_buf());
            }
            _ => {
                return Err(fail(
                    UNSUPPORTED_SOURCE,
                    format!("fuente no admitida en la receta: {source}"),
                ))
            }
        }
    }
    Ok(roots)
}

/// `CARGO_ENCODED_RUSTFLAGS` that replace each registry root with a fixed prefix.
pub fn remap_rustflags(roots: &BTreeSet<PathBuf>) -> String {
    roots
        .iter()
        .map(|root| {
            let name = root
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            format!(
                "--remap-path-prefix={}=/cargo/registry/src/{name}",
                root.display()
            )
        })
        .collect::<Vec<_>>()
        .join("\x1f")
}
