//! Block states and predicates, item stacks and predicates, particles.

use super::nbt_check::{self, Category, Target};
use super::{ArgCtx, nbt, read_resource_location};
use crate::facts::{full_id, kind};
use crate::reader::{PResult, Reader};

/// `BlockStateParser`: `id[prop=value,...]{nbt}`; with `allow_tag`, `#tag[...]{...}`.
pub fn block_state(r: &mut Reader, cx: &mut ArgCtx, allow_tag: bool) -> PResult<()> {
    let start = r.pos;
    let tag = allow_tag && r.try_consume(b'#');
    let (_, id) = read_resource_location(r)?;
    let (s, e) = (r.offset_of(start), r.offset());
    let full = full_id(id);
    let props = if tag {
        cx.reference(kind::BLOCK_TAG, id, s, e);
        None
    } else {
        cx.check_registry("minecraft:block", id, s, e);
        cx.data.blocks.get(&full)
    };
    if r.peek() == Some(b'[') {
        r.pos += 1;
        properties(r, props, &full, tag)?;
    }
    if r.peek() == Some(b'{') {
        // `clone ... filtered` takes a block predicate that DHP does not check strictly.
        let predicate = allow_tag && !cx.path.first().is_some_and(|n| n.name == "clone");
        let id = (!tag).then(|| full.clone());
        let target = Target { predicate, ..Target::new(Category::Block, id) };
        nbt::compound_value(r, cx, Some(&target))?;
    }
    Ok(())
}

fn properties(r: &mut Reader, props: Option<&Vec<(String, Vec<String>)>>, block: &str, vague: bool) -> PResult<()> {
    let mut seen: Vec<String> = Vec::new();
    r.skip_whitespace();
    while r.can_read() && r.peek() != Some(b']') {
        r.skip_whitespace();
        let key_start = r.pos;
        let (key, _) = r.read_string()?;
        let known = props.and_then(|p| p.iter().find(|(k, _)| *k == key));
        if !vague {
            if props.is_some() && known.is_none() {
                r.pos = key_start;
                return Err(r.error_span(key_start, format!("Block {block} does not have property '{key}'")));
            }
            if seen.contains(&key) {
                r.pos = key_start;
                return Err(r.error_span(key_start, format!("Property '{key}' can only be set once for block {block}")));
            }
        }
        seen.push(key.clone());
        r.skip_whitespace();
        if r.peek() != Some(b'=') {
            return Err(r.error(format!("Expected value for property '{key}' on block {block}")));
        }
        r.pos += 1;
        r.skip_whitespace();
        let value_start = r.pos;
        let (value, _) = r.read_string()?;
        if let Some((_, values)) = known {
            if !vague && !values.contains(&value) {
                r.pos = value_start;
                return Err(r.error_span(value_start, format!("Block {block} does not accept '{value}' for {key} property")));
            }
        }
        r.skip_whitespace();
        if r.can_read() {
            match r.peek() {
                Some(b',') => {
                    r.pos += 1;
                    continue;
                }
                Some(b']') => {}
                _ => return Err(r.error(format!("Expected closing ] for block state properties"))),
            }
        }
    }
    if !r.can_read() {
        return Err(r.error("Expected closing ] for block state properties"));
    }
    r.pos += 1;
    Ok(())
}

/// `ItemParser`: `id{nbt}`; with `allow_tag`, `#tag{nbt}`. From 1.20.5 the item stack takes
/// components (`id[name=value]`, and `!name` from 1.21) and the predicate is `ItemPredicateArgument`.
pub fn item(r: &mut Reader, cx: &mut ArgCtx, allow_tag: bool) -> PResult<()> {
    if cx.data.at_least(&[1, 20, 5]) {
        return if allow_tag { item_predicate(r, cx) } else { item_stack(r, cx) };
    }
    let start = r.pos;
    let tag = allow_tag && r.try_consume(b'#');
    let (_, id) = read_resource_location(r)?;
    let (s, e) = (r.offset_of(start), r.offset());
    if tag {
        cx.reference(kind::ITEM_TAG, id, s, e);
    } else {
        cx.check_registry("minecraft:item", id, s, e);
    }
    if r.peek() == Some(b'{') {
        let target = Target { predicate: allow_tag, ..Target::new(Category::Item, (!tag).then(|| full_id(id))) };
        nbt::compound_value(r, cx, Some(&target))?;
    }
    Ok(())
}

fn item_stack(r: &mut Reader, cx: &mut ArgCtx) -> PResult<()> {
    let (start, id) = read_resource_location(r)?;
    cx.check_registry("minecraft:item", id, r.offset_of(start), r.offset());
    if r.peek() != Some(b'[') {
        return Ok(());
    }
    r.pos += 1;
    let mut seen: Vec<String> = Vec::new();
    while r.can_read() && r.peek() != Some(b']') {
        r.skip_whitespace();
        let removed = cx.data.at_least(&[1, 21]) && r.try_consume(b'!');
        let name = component_type(r, cx)?;
        if seen.contains(&name) {
            return Err(r.error(format!("Item component '{name}' was repeated, but only one value can be specified")));
        }
        if !removed {
            r.skip_whitespace();
            r.expect(b'=')?;
            r.skip_whitespace();
            component_value(r, cx, Category::DataComponent, &name)?;
        }
        seen.push(name);
        r.skip_whitespace();
        if !r.try_consume(b',') {
            break;
        }
        r.skip_whitespace();
        if !r.can_read() {
            return Err(r.error("Expected item component"));
        }
    }
    r.expect(b']')
}

/// `ComponentPredicateParser`: `*`, an item or `#tag`, then `[test,test|!test,...]` where a test
/// is `component`, `component=value` or `predicate~value`. Whitespace may come before each token.
fn item_predicate(r: &mut Reader, cx: &mut ArgCtx) -> PResult<()> {
    let start = r.pos;
    if !r.try_consume(b'*') {
        let tag = r.try_consume(b'#');
        let (_, id) = read_resource_location(r)?;
        let (s, e) = (r.offset_of(start), r.offset());
        if tag {
            cx.reference(kind::ITEM_TAG, id, s, e);
        } else {
            cx.check_registry("minecraft:item", id, s, e);
        }
    }
    let end_of_type = r.pos;
    r.skip_whitespace();
    if !r.try_consume(b'[') {
        r.pos = end_of_type;
        return Ok(());
    }
    r.skip_whitespace();
    if r.try_consume(b']') {
        return Ok(());
    }
    loop {
        if r.try_consume(b'!') {
            r.skip_whitespace();
        }
        let name_start = r.pos;
        let (_, id) = read_resource_location(r)?;
        let name = full_id(id);
        let pseudo = name == "minecraft:count";
        r.skip_whitespace();
        match r.peek() {
            Some(b'~') => {
                let registry = if cx.data.at_least(&[1, 21, 5]) { "minecraft:data_component_predicate_type" } else { "minecraft:item_sub_predicate_type" };
                let predicate = pseudo || cx.data.registry_has(registry, &name);
                let component = cx.data.at_least(&[1, 21, 11]) && cx.data.registry_has("minecraft:data_component_type", &name);
                if !predicate && !component {
                    r.pos = name_start;
                    return Err(r.error_span(name_start, format!("Unknown item predicate '{name}'")));
                }
                r.pos += 1;
                if predicate {
                    let category = if pseudo { None } else { Some(Category::ComponentPredicate) };
                    predicate_value(r, cx, category, &name)?;
                } else {
                    let node = nbt::parse_tag(r, nbt::modern(cx.data))?;
                    cx.effects.extend(nbt_check::check_unit(&node));
                }
            }
            next => {
                if !pseudo && !cx.data.registry_has("minecraft:data_component_type", &name) {
                    r.pos = name_start;
                    return Err(r.error_span(name_start, format!("Unknown item component '{name}'")));
                }
                if next == Some(b'=') {
                    r.pos += 1;
                    let category = if pseudo { None } else { Some(Category::DataComponent) };
                    predicate_value(r, cx, category, &name)?;
                }
            }
        }
        r.skip_whitespace();
        if !(r.try_consume(b'|') || r.try_consume(b',')) {
            break;
        }
        r.skip_whitespace();
    }
    r.expect(b']')
}

fn component_type(r: &mut Reader, cx: &ArgCtx) -> PResult<String> {
    if !r.can_read() {
        return Err(r.error("Expected item component"));
    }
    let (start, id) = read_resource_location(r)?;
    let name = full_id(id);
    if !cx.data.registry_has("minecraft:data_component_type", &name) {
        return Err(r.error_span(start, format!("Unknown item component '{name}'")));
    }
    Ok(name)
}

/// An SNBT value checked against the schema of the component (or predicate) `name`.
fn component_value(r: &mut Reader, cx: &mut ArgCtx, category: Category, name: &str) -> PResult<()> {
    let node = nbt::parse_tag(r, nbt::modern(cx.data))?;
    nbt::check(cx, &node, Some(&Target::new(category, Some(name.to_string()))));
    Ok(())
}

fn predicate_value(r: &mut Reader, cx: &mut ArgCtx, category: Option<Category>, name: &str) -> PResult<()> {
    match category {
        Some(category) => component_value(r, cx, category, name),
        None => nbt::parse_tag(r, nbt::modern(cx.data)).map(|_| ()),
    }
}

fn expect_space(r: &mut Reader) -> PResult<()> {
    if r.try_consume(b' ') { Ok(()) } else { Err(r.error("Expected whitespace")) }
}

fn floats(r: &mut Reader, n: usize) -> PResult<()> {
    for i in 0..n {
        if i > 0 {
            expect_space(r)?;
        }
        r.read_float()?;
    }
    Ok(())
}

/// `ParticleArgument`: a particle type followed by its options.
pub fn particle(r: &mut Reader, cx: &mut ArgCtx) -> PResult<()> {
    let (start, id) = read_resource_location(r)?;
    let (s, e) = (r.offset_of(start), r.offset());
    let full = full_id(id);
    if !cx.data.registry_has("minecraft:particle_type", &full) {
        return Err(r.error_span(start, format!("Unknown particle: {full}")));
    }
    cx.check_registry("minecraft:particle_type", id, s, e);
    // From 1.20.5 the options are an SNBT compound, decoded by the type's codec; without one the
    // codec decodes an empty compound.
    if cx.data.at_least(&[1, 20, 5]) {
        let node = if r.peek() == Some(b'{') {
            nbt::parse_compound(r, nbt::modern(cx.data))?
        } else {
            nbt::NbtNode { start: s, end: e, value: nbt::NbtValue::Compound(Vec::new()) }
        };
        nbt::check(cx, &node, Some(&Target::new(Category::Particle, Some(full))));
        return Ok(());
    }
    match full.as_str() {
        "minecraft:dust" => {
            expect_space(r)?;
            floats(r, 3)?;
            expect_space(r)?;
            r.read_float()?;
        }
        "minecraft:dust_color_transition" => {
            expect_space(r)?;
            floats(r, 3)?;
            expect_space(r)?;
            r.read_float()?;
            expect_space(r)?;
            floats(r, 3)?;
        }
        "minecraft:block" | "minecraft:block_marker" | "minecraft:falling_dust" => {
            expect_space(r)?;
            block_state(r, cx, false)?;
        }
        "minecraft:item" => {
            expect_space(r)?;
            item(r, cx, false)?;
        }
        "minecraft:vibration" => {
            expect_space(r)?;
            floats(r, 3)?;
            expect_space(r)?;
            r.read_int()?;
        }
        "minecraft:sculk_charge" => {
            expect_space(r)?;
            r.read_float()?;
        }
        "minecraft:shriek" => {
            expect_space(r)?;
            r.read_int()?;
        }
        _ => {}
    }
    Ok(())
}
