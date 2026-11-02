// Numbers, strings, slots, scoreboard names, ranges, and resources.

import { isAsciiDigit, isAsciiHexDigit, utf8Len } from "../chars.ts";
import type { VersionData } from "../data.ts";
import { ParseError } from "../diag.ts";
import { type Kind, fullId, kind } from "../facts.ts";
import { f64ToI64, fmtF64, parseF64, parseI32, parseU32 } from "../numbers.ts";
import { type PResult, Reader, parseJavaDouble } from "../reader.ts";
import * as entity from "./entity.ts";
import { type ArgCtx, isAllowedInResourceLocation, readResourceLocation } from "./index.ts";
import * as nbt from "./nbt.ts";
import * as nbtCheck from "./nbt_check.ts";

export const COLORS: readonly string[] = [
  "black", "dark_blue", "dark_green", "dark_aqua", "dark_red", "dark_purple", "gold", "gray", "dark_gray", "blue",
  "green", "aqua", "red", "light_purple", "yellow", "white", "reset",
];

export function integer(r: Reader, min: bigint, max: bigint, long: boolean): PResult<void> {
  const start = r.pos;
  let v: bigint;
  if (long) {
    const x = r.readLong();
    if (x instanceof ParseError) return x;
    v = x;
  } else {
    const x = r.readInt();
    if (x instanceof ParseError) return x;
    v = BigInt(x);
  }
  if (v < min) return r.errorSpan(start, `Integer must not be less than ${min}, found ${v}`);
  if (v > max) return r.errorSpan(start, `Integer must not be more than ${max}, found ${v}`);
}

export function float(r: Reader, min: number, max: number, double: boolean): PResult<void> {
  const start = r.pos;
  const v = double ? r.readDouble() : r.readFloat();
  if (v instanceof ParseError) return v;
  if (v < min) return r.errorSpan(start, `Number must not be less than ${fmtF64(min)}, found ${fmtF64(v)}`);
  if (v > max) return r.errorSpan(start, `Number must not be more than ${fmtF64(max)}, found ${fmtF64(v)}`);
}

/** A word. `scoreboard objectives add` and `team add` take their new names as words. */
export function word(r: Reader, cx: ArgCtx): PResult<void> {
  const start = r.pos;
  const name = r.readUnquoted();
  const [s, e] = [r.offsetOf(start), r.offset()];
  if (cx.name === "objective" && cx.follows(["objectives", "add"])) {
    cx.define(kind.OBJECTIVE, name, s, e);
    cx.naming("nameOfObjectives", "objective", name, s, e);
  } else if (cx.name === "team" && cx.follows(["team", "add"])) {
    cx.define(kind.TEAM, name, s, e);
    cx.naming("nameOfTeams", "team", name, s, e);
  } else if (cx.name === "name" && cx.path[0]?.name === "tag" && (cx.follows(["add"]) || cx.follows(["remove"]))) {
    cx.referenceName(kind.ENTITY_TAG, name, s, e);
    cx.naming("nameOfTags", "tag", name, s, e);
  }
}

export function phrase(r: Reader, cx: ArgCtx): PResult<void> {
  const start = r.pos;
  const str = r.readString();
  if (str instanceof ParseError) return str;
  const [value, quote] = str;
  cx.stringQuote(quote, value, r.offsetOf(start), r.offset());
}

export function oneOf(r: Reader, values: readonly string[], what: string): PResult<void> {
  const start = r.pos;
  const s = r.readUnquoted();
  if (!values.includes(s)) return r.errorSpan(start, `Invalid ${what} '${s}'`);
}

export function swizzle(r: Reader): PResult<void> {
  const start = r.pos;
  const seen = [false, false, false];
  for (let b = r.peek(); b !== undefined; b = r.peek()) {
    if (b === " ") break;
    let i: number;
    switch (b) {
      case "x":
        i = 0;
        break;
      case "y":
        i = 1;
        break;
      case "z":
        i = 2;
        break;
      default:
        return r.errorSpan(start, "Invalid swizzle, expected combination of 'x', 'y' and 'z'");
    }
    if (seen[i]) return r.errorSpan(start, "Invalid swizzle, expected combination of 'x', 'y' and 'z'");
    seen[i] = true;
    r.pos += 1;
  }
}

export function itemSlot(r: Reader, data: VersionData): PResult<void> {
  const start = r.pos;
  const s = r.readUnquoted();
  if (!isSlot(s, data)) return r.errorSpan(start, `Unknown slot '${s}'`);
}

/** `item_slots`: a slot, or a group of slots (`container.*`, `armor.*`). */
export function itemSlots(r: Reader, data: VersionData): PResult<void> {
  const start = r.pos;
  const s = r.readWord();
  if (!isSlotRange(s, data)) return r.errorSpan(start, `Unknown slot '${s}'`);
}

/** The slot names of a version: the single slots, and the numbered ones by prefix and count.
 * `SlotArgument` before 1.20.5, `SlotRanges` from it. */
export interface Slots {
  names: readonly string[];
  numbered: readonly (readonly [string, number])[];
}

const NAMES_1_20_4: readonly string[] = [
  "weapon", "weapon.mainhand", "weapon.offhand", "armor.head", "armor.chest", "armor.legs", "armor.feet", "horse.saddle",
  "horse.armor", "horse.chest",
];
const NAMES_1_20_5: readonly string[] = [
  "contents", "weapon", "weapon.mainhand", "weapon.offhand", "armor.head", "armor.chest", "armor.legs", "armor.feet",
  "armor.body", "horse.saddle", "horse.chest", "player.cursor",
];
const NAMES_1_21_5: readonly string[] = [
  "contents", "weapon", "weapon.mainhand", "weapon.offhand", "armor.head", "armor.chest", "armor.legs", "armor.feet",
  "armor.body", "saddle", "horse.chest", "player.cursor",
];
const NUMBERED_1_20_4: readonly (readonly [string, number])[] = [
  ["container.", 54], ["hotbar.", 9], ["inventory.", 27], ["enderchest.", 27], ["villager.", 8], ["horse.", 15],
];
const NUMBERED_1_20_5: readonly (readonly [string, number])[] = [
  ["container.", 54], ["hotbar.", 9], ["inventory.", 27], ["enderchest.", 27], ["villager.", 8], ["horse.", 15],
  ["player.crafting.", 4],
];
const NUMBERED_26_1: readonly (readonly [string, number])[] = [
  ["container.", 54], ["hotbar.", 9], ["inventory.", 27], ["enderchest.", 27], ["mob.inventory.", 8], ["horse.", 15],
  ["player.crafting.", 4],
];

export function slots(data: VersionData): Slots {
  if (!data.atLeast([1, 20, 5])) return { names: NAMES_1_20_4, numbered: NUMBERED_1_20_4 };
  if (!data.atLeast([1, 21, 5])) return { names: NAMES_1_20_5, numbered: NUMBERED_1_20_5 };
  if (!data.atLeast([26, 1])) return { names: NAMES_1_21_5, numbered: NUMBERED_1_20_5 };
  return { names: NAMES_1_21_5, numbered: NUMBERED_26_1 };
}

function isSlot(s: string, data: VersionData): boolean {
  const sl = slots(data);
  return sl.names.includes(s) || sl.numbered.some(([prefix, count]) => indexed(s, prefix, count));
}

/** A slot, or a group of the numbered slots, the weapon slots or the armor slots (`container.*`). */
function isSlotRange(s: string, data: VersionData): boolean {
  if (isSlot(s, data)) return true;
  if (!s.endsWith("*")) return false;
  const group = s.slice(0, -1);
  return group === "weapon." || group === "armor." || slots(data).numbered.some(([prefix]) => prefix === group);
}

/** `slot_source`: a slot range, else a slot source as `ResourceOrIdArgument` reads it. */
export function slotSource(r: Reader, cx: ArgCtx): PResult<void> {
  const start = r.pos;
  if (isSlotRange(r.readWord(), cx.data)) return;
  r.pos = start;
  return resourceOrId(r, cx, "slot_source");
}

/** What an unresolved id was likely meant to be, where the game reads an id in place of a slot or
 * a number: an old slot name, a slot with `minecraft:`, or a number. */
export function misreadId(k: Kind, id: string, data: VersionData): string | undefined {
  if (!id.startsWith("minecraft:")) return undefined;
  const path = id.slice("minecraft:".length);
  switch (k) {
    case "slot_source": {
      let slot: string;
      if (path === "horse.saddle") slot = "saddle";
      else if (path === "horse.armor") slot = "armor.body";
      else if (indexed(path, "villager.", 8)) slot = `mob.inventory.${path.slice("villager.".length)}`;
      else if (isSlot(path, data)) return `a slot with a namespace is read as an id. Write the slot as '${path}'`;
      else return undefined;
      return `'${path}' is no longer a slot, so it is read as an id. The slot is now '${slot}'`;
    }
    case "context_int_provider":
    case "context_float_provider": {
      const number = /[bBsSlLfFdD]$/.test(path) ? path.slice(0, -1) : path;
      if (!(/^[0-9.-]*$/.test(number) && parseF64(number) !== undefined)) return undefined;
      const suffix = k === "context_float_provider" ? "f" : "";
      return `a number here is read as an id. Write a constant as {type:"minecraft:constant",value:${number}${suffix}}`;
    }
    default:
      return undefined;
  }
}

/** `ResourceOrIdArgument`: an id of the registry, or the element written inline in SNBT. */
export function resourceOrId(r: Reader, cx: ArgCtx, registry: string): PResult<void> {
  const next = r.peek();
  if (next === undefined || !isAllowedInResourceLocation(next)) {
    const start = r.pos;
    const node = nbt.parseTag(r, nbt.modern(cx.data));
    if (node instanceof ParseError) return node;
    const k = cx.data.fileKind(registry);
    if (k === undefined) return;
    // Until 1.21.6 the element is read with `RegistryFileCodec`, which takes a string as its id.
    if (!cx.data.atLeast([1, 21, 6]) && node.value.kind === "String") {
      const { value, quote } = node.value;
      const id = new Reader(value, 0);
      if (readResourceLocation(id) instanceof ParseError || id.canRead()) {
        return r.errorSpan(start, `Not a valid resource location: ${value}`);
      }
      const inner = quote !== undefined ? 1 : 0;
      cx.reference(k, value, node.start + inner, node.end - inner);
      return;
    }
    let target: nbtCheck.Target;
    switch (registry) {
      case "item_modifier":
        target = nbtCheck.new_("ItemModifier", undefined);
        break;
      case "slot_source":
        target = nbtCheck.new_("SlotSource", undefined);
        break;
      default:
        target = nbtCheck.new_("Resource", k);
    }
    nbt.check(cx, node, target);
    return;
  }
  const loc = readResourceLocation(r);
  if (loc instanceof ParseError) return loc;
  const [start, id] = loc;
  const [s, e] = [r.offsetOf(start), r.offset()];
  const k = cx.data.fileKind(registry);
  if (k !== undefined) cx.reference(k, id, s, e);
}

/** `resource_selector`: an id pattern with `*` and `?`. A pattern without them names one id. */
export function resourceSelector(r: Reader, cx: ArgCtx, registry: string): PResult<void> {
  const start = r.pos;
  const pattern = r.readWhile((b) => isAllowedInResourceLocation(b) || b === "*" || b === "?");
  if (pattern === "") return r.error("Expected a resource selector");
  const short = registry.startsWith("minecraft:") ? registry.slice("minecraft:".length) : registry;
  if (!pattern.includes("*") && !pattern.includes("?")) {
    const k = cx.data.fileKind(short);
    if (k !== undefined) cx.reference(k, pattern, r.offsetOf(start), r.offset());
  }
}

/** `hex_color`: `RGB` or `RRGGBB`. */
export function hexColor(r: Reader): PResult<void> {
  const start = r.pos;
  const s = r.readUnquoted();
  const len = utf8Len(s);
  if (!((len === 3 || len === 6) && [...s].every(isAsciiHexDigit))) return r.errorSpan(start, `Invalid hex color '${s}'`);
}

export const SWING_ANIMATIONS: readonly string[] = ["none", "whack", "stab"];

/** `<prefix><n>` with `n` below `count`, written without a sign or leading zeros. */
function indexed(s: string, prefix: string, count: number): boolean {
  if (!s.startsWith(prefix)) return false;
  const n = s.slice(prefix.length);
  const v = parseU32(n);
  return v !== undefined && !n.startsWith("+") && (n === "0" || !n.startsWith("0")) && v < count;
}

/** A message: plain text in which `@p`, `@a`, `@r`, `@s`, `@e` and, from 1.21, `@n` start selectors. */
export function message(r: Reader, cx: ArgCtx): PResult<void> {
  while (r.canRead()) {
    const nearest = cx.data.atLeast([1, 21]) && r.peekAt(1) === "n";
    const second = r.peekAt(1);
    if (r.peek() === "@" && (nearest || second === "p" || second === "a" || second === "r" || second === "s" || second === "e")) {
      const sel = entity.selector(r, cx);
      if (sel instanceof ParseError) return sel;
    } else {
      r.skip();
    }
  }
}

export function objective(r: Reader, cx: ArgCtx): PResult<void> {
  const start = r.pos;
  const name = r.readUnquoted();
  const [s, e] = [r.offsetOf(start), r.offset()];
  cx.referenceName(kind.OBJECTIVE, name, s, e);
  cx.naming("nameOfObjectives", "objective", name, s, e);
}

export function team(r: Reader, cx: ArgCtx): PResult<void> {
  const start = r.pos;
  const name = r.readUnquoted();
  const [s, e] = [r.offsetOf(start), r.offset()];
  cx.referenceName(kind.TEAM, name, s, e);
  cx.naming("nameOfTeams", "team", name, s, e);
}

export const SIMPLE_CRITERIA: readonly string[] = [
  "dummy", "trigger", "deathCount", "playerKillCount", "totalKillCount", "health", "xp", "level", "food", "air", "armor",
];

export function objectiveCriteria(r: Reader, cx: ArgCtx): PResult<void> {
  const start = r.pos;
  const s = r.readWord();
  if (SIMPLE_CRITERIA.includes(s)) return;
  const color = s.startsWith("teamkill.") ? s.slice("teamkill.".length) : s.startsWith("killedByTeam.") ? s.slice("killedByTeam.".length) : undefined;
  if (color !== undefined && COLORS.slice(0, 16).includes(color)) return;
  // <stat type>:<value>, both resource locations written with '.' as the separator.
  const colon = s.indexOf(":");
  if (colon >= 0) {
    const statType = dottedToId(s.slice(0, colon));
    const value = dottedToId(s.slice(colon + 1));
    let registry: string | undefined;
    switch (statType) {
      case "minecraft:mined":
        registry = "minecraft:block";
        break;
      case "minecraft:crafted":
      case "minecraft:used":
      case "minecraft:broken":
      case "minecraft:picked_up":
      case "minecraft:dropped":
        registry = "minecraft:item";
        break;
      case "minecraft:killed":
      case "minecraft:killed_by":
        registry = "minecraft:entity_type";
        break;
      case "minecraft:custom":
        registry = "minecraft:custom_stat";
        break;
    }
    if (registry !== undefined && cx.data.registryHas(registry, value)) return;
  }
  return r.errorSpan(start, `Invalid criterion '${s}'`);
}

/** `minecraft.used` -> `minecraft:used`, as `ResourceLocation.of(name, '.')` does. */
function dottedToId(s: string): string {
  const dot = s.indexOf(".");
  return dot >= 0 ? `${s.slice(0, dot)}:${s.slice(dot + 1)}` : `minecraft:${s}`;
}

export function operation(r: Reader): PResult<void> {
  const start = r.pos;
  const s = r.readWord();
  switch (s) {
    case "=":
    case "+=":
    case "-=":
    case "*=":
    case "/=":
    case "%=":
    case "<":
    case ">":
    case "><":
      return;
    default:
      return r.errorSpan(start, "Invalid operation");
  }
}

/** `MinMaxBounds`: `5`, `..5`, `5..`, `1..5`. */
export function range(r: Reader, float: boolean): PResult<[number | undefined, number | undefined]> {
  const start = r.pos;
  const b = bounds(r, float);
  if (b instanceof ParseError) return b;
  const [min, max] = b;
  if (min !== undefined && max !== undefined && min > max) return r.errorSpan(start, "Min cannot be bigger than max");
  return [min, max];
}

export function wrappedRange(r: Reader): PResult<[number | undefined, number | undefined]> {
  return bounds(r, true);
}

function bounds(r: Reader, float: boolean): PResult<[number | undefined, number | undefined]> {
  const start = r.pos;
  if (!r.canRead()) return r.error("Expected value or range of values");
  const min = readBound(r, float);
  if (min instanceof ParseError) return min;
  let max: number | undefined;
  if (r.src.startsWith("..", r.pos)) {
    r.pos += 2;
    const m = readBound(r, float);
    if (m instanceof ParseError) return m;
    max = m;
  } else {
    max = min;
  }
  if (min === undefined && max === undefined) return r.errorSpan(start, "Expected value or range of values");
  return [min, max];
}

function readBound(r: Reader, float: boolean): PResult<number | undefined> {
  const start = r.pos;
  for (let b = r.peek(); b !== undefined; b = r.peek()) {
    const ok = isAsciiDigit(b) || b === "-" || (b === "." && r.peekAt(1) !== ".");
    if (!ok) break;
    r.pos += 1;
  }
  const text = r.src.slice(start, r.pos);
  if (text === "") return undefined;
  const v = float ? parseJavaDouble(text) : parseI32(text);
  if (v === undefined) return r.errorSpan(start, `Invalid ${float ? "double" : "integer"} '${text}'`);
  return v;
}

export function resourceLocation(r: Reader, cx: ArgCtx): PResult<void> {
  const loc = readResourceLocation(r);
  if (loc instanceof ParseError) return loc;
  const [start, id] = loc;
  const [s, e] = [r.offsetOf(start), r.offset()];
  if (cx.prevLiteral() === "storage") {
    cx.writeReference(kind.STORAGE, fullId(id), s, e);
    return;
  }
  switch (cx.name) {
    case "advancement":
      cx.reference(kind.ADVANCEMENT, id, s, e);
      break;
    case "id":
      if (cx.follows(["bossbar", "add"])) cx.define(kind.BOSSBAR, fullId(id), s, e);
      else if (cx.follows(["bossbar"]) || ["get", "remove", "set"].some((l) => cx.follows(["bossbar", l]))) cx.reference(kind.BOSSBAR, id, s, e);
      break;
    case "predicate":
      cx.reference(kind.PREDICATE, id, s, e);
      break;
    case "modifier":
      cx.reference(kind.ITEM_MODIFIER, id, s, e);
      break;
    case "loot_table":
      cx.reference(kind.LOOT_TABLE, id, s, e);
      break;
    case "pool":
      cx.reference(kind.TEMPLATE_POOL, id, s, e);
      break;
    case "template":
      cx.reference(kind.STRUCTURE, id, s, e);
      break;
    case "recipe":
      cx.reference(kind.RECIPE, id, s, e);
      break;
    case "sound":
      cx.checkRegistry("minecraft:sound_event", id, s, e);
      break;
  }
}

export function function_(r: Reader, cx: ArgCtx): PResult<void> {
  const start = r.pos;
  const tag = r.tryConsume("#");
  const loc = readResourceLocation(r);
  if (loc instanceof ParseError) return loc;
  const [, id] = loc;
  cx.reference(tag ? kind.FUNCTION_TAG : kind.FUNCTION, id, r.offsetOf(start), r.offset());
}

export function scoreboardSlot(r: Reader): PResult<void> {
  const start = r.pos;
  const s = r.readUnquoted();
  const ok =
    s === "list" ||
    s === "sidebar" ||
    s === "below_name" ||
    (s.startsWith("sidebar.team.") && COLORS.slice(0, 16).includes(s.slice("sidebar.team.".length)));
  if (!ok) return r.errorSpan(start, `Unknown display slot '${s}'`);
}

export function time(r: Reader, min: number): PResult<void> {
  const start = r.pos;
  const v = r.readFloat();
  if (v instanceof ParseError) return v;
  const unit = r.readUnquoted();
  let factor: number;
  switch (unit) {
    case "":
    case "t":
      factor = 1;
      break;
    case "s":
      factor = 20;
      break;
    case "d":
      factor = 24000;
      break;
    default:
      return r.errorSpan(start, "Invalid unit");
  }
  const ticks = f64ToI64(roundHalfAwayFromZero(Math.fround(v * factor)));
  if (ticks < BigInt(min)) return r.errorSpan(start, `Tick count must not be less than ${min}, found ${ticks}`);
}

/** Rust's `f32::round` / `f64::round`: halves go away from zero (`Math.round` sends them toward +infinity). */
function roundHalfAwayFromZero(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

export function uuid(r: Reader): PResult<void> {
  const start = r.pos;
  const text = r.readWhile((b) => isAsciiHexDigit(b) || b === "-");
  const parts = text.split("-");
  const ok = parts.length === 5 && parts.every((p) => p !== "" && utf8Len(p) <= 16);
  if (!ok) {
    r.pos = start;
    return r.errorSpan(start, "Invalid UUID");
  }
}

/** `minecraft:resource` and friends. Built-in registries are checked here; ids of data pack
 * contents and tags become references, which the project and the vanilla data pack resolve. */
export function resource(r: Reader, cx: ArgCtx, registry: string, allowTag: boolean): PResult<void> {
  const start = r.pos;
  const tag = allowTag && r.tryConsume("#");
  const loc = readResourceLocation(r);
  if (loc instanceof ParseError) return loc;
  const [, id] = loc;
  const [s, e] = [r.offsetOf(start), r.offset()];
  const short = registry.startsWith("minecraft:") ? registry.slice("minecraft:".length) : registry;
  if (tag) {
    const k = cx.data.fileKind(`tag/${short}`);
    if (k !== undefined) cx.reference(k, id, s, e);
  } else {
    const k = cx.data.fileKind(short);
    if (k !== undefined) {
      cx.reference(k, id, s, e);
    } else if (cx.data.registries.has(registry)) {
      cx.checkRegistry(registry, id, s, e);
      cx.values.push({ kind: "Id", id: fullId(id) });
    }
  }
}
