//! Argument parsers. Each follows the 1.20.4 vanilla parser of the same name and
//! reports references, definitions, and lint diagnostics through `ArgCtx`.

pub mod basic;
mod blockitem;
mod coords;
pub mod entity;
pub mod nbt;
pub mod nbt_check;
mod snbt;
pub mod text;

use crate::command::Effect;
use crate::config::Config;
use crate::data::VersionData;
use crate::diag::{Diagnostic, Severity};
use crate::facts::{Def, Kind, Ref, full_id, kind};
use crate::reader::{PResult, Reader};
use crate::tree::{Parser, StringKind};

pub struct ArgCtx<'a> {
    pub data: &'a VersionData,
    pub config: &'a Config,
    pub effects: &'a mut Vec<Effect>,
    /// The argument node's name (`targets`, `loot_table`, ...).
    pub name: &'a str,
    /// Names of the nodes before this argument in the current command
    /// (after `execute ... run`, only the nodes of the inner command).
    pub path: &'a [PathNode<'a>],
    /// Values recorded by the earlier arguments of the current command.
    pub values: &'a mut Vec<ArgValue>,
}

/// What an argument tells the arguments after it (for example the NBT context).
#[derive(Clone, Debug, PartialEq)]
pub enum ArgValue {
    /// An entity argument: the entity type its NBT is checked against
    /// (`None` when the selector does not fix one).
    Entity(Option<String>),
    /// A registry id such as `summon`'s entity type.
    Id(String),
    /// An NBT path, for the `data modify ... value` tag after it.
    Path(Vec<nbt::NbtPathNode>),
}

#[derive(Clone, Copy, Debug)]
pub struct PathNode<'a> {
    pub name: &'a str,
    pub literal: bool,
}

impl ArgCtx<'_> {
    pub fn prev_literal(&self) -> Option<&str> {
        self.path.iter().rev().find(|n| n.literal).map(|n| n.name)
    }

    /// True when the nodes right before this argument are exactly these literals.
    pub fn follows(&self, literals: &[&str]) -> bool {
        self.path.len() >= literals.len()
            && self.path[self.path.len() - literals.len()..]
                .iter()
                .zip(literals)
                .all(|(n, l)| n.literal && n.name == *l)
    }

    pub fn diag(&mut self, start: u32, end: u32, severity: Severity, code: &'static str, message: impl Into<String>) {
        self.effects.push(Effect::Diag(Diagnostic { start, end, severity, code, message: message.into() }));
    }

    pub fn reference(&mut self, kind: Kind, id: &str, start: u32, end: u32) {
        self.effects.push(Effect::Ref(Ref { kind, id: full_id(id), start, end }));
    }

    /// For symbols that are names rather than resource locations
    /// (score holders, entity tags, objectives, teams).
    pub fn reference_name(&mut self, kind: Kind, name: &str, start: u32, end: u32) {
        self.effects.push(Effect::Ref(Ref { kind, id: name.to_string(), start, end }));
    }

    /// A reference that Spyglass 4 binds as a definition (see `Effect::Write`).
    /// `id` is already normalised.
    pub fn write_reference(&mut self, kind: Kind, id: String, start: u32, end: u32) {
        self.effects.push(Effect::Write(Ref { kind, id, start, end }));
    }

    pub fn define(&mut self, kind: Kind, id: String, start: u32, end: u32) {
        self.effects.push(Effect::Def(Def { kind, id, start, end }));
    }

    /// Reports `name` when it does not follow the naming convention of `rule`
    /// (`nameOfObjectives`, `nameOfTags`, ...).
    pub fn naming(&mut self, rule: &'static str, what: &str, name: &str, start: u32, end: u32) {
        let Some((severity, convention)) = self.config.rule(rule) else { return };
        if !crate::lint::follows_convention(name, convention) {
            let names = crate::lint::convention_names(convention);
            self.diag(start, end, severity, rule, format!("Invalid {what} '{name}' which doesn't follow {names}"));
        }
    }

    /// `stringQuote` / `stringQuoteType` for a quotable string argument.
    pub fn string_quote(&mut self, quoted: Option<u8>, value: &str, start: u32, end: u32) {
        self.quote_rules("stringQuote", "stringQuoteType", quoted, value, start, end);
    }

    /// A pair of quote rules (`<x>Quote` / `<x>QuoteType`) for one string.
    pub fn quote_rules(&mut self, quote_rule: &'static str, type_rule: &'static str, quoted: Option<u8>, value: &str, start: u32, end: u32) {
        let quote = self.config.rule_any(quote_rule).and_then(|(s, v)| v.as_bool().map(|b| (s, b)));
        let quote_type = self.config.rule_any(type_rule).and_then(|(s, v)| v.as_str().map(|t| (s, t.to_string())));
        let problems = crate::lint::string_quote_problems(
            quoted,
            value,
            quote.map(|(_, b)| (quote_rule, b)),
            quote_type.as_ref().map(|(_, t)| (type_rule, t.as_str())),
        );
        for (rule, message) in problems {
            let severity = if rule == quote_rule { quote.map(|q| q.0) } else { quote_type.as_ref().map(|q| q.0) };
            if let Some(severity) = severity {
                self.diag(start, end, severity, rule, message);
            }
        }
    }

    /// Checks an id against a vanilla registry under the matching `strict*Check` rule.
    pub fn check_registry(&mut self, registry: &str, id: &str, start: u32, end: u32) {
        let Some(rule) = registry_rule(registry) else { return };
        let Some((mut severity, mode)) = self.config.rule(rule) else { return };
        let full = full_id(id);
        if mode.as_str() == Some("only-default-namespace") && !full.starts_with("minecraft:") {
            // DHP still hints at such ids; the modified Spyglass is silent.
            if self.config.spyglass {
                return;
            }
            severity = Severity::Hint;
        }
        if !self.data.registry_has(registry, &full) {
            let what = registry.strip_prefix("minecraft:").unwrap_or(registry);
            self.diag(start, end, severity, rule, format!("Failed to resolve {what} '{full}'"));
        }
    }
}

/// The `strict*Check` rule that governs a vanilla registry.
pub fn registry_rule(registry: &str) -> Option<&'static str> {
    Some(match registry {
        "minecraft:block" => "strictBlockCheck",
        "minecraft:item" => "strictItemCheck",
        "minecraft:entity_type" => "strictEntityTypeCheck",
        "minecraft:enchantment" => "strictEnchantmentCheck",
        "minecraft:mob_effect" => "strictMobEffectCheck",
        "minecraft:attribute" => "strictAttributeCheck",
        "minecraft:particle_type" => "strictParticleTypeCheck",
        "minecraft:potion" => "strictPotionCheck",
        "minecraft:sound_event" => "strictSoundEventCheck",
        "minecraft:painting_variant" => "strictMotiveCheck",
        "minecraft:fluid" => "strictFluidCheck",
        "minecraft:dimension_type" => "strictDimensionTypeCheck",
        _ => return None,
    })
}

pub fn is_allowed_in_resource_location(b: u8) -> bool {
    b.is_ascii_digit() || b.is_ascii_lowercase() || matches!(b, b'_' | b':' | b'/' | b'.' | b'-')
}

/// Reads a resource location like `ResourceLocation.read`. Returns the byte
/// position where it started and the raw text.
pub fn read_resource_location<'a>(r: &mut Reader<'a>) -> PResult<(usize, &'a str)> {
    let start = r.pos;
    let text = r.read_while(is_allowed_in_resource_location);
    let (ns, path) = text.split_once(':').unwrap_or(("minecraft", text));
    let ns_ok = ns.bytes().all(|b| b.is_ascii_digit() || b.is_ascii_lowercase() || matches!(b, b'_' | b'.' | b'-'));
    let path_ok = path.bytes().all(|b| b.is_ascii_digit() || b.is_ascii_lowercase() || matches!(b, b'_' | b'.' | b'-' | b'/'));
    if !ns_ok || !path_ok {
        r.pos = start;
        return Err(r.error_span(start, format!("Invalid resource location '{text}'")));
    }
    Ok((start, text))
}

pub const ENTITY_ANCHORS: &[&str] = &["eyes", "feet"];
pub const GAMEMODES: &[&str] = &["survival", "creative", "adventure", "spectator"];
pub const HEIGHTMAPS: &[&str] =
    &["world_surface_wg", "world_surface", "ocean_floor_wg", "ocean_floor", "motion_blocking", "motion_blocking_no_leaves"];
pub const TEMPLATE_MIRRORS: &[&str] = &["none", "left_right", "front_back"];
pub const TEMPLATE_ROTATIONS: &[&str] = &["none", "clockwise_90", "180", "counterclockwise_90"];

pub fn parse(parser: &Parser, r: &mut Reader, cx: &mut ArgCtx) -> PResult<()> {
    match parser {
        Parser::Bool => r.read_bool().map(|_| ()),
        Parser::Integer { min, max } => basic::integer(r, *min as i64, *max as i64, false),
        Parser::Long { min, max } => basic::integer(r, *min, *max, true),
        Parser::Float { min, max } => basic::float(r, *min as f64, *max as f64, false),
        Parser::Double { min, max } => basic::float(r, *min, *max, true),
        Parser::String(StringKind::Word) => basic::word(r, cx),
        Parser::String(StringKind::Phrase) => basic::phrase(r, cx),
        Parser::String(StringKind::Greedy) => {
            r.pos = r.src.len();
            Ok(())
        }
        Parser::Entity { single, players_only } => entity::entity(r, cx, *single, *players_only),
        Parser::ScoreHolder { multiple } => entity::score_holder(r, cx, *multiple),
        Parser::GameProfile => entity::game_profile(r, cx),
        Parser::BlockPos => coords::block_pos(r),
        Parser::ColumnPos => coords::column_pos(r),
        Parser::Vec3 => coords::vec3(r),
        Parser::Vec2 => coords::vec2(r),
        Parser::Rotation => coords::rotation(r),
        Parser::Angle => coords::angle(r),
        Parser::Swizzle => basic::swizzle(r),
        Parser::BlockState => blockitem::block_state(r, cx, false),
        Parser::BlockPredicate => blockitem::block_state(r, cx, true),
        Parser::ItemStack => blockitem::item(r, cx, false),
        Parser::ItemPredicate => blockitem::item(r, cx, true),
        Parser::ItemSlot => basic::item_slot(r),
        Parser::ItemSlots => basic::item_slots(r),
        Parser::SlotSource => basic::slot_source(r, cx),
        Parser::Color => basic::one_of(r, basic::COLORS, "color"),
        Parser::TeamColor => basic::one_of(r, &basic::COLORS[..16], "color"),
        Parser::HexColor => basic::hex_color(r),
        Parser::SwingAnimation => basic::one_of(r, basic::SWING_ANIMATIONS, "swing animation"),
        Parser::Component => text::component(r, cx),
        Parser::Style => text::style(r, cx),
        Parser::Message => basic::message(r, cx),
        Parser::NbtCompoundTag => nbt::compound_argument(r, cx),
        Parser::NbtTag => nbt::tag_argument(r, cx),
        Parser::NbtPath => nbt::path_argument(r, cx),
        Parser::Objective => basic::objective(r, cx),
        Parser::ObjectiveCriteria => basic::objective_criteria(r, cx),
        Parser::Operation => basic::operation(r),
        Parser::Particle => blockitem::particle(r, cx),
        Parser::IntRange => basic::range(r, false).map(|_| ()),
        Parser::FloatRange => basic::range(r, true).map(|_| ()),
        Parser::ResourceLocation => basic::resource_location(r, cx),
        Parser::Function => basic::function(r, cx),
        Parser::Dimension => {
            let (start, id) = read_resource_location(r)?;
            cx.reference(kind::DIMENSION, id, r.offset_of(start), r.offset());
            Ok(())
        }
        Parser::EntityAnchor => basic::one_of(r, ENTITY_ANCHORS, "entity anchor"),
        Parser::Gamemode => basic::one_of(r, GAMEMODES, "game mode"),
        Parser::Heightmap => basic::one_of(r, HEIGHTMAPS, "heightmap"),
        Parser::TemplateMirror => basic::one_of(r, TEMPLATE_MIRRORS, "mirror"),
        Parser::TemplateRotation => basic::one_of(r, TEMPLATE_ROTATIONS, "rotation"),
        Parser::ScoreboardSlot => basic::scoreboard_slot(r),
        Parser::Team => basic::team(r, cx),
        Parser::Time { min } => basic::time(r, *min),
        Parser::Uuid => basic::uuid(r),
        Parser::Resource { registry } | Parser::ResourceKey { registry } => basic::resource(r, cx, registry, false),
        Parser::ResourceOrTag { registry } | Parser::ResourceOrTagKey { registry } => {
            basic::resource(r, cx, registry, true)
        }
        Parser::ResourceOrId { registry } => basic::resource_or_id(r, cx, registry),
        Parser::ResourceSelector { .. } => basic::resource_selector(r),
        Parser::Unknown(id) => Err(r.error(format!("Unsupported argument type {id}"))),
    }
}
