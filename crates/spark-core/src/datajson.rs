//! Data pack JSON files (advancements, predicates, loot tables, tags, ...) checked against the
//! vanilla-mcdoc schema the way the mcdoc checker of the modified Spyglass does
//! (`packages/mcdoc/src/runtime/checker`): a value its type cannot hold is an error, a key the
//! type does not know a warning, and ids are resolved against the registries and the project.
//! Where the schema cannot be followed (an unknown reference or dispatcher key), the value is
//! accepted.

use std::cell::Cell;
use std::rc::Rc;

use crate::data::VersionData;
use crate::diag::{Diagnostic, Severity};
use crate::facts::{Kind, Ref, full_id};
use crate::json::{self, Json, Node, Reading};
use crate::mcdoc::{self, Alt, Field, Holds, IdAttr, Key, Lit, McDoc, NumKind, Range, Resolver, Scope, Tags, Tree, Ty, id_shape, same_string, strip_minecraft};

/// The schema of a data pack JSON file of this kind, if the schema covers it.
pub fn schema(kind: Kind, doc: &McDoc) -> Option<Ty> {
    if let Some(registry) = kind.strip_prefix("tag/") {
        let entry = IdAttr { registry: Some(registry.to_string()), tags: Tags::Allowed, ..IdAttr::default() };
        let entry = Ty::String { len: None, id: Some(Box::new(entry)), holds: None };
        return Some(Ty::Concrete { child: Box::new(Ty::Reference("::java::data::tag::Tag".into())), args: vec![entry] });
    }
    doc.dispatchers.get("minecraft:resource")?.get(kind).cloned()
}

pub struct Checked {
    pub diags: Vec<Diagnostic>,
    /// Ids of project resources and tags, for the project to resolve.
    pub refs: Vec<Ref>,
}

pub fn reading(kind: Kind) -> Reading {
    use crate::facts::kind::{ADVANCEMENT, ITEM_MODIFIER, LOOT_TABLE, PREDICATE, RECIPE};
    match kind {
        ADVANCEMENT | LOOT_TABLE | PREDICATE | ITEM_MODIFIER | RECIPE => Reading::Strict,
        _ => Reading::Lenient,
    }
}

pub fn check(text: &str, reading: Reading, schema: &Ty, doc: &McDoc, data: &VersionData) -> Checked {
    let node = match json::parse_document(text, reading) {
        Ok(node) => node,
        Err(e) => {
            let diag = Diagnostic { start: e.start, end: e.end, severity: Severity::Error, code: "jsonSyntax", message: e.message };
            return Checked { diags: vec![diag], refs: Vec::new() };
        }
    };
    let checker = Checker::new(doc, data, text);
    let mut stack = vec![(&node, None)];
    let out = checker.value(&mut stack, schema, &checker.r.empty);
    Checked { diags: out.problems, refs: out.refs }
}

#[derive(Default)]
struct Out {
    problems: Vec<Diagnostic>,
    refs: Vec<Ref>,
}

impl Out {
    fn errors(&self) -> usize {
        self.problems.iter().filter(|p| p.severity == Severity::Error).count()
    }

    fn add(&mut self, other: Out) {
        self.problems.extend(other.problems);
        self.refs.extend(other.refs);
    }

    fn problem(&mut self, (start, end): (usize, usize), severity: Severity, code: &'static str, message: String) {
        self.problems.push(Diagnostic { start: start as u32, end: end as u32, severity, code, message });
    }
}

/// The JSON values from the root to the one being checked, each with its key in its object.
type Stack<'n> = Vec<(&'n Node, Option<&'n str>)>;
type Path<'n> = mcdoc::Path<'n, Node>;

impl Tree for Node {
    fn field(&self, name: &str) -> Option<&Node> {
        match &self.json {
            Json::Object(members) => members.iter().rev().find(|(k, _)| k == name).map(|(_, v)| v),
            _ => None,
        }
    }

    fn string(&self) -> Option<&str> {
        match &self.json {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }
}

/// The symbol that a string naming an objective, a team, or an entity tag references.
fn symbol_kind(holds: Holds) -> Option<Kind> {
    match holds {
        Holds::Objective => Some(crate::facts::kind::OBJECTIVE),
        Holds::Team => Some(crate::facts::kind::TEAM),
        Holds::Tag => Some(crate::facts::kind::ENTITY_TAG),
        _ => None,
    }
}

/// A container is marked at its first character; a long span adds nothing.
fn span(node: &Node) -> (usize, usize) {
    match node.json {
        Json::Array(_) | Json::Object(_) => (node.start, node.start + 1),
        _ => (node.start, node.end),
    }
}

struct Checker<'d> {
    r: Resolver<'d>,
    data: &'d VersionData,
    text: &'d str,
    nbt: Cell<u32>,
}

impl<'d> Checker<'d> {
    fn new(doc: &'d McDoc, data: &'d VersionData, text: &'d str) -> Checker<'d> {
        Checker { r: Resolver::new(doc), data, text, nbt: Cell::new(0) }
    }

    fn inside_quotes(&self, (start, end): (usize, usize)) -> (usize, usize) {
        match self.text.as_bytes().get(start) {
            Some(b'"' | b'\'') => (start + 1, end.saturating_sub(1).max(start + 1)),
            _ => (start, end),
        }
    }

    fn value<'n>(&self, stack: &mut Stack<'n>, ty: &'d Ty, scope: &Rc<Scope<'d>>) -> Out {
        let alts = self.r.resolve(ty, scope, stack, false, 0);
        self.alternatives(stack, &alts)
    }

    fn alternatives<'n>(&self, stack: &mut Stack<'n>, alts: &[Alt<'d>]) -> Out {
        let node = stack.last().expect("a value to check").0;
        if alts.is_empty() || alts.iter().any(|a| matches!(a, Alt::Any)) {
            return Out::default();
        }
        let nbt = self.nbt.get() > 0;
        let fitting: Vec<&Alt<'d>> = alts.iter().filter(|a| fits(a, node, nbt)).collect();
        match fitting.as_slice() {
            [] => {
                let mut out = Out::default();
                out.problem(span(node), Severity::Error, "jsonType", format!("Expected {}", expected(alts)));
                out
            }
            [one] => self.alternative(stack, one),
            many => many
                .iter()
                .map(|a| self.alternative(stack, a))
                .min_by_key(|o| (o.errors(), o.problems.len()))
                .unwrap_or_default(),
        }
    }

    /// Checks a value against one alternative whose shape it fits.
    fn alternative<'n>(&self, stack: &mut Stack<'n>, alt: &Alt<'d>) -> Out {
        let node = stack.last().expect("a value to check").0;
        let mut out = Out::default();
        match (alt, &node.json) {
            (Alt::Struct { fields, open, nbt }, Json::Object(members)) => {
                self.nbt.set(self.nbt.get() + u32::from(*nbt));
                self.object(stack, node, members, fields, *open, &mut out);
                self.nbt.set(self.nbt.get() - u32::from(*nbt));
            }
            (Alt::Leaf(ty, scope, outer_id), json) => match (ty, json) {
                (Ty::String { len, id, holds }, Json::Str(s)) => {
                    if let Some(len) = len
                        && !len.contains(s.chars().count() as f64)
                    {
                        out.problem(span(node), Severity::Error, "jsonRange", format!("Expected a string of length {}", len.describe()));
                    }
                    let value_span = self.inside_quotes((node.start, node.end));
                    if let Some(id) = id.as_deref().or(*outer_id) {
                        self.id(s, id, value_span, !optional_tag_entry(stack), &mut out);
                    }
                    if let Some(kind) = holds.and_then(symbol_kind) {
                        out.refs.push(Ref { kind, id: s.clone(), start: value_span.0 as u32, end: value_span.1 as u32 });
                    }
                }
                (Ty::Number { kind, range }, Json::Num(v)) => number(*kind, *range, *v, node, &mut out),
                (Ty::List { item, len }, Json::Array(items)) => {
                    collection_length(*len, items.len(), node, &mut out);
                    for item_node in items {
                        stack.push((item_node, None));
                        out.add(self.value(stack, item, scope));
                        stack.pop();
                    }
                }
                (Ty::Array { kind, range, len }, Json::Array(items)) => {
                    collection_length(*len, items.len(), node, &mut out);
                    for item_node in items {
                        match item_node.json {
                            Json::Num(v) => number(*kind, *range, v, item_node, &mut out),
                            _ => out.problem(span(item_node), Severity::Error, "jsonType", format!("Expected a {}", kind.name())),
                        }
                    }
                }
                (Ty::Tuple(types), Json::Array(items)) => {
                    for (i, item_node) in items.iter().enumerate() {
                        match types.get(i) {
                            Some(t) => {
                                stack.push((item_node, None));
                                out.add(self.value(stack, t, scope));
                                stack.pop();
                            }
                            None => out.problem(span(item_node), Severity::Error, "jsonType", "Expected nothing".into()),
                        }
                    }
                    if items.len() < types.len() {
                        out.problem(span(node), Severity::Error, "jsonRange", format!("Expected a list of length {}", types.len()));
                    }
                }
                _ => {}
            },
            _ => {}
        }
        out
    }

    fn object<'n>(
        &self,
        stack: &mut Stack<'n>,
        node: &'n Node,
        members: &'n [(String, Node)],
        fields: &[(&'d Field, Rc<Scope<'d>>)],
        open: bool,
        out: &mut Out,
    ) {
        for (i, (name, value)) in members.iter().enumerate() {
            let key_span = value.key.unwrap_or((value.start, value.start));
            if members[..i].iter().any(|(other, _)| other == name) {
                out.problem(key_span, Severity::Warning, "jsonDuplicateKey", format!("Duplicate key “{name}”; the last one is used"));
            }
            match self.r.field(fields, name, stack) {
                Some((ty, scope, key_type)) => {
                    if let Some(kind) = key_type.and_then(|k| self.r.holds(k, &scope, stack, true)).and_then(symbol_kind) {
                        let (start, end) = self.inside_quotes(key_span);
                        out.refs.push(Ref { kind, id: name.clone(), start: start as u32, end: end as u32 });
                    }
                    stack.push((value, Some(name.as_str())));
                    out.add(self.value(stack, ty, &scope));
                    stack.pop();
                }
                None if open => {}
                None => out.problem(key_span, Severity::Warning, "jsonUnknownKey", format!("Unknown key “{name}”")),
            }
        }
        for (f, _) in fields {
            if let Field::Pair { key: Key::Name(n), optional: false, .. } = f
                && !members.iter().any(|(m, _)| m == n)
            {
                out.problem(span(node), Severity::Error, "jsonMissingKey", format!("Missing key “{n}”"));
            }
        }
    }

    /// Checks a resource location; `resolve`: whether it must exist.
    fn id(&self, value: &str, attr: &IdAttr, span: (usize, usize), resolve: bool, out: &mut Out) {
        let (is_tag, raw) = match id_shape(value, attr) {
            Ok(Some(parsed)) => parsed,
            Ok(None) => return,
            Err(message) => {
                out.problem(span, Severity::Error, "jsonId", message);
                return;
            }
        };
        let Some(registry) = attr.registry.as_deref() else { return };
        if attr.definition || attr.path.is_some() || !resolve {
            return;
        }
        let id = full_id(raw);
        if attr.exclude.iter().any(|e| full_id(e) == id) {
            out.problem(span, Severity::Warning, "jsonId", format!("“{id}” is not allowed here"));
        }
        let (start, end) = (span.0 as u32, span.1 as u32);
        if is_tag || attr.tags == Tags::Implicit {
            if let Some(kind) = self.data.file_kind(&format!("tag/{registry}")) {
                out.refs.push(Ref { kind, id, start, end });
            }
        } else if let Some(kind) = self.data.file_kind(registry) {
            out.refs.push(Ref { kind, id, start, end });
        } else if id.starts_with("minecraft:")
            && self.data.registries.contains_key(&format!("minecraft:{registry}"))
            && !self.data.registry_has(&format!("minecraft:{registry}"), &id)
        {
            out.problem(span, Severity::Error, "undeclaredSymbol", format!("Cannot find {registry} “{id}”"));
        }
    }
}

/// The `id` of a tag entry written `{"id": ..., "required": false}`, which the game skips when it is missing.
fn optional_tag_entry(stack: &Path) -> bool {
    let [.., (parent, _), (_, Some("id"))] = stack else { return false };
    !tag_entry_required(parent)
}

pub fn tag_entry_required(entry: &Node) -> bool {
    let Json::Object(members) = &entry.json else { return true };
    match members.iter().rev().find(|(k, _)| k == "required").map(|(_, v)| &v.json) {
        Some(Json::Bool(required)) => *required,
        Some(Json::Num(n)) => n.trunc() as i64 as i8 != 0,
        _ => true,
    }
}

/// Whether the value has the shape of the alternative (and is its literal or enum value).
fn fits(alt: &Alt, node: &Node, nbt: bool) -> bool {
    match (alt, &node.json) {
        (Alt::Any, _) => true,
        (Alt::Struct { .. }, Json::Object(_)) => true,
        (Alt::Leaf(ty, _, outer), json) => match (ty, json) {
            (Ty::Boolean, Json::Bool(_)) => true,
            (Ty::Boolean, Json::Num(_)) => nbt,
            (Ty::String { .. }, Json::Str(_)) => true,
            (Ty::Number { kind, .. }, Json::Num(v)) => kind.bounds().is_none_or(|(lo, hi)| (lo..=hi).contains(v)),
            (Ty::Literal { value, id }, json) => lit_matches(value, json, *id || outer.is_some()),
            (Ty::Enum { values, id, .. }, json) => values.iter().any(|v| lit_matches(v, json, *id || outer.is_some())),
            (Ty::List { .. } | Ty::Array { .. } | Ty::Tuple(_), Json::Array(_)) => true,
            _ => false,
        },
        _ => false,
    }
}

fn lit_matches(lit: &Lit, json: &Json, id: bool) -> bool {
    match (lit, json) {
        (Lit::Bool(a), Json::Bool(b)) => a == b,
        (Lit::Num(a), Json::Num(b)) => a == b,
        (Lit::Str(a), Json::Str(b)) => same_string(a, b, id),
        _ => false,
    }
}

/// What the alternatives expect, as in "Expected a string or an object".
fn expected(alts: &[Alt]) -> String {
    let mut names: Vec<String> = Vec::new();
    for alt in alts {
        if let Alt::Leaf(Ty::Enum { values, .. }, _, _) = alt {
            for q in values.iter().map(quote) {
                if !names.contains(&q) {
                    names.push(q);
                }
            }
            continue;
        }
        let name = match alt {
            Alt::Any => continue,
            Alt::Struct { .. } => "an object".to_string(),
            Alt::Leaf(ty, _, _) => match ty {
                Ty::Boolean => "a boolean".to_string(),
                Ty::String { .. } => "a string".to_string(),
                Ty::Number { kind, range } => {
                    let article = if matches!(kind, NumKind::Int) { "an" } else { "a" };
                    match range {
                        Some(r) => format!("{article} {} in {}", kind.name(), r.describe()),
                        None => format!("{article} {}", kind.name()),
                    }
                }
                Ty::Literal { value, .. } => quote(value),
                Ty::List { .. } | Ty::Array { .. } | Ty::Tuple(_) => "a list".to_string(),
                _ => continue,
            },
        };
        if !names.contains(&name) {
            names.push(name);
        }
    }
    match names.as_slice() {
        [] => "nothing".to_string(),
        [one] => one.clone(),
        [init @ .., last] => format!("{} or {last}", init.join(", ")),
    }
}

fn quote(lit: &Lit) -> String {
    match lit {
        Lit::Bool(b) => format!("“{b}”"),
        Lit::Num(n) => format!("“{n}”"),
        Lit::Str(s) => format!("“{}”", strip_minecraft(s)),
    }
}

fn number(kind: NumKind, range: Option<Range>, v: f64, node: &Node, out: &mut Out) {
    if let Some((lo, hi)) = kind.bounds()
        && !(lo..=hi).contains(&v)
    {
        out.problem(span(node), Severity::Error, "jsonType", format!("Expected a {}", kind.name()));
        return;
    }
    if let Some(r) = range
        && !r.contains(v)
    {
        out.problem(span(node), Severity::Error, "jsonRange", format!("Expected a number in {}", r.describe()));
    }
}

fn collection_length(len: Option<Range>, n: usize, node: &Node, out: &mut Out) {
    if let Some(r) = len
        && !r.contains(n as f64)
    {
        out.problem(span(node), Severity::Error, "jsonRange", format!("Expected a list of length {}", r.describe()));
    }
}

/// A completion at the cursor of a data pack JSON file.
pub struct Suggestion {
    pub label: String,
    /// Replaces `start..end`: the label, quoted for a key or a string.
    pub insert: String,
    pub start: usize,
    pub end: usize,
    pub key: bool,
    pub detail: Option<String>,
}

/// Where the cursor is: on a key of an object, or on a value (or where one goes).
enum Spot {
    Key { start: usize, end: usize, typed: String, present: Vec<String> },
    Value { start: usize, end: usize, typed: String },
    /// A new element of the list on top of the stack.
    Item { at: usize },
}

/// The keys and values that fit at `offset`. `project_ids` gives the ids of a kind that the
/// project defines.
pub fn complete(
    text: &str,
    offset: usize,
    schema: &Ty,
    doc: &McDoc,
    data: &VersionData,
    project_ids: &dyn Fn(Kind) -> Vec<String>,
) -> Vec<Suggestion> {
    let root = json::parse_partial(text);
    let mut stack: Stack = vec![(&root, None)];
    let Some(spot) = locate(text, &root, offset, &mut stack) else { return Vec::new() };
    let checker = Checker::new(doc, data, text);
    let mut alts = checker.along(schema, &stack);
    if let Spot::Item { .. } = spot {
        alts = alts
            .iter()
            .filter_map(|a| match a {
                Alt::Leaf(Ty::List { item, .. }, s, _) => Some((item.as_ref(), s.clone())),
                _ => None,
            })
            .flat_map(|(t, s)| checker.r.resolve(t, &s, &stack, false, 0))
            .collect();
    }
    let mut out: Vec<Suggestion> = Vec::new();
    let mut push = |s: Suggestion| {
        if !out.iter().any(|o| o.label == s.label) {
            out.push(s);
        }
    };
    let mut value_at = None;
    match spot {
        Spot::Key { start, end, typed, present } => {
            for alt in &alts {
                let Alt::Struct { fields, .. } = alt else { continue };
                for (f, scope) in fields {
                    let Field::Pair { key, desc, .. } = f else { continue };
                    let names: Vec<String> = match key {
                        Key::Name(n) => vec![n.clone()],
                        Key::Type(t) => {
                            let mut names = checker.r.key_names(t, scope, &stack);
                            for alt in checker.r.resolve(t, scope, &stack, true, 0) {
                                if let Alt::Leaf(Ty::String { id, .. }, _, outer) = alt
                                    && let Some(attr) = id.as_deref().or(outer)
                                {
                                    names.extend(checker.ids(attr, project_ids));
                                }
                            }
                            names
                        }
                    };
                    let written = |n: &String| present.iter().any(|p| p == n || full_id(p) == full_id(n));
                    for name in names.into_iter().filter(|n| !written(n) && matches_typed(n, &typed)) {
                        push(Suggestion { insert: format!("\"{name}\""), label: name, start, end, key: true, detail: desc.clone() });
                    }
                }
            }
        }
        Spot::Value { start, end, typed } => value_at = Some((start, end, typed)),
        Spot::Item { at } => value_at = Some((at, at, String::new())),
    }
    if let Some((start, end, typed)) = value_at {
        for alt in &alts {
            for (label, quoted) in checker.values(alt, project_ids) {
                if matches_typed(&label, &typed) {
                    let insert = if quoted { format!("\"{label}\"") } else { label.clone() };
                    push(Suggestion { label, insert, start, end, key: false, detail: None });
                }
            }
        }
    }
    out
}

/// Whether a candidate starts with what is typed, ignoring case and a `minecraft:` the user
/// left out.
fn matches_typed(label: &str, typed: &str) -> bool {
    let (label, typed) = (label.to_ascii_lowercase(), typed.to_ascii_lowercase());
    label.starts_with(&typed) || strip_minecraft(label.trim_start_matches('#')).starts_with(typed.trim_start_matches('#'))
}

/// Finds what the cursor is on below `node`, the top of `stack`, pushing the values on the way.
fn locate<'n>(text: &str, node: &'n Node, offset: usize, stack: &mut Stack<'n>) -> Option<Spot> {
    let close = match node.json {
        Json::Object(_) => b'}',
        Json::Array(_) => b']',
        _ => return value_spot(text, node, offset),
    };
    let closed = node.end > node.start + 1 && text.as_bytes().get(node.end - 1) == Some(&close);
    let inside_end = if closed { node.end - 1 } else { node.end };
    if offset <= node.start || offset > inside_end {
        return None;
    }
    let child = |v: &Node| v.start <= offset && offset <= v.end && (v.start < v.end || v.start == offset);
    match &node.json {
        Json::Object(fields) => {
            for (name, v) in fields {
                if let Some((ks, ke)) = v.key
                    && ks <= offset
                    && offset <= ke
                {
                    let typed = text[ks..offset].trim_start_matches('"').to_string();
                    let present = fields.iter().filter(|(n, _)| n != name).map(|(n, _)| n.clone()).collect();
                    return Some(Spot::Key { start: ks, end: ke, typed, present });
                }
            }
            for (name, v) in fields {
                if child(v) {
                    stack.push((v, Some(name.as_str())));
                    return locate(text, v, offset, stack);
                }
            }
            let present = fields.iter().map(|(n, _)| n.clone()).collect();
            Some(Spot::Key { start: offset, end: offset, typed: String::new(), present })
        }
        Json::Array(items) => {
            for v in items {
                if child(v) {
                    stack.push((v, None));
                    return locate(text, v, offset, stack);
                }
            }
            Some(Spot::Item { at: offset })
        }
        _ => None,
    }
}

fn value_spot(text: &str, node: &Node, offset: usize) -> Option<Spot> {
    if node.start == node.end {
        return Some(Spot::Value { start: offset, end: offset, typed: String::new() });
    }
    let quoted = text.as_bytes().get(node.start) == Some(&b'"');
    let from = if quoted { node.start + 1 } else { node.start };
    let typed = text.get(from..offset.max(from)).unwrap_or_default().to_string();
    Some(Spot::Value { start: node.start, end: node.end, typed })
}

impl<'d> Checker<'d> {
    /// The alternatives of the value on top of `stack`, following the schema from the root
    /// through each key and list element on the way.
    fn along(&self, schema: &'d Ty, stack: &Path) -> Vec<Alt<'d>> {
        let mut alts = self.r.resolve(schema, &self.r.empty, &stack[..1], false, 0);
        for i in 1..stack.len() {
            let (node, key) = stack[i];
            let mut next: Vec<(&'d Ty, Rc<Scope<'d>>)> = Vec::new();
            for alt in &alts {
                match (alt, key) {
                    (Alt::Any, _) => return vec![Alt::Any],
                    (Alt::Struct { fields, open, .. }, Some(name)) => {
                        match self.r.field(fields, name, &stack[..i]) {
                            Some((t, s, _)) => next.push((t, s)),
                            None if *open => return vec![Alt::Any],
                            None => {}
                        }
                    }
                    (Alt::Leaf(Ty::List { item, .. }, s, _), None) => next.push((item, s.clone())),
                    (Alt::Leaf(Ty::Tuple(items), s, _), None) => {
                        if let Json::Array(siblings) = &stack[i - 1].0.json
                            && let Some(t) = siblings.iter().position(|x| std::ptr::eq(x, node)).and_then(|p| items.get(p))
                        {
                            next.push((t, s.clone()));
                        }
                    }
                    _ => {}
                }
            }
            alts = next.into_iter().flat_map(|(t, s)| self.r.resolve(t, &s, &stack[..=i], false, 0)).collect();
        }
        alts
    }

    /// The values an alternative offers: literal text and whether it is written as a string.
    fn values(&self, alt: &Alt<'d>, project_ids: &dyn Fn(Kind) -> Vec<String>) -> Vec<(String, bool)> {
        let Alt::Leaf(ty, _, outer) = alt else { return Vec::new() };
        match ty {
            Ty::Boolean => vec![("true".into(), false), ("false".into(), false)],
            Ty::Literal { value, .. } => vec![lit_text(value)],
            Ty::Enum { values, .. } => values.iter().map(lit_text).collect(),
            Ty::String { id, .. } => match id.as_deref().or(*outer) {
                Some(attr) => self.ids(attr, project_ids).into_iter().map(|s| (s, true)).collect(),
                None => Vec::new(),
            },
            _ => Vec::new(),
        }
    }

    fn ids(&self, attr: &IdAttr, project_ids: &dyn Fn(Kind) -> Vec<String>) -> Vec<String> {
        let Some(registry) = attr.registry.as_deref() else { return Vec::new() };
        let mut out: Vec<String> = Vec::new();
        if attr.tags != Tags::Required && attr.tags != Tags::Implicit {
            if let Some(kind) = self.data.file_kind(registry) {
                out.extend(project_ids(kind));
                out.extend(self.data.vanilla_json(kind).into_iter().flatten().cloned());
                if kind == crate::facts::kind::DIMENSION {
                    out.extend(crate::data::DIMENSIONS.iter().map(|d| d.to_string()));
                }
            } else if let Some(ids) = self.data.registries.get(&format!("minecraft:{registry}")) {
                out.extend(ids.iter().cloned());
            }
        }
        if attr.tags != Tags::No
            && let Some(kind) = self.data.file_kind(&format!("tag/{registry}"))
        {
            let prefix = if attr.tags == Tags::Implicit { "" } else { "#" };
            let tags = project_ids(kind).into_iter().chain(self.data.vanilla_json(kind).into_iter().flatten().cloned());
            out.extend(tags.map(|t| format!("{prefix}{t}")));
        }
        out.sort();
        out.dedup();
        out
    }
}

fn lit_text(lit: &Lit) -> (String, bool) {
    match lit {
        Lit::Bool(b) => (b.to_string(), false),
        Lit::Num(n) => (if n.fract() == 0.0 { format!("{}", *n as i64) } else { n.to_string() }, false),
        Lit::Str(s) => (s.clone(), true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `code message` of each diagnostic, then `ref kind id` of each reference.
    fn run(kind: Kind, text: &str) -> Vec<String> {
        run_in("1.20.4", kind, text)
    }

    fn run_in(version: &str, kind: Kind, text: &str) -> Vec<String> {
        let data = crate::data::for_version(version).unwrap();
        let doc = &data.mcdoc;
        let c = check(text, reading(kind), &schema(kind, doc).unwrap(), doc, data);
        let mut out: Vec<String> = c.diags.iter().map(|d| format!("{} {}", d.code, d.message)).collect();
        out.extend(c.refs.iter().map(|r| format!("ref {} {}", r.kind, r.id)));
        out
    }

    #[test]
    fn predicates_follow_the_condition_dispatcher() {
        assert!(run("predicate", r#"{"condition": "minecraft:random_chance", "chance": 0.5}"#).is_empty());
        assert_eq!(
            run("predicate", r#"{"condition": "random_chance", "chancee": 0.5}"#),
            ["jsonUnknownKey Unknown key “chancee”", "jsonMissingKey Missing key “chance”"]
        );
        assert_eq!(run("predicate", r#"{"condition": "random_chance", "chance": 2}"#), ["jsonRange Expected a number in 0..1"]);
        assert_eq!(
            run("predicate", r#"[{"condition": "nope"}]"#),
            ["undeclaredSymbol Cannot find loot_condition_type “minecraft:nope”"]
        );
        assert_eq!(run("predicate", r#"{"condition": "reference", "name": "t:p"}"#), ["ref predicate t:p"]);
    }

    #[test]
    fn nbt_in_json_takes_a_number_for_a_boolean() {
        let spawner = |entity: &str| format!(r#"{{"spawn_potentials": [{{"data": {{"entity": {entity}}}, "weight": 1}}]}}"#);
        assert!(run_in("1.21.5", "trial_spawner", &spawner(r#"{"id": "minecraft:zombie", "IsBaby": 1}"#)).is_empty());
        assert_eq!(run_in("1.21.5", "trial_spawner", &spawner(r#"{"id": "minecraft:zombie", "IsBaby": "yes"}"#)), ["jsonType Expected a boolean"]);
        let components = |component: &str, value: &str| format!(r#"{{"function": "minecraft:set_components", "components": {{"minecraft:{component}": {value}}}}}"#);
        for v in ["1.21.4", "1.21.5"] {
            for (component, value) in [
                ("entity_data", r#"{"id": "minecraft:item_frame", "Invisible": 1}"#),
                ("entity_data", r#"{"id": "minecraft:pig", "Passengers": [{"id": "minecraft:zombie", "NoAI": 1}]}"#),
                ("bucket_entity_data", r#"{"NoAI": 1}"#),
                ("block_entity_data", r#"{"id": "minecraft:command_block", "auto": 1}"#),
            ] {
                assert!(run_in(v, "item_modifier", &components(component, value)).is_empty(), "{v} {component} {value}");
            }
            assert_eq!(run_in(v, "item_modifier", &components("bucket_entity_data", r#"{"NoAI": "yes"}"#)), ["jsonType Expected a boolean"], "{v}");
        }
        assert_eq!(run_in("1.21.5", "tag/item", r#"{"values": [{"id": "minecraft:stone", "required": 0}]}"#), ["jsonType Expected a boolean"]);
    }

    #[test]
    fn wolf_sounds_have_a_step_sound_from_26_1() {
        let names = ["ambient_sound", "death_sound", "growl_sound", "hurt_sound", "pant_sound", "whine_sound"];
        let set = |step: &str| format!("{{{}{step}}}", names.iter().map(|n| format!(r#""{n}": "entity.wolf.step""#)).collect::<Vec<_>>().join(", "));
        let sounds = |step: &str| format!(r#"{{"adult_sounds": {}, "baby_sounds": {}}}"#, set(step), set(step));
        let step = r#", "step_sound": "entity.wolf.step""#;
        assert!(run_in("26.1", "wolf_sound_variant", &sounds(step)).is_empty());
        assert_eq!(run_in("26.1", "wolf_sound_variant", &sounds("")), ["jsonMissingKey Missing key “step_sound”"; 2]);
        assert_eq!(run_in("1.21.11", "wolf_sound_variant", &set(step)), ["jsonUnknownKey Unknown key “step_sound”"]);
    }

    #[test]
    fn the_map_extending_recipe_of_26_3_transmutes_its_result() {
        let recipe = |result: &str| format!(r##"{{"type": "minecraft:crafting_special_mapextending", "map": "#minecraft:extendable_maps", "material": "minecraft:paper", "result": {result}}}"##);
        let diags = |version: &str, result: &str| run_in(version, "recipe", &recipe(result)).into_iter().filter(|m| !m.starts_with("ref ")).collect::<Vec<_>>();
        assert!(diags("26.3", "{}").is_empty());
        assert!(diags("26.3", r#""minecraft:filled_map""#).is_empty());
        assert_eq!(diags("26.2", "{}"), ["jsonMissingKey Missing key “id”"]);
    }

    #[test]
    fn values_of_the_wrong_shape_name_what_fits() {
        let messages = run("loot_table", r#"{"pools": [{"rolls": "x", "entries": [{"type": "item", "name": "minecraft:not_an_item"}]}]}"#);
        assert_eq!(messages, ["jsonType Expected a float or an object", "undeclaredSymbol Cannot find item “minecraft:not_an_item”"]);
        assert_eq!(
            run("predicate", r#"{"condition": "entity_properties", "entity": "target", "predicate": {}}"#),
            ["jsonType Expected “this”, “killer”, “direct_killer” or “killer_player”"]
        );
    }

    #[test]
    fn tag_entries_resolve_by_registry() {
        assert_eq!(run("tag/item", r##"{"values": ["stone", "#t:gems", "t:custom"]}"##), ["ref tag/item t:gems"]);
        assert_eq!(run("tag/item", r#"{"values": ["minecraft:nope"]}"#), ["undeclaredSymbol Cannot find item “minecraft:nope”"]);
        assert!(run("tag/item", r#"{"values": [{"id": "minecraft:nope", "required": false}]}"#).is_empty());
        assert_eq!(run("tag/item", r#"{"values": [{"id": "minecraft:nope", "required": 0}]}"#), ["jsonType Expected a boolean"]);
        assert_eq!(run("tag/function", r#"{"values": ["t:main"]}"#), ["ref function t:main"]);
    }

    #[test]
    fn a_tag_entry_is_required_as_the_game_codec_reads_it() {
        let cases = [
            ("{id: 'a', required: false}", false),
            ("{id: 'a', required: FALSE}", false),
            ("{id: 'a', required: 0}", false),
            ("{id: 'a', required: 256}", false),
            ("{id: 'a', required: 0.5}", false),
            ("{id: 'a', required: 1}", true),
            ("{id: 'a', required: 'false'}", true),
            ("{id: 'a', required: null}", true),
            ("{id: 'a', required: false, required: true}", true),
            ("{id: 'a'}", true),
        ];
        for (text, required) in cases {
            let entry = json::parse_document(text, Reading::Lenient).unwrap();
            assert_eq!(tag_entry_required(&entry), required, "{text}");
        }
    }

    #[test]
    fn advancements_reference_functions_and_may_omit_the_root_background() {
        let root = r#"{"display": {"icon": {"item": "stone"}, "title": "a", "description": "b"}, "criteria": {"a": {"trigger": "tick"}}, "rewards": {"function": "t:reward"}}"#;
        assert_eq!(run("advancement", root), ["ref function t:reward"]);
    }

    #[test]
    fn objectives_and_teams_in_predicates_are_references() {
        let scores = r#"{"condition": "entity_scores", "entity": "this", "scores": {"Hp": 1}}"#;
        assert_eq!(run("predicate", scores), ["ref objective Hp"]);
        let team = r#"{"condition": "entity_properties", "entity": "this", "predicate": {"team": "red"}}"#;
        assert_eq!(run("predicate", team), ["ref team red"]);
        let number = r#"{"condition": "value_check", "value": {"type": "score", "target": "this", "score": "Mp"}, "range": 1}"#;
        assert_eq!(run("predicate", number), ["ref objective Mp"]);
    }

    #[test]
    fn an_id_on_a_reference_lets_enum_values_omit_the_namespace() {
        let messages = run("dimension_type", r#"{"effects": "minecraft:overworld"}"#);
        assert!(!messages.iter().any(|m| m.contains("overworld")), "{messages:?}");
    }

    #[test]
    fn syntax_errors_stop_the_check() {
        let malformed = "jsonSyntax Malformed JSON (strings need double quotes; comments and single quotes are not allowed)";
        assert_eq!(run("predicate", "{'condition': 'random_chance', 'chance': 0.5}"), [malformed]);
        assert_eq!(run("predicate", "// a comment\n{}"), [malformed]);
        assert_eq!(run("tag/block", "{\"values\": []} {}"), ["jsonSyntax Unexpected content after the JSON value"]);
    }

    #[test]
    fn an_item_predicate_may_count_the_items() {
        let equipment = r#"{"condition": "entity_properties", "entity": "this", "predicate": {"equipment": {"mainhand": {"items": ["minecraft:stone"], "count": {"min": 2}}}}}"#;
        assert!(run("predicate", equipment).is_empty());
    }

    #[test]
    fn special_crafting_recipes_take_a_category() {
        assert!(run("recipe", r#"{"type": "minecraft:crafting_special_armordye", "category": "misc"}"#).is_empty());
        assert!(run("recipe", r#"{"type": "minecraft:crafting_decorated_pot", "category": "misc"}"#).is_empty());
        assert_eq!(run("recipe", r#"{"type": "minecraft:crafting_special_repairitem", "categry": "misc"}"#), ["jsonUnknownKey Unknown key “categry”"]);
    }

    #[test]
    fn a_trailing_comma_is_named_as_such() {
        let advancement = r#"{"criteria": {"a": {"trigger": "minecraft:tick"}}, "requirements": [["a"],]}"#;
        assert_eq!(run("advancement", advancement), ["jsonSyntax Trailing comma before ']'"]);
        assert_eq!(run("tag/block", r#"{"values": [],}"#), ["jsonSyntax Trailing comma before '}'"]);
        assert_eq!(run("tag/block", r#"{"values": [];}"#), ["jsonSyntax Trailing ';' before '}'"]);
    }

    #[test]
    fn a_comment_after_the_value_of_a_lenient_file_is_an_error() {
        assert_eq!(run("tag/block", "// before\n{\"values\": []} // after"), ["jsonSyntax Unexpected content after the JSON value"]);
    }

    #[test]
    fn an_unquoted_string_is_marked_over_its_whole_text() {
        let data = crate::data::for_version("1.20.4").unwrap();
        let text = "{values: [nope]}";
        let c = check(text, Reading::Lenient, &schema("tag/block", &data.mcdoc).unwrap(), &data.mcdoc, data);
        let spans: Vec<&str> = c.diags.iter().map(|d| &text[d.start as usize..d.end as usize]).collect();
        assert_eq!(spans, ["nope"]);
    }

    #[test]
    fn each_kind_is_read_as_the_game_reads_it() {
        assert!(run("predicate", "{\"condition\": \"random_chance\", \"chance\": 0.5} {}").is_empty());
        let lenient = "/* stones */ {values = ['stone'; \"#minecraft:logs\",] # end\n}";
        assert_eq!(run("tag/block", lenient), ["jsonType Expected a string or an object", "ref tag/block minecraft:logs"]);
        assert!(run("predicate", "\u{feff}{\"condition\": \"random_chance\", \"chance\": 0.5}").is_empty());
    }

    /// The labels offered where `|` stands, with `t:main` as the project's only function.
    fn offered(kind: Kind, text: &str) -> Vec<String> {
        let data = crate::data::for_version("1.20.4").unwrap();
        let doc = &data.mcdoc;
        let offset = text.find('|').unwrap();
        let text = text.replace('|', "");
        let ids = |k: Kind| if k == "function" { vec!["t:main".to_string()] } else { Vec::new() };
        complete(&text, offset, &schema(kind, doc).unwrap(), doc, data, &ids).into_iter().map(|s| s.insert).collect()
    }

    #[test]
    fn keys_follow_the_dispatcher_and_skip_the_present_ones() {
        let keys = offered("predicate", r#"{"condition": "random_chance", "|"#);
        assert_eq!(keys, ["\"chance\""]);
        let keys = offered("loot_table", r#"{"pools": [{"rol|"#);
        assert_eq!(keys, ["\"rolls\""]);
    }

    #[test]
    fn keys_of_a_map_by_id_come_from_the_registry() {
        let keys = offered("predicate", r#"{"condition": "entity_properties", "entity": "this", "predicate": {"effects": {"minecraft:spe|"#);
        assert!(keys.contains(&"\"minecraft:speed\"".to_string()), "{keys:?}");
        let keys = offered("predicate", r#"{"condition": "entity_properties", "entity": "this", "predicate": {"effects": {"speed": {}, "minecraft:spe|"#);
        assert!(!keys.contains(&"\"minecraft:speed\"".to_string()), "{keys:?}");
    }

    #[test]
    fn values_come_from_registries_enums_booleans_and_the_project() {
        assert!(offered("predicate", r#"{"condition": "|"}"#).contains(&"\"minecraft:random_chance\"".to_string()));
        assert!(offered("predicate", r#"{"condition": "ran|"}"#).contains(&"\"minecraft:random_chance\"".to_string()));
        assert_eq!(
            offered("predicate", r#"{"condition": "entity_properties", "entity": "k|"}"#),
            ["\"killer\"", "\"killer_player\""]
        );
        assert!(offered("tag/item", r#"{"values": ["sto|"#).contains(&"\"minecraft:stone\"".to_string()));
        assert_eq!(offered("trim_pattern", r#"{"decal": |}"#), ["true", "false"]);
        assert_eq!(offered("advancement", r#"{"rewards": {"function": "|"}}"#), ["\"t:main\""]);
    }}
