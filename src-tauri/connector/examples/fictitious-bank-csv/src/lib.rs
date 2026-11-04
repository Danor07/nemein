//! Example connector for the CSV statement of an invented bank, "Banco Ficticio".
//!
//! The bank, its format and every sample are fictitious. The crate is the
//! template for real bank connectors: it maps the bank's columns to an import
//! batch v1 and rejects the whole file on the first problem. Format and
//! configuration: `README.md` next to this file.

use nemein_connector_sdk::{
    account_id, entry_id, error, Batch, Context, Entry, Error, Guest, Manifest, Period,
};
use std::collections::HashSet;

/// Stable identifier; also the namespace of every movement identity, so it must
/// never change between versions of this connector.
pub const ID: &str = "nemein.example.fictitious-bank-csv";

pub const FORMAT: &str = "CONNECTOR_FORMAT";
pub const ENCODING: &str = "CONNECTOR_ENCODING";
pub const INVALID_CONFIG: &str = "CONNECTOR_INVALID_CONFIG";
pub const ACCOUNT_MISMATCH: &str = "CONNECTOR_ACCOUNT_MISMATCH";
pub const INVALID_DATE: &str = "CONNECTOR_INVALID_DATE";
pub const INVALID_PERIOD: &str = "CONNECTOR_INVALID_PERIOD";
pub const OUTSIDE_PERIOD: &str = "CONNECTOR_OUTSIDE_PERIOD";
pub const INVALID_TEXT: &str = "CONNECTOR_INVALID_TEXT";
pub const INVALID_AMOUNT: &str = "CONNECTOR_INVALID_AMOUNT";
pub const DUPLICATE_REFERENCE: &str = "CONNECTOR_DUPLICATE_REFERENCE";
pub const LIMIT: &str = "CONNECTOR_LIMIT";

/// Same entry limit as contract v1; checked here so an oversized file stops
/// before its batch is built.
pub const MAX_ENTRIES: usize = 20_000;
pub const MAX_PAYEE: usize = 160;
pub const MAX_REFERENCE: usize = 64;
pub const MAX_AMOUNT: i64 = 1_000_000_000_000;
const COLUMNS: [&str; 5] = ["Fecha", "Referencia", "Descripción", "Débito", "Crédito"];
/// No line of this format has more fields; longer lines fail before allocating.
const MAX_FIELDS: usize = 5;

pub fn manifest() -> Manifest {
    Manifest {
        id: ID.to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
        name: "Banco Ficticio (ejemplo)".to_owned(),
        description: "Extracto CSV de un banco inventado. Sólo sirve para pruebas y como plantilla; no corresponde a ningún banco real.".to_owned(),
        extensions: vec!["csv".to_owned()],
    }
}

/// The whole connector: file bytes and host context in, batch JSON out.
pub fn parse(input: &[u8], ctx: &Context) -> Result<String, Error> {
    let account = account_id(&ctx.account_id)?;
    let expected_account = config(&ctx.config)?;
    let content = std::str::from_utf8(input)
        .map_err(|_| error(ENCODING, "El archivo no está en UTF-8 válido."))?;
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut lines = content
        .split('\n')
        .enumerate()
        .map(|(index, line)| (index + 1, line.strip_suffix('\r').unwrap_or(line)))
        .filter(|(_, line)| !line.is_empty());

    match lines.next() {
        Some((n, line)) if fields(n, line)? == ["BANCO FICTICIO", "EXTRACTO"] => {}
        _ => {
            return Err(error(
                FORMAT,
                "El archivo no es un extracto del Banco Ficticio.",
            ))
        }
    }

    let (mut source_account, mut from, mut to) = (None, None, None);
    loop {
        let Some((n, line)) = lines.next() else {
            return Err(error(FORMAT, "Falta la fila de columnas."));
        };
        let row = fields(n, line)?;
        if row == COLUMNS {
            break;
        }
        let (slot, value) = match row.as_slice() {
            [key, value] if key == "Cuenta" => (
                &mut source_account,
                text(n, "La cuenta", value, MAX_REFERENCE)?,
            ),
            [key, value] if key == "Desde" => (&mut from, date(n, value)?),
            [key, value] if key == "Hasta" => (&mut to, date(n, value)?),
            _ => {
                return Err(error(
                    FORMAT,
                    format!("Línea {n}: se esperaba Cuenta, Desde, Hasta o la fila de columnas."),
                ))
            }
        };
        if slot.replace(value).is_some() {
            return Err(error(
                FORMAT,
                format!("Línea {n}: dato de encabezado repetido."),
            ));
        }
    }

    let source_account =
        source_account.ok_or_else(|| error(FORMAT, "Falta la cuenta del extracto."))?;
    if expected_account.is_some_and(|expected| expected != source_account) {
        return Err(error(
            ACCOUNT_MISMATCH,
            "El extracto es de otra cuenta que la configurada.",
        ));
    }
    let period = match (from, to) {
        (None, None) => None,
        (Some(from), Some(to)) if from <= to => Some(Period { from, to }),
        (Some(_), Some(_)) => {
            return Err(error(
                INVALID_PERIOD,
                "El período del extracto está invertido.",
            ))
        }
        _ => return Err(error(FORMAT, "Desde y Hasta deben aparecer juntos.")),
    };

    let account_text = account.to_string();
    let mut batch = Batch::new(
        &manifest(),
        format!("banco-ficticio:{source_account}"),
        period,
        account,
    );
    let mut references = HashSet::new();
    for (n, line) in lines {
        if batch.entries.len() == MAX_ENTRIES {
            return Err(error(
                LIMIT,
                format!("El extracto supera {MAX_ENTRIES} movimientos."),
            ));
        }
        let Ok([day, reference, payee, debit, credit]) = <[String; 5]>::try_from(fields(n, line)?)
        else {
            return Err(error(
                FORMAT,
                format!("Línea {n}: se esperaban 5 columnas."),
            ));
        };
        let day = date(n, &day)?;
        if let Some(period) = &batch.period {
            if day < period.from || day > period.to {
                return Err(error(
                    OUTSIDE_PERIOD,
                    format!("Línea {n}: la fecha está fuera del período del extracto."),
                ));
            }
        }
        let reference = text(n, "La referencia", &reference, MAX_REFERENCE)?;
        let payee = text(n, "La descripción", &payee, MAX_PAYEE)?;
        let amount = amount(n, &debit, &credit)?;
        if !references.insert(reference.clone()) {
            return Err(error(
                DUPLICATE_REFERENCE,
                format!("Línea {n}: la referencia ya apareció en el extracto."),
            ));
        }
        batch.entries.push(Entry {
            id: entry_id(&[ID, &account_text, &source_account, &reference]),
            date: day,
            payee,
            amount,
            // Categories are the host's: it resolves and fixes them for review.
            category_id: None,
        });
    }
    Ok(batch.to_json())
}

/// Empty, or one line `cuenta=<account in the file>` to refuse other statements.
fn config(text: &str) -> Result<Option<String>, Error> {
    let mut account = None;
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        match line
            .split_once('=')
            .map(|(key, value)| (key.trim(), value.trim()))
        {
            Some(("cuenta", value)) if !value.is_empty() && account.is_none() => {
                account = Some(value.to_owned());
            }
            _ => {
                return Err(error(
                    INVALID_CONFIG,
                    "La configuración admite sólo una línea cuenta=<número de cuenta>.",
                ))
            }
        }
    }
    Ok(account)
}

/// Splits one line on `;`. A field may be quoted with `"`, doubling `""` inside.
fn fields(n: usize, line: &str) -> Result<Vec<String>, Error> {
    let format = |message: &str| error(FORMAT, format!("Línea {n}: {message}"));
    let mut out = Vec::new();
    let mut chars = line.chars().peekable();
    loop {
        if out.len() == MAX_FIELDS {
            return Err(format("tiene demasiadas columnas."));
        }
        let mut field = String::new();
        let mut ended = true;
        if chars.next_if_eq(&'"').is_some() {
            loop {
                match chars.next() {
                    None => return Err(format("tiene comillas sin cerrar.")),
                    Some('"') if chars.next_if_eq(&'"').is_none() => break,
                    Some(c) => field.push(c),
                }
            }
            match chars.next() {
                None => {}
                Some(';') => ended = false,
                Some(_) => return Err(format("tiene texto después de cerrar comillas.")),
            }
        } else {
            for c in chars.by_ref() {
                match c {
                    ';' => {
                        ended = false;
                        break;
                    }
                    '"' => return Err(format("tiene comillas dentro de un campo sin comillas.")),
                    c => field.push(c),
                }
            }
        }
        out.push(field);
        if ended {
            return Ok(out);
        }
    }
}

/// `YYYY-MM-DD` naming a real calendar day. The host checks the contract range.
fn date(n: usize, value: &str) -> Result<String, Error> {
    let invalid = || {
        error(
            INVALID_DATE,
            format!("Línea {n}: la fecha debe ser AAAA-MM-DD real."),
        )
    };
    let b = value.as_bytes();
    let digits = |range: std::ops::Range<usize>| {
        b[range].iter().try_fold(0u32, |acc, d| {
            d.is_ascii_digit().then(|| acc * 10 + u32::from(d - b'0'))
        })
    };
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return Err(invalid());
    }
    let (Some(year), Some(month), Some(day)) = (digits(0..4), digits(5..7), digits(8..10)) else {
        return Err(invalid());
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return Err(invalid()),
    };
    if day == 0 || day > days {
        return Err(invalid());
    }
    Ok(value.to_owned())
}

/// Text with content, without control characters, at most `max` characters.
fn text(n: usize, label: &str, value: &str, max: usize) -> Result<String, Error> {
    // U+FEFF counts as blank, as in the host's JSON Schema `\S`.
    let content = value.chars().any(|c| !c.is_whitespace() && c != '\u{feff}');
    if !content || value.chars().count() > max || value.chars().any(char::is_control) {
        return Err(error(
            INVALID_TEXT,
            format!("Línea {n}: {label} debe tener texto, sin caracteres de control, de hasta {max} caracteres."),
        ));
    }
    Ok(value.to_owned())
}

/// Exactly one of the two columns: whole units, digits only, no leading zero.
fn amount(n: usize, debit: &str, credit: &str) -> Result<i64, Error> {
    let (digits, sign) = match (debit.is_empty(), credit.is_empty()) {
        (false, true) => (debit, -1),
        (true, false) => (credit, 1),
        _ => {
            return Err(error(
                INVALID_AMOUNT,
                format!("Línea {n}: completá Débito o Crédito, no ambos."),
            ))
        }
    };
    let canonical = digits.len() <= 13
        && !digits.starts_with('0')
        && digits.bytes().all(|d| d.is_ascii_digit());
    match digits.parse::<i64>() {
        Ok(value) if canonical && value <= MAX_AMOUNT => Ok(sign * value),
        _ => Err(error(
            INVALID_AMOUNT,
            format!("Línea {n}: el importe debe ser un entero positivo sin separadores, hasta {MAX_AMOUNT}."),
        )),
    }
}

pub struct Connector;

impl Guest for Connector {
    fn describe() -> Manifest {
        manifest()
    }

    fn parse(input: Vec<u8>, ctx: Context) -> Result<String, Error> {
        parse(&input, &ctx)
    }
}

// Only the component exports these symbols; native test builds stay plain.
#[cfg(target_arch = "wasm32")]
nemein_connector_sdk::export!(Connector);
