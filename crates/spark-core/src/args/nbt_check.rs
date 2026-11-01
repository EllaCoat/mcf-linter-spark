//! The NBT checks of DHP 3.4.19 (`NbtArgumentParser`, `NbtPathArgumentParser`) against the
//! vanilla-mcdoc schema: the type check and the lint rules that work on keys and values.
//!
//! A compound is checked in two passes as DHP does. `parse_pass` is what the parser itself
//! reports (key quotes, naming conventions, duplicate keys, number literals out of range); it
//! follows the schema only to know which keys it names. `validate` checks the types over the
//! finished tree. With a `spyglass.json`, the checks the modified Spyglass makes on top (missing
//! keys of a whole value, its range message) apply.

use std::cmp::Ordering;
use std::rc::Rc;

use serde_json::Value;

use super::nbt::{NbtEntry, NbtNode, NbtPathNode, NbtValue};
use super::registry_rule;
use crate::command::Effect;
use crate::config::Config;
use crate::data::VersionData;
use crate::diag::{Diagnostic, Severity};
use crate::facts::{Ref, kind};
use crate::lint::{expected_quote, follows_convention};
use crate::mcdoc::{ANY, Alt, Field, Holds, IdAttr, Key, Lit, McDoc, NumKind, Range, Resolver, Scope, Tags, Tree, Ty, same_string, strip_minecraft};

/// The dispatcher an NBT's type comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Category {
    Entity,
    Block,
    Item,
    /// The value of an item component (1.20.5), by component type.
    DataComponent,
    /// The value of an item predicate's `~` test, by predicate type.
    ComponentPredicate,
    /// The options of a particle (1.20.5), by particle type.
    Particle,
    /// A text component in SNBT (1.21.5).
    Text,
    /// A text style in SNBT (1.21.5).
    Style,
    /// A data pack element written inline in a command (1.20.5), by its kind (`loot_table`).
    Resource,
    /// An item modifier written inline in a command, which from 26.3 may be a list of ids and
    /// modifiers although a file holds one modifier.
    ItemModifier,
    /// A slot source written inline in a command (26.3), which may be a list like an item modifier.
    SlotSource,
}

impl Category {
    /// The dispatcher of the category's types, or the one type of the categories with one.
    pub fn registry(self) -> &'static str {
        match self {
            Category::Entity => "minecraft:entity",
            Category::Block => "minecraft:block",
            Category::Item => "minecraft:item",
            Category::DataComponent => "minecraft:data_component",
            Category::ComponentPredicate => "minecraft:data_component_predicate",
            Category::Particle => "minecraft:particle",
            Category::Text => "::java::util::text::Text",
            Category::Style => "::java::util::text::TextStyle",
            Category::Resource => "minecraft:resource",
            Category::ItemModifier => "::java::data::item_modifier::ItemModifierArgument",
            Category::SlotSource => "::java::data::slot_source::SlotSourceArgument",
        }
    }
}

/// What a typed NBT is checked against.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub category: Category,
    /// The id whose type applies. `None` merges every type of the category.
    pub id: Option<String>,
    /// DHP's `isPredicate`: types must match strictly.
    pub predicate: bool,
    /// The tag is a whole value (a summoned entity, a `data modify` value other than `merge`),
    /// so the modified Spyglass reports the keys it lacks.
    pub whole: bool,
}

impl Target {
    pub fn new(category: Category, id: Option<String>) -> Target {
        Target { category, id, predicate: false, whole: false }
    }
}

/// The type of the target's NBT: the dispatcher's entry for the id (or `%unknown`), or all its
/// entries merged when the id is not known.
fn root_type<'d>(doc: &'d McDoc, target: &Target) -> &'d Ty {
    let registry = target.category.registry();
    if matches!(target.category, Category::Text | Category::Style | Category::ItemModifier | Category::SlotSource) {
        return doc.types.get(registry).unwrap_or(&ANY);
    }
    match &target.id {
        Some(id) => doc.dispatchers.get(registry).and_then(|m| m.get(strip_minecraft(id)).or_else(|| m.get("%unknown"))).unwrap_or(&ANY),
        None => doc.merged(registry).unwrap_or(&ANY),
    }
}

impl Tree for NbtNode {
    fn field(&self, name: &str) -> Option<&NbtNode> {
        match &self.value {
            NbtValue::Compound(entries) => entries.iter().rev().find(|e| e.key == name).map(|e| &e.value),
            _ => None,
        }
    }

    fn string(&self) -> Option<&str> {
        match &self.value {
            NbtValue::String { value, .. } => Some(value),
            _ => None,
        }
    }
}

/// The tags from the root to the one being checked, each with its key in its compound.
type Stack<'n> = Vec<(&'n NbtNode, Option<&'n str>)>;

/// Checks a parsed tag. `target` is `None` for an NBT without a schema.
pub fn check_value(data: &VersionData, config: &Config, node: &NbtNode, target: Option<&Target>) -> Vec<Effect> {
    // A component, a predicate value, particle options and a text component may be any tag, not
    // only a compound.
    let decoded = target.is_some_and(|t| !matches!(t.category, Category::Entity | Category::Block | Category::Item));
    let checker = Checker { whole: target.is_some_and(|t| t.whole), decoded, ..Checker::new(data, config) };
    let mut out = Vec::new();
    let mut stack = vec![(node, None)];
    let alts = match target {
        Some(t) => checker.r.resolve(root_type(&data.mcdoc, t), &checker.r.empty, &stack, false, 0),
        None => Vec::new(),
    };
    match target {
        Some(t) if decoded => {
            checker.parse_pass(&mut out, &mut stack, &alts);
            checker.validate(&mut out, &mut stack, &alts, t.predicate);
        }
        _ => checker.check_root(&mut out, &mut stack, &alts, target.is_some_and(|t| t.predicate)),
    }
    out
}

/// `Unit.CODEC`, which reads the value of a test that an item has a component: any compound.
pub fn check_unit(node: &NbtNode) -> Vec<Effect> {
    let mut out = Vec::new();
    let kind = kind_of(&node.value);
    if kind != NbtKind::Compound {
        let message = format!("Expected {} but got {}", NbtKind::Compound.article_name(), kind.article_name());
        emit(&mut out, node.start, node.end, Severity::Error, "nbtTypeCheck", message);
    }
    out
}

/// Checks a parsed NBT path. `target` is `None` for a path without a schema (storage).
pub fn check_path(data: &VersionData, config: &Config, nodes: &[NbtPathNode], target: Option<&Target>) -> Vec<Effect> {
    let checker = Checker::new(data, config);
    let mut out = Vec::new();
    let steps = steps(nodes);
    match target {
        Some(t) => checker.walk(&mut out, &steps, Some(vec![(root_type(&data.mcdoc, t), checker.r.empty.clone())])),
        None => checker.walk(&mut out, &steps, None),
    }
    out
}

/// Checks the tag of `data modify <entity|block> <target> <path> <op> value <tag>` against the
/// type at the end of `path`: the element type for `append`, `prepend` and `insert`
/// (`element`), the type itself otherwise. The modified Spyglass types this tag; DHP only parses
/// it, as `check_value` with no target does.
pub fn check_modify_value(
    data: &VersionData,
    config: &Config,
    path: &[NbtPathNode],
    target: &Target,
    element: bool,
    node: &NbtNode,
) -> Vec<Effect> {
    let checker = Checker { modify: true, whole: target.whole, ..Checker::new(data, config) };
    let steps = steps(path);
    let root = checker.r.resolve::<()>(root_type(&data.mcdoc, target), &checker.r.empty, &[], false, 0);
    let mut end = checker.path_end(&steps, root);
    if element {
        end = end.map(|alts| checker.elements(&alts, None));
    }
    let mut stack = vec![(node, None)];
    let alts = match end {
        Some(types) => types.iter().flat_map(|(t, s)| checker.r.resolve(t, s, &stack, false, 0)).collect(),
        None => Vec::new(),
    };
    let mut out = Vec::new();
    checker.parse_pass(&mut out, &mut stack, &alts);
    checker.validate(&mut out, &mut stack, &alts, false);
    out
}

/// The keys of the compound that `steps` reach from the target's root (a key, or `None` for a
/// list element), with the kind of tag each holds.
pub fn keys_at(data: &VersionData, target: &Target, steps: &[Option<&str>]) -> Vec<(String, &'static str)> {
    let config = Config::default();
    let checker = Checker::new(data, &config);
    let r = &checker.r;
    let mut alts = r.resolve::<()>(root_type(&data.mcdoc, target), &r.empty, &[], false, 0);
    for step in steps {
        let next = match step {
            Some(key) => checker.fields(&alts, key),
            None => checker.alt_elements(&alts, None),
        };
        alts = next.iter().flat_map(|(t, s)| r.resolve::<()>(t, s, &[], false, 0)).collect();
    }
    let mut out: Vec<(String, &'static str)> = Vec::new();
    for alt in &alts {
        let Alt::Struct { fields, .. } = alt else { continue };
        for (f, s) in fields {
            let Field::Pair { key, ty, .. } = f else { continue };
            let names = match key {
                Key::Name(n) => vec![n.clone()],
                Key::Type(k) => r.key_names::<()>(k, s, &[]),
            };
            for name in names {
                if !out.iter().any(|(n, _)| *n == name) {
                    let kind = tag_name(&r.resolve::<()>(ty, s, &[], false, 0));
                    out.push((name, kind));
                }
            }
        }
    }
    out
}

/// The kind of tag the alternatives hold, as the completion shows it.
fn tag_name(alts: &[Alt]) -> &'static str {
    let name = |alt: &Alt| match alt {
        Alt::Any => "tag",
        Alt::Struct { .. } => "compound",
        Alt::Leaf(ty, ..) => match ty {
            Ty::Boolean => "boolean",
            Ty::String { .. } => "string",
            Ty::Number { kind, .. } => kind.name(),
            Ty::Literal { .. } | Ty::Enum { .. } => "enum",
            Ty::List { .. } | Ty::Tuple(_) => "list",
            Ty::Array { kind: NumKind::Byte, .. } => "byte array",
            Ty::Array { kind: NumKind::Int, .. } => "int array",
            Ty::Array { .. } => "long array",
            _ => "tag",
        },
    };
    match alts {
        [first, rest @ ..] if rest.iter().all(|a| name(a) == name(first)) => name(first),
        _ => "tag",
    }
}

/// The alternatives when they are a schema to follow; `None` where any tag is allowed.
fn schema<'x, 'd>(alts: &'x [Alt<'d>]) -> Option<&'x [Alt<'d>]> {
    (!alts.is_empty() && !alts.iter().any(|a| matches!(a, Alt::Any))).then_some(alts)
}

type Sink = Vec<Effect>;

fn emit(out: &mut Sink, start: u32, end: u32, severity: Severity, code: &'static str, message: String) {
    out.push(Effect::Diag(Diagnostic { start, end, severity, code, message }));
}

fn diag_count(out: &[Effect]) -> usize {
    out.iter().filter(|e| matches!(e, Effect::Diag(_))).count()
}

fn error_count(out: &[Effect]) -> usize {
    out.iter().filter(|e| matches!(e, Effect::Diag(d) if d.severity == Severity::Error)).count()
}

/// `punc.quote`.
fn quoted(s: &str) -> String {
    format!("\u{201c}{s}\u{201d}")
}

/// `arrayToMessage(items, true, 'or')`.
fn join_or(items: &[String]) -> String {
    let q: Vec<String> = items.iter().map(|s| quoted(s)).collect();
    match q.as_slice() {
        [] => "nothing".to_string(),
        [a] => a.clone(),
        [a, b] => format!("{a} or {b}"),
        [init @ .., last] => format!("{}, or {last}", init.join(", ")),
    }
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `String(x)` of JavaScript for a number.
fn js_number(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.abs() >= 1e21 || x.abs() < 1e-6 {
        let s = format!("{x:e}");
        return match s.split_once('e') {
            Some((m, e)) if !e.starts_with('-') => format!("{m}e+{e}"),
            _ => s,
        };
    }
    format!("{x}")
}

fn js_bound(x: Option<f64>) -> String {
    x.map_or_else(|| "null".to_string(), js_number)
}

/// The value of a number tag. An integer is kept exact: a long does not fit a double.
#[derive(Clone, Copy)]
enum Num {
    Int(i64),
    Float(f64),
}

impl Num {
    /// Whether the value is in the range, an end left out being open.
    fn within(self, r: &Range) -> bool {
        let lower = r.min.is_none_or(|m| match self.cmp_bound(m) {
            Ordering::Greater => true,
            Ordering::Equal => !r.min_exclusive,
            Ordering::Less => false,
        });
        let upper = r.max.is_none_or(|m| match self.cmp_bound(m) {
            Ordering::Less => true,
            Ordering::Equal => !r.max_exclusive,
            Ordering::Greater => false,
        });
        lower && upper
    }

    fn cmp_bound(self, bound: f64) -> Ordering {
        match self {
            Num::Int(v) => cmp_int_float(v, bound),
            Num::Float(v) => v.partial_cmp(&bound).unwrap_or(Ordering::Equal),
        }
    }
}

fn cmp_int_float(v: i64, bound: f64) -> Ordering {
    if bound >= 9.3e18 {
        return Ordering::Less;
    }
    if bound <= -9.3e18 {
        return Ordering::Greater;
    }
    let floor = bound.floor();
    match i128::from(v).cmp(&(floor as i128)) {
        Ordering::Equal if bound > floor => Ordering::Less,
        order => order,
    }
}

/// The value of a number tag, and as JavaScript prints it.
fn number_of(v: &NbtValue) -> Option<(Num, String)> {
    Some(match v {
        NbtValue::Byte { value, .. } => (Num::Int(i64::from(*value)), value.to_string()),
        NbtValue::Short(v) => (Num::Int(i64::from(*v)), v.to_string()),
        NbtValue::Int(v) => (Num::Int(i64::from(*v)), v.to_string()),
        NbtValue::Long(v) => (Num::Int(*v), v.to_string()),
        // DHP keeps the double of the literal; the shortest f32 text is that literal in practice.
        NbtValue::Float(f) => {
            let d = f.to_string().parse::<f64>().unwrap_or(f64::from(*f));
            (Num::Float(d), js_number(d))
        }
        NbtValue::Double(d) => (Num::Float(*d), js_number(*d)),
        _ => return None,
    })
}

/// The type of a tag as DHP's `NbtNodeTypeName` names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NbtKind {
    Byte,
    Short,
    Int,
    Long,
    Float,
    Double,
    String,
    ByteArray,
    IntArray,
    LongArray,
    List,
    Compound,
}

impl NbtKind {
    /// `nbt-tag.<name>` of DHP's locale.
    fn article_name(self) -> &'static str {
        match self {
            NbtKind::Byte => "a byte tag",
            NbtKind::Short => "a short tag",
            NbtKind::Int => "an int tag",
            NbtKind::Long => "a long tag",
            NbtKind::Float => "a float tag",
            NbtKind::Double => "a double tag",
            NbtKind::String => "a string tag",
            NbtKind::ByteArray => "a byte array tag",
            NbtKind::IntArray => "an int array tag",
            NbtKind::LongArray => "a long array tag",
            NbtKind::List => "a list tag",
            NbtKind::Compound => "a compound tag",
        }
    }

    fn number(kind: NumKind) -> NbtKind {
        match kind {
            NumKind::Byte => NbtKind::Byte,
            NumKind::Short => NbtKind::Short,
            NumKind::Int => NbtKind::Int,
            NumKind::Long => NbtKind::Long,
            NumKind::Float => NbtKind::Float,
            NumKind::Double => NbtKind::Double,
        }
    }

    fn array(kind: NumKind) -> NbtKind {
        match kind {
            NumKind::Byte => NbtKind::ByteArray,
            NumKind::Long => NbtKind::LongArray,
            _ => NbtKind::IntArray,
        }
    }
}

/// Whether an alternative has the tag's shape, so that what it reports is more than the type.
fn fits(node: &NbtNode, alt: &Alt) -> bool {
    let kind = kind_of(&node.value);
    match alt {
        Alt::Any => true,
        Alt::Struct { .. } => kind == NbtKind::Compound,
        Alt::Leaf(ty, ..) => match ty {
            Ty::List { .. } | Ty::Tuple(_) => kind == NbtKind::List,
            Ty::String { .. } => kind == NbtKind::String,
            Ty::Array { kind: k, .. } => kind == NbtKind::array(*k),
            Ty::Number { kind: k, .. } => kind == NbtKind::number(*k),
            Ty::Boolean => kind == NbtKind::Byte,
            _ => false,
        },
    }
}

fn kind_of(v: &NbtValue) -> NbtKind {
    match v {
        NbtValue::Byte { .. } => NbtKind::Byte,
        NbtValue::Short(_) => NbtKind::Short,
        NbtValue::Int(_) => NbtKind::Int,
        NbtValue::Long(_) => NbtKind::Long,
        NbtValue::Float(_) => NbtKind::Float,
        NbtValue::Double(_) => NbtKind::Double,
        NbtValue::String { .. } => NbtKind::String,
        NbtValue::List(_) => NbtKind::List,
        NbtValue::ByteArray(_) => NbtKind::ByteArray,
        NbtValue::IntArray(_) => NbtKind::IntArray,
        NbtValue::LongArray(_) => NbtKind::LongArray,
        NbtValue::Compound(_) => NbtKind::Compound,
    }
}

struct QuoteRule {
    quote: Option<(Severity, bool)>,
    kind: Option<(Severity, String)>,
    quote_name: &'static str,
    kind_name: &'static str,
}

struct Rules {
    type_severity: Severity,
    type_strict: bool,
    boolean: Option<(Severity, Value)>,
    array_length: Option<Severity>,
    list_length: Option<Severity>,
    naming: Option<(Severity, Value)>,
    key_quote: QuoteRule,
    path_quote: QuoteRule,
    string_quote: QuoteRule,
}

/// A rule written as `[severity, value]`. An absent setting takes DHP's default; `null` turns the rule off.
fn read_rule(config: &Config, name: &str, default: Option<(Severity, Value)>) -> Option<(Severity, Value)> {
    match config.lint_value(name) {
        None => default,
        Some(Value::Array(a)) if a.len() == 2 => Some((Severity::parse(a[0].as_str()?)?, a[1].clone())),
        Some(_) => None,
    }
}

fn quote_rule(
    config: &Config,
    quote_name: &'static str,
    quote_default: Option<bool>,
    kind_name: &'static str,
    kind_default: &str,
) -> QuoteRule {
    let quote = read_rule(config, quote_name, quote_default.map(|b| (Severity::Warning, Value::Bool(b))))
        .map(|(s, v)| (s, v.as_bool().unwrap_or(false)));
    let kind = read_rule(config, kind_name, Some((Severity::Warning, Value::from(kind_default))))
        .map(|(s, v)| (s, v.as_str().unwrap_or("prefer double").to_string()));
    QuoteRule { quote, kind, quote_name, kind_name }
}

impl Rules {
    fn read(config: &Config) -> Rules {
        let type_check = read_rule(config, "nbtTypeCheck", None);
        let length = |name: &str, default: Option<(Severity, Value)>| {
            read_rule(config, name, default).filter(|(_, v)| truthy(v)).map(|(s, _)| s)
        };
        Rules {
            type_severity: type_check.as_ref().map_or(Severity::Warning, |(s, _)| *s),
            type_strict: type_check.is_some_and(|(_, v)| v.as_str() == Some("strictly")),
            boolean: read_rule(config, "nbtBoolean", None),
            array_length: length("nbtArrayLengthCheck", Some((Severity::Warning, Value::Bool(true)))),
            list_length: length("nbtListLengthCheck", None),
            naming: read_rule(config, "nameOfNbtCompoundTagKeys", None),
            key_quote: quote_rule(config, "nbtCompoundKeyQuote", None, "nbtCompoundKeyQuoteType", "prefer double"),
            path_quote: quote_rule(config, "nbtPathQuote", None, "nbtPathQuoteType", "always double"),
            string_quote: quote_rule(config, "nbtStringQuote", Some(true), "nbtStringQuoteType", "prefer double"),
        }
    }
}

/// `[-+]?(?:0|[1-9][0-9]*)`
fn integer_literal(s: &str) -> Option<&str> {
    let digits = s.strip_prefix(['-', '+']).unwrap_or(s);
    let ok = match digits.as_bytes() {
        [b'0'] => true,
        [b'1'..=b'9', rest @ ..] => rest.iter().all(u8::is_ascii_digit),
        _ => false,
    };
    ok.then_some(s)
}

/// A type the schema gives a tag, with the template arguments it was written with.
type Typed<'d> = (&'d Ty, Rc<Scope<'d>>);

struct Checker<'a> {
    r: Resolver<'a>,
    data: &'a VersionData,
    config: &'a Config,
    rules: Rules,
    /// The modified Spyglass's typing of a `data modify` value: number kinds
    /// are interchangeable, but a boolean must be a byte.
    modify: bool,
    /// `Target::whole`.
    whole: bool,
    /// The game decodes the tag with a codec when it loads the command (a component, a particle's
    /// options, a text component in SNBT), so a tag of another shape or without a required key
    /// does not load.
    decoded: bool,
}

impl<'a> Checker<'a> {
    fn new(data: &'a VersionData, config: &'a Config) -> Checker<'a> {
        Checker { r: Resolver::new(&data.mcdoc), data, config, rules: Rules::read(config), modify: false, whole: false, decoded: false }
    }

    fn check_root<'n>(&self, out: &mut Sink, stack: &mut Stack<'n>, alts: &[Alt<'a>], predicate: bool) {
        self.parse_pass(out, stack, alts);
        if matches!(stack.last().map(|(n, _)| &n.value), Some(NbtValue::Compound(_))) {
            self.validate(out, stack, alts, predicate);
        }
    }

    // ---- following the schema ----

    /// The types of `key` in the structs among `alts`, and whether a field names the key (rather
    /// than a field whose key is a type, as `[string]: any` in an item's tag).
    fn field_types<V: Tree>(&self, alts: &[Alt<'a>], key: &str, container: &[(&V, Option<&str>)]) -> (Vec<Typed<'a>>, bool) {
        let mut types = Vec::new();
        let mut named = false;
        for alt in alts {
            if let Alt::Struct { fields, .. } = alt
                && let Some((ty, scope, key_type)) = self.r.field(fields, key, container)
            {
                types.push((ty, scope));
                named |= key_type.is_none();
            }
        }
        (types, named)
    }

    fn fields(&self, alts: &[Alt<'a>], key: &str) -> Vec<Typed<'a>> {
        self.field_types::<()>(alts, key, &[]).0
    }

    /// The types of the elements of the lists among `alts`; `position` picks a tuple's item.
    fn elements(&self, alts: &[Typed<'a>], position: Option<usize>) -> Vec<Typed<'a>> {
        let resolved: Vec<Alt<'a>> = alts.iter().flat_map(|(t, s)| self.r.resolve::<()>(t, s, &[], false, 0)).collect();
        self.alt_elements(&resolved, position)
    }

    fn alt_elements(&self, alts: &[Alt<'a>], position: Option<usize>) -> Vec<Typed<'a>> {
        let mut out = Vec::new();
        for alt in alts {
            match alt {
                Alt::Leaf(Ty::List { item, .. }, s, _) => out.push((item.as_ref(), s.clone())),
                Alt::Leaf(Ty::Tuple(items), s, _) => match position {
                    Some(p) => out.extend(items.get(p).map(|t| (t, s.clone()))),
                    None => out.extend(items.iter().map(|t| (t, s.clone()))),
                },
                _ => {}
            }
        }
        out
    }

    // ---- what the parser reports ----

    fn parse_pass<'n>(&self, out: &mut Sink, stack: &mut Stack<'n>, alts: &[Alt<'a>]) {
        let node = stack.last().expect("a tag to check").0;
        match &node.value {
            NbtValue::Compound(entries) => {
                for (i, e) in entries.iter().enumerate() {
                    self.quote_problems(out, &self.rules.key_quote, e.key_quote, &e.key, e.key_start, e.key_end);
                    let (types, named) = self.field_types(alts, &e.key, stack);
                    if !named {
                        self.check_naming(out, e);
                    }
                    if entries[..i].iter().any(|p| p.key == e.key) {
                        let message = format!("Duplicate key {}", quoted(&e.key));
                        emit(out, e.key_start, e.key_end, Severity::Warning, "nbtDuplicateKey", message);
                    }
                    stack.push((&e.value, Some(&e.key)));
                    let child: Vec<Alt<'a>> = types.iter().flat_map(|(t, s)| self.r.resolve(t, s, stack, false, 0)).collect();
                    self.parse_pass(out, stack, &child);
                    stack.pop();
                }
            }
            NbtValue::List(items) => {
                for (i, item) in items.iter().enumerate() {
                    stack.push((item, None));
                    let child: Vec<Alt<'a>> =
                        self.alt_elements(alts, Some(i)).iter().flat_map(|(t, s)| self.r.resolve(t, s, stack, false, 0)).collect();
                    self.parse_pass(out, stack, &child);
                    stack.pop();
                }
            }
            NbtValue::String { value, quote: None } => self.check_literal_range(out, node, value),
            _ => {}
        }
    }

    fn check_naming(&self, out: &mut Sink, e: &NbtEntry) {
        let Some((severity, convention)) = &self.rules.naming else { return };
        if follows_convention(&e.key, convention) {
            return;
        }
        let labels: Vec<String> = match convention {
            Value::Array(items) => items.iter().map(convention_label).collect(),
            v => vec![convention_label(v)],
        };
        let message = format!(
            "Invalid key {} which doesn't follow {} convention",
            quoted(&e.key),
            join_or(&labels)
        );
        emit(out, e.key_start, e.key_end, *severity, "nameOfNbtCompoundTagKeys", message);
    }

    /// A number written like `128b` that does not fit its type stays a string; DHP warns about it.
    fn check_literal_range(&self, out: &mut Sink, node: &NbtNode, text: &str) {
        let last = text.bytes().last().map(|b| b.to_ascii_lowercase());
        let (digits, min, max, min_s, max_s) = match last {
            Some(b'b') => (&text[..text.len() - 1], -128i128, 127i128, "-128", "127"),
            Some(b's') => (&text[..text.len() - 1], -32_768, 32_767, "-32,768", "32,767"),
            Some(b'l') => (
                &text[..text.len() - 1],
                i128::from(i64::MIN),
                i128::from(i64::MAX),
                "-9,223,372,036,854,775,808",
                "9,223,372,036,854,775,807",
            ),
            _ => (text, i128::from(i32::MIN), i128::from(i32::MAX), "-2,147,483,648", "2,147,483,647"),
        };
        let Some(digits) = integer_literal(digits) else { return };
        if digits.parse::<i128>().is_ok_and(|v| min <= v && v <= max) {
            return;
        }
        let long = last == Some(b'l');
        let got = if long {
            match digits.trim_start_matches('+') {
                "-0" => "0".to_string(),
                s => s.to_string(),
            }
        } else {
            js_number(digits.parse::<f64>().unwrap_or(f64::NAN))
        };
        let message = format!("Expected a number between {min_s} and {max_s} but got {got}");
        emit(out, node.start, node.end, Severity::Warning, "nbtNumberOutOfRange", message);
    }

    /// `validateStringQuote`. `quote` is the quote the source used, if any.
    fn quote_problems(&self, out: &mut Sink, rule: &QuoteRule, quote: Option<u8>, value: &str, start: u32, end: u32) {
        if rule.quote.is_none() && rule.kind.is_none() {
            return;
        }
        let first = quote.map_or_else(|| value.chars().next().unwrap_or(' '), char::from);
        let expected = expected_quote(value, rule.kind.as_ref().map_or("prefer double", |(_, t)| t.as_str()));
        if let Some((severity, should_quote)) = &rule.quote
            && *should_quote != quote.is_some()
        {
            let wanted = if *should_quote { "a quote (\u{201c}'\u{201d} or \u{201c}\"\u{201d})" } else { "an unquoted string" };
            let message = format!(
                "Expected {wanted} but got {} (rule: {})",
                quoted(&first.to_string()),
                quoted(rule.quote_name)
            );
            emit(out, start, end, *severity, rule.quote_name, message);
        }
        if let (Some(q), Some((severity, _))) = (quote, &rule.kind)
            && q != expected
        {
            let preferred = if expected == b'"' {
                "Double quote (\u{201c}\"\u{201d})"
            } else {
                "Single quote (\u{201c}'\u{201d})"
            };
            let message = format!("{preferred} is preferable here (rule: {})", quoted(rule.kind_name));
            emit(out, start, end, *severity, rule.kind_name, message);
        }
    }

    // ---- the type check ----

    /// Checks the tag on top of `stack` against its alternatives: the first that reports
    /// nothing, or else the one that reports the least, preferring one of the tag's shape. A codec
    /// reads a decoded tag that has only warnings, so for one the fewest errors come first.
    fn validate<'n>(&self, out: &mut Sink, stack: &mut Stack<'n>, alts: &[Alt<'a>], pred: bool) {
        let Some(alts) = schema(alts) else { return };
        if let [alt] = alts {
            return self.validate_one(out, stack, alt, pred);
        }
        let node = stack.last().expect("a tag to check").0;
        let mut best: Option<(Sink, bool)> = None;
        for alt in alts {
            let mut child = Vec::new();
            self.validate_one(&mut child, stack, alt, pred);
            if diag_count(&child) == 0 {
                out.extend(child);
                return;
            }
            let fit = fits(node, alt);
            let better = |(b, b_fit): &(Sink, bool)| {
                let (n, m) = (diag_count(&child), diag_count(b));
                if self.decoded {
                    let (e, f) = (error_count(&child), error_count(b));
                    return e < f || e == f && (fit && !b_fit || fit == *b_fit && n < m);
                }
                n < m || n == m && fit && !b_fit
            };
            if best.as_ref().is_none_or(better) {
                best = Some((child, fit));
            }
        }
        out.extend(best.map(|(b, _)| b).unwrap_or_default());
    }

    fn validate_one<'n>(&self, out: &mut Sink, stack: &mut Stack<'n>, alt: &Alt<'a>, pred: bool) {
        let node = stack.last().expect("a tag to check").0;
        match alt {
            Alt::Any => {}
            Alt::Struct { fields, open, .. } => {
                if self.check_type(out, node, NbtKind::Compound, pred)
                    && let NbtValue::Compound(entries) = &node.value
                {
                    self.validate_compound(out, stack, entries, fields, *open, pred);
                    self.check_required(out, node, fields, pred);
                }
            }
            Alt::Leaf(ty, scope, outer) => match ty {
                Ty::Boolean
                    if self.modify
                        && matches!(kind_of(&node.value), NbtKind::Short | NbtKind::Int | NbtKind::Long | NbtKind::Float | NbtKind::Double) =>
                {
                    emit(out, node.start, node.end, Severity::Error, "nbtTypeCheck", "Expected a boolean".into());
                }
                Ty::Boolean => {
                    if self.check_type(out, node, NbtKind::Byte, pred) {
                        self.check_boolean(out, node);
                    }
                }
                Ty::Number { kind, range } => {
                    if self.check_type(out, node, NbtKind::number(*kind), pred) {
                        self.check_number(out, node, *kind, range.as_ref());
                    }
                }
                Ty::String { id, holds, .. } => match id.as_deref().or(*outer) {
                    Some(attr) => self.id_field(out, node, attr, pred),
                    None => self.string_field(out, node, *holds, pred),
                },
                Ty::Literal { value, id } => self.enum_field(out, node, std::slice::from_ref(value), None, *id || outer.is_some(), pred),
                Ty::Enum { values, id, num } => self.enum_field(out, node, values, *num, *id || outer.is_some(), pred),
                Ty::List { item, len } => {
                    if self.check_type(out, node, NbtKind::List, pred)
                        && let NbtValue::List(items) = &node.value
                    {
                        if let Some(range) = len {
                            self.check_length(out, node, range, items.len(), self.rules.list_length, "nbtListLengthCheck");
                        }
                        for element in items {
                            stack.push((element, None));
                            let alts = self.r.resolve(item, scope, stack, false, 0);
                            self.validate(out, stack, &alts, pred);
                            stack.pop();
                        }
                    }
                }
                Ty::Tuple(types) => {
                    if self.check_type(out, node, NbtKind::List, pred)
                        && let NbtValue::List(items) = &node.value
                    {
                        let exact = Range { min: Some(types.len() as f64), max: Some(types.len() as f64), min_exclusive: false, max_exclusive: false };
                        self.check_length(out, node, &exact, items.len(), self.rules.list_length, "nbtListLengthCheck");
                        for (element, t) in items.iter().zip(types) {
                            stack.push((element, None));
                            let alts = self.r.resolve(t, scope, stack, false, 0);
                            self.validate(out, stack, &alts, pred);
                            stack.pop();
                        }
                    }
                }
                Ty::Array { kind, range, len } => self.array_field(out, node, *kind, len.as_ref(), range.as_ref(), pred),
                _ => {}
            },
        }
    }

    fn validate_compound<'n>(
        &self,
        out: &mut Sink,
        stack: &mut Stack<'n>,
        entries: &'n [NbtEntry],
        fields: &[(&'a Field, Rc<Scope<'a>>)],
        open: bool,
        pred: bool,
    ) {
        for (i, first) in entries.iter().enumerate() {
            // `Object.keys` lists a repeated key once, with the last value and the last key's range.
            if entries[..i].iter().any(|p| p.key == first.key) {
                continue;
            }
            let Some(entry) = entries.iter().rev().find(|e| e.key == first.key) else { continue };
            match self.r.field(fields, &entry.key, stack) {
                Some((ty, scope, _)) => {
                    stack.push((&entry.value, Some(&entry.key)));
                    let alts = self.r.resolve(ty, &scope, stack, false, 0);
                    self.validate(out, stack, &alts, pred);
                    stack.pop();
                }
                None if open => {}
                None => {
                    let message = format!("Unknown key {}", quoted(&entry.key));
                    emit(out, entry.key_start, entry.key_end, Severity::Warning, "nbtUnknownKey", message);
                }
            }
        }
    }

    /// The modified Spyglass reports the keys that a whole value lacks, and a decoded tag lacks none.
    fn check_required(&self, out: &mut Sink, node: &NbtNode, fields: &[(&'a Field, Rc<Scope<'a>>)], pred: bool) {
        if pred || !(self.decoded || self.config.spyglass && self.whole) {
            return;
        }
        let NbtValue::Compound(entries) = &node.value else { return };
        for (f, _) in fields {
            if let Field::Pair { key: Key::Name(key), optional: false, .. } = f
                && !entries.iter().any(|e| e.key == *key)
            {
                emit(out, node.start, node.end, Severity::Error, "nbtMissingKey", format!("Missing key {}", quoted(key)));
            }
        }
    }

    /// `validateNbtNodeType`. Returns whether the tag matches loosely, so that its content is checked.
    fn check_type(&self, out: &mut Sink, node: &NbtNode, expected: NbtKind, pred: bool) -> bool {
        let actual = kind_of(&node.value);
        let number = |k: NbtKind| matches!(k, NbtKind::Byte | NbtKind::Short | NbtKind::Int | NbtKind::Long | NbtKind::Float | NbtKind::Double);
        if self.modify && number(actual) && number(expected) {
            return true;
        }
        let strictly = actual == expected;
        let loosely = strictly
            || (actual == NbtKind::Int
                && matches!(expected, NbtKind::Byte | NbtKind::Short | NbtKind::Long | NbtKind::Float | NbtKind::Double));
        // `NbtOps` reads any number as a number, and a list or an array as a list.
        let shape = |k: NbtKind| match k {
            k if number(k) => 0,
            NbtKind::String => 1,
            NbtKind::Compound => 2,
            _ => 3,
        };
        if self.decoded && shape(actual) != shape(expected) {
            let message = format!("Expected {} but got {}", expected.article_name(), actual.article_name());
            emit(out, node.start, node.end, Severity::Error, "nbtTypeCheck", message);
            return false;
        }
        if !loosely || ((pred || self.rules.type_strict) && !strictly) {
            let message = format!(
                "Expected {} but got {} (rule: {})",
                expected.article_name(),
                actual.article_name(),
                quoted("nbtTypeCheck")
            );
            emit(out, node.start, node.end, self.rules.type_severity, "nbtTypeCheck", message);
        }
        loosely
    }

    fn check_boolean(&self, out: &mut Sink, node: &NbtNode) {
        let Some((severity, expected)) = &self.rules.boolean else { return };
        let literal = match &node.value {
            NbtValue::Byte { raw_bool: Some(b), .. } => Some(*b),
            _ => None,
        };
        let differs = match expected {
            Value::Bool(b) => literal.is_some() != *b,
            _ => true,
        };
        if !differs {
            return;
        }
        let message = if truthy(expected) {
            format!("Expected {}", join_or(&["false".to_string(), "true".to_string()]))
        } else {
            let actual = match literal {
                Some(true) => "true".to_string(),
                Some(false) => "false".to_string(),
                None => number_of(&node.value).map(|(_, s)| s).unwrap_or_default(),
            };
            format!("Expected a byte tag but got {}", quoted(&actual))
        };
        emit(out, node.start, node.end, *severity, "nbtBoolean", message);
    }

    /// A number out of the schema's range: DHP's warning, or the modified Spyglass's error. DHP's
    /// message gives both ends; an end the schema leaves open is the end of the number kind.
    fn check_number(&self, out: &mut Sink, node: &NbtNode, kind: NumKind, range: Option<&Range>) {
        let Some(range) = range else { return };
        let Some((value, text)) = number_of(&node.value) else { return };
        if value.within(range) {
            return;
        }
        if self.config.spyglass {
            let message = format!("Expected numeric value to be {}", spyglass_range(range));
            emit(out, node.start, node.end, Severity::Error, "nbtNumberRange", message);
        } else {
            let (lo, hi) = kind.bounds().unwrap_or((f64::NEG_INFINITY, f64::INFINITY));
            let message = format!("Expected a number between {} and {} but got {text}", js_number(range.min.unwrap_or(lo)), js_number(range.max.unwrap_or(hi)));
            emit(out, node.start, node.end, Severity::Warning, "nbtNumberRange", message);
        }
    }

    fn array_field(&self, out: &mut Sink, node: &NbtNode, kind: NumKind, length: Option<&Range>, values: Option<&Range>, pred: bool) {
        if !self.check_type(out, node, NbtKind::array(kind), pred) {
            return;
        }
        let (NbtValue::ByteArray(items) | NbtValue::IntArray(items) | NbtValue::LongArray(items)) = &node.value else {
            return;
        };
        if let Some(range) = length {
            self.check_length(out, node, range, items.len(), self.rules.array_length, "nbtArrayLengthCheck");
        }
        for item in items {
            self.check_number(out, item, kind, values);
        }
    }

    fn check_length(&self, out: &mut Sink, node: &NbtNode, range: &Range, len: usize, severity: Option<Severity>, rule: &'static str) {
        let Some(severity) = severity else { return };
        if range.contains(len as f64) {
            return;
        }
        let expected = if range.min == range.max {
            format!("a collection with length {}", js_bound(range.min))
        } else {
            format!("a collection with length between {} and {}", js_bound(range.min), js_bound(range.max))
        };
        let message = format!("Expected {expected} (rule: {})", quoted(rule));
        emit(out, node.start, node.end, severity, rule, message);
    }

    /// An enum or a literal: a string unless `num` gives the kind of its numbers.
    fn enum_field(&self, out: &mut Sink, node: &NbtNode, values: &[Lit], num: Option<NumKind>, id: bool, pred: bool) {
        let kind = match (num, values.first()) {
            (Some(k), _) => NbtKind::number(k),
            (None, Some(Lit::Num(_))) => kind_of(&node.value),
            (None, Some(Lit::Bool(_))) => NbtKind::Byte,
            _ => NbtKind::String,
        };
        if !self.check_type(out, node, kind, pred) {
            return;
        }
        let actual = match &node.value {
            NbtValue::String { value, .. } => value.clone(),
            other => number_of(other).map(|(_, s)| s).unwrap_or_default(),
        };
        let texts: Vec<String> = values.iter().map(lit_text).collect();
        if !texts.iter().any(|t| same_string(t, &actual, id)) {
            let message = format!("Expected {} but got {}", join_or(&texts), quoted(&actual));
            emit(out, node.start, node.end, Severity::Warning, "nbtEnum", message);
        }
    }

    fn string_field(&self, out: &mut Sink, node: &NbtNode, holds: Option<Holds>, pred: bool) {
        if !self.check_type(out, node, NbtKind::String, pred) {
            return;
        }
        match &node.value {
            NbtValue::String { value, quote: Some(q) } if !value.is_empty() => {
                self.string_quote(out, node, value, Some(*q));
                if let Some(holds) = holds {
                    self.inner_string(out, node, value, holds);
                }
            }
            // DHP checks quoted strings only; the modified Spyglass checks every string field.
            NbtValue::String { value, quote: None } if self.config.spyglass => self.string_quote(out, node, value, None),
            _ => {}
        }
    }

    fn string_quote(&self, out: &mut Sink, node: &NbtNode, value: &str, quote: Option<u8>) {
        self.quote_problems(out, &self.rules.string_quote, quote, value, node.start, node.end);
    }

    /// `validateInnerString`: a string that holds another argument. Commands are not checked.
    fn inner_string(&self, out: &mut Sink, node: &NbtNode, value: &str, holds: Holds) {
        // Offsets are exact only when the source between the quotes is the value itself.
        let exact = (node.end - node.start) as usize == value.len() + 2;
        let base = if exact { node.start + 1 } else { node.start };
        let mut effects = Vec::new();
        let mut values = Vec::new();
        let mut cx = super::ArgCtx { data: self.data, config: self.config, effects: &mut effects, name: "", path: &[], values: &mut values };
        let mut r = crate::reader::Reader::new(value, base);
        let result = match holds {
            Holds::Tag | Holds::Team => {
                let name = r.read_unquoted();
                let (s, e) = (r.offset_of(0), r.offset());
                if holds == Holds::Tag {
                    cx.reference_name(kind::ENTITY_TAG, name, s, e);
                    cx.naming("nameOfTags", "tag", name, s, e);
                } else {
                    cx.reference_name(kind::TEAM, name, s, e);
                    cx.naming("nameOfTeams", "team", name, s, e);
                }
                Ok(())
            }
            Holds::Text if self.decoded && !super::nbt::modern(self.data) => super::text::lenient_component(&mut r, &mut cx),
            Holds::Text => super::text::component(&mut r, &mut cx),
            Holds::BlockPredicate => super::blockitem::block_state(&mut r, &mut cx, true),
            Holds::Particle => super::blockitem::particle(&mut r, &mut cx),
            Holds::Command | Holds::Objective => return,
        };
        if let Err(e) = result {
            effects.push(Effect::Diag(Diagnostic { start: e.start, end: e.end, severity: Severity::Error, code: "syntax", message: e.message }));
        }
        for effect in &mut effects {
            let range = match effect {
                Effect::Diag(d) => (&mut d.start, &mut d.end),
                Effect::Ref(r) | Effect::Write(r) => (&mut r.start, &mut r.end),
                Effect::Def(d) => (&mut d.start, &mut d.end),
            };
            if !exact {
                *range.0 = node.start;
                *range.1 = node.end;
            }
        }
        out.extend(effects);
    }

    fn id_field(&self, out: &mut Sink, node: &NbtNode, attr: &IdAttr, pred: bool) {
        if !self.check_type(out, node, NbtKind::String, pred) {
            return;
        }
        let NbtValue::String { value, quote } = &node.value else { return };
        if value.is_empty() {
            return;
        }
        self.check_identity(out, node, value, quote.is_some(), attr);
        self.string_quote(out, node, value, *quote);
    }

    /// `IdentityArgumentParser` over the string of an id tag.
    fn check_identity(&self, out: &mut Sink, node: &NbtNode, value: &str, quoted_in_source: bool, attr: &IdAttr) {
        // The offsets inside the string are file offsets only when the source has no escapes.
        let exact = !value.contains(['\\', '"', '\'']);
        let base = node.start + u32::from(quoted_in_source);
        let span = |a: usize, b: usize| if exact { (base + a as u32, base + b as u32) } else { (node.start, node.end) };
        let mut problems: Vec<(usize, usize, Severity, &'static str, String)> = Vec::new();

        let mut pos = 0;
        let is_tag = value.starts_with('#');
        let tags_allowed = matches!(attr.tags, Tags::Allowed | Tags::Required);
        if is_tag {
            pos = 1;
            if !tags_allowed {
                problems.push((0, 1, Severity::Error, "nbtIdentity", "Tags are not allowed here".into()));
            }
        }
        let mut read_part = |pos: &mut usize| -> String {
            let start = *pos;
            let len = value[start..]
                .bytes()
                .take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b'+'))
                .count();
            *pos += len;
            let part = &value[start..*pos];
            if !part.bytes().all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'/' | b'.' | b'_' | b'-')) {
                problems.push((start, *pos, Severity::Error, "nbtIdentity", "Found non [a-z0-9/._-] character(s)".into()));
            }
            part.to_string()
        };
        let first = read_part(&mut pos);
        let (namespace, mut paths) = if value[pos..].starts_with(':') {
            pos += 1;
            let path = read_part(&mut pos);
            (Some(first), vec![path])
        } else {
            (None, vec![first])
        };
        while value[pos..].starts_with('/') {
            pos += 1;
            paths.push(read_part(&mut pos));
        }
        let registry = attr.registry.as_deref().filter(|_| !attr.definition && attr.path.is_none() && (!is_tag || tags_allowed));
        if pos == 0 || (is_tag && pos == 1) {
            let first_char = value.chars().next().map_or(1, char::len_utf8);
            problems.push((0, first_char, Severity::Error, "nbtIdentity", "Expected a namespaced ID but got nothing".into()));
        } else if let Some(registry) = registry {
            let raw = format!("{}:{}", namespace.filter(|n| !n.is_empty()).as_deref().unwrap_or("minecraft"), paths.join("/"));
            let (start, end) = span(usize::from(is_tag), pos);
            let tag = is_tag || attr.tags == Tags::Implicit;
            if let Some(kind) = self.data.file_kind(&if tag { format!("tag/{registry}") } else { registry.to_string() }) {
                if !self.data.vanilla_json_has(kind, &raw) {
                    out.push(Effect::Ref(Ref { kind, id: raw, start, end }));
                }
            } else if !tag {
                let identity = format!("minecraft:{registry}");
                if let Some((severity, rule)) = self.registry_problem(&identity, &raw) {
                    let message = format!(
                        "Failed to resolve namespaced ID {} in registry {} (rule: {})",
                        quoted(&raw),
                        quoted(&identity),
                        quoted(rule)
                    );
                    problems.push((0, pos, severity, rule, message));
                }
            }
        }
        for (a, b, severity, code, message) in problems {
            let (start, end) = span(a, b);
            emit(out, start, end, severity, code, message);
        }
    }

    /// The severity and rule when `id` is not in the registry and the `strict*Check` rule asks for it.
    fn registry_problem(&self, registry: &str, id: &str) -> Option<(Severity, &'static str)> {
        // DHP's switch knows the old name `minecraft:motive`, not `minecraft:painting_variant`.
        if registry == "minecraft:painting_variant" || !self.data.registries.contains_key(registry) {
            return None;
        }
        let rule = registry_rule(registry)?;
        let (severity, mode) = self.config.rule(rule)?;
        let checks = match mode.as_str()? {
            "always" => true,
            "only-default-namespace" => id.starts_with("minecraft:"),
            _ => false,
        };
        (checks && !self.data.registry_has(registry, id)).then_some((severity, rule))
    }
}

/// `at least 0 and at most 59` as the modified Spyglass words a range.
fn spyglass_range(r: &Range) -> String {
    let lower = r.min.map(|m| format!("{} {}", if r.min_exclusive { "above" } else { "at least" }, js_number(m)));
    let upper = r.max.map(|m| format!("{} {}", if r.max_exclusive { "below" } else { "at most" }, js_number(m)));
    match (lower, upper) {
        (Some(l), Some(u)) => format!("{l} and {u}"),
        (l, u) => l.or(u).unwrap_or_default(),
    }
}

fn lit_text(lit: &Lit) -> String {
    match lit {
        Lit::Bool(b) => b.to_string(),
        Lit::Num(n) => js_number(*n),
        Lit::Str(s) => s.clone(),
    }
}

fn convention_label(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Object(o) => o.get("label").and_then(Value::as_str).unwrap_or("").to_string(),
        _ => String::new(),
    }
}

// ---- NbtPathArgumentParser ----

/// A path node as DHP's parser takes it: a key, a `{...}` filter, or an index.
enum Step<'n> {
    Key { name: &'n str, quote: Option<u8>, start: u32, end: u32 },
    Filter(&'n NbtNode),
    Index { start: u32, end: u32, filter: Option<&'n NbtNode> },
}

impl Step<'_> {
    fn start(&self) -> u32 {
        match self {
            Step::Key { start, .. } | Step::Index { start, .. } => *start,
            Step::Filter(node) => node.start,
        }
    }
}

fn steps(nodes: &[NbtPathNode]) -> Vec<Step<'_>> {
    let mut out = Vec::new();
    for node in nodes {
        match node {
            NbtPathNode::MatchRoot(filter) => out.push(Step::Filter(filter)),
            NbtPathNode::Key { name, quote, start, end, filter } => {
                out.push(Step::Key { name, quote: *quote, start: *start, end: *end });
                if let Some(filter) = filter {
                    out.push(Step::Filter(filter));
                }
            }
            NbtPathNode::Index { start, end, .. } | NbtPathNode::AllElements { start, end } => {
                out.push(Step::Index { start: *start, end: *end, filter: None });
            }
            NbtPathNode::MatchElement(filter) => {
                out.push(Step::Index { start: filter.start - 1, end: filter.end + 1, filter: Some(filter) });
            }
        }
    }
    out
}

impl<'a> Checker<'a> {
    /// The types at the end of `steps` from the alternatives `alts`. `None` where the schema
    /// ends or allows any tag.
    fn path_end(&self, steps: &[Step], root: Vec<Alt<'a>>) -> Option<Vec<Typed<'a>>> {
        let mut alts = root;
        let mut types = None;
        for step in steps {
            let current = schema(&alts)?;
            let next = match step {
                Step::Key { name, .. } => self.fields(current, name),
                Step::Filter(_) => continue,
                Step::Index { .. } => self.alt_elements(current, None),
            };
            if next.is_empty() {
                return None;
            }
            alts = next.iter().flat_map(|(t, s)| self.r.resolve::<()>(t, s, &[], false, 0)).collect();
            types = Some(next);
        }
        types
    }

    /// `parseSpecifiedTypes` for the steps from here on. `types` is the schema at this position,
    /// `None` outside it. Where the schema allows several types, a step that any of them takes is
    /// accepted.
    fn walk(&self, out: &mut Sink, steps: &[Step], types: Option<Vec<Typed<'a>>>) {
        let Some((step, rest)) = steps.split_first() else { return };
        let resolved: Vec<Alt<'a>> = types.iter().flatten().flat_map(|(t, s)| self.r.resolve::<()>(t, s, &[], false, 0)).collect();
        let alts = schema(&resolved);
        let compound = alts.is_some_and(|a| a.iter().any(|x| matches!(x, Alt::Struct { .. })));
        match step {
            Step::Key { name, quote, start, end } => {
                self.quote_problems(out, &self.rules.path_quote, *quote, name, *start, *end);
                let mut next = None;
                if let Some(alts) = alts {
                    if !compound {
                        emit(out, *start, *end, Severity::Warning, "nbtPathKey", "Keys are only used for compound tags".into());
                    } else {
                        let found = self.fields(alts, name);
                        let open = alts.iter().any(|x| matches!(x, Alt::Struct { open: true, .. }));
                        if found.is_empty() && !open {
                            let message = format!("Unknown key {}", quoted(name));
                            emit(out, *start, *end, Severity::Warning, "nbtUnknownKey", message);
                        }
                        next = Some(found).filter(|f| !f.is_empty());
                    }
                }
                self.walk(out, rest, next);
            }
            Step::Filter(node) => {
                if alts.is_some() && !compound {
                    emit(out, node.start, node.start + 1, Severity::Warning, "nbtPathFilter", "Compound filters are only used for compound tags".into());
                }
                let filter_types = if compound { types.as_deref().unwrap_or_default() } else { &[] };
                self.check_filter(out, node, filter_types);
                self.walk(out, rest, types);
            }
            Step::Index { start, end, filter } => {
                let elements = alts.map(|a| self.alt_elements(a, None)).unwrap_or_default();
                let is_list = !elements.is_empty();
                let is_array = alts.is_some_and(|a| a.iter().any(|x| matches!(x, Alt::Leaf(Ty::Array { .. }, ..))));
                if alts.is_some() && !(is_list || is_array) {
                    emit(out, *start, *start + 1, Severity::Warning, "nbtPathIndex", "Indices are only used for lists/arrays tags".into());
                }
                let sub = |out: &mut Sink, at: u32| {
                    emit(out, at, at + 1, Severity::Warning, "nbtPathSub", "The current tag doesn't have extra items".into());
                };
                if let Some(filter) = filter {
                    if alts.is_some() && !is_list {
                        sub(out, filter.start);
                    }
                    self.check_filter(out, filter, &elements);
                }
                if alts.is_some() && !is_list && rest.first().is_some_and(|next| next.start() > *end) {
                    sub(out, *end);
                }
                self.walk(out, rest, Some(elements).filter(|e| !e.is_empty()));
            }
        }
    }

    /// A `{...}` filter of a path is a predicate on the compound there, whose own keys pick its type.
    fn check_filter(&self, out: &mut Sink, node: &NbtNode, types: &[Typed<'a>]) {
        let mut stack = vec![(node, None)];
        let alts: Vec<Alt<'a>> = types.iter().flat_map(|(t, s)| self.r.resolve(t, s, &stack, false, 0)).collect();
        let structs: Vec<Alt<'a>> = alts.into_iter().filter(|a| matches!(a, Alt::Struct { .. } | Alt::Any)).collect();
        self.check_root(out, &mut stack, &structs, true);
    }
}

#[cfg(test)]
mod tests;
