// Block states and predicates, item stacks and predicates, particles.

import { ParseError } from "../diag.ts";
import { fullId, kind } from "../facts.ts";
import type { PResult, Reader } from "../reader.ts";
import { type ArgCtx, readResourceLocation } from "./index.ts";
import * as nbt from "./nbt.ts";
import * as nbtCheck from "./nbt_check.ts";

/** `BlockStateParser`: `id[prop=value,...]{nbt}`; with `allowTag`, `#tag[...]{...}`. */
export function blockState(r: Reader, cx: ArgCtx, allowTag: boolean): PResult<void> {
  const start = r.pos;
  const tag = allowTag && r.tryConsume("#");
  const loc = readResourceLocation(r);
  if (loc instanceof ParseError) return loc;
  const [, id] = loc;
  const [s, e] = [r.offsetOf(start), r.offset()];
  const full = fullId(id);
  if (tag) cx.reference(kind.BLOCK_TAG, id, s, e);
  else cx.checkRegistry("minecraft:block", id, s, e);
  const props = tag ? undefined : cx.data.blocks.get(full);
  if (r.peek() === "[") {
    r.pos += 1;
    const p = properties(r, props, full, tag);
    if (p instanceof ParseError) return p;
  }
  if (r.peek() === "{") {
    // `clone ... filtered` takes a block predicate that DHP does not check strictly.
    const predicate = allowTag && cx.path[0]?.name !== "clone";
    const target = { ...nbtCheck.new_("Block", tag ? undefined : full), predicate };
    const v = nbt.compoundValue(r, cx, target);
    if (v instanceof ParseError) return v;
  }
}

function properties(r: Reader, props: readonly (readonly [string, readonly string[]])[] | undefined, block: string, vague: boolean): PResult<void> {
  const seen: string[] = [];
  r.skipWhitespace();
  while (r.canRead() && r.peek() !== "]") {
    r.skipWhitespace();
    const keyStart = r.pos;
    const str = r.readString();
    if (str instanceof ParseError) return str;
    const [key] = str;
    const known = props?.find(([k]) => k === key);
    if (!vague) {
      if (props !== undefined && known === undefined) {
        r.pos = keyStart;
        return r.errorSpan(keyStart, `Block ${block} does not have property '${key}'`);
      }
      if (seen.includes(key)) {
        r.pos = keyStart;
        return r.errorSpan(keyStart, `Property '${key}' can only be set once for block ${block}`);
      }
    }
    seen.push(key);
    r.skipWhitespace();
    if (r.peek() !== "=") return r.error(`Expected value for property '${key}' on block ${block}`);
    r.pos += 1;
    r.skipWhitespace();
    const valueStart = r.pos;
    const valueStr = r.readString();
    if (valueStr instanceof ParseError) return valueStr;
    const [value] = valueStr;
    if (known !== undefined) {
      const values = known[1];
      if (!vague && !values.includes(value)) {
        r.pos = valueStart;
        return r.errorSpan(valueStart, `Block ${block} does not accept '${value}' for ${key} property`);
      }
    }
    r.skipWhitespace();
    if (r.canRead()) {
      const c = r.peek();
      if (c === ",") {
        r.pos += 1;
        continue;
      }
      if (c !== "]") return r.error("Expected closing ] for block state properties");
    }
  }
  if (!r.canRead()) return r.error("Expected closing ] for block state properties");
  r.pos += 1;
}

/** `ItemParser`: `id{nbt}`; with `allowTag`, `#tag{nbt}`. From 1.20.5 the item stack takes
 * components (`id[name=value]`, and `!name` from 1.21) and the predicate is `ItemPredicateArgument`. */
export function item(r: Reader, cx: ArgCtx, allowTag: boolean): PResult<void> {
  if (cx.data.atLeast([1, 20, 5])) return allowTag ? itemPredicate(r, cx) : itemStack(r, cx);
  const start = r.pos;
  const tag = allowTag && r.tryConsume("#");
  const loc = readResourceLocation(r);
  if (loc instanceof ParseError) return loc;
  const [, id] = loc;
  const [s, e] = [r.offsetOf(start), r.offset()];
  if (tag) cx.reference(kind.ITEM_TAG, id, s, e);
  else cx.checkRegistry("minecraft:item", id, s, e);
  if (r.peek() === "{") {
    const target = { ...nbtCheck.new_("Item", tag ? undefined : fullId(id)), predicate: allowTag };
    const v = nbt.compoundValue(r, cx, target);
    if (v instanceof ParseError) return v;
  }
}

function itemStack(r: Reader, cx: ArgCtx): PResult<void> {
  const loc = readResourceLocation(r);
  if (loc instanceof ParseError) return loc;
  const [start, id] = loc;
  cx.checkRegistry("minecraft:item", id, r.offsetOf(start), r.offset());
  if (r.peek() !== "[") return;
  r.pos += 1;
  const seen: string[] = [];
  while (r.canRead() && r.peek() !== "]") {
    r.skipWhitespace();
    const removed = cx.data.atLeast([1, 21]) && r.tryConsume("!");
    const name = componentType(r, cx);
    if (name instanceof ParseError) return name;
    if (seen.includes(name)) return r.error(`Item component '${name}' was repeated, but only one value can be specified`);
    if (!removed) {
      r.skipWhitespace();
      const eq = r.expect("=");
      if (eq instanceof ParseError) return eq;
      r.skipWhitespace();
      const v = componentValue(r, cx, "DataComponent", name);
      if (v instanceof ParseError) return v;
    }
    seen.push(name);
    r.skipWhitespace();
    if (!r.tryConsume(",")) break;
    r.skipWhitespace();
    if (!r.canRead()) return r.error("Expected item component");
  }
  return r.expect("]");
}

/** `ComponentPredicateParser`: `*`, an item or `#tag`, then `[test,test|!test,...]` where a test
 * is `component`, `component=value` or `predicate~value`. Whitespace may come before each token. */
function itemPredicate(r: Reader, cx: ArgCtx): PResult<void> {
  const start = r.pos;
  if (!r.tryConsume("*")) {
    const tag = r.tryConsume("#");
    const loc = readResourceLocation(r);
    if (loc instanceof ParseError) return loc;
    const [, id] = loc;
    const [s, e] = [r.offsetOf(start), r.offset()];
    if (tag) cx.reference(kind.ITEM_TAG, id, s, e);
    else cx.checkRegistry("minecraft:item", id, s, e);
  }
  const endOfType = r.pos;
  r.skipWhitespace();
  if (!r.tryConsume("[")) {
    r.pos = endOfType;
    return;
  }
  r.skipWhitespace();
  if (r.tryConsume("]")) return;
  for (;;) {
    if (r.tryConsume("!")) r.skipWhitespace();
    const nameStart = r.pos;
    const loc = readResourceLocation(r);
    if (loc instanceof ParseError) return loc;
    const [, id] = loc;
    const name = fullId(id);
    const pseudo = name === "minecraft:count";
    r.skipWhitespace();
    const next = r.peek();
    if (next === "~") {
      const registry = cx.data.atLeast([1, 21, 5]) ? "minecraft:data_component_predicate_type" : "minecraft:item_sub_predicate_type";
      const predicate = pseudo || cx.data.registryHas(registry, name);
      const component = cx.data.atLeast([1, 21, 11]) && cx.data.registryHas("minecraft:data_component_type", name);
      if (!predicate && !component) {
        r.pos = nameStart;
        return r.errorSpan(nameStart, `Unknown item predicate '${name}'`);
      }
      r.pos += 1;
      if (predicate) {
        const v = predicateValue(r, cx, pseudo ? undefined : "ComponentPredicate", name);
        if (v instanceof ParseError) return v;
      } else {
        const node = nbt.parseTag(r, nbt.modern(cx.data));
        if (node instanceof ParseError) return node;
        for (const effect of nbtCheck.checkUnit(node)) cx.effects.push(effect);
      }
    } else {
      if (!pseudo && !cx.data.registryHas("minecraft:data_component_type", name)) {
        r.pos = nameStart;
        return r.errorSpan(nameStart, `Unknown item component '${name}'`);
      }
      if (next === "=") {
        r.pos += 1;
        const v = predicateValue(r, cx, pseudo ? undefined : "DataComponent", name);
        if (v instanceof ParseError) return v;
      }
    }
    r.skipWhitespace();
    if (!(r.tryConsume("|") || r.tryConsume(","))) break;
    r.skipWhitespace();
  }
  return r.expect("]");
}

function componentType(r: Reader, cx: ArgCtx): PResult<string> {
  if (!r.canRead()) return r.error("Expected item component");
  const loc = readResourceLocation(r);
  if (loc instanceof ParseError) return loc;
  const [start, id] = loc;
  const name = fullId(id);
  if (!cx.data.registryHas("minecraft:data_component_type", name)) return r.errorSpan(start, `Unknown item component '${name}'`);
  return name;
}

/** An SNBT value checked against the schema of the component (or predicate) `name`. */
function componentValue(r: Reader, cx: ArgCtx, category: nbtCheck.Category, name: string): PResult<void> {
  const node = nbt.parseTag(r, nbt.modern(cx.data));
  if (node instanceof ParseError) return node;
  nbt.check(cx, node, nbtCheck.new_(category, name));
}

function predicateValue(r: Reader, cx: ArgCtx, category: nbtCheck.Category | undefined, name: string): PResult<void> {
  if (category !== undefined) return componentValue(r, cx, category, name);
  const node = nbt.parseTag(r, nbt.modern(cx.data));
  if (node instanceof ParseError) return node;
}

function expectSpace(r: Reader): PResult<void> {
  if (r.tryConsume(" ")) return;
  return r.error("Expected whitespace");
}

function floats(r: Reader, n: number): PResult<void> {
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const sp = expectSpace(r);
      if (sp instanceof ParseError) return sp;
    }
    const v = r.readFloat();
    if (v instanceof ParseError) return v;
  }
}

/** `ParticleArgument`: a particle type followed by its options. */
export function particle(r: Reader, cx: ArgCtx): PResult<void> {
  const loc = readResourceLocation(r);
  if (loc instanceof ParseError) return loc;
  const [start, id] = loc;
  const [s, e] = [r.offsetOf(start), r.offset()];
  const full = fullId(id);
  if (!cx.data.registryHas("minecraft:particle_type", full)) return r.errorSpan(start, `Unknown particle: ${full}`);
  cx.checkRegistry("minecraft:particle_type", id, s, e);
  // From 1.20.5 the options are an SNBT compound, decoded by the type's codec; without one the
  // codec decodes an empty compound.
  if (cx.data.atLeast([1, 20, 5])) {
    let node: nbt.NbtNode;
    if (r.peek() === "{") {
      const c = nbt.parseCompound(r, nbt.modern(cx.data));
      if (c instanceof ParseError) return c;
      node = c;
    } else {
      node = { start: s, end: e, value: { kind: "Compound", entries: [] } };
    }
    nbt.check(cx, node, nbtCheck.new_("Particle", full));
    return;
  }
  switch (full) {
    case "minecraft:dust": {
      const sp = expectSpace(r);
      if (sp instanceof ParseError) return sp;
      const rgb = floats(r, 3);
      if (rgb instanceof ParseError) return rgb;
      const sp2 = expectSpace(r);
      if (sp2 instanceof ParseError) return sp2;
      const scale = r.readFloat();
      if (scale instanceof ParseError) return scale;
      break;
    }
    case "minecraft:dust_color_transition": {
      const sp = expectSpace(r);
      if (sp instanceof ParseError) return sp;
      const from = floats(r, 3);
      if (from instanceof ParseError) return from;
      const sp2 = expectSpace(r);
      if (sp2 instanceof ParseError) return sp2;
      const scale = r.readFloat();
      if (scale instanceof ParseError) return scale;
      const sp3 = expectSpace(r);
      if (sp3 instanceof ParseError) return sp3;
      const to = floats(r, 3);
      if (to instanceof ParseError) return to;
      break;
    }
    case "minecraft:block":
    case "minecraft:block_marker":
    case "minecraft:falling_dust": {
      const sp = expectSpace(r);
      if (sp instanceof ParseError) return sp;
      const b = blockState(r, cx, false);
      if (b instanceof ParseError) return b;
      break;
    }
    case "minecraft:item": {
      const sp = expectSpace(r);
      if (sp instanceof ParseError) return sp;
      const i = item(r, cx, false);
      if (i instanceof ParseError) return i;
      break;
    }
    case "minecraft:vibration": {
      const sp = expectSpace(r);
      if (sp instanceof ParseError) return sp;
      const pos = floats(r, 3);
      if (pos instanceof ParseError) return pos;
      const sp2 = expectSpace(r);
      if (sp2 instanceof ParseError) return sp2;
      const ticks = r.readInt();
      if (ticks instanceof ParseError) return ticks;
      break;
    }
    case "minecraft:sculk_charge": {
      const sp = expectSpace(r);
      if (sp instanceof ParseError) return sp;
      const roll = r.readFloat();
      if (roll instanceof ParseError) return roll;
      break;
    }
    case "minecraft:shriek": {
      const sp = expectSpace(r);
      if (sp instanceof ParseError) return sp;
      const delay = r.readInt();
      if (delay instanceof ParseError) return delay;
      break;
    }
  }
}
