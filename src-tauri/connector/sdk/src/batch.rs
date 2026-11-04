//! Import batch v1 as compact JSON (`src/contracts/import-batch.v1.schema.json`).
//!
//! These types fix the shape and the constants of the contract. They do not
//! repeat its semantic checks: dates, limits and identities are validated by the
//! host, which rejects the whole batch on any violation.

use crate::json::push_string;
use crate::Manifest;
use std::fmt::Write;

/// Inclusive coverage the source declares, as `YYYY-MM-DD` dates.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Period {
    pub from: String,
    pub to: String,
}

/// One movement. `amount` is in whole units of the batch currency: negative for
/// spending, positive for income, never zero.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    /// [`crate::entry_id`] of the source's stable reference.
    pub id: String,
    pub date: String,
    pub payee: String,
    pub amount: i64,
    /// A local category id, or `None` to let the host resolve it for review.
    pub category_id: Option<u64>,
}

/// A batch whose provenance repeats the manifest, so the host's comparison of
/// both can only fail if the connector lies.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Batch {
    /// Logical source, for example the bank account the file describes.
    pub source: String,
    pub period: Option<Period>,
    /// The value read with [`crate::account_id`] from the context.
    pub account_id: u64,
    pub entries: Vec<Entry>,
    connector: String,
    version: String,
}

/// Contract v1 only accepts these two constants; another value needs a new
/// contract version, not a connector option.
const CURRENCY: &str = "PYG";
const AMOUNT_UNIT: &str = "integer";

impl Batch {
    pub fn new(
        manifest: &Manifest,
        source: impl Into<String>,
        period: Option<Period>,
        account_id: u64,
    ) -> Self {
        Batch {
            source: source.into(),
            period,
            account_id,
            entries: Vec::new(),
            connector: manifest.id.clone(),
            version: manifest.version.clone(),
        }
    }

    /// The batch as compact JSON text, the value `parse` returns.
    pub fn to_json(&self) -> String {
        let mut out = String::with_capacity(256 + self.entries.len() * 160);
        out.push_str(r#"{"version":1,"provenance":{"source":"#);
        push_string(&mut out, &self.source);
        out.push_str(r#","connector":"#);
        push_string(&mut out, &self.connector);
        out.push_str(r#","version":"#);
        push_string(&mut out, &self.version);
        out.push_str(r#"},"period":"#);
        match &self.period {
            None => out.push_str("null"),
            Some(period) => {
                out.push_str(r#"{"from":"#);
                push_string(&mut out, &period.from);
                out.push_str(r#","to":"#);
                push_string(&mut out, &period.to);
                out.push('}');
            }
        }
        out.push_str(r#","currency":"#);
        push_string(&mut out, CURRENCY);
        out.push_str(r#","amount_unit":"#);
        push_string(&mut out, AMOUNT_UNIT);
        // Writing to a String cannot fail.
        let _ = write!(out, r#","account_id":{},"entries":["#, self.account_id);
        for (index, entry) in self.entries.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            out.push_str(r#"{"id":"#);
            push_string(&mut out, &entry.id);
            out.push_str(r#","date":"#);
            push_string(&mut out, &entry.date);
            out.push_str(r#","payee":"#);
            push_string(&mut out, &entry.payee);
            let _ = write!(out, r#","amount":{},"category_id":"#, entry.amount);
            match entry.category_id {
                None => out.push_str("null"),
                Some(id) => {
                    let _ = write!(out, "{id}");
                }
            }
            out.push('}');
        }
        out.push_str("]}");
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> Manifest {
        Manifest {
            id: "fixture.connector".into(),
            version: "2.0.0".into(),
            name: "Fixture".into(),
            description: String::new(),
            extensions: vec![],
        }
    }

    #[test]
    fn empty_batch_without_period() {
        let batch = Batch::new(&manifest(), "fixture:a", None, 7);
        assert_eq!(
            batch.to_json(),
            r#"{"version":1,"provenance":{"source":"fixture:a","connector":"fixture.connector","version":"2.0.0"},"period":null,"currency":"PYG","amount_unit":"integer","account_id":7,"entries":[]}"#
        );
    }

    #[test]
    fn entries_period_and_categories() {
        let mut batch = Batch::new(
            &manifest(),
            "s\"q",
            Some(Period {
                from: "2026-10-01".into(),
                to: "2026-10-31".into(),
            }),
            9_007_199_254_740_991,
        );
        batch.entries.push(Entry {
            id: "a".repeat(64),
            date: "2026-10-02".into(),
            payee: "Café; \"x\"".into(),
            amount: -1_000_000_000_000,
            category_id: Some(3),
        });
        batch.entries.push(Entry {
            id: "b".repeat(64),
            date: "2026-10-03".into(),
            payee: "Ingreso".into(),
            amount: 5,
            category_id: None,
        });
        let expected = format!(
            concat!(
                r#"{{"version":1,"provenance":{{"source":"s\"q","connector":"fixture.connector","version":"2.0.0"}},"#,
                r#""period":{{"from":"2026-10-01","to":"2026-10-31"}},"currency":"PYG","amount_unit":"integer","#,
                r#""account_id":9007199254740991,"entries":["#,
                r#"{{"id":"{}","date":"2026-10-02","payee":"Café; \"x\"","amount":-1000000000000,"category_id":3}},"#,
                r#"{{"id":"{}","date":"2026-10-03","payee":"Ingreso","amount":5,"category_id":null}}]}}"#
            ),
            "a".repeat(64),
            "b".repeat(64)
        );
        assert_eq!(batch.to_json(), expected);
    }
}
