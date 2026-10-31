//! Completion for one command line. Walks the command tree like `command::parse_command`
//! up to the cursor and lists what may come next there. Only the language server calls it.

use std::collections::{BTreeSet, HashMap, HashSet};

use crate::args::nbt_check::{self, Category as NbtCategory, Target};
use crate::args::{self, ArgCtx, ArgValue, PathNode};
use crate::command::Effect;
use crate::config::Config;
use crate::data::{DIMENSIONS, VersionData};
use crate::facts::{Kind, full_id, kind};
use crate::reader::Reader;
use crate::tree::{NodeId, NodeKind, Parser, ROOT, StringKind};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    /// The text that replaces the line from `start` up to the cursor.
    pub label: String,
    /// Byte offset in the line where the replaced text starts.
    pub start: usize,
    pub category: Category,
    /// Where the candidate comes from: a symbol kind (`function`) or a registry (`item`).
    pub detail: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Category {
    Keyword,
    Selector,
    /// A symbol of the project or the vanilla data (function, objective, loot table, ...).
    Symbol,
    /// A part of an id that ends at `/` or `:`: more ids continue after it.
    Folder,
    /// A registry id or a fixed value.
    Value,
    /// A selector option or a block state property.
    Property,
    Coordinates,
}

/// What the project offers to the edited file.
pub trait Source {
    /// Ids of a symbol kind that the edited file may reference.
    fn symbols(&self, kind: Kind) -> Vec<String>;
    /// NBT paths that the project uses in a storage, such as `Return.Difficulty`.
    fn storage_paths(&self, storage: &str) -> Vec<String>;
}

/// Candidates for the cursor at the end of `line`, the text of the line before the cursor.
pub fn complete(line: &str, data: &VersionData, config: &Config, source: &dyn Source) -> Vec<Candidate> {
    let indent = line.len() - line.trim_start_matches([' ', '\t']).len();
    let rest = &line[indent..];
    if rest.starts_with('#') {
        return Vec::new();
    }
    let start = indent + usize::from(rest.starts_with('$'));
    let mut w = Walker { data, config, src: &line[start..], source, out: Vec::new() };
    w.children(ROOT, 0, &mut Vec::new(), &mut Vec::new());
    let mut out = w.out;
    for c in &mut out {
        c.start += start;
    }
    out.sort_by(|a, b| (a.start, &a.label).cmp(&(b.start, &b.label)));
    out.dedup_by(|a, b| a.start == b.start && a.label == b.label);
    out
}

/// The usage of the command at the cursor: the nodes already typed, then what may follow.
#[derive(Debug, PartialEq, Eq)]
pub struct Signature {
    pub label: String,
    /// Byte ranges of the parts of `label`, one per node.
    pub parts: Vec<(usize, usize)>,
    /// The part the cursor is in.
    pub active: usize,
}

const MAX_SHOWN_CHOICES: usize = 16;

/// The usage for the cursor at the end of `line`, as `complete` reads the line.
pub fn signature(line: &str, data: &VersionData, config: &Config) -> Option<Signature> {
    let indent = line.len() - line.trim_start_matches([' ', '\t']).len();
    let rest = &line[indent..];
    if rest.starts_with('#') {
        return None;
    }
    let src = &rest[usize::from(rest.starts_with('$'))..];
    let tree = &data.tree;
    let mut typed: Vec<NodeId> = Vec::new();
    let mut node = ROOT;
    let mut pos = 0;
    let mut path: Vec<PathNode> = Vec::new();
    let mut values = Vec::new();
    'walk: loop {
        let n = tree.node(node);
        let word_end = src[pos..].find(' ').map_or(src.len(), |i| pos + i);
        let mut next = None;
        if word_end < src.len() {
            next = n.literals.iter().copied().find(|&c| tree.node(c).name() == &src[pos..word_end]).map(|c| (c, word_end));
        }
        if next.is_none() && word_end < src.len() {
            let saved = values.len();
            for &arg in &n.arguments {
                let a = tree.node(arg);
                let NodeKind::Argument { name, parser } = &a.kind else { continue };
                values.truncate(saved);
                let mut effects = Vec::new();
                let mut reader = Reader { src, pos, base: 0 };
                let mut cx = ArgCtx { data, config, effects: &mut effects, name, path: &path, values: &mut values };
                if args::parse(parser, &mut reader, &mut cx).is_ok() && src.as_bytes().get(reader.pos) == Some(&b' ') {
                    let leaf = a.literals.is_empty() && a.arguments.is_empty() && a.redirect.is_none();
                    if next.is_none() || !leaf {
                        next = Some((arg, reader.pos));
                    }
                    if !leaf {
                        break;
                    }
                }
            }
        }
        let Some((child, end)) = next else { break 'walk };
        let c = tree.node(child);
        match c.redirect {
            Some(ROOT) => {
                typed.clear();
                path.clear();
                values.clear();
                node = ROOT;
            }
            redirect => {
                typed.push(child);
                path.push(PathNode { name: c.name(), literal: matches!(c.kind, NodeKind::Literal(_)) });
                node = redirect.unwrap_or(child);
                if let Some(i) = redirect.and_then(|r| typed.iter().position(|&t| t == r)) {
                    typed.truncate(i + 1);
                }
            }
        }
        pos = end + 1;
    }
    let usage = |id: NodeId| match &tree.node(id).kind {
        NodeKind::Argument { name, .. } => format!("<{name}>"),
        NodeKind::Literal(name) => name.to_string(),
        NodeKind::Root => String::new(),
    };
    let mut segments: Vec<String> = typed.iter().map(|&id| usage(id)).collect();
    let active = segments.len();
    // What may follow: one choice is shown with the single choices after it; several in parentheses.
    let mut at = node;
    for _ in 0..8 {
        let n = tree.node(at);
        let children: Vec<NodeId> = n.literals.iter().chain(&n.arguments).copied().collect();
        match children.as_slice() {
            [] => break,
            [only] => {
                segments.push(usage(*only));
                at = tree.node(*only).redirect.unwrap_or(*only);
                if tree.node(*only).redirect.is_some() {
                    break;
                }
            }
            many if many.len() > MAX_SHOWN_CHOICES => {
                segments.push("…".into());
                break;
            }
            many => {
                segments.push(format!("({})", many.iter().map(|&c| usage(c)).collect::<Vec<_>>().join("|")));
                break;
            }
        }
    }
    if typed.is_empty() || segments.len() <= active {
        return None;
    }
    let mut label = String::new();
    let mut parts = Vec::new();
    for s in &segments {
        if !label.is_empty() {
            label.push(' ');
        }
        parts.push((label.len(), label.len() + s.len()));
        label.push_str(s);
    }
    Some(Signature { label, parts, active })
}

struct Walker<'a, 's> {
    data: &'a VersionData,
    config: &'a Config,
    src: &'a str,
    source: &'s dyn Source,
    out: Vec<Candidate>,
}

impl<'a> Walker<'a, '_> {
    fn children(&mut self, node: NodeId, pos: usize, path: &mut Vec<PathNode<'a>>, values: &mut Vec<ArgValue>) {
        let data = self.data;
        let tree = &data.tree;
        let n = tree.node(node);
        let len = self.src.len();
        let word_end = self.src[pos..].find(' ').map_or(len, |i| pos + i);
        let word = &self.src[pos..word_end];
        if word_end == len {
            for &lit in &n.literals {
                let name = tree.node(lit).name();
                if starts_with_ignore_case(name, word) {
                    self.push(name, pos, Category::Keyword, None);
                }
            }
        } else if let Some(&lit) = n.literals.iter().find(|&&c| tree.node(c).name() == word) {
            self.after(lit, word_end, path, values);
            return;
        }
        for &arg in &n.arguments {
            let NodeKind::Argument { name, parser } = &tree.node(arg).kind else { continue };
            let saved = values.len();
            let mut effects = Vec::new();
            let mut reader = Reader { src: self.src, pos, base: 0 };
            let result = {
                let mut cx = ArgCtx { data, config: self.config, effects: &mut effects, name, path, values };
                args::parse(parser, &mut reader, &mut cx)
            };
            match result {
                Ok(()) if reader.pos < len => {
                    if self.src.as_bytes()[reader.pos] == b' ' {
                        self.after(arg, reader.pos, path, values);
                    }
                }
                // The argument reaches the cursor: it is still being typed.
                Ok(()) => {
                    values.truncate(saved);
                    self.argument(parser, name, pos, path, values);
                }
                // The error is in the text after the last space: the part being typed.
                Err(e) if !self.src[(e.start as usize).min(len)..].contains(' ') => {
                    values.truncate(saved);
                    self.argument(parser, name, pos, path, values);
                }
                Err(_) => {}
            }
            values.truncate(saved);
        }
    }

    /// Continues after `node`, which the line has consumed up to the space at `end`.
    fn after(&mut self, node: NodeId, end: usize, path: &mut Vec<PathNode<'a>>, values: &mut Vec<ArgValue>) {
        let data = self.data;
        let tree = &data.tree;
        let n = tree.node(node);
        let next = n.redirect.unwrap_or(node);
        if !tree.node(next).has_children() {
            return;
        }
        if n.redirect == Some(ROOT) {
            self.children(next, end + 1, &mut Vec::new(), &mut Vec::new());
        } else {
            path.push(PathNode { name: n.name(), literal: matches!(n.kind, NodeKind::Literal(_)) });
            self.children(next, end + 1, path, values);
            path.pop();
        }
    }

    /// Candidates for an argument that starts at `pos` and reaches the cursor.
    fn argument(&mut self, parser: &Parser, name: &str, pos: usize, path: &[PathNode<'a>], values: &mut Vec<ArgValue>) {
        let partial = &self.src[pos..];
        match parser {
            Parser::Bool => self.values(&["true", "false"], partial, pos),
            Parser::Gamemode => self.values(args::GAMEMODES, partial, pos),
            Parser::EntityAnchor => self.values(args::ENTITY_ANCHORS, partial, pos),
            Parser::Heightmap => self.values(args::HEIGHTMAPS, partial, pos),
            Parser::TemplateMirror => self.values(args::TEMPLATE_MIRRORS, partial, pos),
            Parser::TemplateRotation => self.values(args::TEMPLATE_ROTATIONS, partial, pos),
            Parser::Color => self.values(args::basic::COLORS, partial, pos),
            Parser::TeamColor => self.values(&args::basic::COLORS[..16], partial, pos),
            Parser::SwingAnimation => self.values(args::basic::SWING_ANIMATIONS, partial, pos),
            Parser::Operation => self.values(&["=", "+=", "-=", "*=", "/=", "%=", "<", ">", "><"], partial, pos),
            Parser::ObjectiveCriteria => self.values(args::basic::SIMPLE_CRITERIA, partial, pos),
            Parser::ScoreboardSlot => self.values(&["list", "sidebar", "below_name"], partial, pos),
            Parser::ItemSlot | Parser::ItemSlots => self.values(ITEM_SLOTS, partial, pos),
            Parser::SlotSource => {
                self.values(ITEM_SLOTS, partial, pos);
                if let Some(k) = self.probe(parser, name, path, values) {
                    self.symbol(k, partial, pos);
                }
            }
            Parser::Swizzle => self.values(&["xyz", "xy", "xz", "yz", "x", "y", "z"], partial, pos),
            Parser::Entity { players_only, .. } => self.selector(partial, pos, *players_only),
            Parser::GameProfile => self.selector(partial, pos, true),
            Parser::ScoreHolder { .. } => {
                if !partial.starts_with('@') {
                    self.ids(&self.source.symbols(kind::SCORE_HOLDER), partial, pos, kind::SCORE_HOLDER);
                    self.values(&["*"], partial, pos);
                }
                self.selector(partial, pos, false);
            }
            Parser::BlockPos | Parser::Vec3 => self.coordinates(&["~ ~ ~", "^ ^ ^"], partial, pos),
            Parser::ColumnPos | Parser::Vec2 | Parser::Rotation => self.coordinates(&["~ ~"], partial, pos),
            Parser::Angle => self.coordinates(&["~"], partial, pos),
            Parser::BlockState => self.block(partial, pos, false),
            Parser::BlockPredicate => self.block(partial, pos, true),
            Parser::ItemStack => self.item(partial, pos, false),
            Parser::ItemPredicate => self.item(partial, pos, true),
            Parser::Particle => self.particle(partial, pos),
            Parser::Function => match partial.strip_prefix('#') {
                Some(rest) => self.tag_ids(&self.source.symbols(kind::FUNCTION_TAG), rest, pos + 1, kind::FUNCTION_TAG),
                None => self.ids(&self.source.symbols(kind::FUNCTION), partial, pos, kind::FUNCTION),
            },
            Parser::Dimension => self.ids(&DIMENSIONS.iter().map(|d| d.to_string()).collect::<Vec<_>>(), partial, pos, kind::DIMENSION),
            Parser::Resource { registry } | Parser::ResourceKey { registry } => match self.probe(parser, name, path, values) {
                Some(k) => self.symbol(k, partial, pos),
                None => self.resource(registry, partial, pos, false),
            },
            Parser::ResourceOrTag { registry } | Parser::ResourceOrTagKey { registry } => {
                self.resource(registry, partial, pos, true)
            }
            Parser::ResourceLocation if name == "sound" => self.registry("minecraft:sound_event", partial, pos),
            Parser::ResourceLocation
            | Parser::ResourceOrId { .. }
            | Parser::Objective
            | Parser::Team
            | Parser::String(StringKind::Word) => {
                if let Some(k) = self.probe(parser, name, path, values) {
                    self.symbol(k, partial, pos);
                }
            }
            Parser::NbtCompoundTag => {
                let target = self.nbt_target(args::nbt::compound_target, name, path, values);
                self.compound(target.as_ref(), partial, pos);
            }
            Parser::NbtPath => {
                if path.iter().rev().find(|n| n.literal).is_some_and(|n| n.name == "storage") {
                    let storage = self.src[..pos].trim_end().rsplit(' ').next().unwrap_or("");
                    self.storage_path(&full_id(storage), partial, pos);
                } else {
                    let target = self.nbt_target(args::nbt::path_target, name, path, values);
                    self.nbt_path(target.as_ref(), partial, pos);
                }
            }
            _ => {}
        }
    }

    /// The schema of an NBT argument, as the analysis finds it.
    fn nbt_target(
        &self,
        find: fn(&ArgCtx) -> Option<Target>,
        name: &str,
        path: &[PathNode<'a>],
        values: &mut Vec<ArgValue>,
    ) -> Option<Target> {
        let mut effects = Vec::new();
        let cx = ArgCtx { data: self.data, config: self.config, effects: &mut effects, name, path, values };
        find(&cx)
    }

    /// Keys of the compound the cursor is in. `text` starts with the outermost `{` at `pos`.
    fn compound(&mut self, target: Option<&Target>, text: &str, pos: usize) {
        let Some(target) = target else { return };
        let Some((steps, key_start)) = compound_cursor(text) else { return };
        let key = &text[key_start..];
        for (name, tag) in nbt_check::keys_at(self.data, target, &step_keys(&steps)) {
            if starts_with_ignore_case(&name, key) {
                self.push(&format!("{name}:"), pos + key_start, Category::Property, Some(tag));
            }
        }
    }

    /// Keys for the last segment of an NBT path into an entity or a block.
    fn nbt_path(&mut self, target: Option<&Target>, text: &str, pos: usize) {
        let Some(target) = target else { return };
        let Some((steps, seg_start)) = path_cursor(text) else { return };
        let segment = &text[seg_start..];
        for (name, tag) in nbt_check::keys_at(self.data, target, &step_keys(&steps)) {
            if starts_with_ignore_case(&name, segment) {
                self.push(&name, pos + seg_start, Category::Property, Some(tag));
            }
        }
    }

    /// The next segment of the paths that the project uses in a storage.
    fn storage_path(&mut self, storage: &str, text: &str, pos: usize) {
        let Some((steps, seg_start)) = path_cursor(text) else { return };
        let parent: Vec<&str> = steps
            .iter()
            .filter_map(|s| match s {
                Step::Key(k) => Some(k.as_str()),
                Step::Element => None,
            })
            .collect();
        let parent = parent.join(".");
        let segment = &text[seg_start..];
        for p in self.source.storage_paths(storage) {
            let rest = if parent.is_empty() { Some(p.as_str()) } else { p.strip_prefix(&parent).and_then(|r| r.strip_prefix('.')) };
            let Some(next) = rest.and_then(|r| r.split('.').next()) else { continue };
            if starts_with_ignore_case(next, segment) {
                self.push(next, pos + seg_start, Category::Property, Some(kind::STORAGE));
            }
        }
    }

    /// The kind of symbol an argument references, found by parsing a sample id with it.
    fn probe(&self, parser: &Parser, name: &str, path: &[PathNode<'a>], values: &mut Vec<ArgValue>) -> Option<Kind> {
        let saved = values.len();
        let mut effects = Vec::new();
        let mut reader = Reader { src: "probe", pos: 0, base: 0 };
        let mut cx = ArgCtx { data: self.data, config: self.config, effects: &mut effects, name, path, values };
        let _ = args::parse(parser, &mut reader, &mut cx);
        values.truncate(saved);
        effects.iter().find_map(|e| match e {
            Effect::Ref(r) | Effect::Write(r) => Some(r.kind),
            _ => None,
        })
    }

    /// The project's ids of a kind, with the vanilla ones it resolves against.
    fn symbol(&mut self, k: Kind, partial: &str, pos: usize) {
        let mut ids = self.source.symbols(k);
        if let Some(vanilla) = self.data.vanilla_json(k) {
            ids.extend(vanilla.iter().cloned());
        }
        self.ids(&ids, partial, pos, k);
    }

    fn resource(&mut self, registry: &str, partial: &str, pos: usize, allow_tag: bool) {
        let short = registry.strip_prefix("minecraft:").unwrap_or(registry);
        if let Some(rest) = partial.strip_prefix('#') {
            if allow_tag {
                let mut tags: Vec<String> = self.data.tags.get(short).map(|s| s.iter().cloned().collect()).unwrap_or_default();
                if let Some(k) = self.data.file_kind(&format!("tag/{short}")) {
                    tags.extend(self.source.symbols(k));
                }
                self.tag_ids(&tags, rest, pos + 1, registry);
            }
            return;
        }
        // The contents of a data pack kind include the project's files.
        if let Some(k) = self.data.file_kind(short) {
            return self.symbol(k, partial, pos);
        }
        let ids: Vec<String> = self.data.registries.get(registry).map(|s| s.iter().cloned().collect()).unwrap_or_default();
        self.ids(&ids, partial, pos, short);
    }

    fn particle(&mut self, partial: &str, pos: usize) {
        if self.data.at_least(&[1, 20, 5])
            && let Some(brace) = partial.find('{')
        {
            let target = Target::new(NbtCategory::Particle, Some(full_id(&partial[..brace])));
            return self.compound(Some(&target), &partial[brace..], pos + brace);
        }
        self.registry("minecraft:particle_type", partial, pos);
    }

    fn registry(&mut self, registry: &str, partial: &str, pos: usize) {
        let ids: Vec<String> = self.data.registries.get(registry).map(|s| s.iter().cloned().collect()).unwrap_or_default();
        self.ids(&ids, partial, pos, registry.strip_prefix("minecraft:").unwrap_or(registry));
    }

    fn block(&mut self, partial: &str, pos: usize, predicate: bool) {
        if let Some(brace) = partial.find('{') {
            if !partial.starts_with('#') {
                let id = full_id(&partial[..partial.find('[').unwrap_or(brace)]);
                self.compound(Some(&Target::new(NbtCategory::Block, Some(id))), &partial[brace..], pos + brace);
            }
            return;
        }
        if let Some(open) = partial.find('[') {
            if partial.starts_with('#') || partial[open..].contains(']') {
                return;
            }
            let id = full_id(&partial[..open]);
            let Some(props) = self.data.blocks.get(&id) else { return };
            let inner_start = open + 1;
            let seg_start = partial[inner_start..].rfind(',').map_or(inner_start, |i| inner_start + i + 1);
            let seg = &partial[seg_start..];
            let seg = seg.trim_start();
            let seg_pos = pos + partial.len() - seg.len();
            match seg.split_once('=') {
                Some((key, value)) => {
                    let value = value.trim_start();
                    if let Some((_, values)) = props.iter().find(|(k, _)| k == key.trim_end()) {
                        let values: Vec<&str> = values.iter().map(String::as_str).collect();
                        self.values(&values, value, pos + partial.len() - value.len());
                    }
                }
                None => {
                    let used: HashSet<&str> = partial[inner_start..seg_start].split(',').filter_map(|p| p.split_once('=')).map(|(k, _)| k.trim()).collect();
                    for (key, _) in props {
                        if !used.contains(key.as_str()) && starts_with_ignore_case(key, seg) {
                            self.push(&format!("{key}="), seg_pos, Category::Property, None);
                        }
                    }
                }
            }
            return;
        }
        if predicate && let Some(rest) = partial.strip_prefix('#') {
            let mut tags = self.source.symbols(kind::BLOCK_TAG);
            tags.extend(self.data.tags.get("block").into_iter().flatten().cloned());
            self.tag_ids(&tags, rest, pos + 1, kind::BLOCK_TAG);
            return;
        }
        self.registry("minecraft:block", partial, pos);
    }

    fn item(&mut self, partial: &str, pos: usize, predicate: bool) {
        if self.data.at_least(&[1, 20, 5]) {
            return self.item_components(partial, pos, predicate);
        }
        if let Some(brace) = partial.find('{') {
            if !partial.starts_with('#') {
                let id = full_id(&partial[..brace]);
                self.compound(Some(&Target::new(NbtCategory::Item, Some(id))), &partial[brace..], pos + brace);
            }
            return;
        }
        if predicate && let Some(rest) = partial.strip_prefix('#') {
            let mut tags = self.source.symbols(kind::ITEM_TAG);
            tags.extend(self.data.tags.get("item").into_iter().flatten().cloned());
            self.tag_ids(&tags, rest, pos + 1, kind::ITEM_TAG);
            return;
        }
        self.registry("minecraft:item", partial, pos);
    }

    /// An item stack or predicate of 1.20.5 and later: the item, then the component (or
    /// predicate) being typed inside `[...]`, or its SNBT value after `=` (`~`).
    fn item_components(&mut self, partial: &str, pos: usize, predicate: bool) {
        let Some(open) = partial.find('[') else {
            if predicate && let Some(rest) = partial.strip_prefix('#') {
                let mut tags = self.source.symbols(kind::ITEM_TAG);
                tags.extend(self.data.tags.get("item").into_iter().flatten().cloned());
                return self.tag_ids(&tags, rest, pos + 1, kind::ITEM_TAG);
            }
            if predicate {
                self.values(&["*"], partial, pos);
            }
            return self.registry("minecraft:item", partial, pos);
        };
        let separators: &[u8] = if predicate { b",|" } else { b"," };
        let (mut depth, mut quote, mut seg_start) = (0, None, open + 1);
        for (i, b) in partial.bytes().enumerate().skip(open + 1) {
            match (quote, b) {
                (Some(q), _) if b == q => quote = None,
                (Some(_), _) => {}
                (None, b'"' | b'\'') => quote = Some(b),
                (None, b'{' | b'[') => depth += 1,
                (None, b'}' | b']') => depth -= 1,
                (None, _) if depth == 0 && separators.contains(&b) => seg_start = i + 1,
                _ => {}
            }
        }
        if depth < 0 {
            return;
        }
        let seg = partial[seg_start..].trim_start();
        let seg = seg.strip_prefix('!').unwrap_or(seg);
        let seg_pos = pos + partial.len() - seg.len();
        let predicates = if self.data.at_least(&[1, 21, 5]) { "minecraft:data_component_predicate_type" } else { "minecraft:item_sub_predicate_type" };
        match seg.find(['=', '~']) {
            Some(op) => {
                let value = seg[op + 1..].trim_start();
                if value.starts_with('{') {
                    let category = if &seg[op..=op] == "~" { NbtCategory::ComponentPredicate } else { NbtCategory::DataComponent };
                    let target = Target::new(category, Some(full_id(seg[..op].trim_end())));
                    self.compound(Some(&target), value, pos + partial.len() - value.len());
                }
            }
            None => {
                self.registry("minecraft:data_component_type", seg, seg_pos);
                if predicate {
                    self.registry(predicates, seg, seg_pos);
                    self.ids(&["minecraft:count".to_string()], seg, seg_pos, "data_component_type");
                }
            }
        }
    }

    fn selector(&mut self, partial: &str, pos: usize, players_only: bool) {
        let Some(open) = partial.find('[') else {
            if partial.is_empty() || partial.starts_with('@') {
                let types: &[&str] = if players_only { &["@a", "@p", "@r", "@s"] } else { &["@a", "@e", "@p", "@r", "@s"] };
                for t in types {
                    if starts_with_ignore_case(t, partial) {
                        self.push(t, pos, Category::Selector, None);
                    }
                }
            }
            return;
        };
        let inner = open + 1;
        // The option being typed starts after the last ',' or '[' outside braces and quotes.
        let mut depth = 0;
        let mut quote = None;
        let mut seg_start = inner;
        for (i, b) in partial.bytes().enumerate().skip(inner) {
            match (quote, b) {
                (Some(q), _) if b == q => quote = None,
                (Some(_), _) => {}
                (None, b'"' | b'\'') => quote = Some(b),
                (None, b'{' | b'[') => depth += 1,
                (None, b'}' | b']') if depth == 0 => return,
                (None, b'}' | b']') => depth -= 1,
                (None, b',') if depth == 0 => seg_start = i + 1,
                _ => {}
            }
        }
        let seg = partial[seg_start..].trim_start();
        let seg_pos = pos + partial.len() - seg.len();
        let Some((key, value)) = seg.split_once('=') else {
            for option in args::entity::SELECTOR_OPTIONS {
                if starts_with_ignore_case(option, seg) {
                    self.push(&format!("{option}="), seg_pos, Category::Property, None);
                }
            }
            return;
        };
        let value = value.trim_start();
        let value = value.strip_prefix('!').unwrap_or(value).trim_start();
        let value_pos = pos + partial.len() - value.len();
        match key.trim_end() {
            "type" => match value.strip_prefix('#') {
                Some(rest) => {
                    let mut tags = self.source.symbols(kind::ENTITY_TYPE_TAG);
                    tags.extend(self.data.tags.get("entity_type").into_iter().flatten().cloned());
                    self.tag_ids(&tags, rest, value_pos + 1, kind::ENTITY_TYPE_TAG);
                }
                None => self.registry("minecraft:entity_type", value, value_pos),
            },
            "tag" => self.ids(&self.source.symbols(kind::ENTITY_TAG), value, value_pos, kind::ENTITY_TAG),
            "team" => self.ids(&self.source.symbols(kind::TEAM), value, value_pos, kind::TEAM),
            "gamemode" => self.values(args::GAMEMODES, value, value_pos),
            "sort" => self.values(args::entity::SORTS, value, value_pos),
            "predicate" => self.symbol(kind::PREDICATE, value, value_pos),
            "nbt" if value.starts_with('{') => {
                let target = Target::new(NbtCategory::Entity, selector_type(&partial[inner..seg_start]));
                self.compound(Some(&target), value, value_pos);
            }
            "scores" | "advancements" => {
                let Some(body) = value.strip_prefix('{') else { return };
                let entry_start = body.rfind(',').map_or(0, |i| i + 1);
                let entry = body[entry_start..].trim_start();
                if entry.contains('=') {
                    return;
                }
                let entry_pos = pos + partial.len() - entry.len();
                if key.trim_end() == "scores" {
                    self.ids(&self.source.symbols(kind::OBJECTIVE), entry, entry_pos, kind::OBJECTIVE);
                } else {
                    self.symbol(kind::ADVANCEMENT, entry, entry_pos);
                }
            }
            _ => {}
        }
    }

    fn coordinates(&mut self, forms: &[&str], partial: &str, pos: usize) {
        for f in forms {
            if f.starts_with(partial) {
                self.push(f, pos, Category::Coordinates, None);
            }
        }
    }

    fn values(&mut self, values: &[&str], partial: &str, pos: usize) {
        for v in values {
            if starts_with_ignore_case(v, partial) {
                self.push(v, pos, Category::Value, None);
            }
        }
    }

    /// Tags: `ids` without `#`, `partial` after the `#` at `pos - 1`.
    fn tag_ids(&mut self, ids: &[String], partial: &str, pos: usize, detail: &str) {
        let before = self.out.len();
        self.ids(ids, partial, pos, detail);
        for c in &mut self.out[before..] {
            c.label.insert(0, '#');
            c.start -= 1;
        }
    }

    /// Full ids filtered by the typed text. Ids in `minecraft:` also match without the
    /// namespace. A candidate stops after the next `:` or `/`, so that a long list of ids
    /// comes one level at a time.
    fn ids(&mut self, ids: &[String], partial: &str, pos: usize, detail: &str) {
        let category = if detail.starts_with("minecraft:") || self.data.registries.contains_key(&format!("minecraft:{detail}")) {
            Category::Value
        } else {
            Category::Symbol
        };
        let mut seen = HashSet::new();
        for id in ids {
            let short = id.strip_prefix("minecraft:");
            for form in [Some(id.as_str()), short].into_iter().flatten() {
                let Some(rest) = strip_prefix_ignore_case(form, partial) else { continue };
                let (label, category) = match rest.find([':', '/']) {
                    Some(i) => (&form[..partial.len() + i + 1], Category::Folder),
                    None => (form, category),
                };
                if seen.insert(label) {
                    self.push(label, pos, category, Some(detail));
                }
            }
        }
    }

    fn push(&mut self, label: &str, start: usize, category: Category, detail: Option<&str>) {
        self.out.push(Candidate { label: label.to_string(), start, category, detail: detail.map(str::to_string) });
    }
}

/// `text` without `prefix`, comparing ASCII letters without case.
fn strip_prefix_ignore_case<'t>(text: &'t str, prefix: &str) -> Option<&'t str> {
    let head = text.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix).then(|| &text[prefix.len()..])
}

fn starts_with_ignore_case(text: &str, prefix: &str) -> bool {
    strip_prefix_ignore_case(text, prefix).is_some()
}
/// A step from a compound to a tag inside it.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Step {
    Key(String),
    /// An element of a list.
    Element,
}

/// For the cursor at the end of SNBT `text` (starting with `{`): the steps to the compound
/// the cursor is in, and the offset where the key being typed starts. `None` when the cursor
/// is not where a key goes.
fn compound_cursor(text: &str) -> Option<(Vec<Step>, usize)> {
    enum Frame {
        Compound { key: Option<String>, at_key: bool, token: usize },
        List,
    }
    let bytes = text.as_bytes();
    let mut frames: Vec<Frame> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            q @ (b'"' | b'\'') => i += text[i + 1..].find(q as char)? + 1,
            b'{' => frames.push(Frame::Compound { key: None, at_key: true, token: i + 1 }),
            b'[' => frames.push(Frame::List),
            b'}' | b']' => {
                frames.pop()?;
            }
            b':' => {
                if let Some(Frame::Compound { key, at_key, token }) = frames.last_mut()
                    && *at_key
                {
                    *key = Some(unquote(text[*token..i].trim()).to_string());
                    *at_key = false;
                }
            }
            b',' => {
                if let Some(Frame::Compound { key, at_key, token }) = frames.last_mut() {
                    *key = None;
                    *at_key = true;
                    *token = i + 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    let Some(Frame::Compound { at_key: true, token, .. }) = frames.last() else { return None };
    let key_start = text.len() - text[*token..].trim_start().len();
    let mut steps = Vec::new();
    for f in &frames[..frames.len() - 1] {
        match f {
            Frame::Compound { key: Some(k), .. } => steps.push(Step::Key(k.clone())),
            Frame::Compound { key: None, .. } => return None,
            Frame::List => steps.push(Step::Element),
        }
    }
    Some((steps, key_start))
}

/// For the cursor at the end of NBT path `text`: the steps before the last segment, and
/// where that segment starts. `None` inside brackets or quotes.
fn path_cursor(text: &str) -> Option<(Vec<Step>, usize)> {
    let bytes = text.as_bytes();
    let mut steps = Vec::new();
    let mut seg = 0;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            q @ (b'"' | b'\'') => i += text[i + 1..].find(q as char)? + 1,
            open @ (b'[' | b'{') => {
                if i > seg {
                    steps.push(Step::Key(unquote(&text[seg..i]).to_string()));
                }
                i = closing(text, i)?;
                if open == b'[' {
                    steps.push(Step::Element);
                }
                seg = i + 1;
            }
            b'.' => {
                if i > seg {
                    steps.push(Step::Key(unquote(&text[seg..i]).to_string()));
                }
                seg = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    Some((steps, seg))
}

/// The index of the bracket that closes the one at `open`.
fn closing(text: &str, open: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut depth = 0;
    let mut i = open;
    while i < bytes.len() {
        match bytes[i] {
            q @ (b'"' | b'\'') => i += text[i + 1..].find(q as char)? + 1,
            b'[' | b'{' => depth += 1,
            b']' | b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

fn top_level_colon(text: &str) -> usize {
    let bytes = text.as_bytes();
    let mut depth = 0;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            q @ (b'"' | b'\'') => match text[i + 1..].find(q as char) {
                Some(close) => i += close + 1,
                None => return text.len(),
            },
            b'[' | b'{' => depth += 1,
            b']' | b'}' => depth -= 1,
            b':' if depth == 0 => return i,
            _ => {}
        }
        i += 1;
    }
    text.len()
}

fn unquote(s: &str) -> &str {
    s.strip_prefix(['"', '\'']).and_then(|s| s.strip_suffix(['"', '\''])).unwrap_or(s)
}

fn step_keys(steps: &[Step]) -> Vec<Option<&str>> {
    steps
        .iter()
        .map(|s| match s {
            Step::Key(k) => Some(k.as_str()),
            Step::Element => None,
        })
        .collect()
}

/// The entity type a selector's options fix with `type=`.
fn selector_type(options: &str) -> Option<String> {
    options.split(',').find_map(|o| {
        let (k, v) = o.split_once('=')?;
        let v = v.trim();
        (k.trim() == "type" && !v.starts_with(['!', '#'])).then(|| full_id(v))
    })
}

/// Adds the NBT paths that `storage <id> <path>` uses in a function's text, with every
/// prefix (`Return`, `Return.Difficulty`), by storage id. Elements and filters are dropped.
/// IMP-Doc lines such as `# @input storage api: Argument.ID` count as well.
pub fn collect_storage_paths(text: &str, out: &mut HashMap<String, BTreeSet<String>>) {
    let is_id = |s: &str| !s.is_empty() && s.bytes().all(args::is_allowed_in_resource_location);
    for line in text.lines() {
        let tokens: Vec<&str> = line.split(' ').collect();
        for w in tokens.windows(3) {
            if w[0] != "storage" || !is_id(w[1]) || !w[2].is_ascii() || w[2].starts_with('{') || w[2].contains("$(") {
                continue;
            }
            let path = w[2][..top_level_colon(w[2])].trim_end_matches('?');
            let Some((steps, seg)) = path_cursor(path) else { continue };
            let mut keys: Vec<&str> = steps
                .iter()
                .filter_map(|s| match s {
                    Step::Key(k) => Some(k.as_str()),
                    Step::Element => None,
                })
                .collect();
            let last = unquote(&path[seg..]);
            if !last.is_empty() {
                keys.push(last);
            }
            if keys.iter().any(|k| !k.bytes().all(crate::reader::is_allowed_in_unquoted)) {
                continue;
            }
            let set = out.entry(full_id(w[1])).or_default();
            for n in 1..=keys.len() {
                set.insert(keys[..n].join("."));
            }
        }
    }
}

const ITEM_SLOTS: &[&str] = &[
    "weapon", "weapon.mainhand", "weapon.offhand", "armor.head", "armor.chest", "armor.legs", "armor.feet",
    "horse.saddle", "horse.armor", "horse.chest", "container.", "hotbar.", "inventory.", "enderchest.", "villager.",
    "horse.",
];

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake;

    impl Source for Fake {
        fn symbols(&self, k: Kind) -> Vec<String> {
            match k {
                kind::FUNCTION => vec!["example:item/sword/use".into(), "example:item/bow/use".into(), "example:tick".into()],
                kind::FUNCTION_TAG => vec!["example:item/use".into()],
                kind::OBJECTIVE => vec!["Temporary".into(), "Const".into()],
                kind::SCORE_HOLDER => vec!["$Difficulty".into()],
                kind::STORAGE => vec!["example:temp".into(), "api:".into()],
                kind::ENTITY_TAG => vec!["Enemy".into()],
                kind::ADVANCEMENT => vec!["example:first_join".into()],
                kind::DAMAGE_TYPE => vec!["example:magic".into()],
                "enchantment" => vec!["example:sharp".into()],
                "dialog" => vec!["example:menu".into()],
                "slot_source" => vec!["example:hands".into()],
                "worldgen/biome" => vec!["example:glade".into()],
                "tag/worldgen/biome" => vec!["example:warm".into()],
                _ => Vec::new(),
            }
        }

        fn storage_paths(&self, storage: &str) -> Vec<String> {
            let mut out = HashMap::new();
            collect_storage_paths(
                concat!(
                    "data modify storage api: Argument.ID set value 1\n",
                    "# @input storage api: Return.Difficulty : int\n",
                    "execute store result storage api: Argument.Damage[0].Amount int 1 run say\n",
                    "#   storage lib: Array: [int] @ N\n",
                    "#   storage lib: Argument.BoundingCone.Angle: float\n",
                    "# see storage lib: Note, then\n",
                    "#   storage api: Argument.Silent? : boolean(default: false)\n",
                    "#   storage api: Argument.Attacker?: int (entity id)\n",
                ),
                &mut out,
            );
            out.get(storage).map(|s| s.iter().cloned().collect()).unwrap_or_default()
        }
    }

    fn labels(line: &str) -> Vec<(String, usize)> {
        let data = crate::data::for_version("1.20.4").unwrap();
        complete(line, data, &Config::default(), &Fake).into_iter().map(|c| (c.label, c.start)).collect()
    }

    fn has(line: &str, label: &str, start: usize) -> bool {
        labels(line).contains(&(label.to_string(), start))
    }

    fn has_in(version: &str, line: &str, label: &str, start: usize) -> bool {
        let data = crate::data::for_version(version).unwrap();
        complete(line, data, &Config::default(), &Fake).into_iter().any(|c| c.label == label && c.start == start)
    }

    #[test]
    fn data_pack_ids_of_resource_arguments_include_the_project() {
        assert!(has("damage @s 1 example:", "example:magic", 12));
        assert!(has_in("1.21.2", "advancement grant @s only example:", "example:first_join", 26));
        assert!(has_in("1.21.2", "advancement grant @s only ", "minecraft:", 26));
        assert!(has_in("26.3", "summon zomb", "zombie", 7));
        assert!(has_in("1.21", "enchant @s example:", "example:sharp", 11));
        assert!(has_in("1.21", "enchant @s minecraft:", "minecraft:sharpness", 11));
        assert!(!has_in("1.20.4", "enchant @s example:", "example:sharp", 11));
        assert!(has_in("26.3", "dialog show @s example:", "example:menu", 15));
        assert!(has_in("26.3", "execute if items entity @s example:", "example:hands", 27));
        assert!(has_in("26.3", "execute if items entity @s weap", "weapon", 27));
        assert!(has("locate biome example:", "example:glade", 13));
        assert!(has("locate biome minecraft:pl", "minecraft:plains", 13));
        assert!(has("locate biome #example:", "#example:warm", 13));
        assert!(has("locate biome #minecraft:is_o", "#minecraft:is_ocean", 13));
    }

    #[test]
    fn literals_of_the_command_tree() {
        assert!(has("exe", "execute", 0));
        assert!(has("scoreboard pl", "players", 11));
        assert!(!has("scoreboard pl", "objectives", 11));
        assert!(has("execute as @s ru", "run", 14));
        assert!(has("execute as @s run fun", "function", 18));
    }

    #[test]
    fn selectors_and_their_options() {
        assert!(has("kill @", "@e", 5));
        assert!(has("kill @e[ty", "type=", 8));
        assert!(has("kill @e[tag=Enemy,ty", "type=", 18));
        assert!(has("kill @e[type=zomb", "zombie", 13));
        assert!(has("kill @e[type=!zomb", "zombie", 14));
        assert!(has("kill @e[type=#", "#skeletons", 13));
        assert!(has("kill @e[type=#", "#minecraft:", 13));
        assert!(has("kill @e[tag=", "Enemy", 12));
        assert!(has("execute if entity @e[scores={Te", "Temporary", 29));
        assert!(has("tp @a[gamemode=sur", "survival", 15));
    }

    #[test]
    fn functions_come_one_level_at_a_time() {
        assert!(has("function ", "example:", 9));
        assert!(has("function example:", "example:item/", 9));
        assert!(has("function example:", "example:tick", 9));
        assert!(!has("function example:", "example:item/sword/use", 9));
        assert!(has("function example:item/sword/", "example:item/sword/use", 9));
        assert!(has("function #example:", "#example:item/", 9));
    }

    #[test]
    fn symbols_follow_the_argument() {
        assert!(has("scoreboard players set @s T", "Temporary", 26));
        assert!(has("scoreboard players set @s temp", "Temporary", 26));
        assert!(has("execute if entity @e[scores={temp", "Temporary", 29));
        assert!(has("scoreboard players get ", "$Difficulty", 23));
        assert!(has("data get storage ", "example:", 17));
        assert!(has("data get storage example:", "example:temp", 17));
        assert!(has("tag @s remove E", "Enemy", 14));
        assert!(labels("scoreboard objectives add N").is_empty());
    }

    #[test]
    fn vanilla_ids_with_or_without_the_namespace() {
        assert!(has("give @s diamond_sw", "diamond_sword", 8));
        assert!(has("give @s minecraft:diamond_sw", "minecraft:diamond_sword", 8));
        assert!(has("loot give @s loot chests/ig", "chests/igloo_chest", 18));
        assert!(has("particle fla", "flame", 9));
        assert!(has("effect give @s minecraft:spe", "minecraft:speed", 15));
    }

    #[test]
    fn block_states() {
        assert!(has("setblock ~ ~ ~ oak_door[fac", "facing=", 24));
        assert!(has("setblock ~ ~ ~ oak_door[facing=north,ha", "half=", 37));
        assert!(!has("setblock ~ ~ ~ oak_door[facing=north,", "facing=", 37));
        assert!(has("setblock ~ ~ ~ oak_door[facing=n", "north", 31));
        assert!(has("execute if block ~ ~ ~ #minecraft:do", "#minecraft:doors", 23));
    }

    #[test]
    fn coordinates_and_fixed_values() {
        assert!(has("tp @s ", "~ ~ ~", 6));
        assert!(has("tp @s ~ ", "~ ~ ~", 6));
        assert!(has("gamemode cr", "creative", 9));
        assert!(has("scoreboard players operation @s Temporary ", "+=", 42));
    }

    fn usage(line: &str) -> Option<(String, String)> {
        let data = crate::data::for_version("1.20.4").unwrap();
        signature(line, data, &Config::default()).map(|s| {
            let (a, b) = s.parts[s.active];
            (s.label.clone(), s.label[a..b].to_string())
        })
    }

    #[test]
    fn signature_shows_the_typed_nodes_and_what_follows() {
        assert_eq!(usage("scoreboard players set @s "), Some(("scoreboard players set <targets> <objective> <score>".into(), "<objective>".into())));
        assert_eq!(usage("scoreboard "), Some(("scoreboard (objectives|players)".into(), "(objectives|players)".into())));
        assert_eq!(usage("execute as @a run tp @s "), usage("tp @s "));
        assert_eq!(usage("# comment"), None);
    }

    #[test]
    fn signature_help_stays_short_after_run_in_execute_chains_and_with_many_choices() {
        assert_eq!(usage("execute as @a run "), None);
        assert_eq!(usage("execute if entity @s run return run "), None);
        assert_eq!(usage(""), None);
        assert_eq!(usage("gamerule "), Some(("gamerule …".into(), "…".into())));
        let execute = "execute (align|anchored|as|at|facing|if|in|on|positioned|rotated|run|store|summon|unless)";
        let next = Some((execute.to_string(), execute["execute ".len()..].to_string()));
        assert_eq!(usage("execute "), next);
        assert_eq!(usage("execute as @a at @s "), next);
        let condition = "(biome|block|blocks|data|dimension|entity|function|loaded|predicate|score)";
        assert_eq!(usage("execute as @a if score @s Global matches 1 if "), Some((format!("execute if {condition}"), condition.into())));
        assert_eq!(
            usage("execute as @a if entity @s[tag=A] store result score @s "),
            Some(("execute store result score <targets> <objective>".into(), "<objective>".into()))
        );
    }

    #[test]
    fn signature_help_follows_the_argument_that_more_can_follow_when_two_read_the_value() {
        assert_eq!(usage("tp @s "), Some(("tp <targets> (<destination>|<location>)".into(), "(<destination>|<location>)".into())));
        assert_eq!(usage("kill @s "), None);
    }

    #[test]
    fn nbt_keys_from_the_schema() {
        assert!(has("summon zombie ~ ~ ~ {NoA", "NoAI:", 21));
        assert!(has("summon zombie ~ ~ ~ {NoAI:1b,Hea", "Health:", 29));
        assert!(has("summon zombie ~ ~ ~ {ArmorItems:[{},{Cou", "Count:", 37));
        assert!(!has("summon zombie ~ ~ ~ {NoAI:", "NoAI:", 21));
        assert!(has("data merge entity @e[type=zombie,limit=1] {IsBa", "IsBaby:", 43));
        assert!(has("data get entity @s Inv", "Inventory", 19));
        assert!(has("data get entity @e[type=zombie,limit=1] ArmorItems[0].Cou", "Count", 54));
        assert!(has("kill @e[nbt={OnGro", "OnGround:", 13));
        assert!(has("give @s diamond_sword{Dam", "Damage:", 22));
        assert!(has("setblock ~ ~ ~ chest{Ite", "Items:", 21));
        assert!(has("summon armor_stand ~ ~ ~ {ArmorItems:[{},{id:\"stone\",tag:{Dam", "Damage:", 58));
        assert!(has("data modify entity @s ArmorItems[0].", "Count", 36));
    }

    #[test]
    fn item_components_and_particle_options_from_1_20_5() {
        assert!(has_in("1.20.5", "give @s diamond_sword[dam", "damage", 22));
        assert!(has_in("26.3", "give @s diamond_sword[damage=1, !enchan", "enchantments", 33));
        assert!(has_in("26.3", "give @s diamond_sword[enchantments={levels:{}},custom_data={}, max_dam", "max_damage", 63));
        assert!(has_in("1.20.5", "give @s diamond_sword[enchantments={lev", "levels:", 36));
        assert!(!has_in("26.3", "give @s diamond_sword{Dam", "Damage:", 22));
        assert!(has_in("26.3", "clear @s *[dam", "damage", 11));
        assert!(has_in("26.3", "clear @s *[custom_data|cou", "count", 23));
        assert!(has_in("26.3", "clear @s *[damage~{dur", "durability:", 19));
        assert!(has_in("1.20.5", "clear @s *[damage~{dur", "durability:", 19));
        assert!(has_in("26.3", "clear @s ", "*", 9));
        assert!(has_in("26.3", "particle dust{sc", "scale:", 14));
        assert!(has_in("26.3", "particle du", "dust", 9));
    }

    #[test]
    fn storage_paths_used_in_the_project() {
        assert!(has("data get storage api: ", "Argument", 22));
        assert!(has("data get storage api: ", "Return", 22));
        assert!(has("data get storage api: Return.", "Difficulty", 29));
        assert!(has("data get storage api: Argument.Damage[0].", "Amount", 41));
        assert!(!has("data get storage example:temp ", "Argument", 30));
    }

    #[test]
    fn storage_paths_as_imp_doc_lines_write_them() {
        assert!(has("data get storage lib: ", "Array", 22));
        assert!(!has("data get storage lib: ", "Array:", 22));
        assert!(has("data get storage lib: Argument.BoundingCone.", "Angle", 44));
        assert!(!has("data get storage lib: Argument.BoundingCone.", "Angle:", 44));
        assert!(!has("data get storage lib: ", "Note,", 22));
        assert!(has("data get storage lib: Arr", "Array", 22));
        assert!(has("data get storage lib: Array", "Array", 22));
        assert!(has("data get storage api: Return.Difficulty", "Difficulty", 29));
        assert!(has("data get storage api: Argument.", "Silent", 31));
        assert!(has("data get storage api: Argument.", "Attacker", 31));
        assert!(!has("data get storage api: Argument.", "Silent?", 31));
    }

    #[test]
    fn indented_macro_and_comment_lines() {
        assert!(has("    function example:", "example:tick", 13));
        assert!(has("$function example:", "example:tick", 10));
        assert!(labels("# function example:").is_empty());
        assert!(labels("#> example:").is_empty());
    }
}
