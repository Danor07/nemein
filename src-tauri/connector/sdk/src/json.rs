//! Compact JSON text with the same string escaping as `JSON.stringify`.

use std::fmt::Write;

/// Appends `value` as a JSON string. Escapes only `"`, `\` and control
/// characters, so the output is the shortest form and matches JavaScript.
pub(crate) fn push_string(out: &mut String, value: &str) {
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c < ' ' => {
                // Writing to a String cannot fail.
                let _ = write!(out, "\\u{:04x}", u32::from(c));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::push_string;

    fn encode(value: &str) -> String {
        let mut out = String::new();
        push_string(&mut out, value);
        out
    }

    #[test]
    fn escapes_like_javascript() {
        assert_eq!(encode(""), r#""""#);
        assert_eq!(encode("Café ñ €"), "\"Café ñ €\"");
        assert_eq!(encode("a\"b\\c"), r#""a\"b\\c""#);
        assert_eq!(encode("\u{08}\u{0c}\n\r\t"), r#""\b\f\n\r\t""#);
        assert_eq!(encode("\u{00}\u{1f}\u{7f}"), "\"\\u0000\\u001f\u{7f}\"");
        assert_eq!(encode("/ \u{2028} 𝄞"), "\"/ \u{2028} 𝄞\"");
        assert_eq!(encode(" "), "\" \"");
    }
}
