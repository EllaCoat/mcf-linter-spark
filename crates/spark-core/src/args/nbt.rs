//! SNBT (`TagParser`) and NBT paths (`NbtPathArgument`) of Minecraft 1.20.4. From 1.21.5 the
//! SNBT is read by `snbt.rs` into the same tree.

use super::nbt_check::{self, Category, Target};
use super::{ArgCtx, ArgValue, snbt};
use crate::data::VersionData;
use crate::reader::{PResult, Reader, is_quote};

/// A parsed SNBT value with its file offsets.
#[derive(Clone, Debug, PartialEq)]
pub struct NbtNode {
    pub start: u32,
    pub end: u32,
    pub value: NbtValue,
}

#[derive(Clone, Debug, PartialEq)]
pub enum NbtValue {
    /// `raw_bool` is set when the source wrote `true` or `false`.
    Byte { value: i8, raw_bool: Option<bool> },
    Short(i16),
    Int(i32),
    Long(i64),
    Float(f32),
    Double(f64),
    /// `quote` is the quote character used in the source, if any.
    String { value: String, quote: Option<u8> },
    List(Vec<NbtNode>),
    ByteArray(Vec<NbtNode>),
    IntArray(Vec<NbtNode>),
    LongArray(Vec<NbtNode>),
    Compound(Vec<NbtEntry>),
}

impl NbtValue {
    /// `TagType.getPrettyName`, as used in vanilla's "Can't insert ..." messages.
    pub fn type_name(&self) -> &'static str {
        match self {
            NbtValue::Byte { .. } => "TAG_Byte",
            NbtValue::Short(_) => "TAG_Short",
            NbtValue::Int(_) => "TAG_Int",
            NbtValue::Long(_) => "TAG_Long",
            NbtValue::Float(_) => "TAG_Float",
            NbtValue::Double(_) => "TAG_Double",
            NbtValue::String { .. } => "TAG_String",
            NbtValue::List(_) => "TAG_List",
            NbtValue::ByteArray(_) => "TAG_Byte_Array",
            NbtValue::IntArray(_) => "TAG_Int_Array",
            NbtValue::LongArray(_) => "TAG_Long_Array",
            NbtValue::Compound(_) => "TAG_Compound",
        }
    }
}

/// One `key: value` pair. Duplicate keys are all kept, in source order.
#[derive(Clone, Debug, PartialEq)]
pub struct NbtEntry {
    pub key: String,
    pub key_quote: Option<u8>,
    pub key_start: u32,
    pub key_end: u32,
    pub value: NbtNode,
}

#[derive(Clone, Debug, PartialEq)]
pub enum NbtPathNode {
    /// `{...}` at the start of a path.
    MatchRoot(NbtNode),
    /// `name` or `"name"`, optionally followed by `{...}`. `start..end` covers
    /// the name token (with its quotes); the filter has its own offsets.
    Key { name: String, quote: Option<u8>, start: u32, end: u32, filter: Option<NbtNode> },
    /// `[3]` or `[-1]`; `start..end` includes the brackets.
    Index { index: i32, start: u32, end: u32 },
    /// `[]`.
    AllElements { start: u32, end: u32 },
    /// `[{...}]`; the node is the `{...}` inside the brackets.
    MatchElement(NbtNode),
}

/// Whether the version reads SNBT with the grammar of 1.21.5 (`snbt.rs`).
pub fn modern(data: &VersionData) -> bool {
    data.at_least(&[1, 21, 5])
}

pub const MAX_DEPTH: usize = 512;
pub const TOO_DEEP: &str = "Resulting NBT too deeply nested";

pub fn too_deep_to_check() -> String {
    format!("Stopped checking from here: the NBT is nested deeper than {MAX_DEPTH} levels")
}

/// `TagParser.readStruct`. Leading whitespace is skipped.
pub fn parse_compound(r: &mut Reader, modern: bool) -> PResult<NbtNode> {
    if modern { snbt::parse_compound(r) } else { read_struct(r, 0) }
}

/// `TagParser.readValue`. Leading whitespace is skipped.
pub fn parse_tag(r: &mut Reader, modern: bool) -> PResult<NbtNode> {
    if modern { snbt::parse_tag(r) } else { read_value(r, 0) }
}

/// `NbtPathArgument.parse`. Stops at a space or the end of the line.
pub fn parse_path(r: &mut Reader, modern: bool) -> PResult<Vec<NbtPathNode>> {
    let mut nodes = Vec::new();
    let mut first = true;
    while r.can_read() && r.peek() != Some(b' ') {
        nodes.push(parse_path_node(r, first, modern)?);
        first = false;
        if let Some(c) = r.peek()
            && !matches!(c, b' ' | b'[' | b'{')
        {
            r.expect(b'.')?;
        }
    }
    Ok(nodes)
}

fn parse_path_node(r: &mut Reader, first: bool, modern: bool) -> PResult<NbtPathNode> {
    let start = r.pos;
    match r.peek() {
        Some(q) if is_quote(q) => {
            let name = r.read_quoted()?;
            read_key_node(r, name, Some(q), start, modern)
        }
        Some(b'[') => {
            r.pos += 1;
            match r.peek() {
                Some(b'{') => {
                    let compound = parse_compound(r, modern)?;
                    r.expect(b']')?;
                    Ok(NbtPathNode::MatchElement(compound))
                }
                Some(b']') => {
                    r.pos += 1;
                    Ok(NbtPathNode::AllElements { start: r.offset_of(start), end: r.offset() })
                }
                _ => {
                    let index = r.read_int()?;
                    r.expect(b']')?;
                    Ok(NbtPathNode::Index { index, start: r.offset_of(start), end: r.offset() })
                }
            }
        }
        Some(b'{') => {
            if !first {
                return Err(r.error("Invalid NBT path element"));
            }
            Ok(NbtPathNode::MatchRoot(parse_compound(r, modern)?))
        }
        _ => {
            let name = read_unquoted_name(r)?;
            read_key_node(r, name, None, start, modern)
        }
    }
}

fn read_key_node(r: &mut Reader, name: String, quote: Option<u8>, start: usize, modern: bool) -> PResult<NbtPathNode> {
    let end = r.offset();
    let filter = if r.peek() == Some(b'{') { Some(parse_compound(r, modern)?) } else { None };
    Ok(NbtPathNode::Key { name, quote, start: r.offset_of(start), end, filter })
}

fn read_unquoted_name(r: &mut Reader) -> PResult<String> {
    let start = r.pos;
    while let Some(c) = r.peek_char() {
        if matches!(c, ' ' | '"' | '\'' | '[' | ']' | '.' | '{' | '}') {
            break;
        }
        r.pos += c.len_utf8();
    }
    if r.pos == start {
        return Err(r.error("Invalid NBT path element"));
    }
    Ok(r.src[start..r.pos].to_string())
}

/// Java's `Character.isWhitespace`, which `StringReader.skipWhitespace` uses.
pub(super) fn is_java_whitespace(c: char) -> bool {
    match c {
        '\u{85}' | '\u{a0}' | '\u{2007}' | '\u{202f}' => false,
        '\u{1c}'..='\u{1f}' => true,
        _ => c.is_whitespace(),
    }
}

fn skip_ws(r: &mut Reader) {
    while let Some(c) = r.peek_char() {
        if !is_java_whitespace(c) {
            break;
        }
        r.pos += c.len_utf8();
    }
}

fn expect(r: &mut Reader, b: u8) -> PResult<()> {
    skip_ws(r);
    r.expect(b)
}

fn finish(r: &Reader, start: usize, value: NbtValue) -> NbtNode {
    NbtNode { start: r.offset_of(start), end: r.offset(), value }
}

fn has_element_separator(r: &mut Reader) -> bool {
    skip_ws(r);
    if r.peek() == Some(b',') {
        r.pos += 1;
        skip_ws(r);
        true
    } else {
        false
    }
}

fn read_value(r: &mut Reader, depth: usize) -> PResult<NbtNode> {
    skip_ws(r);
    match r.peek() {
        None => Err(r.error("Expected value")),
        Some(b'{' | b'[') if depth >= MAX_DEPTH => Err(r.error(too_deep_to_check()).warning()),
        Some(b'{') => read_struct(r, depth),
        Some(b'[') => read_list(r, depth),
        Some(_) => read_typed_value(r),
    }
}

fn read_struct(r: &mut Reader, depth: usize) -> PResult<NbtNode> {
    skip_ws(r);
    let start = r.pos;
    r.expect(b'{')?;
    skip_ws(r);
    let mut entries = Vec::new();
    while r.can_read() && r.peek() != Some(b'}') {
        let key_pos = r.pos;
        let (key, key_quote) = read_key(r)?;
        let key_end = r.offset();
        expect(r, b':')?;
        let value = read_value(r, depth + 1)?;
        entries.push(NbtEntry { key, key_quote, key_start: r.offset_of(key_pos), key_end, value });
        if !has_element_separator(r) {
            break;
        }
        if !r.can_read() {
            return Err(r.error("Expected key"));
        }
    }
    expect(r, b'}')?;
    Ok(finish(r, start, NbtValue::Compound(entries)))
}

fn read_key(r: &mut Reader) -> PResult<(String, Option<u8>)> {
    skip_ws(r);
    if !r.can_read() {
        return Err(r.error("Expected key"));
    }
    let start = r.pos;
    let (key, quote) = r.read_string()?;
    if key.is_empty() {
        r.pos = start;
        return Err(r.error("Expected key"));
    }
    Ok((key, quote))
}

fn read_typed_value(r: &mut Reader) -> PResult<NbtNode> {
    let start = r.pos;
    if let Some(q) = r.peek().filter(|b| is_quote(*b)) {
        let value = r.read_quoted()?;
        return Ok(finish(r, start, NbtValue::String { value, quote: Some(q) }));
    }
    let text = r.read_unquoted();
    if text.is_empty() {
        return Err(r.error("Expected value"));
    }
    Ok(finish(r, start, classify(text)))
}

fn read_list(r: &mut Reader, depth: usize) -> PResult<NbtNode> {
    let mut ahead = r.rest().chars().skip(1);
    match (ahead.next(), ahead.next()) {
        (Some(kind), Some(';')) if !matches!(kind, '"' | '\'') => read_array_tag(r, kind, depth),
        _ => read_list_tag(r, depth),
    }
}

fn read_list_tag(r: &mut Reader, depth: usize) -> PResult<NbtNode> {
    let start = r.pos;
    r.pos += 1;
    skip_ws(r);
    if !r.can_read() {
        return Err(r.error("Expected value"));
    }
    let mut items: Vec<NbtNode> = Vec::new();
    while r.peek() != Some(b']') {
        let item_pos = r.pos;
        let item = read_value(r, depth + 1)?;
        if let Some(first) = items.first()
            && first.value.type_name() != item.value.type_name()
        {
            let message = format!("Can't insert {} into list of {}", item.value.type_name(), first.value.type_name());
            return Err(r.error_span(item_pos, message));
        }
        items.push(item);
        if !has_element_separator(r) {
            break;
        }
        if !r.can_read() {
            return Err(r.error("Expected value"));
        }
    }
    expect(r, b']')?;
    Ok(finish(r, start, NbtValue::List(items)))
}

fn read_array_tag(r: &mut Reader, kind: char, depth: usize) -> PResult<NbtNode> {
    let start = r.pos;
    r.pos += 1;
    let kind_pos = r.pos;
    r.skip();
    r.skip();
    skip_ws(r);
    if !r.can_read() {
        return Err(r.error("Expected value"));
    }
    type Wrap = fn(Vec<NbtNode>) -> NbtValue;
    let (array_name, element_name, wrap): (&str, &str, Wrap) = match kind {
        'B' => ("TAG_Byte_Array", "TAG_Byte", NbtValue::ByteArray),
        'I' => ("TAG_Int_Array", "TAG_Int", NbtValue::IntArray),
        'L' => ("TAG_Long_Array", "TAG_Long", NbtValue::LongArray),
        _ => {
            r.pos = kind_pos;
            return Err(r.error(format!("Invalid array type '{kind}'")));
        }
    };
    let mut items = Vec::new();
    while r.peek() != Some(b']') {
        let item_pos = r.pos;
        let item = read_value(r, depth + 1)?;
        if item.value.type_name() != element_name {
            let message = format!("Can't insert {} into {array_name}", item.value.type_name());
            return Err(r.error_span(item_pos, message));
        }
        items.push(item);
        if !has_element_separator(r) {
            break;
        }
        if !r.can_read() {
            return Err(r.error("Expected value"));
        }
    }
    expect(r, b']')?;
    Ok(finish(r, start, wrap(items)))
}

/// `TagParser.type`: a number if the unquoted text matches one of the number
/// patterns and fits its type, `true`/`false` as a byte, otherwise a string.
fn classify(text: &str) -> NbtValue {
    let string = || NbtValue::String { value: text.to_string(), quote: None };
    let Some(last) = text.bytes().last() else { return string() };
    let body = &text[..text.len() - 1];
    match last.to_ascii_lowercase() {
        b'f' if is_decimal(body, false) => body.parse().map_or_else(|_| string(), NbtValue::Float),
        b'd' if is_decimal(body, false) => body.parse().map_or_else(|_| string(), NbtValue::Double),
        b'b' if is_integer(body) => {
            body.parse().map_or_else(|_| string(), |value| NbtValue::Byte { value, raw_bool: None })
        }
        b'l' if is_integer(body) => body.parse().map_or_else(|_| string(), NbtValue::Long),
        b's' if is_integer(body) => body.parse().map_or_else(|_| string(), NbtValue::Short),
        _ if is_integer(text) => text.parse().map_or_else(|_| string(), NbtValue::Int),
        _ if is_decimal(text, true) => text.parse().map_or_else(|_| string(), NbtValue::Double),
        _ if text.eq_ignore_ascii_case("true") => NbtValue::Byte { value: 1, raw_bool: Some(true) },
        _ if text.eq_ignore_ascii_case("false") => NbtValue::Byte { value: 0, raw_bool: Some(false) },
        _ => string(),
    }
}

fn strip_sign(s: &str) -> &str {
    s.strip_prefix(['-', '+']).unwrap_or(s)
}

/// `[-+]?(?:0|[1-9][0-9]*)`
fn is_integer(s: &str) -> bool {
    match strip_sign(s).as_bytes() {
        [b'0'] => true,
        [b'1'..=b'9', rest @ ..] => rest.iter().all(u8::is_ascii_digit),
        _ => false,
    }
}

/// `[-+]?(?:[0-9]+[.]?|[0-9]*[.][0-9]+)(?:e[-+]?[0-9]+)?`, or with the dot
/// required (`[0-9]+[.]|[0-9]*[.][0-9]+`) when `dot_required` is set.
fn is_decimal(s: &str, dot_required: bool) -> bool {
    let all_digits = |t: &str| t.bytes().all(|b| b.is_ascii_digit());
    let (mantissa, exponent) = match strip_sign(s).split_once(['e', 'E']) {
        Some((m, e)) => (m, Some(strip_sign(e))),
        None => (strip_sign(s), None),
    };
    if exponent.is_some_and(|e| e.is_empty() || !all_digits(e)) {
        return false;
    }
    match mantissa.split_once('.') {
        Some((int, frac)) => all_digits(int) && all_digits(frac) && !(int.is_empty() && frac.is_empty()),
        None => !dot_required && !mantissa.is_empty() && all_digits(mantissa),
    }
}

pub(super) fn check(cx: &mut ArgCtx, node: &NbtNode, target: Option<&Target>) {
    let effects = nbt_check::check_value(cx.data, cx.config, node, target);
    cx.effects.extend(effects);
}

/// The entity type of the last entity argument (`@a` is a player, otherwise the selector's `type=`).
fn entity_id(cx: &ArgCtx) -> Option<String> {
    cx.values
        .iter()
        .rev()
        .find_map(|v| match v {
            ArgValue::Entity(id) => Some(id.clone()),
            _ => None,
        })
        .flatten()
}

/// The schema of a `minecraft:nbt_compound_tag` argument, from the command it is in.
pub(crate) fn compound_target(cx: &ArgCtx) -> Option<Target> {
    let names: Vec<&str> = cx.path.iter().map(|n| n.name).collect();
    match names.as_slice() {
        ["summon", ..] => {
            let id = cx.values.iter().rev().find_map(|v| match v {
                ArgValue::Id(id) => Some(id.clone()),
                _ => None,
            });
            Some(Target { whole: true, ..Target::new(Category::Entity, id) })
        }
        ["data", "merge", "entity", ..] => Some(Target::new(Category::Entity, entity_id(cx))),
        _ => None,
    }
}

/// The schema of a `minecraft:nbt_path` argument: the holder named right before it.
pub(crate) fn path_target(cx: &ArgCtx) -> Option<Target> {
    match cx.prev_literal() {
        Some("entity") => Some(Target::new(Category::Entity, entity_id(cx))),
        Some("block") => Some(Target::new(Category::Block, None)),
        _ => None,
    }
}

/// The `minecraft:nbt_compound_tag` argument.
pub fn compound_argument(r: &mut Reader, cx: &mut ArgCtx) -> PResult<()> {
    let node = parse_compound(r, modern(cx.data))?;
    let target = compound_target(cx);
    check(cx, &node, target.as_ref());
    Ok(())
}

/// The `minecraft:nbt_tag` argument. With a `spyglass.json`, the tag of `data
/// modify <entity|block> ... value` has a schema (see `nbt_check::check_modify_value`);
/// DHP never types it.
pub fn tag_argument(r: &mut Reader, cx: &mut ArgCtx) -> PResult<()> {
    let node = parse_tag(r, modern(cx.data))?;
    match modify_value_target(cx).filter(|_| cx.config.spyglass) {
        Some((target, element, path)) => {
            let effects = nbt_check::check_modify_value(cx.data, cx.config, &path, &target, element, &node);
            cx.effects.extend(effects);
        }
        None => check(cx, &node, None),
    }
    Ok(())
}

/// For the tag of `data modify <entity|block> <target> <path> <op> value`: the
/// holder's schema, whether the tag is a list element, and the target path.
fn modify_value_target(cx: &ArgCtx) -> Option<(Target, bool, Vec<NbtPathNode>)> {
    let names: Vec<&str> = cx.path.iter().map(|n| n.name).collect();
    let ["data", "modify", holder, _, "targetPath", op, .., "value"] = names.as_slice() else { return None };
    let target = match *holder {
        "entity" => Target::new(Category::Entity, entity_id(cx)),
        "block" => Target::new(Category::Block, None),
        _ => return None,
    };
    let target = Target { whole: *op != "merge", ..target };
    let path = cx.values.iter().rev().find_map(|v| match v {
        ArgValue::Path(p) => Some(p.clone()),
        _ => None,
    })?;
    Some((target, matches!(*op, "append" | "prepend" | "insert"), path))
}

/// The `minecraft:nbt_path` argument.
pub fn path_argument(r: &mut Reader, cx: &mut ArgCtx) -> PResult<()> {
    let nodes = parse_path(r, modern(cx.data))?;
    let target = path_target(cx);
    let effects = nbt_check::check_path(cx.data, cx.config, &nodes, target.as_ref());
    cx.effects.extend(effects);
    cx.values.push(ArgValue::Path(nodes));
    Ok(())
}

/// A compound inside another argument (selector `nbt=`, block and item NBT).
pub fn compound_value(r: &mut Reader, cx: &mut ArgCtx, target: Option<&Target>) -> PResult<()> {
    if r.peek() != Some(b'{') {
        return Err(r.error("Expected '{'"));
    }
    let node = parse_compound(r, modern(cx.data))?;
    check(cx, &node, target);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tag(src: &str) -> PResult<NbtNode> {
        parse_tag(&mut Reader::new(src, 0), false)
    }

    fn value(src: &str) -> NbtValue {
        tag(src).unwrap_or_else(|e| panic!("{src}: {}", e.message)).value
    }

    fn error(src: &str) -> (u32, u32, String) {
        let e = tag(src).expect_err(src);
        (e.start, e.end, e.message)
    }

    fn path(src: &str) -> PResult<Vec<NbtPathNode>> {
        parse_path(&mut Reader::new(src, 0), false)
    }

    fn path_error(src: &str) -> (u32, String) {
        let e = path(src).expect_err(src);
        (e.start, e.message)
    }

    fn string(value: &str, quote: Option<u8>) -> NbtValue {
        NbtValue::String { value: value.to_string(), quote }
    }

    fn byte(value: i8) -> NbtValue {
        NbtValue::Byte { value, raw_bool: None }
    }

    fn int_node(start: u32, end: u32, value: i32) -> NbtNode {
        NbtNode { start, end, value: NbtValue::Int(value) }
    }

    #[test]
    fn compound_with_offsets() {
        let mut r = Reader::new(r#"{a:1b,"b":'x',c:[1,2]} tail"#, 100);
        let node = parse_compound(&mut r, false).unwrap();
        assert_eq!(r.rest(), " tail");
        assert_eq!((node.start, node.end), (100, 122));
        let NbtValue::Compound(entries) = node.value else { panic!() };
        assert_eq!(entries.len(), 3);

        assert_eq!((entries[0].key.as_str(), entries[0].key_quote), ("a", None));
        assert_eq!((entries[0].key_start, entries[0].key_end), (101, 102));
        assert_eq!(entries[0].value, NbtNode { start: 103, end: 105, value: byte(1) });

        assert_eq!((entries[1].key.as_str(), entries[1].key_quote), ("b", Some(b'"')));
        assert_eq!((entries[1].key_start, entries[1].key_end), (106, 109));
        assert_eq!(entries[1].value, NbtNode { start: 110, end: 113, value: string("x", Some(b'\'')) });

        assert_eq!((entries[2].key.as_str(), entries[2].key_quote), ("c", None));
        let expected = NbtValue::List(vec![int_node(117, 118, 1), int_node(119, 120, 2)]);
        assert_eq!(entries[2].value, NbtNode { start: 116, end: 121, value: expected });
    }

    #[test]
    fn empty_compound_and_nesting() {
        assert_eq!(value("{}"), NbtValue::Compound(vec![]));
        let NbtValue::Compound(outer) = value("{a:{b:{}}}") else { panic!() };
        let NbtValue::Compound(inner) = &outer[0].value.value else { panic!() };
        assert_eq!(inner[0].key, "b");
        assert_eq!(inner[0].value.value, NbtValue::Compound(vec![]));
    }

    #[test]
    fn whitespace_and_trailing_commas() {
        let mut r = Reader::new("  { a : 1 , b : [ 1 , 2 , ] , }  x", 0);
        let node = parse_compound(&mut r, false).unwrap();
        assert_eq!((node.start, node.end), (2, 31));
        assert_eq!(r.rest(), "  x");
        let NbtValue::Compound(entries) = node.value else { panic!() };
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].value.value, NbtValue::Int(1));
        assert!(matches!(&entries[1].value.value, NbtValue::List(items) if items.len() == 2));
        assert_eq!(value("\t[\n1,\n2\n]"), NbtValue::List(vec![int_node(3, 4, 1), int_node(6, 7, 2)]));
    }

    #[test]
    fn non_breaking_space_is_not_whitespace() {
        assert_eq!(error("{a:\u{a0}1}"), (3, 5, "Expected value".to_string()));
        assert_eq!(value("{a:\u{3000}1}"), NbtValue::Compound(vec![NbtEntry {
            key: "a".into(),
            key_quote: None,
            key_start: 1,
            key_end: 2,
            value: int_node(6, 7, 1),
        }]));
    }

    #[test]
    fn number_types_and_suffixes() {
        let cases: Vec<(&str, NbtValue)> = vec![
            ("1b", byte(1)),
            ("-1B", byte(-1)),
            ("+7b", byte(7)),
            ("127b", byte(127)),
            ("1s", NbtValue::Short(1)),
            ("-32768S", NbtValue::Short(-32768)),
            ("0", NbtValue::Int(0)),
            ("-0", NbtValue::Int(0)),
            ("-5", NbtValue::Int(-5)),
            ("+5", NbtValue::Int(5)),
            ("2147483647", NbtValue::Int(i32::MAX)),
            ("1l", NbtValue::Long(1)),
            ("-9223372036854775808L", NbtValue::Long(i64::MIN)),
            ("1.5", NbtValue::Double(1.5)),
            (".5", NbtValue::Double(0.5)),
            ("5.", NbtValue::Double(5.0)),
            ("-1.5e2", NbtValue::Double(-150.0)),
            ("1.5E-1", NbtValue::Double(0.15)),
            ("1.e2", NbtValue::Double(100.0)),
            ("1d", NbtValue::Double(1.0)),
            ("1D", NbtValue::Double(1.0)),
            ("1.d", NbtValue::Double(1.0)),
            (".5d", NbtValue::Double(0.5)),
            ("1e5d", NbtValue::Double(100000.0)),
            ("1f", NbtValue::Float(1.0)),
            ("1.5F", NbtValue::Float(1.5)),
            ("-.5f", NbtValue::Float(-0.5)),
            ("1e5f", NbtValue::Float(100000.0)),
            ("1e999f", NbtValue::Float(f32::INFINITY)),
        ];
        for (text, expected) in cases {
            assert_eq!(value(text), expected, "{text}");
        }
    }

    #[test]
    fn number_looking_text_is_a_string() {
        for text in [
            "128b", "-129b", "32768s", "2147483648", "9223372036854775808l", "01", "00b", "007", "1e5", "1e", "e5", "1.5b",
            "1.5l", "1.5s", "1.5.5", "1.5.5f", "-", "+", ".", "-.", ".f", "f", "b", "1-2", "--1", "+-1", "1_000", "1e+f",
            "1e5.5", "abc", "1x", "0x10", "NaN", "Infinity", "truee", "1ff",
        ] {
            assert_eq!(value(text), string(text, None), "{text}");
        }
    }

    #[test]
    fn true_and_false_are_bytes() {
        let bool_byte = |value, raw| NbtValue::Byte { value, raw_bool: Some(raw) };
        assert_eq!(value("true"), bool_byte(1, true));
        assert_eq!(value("false"), bool_byte(0, false));
        assert_eq!(value("TRUE"), bool_byte(1, true));
        assert_eq!(value("False"), bool_byte(0, false));
        assert_eq!(value("1b"), NbtValue::Byte { value: 1, raw_bool: None });
        assert_eq!(value("\"true\""), string("true", Some(b'"')));
        assert_eq!(value("tru"), string("tru", None));
    }

    #[test]
    fn quoted_strings() {
        assert_eq!(value(r#""a\"b\\c""#), string(r#"a"b\c"#, Some(b'"')));
        assert_eq!(value(r#"'a"b'"#), string("a\"b", Some(b'\'')));
        assert_eq!(value(r#"'it\'s'"#), string("it's", Some(b'\'')));
        assert_eq!(value(r#""1b""#), string("1b", Some(b'"')));
        assert_eq!(value(r#""""#), string("", Some(b'"')));
    }

    #[test]
    fn unquoted_value_stops_at_disallowed_characters() {
        let mut r = Reader::new("foo:bar", 0);
        let node = parse_tag(&mut r, false).unwrap();
        assert_eq!(node.value, string("foo", None));
        assert_eq!(r.rest(), ":bar");

        let mut r = Reader::new("12 rest", 0);
        assert_eq!(parse_tag(&mut r, false).unwrap().value, NbtValue::Int(12));
        assert_eq!(r.rest(), " rest");
    }

    #[test]
    fn quoted_keys_and_escapes_in_keys() {
        let NbtValue::Compound(entries) = value(r#"{"a b":1,'c\'d':2,1.5:3,-x:4}"#) else { panic!() };
        let keys: Vec<_> = entries.iter().map(|e| (e.key.as_str(), e.key_quote)).collect();
        assert_eq!(keys, [("a b", Some(b'"')), ("c'd", Some(b'\'')), ("1.5", None), ("-x", None)]);
        assert_eq!((entries[0].key_start, entries[0].key_end), (1, 6));
    }

    #[test]
    fn duplicate_keys_are_kept() {
        let NbtValue::Compound(entries) = value("{a:1,a:2}") else { panic!() };
        assert_eq!(entries.len(), 2);
    }

    #[test]
    fn lists() {
        assert_eq!(value("[]"), NbtValue::List(vec![]));
        assert_eq!(value("[ ]"), NbtValue::List(vec![]));
        assert_eq!(value("[1,2,3]"), NbtValue::List(vec![int_node(1, 2, 1), int_node(3, 4, 2), int_node(5, 6, 3)]));
        assert!(matches!(value("[true,1b,false]"), NbtValue::List(items) if items.len() == 3));
        assert!(matches!(value("[[1],['a']]"), NbtValue::List(items) if items.len() == 2));
        assert!(matches!(value("[{a:1},{b:'x'}]"), NbtValue::List(items) if items.len() == 2));
        assert!(matches!(value("[ 'a' , \"b\" , c ]"), NbtValue::List(items) if items.len() == 3));
        // the array form needs `;` right after the type character
        assert_eq!(error("[ B;1]"), (3, 4, "Expected ']'".to_string()));
    }

    #[test]
    fn mixed_list_is_an_error() {
        assert_eq!(error("[1,2L]"), (3, 5, "Can't insert TAG_Long into list of TAG_Int".to_string()));
        assert_eq!(error("[1, 1.0]"), (4, 7, "Can't insert TAG_Double into list of TAG_Int".to_string()));
        assert_eq!(error("[1b,1]").2, "Can't insert TAG_Int into list of TAG_Byte");
        assert_eq!(error("['a',1]").2, "Can't insert TAG_Int into list of TAG_String");
        assert_eq!(error("[{},[]]").2, "Can't insert TAG_List into list of TAG_Compound");
        assert_eq!(error("[a,1b,2]").2, "Can't insert TAG_Byte into list of TAG_String");
    }

    #[test]
    fn typed_arrays() {
        assert_eq!(
            value("[B;1b,true]"),
            NbtValue::ByteArray(vec![
                NbtNode { start: 3, end: 5, value: byte(1) },
                NbtNode { start: 6, end: 10, value: NbtValue::Byte { value: 1, raw_bool: Some(true) } },
            ])
        );
        assert_eq!(value("[I;1,-2]"), NbtValue::IntArray(vec![int_node(3, 4, 1), int_node(5, 7, -2)]));
        assert_eq!(
            value("[L; 1L , 2l ]"),
            NbtValue::LongArray(vec![
                NbtNode { start: 4, end: 6, value: NbtValue::Long(1) },
                NbtNode { start: 9, end: 11, value: NbtValue::Long(2) },
            ])
        );
        assert_eq!(value("[B;]"), NbtValue::ByteArray(vec![]));
        assert_eq!(value("[I;]"), NbtValue::IntArray(vec![]));
        assert_eq!(value("[L;1l,]"), NbtValue::LongArray(vec![NbtNode { start: 3, end: 5, value: NbtValue::Long(1) }]));
        let node = tag("[I;1,2]").unwrap();
        assert_eq!((node.start, node.end), (0, 7));
    }

    #[test]
    fn typed_array_errors() {
        assert_eq!(error("[B;1]"), (3, 4, "Can't insert TAG_Int into TAG_Byte_Array".to_string()));
        assert_eq!(error("[I;1b]").2, "Can't insert TAG_Byte into TAG_Int_Array");
        assert_eq!(error("[L;1]").2, "Can't insert TAG_Int into TAG_Long_Array");
        assert_eq!(error("[I;\"a\"]").2, "Can't insert TAG_String into TAG_Int_Array");
        assert_eq!(error("[I;[1]]").2, "Can't insert TAG_List into TAG_Int_Array");
        assert_eq!(error("[X;1]"), (1, 2, "Invalid array type 'X'".to_string()));
        assert_eq!(error("[b;1b]").2, "Invalid array type 'b'");
        assert_eq!(error("[X;").2, "Expected value");
        assert_eq!(error("[I;1 2]").2, "Expected ']'");
    }

    #[test]
    fn quoted_second_character_makes_a_list() {
        assert_eq!(error("[a;]"), (1, 2, "Invalid array type 'a'".to_string()));
        assert_eq!(error("[\"a\";]"), (4, 5, "Expected ']'".to_string()));
    }

    #[test]
    fn syntax_errors() {
        assert_eq!(error(""), (0, 0, "Expected value".to_string()));
        assert_eq!(error("  "), (2, 2, "Expected value".to_string()));
        assert_eq!(error("@s"), (0, 1, "Expected value".to_string()));
        assert_eq!(error("{a:}"), (3, 4, "Expected value".to_string()));
        assert_eq!(error("{a:@}").2, "Expected value");
        assert_eq!(error("{:1}"), (1, 2, "Expected key".to_string()));
        assert_eq!(error("{\"\":1}").2, "Expected key");
        assert_eq!(error("{a:1,").2, "Expected key");
        assert_eq!(error("{a:1,b").2, "Expected ':'");
        assert_eq!(error("{a 1}"), (3, 4, "Expected ':'".to_string()));
        assert_eq!(error("{a:1 b:2}"), (5, 6, "Expected '}'".to_string()));
        assert_eq!(error("{a:1"), (4, 4, "Expected '}'".to_string()));
        assert_eq!(error("{"), (1, 1, "Expected '}'".to_string()));
        assert_eq!(error("[1,").2, "Expected value");
        assert_eq!(error("[").2, "Expected value");
        assert_eq!(error("[1 2]"), (3, 4, "Expected ']'".to_string()));
        assert_eq!(error("[1").2, "Expected ']'");
        assert_eq!(error("{a:1]").2, "Expected '}'");
        assert_eq!(error("{a:[1}").2, "Expected ']'");
        assert_eq!(error("{\"a:1}").2, "Unclosed quoted string");
        assert_eq!(error("{a:\"x\\n\"}").2, "Invalid escape sequence 'n' in quoted string");
    }

    #[test]
    fn compound_must_start_with_brace() {
        let e = parse_compound(&mut Reader::new("[1]", 0), false).unwrap_err();
        assert_eq!((e.start, e.message.as_str()), (0, "Expected '{'"));
        assert!(parse_compound(&mut Reader::new(" {a:1}", 0), false).is_ok());
    }

    fn key(name: &str, quote: Option<u8>, start: u32, end: u32) -> NbtPathNode {
        NbtPathNode::Key { name: name.into(), quote, start, end, filter: None }
    }

    #[test]
    fn path_keys_and_indexes() {
        assert_eq!(
            path("foo.bar[0].baz[-1]").unwrap(),
            vec![
                key("foo", None, 0, 3),
                key("bar", None, 4, 7),
                NbtPathNode::Index { index: 0, start: 7, end: 10 },
                key("baz", None, 11, 14),
                NbtPathNode::Index { index: -1, start: 14, end: 18 },
            ]
        );
        assert_eq!(path("[]").unwrap(), vec![NbtPathNode::AllElements { start: 0, end: 2 }]);
        assert_eq!(path("a[][1]").unwrap().len(), 3);
        assert_eq!(path("[0][1]").unwrap().len(), 2);
        assert_eq!(path("'x y'.\"z\"").unwrap(), vec![key("x y", Some(b'\''), 0, 5), key("z", Some(b'"'), 6, 9)]);
        assert_eq!(path("minecraft:foo.a-b+c@d").unwrap(), vec![key("minecraft:foo", None, 0, 13), key("a-b+c@d", None, 14, 21)]);
        assert_eq!(path("").unwrap(), vec![]);
    }

    #[test]
    fn path_filters() {
        let nodes = path("{a:1}.foo").unwrap();
        assert_eq!(nodes.len(), 2);
        assert!(matches!(&nodes[0], NbtPathNode::MatchRoot(n) if (n.start, n.end) == (0, 5)));
        assert_eq!(nodes[1], key("foo", None, 6, 9));

        let nodes = path("foo{a:1}.bar").unwrap();
        let NbtPathNode::Key { name, start, end, filter, .. } = &nodes[0] else { panic!() };
        assert_eq!((name.as_str(), *start, *end), ("foo", 0, 3));
        assert_eq!(filter.as_ref().map(|n| (n.start, n.end)), Some((3, 8)));
        assert_eq!(nodes[1], key("bar", None, 9, 12));

        let nodes = path("Items[{id:\"a\",Count:1b}].tag").unwrap();
        assert_eq!(nodes.len(), 3);
        assert!(matches!(&nodes[1], NbtPathNode::MatchElement(n) if (n.start, n.end) == (6, 23)));

        let nodes = path("\"a\"{b:1}").unwrap();
        assert!(matches!(&nodes[0], NbtPathNode::Key { quote: Some(b'"'), filter: Some(_), .. }));

        let nodes = path("{a:1}[0]").unwrap();
        assert_eq!(nodes.len(), 2);

        let nodes = path("a{x: 1, y: [1, 2]}.b").unwrap();
        assert_eq!(nodes.len(), 2);
    }

    #[test]
    fn path_stops_at_a_space() {
        let mut r = Reader::new("foo.bar rest", 0);
        assert_eq!(parse_path(&mut r, false).unwrap().len(), 2);
        assert_eq!(r.rest(), " rest");
        // vanilla accepts a trailing dot
        assert_eq!(path("foo.").unwrap(), vec![key("foo", None, 0, 3)]);
    }

    #[test]
    fn path_errors() {
        assert_eq!(path_error("foo..bar"), (4, "Invalid NBT path element".into()));
        assert_eq!(path_error("foo.]"), (4, "Invalid NBT path element".into()));
        assert_eq!(path_error("foo.{a:1}"), (4, "Invalid NBT path element".into()));
        assert_eq!(path_error("foo{a:1}{b:2}"), (8, "Invalid NBT path element".into()));
        assert_eq!(path_error("[0]{a:1}"), (3, "Invalid NBT path element".into()));
        assert_eq!(path_error("}"), (0, "Invalid NBT path element".into()));
        assert_eq!(path_error("foo]"), (3, "Expected '.'".into()));
        assert_eq!(path_error("{a:1}foo"), (5, "Expected '.'".into()));
        assert_eq!(path_error("\"a\"b"), (3, "Expected '.'".into()));
        assert_eq!(path_error("foo[").1, "Expected integer");
        assert_eq!(path_error("foo[x]"), (4, "Expected integer".into()));
        assert_eq!(path_error("foo[ 0]").1, "Expected integer");
        assert_eq!(path_error("foo[1").1, "Expected ']'");
        assert_eq!(path_error("foo[1.5]").1, "Invalid integer '1.5'");
        assert_eq!(path_error("foo[99999999999]").1, "Invalid integer '99999999999'");
        assert_eq!(path_error("foo[{a:1} ]"), (9, "Expected ']'".into()));
        assert_eq!(path_error("foo[{a:1}").1, "Expected ']'");
        assert_eq!(path_error("foo{a:").1, "Expected value");
        assert_eq!(path_error("\"foo").1, "Unclosed quoted string");
    }
}
