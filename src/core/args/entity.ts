// Entity selectors, player names, score holders (`EntitySelectorParser`).

import { charCount, isAsciiHexDigit, utf8Len } from "../chars.ts";
import { ParseError } from "../diag.ts";
import { fullId, kind } from "../facts.ts";
import { asArray } from "../json-value.ts";
import { selectorKeysSorted } from "../lint.ts";
import { U32_MAX } from "../numbers.ts";
import type { PResult, Reader } from "../reader.ts";
import * as basic from "./basic.ts";
import { type ArgCtx, GAMEMODES, readResourceLocation } from "./index.ts";
import * as nbt from "./nbt.ts";
import * as nbtCheck from "./nbt_check.ts";

/** What a parsed selector can match, for the single / players-only checks. */
export interface SelectorInfo {
  maxResults: number;
  includesEntities: boolean;
  isSelf: boolean;
  /** DHP's `getNbtdocRegistryId`: `minecraft:player` for `@a`/`@p`/`@r`,
   * otherwise the first non-negated, non-tag `type=` (as far as parsed). */
  nbtType: string | undefined;
}

export function entity(r: Reader, cx: ArgCtx, single: boolean, playersOnly: boolean): PResult<void> {
  const start = r.pos;
  const info = r.peek() === "@" ? selector(r, cx) : nameOrUuid(r);
  if (info instanceof ParseError) return info;
  cx.values.push({ kind: "Entity", entityType: info.nbtType });
  if (info.maxResults > 1 && single) {
    const message = playersOnly
      ? "Only one player is allowed, but the provided selector allows more than one"
      : "Only one entity is allowed, but the provided selector allows more than one";
    return r.errorSpan(start, message);
  }
  if (info.includesEntities && playersOnly && !info.isSelf) {
    return r.errorSpan(start, "Only players may be affected by this command, but the provided selector includes entities");
  }
}

function nameOrUuid(r: Reader): PResult<SelectorInfo> {
  const start = r.pos;
  const str = r.readString();
  if (str instanceof ParseError) return str;
  const [s] = str;
  const uuid = isUuid(s);
  if (!uuid && (s === "" || charCount(s) > 16)) {
    r.pos = start;
    return r.errorSpan(start, "Invalid name or UUID");
  }
  return { maxResults: 1, includesEntities: uuid, isSelf: false, nbtType: undefined };
}

export function scoreHolder(r: Reader, cx: ArgCtx, multiple: boolean): PResult<void> {
  const start = r.pos;
  if (r.peek() === "@") {
    const info = selector(r, cx);
    if (info instanceof ParseError) return info;
    if (!multiple && info.maxResults > 1) {
      return r.errorSpan(start, "Only one entity is allowed, but the provided selector allows more than one");
    }
    return;
  }
  const name = r.readWord();
  if (name !== "*") {
    const [s, e] = [r.offsetOf(start), r.offset()];
    cx.naming("nameOfScoreHolders", "score holder", name, s, e);
    if (!isUuidLike(name)) {
      if (isWritten(cx)) cx.writeReference(kind.SCORE_HOLDER, name, s, e);
      else cx.referenceName(kind.SCORE_HOLDER, name, s, e);
    }
  }
}

/** The score holders that a command writes, which Spyglass 4 binds as definitions. */
function isWritten(cx: ArgCtx): boolean {
  return (
    cx.name === "targets" &&
    (["add", "remove", "set", "reset", "operation"].some((op) => cx.follows(["scoreboard", "players", op])) ||
      cx.follows(["store", "result", "score"]) ||
      cx.follows(["store", "success", "score"]))
  );
}

export function gameProfile(r: Reader, cx: ArgCtx): PResult<void> {
  const start = r.pos;
  if (r.peek() === "@") {
    const info = selector(r, cx);
    if (info instanceof ParseError) return info;
    if (info.includesEntities) {
      return r.errorSpan(start, "Only players may be affected by this command, but the provided selector includes entities");
    }
    return;
  }
  r.readWord();
}

/** The options a selector accepts in 1.20.4 (`EntitySelectorOptions`). */
export const SELECTOR_OPTIONS: readonly string[] = [
  "name", "distance", "level", "x", "y", "z", "dx", "dy", "dz", "x_rotation", "y_rotation", "limit", "sort",
  "gamemode", "team", "tag", "type", "nbt", "scores", "advancements", "predicate",
];
export const SORTS: readonly string[] = ["nearest", "furthest", "random", "arbitrary"];

/** Parses `@x` or `@x[...]` at the reader, which must point at `@`. */
export function selector(r: Reader, cx: ArgCtx): PResult<SelectorInfo> {
  const start = r.pos;
  const at = r.expect("@");
  if (at instanceof ParseError) return at;
  const type = r.peek();
  let info: SelectorInfo;
  if (type === "p") info = { maxResults: 1, includesEntities: false, isSelf: false, nbtType: undefined };
  else if (type === "a") info = { maxResults: U32_MAX, includesEntities: false, isSelf: false, nbtType: undefined };
  else if (type === "r") info = { maxResults: 1, includesEntities: false, isSelf: false, nbtType: undefined };
  else if (type === "s") info = { maxResults: 1, includesEntities: true, isSelf: true, nbtType: undefined };
  else if (type === "e") info = { maxResults: U32_MAX, includesEntities: true, isSelf: false, nbtType: undefined };
  else if (type === "n" && cx.data.atLeast([1, 21])) info = { maxResults: 1, includesEntities: true, isSelf: false, nbtType: undefined };
  else {
    r.skip();
    return r.errorSpan(start, "Unknown selector type");
  }
  if (type === "a" || type === "p" || type === "r") info.nbtType = "minecraft:player";
  r.pos += 1;
  if (r.peek() === "[") {
    const open = r.pos;
    r.pos += 1;
    const keys: string[] = [];
    const o = options(r, cx, info, keys);
    if (o instanceof ParseError) return o;
    const rule = cx.config.rule("selectorSortKeys");
    if (rule !== undefined) {
      const [severity, order] = rule;
      const arr = asArray(order);
      const sorted = arr === undefined || selectorKeysSorted(keys, arr);
      if (!sorted) cx.diag(r.offsetOf(open), r.offset(), severity, "selectorSortKeys", "Unsorted keys");
    }
  }
  return info;
}

/** DHP's `UuidPattern`: five hexadecimal groups. */
function isUuidLike(s: string): boolean {
  const parts = s.split("-");
  return parts.length === 5 && parts.every((p) => p !== "" && [...p].every(isAsciiHexDigit));
}

function options(r: Reader, cx: ArgCtx, info: SelectorInfo, keys: string[]): PResult<void> {
  r.skipWhitespace();
  while (r.canRead() && r.peek() !== "]") {
    r.skipWhitespace();
    const keyStart = r.pos;
    const str = r.readString();
    if (str instanceof ParseError) return str;
    const [key, quote] = str;
    cx.quoteRules("selectorKeyQuote", "selectorKeyQuoteType", quote, key, r.offsetOf(keyStart), r.offset());
    r.skipWhitespace();
    if (r.peek() !== "=") return r.error(`Expected value for option '${key}'`);
    r.pos += 1;
    r.skipWhitespace();
    keys.push(r.peek() === "!" ? `${key}Neg` : key);
    const v = optionValue(r, cx, info, key, keyStart);
    if (v instanceof ParseError) return v;
    r.skipWhitespace();
    if (r.canRead()) {
      const c = r.peek();
      if (c === ",") {
        r.pos += 1;
        continue;
      }
      if (c !== "]") return r.error("Expected end of options");
    }
  }
  if (!r.canRead()) return r.error("Expected end of options");
  r.pos += 1;
}

function isUuid(s: string): boolean {
  if (utf8Len(s) > 36) return false;
  const parts = s.split("-");
  return parts.length === 5 && parts.every((p) => p !== "" && utf8Len(p) <= 16 && [...p].every(isAsciiHexDigit));
}

function invert(r: Reader): boolean {
  r.skipWhitespace();
  const negated = r.tryConsume("!");
  if (negated) r.skipWhitespace();
  return negated;
}

function optionValue(r: Reader, cx: ArgCtx, info: SelectorInfo, key: string, keyStart: number): PResult<void> {
  switch (key) {
    case "name": {
      invert(r);
      const s = r.readString();
      if (s instanceof ParseError) return s;
      break;
    }
    case "distance":
    case "level": {
      const start = r.pos;
      const range = basic.range(r, key === "distance");
      if (range instanceof ParseError) return range;
      const [min] = range;
      if (min !== undefined && min < 0) {
        const what = key === "distance" ? "Distance" : "Level";
        return r.errorSpan(start, `${what} cannot be negative`);
      }
      break;
    }
    case "x":
    case "y":
    case "z":
    case "dx":
    case "dy":
    case "dz": {
      const v = r.readDouble();
      if (v instanceof ParseError) return v;
      break;
    }
    case "x_rotation":
    case "y_rotation": {
      const v = basic.wrappedRange(r);
      if (v instanceof ParseError) return v;
      break;
    }
    case "limit": {
      const start = r.pos;
      const n = r.readInt();
      if (n instanceof ParseError) return n;
      if (n < 1) return r.errorSpan(start, "Limit must be at least 1");
      if (!info.isSelf) info.maxResults = n;
      break;
    }
    case "sort": {
      const start = r.pos;
      const s = r.readUnquoted();
      if (!SORTS.includes(s)) return r.errorSpan(start, `Invalid or unknown sort type '${s}'`);
      break;
    }
    case "gamemode": {
      invert(r);
      const start = r.pos;
      const s = r.readUnquoted();
      if (!GAMEMODES.includes(s)) return r.errorSpan(start, `Invalid or unknown game mode '${s}'`);
      break;
    }
    case "team": {
      invert(r);
      const start = r.pos;
      const s = r.readUnquoted();
      if (s !== "") {
        const [s0, e0] = [r.offsetOf(start), r.offset()];
        cx.referenceName(kind.TEAM, s, s0, e0);
        cx.naming("nameOfTeams", "team", s, s0, e0);
      }
      break;
    }
    case "tag": {
      invert(r);
      const start = r.pos;
      const s = r.readUnquoted();
      if (s !== "") {
        const [s0, e0] = [r.offsetOf(start), r.offset()];
        cx.referenceName(kind.ENTITY_TAG, s, s0, e0);
        cx.naming("nameOfTags", "tag", s, s0, e0);
      }
      break;
    }
    case "type": {
      const negated = invert(r);
      const start = r.pos;
      const tag = r.tryConsume("#");
      const loc = readResourceLocation(r);
      if (loc instanceof ParseError) return loc;
      const [, id] = loc;
      const [s, e] = [r.offsetOf(start), r.offset()];
      if (tag) {
        cx.reference(kind.ENTITY_TYPE_TAG, id, s, e);
      } else {
        cx.checkRegistry("minecraft:entity_type", id, s, e);
        if (!negated && fullId(id) === "minecraft:player") info.includesEntities = false;
        if (!negated && info.nbtType === undefined) info.nbtType = fullId(id);
      }
      break;
    }
    case "nbt": {
      invert(r);
      const target = { ...nbtCheck.new_("Entity", info.nbtType), predicate: true };
      const v = nbt.compoundValue(r, cx, target);
      if (v instanceof ParseError) return v;
      break;
    }
    case "scores": {
      const v = scores(r, cx);
      if (v instanceof ParseError) return v;
      break;
    }
    case "advancements": {
      const v = advancements(r, cx);
      if (v instanceof ParseError) return v;
      break;
    }
    case "predicate": {
      invert(r);
      const loc = readResourceLocation(r);
      if (loc instanceof ParseError) return loc;
      const [start, id] = loc;
      cx.reference(kind.PREDICATE, id, r.offsetOf(start), r.offset());
      break;
    }
    default:
      r.pos = keyStart;
      return r.errorSpan(keyStart, `Unknown option '${key}'`);
  }
}

function scores(r: Reader, cx: ArgCtx): PResult<void> {
  const open = r.expect("{");
  if (open instanceof ParseError) return open;
  r.skipWhitespace();
  while (r.canRead() && r.peek() !== "}") {
    r.skipWhitespace();
    const start = r.pos;
    const name = r.readUnquoted();
    cx.referenceName(kind.OBJECTIVE, name, r.offsetOf(start), r.offset());
    r.skipWhitespace();
    const eq = r.expect("=");
    if (eq instanceof ParseError) return eq;
    r.skipWhitespace();
    const v = basic.range(r, false);
    if (v instanceof ParseError) return v;
    r.skipWhitespace();
    r.tryConsume(",");
  }
  return r.expect("}");
}

function advancements(r: Reader, cx: ArgCtx): PResult<void> {
  const open = r.expect("{");
  if (open instanceof ParseError) return open;
  r.skipWhitespace();
  while (r.canRead() && r.peek() !== "}") {
    r.skipWhitespace();
    const loc = readResourceLocation(r);
    if (loc instanceof ParseError) return loc;
    const [start, id] = loc;
    cx.reference(kind.ADVANCEMENT, id, r.offsetOf(start), r.offset());
    r.skipWhitespace();
    const eq = r.expect("=");
    if (eq instanceof ParseError) return eq;
    r.skipWhitespace();
    if (r.peek() === "{") {
      r.pos += 1;
      r.skipWhitespace();
      while (r.canRead() && r.peek() !== "}") {
        r.skipWhitespace();
        r.readUnquoted();
        r.skipWhitespace();
        const eq2 = r.expect("=");
        if (eq2 instanceof ParseError) return eq2;
        r.skipWhitespace();
        const b = r.readBool();
        if (b instanceof ParseError) return b;
        r.skipWhitespace();
        r.tryConsume(",");
      }
      const close = r.expect("}");
      if (close instanceof ParseError) return close;
    } else {
      const b = r.readBool();
      if (b instanceof ParseError) return b;
    }
    r.skipWhitespace();
    r.tryConsume(",");
  }
  return r.expect("}");
}
