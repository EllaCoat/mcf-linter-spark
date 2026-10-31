//! Entity selectors, player names, score holders (`EntitySelectorParser`).

use super::nbt_check::{Category, Target};
use super::{ArgCtx, basic, nbt, read_resource_location};
use crate::facts::kind;
use crate::reader::{PResult, Reader};

/// What a parsed selector can match, for the single / players-only checks.
pub struct SelectorInfo {
    pub max_results: u32,
    pub includes_entities: bool,
    pub is_self: bool,
    /// DHP's `getNbtdocRegistryId`: `minecraft:player` for `@a`/`@p`/`@r`,
    /// otherwise the first non-negated, non-tag `type=` (as far as parsed).
    pub nbt_type: Option<String>,
}

pub fn entity(r: &mut Reader, cx: &mut ArgCtx, single: bool, players_only: bool) -> PResult<()> {
    let start = r.pos;
    let info = if r.peek() == Some(b'@') { selector(r, cx)? } else { name_or_uuid(r)? };
    cx.values.push(super::ArgValue::Entity(info.nbt_type.clone()));
    if info.max_results > 1 && single {
        let message = if players_only {
            "Only one player is allowed, but the provided selector allows more than one"
        } else {
            "Only one entity is allowed, but the provided selector allows more than one"
        };
        return Err(r.error_span(start, message));
    }
    if info.includes_entities && players_only && !info.is_self {
        return Err(r.error_span(start, "Only players may be affected by this command, but the provided selector includes entities"));
    }
    Ok(())
}

fn name_or_uuid(r: &mut Reader) -> PResult<SelectorInfo> {
    let start = r.pos;
    let (s, _) = r.read_string()?;
    let is_uuid = is_uuid(&s);
    if !is_uuid && (s.is_empty() || s.chars().count() > 16) {
        r.pos = start;
        return Err(r.error_span(start, "Invalid name or UUID"));
    }
    Ok(SelectorInfo { max_results: 1, includes_entities: is_uuid, is_self: false, nbt_type: None })
}

pub fn score_holder(r: &mut Reader, cx: &mut ArgCtx, multiple: bool) -> PResult<()> {
    let start = r.pos;
    if r.peek() == Some(b'@') {
        let info = selector(r, cx)?;
        if !multiple && info.max_results > 1 {
            return Err(r.error_span(start, "Only one entity is allowed, but the provided selector allows more than one"));
        }
        return Ok(());
    }
    let name = r.read_word();
    if name != "*" {
        let (s, e) = (r.offset_of(start), r.offset());
        cx.naming("nameOfScoreHolders", "score holder", name, s, e);
        if !is_uuid_like(name) {
            if is_written(cx) {
                cx.write_reference(kind::SCORE_HOLDER, name.to_string(), s, e);
            } else {
                cx.reference_name(kind::SCORE_HOLDER, name, s, e);
            }
        }
    }
    Ok(())
}

/// The score holders that a command writes, which Spyglass 4 binds as definitions.
fn is_written(cx: &ArgCtx) -> bool {
    cx.name == "targets"
        && (["add", "remove", "set", "reset", "operation"].iter().any(|op| cx.follows(&["scoreboard", "players", op]))
            || cx.follows(&["store", "result", "score"])
            || cx.follows(&["store", "success", "score"]))
}

pub fn game_profile(r: &mut Reader, cx: &mut ArgCtx) -> PResult<()> {
    let start = r.pos;
    if r.peek() == Some(b'@') {
        let info = selector(r, cx)?;
        if info.includes_entities {
            return Err(r.error_span(start, "Only players may be affected by this command, but the provided selector includes entities"));
        }
        return Ok(());
    }
    r.read_word();
    Ok(())
}

/// The options a selector accepts in 1.20.4 (`EntitySelectorOptions`).
pub const SELECTOR_OPTIONS: &[&str] = &[
    "name", "distance", "level", "x", "y", "z", "dx", "dy", "dz", "x_rotation", "y_rotation", "limit", "sort",
    "gamemode", "team", "tag", "type", "nbt", "scores", "advancements", "predicate",
];
pub const SORTS: &[&str] = &["nearest", "furthest", "random", "arbitrary"];

/// Parses `@x` or `@x[...]` at the reader, which must point at `@`.
pub fn selector(r: &mut Reader, cx: &mut ArgCtx) -> PResult<SelectorInfo> {
    let start = r.pos;
    r.expect(b'@')?;
    let mut info = match r.peek() {
        Some(b'p') => SelectorInfo { max_results: 1, includes_entities: false, is_self: false, nbt_type: None },
        Some(b'a') => SelectorInfo { max_results: u32::MAX, includes_entities: false, is_self: false, nbt_type: None },
        Some(b'r') => SelectorInfo { max_results: 1, includes_entities: false, is_self: false, nbt_type: None },
        Some(b's') => SelectorInfo { max_results: 1, includes_entities: true, is_self: true, nbt_type: None },
        Some(b'e') => SelectorInfo { max_results: u32::MAX, includes_entities: true, is_self: false, nbt_type: None },
        _ => {
            r.skip();
            return Err(r.error_span(start, "Unknown selector type"));
        }
    };
    if matches!(r.peek(), Some(b'a' | b'p' | b'r')) {
        info.nbt_type = Some("minecraft:player".into());
    }
    r.pos += 1;
    if r.peek() == Some(b'[') {
        let open = r.pos;
        r.pos += 1;
        let mut keys = Vec::new();
        options(r, cx, &mut info, &mut keys)?;
        if let Some((severity, order)) = cx.config.rule("selectorSortKeys") {
            let sorted = order.as_array().is_none_or(|o| crate::lint::selector_keys_sorted(&keys, o));
            if !sorted {
                cx.diag(r.offset_of(open), r.offset(), severity, "selectorSortKeys", "Unsorted keys");
            }
        }
    }
    Ok(info)
}

/// DHP's `UuidPattern`: five hexadecimal groups.
fn is_uuid_like(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() == 5 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn options(r: &mut Reader, cx: &mut ArgCtx, info: &mut SelectorInfo, keys: &mut Vec<String>) -> PResult<()> {
    r.skip_whitespace();
    while r.can_read() && r.peek() != Some(b']') {
        r.skip_whitespace();
        let key_start = r.pos;
        let (key, quote) = r.read_string()?;
        cx.quote_rules("selectorKeyQuote", "selectorKeyQuoteType", quote, &key, r.offset_of(key_start), r.offset());
        r.skip_whitespace();
        if r.peek() != Some(b'=') {
            return Err(r.error(format!("Expected value for option '{key}'")));
        }
        r.pos += 1;
        r.skip_whitespace();
        keys.push(if r.peek() == Some(b'!') { format!("{key}Neg") } else { key.clone() });
        option_value(r, cx, info, &key, key_start)?;
        r.skip_whitespace();
        if r.can_read() {
            match r.peek() {
                Some(b',') => {
                    r.pos += 1;
                    continue;
                }
                Some(b']') => {}
                _ => return Err(r.error("Expected end of options")),
            }
        }
    }
    if !r.can_read() {
        return Err(r.error("Expected end of options"));
    }
    r.pos += 1;
    Ok(())
}

fn is_uuid(s: &str) -> bool {
    s.len() <= 36 && s.split('-').count() == 5 && s.split('-').all(|p| !p.is_empty() && p.len() <= 16 && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn invert(r: &mut Reader) -> bool {
    r.skip_whitespace();
    let negated = r.try_consume(b'!');
    if negated {
        r.skip_whitespace();
    }
    negated
}

fn option_value(
    r: &mut Reader,
    cx: &mut ArgCtx,
    info: &mut SelectorInfo,
    key: &str,
    key_start: usize,
) -> PResult<()> {
    match key {
        "name" => {
            invert(r);
            r.read_string()?;
        }
        "distance" | "level" => {
            let start = r.pos;
            let (min, _) = basic::range(r, key == "distance")?;
            if min.is_some_and(|m| m < 0.0) {
                let what = if key == "distance" { "Distance" } else { "Level" };
                return Err(r.error_span(start, format!("{what} cannot be negative")));
            }
        }
        "x" | "y" | "z" | "dx" | "dy" | "dz" => {
            r.read_double()?;
        }
        "x_rotation" | "y_rotation" => {
            basic::wrapped_range(r)?;
        }
        "limit" => {
            let start = r.pos;
            let n = r.read_int()?;
            if n < 1 {
                return Err(r.error_span(start, "Limit must be at least 1"));
            }
            if !info.is_self {
                info.max_results = n as u32;
            }
        }
        "sort" => {
            let start = r.pos;
            let s = r.read_unquoted();
            if !SORTS.contains(&s) {
                return Err(r.error_span(start, format!("Invalid or unknown sort type '{s}'")));
            }
        }
        "gamemode" => {
            invert(r);
            let start = r.pos;
            let s = r.read_unquoted();
            if !super::GAMEMODES.contains(&s) {
                return Err(r.error_span(start, format!("Invalid or unknown game mode '{s}'")));
            }
        }
        "team" => {
            invert(r);
            let start = r.pos;
            let s = r.read_unquoted();
            if !s.is_empty() {
                let (s0, e0) = (r.offset_of(start), r.offset());
                cx.reference_name(kind::TEAM, s, s0, e0);
                cx.naming("nameOfTeams", "team", s, s0, e0);
            }
        }
        "tag" => {
            invert(r);
            let start = r.pos;
            let s = r.read_unquoted();
            if !s.is_empty() {
                let (s0, e0) = (r.offset_of(start), r.offset());
                cx.reference_name(kind::ENTITY_TAG, s, s0, e0);
                cx.naming("nameOfTags", "tag", s, s0, e0);
            }
        }
        "type" => {
            let negated = invert(r);
            let start = r.pos;
            let tag = r.try_consume(b'#');
            let (_, id) = read_resource_location(r)?;
            let (s, e) = (r.offset_of(start), r.offset());
            if tag {
                cx.reference(kind::ENTITY_TYPE_TAG, id, s, e);
            } else {
                cx.check_registry("minecraft:entity_type", id, s, e);
                if !negated && crate::facts::full_id(id) == "minecraft:player" {
                    info.includes_entities = false;
                }
                if !negated && info.nbt_type.is_none() {
                    info.nbt_type = Some(crate::facts::full_id(id));
                }
            }
        }
        "nbt" => {
            invert(r);
            let target = Target { predicate: true, ..Target::new(Category::Entity, info.nbt_type.clone()) };
            nbt::compound_value(r, cx, Some(&target))?;
        }
        "scores" => scores(r, cx)?,
        "advancements" => advancements(r, cx)?,
        "predicate" => {
            invert(r);
            let (start, id) = read_resource_location(r)?;
            cx.reference(kind::PREDICATE, id, r.offset_of(start), r.offset());
        }
        _ => {
            r.pos = key_start;
            return Err(r.error_span(key_start, format!("Unknown option '{key}'")));
        }
    }
    Ok(())
}

fn scores(r: &mut Reader, cx: &mut ArgCtx) -> PResult<()> {
    r.expect(b'{')?;
    r.skip_whitespace();
    while r.can_read() && r.peek() != Some(b'}') {
        r.skip_whitespace();
        let start = r.pos;
        let name = r.read_unquoted();
        cx.reference_name(kind::OBJECTIVE, name, r.offset_of(start), r.offset());
        r.skip_whitespace();
        r.expect(b'=')?;
        r.skip_whitespace();
        basic::range(r, false)?;
        r.skip_whitespace();
        r.try_consume(b',');
    }
    r.expect(b'}')
}

fn advancements(r: &mut Reader, cx: &mut ArgCtx) -> PResult<()> {
    r.expect(b'{')?;
    r.skip_whitespace();
    while r.can_read() && r.peek() != Some(b'}') {
        r.skip_whitespace();
        let (start, id) = read_resource_location(r)?;
        cx.reference(kind::ADVANCEMENT, id, r.offset_of(start), r.offset());
        r.skip_whitespace();
        r.expect(b'=')?;
        r.skip_whitespace();
        if r.peek() == Some(b'{') {
            r.pos += 1;
            r.skip_whitespace();
            while r.can_read() && r.peek() != Some(b'}') {
                r.skip_whitespace();
                r.read_unquoted();
                r.skip_whitespace();
                r.expect(b'=')?;
                r.skip_whitespace();
                r.read_bool()?;
                r.skip_whitespace();
                r.try_consume(b',');
            }
            r.expect(b'}')?;
        } else {
            r.read_bool()?;
        }
        r.skip_whitespace();
        r.try_consume(b',');
    }
    r.expect(b'}')
}
