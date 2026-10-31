//! Block states and predicates, item stacks and predicates, particles.

use super::nbt_check::{Category, Target};
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

/// `ItemParser`: `id{nbt}`; with `allow_tag`, `#tag{nbt}`.
pub fn item(r: &mut Reader, cx: &mut ArgCtx, allow_tag: bool) -> PResult<()> {
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
