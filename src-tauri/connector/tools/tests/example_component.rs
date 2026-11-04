//! End to end: the recipe builds the example, the result has no imports, and
//! wasmtime runs it with an empty linker and typed bindings for the world.
//! The worker of delivery 2 adds the Windows enclosure around this same call.

use nemein_connector_tools::{check_connector, inspect, WORLD_EXPORTS};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::OnceLock;
use wasmtime::component::{Component, Linker};
use wasmtime::{Config, Engine, Store};

wasmtime::component::bindgen!({ path: "../sdk/wit", world: "connector" });

use exports::nemein::connector::api::Context;

const EXAMPLE: &str = "../examples/fictitious-bank-csv/fixtures";

fn tool(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_nemein-componentize"))
        .args(args)
        .output()
        .expect("run nemein-componentize")
}

/// Built once per test binary with the documented recipe, through the CLI.
fn component_path() -> &'static Path {
    static PATH: OnceLock<PathBuf> = OnceLock::new();
    PATH.get_or_init(|| {
        let out = Path::new(env!("CARGO_TARGET_TMPDIR")).join("fictitious-bank-csv.wasm");
        let result = tool(&["build", "nemein-example-bank-csv", out.to_str().unwrap()]);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let report: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
        let bytes = std::fs::read(&out).unwrap();
        assert_eq!(report["bytes"], bytes.len());
        assert_eq!(report["sha256"], nemein_connector_tools::sha256_hex(&bytes));
        out
    })
}

fn component_bytes() -> Vec<u8> {
    std::fs::read(component_path()).unwrap()
}

fn engine() -> Engine {
    Engine::new(&Config::new()).unwrap()
}

fn instantiate(engine: &Engine, bytes: &[u8]) -> wasmtime::Result<(Store<()>, Connector)> {
    let component = Component::new(engine, bytes)?;
    let mut store = Store::new(engine, ());
    // Empty linker: the host offers nothing a connector could call.
    let connector = Connector::instantiate(&mut store, &component, &Linker::new(engine))?;
    Ok((store, connector))
}

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(EXAMPLE)
            .join(name),
    )
    .unwrap()
}

#[test]
fn recipe_component_has_no_imports_anywhere() {
    let inspection = check_connector(&component_bytes()).unwrap();
    assert!(inspection.component);
    assert!(inspection.imports.is_empty(), "{:?}", inspection.imports);
    // Not even internal shims: the core module imports nothing either.
    assert!(
        inspection.core_imports.is_empty(),
        "{:?}",
        inspection.core_imports
    );
    assert_eq!(inspection.exports, WORLD_EXPORTS);
}

#[test]
fn wasmtime_sees_no_imports_and_runs_it_with_an_empty_linker() {
    let engine = engine();
    let bytes = component_bytes();
    let component = Component::new(&engine, &bytes).unwrap();
    let ty = component.component_type();
    assert_eq!(ty.imports(&engine).count(), 0);
    let exports: Vec<_> = ty
        .exports(&engine)
        .map(|(name, _)| name.to_owned())
        .collect();
    assert_eq!(exports, WORLD_EXPORTS);

    let (mut store, connector) = instantiate(&engine, &bytes).unwrap();
    let api = connector.nemein_connector_api();
    let manifest = api.call_describe(&mut store).unwrap();
    let expected: serde_json::Value = serde_json::from_slice(&fixture("manifest.json")).unwrap();
    assert_eq!(
        serde_json::json!({
            "id": manifest.id, "version": manifest.version, "name": manifest.name,
            "description": manifest.description, "extensions": manifest.extensions,
        }),
        expected
    );

    let ctx = Context {
        config: String::new(),
        account_id: "1".into(),
    };
    let batch = api
        .call_parse(&mut store, &fixture("extracto.csv"), &ctx)
        .unwrap()
        .expect("the fixture is valid");
    let golden = String::from_utf8(fixture("extracto.batch.json")).unwrap();
    assert_eq!(format!("{batch}\n"), golden);

    // Same instance, a rejected file: an error value, not a trap.
    let failure = api
        .call_parse(&mut store, b"not a statement", &ctx)
        .unwrap()
        .unwrap_err();
    assert_eq!(failure.code, "CONNECTOR_FORMAT");
    let bad_context = Context {
        config: String::new(),
        account_id: "01".into(),
    };
    let failure = api
        .call_parse(&mut store, &fixture("extracto.csv"), &bad_context)
        .unwrap()
        .unwrap_err();
    assert_eq!(failure.code, "CONNECTOR_INVALID_CONTEXT");
}

#[test]
fn typed_instantiation_rejects_the_right_name_with_wrong_types() {
    // Passes the static name check, fails the host's typed bindings.
    let impostor = wat::parse_str(
        r#"(component
          (core module $m (func (export "f")))
          (core instance $i (instantiate $m))
          (func $f (canon lift (core func $i "f")))
          (instance $api (export "describe" (func $f)) (export "parse" (func $f)))
          (export "nemein:connector/api@1.0.0" (instance $api))
        )"#,
    )
    .unwrap();
    assert!(check_connector(&impostor).is_ok());
    assert!(instantiate(&engine(), &impostor).is_err());
}

#[test]
fn cli_check_wrap_and_usage() {
    let path = component_path().to_str().unwrap();
    let check = tool(&["check", path]);
    assert!(check.status.success());
    let report: serde_json::Value = serde_json::from_slice(&check.stdout).unwrap();
    assert_eq!(
        report["sha256"],
        nemein_connector_tools::sha256_hex(&component_bytes())
    );

    let out = Path::new(env!("CARGO_TARGET_TMPDIR")).join("rewrapped.wasm");
    // A failed wrap must not leave a file; start without one from earlier runs.
    let _ = std::fs::remove_file(&out);
    let wrap = tool(&["wrap", path, out.to_str().unwrap()]);
    assert!(!wrap.status.success());
    assert!(String::from_utf8_lossy(&wrap.stderr).contains("NOT_A_MODULE"));
    assert!(!out.exists());

    let core = Path::new(env!("CARGO_TARGET_TMPDIR")).join("core.wasm");
    std::fs::write(
        &core,
        wat::parse_str(r#"(module (import "wasi_snapshot_preview1" "fd_write" (func)))"#).unwrap(),
    )
    .unwrap();
    let wasi = tool(&["check", core.to_str().unwrap()]);
    assert!(!wasi.status.success());
    assert!(String::from_utf8_lossy(&wasi.stderr).contains("NOT_A_COMPONENT"));
    let wasi = tool(&["wrap", core.to_str().unwrap(), out.to_str().unwrap()]);
    assert!(String::from_utf8_lossy(&wasi.stderr).contains("HAS_IMPORTS"));
    assert!(!out.exists());

    for args in [
        &[][..],
        &["build"],
        &["check"],
        &["wrap", "a"],
        &["other", "a", "b"],
    ] {
        let usage = tool(args);
        assert!(!usage.status.success(), "{args:?}");
        assert!(usage.stdout.is_empty());
        assert!(String::from_utf8_lossy(&usage.stderr).contains("uso:"));
    }
    let missing = tool(&["check", "/nonexistent/connector.wasm"]);
    assert!(!missing.status.success());
    let unknown = tool(&["build", "nemein-connector-sdk", out.to_str().unwrap()]);
    assert!(String::from_utf8_lossy(&unknown.stderr).contains("no es un conector cdylib"));

    // The wasm core from the recipe wraps to the very same bytes.
    let recipe_core = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../target/recipe/wasm32-unknown-unknown/guest/nemein_example_bank_csv.wasm");
    let wrapped = tool(&["wrap", recipe_core.to_str().unwrap(), out.to_str().unwrap()]);
    assert!(
        wrapped.status.success(),
        "{}",
        String::from_utf8_lossy(&wrapped.stderr)
    );
    assert_eq!(std::fs::read(&out).unwrap(), component_bytes());
    assert_eq!(
        inspect(&std::fs::read(recipe_core).unwrap())
            .unwrap()
            .imports,
        Vec::<String>::new()
    );
}
