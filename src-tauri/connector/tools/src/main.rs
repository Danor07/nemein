//! `nemein-componentize`: the reproducible connector recipe.
//!
//! ```text
//! nemein-componentize build <package> <out.wasm>   compile, wrap and check
//! nemein-componentize wrap <core.wasm> <out.wasm>  wrap and check a core module
//! nemein-componentize check <component.wasm>       check a component
//! ```
//!
//! On success it prints one JSON line with the size and SHA-256 of the
//! component; on failure, the reason on stderr and a non-zero exit status.

use nemein_connector_tools::{
    check_connector, componentize, registry_roots, remap_rustflags, sha256_hex, ToolError,
};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

const TARGET: &str = "wasm32-unknown-unknown";
const PROFILE: &str = "guest";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["build", package, out] => build(package, Path::new(out)),
        ["wrap", core, out] => read(Path::new(core)).and_then(|core| write(&core, Path::new(out))),
        ["check", component] => read(Path::new(component)).and_then(|bytes| {
            check_connector(&bytes).map_err(|e| e.to_string())?;
            Ok(report(&bytes))
        }),
        _ => Err("uso: nemein-componentize build <paquete> <salida.wasm> | wrap <núcleo.wasm> <salida.wasm> | check <componente.wasm>".to_owned()),
    };
    match result {
        Ok(line) => {
            println!("{line}");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("nemein-componentize: {message}");
            ExitCode::FAILURE
        }
    }
}

fn read(path: &Path) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))
}

fn write(core: &[u8], out: &Path) -> Result<String, String> {
    let component = componentize(core).map_err(|e: ToolError| e.to_string())?;
    std::fs::write(out, &component).map_err(|e| format!("{}: {e}", out.display()))?;
    Ok(report(&component))
}

fn report(component: &[u8]) -> String {
    format!(
        r#"{{"bytes":{},"sha256":"{}"}}"#,
        component.len(),
        sha256_hex(component)
    )
}

/// Compiles `package` for the guest profile with every registry path remapped,
/// so the bytes do not depend on the checkout folder or on CARGO_HOME.
fn build(package: &str, out: &Path) -> Result<String, String> {
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("../Cargo.toml");
    let metadata = Command::new(&cargo)
        .args([
            "metadata",
            "--format-version",
            "1",
            "--locked",
            "--filter-platform",
            TARGET,
        ])
        .arg("--manifest-path")
        .arg(&manifest)
        .output()
        .map_err(|e| format!("cargo metadata: {e}"))?;
    if !metadata.status.success() {
        return Err(format!(
            "cargo metadata: {}",
            String::from_utf8_lossy(&metadata.stderr)
        ));
    }
    let metadata: serde_json::Value =
        serde_json::from_slice(&metadata.stdout).map_err(|e| format!("cargo metadata: {e}"))?;
    let flags = remap_rustflags(&registry_roots(&metadata).map_err(|e| e.to_string())?);
    let workspace = metadata["workspace_root"]
        .as_str()
        .map(PathBuf::from)
        .ok_or("cargo metadata sin workspace_root")?;
    let library = metadata["packages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p["name"] == package && p["source"].is_null())
        .flat_map(|p| p["targets"].as_array().into_iter().flatten())
        .find(|t| {
            t["kind"]
                .as_array()
                .is_some_and(|k| k.iter().any(|k| k == "cdylib"))
        })
        .and_then(|t| t["name"].as_str())
        .map(|name| name.replace('-', "_"))
        .ok_or_else(|| format!("{package} no es un conector cdylib del workspace"))?;
    let target_dir = workspace.join("target").join("recipe");
    let status = Command::new(&cargo)
        .current_dir(&workspace)
        .env_remove("RUSTFLAGS")
        .env("CARGO_ENCODED_RUSTFLAGS", flags)
        .args([
            "build",
            "--locked",
            "--profile",
            PROFILE,
            "--target",
            TARGET,
            "-p",
            package,
        ])
        .arg("--target-dir")
        .arg(&target_dir)
        .status()
        .map_err(|e| format!("cargo build: {e}"))?;
    if !status.success() {
        return Err(format!("cargo build terminó con {status}"));
    }
    let core = read(
        &target_dir
            .join(TARGET)
            .join(PROFILE)
            .join(format!("{library}.wasm")),
    )?;
    write(&core, out)
}
