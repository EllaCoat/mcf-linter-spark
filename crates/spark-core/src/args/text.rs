//! JSON text components (`minecraft:component`) and styles (`minecraft:style`).
//!
//! 1.20.4 reads one value with Gson's strict `JsonReader` (`ParserUtils.parseJson`)
//! and decodes it with `ComponentSerialization.CODEC` / `Style.Serializer.CODEC`
//! over DFU's `JsonOps`. This module does the same in two stages: `parse_value`
//! follows Gson's syntax and keeps spans, `Checker` applies the codec rules and
//! reports the references inside the component.

use super::{ArgCtx, basic, entity, read_resource_location};
use crate::diag::{ParseError, Severity};
use crate::facts::kind;
use crate::json::{Json, Node, parse_value};
use crate::reader::{PResult, Reader};

pub fn component(r: &mut Reader, cx: &mut ArgCtx) -> PResult<()> {
    run(r, cx, "chat component", |ck, node| ck.component(node))
}

pub fn style(r: &mut Reader, cx: &mut ArgCtx) -> PResult<()> {
    run(r, cx, "style", |ck, node| match &node.json {
        Json::Object(fields) => ck.style_fields(fields),
        _ => fail(node, "Not a JSON object"),
    })
}

fn run(r: &mut Reader, cx: &mut ArgCtx, what: &str, check: impl FnOnce(&mut Checker, &Node) -> Check) -> PResult<()> {
    let node = parse_value(r, 0).map_err(|mut e| {
        e.message = format!("Invalid {what}: {}", e.message);
        e
    })?;
    let mut checker = Checker { cx, base: r.base };
    check(&mut checker, &node).map_err(|f| {
        ParseError::new(r.offset_of(f.start), r.offset_of(f.end), format!("Invalid {what}: {}", f.message))
    })
}


struct Fail {
    start: usize,
    end: usize,
    message: String,
}

type Check = Result<(), Fail>;
type Fields = [(String, Node)];

/// A container is marked at its first character; a long span adds nothing.
fn fail_at(node: &Node, message: impl Into<String>) -> Fail {
    let end = match node.json {
        Json::Array(_) | Json::Object(_) => node.start + 1,
        _ => node.end,
    };
    Fail { start: node.start, end, message: message.into() }
}

fn fail<T>(node: &Node, message: impl Into<String>) -> Result<T, Fail> {
    Err(fail_at(node, message))
}

/// A key counts as absent when it is missing or `null`; the last duplicate wins.
fn get<'n>(fields: &'n Fields, key: &str) -> Option<&'n Node> {
    fields.iter().rev().find(|(k, _)| k == key).map(|(_, n)| n).filter(|n| !matches!(n.json, Json::Null))
}

fn required<'n>(node: &Node, fields: &'n Fields, key: &str) -> Result<&'n Node, Fail> {
    get(fields, key).ok_or_else(|| fail_at(node, format!("No key {key}")))
}

/// `Codec.STRING` on `JsonOps` accepts only JSON strings.
fn string(node: &Node) -> Result<&str, Fail> {
    match &node.json {
        Json::Str(s) => Ok(s),
        _ => fail(node, "Not a string"),
    }
}

fn string_field<'n>(node: &Node, fields: &'n Fields, key: &str) -> Result<(&'n str, &'n Node), Fail> {
    let value = required(node, fields, key)?;
    Ok((string(value)?, value))
}

/// `Codec.BOOL` and `Codec.INT` also take numbers and booleans from each other.
fn is_bool_or_number(node: &Node) -> bool {
    matches!(node.json, Json::Bool(_) | Json::Num(_))
}

fn is_resource_location(s: &str) -> bool {
    let mut r = Reader::new(s, 0);
    read_resource_location(&mut r).is_ok() && !r.can_read()
}

fn resource_location(node: &Node) -> Check {
    let s = string(node)?;
    if is_resource_location(s) { Ok(()) } else { fail(node, format!("Not a valid resource location: {s}")) }
}

fn color(node: &Node) -> Check {
    let s = string(node)?;
    let valid = match s.strip_prefix('#') {
        Some(hex) => i64::from_str_radix(hex, 16).is_ok_and(|v| (0..=0xFF_FFFF).contains(&v)),
        None => s != "reset" && basic::COLORS.contains(&s),
    };
    if valid { Ok(()) } else { fail(node, format!("Invalid color: {s}")) }
}

fn click_event(node: &Node) -> Check {
    let Json::Object(fields) = &node.json else {
        return fail(node, "Not a JSON object");
    };
    let action = required(node, fields, "action")?;
    match string(action)? {
        "open_url" | "run_command" | "suggest_command" | "change_page" | "copy_to_clipboard" => {}
        "open_file" => return fail(action, "Action not allowed: open_file"),
        other => return fail(action, format!("Unknown element name:{other}")),
    }
    string_field(node, fields, "value").map(drop)
}

/// `UUID.fromString` takes five dash-separated hex numbers, each fitting a long.
fn is_java_uuid(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    s.chars().count() <= 36 && parts.len() == 5 && parts.iter().all(|p| i64::from_str_radix(p, 16).is_ok())
}

fn uuid(node: &Node) -> Check {
    match &node.json {
        Json::Array(items) if items.len() == 4 && items.iter().all(is_bool_or_number) => Ok(()),
        Json::Str(s) if is_java_uuid(s) => Ok(()),
        Json::Str(s) => fail(node, format!("Invalid UUID {s}")),
        _ => fail(node, "Not a UUID"),
    }
}

/// The `tag` string is SNBT; the NBT parsers are responsible for its contents.
fn item_info(node: &Node) -> Check {
    match &node.json {
        Json::Str(_) => resource_location(node),
        Json::Object(fields) => {
            resource_location(required(node, fields, "id")?)?;
            if let Some(count) = get(fields, "count")
                && !is_bool_or_number(count)
            {
                return fail(count, "Not a number");
            }
            get(fields, "tag").map_or(Ok(()), |tag| string(tag).map(drop))
        }
        _ => fail(node, "Not an item stack"),
    }
}

#[derive(Clone, Copy)]
enum Content {
    Text,
    Translatable,
    Keybind,
    Score,
    Selector,
    Nbt,
}

/// (value of `type`, key that selects it when `type` is absent, contents)
const CONTENTS: [(&str, &str, Content); 6] = [
    ("text", "text", Content::Text),
    ("translatable", "translate", Content::Translatable),
    ("keybind", "keybind", Content::Keybind),
    ("score", "score", Content::Score),
    ("selector", "selector", Content::Selector),
    ("nbt", "nbt", Content::Nbt),
];

#[derive(Clone, Copy)]
enum Source {
    Entity,
    Block,
    Storage,
}

/// (value of `source`, which is also the key that selects it)
const SOURCES: [(&str, Source); 3] =
    [("entity", Source::Entity), ("block", Source::Block), ("storage", Source::Storage)];

#[derive(Clone, Copy)]
enum HoverAction {
    Text,
    Item,
    Entity,
}

struct Checker<'c, 'a> {
    cx: &'c mut ArgCtx<'a>,
    base: u32,
}

impl Checker<'_, '_> {
    fn component(&mut self, node: &Node) -> Check {
        match &node.json {
            Json::Str(_) => Ok(()),
            Json::Array(items) => self.component_list(node, items),
            Json::Object(fields) => {
                self.contents(node, fields)?;
                if self.cx.config.spyglass {
                    self.nbt_only_keys(fields);
                }
                if let Some(extra) = get(fields, "extra") {
                    let Json::Array(items) = &extra.json else {
                        return fail(extra, "Not a JSON array");
                    };
                    self.component_list(extra, items)?;
                }
                self.style_fields(fields)
            }
            _ => fail(node, "Expected a string, array or object"),
        }
    }

    /// mcdoc's text component lets `interpret` appear only with `nbt`; vanilla
    /// ignores it elsewhere. The modified Spyglass reports both keys.
    fn nbt_only_keys(&mut self, fields: &Fields) {
        if get(fields, "nbt").is_some() {
            return;
        }
        let Some(interpret) = get(fields, "interpret") else { return };
        let Some((content, node)) = ["text", "translate", "score", "selector", "keybind"].iter().find_map(|k| get(fields, k).map(|n| (*k, n)))
        else {
            return;
        };
        let message = format!("Invalid combination of keys “interpret” and “{content}”");
        for n in [node, interpret] {
            if let Some((start, end)) = n.key {
                self.cx.diag(self.base + start as u32, self.base + end as u32, Severity::Error, "jsonKeyCombination", message.clone());
            }
        }
    }

    fn component_list(&mut self, node: &Node, items: &[Node]) -> Check {
        if items.is_empty() {
            return fail(node, "List must have contents");
        }
        items.iter().try_for_each(|item| self.component(item))
    }

    fn contents(&mut self, node: &Node, fields: &Fields) -> Check {
        if let Some(type_node) = get(fields, "type") {
            let name = string(type_node)?;
            return match CONTENTS.iter().find(|(type_name, ..)| *type_name == name) {
                Some(&(.., content)) => self.content(content, node, fields),
                None => fail(type_node, format!("Unknown element name:{name}")),
            };
        }
        let options = CONTENTS.iter().map(|&(_, key, content)| (key, content));
        self.first_match(node, fields, options, |ck, content| ck.content(content, node, fields))
    }

    /// Without a `type`/`source` discriminator vanilla tries each alternative in order
    /// and keeps the first that decodes. A failed alternative must leave no references.
    fn first_match<T: Copy>(
        &mut self,
        node: &Node,
        fields: &Fields,
        options: impl Iterator<Item = (&'static str, T)>,
        mut check: impl FnMut(&mut Self, T) -> Check,
    ) -> Check {
        let mut reported = None;
        for (key, option) in options {
            let mark = self.cx.effects.len();
            match check(self, option) {
                Ok(()) => return Ok(()),
                Err(fail) => {
                    self.cx.effects.truncate(mark);
                    if reported.is_none() && get(fields, key).is_some() {
                        reported = Some(fail);
                    }
                }
            }
        }
        Err(reported.unwrap_or_else(|| fail_at(node, "No matching codec found")))
    }

    fn content(&mut self, content: Content, node: &Node, fields: &Fields) -> Check {
        match content {
            Content::Text => string_field(node, fields, "text").map(drop),
            Content::Keybind => string_field(node, fields, "keybind").map(drop),
            Content::Translatable => {
                // `fallback` is a lenient optional field: a wrong type is ignored.
                string_field(node, fields, "translate")?;
                let Some(with) = get(fields, "with") else { return Ok(()) };
                let Json::Array(args) = &with.json else {
                    return fail(with, "Not a JSON array");
                };
                args.iter().try_for_each(|arg| match &arg.json {
                    Json::Str(_) | Json::Num(_) | Json::Bool(_) => Ok(()),
                    Json::Array(_) | Json::Object(_) => self.component(arg),
                    Json::Null => fail(arg, "Not a component"),
                })
            }
            Content::Score => {
                let score = required(node, fields, "score")?;
                let Json::Object(inner) = &score.json else {
                    return fail(score, "Not a JSON object");
                };
                let (name, name_node) = string_field(score, inner, "name")?;
                let (objective, objective_node) = string_field(score, inner, "objective")?;
                if name.starts_with('@') {
                    self.selector(name, name_node);
                } else if name != "*" {
                    let (start, end) = self.span(name_node);
                    self.cx.reference_name(kind::SCORE_HOLDER, name, start, end);
                }
                let (start, end) = self.span(objective_node);
                self.cx.reference_name(kind::OBJECTIVE, objective, start, end);
                Ok(())
            }
            Content::Selector => {
                let (pattern, pattern_node) = string_field(node, fields, "selector")?;
                if let Some(separator) = get(fields, "separator") {
                    self.component(separator)?;
                }
                if pattern.starts_with('@') {
                    self.selector(pattern, pattern_node);
                }
                Ok(())
            }
            Content::Nbt => {
                string_field(node, fields, "nbt")?;
                // `interpret` and `separator` are lenient optional fields too.
                if let Some(separator) = get(fields, "separator") {
                    let mark = self.cx.effects.len();
                    if self.component(separator).is_err() {
                        self.cx.effects.truncate(mark);
                    }
                }
                self.data_source(node, fields)
            }
        }
    }

    fn data_source(&mut self, node: &Node, fields: &Fields) -> Check {
        if let Some(type_node) = get(fields, "source") {
            let name = string(type_node)?;
            return match SOURCES.iter().find(|(key, _)| *key == name) {
                Some(&(_, source)) => self.source(source, node, fields),
                None => fail(type_node, format!("Unknown element name:{name}")),
            };
        }
        self.first_match(node, fields, SOURCES.iter().copied(), |ck, source| ck.source(source, node, fields))
    }

    fn source(&mut self, source: Source, node: &Node, fields: &Fields) -> Check {
        match source {
            Source::Entity => {
                let (pattern, pattern_node) = string_field(node, fields, "entity")?;
                if pattern.starts_with('@') {
                    self.selector(pattern, pattern_node);
                }
                Ok(())
            }
            Source::Block => string_field(node, fields, "block").map(drop),
            Source::Storage => {
                let value = required(node, fields, "storage")?;
                resource_location(value)?;
                let (start, end) = self.span(value);
                if let Json::Str(id) = &value.json {
                    self.cx.reference(kind::STORAGE, id, start, end);
                }
                Ok(())
            }
        }
    }

    fn style_fields(&mut self, fields: &Fields) -> Check {
        if let Some(value) = get(fields, "color") {
            color(value)?;
        }
        for key in ["bold", "italic", "underlined", "strikethrough", "obfuscated"] {
            if let Some(value) = get(fields, key)
                && !is_bool_or_number(value)
            {
                return fail(value, "Not a boolean");
            }
        }
        if let Some(value) = get(fields, "clickEvent") {
            click_event(value)?;
        }
        if let Some(value) = get(fields, "hoverEvent") {
            self.hover_event(value)?;
        }
        if let Some(value) = get(fields, "insertion") {
            string(value)?;
        }
        get(fields, "font").map_or(Ok(()), resource_location)
    }

    /// `{action, contents}`, or the legacy `{action, value}` that holds a component.
    fn hover_event(&mut self, node: &Node) -> Check {
        let Json::Object(fields) = &node.json else {
            return fail(node, "Not a JSON object");
        };
        let action = required(node, fields, "action")?;
        let action = match string(action)? {
            "show_text" => HoverAction::Text,
            "show_item" => HoverAction::Item,
            "show_entity" => HoverAction::Entity,
            other => return fail(action, format!("Unknown element name:{other}")),
        };
        let mark = self.cx.effects.len();
        let modern = required(node, fields, "contents").and_then(|contents| match action {
            HoverAction::Text => self.component(contents),
            HoverAction::Item => item_info(contents),
            HoverAction::Entity => self.entity_info(contents),
        });
        let Err(modern) = modern else { return Ok(()) };
        self.cx.effects.truncate(mark);
        // Legacy show_item and show_entity carry SNBT inside the component text; not checked here.
        if get(fields, "value").is_some_and(|value| self.component(value).is_ok()) {
            return Ok(());
        }
        self.cx.effects.truncate(mark);
        Err(modern)
    }

    fn entity_info(&mut self, node: &Node) -> Check {
        let Json::Object(fields) = &node.json else {
            return fail(node, "Not a JSON object");
        };
        resource_location(required(node, fields, "type")?)?;
        uuid(required(node, fields, "id")?)?;
        get(fields, "name").map_or(Ok(()), |name| self.component(name))
    }

    /// File offsets of a string node's content, without the quotes.
    fn span(&self, node: &Node) -> (u32, u32) {
        (self.base + node.start as u32 + 1, self.base + node.end as u32 - 1)
    }

    /// Selectors in components are parsed only for the references they hold; vanilla
    /// ignores one that fails. Escapes shift offsets, so they stay approximate.
    fn selector(&mut self, text: &str, node: &Node) {
        let mark = self.cx.effects.len();
        let mut reader = Reader::new(text, self.span(node).0);
        if entity::selector(&mut reader, self.cx).is_err() {
            self.cx.effects.truncate(mark);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::Effect;
    use crate::json::MAX_DEPTH;
    use crate::config::Config;

    struct Parsed {
        result: PResult<()>,
        end: usize,
        effects: Vec<Effect>,
    }

    fn parse_with(f: fn(&mut Reader, &mut ArgCtx) -> PResult<()>, src: &str, base: u32) -> Parsed {
        let data = crate::data::for_version("1.20.4").unwrap();
        let config = Config::default();
        let mut effects = Vec::new();
        let mut values = Vec::new();
        let mut cx = ArgCtx { data, config: &config, effects: &mut effects, name: "message", path: &[], values: &mut values };
        let mut r = Reader::new(src, base);
        let result = f(&mut r, &mut cx);
        Parsed { result, end: r.pos, effects }
    }

    fn parse_component(src: &str) -> Parsed {
        parse_with(component, src, 0)
    }

    fn refs(p: &Parsed) -> Vec<(&'static str, String, u32, u32)> {
        p.effects
            .iter()
            .filter_map(|e| match e {
                Effect::Ref(r) | Effect::Write(r) => Some((r.kind, r.id.clone(), r.start, r.end)),
                _ => None,
            })
            .collect()
    }

    fn kinds(p: &Parsed) -> Vec<&'static str> {
        refs(p).into_iter().map(|r| r.0).collect()
    }

    /// File offsets of the first `needle` in `src`.
    fn at(src: &str, needle: &str, base: u32) -> (u32, u32) {
        let start = src.find(needle).unwrap() as u32 + base;
        (start, start + needle.len() as u32)
    }

    fn accepts(sources: &[&str]) {
        for src in sources {
            let p = parse_component(src);
            if let Err(e) = &p.result {
                panic!("{src}: {}", e.message);
            }
            assert_eq!(p.end, src.len(), "{src}");
        }
    }

    fn rejects(sources: &[&str]) {
        for src in sources {
            assert!(parse_component(src).result.is_err(), "{src} should be rejected");
        }
    }

    fn syntax_end(src: &str) -> Option<usize> {
        let mut r = Reader::new(src, 0);
        parse_value(&mut r, 0).ok().map(|_| r.pos)
    }

    #[test]
    fn strings_accept_json_escapes_that_brigadier_rejects() {
        accepts(&[r#""a\n""#, r#"{"text":"a\u0002b\n\t\r\b\f\/\'\"\\"}"#, r#"["é",{"text":"😀 \ud83d"}]"#]);
        let mut r = Reader::new(r#""😀A\n""#, 0);
        let Json::Str(s) = parse_value(&mut r, 0).unwrap().json else { panic!() };
        assert_eq!(s, "\u{1F600}A\n");
    }

    #[test]
    fn syntax_matches_gson_strict_mode() {
        // Positions are what Gson's `JsonReader` reports after reading one value.
        let cases: &[(&str, Option<usize>)] = &[
            (r#""a""#, Some(3)),
            (r#""a" b"#, Some(3)),
            ("'a'", None),
            ("a", None),
            (r#"{text:"a"}"#, None),
            (r#"{'text':'a'}"#, None),
            (r#"{"text":"a"}"#, Some(12)),
            (r#"{"text":"a"} x"#, Some(12)),
            (r#"{"text":"a"}x"#, Some(12)),
            ("{\"text\": \"a\" ,\t\"bold\" : true }", Some(30)),
            (r#"{"text":"a",}"#, None),
            (r#"{,"text":"a"}"#, None),
            (r#"{"text":"a" "b":1}"#, None),
            (r#"{"text" "a"}"#, None),
            (r#"{"text"="a"}"#, None),
            (r#"{"a":1;"b":2}"#, None),
            (r#"{"a":}"#, None),
            (r#"{"a"}"#, None),
            ("{", None),
            (r#"{"a":1"#, None),
            ("{}", Some(2)),
            ("{ }", Some(3)),
            (r#"{"a":{"b":[1,{"c":null}]}}"#, Some(26)),
            ("[", None),
            ("[]", Some(2)),
            ("[ ]", Some(3)),
            ("[1", None),
            ("[1,", None),
            ("[1,]", None),
            ("[,1]", None),
            ("[1 2]", None),
            ("[1;2]", None),
            ("[[]]", Some(4)),
            (r#"["a",["b"],{"c":1}]"#, Some(19)),
            ("1", Some(1)),
            ("1 2", Some(1)),
            ("-1", Some(2)),
            ("-0", Some(2)),
            ("0", Some(1)),
            ("00", None),
            ("01", None),
            ("-", None),
            ("-a", None),
            ("+1", None),
            (".5", None),
            ("-.5", None),
            ("1.", None),
            ("1.5", Some(3)),
            ("1.5.5", None),
            ("1e3", Some(3)),
            ("1E+3", Some(4)),
            ("1e-3", Some(4)),
            ("1e", None),
            ("1e+", None),
            ("1.e3", None),
            ("12abc", None),
            ("1,", Some(1)),
            ("1]", Some(1)),
            ("1}", Some(1)),
            ("1:", Some(1)),
            ("1/", None),
            ("1;", None),
            ("1#", None),
            ("1=", None),
            ("1\u{c}", Some(1)),
            ("true", Some(4)),
            ("false", Some(5)),
            ("null", Some(4)),
            ("TRUE", Some(4)),
            ("tRuE", Some(4)),
            ("Null", Some(4)),
            ("nul", None),
            ("truex", None),
            ("true1", None),
            ("true,", Some(4)),
            ("true]", Some(4)),
            ("true/", None),
            ("nulll", None),
            ("NaN", None),
            ("Infinity", None),
            (r#""a\n""#, Some(5)),
            (r#""a\u0002""#, Some(9)),
            (r#""a\x""#, None),
            (r#""a\u00""#, None),
            (r#""a\u00zz""#, None),
            (r#""a\u12""#, None),
            (r#""a\"#, None),
            (r#""a\'""#, Some(5)),
            (r#""a\/""#, Some(5)),
            (r#""a\"b""#, Some(6)),
            (r#""a\\""#, Some(5)),
            (r#""a\b\f\n\r\t""#, Some(13)),
            (r#""\ud83d""#, Some(8)),
            (r#""\ude00""#, Some(8)),
            (r#""unterminated"#, None),
            ("\"a\nb\"", Some(5)),
            ("\"a\tb\"", Some(5)),
            ("\"a\\\nb\"", Some(6)),
            ("// c\n1", None),
            ("/*x*/1", None),
            ("#x\n1", None),
            ("/ 1", None),
            (" \"a\"", Some(4)),
            ("\n\"a\"", Some(4)),
            ("\t\"a\"", Some(4)),
            ("\r\"a\"", Some(4)),
            ("\u{c}\"a\"", None),
            ("]", None),
            ("}", None),
            (",", None),
            (":", None),
            (")", None),
            ("\\", None),
            ("@", None),
            ("", None),
            (r#"{"a":[1,2,3],"b":{"c":"d"}}"#, Some(27)),
        ];
        for (src, expected) in cases {
            assert_eq!(syntax_end(src), *expected, "{src:?}");
        }
    }

    #[test]
    fn nesting_is_bounded() {
        let deep = |n: usize| format!("{}{}", "[".repeat(n), "]".repeat(n));
        assert!(syntax_end(&deep(MAX_DEPTH)).is_some());
        assert!(syntax_end(&deep(MAX_DEPTH + 1)).is_none());
    }

    #[test]
    fn syntax_errors_point_at_the_problem() {
        let e = parse_component(r#"{"text":"a",}"#).result.unwrap_err();
        assert_eq!((e.start, e.end), (12, 13));
        assert!(e.message.starts_with("Invalid chat component: "), "{}", e.message);

        let e = parse_with(component, r#"["a" "b"]"#, 40).result.unwrap_err();
        assert_eq!((e.start, e.end), (45, 46));

        let e = parse_component(r#"{"text":"a\x"}"#).result.unwrap_err();
        assert_eq!((e.start, e.end), (11, 12));

        let e = parse_with(style, r#"{"bold":tru"#, 0).result.unwrap_err();
        assert!(e.message.starts_with("Invalid style: "), "{}", e.message);
    }

    #[test]
    fn the_value_ends_where_the_json_ends() {
        let p = parse_component(r#"{"text":"a"} rest"#);
        assert!(p.result.is_ok());
        assert_eq!(p.end, 12);
        assert_eq!(parse_component(r#""a""#).end, 3);
    }

    #[test]
    fn plain_strings_arrays_and_extra() {
        accepts(&[
            r#""hello""#,
            r#""""#,
            r#"[""]"#,
            r#"["a",{"text":"b"},["c"]]"#,
            r#"{"text":"a"}"#,
            r#"{"text":""}"#,
            r#"{"text":"a","extra":["b",{"text":"c","extra":[{"text":"d","extra":["e"]}]}]}"#,
            r#"{"text":"a","extra":null}"#,
            r#"{"text":"a","unknown":1,"other":{}}"#,
        ]);
        rejects(&[
            "",
            "'hello'",
            "hello",
            "1",
            "1.5",
            "true",
            "false",
            "null",
            "[]",
            "[[]]",
            "{}",
            r#"{"extra":["a"]}"#,
            r#"{"text":1}"#,
            r#"{"text":true}"#,
            r#"{"text":null}"#,
            r#"{"text":[]}"#,
            r#"{"text":{"text":"a"}}"#,
            r#"{"text":"a","extra":[]}"#,
            r#"{"text":"a","extra":"b"}"#,
            r#"{"text":"a","extra":[1]}"#,
            r#"{"text":"a","extra":[true]}"#,
            r#"{"text":"a","extra":[{"text":"b"},{"unknown":1}]}"#,
            r#"{"text":"a","extra":[{"text":"b","color":"bogus"}]}"#,
            r#"{text:"a"}"#,
            r#"{"text":"a",}"#,
            r#"["a",]"#,
            r#"["a" "b"]"#,
        ]);
    }

    #[test]
    fn duplicate_and_null_keys_follow_gson_and_jsonops() {
        accepts(&[
            r#"{"text":"a","text":"b"}"#,
            r#"{"text":"a","color":"bogus","color":"red"}"#,
            r#"{"text":null,"translate":"a"}"#,
            r#"{"type":null,"text":"a"}"#,
            r#"{"text":"a","bold":null,"clickEvent":null,"hoverEvent":null}"#,
        ]);
        rejects(&[r#"{"text":"a","color":"red","color":"bogus"}"#, r#"{"text":"a","text":null}"#]);
    }

    #[test]
    fn the_first_contents_that_decodes_wins() {
        accepts(&[
            r#"{"text":true,"translate":"a"}"#,
            r#"{"text":true,"keybind":"k"}"#,
            r#"{"text":"a","translate":1}"#,
            r#"{"text":"a","translate":{}}"#,
        ]);
        rejects(&[r#"{"text":true,"translate":true}"#, r#"{"bold":true}"#]);
    }

    #[test]
    fn explicit_type_selects_the_contents() {
        accepts(&[
            r#"{"type":"text","text":"a"}"#,
            r#"{"type":"translatable","translate":"a"}"#,
            r#"{"type":"keybind","keybind":"k"}"#,
            r#"{"type":"score","score":{"name":"a","objective":"b"}}"#,
            r#"{"type":"selector","selector":"@a"}"#,
            r#"{"type":"nbt","nbt":"a","storage":"x:y"}"#,
        ]);
        rejects(&[
            r#"{"type":"text","translate":"a"}"#,
            r#"{"type":"foo","text":"a"}"#,
            r#"{"type":"TEXT","text":"a"}"#,
            r#"{"type":1,"text":"a"}"#,
            r#"{"type":true,"text":"a"}"#,
        ]);
    }

    #[test]
    fn translatable_with_arguments() {
        accepts(&[
            r#"{"translate":"a"}"#,
            r#"{"translate":"a","with":[]}"#,
            r#"{"translate":"a","with":["x",1,1.5,true,{"text":"y"},["a",{"text":"b"}]]}"#,
            r#"{"translate":"a","fallback":"b"}"#,
            r#"{"translate":"a","fallback":true}"#,
            r#"{"translate":"a","with":[{"translate":"b","with":["c"]}],"color":"red"}"#,
        ]);
        rejects(&[
            r#"{"translate":1}"#,
            r#"{"translate":true}"#,
            r#"{"translate":"a","with":"x"}"#,
            r#"{"translate":"a","with":{}}"#,
            r#"{"translate":"a","with":[null]}"#,
            r#"{"translate":"a","with":[[]]}"#,
            r#"{"translate":"a","with":[{"bogus":1}]}"#,
        ]);
    }

    #[test]
    fn keybind_needs_a_string() {
        accepts(&[r#"{"keybind":"key.jump"}"#]);
        rejects(&[r#"{"keybind":1}"#, r#"{"keybind":true}"#]);
    }

    #[test]
    fn score_reports_objective_and_holder() {
        let src = r##"{"score":{"name":"#kills","objective":"stat"}}"##;
        let p = parse_with(component, src, 100);
        p.result.as_ref().unwrap();
        let (name, objective) = (at(src, "#kills", 100), at(src, "stat", 100));
        assert_eq!(
            refs(&p),
            [
                ("score_holder", "#kills".to_string(), name.0, name.1),
                ("objective", "stat".to_string(), objective.0, objective.1)
            ]
        );

        assert_eq!(kinds(&parse_component(r#"{"score":{"name":"*","objective":"o"}}"#)), ["objective"]);

        // the selector's offsets start at its string content
        let src = r#"{"score":{"name":"@a[tag=x]","objective":"o"}}"#;
        let p = parse_with(component, src, 7);
        p.result.as_ref().unwrap();
        let (tag, objective) = (at(src, "x", 7), at(src, "\"o\"", 7));
        assert_eq!(
            refs(&p),
            [("tag", "x".to_string(), tag.0, tag.1), ("objective", "o".to_string(), objective.0 + 1, objective.1 - 1)]
        );

        rejects(&[
            r#"{"score":{"name":"x"}}"#,
            r#"{"score":{"objective":"o"}}"#,
            r#"{"score":"x"}"#,
            r#"{"score":{"name":1,"objective":"o"}}"#,
            r#"{"score":{"name":"x","objective":true}}"#,
        ]);
    }

    #[test]
    fn selector_reports_references_inside_the_pattern() {
        let p = parse_component(r#"{"selector":"@e[tag=boss]","separator":{"text":", "}}"#);
        p.result.as_ref().unwrap();
        assert_eq!(refs(&p).iter().map(|r| (r.0, r.1.as_str())).collect::<Vec<_>>(), [("tag", "boss")]);

        // a pattern that does not parse, or a player name, adds nothing and is not an error
        for src in [r#"{"selector":"@e[tag="}"#, r#"{"selector":"Steve"}"#, r#"{"selector":"@q"}"#] {
            let p = parse_component(src);
            p.result.as_ref().unwrap();
            assert!(refs(&p).is_empty(), "{src}");
        }
        rejects(&[
            r#"{"selector":true}"#,
            r#"{"selector":"@a","separator":true}"#,
            r#"{"selector":"@a","separator":[]}"#,
            r#"{"selector":"@a","separator":{"bogus":1}}"#,
        ]);
    }

    #[test]
    fn nbt_reports_storage_and_selector() {
        let src = r#"{"nbt":"a.b","storage":"example:data"}"#;
        let p = parse_with(component, src, 10);
        p.result.as_ref().unwrap();
        let id = at(src, "example:data", 10);
        assert_eq!(refs(&p), [("storage", "example:data".to_string(), id.0, id.1)]);

        assert_eq!(refs(&parse_component(r#"{"nbt":"a","storage":"data"}"#))[0].1, "minecraft:data");

        let p = parse_component(r#"{"nbt":"a","entity":"@s[tag=x]"}"#);
        p.result.as_ref().unwrap();
        assert_eq!(kinds(&p), ["tag"]);

        accepts(&[
            r#"{"nbt":"a","block":"~ ~ ~"}"#,
            r#"{"nbt":"a","storage":"x:y/z.w-v_u","interpret":true,"separator":{"text":","}}"#,
            r#"{"nbt":"a","source":"storage","storage":"x:y"}"#,
            r#"{"nbt":"a","source":"entity","entity":"@s"}"#,
            r#"{"nbt":"a","source":"block","block":"~ ~ ~"}"#,
            r#"{"nbt":"a","entity":true,"storage":"x:y"}"#,
            r#"{"nbt":"a","storage":"x:y","interpret":"yes","separator":[]}"#,
            r#"{"nbt":"a","storage":"x:y","separator":true}"#,
        ]);
        rejects(&[
            r#"{"nbt":"a"}"#,
            r#"{"nbt":true,"storage":"x:y"}"#,
            r#"{"nbt":"a","storage":"X"}"#,
            r#"{"nbt":"a","storage":"x:Y"}"#,
            r#"{"nbt":"a","storage":"x:y:z"}"#,
            r#"{"nbt":"a","storage":1}"#,
            r#"{"nbt":"a","entity":1}"#,
            r#"{"nbt":"a","source":"foo","storage":"x:y"}"#,
            r#"{"nbt":"a","source":"storage","entity":"@s"}"#,
            r#"{"nbt":"a","source":1,"storage":"x:y"}"#,
        ]);
    }

    #[test]
    fn a_failed_alternative_leaves_no_references() {
        // `translatable` fails on its second argument after the first reported a storage
        let p = parse_component(r#"{"translate":"a","with":[{"nbt":"a","storage":"x:y"},[]],"keybind":"k"}"#);
        p.result.as_ref().unwrap();
        assert!(refs(&p).is_empty());

        // an invalid nbt separator is dropped together with what it referenced
        let src = r#"{"nbt":"a","storage":"x:y","separator":{"score":{"name":"n","objective":"o"},"bold":"x"}}"#;
        let p = parse_component(src);
        p.result.as_ref().unwrap();
        assert_eq!(kinds(&p), ["storage"]);
    }

    #[test]
    fn style_fields() {
        accepts(&[
            r##"{"text":"a","color":"red"}"##,
            r##"{"text":"a","color":"white"}"##,
            r##"{"text":"a","color":"dark_red"}"##,
            r##"{"text":"a","color":"light_purple"}"##,
            r##"{"text":"a","color":"#ff0000"}"##,
            r##"{"text":"a","color":"#FF00"}"##,
            r##"{"text":"a","color":"#ffffff"}"##,
            r##"{"text":"a","color":"#+ff"}"##,
            r##"{"text":"a","color":"#0000000000000ff"}"##,
            r##"{"text":"a","bold":true,"italic":false,"underlined":1,"strikethrough":0.5,"obfuscated":true}"##,
            r##"{"text":"a","insertion":"x","font":"minecraft:uniform"}"##,
            r##"{"text":"a","font":"x:y/z"}"##,
        ]);
        rejects(&[
            r##"{"text":"a","color":"bogus"}"##,
            r##"{"text":"a","color":"RED"}"##,
            r##"{"text":"a","color":"grey"}"##,
            r##"{"text":"a","color":"reset"}"##,
            r##"{"text":"a","color":"#1000000"}"##,
            r##"{"text":"a","color":"#-1"}"##,
            r##"{"text":"a","color":"#"}"##,
            r##"{"text":"a","color":"#xyz"}"##,
            r##"{"text":"a","color":1}"##,
            r##"{"text":"a","color":true}"##,
            r##"{"text":"a","bold":"true"}"##,
            r##"{"text":"a","bold":[]}"##,
            r##"{"text":"a","italic":"x"}"##,
            r##"{"text":"a","insertion":true}"##,
            r##"{"text":"a","insertion":1}"##,
            r##"{"text":"a","font":"Foo"}"##,
            r##"{"text":"a","font":1}"##,
        ]);
    }

    #[test]
    fn click_events() {
        accepts(&[
            r#"{"text":"a","clickEvent":{"action":"run_command","value":"/say hi"}}"#,
            r#"{"text":"a","clickEvent":{"action":"suggest_command","value":"x"}}"#,
            r#"{"text":"a","clickEvent":{"action":"open_url","value":"http://x"}}"#,
            r#"{"text":"a","clickEvent":{"action":"change_page","value":"1"}}"#,
            r#"{"text":"a","clickEvent":{"action":"copy_to_clipboard","value":"x"}}"#,
        ]);
        rejects(&[
            r#"{"text":"a","clickEvent":{"action":"open_file","value":"x"}}"#,
            r#"{"text":"a","clickEvent":{"action":"foo","value":"x"}}"#,
            r#"{"text":"a","clickEvent":{"action":1,"value":"x"}}"#,
            r#"{"text":"a","clickEvent":{"action":"run_command"}}"#,
            r#"{"text":"a","clickEvent":{"action":"run_command","value":1}}"#,
            r#"{"text":"a","clickEvent":{"action":"run_command","value":true}}"#,
            r#"{"text":"a","clickEvent":{"value":"x"}}"#,
            r#"{"text":"a","clickEvent":"x"}"#,
            r#"{"text":"a","clickEvent":[]}"#,
        ]);
    }

    #[test]
    fn hover_events() {
        accepts(&[
            r#"{"text":"a","hoverEvent":{"action":"show_text","contents":"x"}}"#,
            r#"{"text":"a","hoverEvent":{"action":"show_text","contents":{"text":"x","hoverEvent":{"action":"show_text","contents":"y"}}}}"#,
            r#"{"text":"a","hoverEvent":{"action":"show_text","contents":["x",{"text":"y"}]}}"#,
            r#"{"text":"a","hoverEvent":{"action":"show_text","value":{"text":"x"}}}"#,
            r#"{"text":"a","hoverEvent":{"action":"show_item","contents":"minecraft:stone"}}"#,
            r#"{"text":"a","hoverEvent":{"action":"show_item","contents":{"id":"minecraft:stone","count":2,"tag":"{a:1}"}}}"#,
            r#"{"text":"a","hoverEvent":{"action":"show_item","contents":{"id":"minecraft:stone","count":true}}}"#,
            r#"{"text":"a","hoverEvent":{"action":"show_item","contents":{"id":"minecraft:nonexistent"}}}"#,
            r#"{"text":"a","hoverEvent":{"action":"show_item","value":"{id:\"minecraft:stone\",Count:1b}"}}"#,
            r#"{"text":"a","hoverEvent":{"action":"show_entity","contents":{"type":"minecraft:pig","id":"00000000-0000-0000-0000-000000000000","name":{"text":"x"}}}}"#,
            r#"{"text":"a","hoverEvent":{"action":"show_entity","contents":{"type":"minecraft:nonexistent","id":[0,0,0,0]}}}"#,
            r#"{"text":"a","hoverEvent":{"action":"show_entity","contents":{"type":"minecraft:pig","id":"0-0-0-0-0"}}}"#,
            r#"{"text":"a","hoverEvent":{"action":"show_entity","contents":"x","value":"y"}}"#,
        ]);
        rejects(&[
            r#"{"text":"a","hoverEvent":"x"}"#,
            r#"{"text":"a","hoverEvent":[]}"#,
            r#"{"text":"a","hoverEvent":{"contents":"x"}}"#,
            r#"{"text":"a","hoverEvent":{"action":"foo","contents":"x"}}"#,
            r#"{"text":"a","hoverEvent":{"action":1,"contents":"x"}}"#,
            r#"{"text":"a","hoverEvent":{"action":null,"contents":"x"}}"#,
            r#"{"text":"a","hoverEvent":{"action":"show_text"}}"#,
            r#"{"text":"a","hoverEvent":{"action":"show_text","contents":[]}}"#,
            r#"{"text":"a","hoverEvent":{"action":"show_text","contents":true}}"#,
            r#"{"text":"a","hoverEvent":{"action":"show_text","contents":1}}"#,
            r#"{"text":"a","hoverEvent":{"action":"show_text","contents":{"bogus":1}}}"#,
            r#"{"text":"a","hoverEvent":{"action":"show_text","contents":[],"value":[]}}"#,
            r#"{"text":"a","hoverEvent":{"action":"show_item","contents":{"count":2}}}"#,
            r#"{"text":"a","hoverEvent":{"action":"show_item","contents":{"id":"Foo"}}}"#,
            r#"{"text":"a","hoverEvent":{"action":"show_item","contents":{"id":"minecraft:stone","count":"2"}}}"#,
            r#"{"text":"a","hoverEvent":{"action":"show_item","contents":{"id":"minecraft:stone","tag":{"a":1}}}}"#,
            r#"{"text":"a","hoverEvent":{"action":"show_item","contents":1}}"#,
            r#"{"text":"a","hoverEvent":{"action":"show_entity","contents":{"type":"minecraft:pig"}}}"#,
            r#"{"text":"a","hoverEvent":{"action":"show_entity","contents":{"id":"0-0-0-0-0"}}}"#,
            r#"{"text":"a","hoverEvent":{"action":"show_entity","contents":{"type":"Pig","id":"0-0-0-0-0"}}}"#,
            r#"{"text":"a","hoverEvent":{"action":"show_entity","contents":{"type":"minecraft:pig","id":"bad"}}}"#,
            r#"{"text":"a","hoverEvent":{"action":"show_entity","contents":{"type":"minecraft:pig","id":[0,0,0]}}}"#,
            r#"{"text":"a","hoverEvent":{"action":"show_entity","contents":{"type":"minecraft:pig","id":[0,0,0,"a"]}}}"#,
            r#"{"text":"a","hoverEvent":{"action":"show_entity","contents":{"type":"minecraft:pig","id":"0-0-0-0-0","name":[]}}}"#,
        ]);
    }

    #[test]
    fn hover_references_come_only_from_the_form_that_decodes() {
        let src = r#"{"text":"a","hoverEvent":{"action":"show_text","contents":{"nbt":"a","storage":"x:y"}}}"#;
        assert_eq!(kinds(&parse_component(src)), ["storage"]);

        // `contents` fails after reporting a storage; the legacy `value` is what decodes
        let src = r#"{"text":"a","hoverEvent":{"action":"show_text","contents":{"nbt":"a","storage":"x:y","bold":"x"},"value":"v"}}"#;
        let p = parse_component(src);
        p.result.as_ref().unwrap();
        assert!(refs(&p).is_empty());
    }

    #[test]
    fn java_uuid_parsing() {
        // Results of `UUID.fromString` on the same strings.
        let cases = [
            ("00000000-0000-0000-0000-000000000000", true),
            ("0-0-0-0-0", true),
            ("1-2-3-4-5", true),
            ("+1-+2-3-4-5", true),
            ("-1-2-3-4-5", false),
            ("1-2-3-4", false),
            ("1-2-3-4-5-6", false),
            ("123456789-0-0-0-0", true),
            ("ffffffffffffffff-0-0-0-0", false),
            ("7fffffffffffffff-0-0-0-0", true),
            ("8000000000000000-0-0-0-0", false),
            ("00000000-0000-0000-0000-0000000000000", false),
            ("00000000-0000-0000-0000-000000000000x", false),
            ("x-x-x-x-x", false),
            ("--0-0-0-0", false),
            ("0--0-0-0", false),
            ("0-0-0-0-", false),
            ("-0-0-0-0", false),
            ("@s", false),
            ("abc", false),
        ];
        for (s, ok) in cases {
            assert_eq!(is_java_uuid(s), ok, "{s}");
        }
    }

    #[test]
    fn invalid_values_are_marked_where_they_are() {
        let src = r#"{"text":"a","color":"bogus"}"#;
        let e = parse_with(component, src, 50).result.unwrap_err();
        let bogus = at(src, "\"bogus\"", 50);
        assert_eq!((e.start, e.end), bogus);
        assert_eq!(e.message, "Invalid chat component: Invalid color: bogus");

        // an object is marked at its `{`, not over its whole text
        let e = parse_component(r#"["a",{"bogus":1}]"#).result.unwrap_err();
        assert_eq!((e.start, e.end), (5, 6));
        assert!(e.message.contains("No matching codec found"), "{}", e.message);

        // with several alternatives, the error comes from the one whose key is present
        let e = parse_component(r#"{"translate":"a","with":"x"}"#).result.unwrap_err();
        assert!(e.message.contains("Not a JSON array"), "{}", e.message);
    }

    #[test]
    fn style_argument() {
        for src in [
            r#"{}"#,
            r#"{"bold":true}"#,
            r##"{"insertion":"x","color":"#123456"}"##,
            r#"{"color":"red","bold":true,"hoverEvent":{"action":"show_text","contents":"a"}}"#,
            r#"{"clickEvent":{"action":"run_command","value":"/x"}}"#,
            r#"{"font":"minecraft:x"}"#,
            r#"{"text":"ignored"}"#,
        ] {
            let p = parse_with(style, src, 0);
            if let Err(e) = &p.result {
                panic!("{src}: {}", e.message);
            }
            assert_eq!(p.end, src.len());
        }
        for src in [
            "",
            "[]",
            r#""x""#,
            "true",
            "1",
            "null",
            r#"{"color":"bogus"}"#,
            r#"{"bold":"true"}"#,
            "{bold:true}",
            "{'bold':true}",
        ] {
            assert!(parse_with(style, src, 0).result.is_err(), "{src}");
        }
        assert_eq!(parse_with(style, r#"{"bold":true} x"#, 0).end, 13);
    }
}
