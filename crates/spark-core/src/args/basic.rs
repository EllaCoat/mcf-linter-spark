use super::{ArgCtx, entity, read_resource_location};
use crate::facts::kind;
use crate::reader::{PResult, Reader};

pub const COLORS: &[&str] = &[
    "black", "dark_blue", "dark_green", "dark_aqua", "dark_red", "dark_purple", "gold", "gray", "dark_gray", "blue",
    "green", "aqua", "red", "light_purple", "yellow", "white", "reset",
];

pub fn integer(r: &mut Reader, min: i64, max: i64, long: bool) -> PResult<()> {
    let start = r.pos;
    let v = if long { r.read_long()? } else { r.read_int()? as i64 };
    if v < min {
        return Err(r.error_span(start, format!("Integer must not be less than {min}, found {v}")));
    }
    if v > max {
        return Err(r.error_span(start, format!("Integer must not be more than {max}, found {v}")));
    }
    Ok(())
}

pub fn float(r: &mut Reader, min: f64, max: f64, double: bool) -> PResult<()> {
    let start = r.pos;
    let v = if double { r.read_double()? } else { r.read_float()? as f64 };
    if v < min {
        return Err(r.error_span(start, format!("Number must not be less than {min}, found {v}")));
    }
    if v > max {
        return Err(r.error_span(start, format!("Number must not be more than {max}, found {v}")));
    }
    Ok(())
}

/// A word. `scoreboard objectives add` and `team add` take their new names as words.
pub fn word(r: &mut Reader, cx: &mut ArgCtx) -> PResult<()> {
    let start = r.pos;
    let name = r.read_unquoted();
    let (s, e) = (r.offset_of(start), r.offset());
    if cx.name == "objective" && cx.follows(&["objectives", "add"]) {
        cx.define(kind::OBJECTIVE, name.to_string(), s, e);
        cx.naming("nameOfObjectives", "objective", name, s, e);
    } else if cx.name == "team" && cx.follows(&["team", "add"]) {
        cx.define(kind::TEAM, name.to_string(), s, e);
        cx.naming("nameOfTeams", "team", name, s, e);
    } else if cx.name == "name" && cx.path.first().is_some_and(|n| n.name == "tag") && (cx.follows(&["add"]) || cx.follows(&["remove"])) {
        cx.reference_name(kind::ENTITY_TAG, name, s, e);
        cx.naming("nameOfTags", "tag", name, s, e);
    }
    Ok(())
}

pub fn phrase(r: &mut Reader, cx: &mut ArgCtx) -> PResult<()> {
    let start = r.pos;
    let (value, quote) = r.read_string()?;
    cx.string_quote(quote, &value, r.offset_of(start), r.offset());
    Ok(())
}

pub fn one_of(r: &mut Reader, values: &[&str], what: &str) -> PResult<()> {
    let start = r.pos;
    let s = r.read_unquoted();
    if values.contains(&s) { Ok(()) } else { Err(r.error_span(start, format!("Invalid {what} '{s}'"))) }
}

pub fn swizzle(r: &mut Reader) -> PResult<()> {
    let start = r.pos;
    let mut seen = [false; 3];
    while let Some(b) = r.peek() {
        if b == b' ' {
            break;
        }
        let i = match b {
            b'x' => 0,
            b'y' => 1,
            b'z' => 2,
            _ => return Err(r.error_span(start, "Invalid swizzle, expected combination of 'x', 'y' and 'z'")),
        };
        if seen[i] {
            return Err(r.error_span(start, "Invalid swizzle, expected combination of 'x', 'y' and 'z'"));
        }
        seen[i] = true;
        r.pos += 1;
    }
    Ok(())
}

pub fn item_slot(r: &mut Reader) -> PResult<()> {
    let start = r.pos;
    let s = r.read_unquoted();
    if is_slot(s) { Ok(()) } else { Err(r.error_span(start, format!("Unknown slot '{s}'"))) }
}

/// `item_slots`: a slot, or a group of slots (`container.*`, `armor.*`).
pub fn item_slots(r: &mut Reader) -> PResult<()> {
    let start = r.pos;
    let s = r.read_word();
    if is_slot_range(s) { Ok(()) } else { Err(r.error_span(start, format!("Unknown slot '{s}'"))) }
}

/// The slot names of every version from 1.20.5, as `SlotRanges` lists them.
fn is_slot_range(s: &str) -> bool {
    const GROUPS: &[&str] =
        &["container", "hotbar", "inventory", "enderchest", "villager", "mob.inventory", "horse", "weapon", "armor", "player.crafting"];
    s.strip_suffix(".*").is_some_and(|g| GROUPS.contains(&g))
        || is_slot(s)
        || indexed(s, "mob.inventory.", 8)
        || indexed(s, "player.crafting.", 4)
        || matches!(s, "armor.body" | "player.cursor" | "contents" | "saddle")
}

/// `slot_source`: a slot range, else a slot source as `ResourceOrIdArgument` reads it.
pub fn slot_source(r: &mut Reader, cx: &mut ArgCtx) -> PResult<()> {
    let start = r.pos;
    if is_slot_range(r.read_word()) {
        return Ok(());
    }
    r.pos = start;
    resource_or_id(r, cx, "slot_source")
}

/// `ResourceOrIdArgument`: an id of the registry, or the element written inline in SNBT.
pub fn resource_or_id(r: &mut Reader, cx: &mut ArgCtx, registry: &str) -> PResult<()> {
    if !r.peek().is_some_and(super::is_allowed_in_resource_location) {
        return super::nbt::parse_tag(r).map(|_| ());
    }
    let (start, id) = read_resource_location(r)?;
    let (s, e) = (r.offset_of(start), r.offset());
    if let Some(k) = cx.data.file_kind(registry) {
        cx.reference(k, id, s, e);
    }
    Ok(())
}

/// `resource_selector`: an id pattern with `*` and `?`.
pub fn resource_selector(r: &mut Reader) -> PResult<()> {
    let pattern = r.read_while(|b| super::is_allowed_in_resource_location(b) || matches!(b, b'*' | b'?'));
    if pattern.is_empty() { Err(r.error("Expected a resource selector")) } else { Ok(()) }
}

/// `hex_color`: `RGB` or `RRGGBB`.
pub fn hex_color(r: &mut Reader) -> PResult<()> {
    let start = r.pos;
    let s = r.read_unquoted();
    if matches!(s.len(), 3 | 6) && s.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(r.error_span(start, format!("Invalid hex color '{s}'")))
    }
}

pub const SWING_ANIMATIONS: &[&str] = &["none", "whack", "stab"];

/// `<prefix><n>` with `n` below `count`, written without a sign or leading zeros.
fn indexed(s: &str, prefix: &str, count: u32) -> bool {
    s.strip_prefix(prefix)
        .and_then(|n| n.parse::<u32>().ok().filter(|_| !n.starts_with('+') && (n == "0" || !n.starts_with('0'))))
        .is_some_and(|n| n < count)
}

fn is_slot(s: &str) -> bool {
    indexed(s, "container.", 54)
        || indexed(s, "hotbar.", 9)
        || indexed(s, "inventory.", 27)
        || indexed(s, "enderchest.", 27)
        || indexed(s, "villager.", 8)
        || indexed(s, "horse.", 15)
        || matches!(
            s,
            "weapon"
                | "weapon.mainhand"
                | "weapon.offhand"
                | "armor.head"
                | "armor.chest"
                | "armor.legs"
                | "armor.feet"
                | "horse.saddle"
                | "horse.armor"
                | "horse.chest"
        )
}

/// A message: plain text in which `@p`, `@a`, `@r`, `@s` and `@e` start selectors.
pub fn message(r: &mut Reader, cx: &mut ArgCtx) -> PResult<()> {
    while r.can_read() {
        if r.peek() == Some(b'@') && matches!(r.peek_at(1), Some(b'p' | b'a' | b'r' | b's' | b'e')) {
            entity::selector(r, cx)?;
        } else {
            r.skip();
        }
    }
    Ok(())
}

pub fn objective(r: &mut Reader, cx: &mut ArgCtx) -> PResult<()> {
    let start = r.pos;
    let name = r.read_unquoted();
    let (s, e) = (r.offset_of(start), r.offset());
    cx.reference_name(kind::OBJECTIVE, name, s, e);
    cx.naming("nameOfObjectives", "objective", name, s, e);
    Ok(())
}

pub fn team(r: &mut Reader, cx: &mut ArgCtx) -> PResult<()> {
    let start = r.pos;
    let name = r.read_unquoted();
    let (s, e) = (r.offset_of(start), r.offset());
    cx.reference_name(kind::TEAM, name, s, e);
    cx.naming("nameOfTeams", "team", name, s, e);
    Ok(())
}

pub const SIMPLE_CRITERIA: &[&str] =
    &["dummy", "trigger", "deathCount", "playerKillCount", "totalKillCount", "health", "xp", "level", "food", "air", "armor"];

pub fn objective_criteria(r: &mut Reader, cx: &mut ArgCtx) -> PResult<()> {
    let start = r.pos;
    let s = r.read_word();
    if SIMPLE_CRITERIA.contains(&s) {
        return Ok(());
    }
    if let Some(color) = s.strip_prefix("teamkill.").or_else(|| s.strip_prefix("killedByTeam.")) {
        if COLORS[..16].contains(&color) {
            return Ok(());
        }
    }
    // <stat type>:<value>, both resource locations written with '.' as the separator.
    if let Some((stat_type, value)) = s.split_once(':') {
        let stat_type = dotted_to_id(stat_type);
        let value = dotted_to_id(value);
        let registry = match stat_type.as_str() {
            "minecraft:mined" => Some("minecraft:block"),
            "minecraft:crafted" | "minecraft:used" | "minecraft:broken" | "minecraft:picked_up" | "minecraft:dropped" => {
                Some("minecraft:item")
            }
            "minecraft:killed" | "minecraft:killed_by" => Some("minecraft:entity_type"),
            "minecraft:custom" => Some("minecraft:custom_stat"),
            _ => None,
        };
        if let Some(registry) = registry {
            if cx.data.registry_has(registry, &value) {
                return Ok(());
            }
        }
    }
    Err(r.error_span(start, format!("Invalid criterion '{s}'")))
}

/// `minecraft.used` -> `minecraft:used`, as `ResourceLocation.of(name, '.')` does.
fn dotted_to_id(s: &str) -> String {
    match s.split_once('.') {
        Some((ns, path)) => format!("{ns}:{path}"),
        None => format!("minecraft:{s}"),
    }
}

pub fn operation(r: &mut Reader) -> PResult<()> {
    let start = r.pos;
    let s = r.read_word();
    if matches!(s, "=" | "+=" | "-=" | "*=" | "/=" | "%=" | "<" | ">" | "><") {
        Ok(())
    } else {
        Err(r.error_span(start, "Invalid operation"))
    }
}

/// `MinMaxBounds`: `5`, `..5`, `5..`, `1..5`.
pub fn range(r: &mut Reader, float: bool) -> PResult<(Option<f64>, Option<f64>)> {
    let start = r.pos;
    let (min, max) = bounds(r, float)?;
    if let (Some(a), Some(b)) = (min, max)
        && a > b
    {
        return Err(r.error_span(start, "Min cannot be bigger than max"));
    }
    Ok((min, max))
}

pub fn wrapped_range(r: &mut Reader) -> PResult<(Option<f64>, Option<f64>)> {
    bounds(r, true)
}

fn bounds(r: &mut Reader, float: bool) -> PResult<(Option<f64>, Option<f64>)> {
    let start = r.pos;
    if !r.can_read() {
        return Err(r.error("Expected value or range of values"));
    }
    let min = read_bound(r, float)?;
    let max = if r.rest().starts_with("..") {
        r.pos += 2;
        read_bound(r, float)?
    } else {
        min
    };
    if min.is_none() && max.is_none() {
        return Err(r.error_span(start, "Expected value or range of values"));
    }
    Ok((min, max))
}

fn read_bound(r: &mut Reader, float: bool) -> PResult<Option<f64>> {
    let start = r.pos;
    while let Some(b) = r.peek() {
        let ok = b.is_ascii_digit() || b == b'-' || (b == b'.' && r.peek_at(1) != Some(b'.'));
        if !ok {
            break;
        }
        r.pos += 1;
    }
    let text = &r.src[start..r.pos];
    if text.is_empty() {
        return Ok(None);
    }
    let v = if float {
        crate::reader::parse_java_double(text)
    } else {
        text.parse::<i32>().ok().map(|v| v as f64)
    };
    match v {
        Some(v) => Ok(Some(v)),
        None => Err(r.error_span(start, format!("Invalid {} '{text}'", if float { "double" } else { "integer" }))),
    }
}

pub fn resource_location(r: &mut Reader, cx: &mut ArgCtx) -> PResult<()> {
    let (start, id) = read_resource_location(r)?;
    let (s, e) = (r.offset_of(start), r.offset());
    if cx.prev_literal() == Some("storage") {
        cx.write_reference(kind::STORAGE, crate::facts::full_id(id), s, e);
        return Ok(());
    }
    match cx.name {
        "advancement" => cx.reference(kind::ADVANCEMENT, id, s, e),
        "id" if cx.follows(&["bossbar", "add"]) => cx.define(kind::BOSSBAR, crate::facts::full_id(id), s, e),
        "id" => cx.reference(kind::BOSSBAR, id, s, e),
        "predicate" => cx.reference(kind::PREDICATE, id, s, e),
        "modifier" => cx.reference(kind::ITEM_MODIFIER, id, s, e),
        "loot_table" => cx.reference(kind::LOOT_TABLE, id, s, e),
        "pool" => cx.reference(kind::TEMPLATE_POOL, id, s, e),
        "template" => cx.reference(kind::STRUCTURE, id, s, e),
        "recipe" => cx.reference(kind::RECIPE, id, s, e),
        "sound" => cx.check_registry("minecraft:sound_event", id, s, e),
        _ => {}
    }
    Ok(())
}

pub fn function(r: &mut Reader, cx: &mut ArgCtx) -> PResult<()> {
    let start = r.pos;
    let tag = r.try_consume(b'#');
    let (_, id) = read_resource_location(r)?;
    let (s, e) = (r.offset_of(start), r.offset());
    cx.reference(if tag { kind::FUNCTION_TAG } else { kind::FUNCTION }, id, s, e);
    Ok(())
}

pub fn scoreboard_slot(r: &mut Reader) -> PResult<()> {
    let start = r.pos;
    let s = r.read_unquoted();
    let ok = matches!(s, "list" | "sidebar" | "below_name")
        || s.strip_prefix("sidebar.team.").is_some_and(|c| COLORS[..16].contains(&c));
    if ok { Ok(()) } else { Err(r.error_span(start, format!("Unknown display slot '{s}'"))) }
}

pub fn time(r: &mut Reader, min: i32) -> PResult<()> {
    let start = r.pos;
    let v = r.read_float()?;
    let unit = r.read_unquoted();
    let factor = match unit {
        "" | "t" => 1.0,
        "s" => 20.0,
        "d" => 24000.0,
        _ => return Err(r.error_span(start, "Invalid unit")),
    };
    let ticks = (v * factor).round() as i64;
    if ticks < min as i64 {
        return Err(r.error_span(start, format!("Tick count must not be less than {min}, found {ticks}")));
    }
    Ok(())
}

pub fn uuid(r: &mut Reader) -> PResult<()> {
    let start = r.pos;
    let text = r.read_while(|b| b.is_ascii_hexdigit() || b == b'-');
    let parts: Vec<&str> = text.split('-').collect();
    let ok = parts.len() == 5 && parts.iter().all(|p| !p.is_empty() && p.len() <= 16);
    if ok {
        Ok(())
    } else {
        r.pos = start;
        Err(r.error_span(start, "Invalid UUID"))
    }
}

/// `minecraft:resource` and friends. Built-in registries are checked here; ids of data pack
/// contents and tags become references, which the project and the vanilla data pack resolve.
pub fn resource(r: &mut Reader, cx: &mut ArgCtx, registry: &str, allow_tag: bool) -> PResult<()> {
    let start = r.pos;
    let tag = allow_tag && r.try_consume(b'#');
    let (_, id) = read_resource_location(r)?;
    let (s, e) = (r.offset_of(start), r.offset());
    let short = registry.strip_prefix("minecraft:").unwrap_or(registry);
    if tag {
        if let Some(k) = cx.data.file_kind(&format!("tag/{short}")) {
            cx.reference(k, id, s, e);
        }
    } else if let Some(k) = cx.data.file_kind(short) {
        cx.reference(k, id, s, e);
    } else if cx.data.registries.contains_key(registry) {
        cx.check_registry(registry, id, s, e);
        cx.values.push(super::ArgValue::Id(crate::facts::full_id(id)));
    }
    Ok(())
}
