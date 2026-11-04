//! Inspection of hand-written hostile and edge-case binaries. Nothing runs.

use nemein_connector_tools::*;
use proptest::prelude::*;
use proptest::test_runner::{Config, RngSeed};
use std::collections::BTreeSet;
use std::path::PathBuf;

fn wasm(text: &str) -> Vec<u8> {
    wat::parse_str(text).expect("valid WAT")
}

/// Closed component with the world's export name. Its function types are wrong
/// on purpose: only typed instantiation can see that (`example_component.rs`).
const NAMED_API: &str = r#"(component
  (core module $m (func (export "f")))
  (core instance $i (instantiate $m))
  (func $f (canon lift (core func $i "f")))
  (instance $api (export "describe" (func $f)) (export "parse" (func $f)))
  (export "nemein:connector/api@1.0.0" (instance $api))
)"#;

fn code(result: Result<impl std::fmt::Debug, ToolError>) -> &'static str {
    result.expect_err("must be rejected").code
}

#[test]
fn core_modules() {
    let plain = inspect(&wasm(
        r#"(module (func (export "b")) (func (export "a")) (memory (export "memory") 1))"#,
    ))
    .unwrap();
    assert!(!plain.component);
    assert!(plain.imports.is_empty() && plain.core_imports.is_empty());
    assert_eq!(plain.exports, ["a", "b", "memory"]);

    let wasi = wasm(
        r#"(module (import "wasi_snapshot_preview1" "fd_write" (func (param i32 i32 i32 i32) (result i32))))"#,
    );
    let inspection = inspect(&wasi).unwrap();
    assert_eq!(inspection.imports, ["wasi_snapshot_preview1::fd_write"]);
    assert_eq!(inspection.core_imports, inspection.imports);
    // The recipe never links an adapter: a WASI import is refused before encoding.
    assert_eq!(code(componentize(&wasi)), HAS_IMPORTS);
    assert_eq!(code(check_connector(&wasi)), NOT_A_COMPONENT);
}

#[test]
fn component_imports_of_every_kind_are_refused() {
    for (text, name) in [
        (r#"(component (import "host-log" (func)))"#, "host-log"),
        (
            r#"(component (import "wasi:cli/stdout@0.2.0" (instance)))"#,
            "wasi:cli/stdout@0.2.0",
        ),
        // What a world-level record becomes: a type import, refused as well.
        (
            r#"(component (type $r (record (field "a" string))) (import "manifest" (type (eq $r))))"#,
            "manifest",
        ),
        (r#"(component (import "res" (type (sub resource))))"#, "res"),
        (r#"(component (import "m" (core module)))"#, "m"),
        (r#"(component (import "c" (component)))"#, "c"),
    ] {
        let bytes = wasm(text);
        assert_eq!(inspect(&bytes).unwrap().imports, [name], "{text}");
        let failure = check_connector(&bytes).unwrap_err();
        assert_eq!(failure.code, HAS_IMPORTS, "{text}");
        assert!(failure.message.contains(name));
        assert_eq!(code(componentize(&bytes)), NOT_A_MODULE);
    }
}

#[test]
fn exports_must_be_exactly_the_world() {
    let closed = wasm(NAMED_API);
    let inspection = check_connector(&closed).unwrap();
    assert!(inspection.component && inspection.imports.is_empty());
    assert_eq!(inspection.exports, WORLD_EXPORTS);
    assert!(inspection.core_imports.is_empty());

    let extra = wasm(&NAMED_API.replace(
        "(export \"nemein:connector/api@1.0.0\" (instance $api))",
        "(export \"nemein:connector/api@1.0.0\" (instance $api)) (export \"extra\" (func $f))",
    ));
    assert_eq!(
        inspect(&extra).unwrap().exports,
        ["extra", "nemein:connector/api@1.0.0"]
    );
    assert_eq!(code(check_connector(&extra)), WRONG_EXPORTS);

    for name in [
        "nemein:connector/api@1.0.1",
        "nemein:connector/api@2.0.0",
        "nemein:other/api@1.0.0",
        "describe",
    ] {
        let renamed = wasm(&NAMED_API.replace("nemein:connector/api@1.0.0", name));
        assert_eq!(code(check_connector(&renamed)), WRONG_EXPORTS, "{name}");
    }
    assert_eq!(code(check_connector(&wasm("(component)"))), WRONG_EXPORTS);
}

#[test]
fn nested_imports_are_internal_but_reported() {
    // A core module inside a component imports only from instances the
    // component itself creates; the host provides nothing.
    let bytes = wasm(
        r#"(component
      (core module $a (func (export "f")))
      (core module $b (import "a" "f" (func)))
      (core instance $ia (instantiate $a))
      (core instance $ib (instantiate $b (with "a" (instance $ia))))
      (component $inner (import "x" (func)))
    )"#,
    );
    let inspection = inspect(&bytes).unwrap();
    assert!(inspection.component);
    assert!(inspection.imports.is_empty());
    assert_eq!(inspection.core_imports, ["a::f"]);
    assert_eq!(code(check_connector(&bytes)), WRONG_EXPORTS);
}

#[test]
fn invalid_binaries() {
    for bytes in [
        Vec::new(),
        b"\0asm".to_vec(),
        b"not wasm at all".to_vec(),
        wasm(NAMED_API)[..20].to_vec(),
        // A module whose export refers to a function that does not exist.
        vec![0, b'a', b's', b'm', 1, 0, 0, 0, 7, 5, 1, 1, b'f', 0, 9],
    ] {
        assert_eq!(code(inspect(&bytes)), INVALID_WASM, "{bytes:?}");
        assert_eq!(code(check_connector(&bytes)), INVALID_WASM);
        assert_eq!(code(componentize(&bytes)), INVALID_WASM);
    }
}

#[test]
fn modules_without_world_metadata_are_not_connectors() {
    let failure = componentize(&wasm(r#"(module (func (export "describe")))"#)).unwrap_err();
    assert!(
        [ENCODE_FAILED, WRONG_EXPORTS].contains(&failure.code),
        "{failure}"
    );
    assert!(!failure.message.is_empty());
}

#[test]
fn sha256_vectors() {
    assert_eq!(
        sha256_hex(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        sha256_hex(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn registry_roots_and_remap() {
    let metadata = serde_json::json!({ "packages": [
        { "name": "own", "source": null, "manifest_path": "/w/own/Cargo.toml" },
        { "name": "a", "source": "registry+https://github.com/rust-lang/crates.io-index",
          "manifest_path": "/h/.cargo/registry/src/index.crates.io-x/a-1.0.0/Cargo.toml" },
        { "name": "b", "source": "sparse+https://index.crates.io/",
          "manifest_path": "/h/.cargo/registry/src/index.crates.io-x/b-2.0.0/Cargo.toml" },
        { "name": "c", "source": "registry+https://mirror.example/index",
          "manifest_path": "/h/.cargo/registry/src/mirror-y/c-3.0.0/Cargo.toml" },
    ]});
    let roots = registry_roots(&metadata).unwrap();
    let expected: BTreeSet<PathBuf> = [
        "/h/.cargo/registry/src/index.crates.io-x",
        "/h/.cargo/registry/src/mirror-y",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect();
    assert_eq!(roots, expected);
    assert_eq!(
        remap_rustflags(&roots),
        "--remap-path-prefix=/h/.cargo/registry/src/index.crates.io-x=/cargo/registry/src/index.crates.io-x\x1f--remap-path-prefix=/h/.cargo/registry/src/mirror-y=/cargo/registry/src/mirror-y"
    );
    assert_eq!(remap_rustflags(&BTreeSet::new()), "");

    for bad in [
        serde_json::json!({}),
        serde_json::json!({ "packages": {} }),
        serde_json::json!({ "packages": [{ "source": "git+https://example/repo#abc", "manifest_path": "/g/x/Cargo.toml" }] }),
        serde_json::json!({ "packages": [{ "source": "registry+https://x" }] }),
        serde_json::json!({ "packages": [{ "source": "registry+https://x", "manifest_path": "Cargo.toml" }] }),
    ] {
        assert_eq!(
            registry_roots(&bad).unwrap_err().code,
            UNSUPPORTED_SOURCE,
            "{bad}"
        );
    }
}

fn config(cases: u32, seed: u64) -> Config {
    Config {
        cases,
        rng_seed: RngSeed::Fixed(seed),
        failure_persistence: None,
        ..Config::default()
    }
}

proptest! {
    #![proptest_config(config(256, 0x6e65_6d65_696e_0201))]

    /// Every import is listed and refused, whatever its name or count.
    #[test]
    fn any_import_is_listed_and_refused(names in proptest::collection::btree_set("[a-z]{1,8}(-[a-z]{1,8}){0,2}", 1..6)) {
        let imports: String = names.iter().map(|n| format!("(import \"{n}\" (func))")).collect();
        let bytes = wasm(&NAMED_API.replacen("(component", &format!("(component {imports}"), 1));
        let inspection = inspect(&bytes).unwrap();
        let listed: BTreeSet<String> = inspection.imports.iter().cloned().collect();
        prop_assert_eq!(&listed, &names);
        prop_assert_eq!(inspection.imports.len(), names.len());
        prop_assert_eq!(check_connector(&bytes).unwrap_err().code, HAS_IMPORTS);
    }

    /// Corrupted bytes never panic the inspector; what still validates keeps
    /// the closed shape or is refused with a known code.
    #[test]
    fn corrupted_components_fail_closed(edits in proptest::collection::vec((any::<usize>(), any::<u8>(), any::<bool>()), 1..8)) {
        let mut bytes = wasm(NAMED_API);
        for (position, byte, insert) in edits {
            let at = position % bytes.len();
            if insert { bytes.insert(at, byte) } else { bytes[at] = byte }
        }
        match check_connector(&bytes) {
            Ok(inspection) => {
                prop_assert!(inspection.component && inspection.imports.is_empty());
                prop_assert_eq!(inspection.exports, WORLD_EXPORTS);
            }
            Err(failure) => prop_assert!([INVALID_WASM, NOT_A_COMPONENT, HAS_IMPORTS, WRONG_EXPORTS].contains(&failure.code)),
        }
    }

    #[test]
    fn arbitrary_bytes_never_panic(bytes in proptest::collection::vec(any::<u8>(), 0..256)) {
        let _ = inspect(&bytes);
        let _ = componentize(&bytes);
    }
}
