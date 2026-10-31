//! Style rules from `datapack.lint.*` that do not depend on NBT schemas.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use regex::Regex;
use serde_json::Value;

/// DHP's `checkNamingConvention` for one rule value (`[severity, convention]`'s convention).
pub fn follows_convention(identity: &str, convention: &Value) -> bool {
    match convention {
        Value::Array(items) => items.iter().any(|c| follows_convention(identity, c)),
        Value::String(s) => {
            if s.len() >= 2 && s.starts_with('/') && s.ends_with('/') {
                return regex(&s[1..s.len() - 1]).is_none_or(|r| r.is_match(identity));
            }
            let re = match s.as_str() {
                "camelCase" => r"^[a-z\d]+([A-Z\d]+[a-z\d]*)*$",
                "PascalCase" => r"^([A-Z\d]+[a-z\d]*)+$",
                "snake_case" => r"^[a-z\d]+(_[a-z\d]+)*$",
                "SCREAMING_SNAKE_CASE" => r"^[A-Z\d]+(_[A-Z\d]+)*$",
                "kebab-case" => r"^[a-z\d]+(\-[a-z\d]+)*$",
                "lowercase" => r"^[a-z\d]+$",
                "UPPERCASE" => r"^[A-Z\d]+$",
                _ => return true,
            };
            regex(re).is_none_or(|r| r.is_match(identity))
        }
        Value::Object(o) => {
            let mut id = identity;
            if let Some(prefix) = o.get("prefix").and_then(Value::as_str).filter(|p| !p.is_empty()) {
                match id.strip_prefix(prefix) {
                    Some(rest) => id = rest,
                    None => return false,
                }
            }
            if let Some(suffix) = o.get("suffix").and_then(Value::as_str).filter(|p| !p.is_empty()) {
                match id.strip_suffix(suffix) {
                    Some(rest) => id = rest,
                    None => return false,
                }
            }
            let Some(parts) = o.get("parts").filter(|p| !p.is_null()) else { return true };
            let sep = o.get("sep").and_then(Value::as_str).filter(|s| !s.is_empty());
            let Some(sep) = sep else {
                return match parts {
                    Value::Array(list) => list.iter().any(|p| follows_convention(id, p)),
                    p => follows_convention(id, p),
                };
            };
            let pieces: Vec<&str> = id.split(sep).collect();
            let Value::Array(list) = parts else {
                return pieces.iter().all(|p| follows_convention(p, parts));
            };
            let allow_less = o.get("allowLessParts").and_then(Value::as_bool).unwrap_or(false);
            let allow_more = o.get("allowMoreParts").and_then(Value::as_bool).unwrap_or(false);
            if pieces.len() < list.len() && !allow_less || pieces.len() > list.len() && !allow_more {
                return false;
            }
            if list.is_empty() {
                return true;
            }
            pieces.iter().enumerate().all(|(i, p)| follows_convention(p, &list[i.min(list.len() - 1)]))
        }
        _ => true,
    }
}

/// The labels of a convention for messages (`getConventionNames`).
pub fn convention_names(convention: &Value) -> String {
    let items: Vec<&Value> = match convention {
        Value::Array(a) => a.iter().collect(),
        v => vec![v],
    };
    items
        .iter()
        .map(|v| match v {
            Value::String(s) => s.clone(),
            Value::Object(o) => o.get("label").and_then(Value::as_str).unwrap_or("").to_string(),
            _ => String::new(),
        })
        .collect::<Vec<_>>()
        .join(" or ")
}

fn regex(source: &str) -> Option<Arc<Regex>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<Arc<Regex>>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(r) = cache.lock().unwrap().get(source) {
        return r.clone();
    }
    let r = Regex::new(source).ok().map(Arc::new);
    cache.lock().unwrap().insert(source.to_string(), r.clone());
    r
}

/// The quote character `quoteString` would choose for `value` under a quote type setting.
pub fn expected_quote(value: &str, quote_type: &str) -> u8 {
    match quote_type {
        "always single" => b'\'',
        "always double" => b'"',
        "prefer single" => {
            if value.contains('\'') && !value.contains('"') { b'"' } else { b'\'' }
        }
        _ => {
            if value.contains('"') && !value.contains('\'') { b'\'' } else { b'"' }
        }
    }
}

/// `validateStringQuote`. `quoted` is the quote used in the source, if any.
/// Returns (rule, message) pairs to report.
pub fn string_quote_problems(
    quoted: Option<u8>,
    value: &str,
    quote_rule: Option<(&'static str, bool)>,
    quote_type_rule: Option<(&'static str, &str)>,
) -> Vec<(&'static str, String)> {
    let mut out = Vec::new();
    let expected = expected_quote(value, quote_type_rule.map_or("prefer double", |(_, t)| t));
    if let Some((rule, should_quote)) = quote_rule {
        if should_quote != quoted.is_some() {
            let message = if should_quote { "Expected a quote" } else { "Expected an unquoted string" };
            out.push((rule, message.to_string()));
        }
    }
    if let (Some(q), Some((rule, _))) = (quoted, quote_type_rule) {
        if q != expected {
            let message = if expected == b'"' { "Prefer double quotes" } else { "Prefer single quotes" };
            out.push((rule, message.to_string()));
        }
    }
    out
}

/// `SelectorArgumentsNode[IsMapSorted]`: are the keys in the configured order?
/// Keys missing from the configuration are skipped.
pub fn selector_keys_sorted(keys: &[String], order: &[Value]) -> bool {
    let order: Vec<&str> = order.iter().filter_map(Value::as_str).collect();
    let mut i = 0;
    for key in keys {
        let Some(pos) = order.iter().position(|k| k == key) else { continue };
        if pos < i {
            return false;
        }
        i = pos;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn chained_pascal_case() {
        let c = json!({"label": "ChainedPascalCase", "allowLessParts": true, "allowMoreParts": true, "sep": ".", "parts": "/^([A-Z\\d]+[a-z\\d]*)+$/"});
        assert!(follows_convention("Foo.BarBaz", &c));
        assert!(!follows_convention("foo.Bar", &c));
        let dollar = json!({"label": "DollerPrefix", "prefix": "$"});
        assert!(follows_convention("$x", &dollar));
        assert!(!follows_convention("x", &dollar));
        assert!(follows_convention("abc", &json!("lowercase")));
    }

    #[test]
    fn selector_order() {
        let order = vec![json!("type"), json!("tag"), json!("tagNeg"), json!("limit")];
        let k = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(selector_keys_sorted(&k(&["type", "tag", "tag", "limit"]), &order));
        assert!(!selector_keys_sorted(&k(&["tag", "type"]), &order));
        assert!(selector_keys_sorted(&k(&["type", "x", "limit"]), &order));
    }

    #[test]
    fn quotes() {
        assert_eq!(string_quote_problems(None, "a", Some(("stringQuote", true)), None).len(), 1);
        assert!(string_quote_problems(Some(b'"'), "a", Some(("stringQuote", true)), Some(("stringQuoteType", "prefer double"))).is_empty());
        assert_eq!(string_quote_problems(Some(b'\''), "a", None, Some(("stringQuoteType", "prefer double"))).len(), 1);
        assert!(string_quote_problems(Some(b'\''), "a\"b", None, Some(("stringQuoteType", "prefer double"))).is_empty());
    }
}
