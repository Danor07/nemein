//! Properties of the SDK against independent oracles (serde_json, sha2, std
//! integer formatting). Seeds are fixed; a failure prints the reduced input.

use nemein_connector_sdk::{
    account_id, entry_id, Batch, Entry, Manifest, Period, MAX_SAFE_INTEGER,
};
use proptest::prelude::*;
use proptest::test_runner::{Config, RngSeed};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn config(cases: u32, seed: u64) -> Config {
    Config {
        cases,
        rng_seed: RngSeed::Fixed(seed),
        failure_persistence: None,
        ..Config::default()
    }
}

fn manifest(id: String, version: String) -> Manifest {
    Manifest {
        id,
        version,
        name: "n".into(),
        description: String::new(),
        extensions: vec![],
    }
}

/// Any Unicode text, with control characters, quotes and backslashes made likely.
fn text() -> impl Strategy<Value = String> {
    prop_oneof![
        any::<String>(),
        "[\\x00-\\x1f\"\\\\/a\u{7f}\u{2028}\u{feff}é𝄞 ]{0,24}",
    ]
}

fn entry() -> impl Strategy<Value = Entry> {
    (
        "[a-f0-9]{64}",
        text(),
        text(),
        any::<i64>(),
        proptest::option::of(any::<u64>()),
    )
        .prop_map(|(id, date, payee, amount, category_id)| Entry {
            id,
            date,
            payee,
            amount,
            category_id,
        })
}

proptest! {
    #![proptest_config(config(512, 0x6e65_6d65_696e_0001))]

    #[test]
    fn batch_json_round_trips_and_escapes_like_javascript(
        source in text(),
        id in text(),
        version in text(),
        period in proptest::option::of((text(), text())),
        account in any::<u64>(),
        entries in proptest::collection::vec(entry(), 0..8),
    ) {
        let mut batch = Batch::new(
            &manifest(id.clone(), version.clone()),
            source.clone(),
            period.clone().map(|(from, to)| Period { from, to }),
            account,
        );
        batch.entries = entries.clone();
        let json = batch.to_json();
        let value: Value = serde_json::from_str(&json).expect("valid JSON");
        prop_assert_eq!(value.as_object().unwrap().len(), 7);
        prop_assert_eq!(&value["version"], 1);
        prop_assert_eq!(&value["provenance"]["source"], source.as_str());
        prop_assert_eq!(&value["provenance"]["connector"], id.as_str());
        prop_assert_eq!(&value["provenance"]["version"], version.as_str());
        prop_assert_eq!(&value["currency"], "PYG");
        prop_assert_eq!(&value["amount_unit"], "integer");
        prop_assert_eq!(&value["account_id"], account);
        match &period {
            None => prop_assert!(value["period"].is_null()),
            Some((from, to)) => {
                prop_assert_eq!(&value["period"]["from"], from.as_str());
                prop_assert_eq!(&value["period"]["to"], to.as_str());
            }
        }
        let parsed = value["entries"].as_array().unwrap();
        prop_assert_eq!(parsed.len(), entries.len());
        for (json_entry, entry) in parsed.iter().zip(&entries) {
            prop_assert_eq!(json_entry.as_object().unwrap().len(), 5);
            prop_assert_eq!(&json_entry["id"], entry.id.as_str());
            prop_assert_eq!(&json_entry["date"], entry.date.as_str());
            prop_assert_eq!(&json_entry["payee"], entry.payee.as_str());
            prop_assert_eq!(&json_entry["amount"], entry.amount);
            match entry.category_id {
                None => prop_assert!(json_entry["category_id"].is_null()),
                Some(category) => prop_assert_eq!(&json_entry["category_id"], category),
            }
            // Same escaping as serde_json, which matches JSON.stringify.
            let escaped = format!(r#""payee":{},"#, serde_json::to_string(&entry.payee).unwrap());
            prop_assert!(json.contains(&escaped));
        }
        // Compact: as short as serde_json's own output (keys only reordered).
        prop_assert_eq!(json.len(), serde_json::to_string(&value).unwrap().len());
        prop_assert!(!json.contains('\n'));
    }

    #[test]
    fn entry_id_is_sha256_of_json_stringify(parts in proptest::collection::vec(text(), 0..6)) {
        let refs: Vec<&str> = parts.iter().map(String::as_str).collect();
        let expected: String = Sha256::digest(serde_json::to_string(&parts).unwrap().as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let id = entry_id(&refs);
        prop_assert_eq!(&id, &expected);
        prop_assert!(id.len() == 64 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    }

    #[test]
    fn entry_id_separates_parts(a in text(), b in text()) {
        // Joining or splitting parts never collides with the original split.
        let joined = format!("{a}{b}");
        prop_assume!(!a.is_empty() || !b.is_empty());
        prop_assert_ne!(entry_id(&[&a, &b]), entry_id(&[&joined]));
        prop_assert_ne!(entry_id(&[&a, &b]), entry_id(&[&a, &b, ""]));
    }

    #[test]
    fn account_id_round_trips_every_safe_integer(n in 1..=MAX_SAFE_INTEGER) {
        prop_assert_eq!(account_id(&n.to_string()).unwrap(), n);
    }

    #[test]
    fn account_id_rejects_unsafe_and_non_canonical_values(
        n in (MAX_SAFE_INTEGER + 1)..=u64::MAX,
        k in 1..=MAX_SAFE_INTEGER,
        zeros in 1usize..4,
        affix in "[ +\\-.,e_]",
    ) {
        let candidates = [
            n.to_string(),
            format!("{}{k}", "0".repeat(zeros)),
            format!("{affix}{k}"),
            format!("{k}{affix}"),
        ];
        for candidate in candidates {
            prop_assert!(account_id(&candidate).is_err(), "{:?}", candidate);
        }
    }

    #[test]
    fn account_id_matches_a_formatting_oracle(text in "[0-9+\\- ]{0,20}|\\PC{0,20}") {
        let oracle = text
            .parse::<u64>()
            .ok()
            .filter(|value| value.to_string() == text && (1..=MAX_SAFE_INTEGER).contains(value));
        prop_assert_eq!(account_id(&text).ok(), oracle);
    }
}
