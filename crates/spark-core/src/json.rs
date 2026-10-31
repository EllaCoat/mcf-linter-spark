//! JSON syntax as Gson's `JsonReader` reads it, strict or lenient, keeping the spans of values and keys.

use crate::diag::ParseError;
use crate::reader::{PResult, Reader};

/// Byte offsets into the reader's source.
pub struct Node {
    pub json: Json,
    pub start: usize,
    pub end: usize,
    /// For an object member's value, the range of its key.
    pub key: Option<(usize, usize)>,
}

pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Array(Vec<Node>),
    Object(Vec<(String, Node)>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reading {
    Strict,
    Lenient,
}

// ponytail: the Rust stack bounds the nesting; vanilla only fails on a JVM stack overflow
pub(crate) const MAX_DEPTH: usize = 256;

const MALFORMED: &str = "Malformed JSON (strings need double quotes; comments and single quotes are not allowed)";

/// A whole file. A byte order mark at the start is skipped, as Gson does.
pub fn parse_document(text: &str, reading: Reading) -> Result<Node, ParseError> {
    let mut r = Reader::new(text, 0);
    if r.rest().starts_with('\u{feff}') {
        r.pos += '\u{feff}'.len_utf8();
    }
    let lenient = reading == Reading::Lenient;
    let node = value(&mut r, 0, lenient)?;
    if lenient {
        skip_whitespace(&mut r, false)?;
        if r.can_read() {
            return Err(r.error("Unexpected content after the JSON value"));
        }
    }
    Ok(node)
}

pub(crate) fn parse_value(r: &mut Reader, depth: usize) -> PResult<Node> {
    value(r, depth, false)
}

fn value(r: &mut Reader, depth: usize, lenient: bool) -> PResult<Node> {
    skip_whitespace(r, lenient)?;
    let start = r.pos;
    let json = match r.peek() {
        None => return Err(r.error("Unexpected end of input")),
        Some(b'"') => Json::Str(parse_string(r)?),
        Some(b'\'') if lenient => Json::Str(parse_string(r)?),
        Some(b'[' | b'{') if depth >= MAX_DEPTH => return Err(r.error("Nesting is too deep")),
        Some(b'[') => parse_array(r, depth, lenient)?,
        Some(b'{') => parse_object(r, depth, lenient)?,
        Some(_) => parse_literal(r, lenient)?,
    };
    Ok(Node { json, start, end: r.pos, key: None })
}

/// Gson skips only these four whitespace characters, and in a lenient reader the comments `//`
/// and `#` (to the end of the line) and `/* */`.
fn skip_whitespace(r: &mut Reader, lenient: bool) -> PResult<()> {
    loop {
        r.read_while(|b| matches!(b, b' ' | b'\t' | b'\r' | b'\n'));
        let rest = r.rest();
        if !lenient {
            return Ok(());
        } else if rest.starts_with("//") || rest.starts_with('#') {
            r.read_while(|b| b != b'\n' && b != b'\r');
        } else if let Some(comment) = rest.strip_prefix("/*") {
            let Some(close) = comment.find("*/") else { return Err(r.error("Unterminated comment")) };
            r.pos += 2 + close + 2;
        } else {
            return Ok(());
        }
    }
}

fn parse_array(r: &mut Reader, depth: usize, lenient: bool) -> PResult<Json> {
    r.pos += 1;
    let mut items = Vec::new();
    skip_whitespace(r, lenient)?;
    if r.try_consume(b']') {
        return Ok(Json::Array(items));
    }
    loop {
        skip_whitespace(r, lenient)?;
        match r.peek() {
            Some(b',' | b';' | b']') if lenient => items.push(Node { json: Json::Null, start: r.pos, end: r.pos, key: None }),
            Some(b']') => return Err(r.error("Trailing comma before ']'")),
            _ => items.push(value(r, depth + 1, lenient)?),
        }
        skip_whitespace(r, lenient)?;
        match r.peek() {
            Some(b',') => r.pos += 1,
            Some(b';') if lenient => r.pos += 1,
            Some(b']') => {
                r.pos += 1;
                return Ok(Json::Array(items));
            }
            None => return Err(r.error("Unterminated array")),
            Some(_) => return Err(r.error("Expected ',' or ']'")),
        }
    }
}

fn parse_object(r: &mut Reader, depth: usize, lenient: bool) -> PResult<Json> {
    r.pos += 1;
    let mut fields = Vec::new();
    skip_whitespace(r, lenient)?;
    if r.try_consume(b'}') {
        return Ok(Json::Object(fields));
    }
    let mut separator = b',';
    loop {
        skip_whitespace(r, lenient)?;
        let key_start = r.pos;
        let name = match r.peek() {
            Some(b'}') if separator == b';' => return Err(r.error("Trailing ';' before '}'")),
            Some(b'}') => return Err(r.error("Trailing comma before '}'")),
            Some(b'"') => parse_string(r)?,
            Some(b'\'') if lenient => parse_string(r)?,
            None => return Err(r.error("Unterminated object")),
            Some(_) if lenient => match unquoted(r) {
                "" => return Err(r.error("Expected name")),
                word => word.to_string(),
            },
            Some(_) => return Err(r.error(MALFORMED)),
        };
        let key = Some((key_start, r.pos));
        skip_whitespace(r, lenient)?;
        match r.peek() {
            Some(b':') => r.pos += 1,
            Some(b'=') if lenient => {
                r.pos += 1;
                r.try_consume(b'>');
            }
            _ => return Err(r.error("Expected ':'")),
        }
        fields.push((name, Node { key, ..value(r, depth + 1, lenient)? }));
        skip_whitespace(r, lenient)?;
        match r.peek() {
            Some(b',') => {
                separator = b',';
                r.pos += 1;
            }
            Some(b';') if lenient => {
                separator = b';';
                r.pos += 1;
            }
            Some(b'}') => {
                r.pos += 1;
                return Ok(Json::Object(fields));
            }
            None => return Err(r.error("Unterminated object")),
            Some(_) => return Err(r.error("Expected ',' or '}'")),
        }
    }
}

fn unquoted<'a>(r: &mut Reader<'a>) -> &'a str {
    r.read_while(|b| !matches!(b, b'/' | b'\\' | b';' | b'#' | b'=' | b'{' | b'}' | b'[' | b']' | b':' | b',' | b' ' | b'\t' | b'\x0c' | b'\r' | b'\n'))
}

/// `true`, `false`, `null` (each letter in either case) and numbers. A lenient reader takes
/// any other word as a string without quotes.
fn parse_literal(r: &mut Reader, lenient: bool) -> PResult<Json> {
    let rest = r.rest().as_bytes();
    let found = match number_len(rest) {
        Some(len) => Some((len, Json::Num(r.rest()[..len].parse().unwrap_or(f64::NAN)))),
        None => keyword(rest),
    };
    let ends = |len: usize| {
        rest.get(len).is_none_or(|b| {
            matches!(b, b'{' | b'}' | b'[' | b']' | b':' | b',' | b' ' | b'\t' | b'\x0c' | b'\r' | b'\n')
                || (lenient && matches!(b, b'/' | b'\\' | b';' | b'#' | b'='))
        })
    };
    match found {
        Some((len, json)) if ends(len) => {
            r.pos += len;
            Ok(json)
        }
        _ if lenient => match unquoted(r) {
            "" => Err(r.error("Expected a value")),
            word => Ok(Json::Str(word.to_string())),
        },
        _ => Err(r.error(MALFORMED)),
    }
}

fn keyword(rest: &[u8]) -> Option<(usize, Json)> {
    [("true", Json::Bool(true)), ("false", Json::Bool(false)), ("null", Json::Null)]
        .into_iter()
        .find(|(word, _)| rest.len() >= word.len() && rest[..word.len()].eq_ignore_ascii_case(word.as_bytes()))
        .map(|(word, json)| (word.len(), json))
}

/// `-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?`
fn number_len(b: &[u8]) -> Option<usize> {
    let digits = |from: usize| b[from.min(b.len())..].iter().take_while(|c| c.is_ascii_digit()).count();
    let mut i = usize::from(b.first() == Some(&b'-'));
    i += match b.get(i)? {
        b'0' => 1,
        b'1'..=b'9' => digits(i),
        _ => return None,
    };
    if b.get(i) == Some(&b'.') {
        match digits(i + 1) {
            0 => return None,
            n => i += 1 + n,
        }
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        let sign = usize::from(matches!(b.get(i + 1), Some(b'+' | b'-')));
        match digits(i + 1 + sign) {
            0 => return None,
            n => i += 1 + sign + n,
        }
    }
    Some(i)
}

fn parse_string(r: &mut Reader) -> PResult<String> {
    let start = r.pos;
    let quote = r.peek_char().unwrap_or('"');
    r.pos += 1;
    let mut out = String::new();
    loop {
        let Some(c) = r.peek_char() else {
            return Err(r.error_span(start, "Unterminated string"));
        };
        r.pos += c.len_utf8();
        match c {
            '\\' => out.push(parse_escape(r)?),
            c if c == quote => return Ok(out),
            _ => out.push(c),
        }
    }
}

/// Reads the character after a backslash.
fn parse_escape(r: &mut Reader) -> PResult<char> {
    let Some(c) = r.peek_char() else {
        return Err(r.error("Unterminated escape sequence"));
    };
    let decoded = match c {
        '"' | '\'' | '\\' | '/' | '\n' => c,
        'b' => '\u{8}',
        'f' => '\u{c}',
        'n' => '\n',
        'r' => '\r',
        't' => '\t',
        'u' => {
            r.pos += 1;
            return parse_unicode_escape(r);
        }
        _ => return Err(r.error("Invalid escape sequence")),
    };
    r.pos += c.len_utf8();
    Ok(decoded)
}

/// After `\u`. A lone surrogate becomes U+FFFD, which Rust strings cannot hold.
fn parse_unicode_escape(r: &mut Reader) -> PResult<char> {
    let high = parse_hex4(r)?;
    if (0xD800..0xDC00).contains(&high) && r.rest().starts_with("\\u") {
        let before = r.pos;
        r.pos += 2;
        if let Ok(low) = parse_hex4(r)
            && (0xDC00..0xE000).contains(&low)
        {
            return Ok(char::from_u32(0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00)).unwrap_or('\u{FFFD}'));
        }
        r.pos = before;
    }
    Ok(char::from_u32(high).unwrap_or('\u{FFFD}'))
}

fn parse_hex4(r: &mut Reader) -> PResult<u32> {
    let Some(digits) = r.src.as_bytes().get(r.pos..r.pos + 4) else {
        return Err(r.error("Unterminated escape sequence"));
    };
    if !digits.iter().all(u8::is_ascii_hexdigit) {
        return Err(r.error("Invalid unicode escape"));
    }
    let value = digits.iter().fold(0, |acc, d| acc * 16 + (*d as char).to_digit(16).unwrap_or(0));
    r.pos += 4;
    Ok(value)
}

/// Reads as much of a value as the text has, for completion while it is typed. Strings,
/// objects, and lists left open end at the end of the text (a string also at the end of its
/// line), a key with no value yet gets an empty `null` where the value would start, a word
/// that is no JSON literal is read as a string, and a character that starts nothing is skipped.
pub fn parse_partial(text: &str) -> Node {
    let mut p = Partial { text, pos: 0 };
    p.whitespace();
    p.value(0)
}

struct Partial<'t> {
    text: &'t str,
    pos: usize,
}

impl Partial<'_> {
    fn peek(&self) -> Option<u8> {
        self.text.as_bytes().get(self.pos).copied()
    }

    fn whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\r' | b'\n')) {
            self.pos += 1;
        }
    }

    fn empty(&self) -> Node {
        Node { json: Json::Null, start: self.pos, end: self.pos, key: None }
    }

    fn value(&mut self, depth: usize) -> Node {
        let start = self.pos;
        let json = match self.peek() {
            None | Some(b',' | b'}' | b']' | b':') => return self.empty(),
            Some(b'{') if depth < MAX_DEPTH => self.object(depth),
            Some(b'[') if depth < MAX_DEPTH => self.array(depth),
            Some(b'"') => Json::Str(self.string()),
            Some(_) => {
                let word = self.word();
                match word {
                    "true" => Json::Bool(true),
                    "false" => Json::Bool(false),
                    "null" => Json::Null,
                    _ => word.parse().map_or_else(|_| Json::Str(word.to_string()), Json::Num),
                }
            }
        };
        Node { json, start, end: self.pos, key: None }
    }

    fn word(&mut self) -> &str {
        let start = self.pos;
        while let Some(b) = self.peek() {
            if matches!(b, b',' | b'}' | b']' | b':' | b'"' | b'{' | b'[' | b' ' | b'\t' | b'\r' | b'\n') {
                break;
            }
            self.pos += 1;
        }
        &self.text[start..self.pos]
    }

    fn string(&mut self) -> String {
        self.pos += 1;
        let mut out = String::new();
        while let Some(c) = self.text[self.pos..].chars().next() {
            match c {
                '"' => {
                    self.pos += 1;
                    break;
                }
                '\n' => break,
                '\\' => {
                    self.pos += 1;
                    if let Some(e) = self.text[self.pos..].chars().next() {
                        self.pos += e.len_utf8();
                        out.push(match e {
                            'n' => '\n',
                            't' => '\t',
                            other => other,
                        });
                    }
                }
                _ => {
                    self.pos += c.len_utf8();
                    out.push(c);
                }
            }
        }
        out
    }

    fn object(&mut self, depth: usize) -> Json {
        self.pos += 1;
        let mut fields = Vec::new();
        loop {
            self.whitespace();
            match self.peek() {
                None => break,
                Some(b'}') => {
                    self.pos += 1;
                    break;
                }
                Some(b',') => {
                    self.pos += 1;
                    continue;
                }
                Some(b'{' | b'[' | b':') => {
                    self.pos += 1;
                    continue;
                }
                _ => {}
            }
            let key_start = self.pos;
            let name = if self.peek() == Some(b'"') { self.string() } else { self.word().to_string() };
            if self.pos == key_start {
                self.pos += 1;
                continue;
            }
            let key = Some((key_start, self.pos));
            self.whitespace();
            let value = if self.peek() == Some(b':') {
                self.pos += 1;
                self.whitespace();
                self.value(depth + 1)
            } else {
                self.empty()
            };
            fields.push((name, Node { key, ..value }));
        }
        Json::Object(fields)
    }

    fn array(&mut self, depth: usize) -> Json {
        self.pos += 1;
        let mut items = Vec::new();
        loop {
            self.whitespace();
            match self.peek() {
                None => break,
                Some(b']') => {
                    self.pos += 1;
                    break;
                }
                Some(b',') => {
                    self.pos += 1;
                    continue;
                }
                _ => {}
            }
            let before = self.pos;
            let item = self.value(depth + 1);
            if self.pos == before {
                self.pos += 1;
                continue;
            }
            items.push(item);
        }
        Json::Array(items)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `name key-span value-span` of each member.
    fn keys(node: &Node) -> Vec<String> {
        let Json::Object(fields) = &node.json else { panic!("an object") };
        fields.iter().map(|(k, v)| format!("{k} {:?} {:?}", v.key.unwrap(), (v.start, v.end))).collect()
    }

    #[test]
    fn partial_text_keeps_the_keys_and_values_typed_so_far() {
        let text = r#"{"condition": "random_chance", "cha"#;
        assert_eq!(keys(&parse_partial(text)), ["condition (1, 12) (14, 29)", "cha (31, 35) (35, 35)"]);
        let text = r#"{"a": , "b": tr"#;
        assert_eq!(keys(&parse_partial(text)), ["a (1, 4) (6, 6)", "b (8, 11) (13, 15)"]);
        let Json::Object(fields) = parse_partial(r##"{"values": ["stone", "#mine"##).json else { panic!() };
        let Json::Array(items) = &fields[0].1.json else { panic!() };
        assert!(matches!(&items[1].json, Json::Str(s) if s == "#mine"));
    }
}