//! The worker's run of one request, in process: real components built with the
//! recipe, hostile ones included. Anything that can hang is tested through the
//! supervisor in `supervise.rs`, where the wall clock applies.

mod common;

use common::{component, fixture, header, request};
use nemein_connector::execute::execute;
use nemein_connector::frame::Frame;
use nemein_connector::limits::{ACCOUNT_ID_MAX, CONFIG_MAX};
use nemein_connector::protocol::{code, Op};

fn hostile(config: &str) -> Frame {
    execute(&request(
        Op::Parse,
        component("nemein-fixture-hostile"),
        Vec::new(),
        config,
        "7",
    ))
}

fn host_code(frame: &Frame) -> String {
    let h = header(frame);
    assert_eq!(h["status"], "host_error", "{h}");
    assert!(frame.blobs.is_empty());
    h["code"].as_str().unwrap().to_owned()
}

#[test]
fn example_parse_and_describe() {
    let example = component("nemein-example-bank-csv");
    let out = execute(&request(
        Op::Parse,
        example.clone(),
        fixture("extracto.csv"),
        "",
        "1",
    ));
    let h = header(&out);
    assert_eq!(h["status"], "ok");
    let manifest: serde_json::Value = serde_json::from_slice(&fixture("manifest.json")).unwrap();
    assert_eq!(h["manifest"], manifest);
    assert_eq!(
        format!("{}\n", String::from_utf8(out.blobs[0].clone()).unwrap()),
        String::from_utf8(fixture("extracto.batch.json")).unwrap()
    );

    let described = execute(&request(Op::Describe, example.clone(), Vec::new(), "", "1"));
    assert_eq!(header(&described)["status"], "ok");
    assert_eq!(header(&described)["manifest"], manifest);
    assert!(described.blobs.is_empty());

    let rejected = execute(&request(
        Op::Parse,
        example,
        b"no es un extracto".to_vec(),
        "",
        "1",
    ));
    let h = header(&rejected);
    assert_eq!(h["status"], "connector_error");
    assert_eq!(h["error"]["code"], "CONNECTOR_FORMAT");
    assert_eq!(h["manifest"], manifest);
}

#[test]
fn connector_results_and_their_limits() {
    let ok = hostile("valid");
    assert_eq!(header(&ok)["status"], "ok");
    // The worker relays what the connector wrote; Node validates it.
    for config in ["invalid", "lie-provenance", "lie-account"] {
        let out = hostile(config);
        assert_eq!(header(&out)["status"], "ok", "{config}");
        assert_eq!(out.blobs.len(), 1);
    }
    let failed = hostile("error");
    assert_eq!(
        header(&failed)["error"],
        serde_json::json!({"code": "CONNECTOR_TEST", "message": "error de prueba"})
    );
    assert_eq!(host_code(&hostile("big-error")), code::ERROR_TOO_LARGE);
    assert_eq!(host_code(&hostile("big-code")), code::ERROR_TOO_LARGE);
    assert_eq!(host_code(&hostile("huge")), code::OUTPUT_TOO_LARGE);
}

#[test]
fn traps_and_memory_are_contained() {
    assert_eq!(host_code(&hostile("trap")), code::CONNECTOR_TRAP);
    // Linear memory stops at its limit and the connector traps.
    assert_eq!(host_code(&hostile("grow")), code::CONNECTOR_TRAP);
    // A 100 MB result exceeds what the host lifts in one call: it fails in
    // the guest's turn instead of making the host allocate it.
    let out = hostile("host-alloc");
    assert_eq!(host_code(&out), code::CONNECTOR_TRAP);
}

#[test]
fn lying_manifests_are_capped() {
    let out = execute(&request(
        Op::Describe,
        component("nemein-fixture-hostile-manifest"),
        Vec::new(),
        "",
        "1",
    ));
    assert_eq!(host_code(&out), code::MANIFEST_TOO_LARGE);
}

#[test]
fn components_outside_the_world_are_refused() {
    let compile = |text: &str| {
        execute(&request(
            Op::Describe,
            wat::parse_str(text).unwrap(),
            Vec::new(),
            "",
            "1",
        ))
    };
    assert_eq!(
        host_code(&compile(r#"(component (import "host-log" (func)))"#)),
        code::COMPONENT_HAS_IMPORTS
    );
    assert_eq!(
        host_code(&compile(
            r#"(component (type $r (record (field "a" string))) (import "manifest" (type (eq $r))))"#
        )),
        code::COMPONENT_HAS_IMPORTS
    );
    // Right export name, wrong function types: typed instantiation refuses it.
    let impostor = r#"(component
      (core module $m (func (export "f")))
      (core instance $i (instantiate $m))
      (func $f (canon lift (core func $i "f")))
      (instance $api (export "describe" (func $f)) (export "parse" (func $f)))
      (export "nemein:connector/api@1.0.0" (instance $api)))"#;
    assert_eq!(host_code(&compile(impostor)), code::COMPONENT_WRONG_WORLD);
    assert_eq!(
        host_code(&compile("(component)")),
        code::COMPONENT_WRONG_WORLD
    );
    // Core modules and garbage are not components.
    assert_eq!(host_code(&compile("(module)")), code::COMPONENT_INVALID);
    let garbage = execute(&request(
        Op::Describe,
        b"\0asm garbage".to_vec(),
        Vec::new(),
        "",
        "1",
    ));
    assert_eq!(host_code(&garbage), code::COMPONENT_INVALID);
    // Proposals a connector does not need are off: memory64 fails validation.
    assert_eq!(
        host_code(&compile("(component (core module (memory i64 1)))")),
        code::COMPONENT_INVALID
    );
}

#[test]
fn malformed_requests_are_refused_before_compiling() {
    let example = component("nemein-example-bank-csv");
    let mut frame = request(Op::Parse, example.clone(), Vec::new(), "", "1");
    frame.header = b"{".to_vec();
    assert_eq!(host_code(&execute(&frame)), code::REQUEST_INVALID);
    let mut frame = request(Op::Parse, example.clone(), Vec::new(), "", "1");
    frame.blobs.pop();
    assert_eq!(host_code(&execute(&frame)), code::REQUEST_INVALID);
    let big_config = request(
        Op::Parse,
        example.clone(),
        Vec::new(),
        &"c".repeat(CONFIG_MAX + 1),
        "1",
    );
    assert_eq!(host_code(&execute(&big_config)), code::REQUEST_INVALID);
    let big_account = request(
        Op::Parse,
        example.clone(),
        Vec::new(),
        "",
        &"1".repeat(ACCOUNT_ID_MAX + 1),
    );
    assert_eq!(host_code(&execute(&big_account)), code::REQUEST_INVALID);
    let describe_with_file = request(Op::Describe, example.clone(), b"x".to_vec(), "", "1");
    assert_eq!(
        host_code(&execute(&describe_with_file)),
        code::REQUEST_INVALID
    );
    // Exactly at the limits is accepted.
    let at_limits = request(
        Op::Parse,
        example,
        Vec::new(),
        &" ".repeat(CONFIG_MAX),
        "1234567890123456",
    );
    assert_ne!(header(&execute(&at_limits))["status"], "host_error");
}
