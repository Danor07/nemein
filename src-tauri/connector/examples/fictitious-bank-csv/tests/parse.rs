//! Regression and boundary tests for the fictitious bank format. Fictitious data.

use nemein_connector_sdk::{entry_id, Context, Error};
use nemein_example_bank_csv::*;
use serde_json::Value;

fn ctx(config: &str, account: &str) -> Context {
    Context {
        config: config.to_owned(),
        account_id: account.to_owned(),
    }
}

const HEAD: &str =
    "BANCO FICTICIO;EXTRACTO\nCuenta;FIC-0001\nFecha;Referencia;Descripción;Débito;Crédito\n";

fn run(text: &str) -> Result<Value, Error> {
    parse(text.as_bytes(), &ctx("", "1")).map(|json| serde_json::from_str(&json).unwrap())
}

fn code(text: &str) -> String {
    let failure = run(text).expect_err("the file must be rejected");
    assert!(!failure.message.is_empty());
    assert!(failure.message.chars().count() <= 1024);
    failure.code
}

fn rows(lines: &[&str]) -> String {
    format!("{HEAD}{}\n", lines.join("\n"))
}

#[test]
fn golden_fixture_and_manifest() {
    let input = include_bytes!("../fixtures/extracto.csv");
    let json = parse(input, &ctx("", "1")).unwrap();
    assert_eq!(
        format!("{json}\n"),
        include_str!("../fixtures/extracto.batch.json")
    );
    let fixture: Value = serde_json::from_str(include_str!("../fixtures/manifest.json")).unwrap();
    let m = manifest();
    assert_eq!(
        serde_json::json!({
            "id": m.id, "version": m.version, "name": m.name,
            "description": m.description, "extensions": m.extensions,
        }),
        fixture
    );
    let batch: Value = serde_json::from_str(&json).unwrap();
    assert_eq!(batch["provenance"]["connector"], fixture["id"]);
    assert_eq!(batch["provenance"]["version"], fixture["version"]);
}

#[test]
fn maps_columns_signs_and_identity() {
    let batch = run(&rows(&[
        "2026-10-01;R1;Sueldo;;5000000",
        "2026-10-02;R2;Mercado;85000;",
    ]))
    .unwrap();
    assert_eq!(batch["account_id"], 1);
    assert_eq!(batch["period"], Value::Null);
    assert_eq!(batch["provenance"]["source"], "banco-ficticio:FIC-0001");
    let entries = batch["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["amount"], 5_000_000);
    assert_eq!(entries[1]["amount"], -85_000);
    assert_eq!(entries[1]["payee"], "Mercado");
    assert_eq!(entries[1]["date"], "2026-10-02");
    assert_eq!(entries[1]["category_id"], Value::Null);
    assert_eq!(entries[0]["id"], entry_id(&[ID, "1", "FIC-0001", "R1"]));
}

#[test]
fn identity_ignores_position_payee_amount_and_period_but_not_account() {
    let one = run(&rows(&["2026-10-02;R2;Mercado;85000;"])).unwrap();
    let moved = run("BANCO FICTICIO;EXTRACTO\nCuenta;FIC-0001\nDesde;2026-10-01\nHasta;2026-10-31\nFecha;Referencia;Descripción;Débito;Crédito\n2026-10-01;R1;Otro;1;\n2026-10-03;R2;Cambiado;9;\n")
    .unwrap();
    assert_eq!(one["entries"][0]["id"], moved["entries"][1]["id"]);
    let other_account = parse(
        rows(&["2026-10-02;R2;Mercado;85000;"]).as_bytes(),
        &ctx("", "2"),
    )
    .unwrap();
    let other: Value = serde_json::from_str(&other_account).unwrap();
    assert_eq!(other["account_id"], 2);
    assert_ne!(other["entries"][0]["id"], one["entries"][0]["id"]);
}

#[test]
fn line_endings_bom_and_blank_lines_do_not_change_the_batch() {
    let plain = rows(&["2026-10-02;R2;Mercado;85000;"]);
    let expected = run(&plain).unwrap();
    assert_eq!(run(&plain.replace('\n', "\r\n")).unwrap(), expected);
    assert_eq!(run(&format!("\u{feff}{plain}")).unwrap(), expected);
    assert_eq!(run(&plain.replace('\n', "\n\n")).unwrap(), expected);
    assert_eq!(run(plain.trim_end()).unwrap(), expected);
    // Only one BOM, and only at the start.
    assert_eq!(code(&format!("\u{feff}\u{feff}{plain}")), FORMAT);
}

#[test]
fn quoted_fields() {
    let batch = run(&rows(&[
        r#""2026-10-02";"R2";"Farmacia; ""noche""";"85000";"""#,
        r#"2026-10-03;R3;"";1;"#,
    ]));
    assert_eq!(batch.unwrap_err().code, INVALID_TEXT);
    let batch = run(&rows(&[
        r#""2026-10-02";"R2";"Farmacia; ""noche""";"85000";"""#,
    ]))
    .unwrap();
    assert_eq!(batch["entries"][0]["payee"], "Farmacia; \"noche\"");
    assert_eq!(batch["entries"][0]["amount"], -85000);
    for bad in [
        r#"2026-10-02;R2;"sin cerrar;85000;"#,
        r#"2026-10-02;R2;"cerrado"x;85000;"#,
        r#"2026-10-02;R2;co"millas;85000;"#,
        "2026-10-02;R2;Mercado;85000;;",
        "2026-10-02;R2;Mercado;85000",
        "2026-10-02;R2;Mercado",
        "2026-10-02",
    ] {
        assert_eq!(code(&rows(&[bad])), FORMAT, "{bad}");
    }
}

#[test]
fn header_and_metadata() {
    for bad in [
        "",
        "\n\n",
        "BANCO FICTICIO\n",
        "BANCO FICTICIO;EXTRACTO;X\n",
        "banco ficticio;extracto\nCuenta;A\nFecha;Referencia;Descripción;Débito;Crédito\n",
        "BANCO FICTICIO;EXTRACTO\n",
        "BANCO FICTICIO;EXTRACTO\nCuenta;A\n",
        "BANCO FICTICIO;EXTRACTO\nFecha;Referencia;Descripción;Débito;Crédito\n",
        "BANCO FICTICIO;EXTRACTO\nCuenta;A\nCuenta;A\nFecha;Referencia;Descripción;Débito;Crédito\n",
        "BANCO FICTICIO;EXTRACTO\nCuenta;A\nSaldo;1\nFecha;Referencia;Descripción;Débito;Crédito\n",
        "BANCO FICTICIO;EXTRACTO\nCuenta;A;B\nFecha;Referencia;Descripción;Débito;Crédito\n",
        "BANCO FICTICIO;EXTRACTO\nCuenta;A\nDesde;2026-10-01\nFecha;Referencia;Descripción;Débito;Crédito\n",
        "BANCO FICTICIO;EXTRACTO\nCuenta;A\nHasta;2026-10-01\nFecha;Referencia;Descripción;Débito;Crédito\n",
        "BANCO FICTICIO;EXTRACTO\nCuenta;A\nDesde;2026-10-01\nDesde;2026-10-01\nHasta;2026-10-02\nFecha;Referencia;Descripción;Débito;Crédito\n",
        "BANCO FICTICIO;EXTRACTO\nCuenta;A\nHasta;2026-10-01\nHasta;2026-10-01\nDesde;2026-10-01\nFecha;Referencia;Descripción;Débito;Crédito\n",
        "BANCO FICTICIO;EXTRACTO\nCuenta;A\nFecha;Referencia;Descripcion;Débito;Crédito\n",
    ] {
        assert_eq!(code(bad), FORMAT, "{bad:?}");
    }
    assert_eq!(
        code("BANCO FICTICIO;EXTRACTO\nCuenta; \nFecha;Referencia;Descripción;Débito;Crédito\n"),
        INVALID_TEXT
    );
    assert_eq!(
        code("BANCO FICTICIO;EXTRACTO\nCuenta;A\nDesde;2026-13-01\nHasta;2026-10-01\nFecha;Referencia;Descripción;Débito;Crédito\n"),
        INVALID_DATE
    );
    // Metadata in any order; a header-only file is an empty statement.
    let empty = run("BANCO FICTICIO;EXTRACTO\nHasta;2026-10-31\nDesde;2026-10-01\nCuenta;A\nFecha;Referencia;Descripción;Débito;Crédito\n").unwrap();
    assert_eq!(empty["entries"], serde_json::json!([]));
    assert_eq!(
        empty["period"],
        serde_json::json!({"from": "2026-10-01", "to": "2026-10-31"})
    );
}

#[test]
fn period_boundaries_are_inclusive() {
    let head = |from: &str, to: &str| {
        format!("BANCO FICTICIO;EXTRACTO\nCuenta;A\nDesde;{from}\nHasta;{to}\nFecha;Referencia;Descripción;Débito;Crédito\n")
    };
    let ok = run(&format!(
        "{}2026-10-01;A;x;1;\n2026-10-31;B;y;;1\n",
        head("2026-10-01", "2026-10-31")
    ))
    .unwrap();
    assert_eq!(ok["entries"].as_array().unwrap().len(), 2);
    assert!(run(&head("2026-10-01", "2026-10-01")).is_ok());
    assert_eq!(code(&head("2026-10-02", "2026-10-01")), INVALID_PERIOD);
    assert_eq!(
        code(&format!(
            "{}2026-09-30;A;x;1;\n",
            head("2026-10-01", "2026-10-31")
        )),
        OUTSIDE_PERIOD
    );
    assert_eq!(
        code(&format!(
            "{}2026-11-01;A;x;1;\n",
            head("2026-10-01", "2026-10-31")
        )),
        OUTSIDE_PERIOD
    );
}

#[test]
fn dates() {
    for ok in [
        "2024-02-29",
        "2000-02-29",
        "2026-01-31",
        "2026-04-30",
        "2026-12-31",
        "0001-01-01",
        "9999-12-31",
    ] {
        assert!(run(&rows(&[&format!("{ok};R;x;1;")])).is_ok(), "{ok}");
    }
    for bad in [
        "2023-02-29",
        "1900-02-29",
        "2026-02-30",
        "2026-04-31",
        "2026-06-31",
        "2026-09-31",
        "2026-11-31",
        "2026-01-32",
        "2026-00-10",
        "2026-13-10",
        "2026-10-00",
        "2026-1-01",
        "2026/10/01",
        "26-10-01",
        "2026-10-01 ",
        " 2026-10-01",
        "2026-10-0a",
        "202a-10-01",
        "2026-1a-01",
        "2026-10-011",
        "01/10/2026",
        "",
    ] {
        assert_eq!(
            code(&rows(&[&format!("{bad};R;x;1;")])),
            INVALID_DATE,
            "{bad:?}"
        );
    }
}

#[test]
fn amounts() {
    let amount = |debit: &str, credit: &str| {
        run(&rows(&[&format!("2026-10-01;R;x;{debit};{credit}")]))
            .map(|b| b["entries"][0]["amount"].as_i64().unwrap())
    };
    assert_eq!(amount("1", "").unwrap(), -1);
    assert_eq!(amount("", "1").unwrap(), 1);
    assert_eq!(amount("1000000000000", "").unwrap(), -MAX_AMOUNT);
    assert_eq!(amount("", "1000000000000").unwrap(), MAX_AMOUNT);
    assert_eq!(
        amount("9999999999999", "").unwrap_err().code,
        INVALID_AMOUNT
    );
    for (debit, credit) in [
        ("", ""),
        ("1", "1"),
        ("0", ""),
        ("", "0"),
        ("01", ""),
        ("", "1000000000001"),
        ("10000000000000", ""),
        ("-1", ""),
        ("+1", ""),
        ("1.000", ""),
        ("1,5", ""),
        ("1 ", ""),
        (" 1", ""),
        ("1e3", ""),
        ("99999999999999999999", ""),
        ("", "١"),
    ] {
        assert_eq!(
            amount(debit, credit).unwrap_err().code,
            INVALID_AMOUNT,
            "{debit:?} {credit:?}"
        );
    }
}

#[test]
fn texts() {
    let long = "é".repeat(MAX_PAYEE);
    assert_eq!(
        run(&rows(&[&format!("2026-10-01;R;{long};1;")])).unwrap()["entries"][0]["payee"],
        long.as_str()
    );
    let reference = "r".repeat(MAX_REFERENCE);
    assert!(run(&rows(&[&format!("2026-10-01;{reference};x;1;")])).is_ok());
    for (reference, payee) in [
        ("R", &*format!("{long}é")),
        (&*format!("{reference}r"), "x"),
        ("R", ""),
        ("R", "   "),
        ("R", "\u{feff}"),
        ("R", "\u{a0}\u{2028}"),
        ("", "x"),
        (" ", "x"),
        ("R", "a\u{7}b"),
        ("R", "a\u{85}b"),
        ("R\u{1}", "x"),
    ] {
        assert_eq!(
            code(&rows(&[&format!("2026-10-01;{reference};{payee};1;")])),
            INVALID_TEXT,
            "{reference:?} {payee:?}"
        );
    }
    // Spaces are kept as written: the bank's text is not rewritten.
    let spaced = run(&rows(&["2026-10-01;R; Mercado ;1;"])).unwrap();
    assert_eq!(spaced["entries"][0]["payee"], " Mercado ");
}

#[test]
fn duplicate_reference_rejects_the_file() {
    assert_eq!(
        code(&rows(&[
            "2026-10-01;R1;x;1;",
            "2026-10-02;R2;y;2;",
            "2026-10-03;R1;z;;3"
        ])),
        DUPLICATE_REFERENCE
    );
    let failure = run(&rows(&["2026-10-01;R1;x;1;", "2026-10-03;R1;z;;3"])).unwrap_err();
    assert!(
        failure.message.starts_with("Línea 5:"),
        "{}",
        failure.message
    );
}

#[test]
fn line_numbers_are_physical() {
    let failure = run(&format!("{HEAD}\n\n2026-10-01;R;x;1;1\n")).unwrap_err();
    assert_eq!(failure.code, INVALID_AMOUNT);
    assert!(
        failure.message.starts_with("Línea 6:"),
        "{}",
        failure.message
    );
}

#[test]
fn entry_limit_is_exact() {
    let mut text = String::from(HEAD);
    for n in 0..MAX_ENTRIES {
        text.push_str(&format!("2026-10-01;R{n};x;1;\n"));
    }
    let batch = run(&text).unwrap();
    assert_eq!(batch["entries"].as_array().unwrap().len(), MAX_ENTRIES);
    text.push_str("2026-10-01;extra;x;1;\n");
    assert_eq!(code(&text), LIMIT);
}

#[test]
fn encoding() {
    let mut bytes = rows(&["2026-10-01;R;x;1;"]).into_bytes();
    bytes.push(0xff);
    let failure = parse(&bytes, &ctx("", "1")).unwrap_err();
    assert_eq!(failure.code, ENCODING);
    let latin1 = b"BANCO FICTICIO;EXTRACTO\nCuenta;A\nFecha;Referencia;Descripci\xf3n;D\xe9bito;Cr\xe9dito\n";
    assert_eq!(parse(latin1, &ctx("", "1")).unwrap_err().code, ENCODING);
}

#[test]
fn context_is_checked_before_the_file() {
    for account in ["", "0", "01", "-1", "1.0", "9007199254740992", " 1"] {
        let failure = parse(b"not a statement", &ctx("", account)).unwrap_err();
        assert_eq!(failure.code, "CONNECTOR_INVALID_CONTEXT", "{account:?}");
    }
    assert!(parse(rows(&[]).as_bytes(), &ctx("", "9007199254740991")).is_ok());
}

#[test]
fn configuration() {
    let file = rows(&["2026-10-01;R;x;1;"]);
    for config in [
        "",
        "\n",
        "  ",
        "cuenta=FIC-0001",
        " cuenta = FIC-0001 \n",
        "\ncuenta=FIC-0001\n\n",
    ] {
        assert!(
            parse(file.as_bytes(), &ctx(config, "1")).is_ok(),
            "{config:?}"
        );
    }
    assert_eq!(
        parse(file.as_bytes(), &ctx("cuenta=FIC-0002", "1"))
            .unwrap_err()
            .code,
        ACCOUNT_MISMATCH
    );
    for config in [
        "cuenta=",
        "cuenta= ",
        "cuenta=A\ncuenta=A",
        "otra=1",
        "Cuenta=FIC-0001",
        "{}",
        "cuenta",
    ] {
        // Configuration is checked before the file is read.
        assert_eq!(
            parse(b"\xff", &ctx(config, "1")).unwrap_err().code,
            INVALID_CONFIG,
            "{config:?}"
        );
    }
}

#[test]
fn too_many_fields_fail_before_reading_the_rest() {
    let line = ";".repeat(1_000_000);
    assert_eq!(code(&rows(&[&line])), FORMAT);
}

#[test]
fn describe_matches_the_wit_limits() {
    let m = manifest();
    let id_ok = m.id.len() <= 160
        && m.id.split(['.', '-']).all(|w| {
            !w.is_empty()
                && w.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        });
    assert!(id_ok);
    assert!((1..=80).contains(&m.version.chars().count()));
    assert!((1..=80).contains(&m.name.chars().count()));
    assert!(m.description.chars().count() <= 500);
    assert!(m.extensions.len() <= 8);
    assert!(m.extensions.iter().all(|e| (1..=16).contains(&e.len())
        && e.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())));
    assert_eq!(<Connector as nemein_connector_sdk::Guest>::describe(), m);
}
