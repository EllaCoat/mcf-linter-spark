//! SNBT of 1.21.5 and later (`SnbtGrammar`, `SnbtOperations`), read into the tree of `nbt.rs`.
//! The error messages are the game's (`snbt.parser.*` in `en_us.json`).

use super::nbt::{NbtEntry, NbtNode, NbtValue, is_java_whitespace};
use crate::reader::{PResult, Reader};

/// `TagParser.parseAsArgument`: one value. Leading whitespace is skipped.
pub fn parse_tag(r: &mut Reader) -> PResult<NbtNode> {
    skip_ws(r);
    literal(r)
}

/// `TagParser.parseCompoundAsArgument`: a value that must be a compound.
pub fn parse_compound(r: &mut Reader) -> PResult<NbtNode> {
    skip_ws(r);
    let start = r.pos;
    let node = literal(r)?;
    if matches!(node.value, NbtValue::Compound(_)) { Ok(node) } else { Err(r.error_span(start, "Expected compound tag")) }
}

/// The characters of an unquoted string (`SnbtGrammar.isAllowedInUnquotedString`).
fn is_unquoted(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b'+')
}

fn skip_ws(r: &mut Reader) {
    while let Some(c) = r.peek_char() {
        if !is_java_whitespace(c) {
            break;
        }
        r.pos += c.len_utf8();
    }
}

fn finish(r: &Reader, start: usize, value: NbtValue) -> NbtNode {
    NbtNode { start: r.offset_of(start), end: r.offset(), value }
}

fn separator(r: &mut Reader) -> bool {
    skip_ws(r);
    if r.try_consume(b',') {
        skip_ws(r);
        true
    } else {
        false
    }
}

fn literal(r: &mut Reader) -> PResult<NbtNode> {
    let start = r.pos;
    match r.peek() {
        None => Err(r.error("Expected value")),
        Some(b'+' | b'-' | b'.' | b'0'..=b'9') => {
            let token = r.read_while(is_unquoted);
            match number(token, IntType::Int) {
                Ok((value, _)) => Ok(finish(r, start, value)),
                Err(message) => Err(r.error_span(start, message)),
            }
        }
        Some(q @ (b'"' | b'\'')) => {
            let value = quoted(r, q)?;
            Ok(finish(r, start, NbtValue::String { value, quote: Some(q) }))
        }
        Some(b'{') => compound(r),
        Some(b'[') => list(r),
        Some(_) => {
            let word = r.read_while(is_unquoted);
            if word.is_empty() {
                return Err(r.error("Expected value"));
            }
            let before_args = r.pos;
            skip_ws(r);
            if r.peek() == Some(b'(') {
                return operation(r, start, word);
            }
            r.pos = before_args;
            let value = if word.eq_ignore_ascii_case("true") {
                NbtValue::Byte { value: 1, raw_bool: Some(true) }
            } else if word.eq_ignore_ascii_case("false") {
                NbtValue::Byte { value: 0, raw_bool: Some(false) }
            } else {
                NbtValue::String { value: word.to_string(), quote: None }
            };
            Ok(finish(r, start, value))
        }
    }
}

fn compound(r: &mut Reader) -> PResult<NbtNode> {
    let start = r.pos;
    r.pos += 1;
    skip_ws(r);
    let mut entries = Vec::new();
    while r.can_read() && r.peek() != Some(b'}') {
        let key_pos = r.pos;
        let (key, key_quote) = match r.peek() {
            Some(q @ (b'"' | b'\'')) => {
                let key = quoted(r, q)?;
                if key.is_empty() {
                    return Err(r.error_span(key_pos, "Key cannot be empty"));
                }
                (key, Some(q))
            }
            _ => {
                let key = r.read_while(is_unquoted);
                if key.is_empty() {
                    return Err(r.error("Expected key"));
                }
                (key.to_string(), None)
            }
        };
        let key_end = r.offset();
        skip_ws(r);
        r.expect(b':')?;
        skip_ws(r);
        let value = literal(r)?;
        entries.push(NbtEntry { key, key_quote, key_start: r.offset_of(key_pos), key_end, value });
        if !separator(r) {
            break;
        }
    }
    skip_ws(r);
    r.expect(b'}')?;
    Ok(finish(r, start, NbtValue::Compound(entries)))
}

fn list(r: &mut Reader) -> PResult<NbtNode> {
    let start = r.pos;
    r.pos += 1;
    skip_ws(r);
    let first = r.pos;
    if let Some(kind @ (b'B' | b'I' | b'L')) = r.peek() {
        r.pos += 1;
        skip_ws(r);
        if r.try_consume(b';') {
            return array_tag(r, start, kind);
        }
        r.pos = first;
    }
    let mut items = Vec::new();
    while r.can_read() && r.peek() != Some(b']') {
        items.push(literal(r)?);
        if !separator(r) {
            break;
        }
    }
    skip_ws(r);
    r.expect(b']')?;
    Ok(finish(r, start, NbtValue::List(items)))
}

/// The integer literals after `[B;`, `[I;` or `[L;`. An element without a suffix takes the
/// array's type; one with a suffix may be of a narrower type.
fn array_tag(r: &mut Reader, start: usize, kind: u8) -> PResult<NbtNode> {
    skip_ws(r);
    let (element, allowed): (IntType, &[IntType]) = match kind {
        b'B' => (IntType::Byte, &[IntType::Byte]),
        b'I' => (IntType::Int, &[IntType::Byte, IntType::Short, IntType::Int]),
        _ => (IntType::Long, &[IntType::Byte, IntType::Short, IntType::Int, IntType::Long]),
    };
    let mut items = Vec::new();
    while r.can_read() && r.peek() != Some(b']') {
        let item_pos = r.pos;
        if !matches!(r.peek(), Some(b'+' | b'-' | b'0'..=b'9')) {
            return Err(r.error("Invalid array element type"));
        }
        let token = r.read_while(is_unquoted);
        let value = match number(token, element) {
            Ok((value, suffixed)) => match int_of(&value) {
                Some((t, v)) if !suffixed || allowed.contains(&t) => element.value(v),
                _ => return Err(r.error_span(item_pos, "Invalid array element type")),
            },
            Err(message) => return Err(r.error_span(item_pos, message)),
        };
        items.push(finish(r, item_pos, value));
        if !separator(r) {
            break;
        }
    }
    skip_ws(r);
    r.expect(b']')?;
    let value = match kind {
        b'B' => NbtValue::ByteArray(items),
        b'I' => NbtValue::IntArray(items),
        _ => NbtValue::LongArray(items),
    };
    Ok(finish(r, start, value))
}

/// `name(arguments)`: `bool` and `uuid`, each of one argument.
fn operation(r: &mut Reader, start: usize, name: &str) -> PResult<NbtNode> {
    r.pos += 1;
    skip_ws(r);
    let mut args = Vec::new();
    while r.can_read() && r.peek() != Some(b')') {
        args.push(literal(r)?);
        if !separator(r) {
            break;
        }
    }
    skip_ws(r);
    r.expect(b')')?;
    let value = match (name, args.as_slice()) {
        ("bool", [arg]) => {
            let truth = match &arg.value {
                NbtValue::Byte { value, .. } => *value != 0,
                NbtValue::Short(v) => *v != 0,
                NbtValue::Int(v) => *v != 0,
                NbtValue::Long(v) => *v != 0,
                NbtValue::Float(v) => *v != 0.0,
                NbtValue::Double(v) => *v != 0.0,
                _ => return Err(r.error_span(start, "Expected a number or a boolean")),
            };
            NbtValue::Byte { value: truth.into(), raw_bool: None }
        }
        ("uuid", [arg]) => {
            let ints = match &arg.value {
                NbtValue::String { value, .. } => uuid_ints(value),
                _ => None,
            };
            let Some(ints) = ints else { return Err(r.error_span(start, "Expected a string representing a valid UUID")) };
            let node = |v: i32| NbtNode { start: r.offset_of(start), end: r.offset(), value: NbtValue::Int(v) };
            NbtValue::IntArray(ints.into_iter().map(node).collect())
        }
        _ => return Err(r.error_span(start, format!("No such operation: {name}/{}", args.len()))),
    };
    Ok(finish(r, start, value))
}

/// `UUID.fromString` and `UUIDUtil.uuidToIntArray`.
fn uuid_ints(s: &str) -> Option<[i32; 4]> {
    let parts: Vec<&str> = s.split('-').collect();
    if s.len() > 36 || parts.len() != 5 || parts.iter().any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_hexdigit())) {
        return None;
    }
    let field = |i: usize| u64::from_str_radix(parts[i], 16).ok();
    let most = (field(0)? & 0xffff_ffff) << 32 | (field(1)? & 0xffff) << 16 | (field(2)? & 0xffff);
    let least = (field(3)? & 0xffff) << 48 | (field(4)? & 0xffff_ffff_ffff);
    Some([(most >> 32) as i32, most as i32, (least >> 32) as i32, least as i32])
}

fn quoted(r: &mut Reader, q: u8) -> PResult<String> {
    let start = r.pos;
    r.pos += 1;
    let mut out = String::new();
    loop {
        match r.peek_char() {
            None => return Err(r.error_span(start, "Unclosed quoted string")),
            Some(c) if c as u32 == q as u32 => {
                r.pos += 1;
                return Ok(out);
            }
            Some('\\') => {
                r.pos += 1;
                escape(r, &mut out)?;
            }
            Some(c) => {
                out.push(c);
                r.pos += c.len_utf8();
            }
        }
    }
}

fn escape(r: &mut Reader, out: &mut String) -> PResult<()> {
    let Some(c) = r.peek_char() else { return Err(r.error("Invalid string contents")) };
    r.pos += c.len_utf8();
    let simple = match c {
        'b' => Some('\u{8}'),
        's' => Some(' '),
        't' => Some('\t'),
        'n' => Some('\n'),
        'f' => Some('\u{c}'),
        'r' => Some('\r'),
        '\\' | '\'' | '"' => Some(c),
        _ => None,
    };
    if let Some(s) = simple {
        out.push(s);
        return Ok(());
    }
    let len = match c {
        'x' => 2,
        'u' => 4,
        'U' => 8,
        'N' => {
            let start = r.pos;
            r.expect(b'{')?;
            let name = r.read_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b' '));
            if name.is_empty() || !r.try_consume(b'}') {
                return Err(r.error_span(start, "Invalid Unicode character name"));
            }
            // ponytail: Unicode names are not looked up, an unknown name passes; add the name table if it matters
            out.push('\u{fffd}');
            return Ok(());
        }
        _ => {
            r.pos -= c.len_utf8();
            return Err(r.error("Invalid string contents"));
        }
    };
    let start = r.pos;
    let found = r.rest().as_bytes().iter().take(len).take_while(|b| b.is_ascii_hexdigit()).count();
    if found < len {
        return Err(r.error(format!("Expected a character literal of length {len}")));
    }
    let hex = &r.rest()[..len];
    r.pos += len;
    match u32::from_str_radix(hex, 16).ok().and_then(char::from_u32) {
        Some(ch) => {
            out.push(ch);
            Ok(())
        }
        None => Err(r.error_span(start, format!("Invalid Unicode character value: {hex}"))),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum IntType {
    Byte,
    Short,
    Int,
    Long,
}

impl IntType {
    fn bits(self) -> u32 {
        match self {
            IntType::Byte => 8,
            IntType::Short => 16,
            IntType::Int => 32,
            IntType::Long => 64,
        }
    }

    /// The tag of a value already in the type's range (two's complement for unsigned ones).
    fn value(self, v: i128) -> NbtValue {
        match self {
            IntType::Byte => NbtValue::Byte { value: v as i8, raw_bool: None },
            IntType::Short => NbtValue::Short(v as i16),
            IntType::Int => NbtValue::Int(v as i32),
            IntType::Long => NbtValue::Long(v as i64),
        }
    }
}

fn int_of(value: &NbtValue) -> Option<(IntType, i128)> {
    match value {
        NbtValue::Byte { value, .. } => Some((IntType::Byte, i128::from(*value))),
        NbtValue::Short(v) => Some((IntType::Short, i128::from(*v))),
        NbtValue::Int(v) => Some((IntType::Int, i128::from(*v))),
        NbtValue::Long(v) => Some((IntType::Long, i128::from(*v))),
        _ => None,
    }
}

const UNQUOTED_START: &str = "Unquoted strings can't start with digits 0-9, + or -";

/// A number literal (`SnbtGrammar` 346-436): the value, and whether it had a type suffix. An
/// integer without a suffix is of `default`.
fn number(token: &str, default: IntType) -> Result<(NbtValue, bool), String> {
    let (negative, body) = match token.as_bytes().first() {
        Some(b'-') => (true, &token[1..]),
        Some(b'+') => (false, &token[1..]),
        _ => (false, token),
    };
    let lower = body.to_ascii_lowercase();
    let radix = if lower.starts_with("0x") {
        Some(16)
    } else if lower.starts_with("0b") && lower[2..].starts_with(['0', '1', '_']) {
        Some(2)
    } else {
        None
    };
    if let Some(radix) = radix {
        let digits_len = body[2..].bytes().take_while(|b| *b == b'_' || (*b as char).is_digit(radix)).count();
        let (digits, suffix) = body[2..].split_at(digits_len);
        if digits.is_empty() {
            return Err(if radix == 16 { "Expected a hexadecimal number" } else { "Expected a binary number" }.into());
        }
        return integer(digits, radix, negative, suffix, true, default).map(|v| (v, !suffix.is_empty()));
    }
    let digits_end = |s: &str| s.bytes().take_while(|b| b.is_ascii_digit() || *b == b'_').count();
    let (int_part, rest) = body.split_at(digits_end(body));
    let (fraction, rest) = match rest.strip_prefix('.') {
        Some(after) => {
            let (fraction, rest) = after.split_at(digits_end(after));
            (Some(fraction), rest)
        }
        None => (None, rest),
    };
    if int_part.is_empty() && fraction.is_none_or(str::is_empty) {
        return Err(UNQUOTED_START.into());
    }
    let (exponent, suffix) = match rest.strip_prefix(['e', 'E']) {
        Some(after) => {
            let sign_len = usize::from(after.starts_with(['+', '-']));
            let len = sign_len + digits_end(&after[sign_len..]);
            if len == sign_len {
                return Err("Expected a decimal number".into());
            }
            (Some(&after[..len]), &after[len..])
        }
        None => (None, rest),
    };
    let single = match suffix {
        "f" | "F" => true,
        "d" | "D" => false,
        "" if fraction.is_some() || exponent.is_some() => false,
        _ if fraction.is_some() || exponent.is_some() => return Err(UNQUOTED_START.into()),
        _ => {
            if int_part.len() > 1 && int_part.starts_with('0') {
                return Err("Decimal numbers can't start with 0".into());
            }
            return integer(int_part, 10, negative, suffix, false, default).map(|v| (v, !suffix.is_empty()));
        }
    };
    let mut text = String::from(if negative { "-" } else { "" });
    text += &digits(int_part)?;
    if let Some(fraction) = fraction {
        text = format!("{text}.{}", digits(fraction)?);
    }
    if let Some(exponent) = exponent {
        let (sign, exp_digits) = exponent.split_at(usize::from(exponent.starts_with(['+', '-'])));
        text = format!("{text}e{sign}{}", digits(exp_digits)?);
    }
    let failure = || format!("Failed to parse number: {token}");
    let (value, finite) = if single {
        let v: f32 = text.parse().map_err(|_| failure())?;
        (NbtValue::Float(v), v.is_finite())
    } else {
        let v: f64 = text.parse().map_err(|_| failure())?;
        (NbtValue::Double(v), v.is_finite())
    };
    if !finite {
        return Err("Non-finite numbers are not allowed".into());
    }
    Ok((value, !suffix.is_empty()))
}

/// The digits of one numeral without its `_`, which may only be between digits.
fn digits(run: &str) -> Result<String, String> {
    if run.starts_with('_') || run.ends_with('_') {
        return Err("Underscore characters are not allowed at the start or end of a number".into());
    }
    Ok(run.replace('_', ""))
}

fn integer(digits_run: &str, radix: u32, negative: bool, suffix: &str, unsigned_default: bool, default: IntType) -> Result<NbtValue, String> {
    let lower = suffix.to_ascii_lowercase();
    let parsed = match lower.as_bytes() {
        [] => Some((None, default)),
        [t] => int_type(*t).map(|t| (None, t)),
        [s @ (b'u' | b's'), t] => int_type(*t).map(|t| (Some(*s == b'u'), t)),
        _ => None,
    };
    let Some((sign, ty)) = parsed else { return Err(UNQUOTED_START.into()) };
    let digits = digits(digits_run)?;
    let unsigned = sign.unwrap_or(unsigned_default);
    let failure = || format!("Failed to parse number: {}{digits}", if negative { "-" } else { "" });
    let magnitude = u128::from_str_radix(&digits, radix).map_err(|_| failure())?;
    let bits = ty.bits();
    let value = if unsigned {
        if negative {
            return Err("Expected a non-negative number".into());
        }
        if magnitude >= 1u128 << bits {
            return Err(failure());
        }
        let v = magnitude as i128;
        if v >= 1i128 << (bits - 1) { v - (1i128 << bits) } else { v }
    } else {
        if magnitude > 1u128 << (bits - 1) {
            return Err(failure());
        }
        let v = if negative { -(magnitude as i128) } else { magnitude as i128 };
        if v >= 1i128 << (bits - 1) {
            return Err(failure());
        }
        v
    };
    Ok(ty.value(value))
}

fn int_type(b: u8) -> Option<IntType> {
    Some(match b {
        b'b' => IntType::Byte,
        b's' => IntType::Short,
        b'i' => IntType::Int,
        b'l' => IntType::Long,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value(src: &str) -> NbtValue {
        parse_tag(&mut Reader::new(src, 0)).unwrap_or_else(|e| panic!("{src}: {}", e.message)).value
    }

    fn error(src: &str) -> String {
        parse_tag(&mut Reader::new(src, 0)).map(|n| format!("parsed: {:?}", n.value)).unwrap_or_else(|e| e.message)
    }

    fn byte(v: i8) -> NbtValue {
        NbtValue::Byte { value: v, raw_bool: None }
    }

    #[test]
    fn integers_with_radix_sign_and_suffix() {
        assert_eq!(value("12"), NbtValue::Int(12));
        assert_eq!(value("-12"), NbtValue::Int(-12));
        assert_eq!(value("+12"), NbtValue::Int(12));
        assert_eq!(value("1b"), byte(1));
        assert_eq!(value("1B"), byte(1));
        assert_eq!(value("240ub"), byte(-16));
        assert_eq!(value("-5sb"), byte(-5));
        assert_eq!(value("1s"), NbtValue::Short(1));
        assert_eq!(value("1i"), NbtValue::Int(1));
        assert_eq!(value("1l"), NbtValue::Long(1));
        assert_eq!(value("0"), NbtValue::Int(0));
        assert_eq!(value("0b"), byte(0));
        assert_eq!(value("0x1b"), NbtValue::Int(27));
        assert_eq!(value("0xFFub"), byte(-1));
        assert_eq!(value("0xFFFFFFFF"), NbtValue::Int(-1));
        assert_eq!(value("0b101"), NbtValue::Int(5));
        assert_eq!(value("1_000"), NbtValue::Int(1000));
        assert_eq!(value("2147483647"), NbtValue::Int(i32::MAX));
        assert_eq!(value("-2147483648"), NbtValue::Int(i32::MIN));
    }

    #[test]
    fn integer_errors() {
        assert!(error("300b").starts_with("Failed to parse number"));
        assert!(error("2147483648").starts_with("Failed to parse number"));
        assert_eq!(value("-2147483648"), NbtValue::Int(i32::MIN));
        assert!(error("-170141183460469231731687303715884105728").starts_with("Failed to parse number"));
        assert!(error("-0x80000000000000000000000000000000sl").starts_with("Failed to parse number"));
        assert_eq!(error("007"), "Decimal numbers can't start with 0");
        assert_eq!(error("1abc"), "Unquoted strings can't start with digits 0-9, + or -");
        assert_eq!(error("-abc"), "Unquoted strings can't start with digits 0-9, + or -");
        assert_eq!(error("-1ub"), "Expected a non-negative number");
        assert_eq!(error("-0x1"), "Expected a non-negative number");
        assert_eq!(error("_1"), "parsed: String { value: \"_1\", quote: None }");
        assert_eq!(error("1_"), "Underscore characters are not allowed at the start or end of a number");
        assert_eq!(error("0x"), "Expected a hexadecimal number");
    }

    #[test]
    fn floats() {
        assert_eq!(value("1.5"), NbtValue::Double(1.5));
        assert_eq!(value("1."), NbtValue::Double(1.0));
        assert_eq!(value(".5"), NbtValue::Double(0.5));
        assert_eq!(value("1e5"), NbtValue::Double(1e5));
        assert_eq!(value("1.5e-3f"), NbtValue::Float(1.5e-3));
        assert_eq!(value("1f"), NbtValue::Float(1.0));
        assert_eq!(value("1D"), NbtValue::Double(1.0));
        assert_eq!(value("007f"), NbtValue::Float(7.0));
        assert_eq!(value("-0.5d"), NbtValue::Double(-0.5));
        assert_eq!(error("1e400"), "Non-finite numbers are not allowed");
        assert_eq!(error("1e40f"), "Non-finite numbers are not allowed");
        assert_eq!(error("."), "Unquoted strings can't start with digits 0-9, + or -");
        assert_eq!(error("1.5b"), "Unquoted strings can't start with digits 0-9, + or -");
    }

    #[test]
    fn strings_and_booleans() {
        assert_eq!(value("abc"), NbtValue::String { value: "abc".into(), quote: None });
        assert_eq!(value("a.b-c+d_e"), NbtValue::String { value: "a.b-c+d_e".into(), quote: None });
        assert_eq!(value("TRUE"), NbtValue::Byte { value: 1, raw_bool: Some(true) });
        assert_eq!(value("false"), NbtValue::Byte { value: 0, raw_bool: Some(false) });
        assert_eq!(value("'it''"), NbtValue::String { value: "it".into(), quote: Some(b'\'') });
        assert_eq!(value(r#""a\tb\x41é\U0001F600\s""#), NbtValue::String { value: "a\tbAé\u{1F600} ".into(), quote: Some(b'"') });
        assert_eq!(error(r#""\q""#), "Invalid string contents");
        assert_eq!(error(r#""\x4""#), "Expected a character literal of length 2");
        assert_eq!(error(r#""\uD800""#), "Invalid Unicode character value: D800");
        assert_eq!(error("\"abc"), "Unclosed quoted string");
        assert_eq!(error("§"), "Expected value");
    }

    #[test]
    fn compounds_and_lists() {
        let NbtValue::Compound(entries) = value("{a: 1, 'b c': [1, \"x\", {}], 1d: 2,}") else { panic!() };
        let keys: Vec<_> = entries.iter().map(|e| e.key.as_str()).collect();
        assert_eq!(keys, ["a", "b c", "1d"]);
        let NbtValue::List(items) = &entries[1].value.value else { panic!() };
        assert_eq!(items.len(), 3);
        assert_eq!(value("[]"), NbtValue::List(Vec::new()));
        assert_eq!(value("[1,]"), NbtValue::List(vec![NbtNode { start: 1, end: 2, value: NbtValue::Int(1) }]));
        assert_eq!(error("{'': 1}"), "Key cannot be empty");
        assert_eq!(error("{a 1}"), "Expected ':'");
        assert_eq!(error("{a: 1"), "Expected '}'");
        assert_eq!(error("[1 2]"), "Expected ']'");
    }

    #[test]
    fn arrays() {
        let elements = |v: NbtValue| match v {
            NbtValue::ByteArray(n) | NbtValue::IntArray(n) | NbtValue::LongArray(n) => n.into_iter().map(|n| n.value).collect::<Vec<_>>(),
            other => panic!("{other:?}"),
        };
        assert_eq!(elements(value("[B; 1, 2b]")), [byte(1), byte(2)]);
        assert_eq!(elements(value("[I;1b,2s,3]")), [NbtValue::Int(1), NbtValue::Int(2), NbtValue::Int(3)]);
        assert_eq!(elements(value("[L;1,2i]")), [NbtValue::Long(1), NbtValue::Long(2)]);
        assert_eq!(elements(value("[B;]")), Vec::<NbtValue>::new());
        assert_eq!(elements(value("[ I ; 1 ]")), [NbtValue::Int(1)]);
        assert!(matches!(value("[ I ]"), NbtValue::List(_)));
        assert_eq!(error("[B;1s]"), "Invalid array element type");
        assert_eq!(error("[I;1l]"), "Invalid array element type");
        assert_eq!(error("[I;1.5]"), "Invalid array element type");
        assert_eq!(error("[I;a]"), "Invalid array element type");
        assert!(error("[B;300]").starts_with("Failed to parse number"));
        assert_eq!(error("[b;1]"), "Expected ']'");
    }

    #[test]
    fn operations() {
        assert_eq!(value("bool(1)"), byte(1));
        assert_eq!(value("bool(0.0)"), byte(0));
        assert_eq!(value("bool(true)"), byte(1));
        assert_eq!(error("bool('a')"), "Expected a number or a boolean");
        let NbtValue::IntArray(ints) = value("uuid(\"f81d4fae-7dec-11d0-a765-00a0c91e6bf6\")") else { panic!() };
        let ints: Vec<_> = ints.into_iter().map(|n| n.value).collect();
        assert_eq!(ints, [NbtValue::Int(-132296786), NbtValue::Int(2112623056), NbtValue::Int(-1486552928), NbtValue::Int(-920753162)]);
        assert_eq!(error("uuid('x')"), "Expected a string representing a valid UUID");
        assert_eq!(error("foo(1)"), "No such operation: foo/1");
        assert_eq!(error("Bool(1)"), "No such operation: Bool/1");
    }

    #[test]
    fn compound_argument() {
        assert!(parse_compound(&mut Reader::new(" {a:1}", 0)).is_ok());
        assert_eq!(parse_compound(&mut Reader::new("[1]", 0)).unwrap_err().message, "Expected compound tag");
    }
}
