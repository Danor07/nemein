//! Properties and adversarial fuzzing of the fictitious bank connector.
//! Seeds are fixed; a failure prints the reduced input. Fictitious data only.

use nemein_connector_sdk::{entry_id, Context};
use nemein_example_bank_csv::*;
use proptest::prelude::*;
use proptest::test_runner::{Config, RngSeed};
use serde_json::Value;
use std::collections::HashSet;

fn config(cases: u32, seed: u64) -> Config {
    Config {
        cases,
        rng_seed: RngSeed::Fixed(seed),
        failure_persistence: None,
        ..Config::default()
    }
}

const CODES: [&str; 12] = [
    "CONNECTOR_INVALID_CONTEXT",
    FORMAT,
    ENCODING,
    INVALID_CONFIG,
    ACCOUNT_MISMATCH,
    INVALID_DATE,
    INVALID_PERIOD,
    OUTSIDE_PERIOD,
    INVALID_TEXT,
    INVALID_AMOUNT,
    DUPLICATE_REFERENCE,
    LIMIT,
];

#[derive(Clone, Debug)]
struct Row {
    date: String,
    reference: String,
    payee: String,
    amount: i64,
}

#[derive(Clone, Debug)]
struct Style {
    crlf: bool,
    bom: bool,
    quote_all: bool,
    blank_lines: bool,
}

/// An independent calendar: day count from the month's position in the year.
fn days_in_month(year: u32, month: u32) -> u32 {
    let leap = (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400);
    match month {
        2 => 28 + u32::from(leap),
        m => 30 + ((m + m / 8) % 2),
    }
}

fn date() -> impl Strategy<Value = String> {
    (1900u32..=2200, 1u32..=12, 1u32..=31)
        .prop_map(|(y, m, d)| format!("{y:04}-{m:02}-{:02}", d.min(days_in_month(y, m))))
}

fn payee() -> impl Strategy<Value = String> {
    // Starts with content; may hold the separator, quotes and non-ASCII text.
    "[A-Za-zÁÉñÑ€𝄞0-9][A-Za-z0-9 ;\"'áéíóúñÑ€𝄞/\\\\.,-]{0,60}"
}

fn amount() -> impl Strategy<Value = i64> {
    prop_oneof![
        1i64..=MAX_AMOUNT,
        -MAX_AMOUNT..=-1i64,
        Just(MAX_AMOUNT),
        Just(-MAX_AMOUNT),
        Just(1),
        Just(-1),
    ]
}

fn rows() -> impl Strategy<Value = Vec<Row>> {
    rows_up_to(40)
}

fn rows_up_to(max: usize) -> impl Strategy<Value = Vec<Row>> {
    proptest::collection::vec((date(), "[A-Z0-9]{1,8}", payee(), amount()), 0..max).prop_map(
        |rows| {
            rows.into_iter()
                .enumerate()
                .map(|(index, (date, reference, payee, amount))| Row {
                    date,
                    // Unique by construction; the suffix keeps them varied.
                    reference: format!("{index}-{reference}"),
                    payee,
                    amount,
                })
                .collect()
        },
    )
}

fn style() -> impl Strategy<Value = Style> {
    (any::<bool>(), any::<bool>(), any::<bool>(), any::<bool>()).prop_map(
        |(crlf, bom, quote_all, blank_lines)| Style {
            crlf,
            bom,
            quote_all,
            blank_lines,
        },
    )
}

fn field(value: &str, quote_all: bool) -> String {
    if quote_all || value.contains([';', '"']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_owned()
    }
}

fn render(account: &str, period: Option<(&str, &str)>, rows: &[Row], style: &Style) -> Vec<u8> {
    let q = |value: &str| field(value, style.quote_all);
    let mut lines = vec![
        format!("{};{}", q("BANCO FICTICIO"), q("EXTRACTO")),
        format!("{};{}", q("Cuenta"), q(account)),
    ];
    if let Some((from, to)) = period {
        lines.push(format!("{};{}", q("Desde"), q(from)));
        lines.push(format!("{};{}", q("Hasta"), q(to)));
    }
    lines.push(
        ["Fecha", "Referencia", "Descripción", "Débito", "Crédito"]
            .map(q)
            .join(";"),
    );
    for row in rows {
        let magnitude = row.amount.unsigned_abs().to_string();
        let (debit, credit) = if row.amount < 0 {
            (magnitude.as_str(), "")
        } else {
            ("", magnitude.as_str())
        };
        // An empty column stays empty even when quoting everything else.
        let money = |v: &str| if v.is_empty() { String::new() } else { q(v) };
        lines.push(format!(
            "{};{};{};{};{}",
            q(&row.date),
            q(&row.reference),
            q(&row.payee),
            money(debit),
            money(credit)
        ));
    }
    let newline = if style.crlf { "\r\n" } else { "\n" };
    let separator = if style.blank_lines {
        format!("{newline}{newline}")
    } else {
        newline.to_owned()
    };
    let mut text = lines.join(&separator);
    text.push_str(newline);
    let mut bytes = Vec::new();
    if style.bom {
        bytes.extend_from_slice("\u{feff}".as_bytes());
    }
    bytes.extend_from_slice(text.as_bytes());
    bytes
}

fn ctx(account: u64) -> Context {
    Context {
        config: String::new(),
        account_id: account.to_string(),
    }
}

/// Invariants of every outcome, valid or not.
fn check_outcome(
    result: &Result<String, nemein_connector_sdk::Error>,
    account: u64,
) -> Result<(), TestCaseError> {
    match result {
        Err(failure) => {
            prop_assert!(
                CODES.contains(&failure.code.as_str()),
                "unknown code {}",
                failure.code
            );
            prop_assert!((1..=1024).contains(&failure.message.chars().count()));
        }
        Ok(json) => {
            let batch: Value = serde_json::from_str(json).expect("valid JSON");
            prop_assert_eq!(&batch["account_id"], account);
            prop_assert_eq!(&batch["provenance"]["connector"], ID);
            let entries = batch["entries"].as_array().unwrap();
            prop_assert!(entries.len() <= MAX_ENTRIES);
            let mut ids = HashSet::new();
            for entry in entries {
                let id = entry["id"].as_str().unwrap();
                prop_assert!(id.len() == 64 && ids.insert(id.to_owned()));
                let amount = entry["amount"].as_i64().unwrap();
                prop_assert!(amount != 0 && amount.abs() <= MAX_AMOUNT);
                let payee = entry["payee"].as_str().unwrap();
                prop_assert!(
                    payee.chars().count() <= MAX_PAYEE && !payee.chars().any(char::is_control)
                );
                prop_assert!(entry["category_id"].is_null());
            }
        }
    }
    Ok(())
}

proptest! {
    #![proptest_config(config(400, 0x6e65_6d65_696e_0101))]

    /// Model round trip: every row becomes exactly its entry, in order.
    #[test]
    fn rendered_statements_round_trip(
        account in 1u64..=9_007_199_254_740_991,
        source in "[A-Z]{3}-[0-9]{1,6}",
        rows in rows(),
        with_period in any::<bool>(),
        style in style(),
    ) {
        let period = with_period.then(|| ("1900-01-01".to_owned(), "2200-12-31".to_owned()));
        let bytes = render(&source, period.as_ref().map(|(f, t)| (f.as_str(), t.as_str())), &rows, &style);
        let json = parse(&bytes, &ctx(account)).expect("a well-formed statement");
        let batch: Value = serde_json::from_str(&json).unwrap();
        prop_assert_eq!(&batch["account_id"], account);
        let expected_source = format!("banco-ficticio:{source}");
        prop_assert_eq!(&batch["provenance"]["source"], expected_source.as_str());
        prop_assert_eq!(batch["period"].is_null(), !with_period);
        let entries = batch["entries"].as_array().unwrap();
        prop_assert_eq!(entries.len(), rows.len());
        let account_text = account.to_string();
        for (entry, row) in entries.iter().zip(&rows) {
            prop_assert_eq!(&entry["date"], row.date.as_str());
            prop_assert_eq!(&entry["payee"], row.payee.as_str());
            prop_assert_eq!(&entry["amount"], row.amount);
            let id = entry_id(&[ID, &account_text, &source, &row.reference]);
            prop_assert_eq!(&entry["id"], id.as_str());
        }
    }

    /// Line endings, BOM, blank lines and optional quoting never change the batch.
    #[test]
    fn presentation_does_not_change_the_batch(rows in rows(), a in style(), b in style()) {
        let one = parse(&render("FIC-1", None, &rows, &a), &ctx(1)).unwrap();
        let two = parse(&render("FIC-1", None, &rows, &b), &ctx(1)).unwrap();
        prop_assert_eq!(one, two);
    }

    /// Identity depends on account and reference only, never on position,
    /// description, amount or period.
    #[test]
    fn identity_survives_reordering_and_edits(rows in rows(), shift in any::<usize>(), payee in payee()) {
        prop_assume!(!rows.is_empty());
        let style = Style { crlf: false, bom: false, quote_all: false, blank_lines: false };
        let ids = |rows: &[Row], period: Option<(&str, &str)>| -> Vec<(String, String)> {
            let batch: Value = serde_json::from_str(&parse(&render("FIC-1", period, rows, &style), &ctx(3)).unwrap()).unwrap();
            let mut pairs: Vec<(String, String)> = batch["entries"].as_array().unwrap().iter().zip(rows)
                .map(|(entry, row)| (row.reference.clone(), entry["id"].as_str().unwrap().to_owned()))
                .collect();
            pairs.sort();
            pairs
        };
        let mut edited = rows.clone();
        edited.rotate_left(shift % rows.len());
        for row in &mut edited {
            row.payee = payee.clone();
            row.amount = if row.amount == 1 { 2 } else { 1 };
        }
        prop_assert_eq!(ids(&rows, None), ids(&edited, Some(("1900-01-01", "2200-12-31"))));
    }

    /// The calendar check agrees with an independent day count.
    #[test]
    fn dates_follow_the_calendar(y in 0u32..=9999, m in 0u32..=13, d in 0u32..=32) {
        let date = format!("{y:04}-{m:02}-{d:02}");
        let file = format!("BANCO FICTICIO;EXTRACTO\nCuenta;A\nFecha;Referencia;Descripción;Débito;Crédito\n{date};R;x;1;\n");
        let valid = (1..=12).contains(&m) && d >= 1 && d <= days_in_month(y, m);
        let result = parse(file.as_bytes(), &ctx(1));
        prop_assert_eq!(result.is_ok(), valid, "{}", date);
        if !valid {
            prop_assert_eq!(result.unwrap_err().code, INVALID_DATE);
        }
    }
}

proptest! {
    #![proptest_config(config(1500, 0x6e65_6d65_696e_0102))]

    /// Arbitrary bytes: never panics, only known codes, bounded messages.
    #[test]
    fn arbitrary_bytes_fail_closed(bytes in proptest::collection::vec(any::<u8>(), 0..512), config in "\\PC{0,24}") {
        let context = Context { config, account_id: "5".into() };
        let result = parse(&bytes, &context);
        check_outcome(&result, 5)?;
    }

    /// Valid files with random byte edits: the parser either rejects the whole
    /// file or returns a batch that still satisfies every invariant.
    #[test]
    fn mutated_statements_fail_closed(
        rows in rows_up_to(6),
        style in style(),
        edits in proptest::collection::vec((any::<usize>(), 0u8..3, prop_oneof![
            any::<u8>(),
            Just(b';'), Just(b'"'), Just(b'\n'), Just(b'\r'), Just(b'-'), Just(b'0'), Just(0xff),
        ]), 1..6),
    ) {
        let mut bytes = render("FIC-9", Some(("1900-01-01", "2200-12-31")), &rows, &style);
        for (position, kind, byte) in edits {
            let at = position % (bytes.len() + 1);
            match kind {
                0 => bytes.insert(at, byte),
                1 if at < bytes.len() => { bytes.remove(at); }
                _ if at < bytes.len() => bytes[at] = byte,
                _ => bytes.push(byte),
            }
        }
        check_outcome(&parse(&bytes, &ctx(9)), 9)?;
    }
}
