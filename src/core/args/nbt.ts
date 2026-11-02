// SNBT (`TagParser`) and NBT paths (`NbtPathArgument`) of Minecraft 1.20.4. From 1.21.5 the
// SNBT is read by `snbt.ts` into the same tree.

import { charAt, isWhitespace } from "../chars.ts";
import type { Effect } from "../command.ts";
import type { VersionData } from "../data.ts";
import { ParseError } from "../diag.ts";
import { parseF64, parseI32, parseI64 } from "../numbers.ts";
import { type PResult, type Reader, isQuote } from "../reader.ts";
import type { ArgCtx, ArgValue } from "./index.ts";
import * as nbtCheck from "./nbt_check.ts";
import * as snbt from "./snbt.ts";

/** A parsed SNBT value with its file offsets. */
export interface NbtNode {
  start: number;
  end: number;
  value: NbtValue;
}

export type NbtValue =
  /** `rawBool` is set when the source wrote `true` or `false`. */
  | { kind: "Byte"; value: number; rawBool: boolean | undefined }
  | { kind: "Short"; value: number }
  | { kind: "Int"; value: number }
  | { kind: "Long"; value: bigint }
  | { kind: "Float"; value: number }
  | { kind: "Double"; value: number }
  /** `quote` is the quote character used in the source, if any. */
  | { kind: "String"; value: string; quote: string | undefined }
  | { kind: "List"; items: NbtNode[] }
  | { kind: "ByteArray"; items: NbtNode[] }
  | { kind: "IntArray"; items: NbtNode[] }
  | { kind: "LongArray"; items: NbtNode[] }
  | { kind: "Compound"; entries: NbtEntry[] };

/** `TagType.getPrettyName`, as used in vanilla's "Can't insert ..." messages. */
export function typeName(v: NbtValue): string {
  switch (v.kind) {
    case "Byte":
      return "TAG_Byte";
    case "Short":
      return "TAG_Short";
    case "Int":
      return "TAG_Int";
    case "Long":
      return "TAG_Long";
    case "Float":
      return "TAG_Float";
    case "Double":
      return "TAG_Double";
    case "String":
      return "TAG_String";
    case "List":
      return "TAG_List";
    case "ByteArray":
      return "TAG_Byte_Array";
    case "IntArray":
      return "TAG_Int_Array";
    case "LongArray":
      return "TAG_Long_Array";
    case "Compound":
      return "TAG_Compound";
  }
}

/** One `key: value` pair. Duplicate keys are all kept, in source order. */
export interface NbtEntry {
  key: string;
  keyQuote: string | undefined;
  keyStart: number;
  keyEnd: number;
  value: NbtNode;
}

export type NbtPathNode =
  /** `{...}` at the start of a path. */
  | { kind: "MatchRoot"; node: NbtNode }
  /** `name` or `"name"`, optionally followed by `{...}`. `start..end` covers
   * the name token (with its quotes); the filter has its own offsets. */
  | { kind: "Key"; name: string; quote: string | undefined; start: number; end: number; filter: NbtNode | undefined }
  /** `[3]` or `[-1]`; `start..end` includes the brackets. */
  | { kind: "Index"; index: number; start: number; end: number }
  /** `[]`. */
  | { kind: "AllElements"; start: number; end: number }
  /** `[{...}]`; the node is the `{...}` inside the brackets. */
  | { kind: "MatchElement"; node: NbtNode };

/** Whether the version reads SNBT with the grammar of 1.21.5 (`snbt.ts`). */
export function modern(data: VersionData): boolean {
  return data.atLeast([1, 21, 5]);
}

export const MAX_DEPTH = 512;
export const TOO_DEEP = "Resulting NBT too deeply nested";

export function tooDeepToCheck(): string {
  return `Stopped checking from here: the NBT is nested deeper than ${MAX_DEPTH} levels`;
}

/** `TagParser.readStruct`. Leading whitespace is skipped. */
export function parseCompound(r: Reader, modern: boolean): PResult<NbtNode> {
  return modern ? snbt.parseCompound(r) : readStruct(r, 0);
}

/** `TagParser.readValue`. Leading whitespace is skipped. */
export function parseTag(r: Reader, modern: boolean): PResult<NbtNode> {
  return modern ? snbt.parseTag(r) : readValue(r, 0);
}

/** `NbtPathArgument.parse`. Stops at a space or the end of the line. */
export function parsePath(r: Reader, modern: boolean): PResult<NbtPathNode[]> {
  const nodes: NbtPathNode[] = [];
  let first = true;
  while (r.canRead() && r.peek() !== " ") {
    const node = parsePathNode(r, first, modern);
    if (node instanceof ParseError) return node;
    nodes.push(node);
    first = false;
    const c = r.peek();
    if (c !== undefined && c !== " " && c !== "[" && c !== "{") {
      const dot = r.expect(".");
      if (dot instanceof ParseError) return dot;
    }
  }
  return nodes;
}

function parsePathNode(r: Reader, first: boolean, modern: boolean): PResult<NbtPathNode> {
  const start = r.pos;
  const c = r.peek();
  if (c !== undefined && isQuote(c)) {
    const name = r.readQuoted();
    if (name instanceof ParseError) return name;
    return readKeyNode(r, name, c, start, modern);
  }
  if (c === "[") {
    r.pos += 1;
    const d = r.peek();
    if (d === "{") {
      const compound = parseCompound(r, modern);
      if (compound instanceof ParseError) return compound;
      const close = r.expect("]");
      if (close instanceof ParseError) return close;
      return { kind: "MatchElement", node: compound };
    }
    if (d === "]") {
      r.pos += 1;
      return { kind: "AllElements", start: r.offsetOf(start), end: r.offset() };
    }
    const index = r.readInt();
    if (index instanceof ParseError) return index;
    const close = r.expect("]");
    if (close instanceof ParseError) return close;
    return { kind: "Index", index, start: r.offsetOf(start), end: r.offset() };
  }
  if (c === "{") {
    if (!first) return r.error("Invalid NBT path element");
    const compound = parseCompound(r, modern);
    if (compound instanceof ParseError) return compound;
    return { kind: "MatchRoot", node: compound };
  }
  const name = readUnquotedName(r);
  if (name instanceof ParseError) return name;
  return readKeyNode(r, name, undefined, start, modern);
}

function readKeyNode(r: Reader, name: string, quote: string | undefined, start: number, modern: boolean): PResult<NbtPathNode> {
  const end = r.offset();
  let filter: NbtNode | undefined;
  if (r.peek() === "{") {
    const compound = parseCompound(r, modern);
    if (compound instanceof ParseError) return compound;
    filter = compound;
  }
  return { kind: "Key", name, quote, start: r.offsetOf(start), end, filter };
}

function readUnquotedName(r: Reader): PResult<string> {
  const start = r.pos;
  for (let c = r.peekChar(); c !== undefined; c = r.peekChar()) {
    if (" \"'[].{}".includes(c)) break;
    r.pos += c.length;
  }
  if (r.pos === start) return r.error("Invalid NBT path element");
  return r.src.slice(start, r.pos);
}

/** Java's `Character.isWhitespace`, which `StringReader.skipWhitespace` uses. */
function isJavaWhitespace(c: string): boolean {
  const cp = c.codePointAt(0);
  if (cp === undefined || cp === 0x85 || cp === 0xa0 || cp === 0x2007 || cp === 0x202f) return false;
  if (cp >= 0x1c && cp <= 0x1f) return true;
  return isWhitespace(c);
}

export function skipWs(r: Reader): void {
  for (let c = r.peekChar(); c !== undefined && isJavaWhitespace(c); c = r.peekChar()) r.pos += c.length;
}

function expect(r: Reader, c: string): PResult<void> {
  skipWs(r);
  return r.expect(c);
}

export function finish(r: Reader, start: number, value: NbtValue): NbtNode {
  return { start: r.offsetOf(start), end: r.offset(), value };
}

export function hasElementSeparator(r: Reader): boolean {
  skipWs(r);
  if (r.peek() === ",") {
    r.pos += 1;
    skipWs(r);
    return true;
  }
  return false;
}

function readValue(r: Reader, depth: number): PResult<NbtNode> {
  skipWs(r);
  const c = r.peek();
  if (c === undefined) return r.error("Expected value");
  if ((c === "{" || c === "[") && depth >= MAX_DEPTH) return r.error(tooDeepToCheck()).warning();
  if (c === "{") return readStruct(r, depth);
  if (c === "[") return readList(r, depth);
  return readTypedValue(r);
}

function readStruct(r: Reader, depth: number): PResult<NbtNode> {
  skipWs(r);
  const start = r.pos;
  const open = r.expect("{");
  if (open instanceof ParseError) return open;
  skipWs(r);
  const entries: NbtEntry[] = [];
  while (r.canRead() && r.peek() !== "}") {
    const keyPos = r.pos;
    const key = readKey(r);
    if (key instanceof ParseError) return key;
    const [name, keyQuote] = key;
    const keyEnd = r.offset();
    const colon = expect(r, ":");
    if (colon instanceof ParseError) return colon;
    const value = readValue(r, depth + 1);
    if (value instanceof ParseError) return value;
    entries.push({ key: name, keyQuote, keyStart: r.offsetOf(keyPos), keyEnd, value });
    if (!hasElementSeparator(r)) break;
    if (!r.canRead()) return r.error("Expected key");
  }
  const close = expect(r, "}");
  if (close instanceof ParseError) return close;
  return finish(r, start, { kind: "Compound", entries });
}

function readKey(r: Reader): PResult<[string, string | undefined]> {
  skipWs(r);
  if (!r.canRead()) return r.error("Expected key");
  const start = r.pos;
  const key = r.readString();
  if (key instanceof ParseError) return key;
  if (key[0] === "") {
    r.pos = start;
    return r.error("Expected key");
  }
  return key;
}

function readTypedValue(r: Reader): PResult<NbtNode> {
  const start = r.pos;
  const q = r.peek();
  if (q !== undefined && isQuote(q)) {
    const value = r.readQuoted();
    if (value instanceof ParseError) return value;
    return finish(r, start, { kind: "String", value, quote: q });
  }
  const text = r.readUnquoted();
  if (text === "") return r.error("Expected value");
  return finish(r, start, classify(text));
}

function readList(r: Reader, depth: number): PResult<NbtNode> {
  const kind = charAt(r.src, r.pos + 1);
  if (kind !== undefined && kind !== '"' && kind !== "'" && charAt(r.src, r.pos + 1 + kind.length) === ";") {
    return readArrayTag(r, kind, depth);
  }
  return readListTag(r, depth);
}

function readListTag(r: Reader, depth: number): PResult<NbtNode> {
  const start = r.pos;
  r.pos += 1;
  skipWs(r);
  if (!r.canRead()) return r.error("Expected value");
  const items: NbtNode[] = [];
  while (r.peek() !== "]") {
    const itemPos = r.pos;
    const item = readValue(r, depth + 1);
    if (item instanceof ParseError) return item;
    const first = items[0];
    if (first !== undefined && typeName(first.value) !== typeName(item.value)) {
      return r.errorSpan(itemPos, `Can't insert ${typeName(item.value)} into list of ${typeName(first.value)}`);
    }
    items.push(item);
    if (!hasElementSeparator(r)) break;
    if (!r.canRead()) return r.error("Expected value");
  }
  const close = expect(r, "]");
  if (close instanceof ParseError) return close;
  return finish(r, start, { kind: "List", items });
}

function readArrayTag(r: Reader, kind: string, depth: number): PResult<NbtNode> {
  const start = r.pos;
  r.pos += 1;
  const kindPos = r.pos;
  r.skip();
  r.skip();
  skipWs(r);
  if (!r.canRead()) return r.error("Expected value");
  let arrayKind: "ByteArray" | "IntArray" | "LongArray";
  let arrayName: string;
  let elementName: string;
  switch (kind) {
    case "B":
      [arrayKind, arrayName, elementName] = ["ByteArray", "TAG_Byte_Array", "TAG_Byte"];
      break;
    case "I":
      [arrayKind, arrayName, elementName] = ["IntArray", "TAG_Int_Array", "TAG_Int"];
      break;
    case "L":
      [arrayKind, arrayName, elementName] = ["LongArray", "TAG_Long_Array", "TAG_Long"];
      break;
    default:
      r.pos = kindPos;
      return r.error(`Invalid array type '${kind}'`);
  }
  const items: NbtNode[] = [];
  while (r.peek() !== "]") {
    const itemPos = r.pos;
    const item = readValue(r, depth + 1);
    if (item instanceof ParseError) return item;
    if (typeName(item.value) !== elementName) {
      return r.errorSpan(itemPos, `Can't insert ${typeName(item.value)} into ${arrayName}`);
    }
    items.push(item);
    if (!hasElementSeparator(r)) break;
    if (!r.canRead()) return r.error("Expected value");
  }
  const close = expect(r, "]");
  if (close instanceof ParseError) return close;
  return finish(r, start, { kind: arrayKind, items });
}

/** `TagParser.type`: a number if the unquoted text matches one of the number
 * patterns and fits its type, `true`/`false` as a byte, otherwise a string. */
function classify(text: string): NbtValue {
  const string = (): NbtValue => ({ kind: "String", value: text, quote: undefined });
  if (text === "") return string();
  const body = text.slice(0, -1);
  const last = text.slice(-1).toLowerCase();
  if (last === "f" && isDecimal(body, false)) {
    const v = parseF64(body);
    // ponytail: f64 then f32 rounds twice, unlike an exact f32 parse; parse exactly if 25+ digit floats near a midpoint matter
    return v === undefined ? string() : { kind: "Float", value: Math.fround(v) };
  }
  if (last === "d" && isDecimal(body, false)) {
    const v = parseF64(body);
    return v === undefined ? string() : { kind: "Double", value: v };
  }
  if (last === "b" && isInteger(body)) {
    const v = parseIntIn(body, -128, 127);
    return v === undefined ? string() : { kind: "Byte", value: v, rawBool: undefined };
  }
  if (last === "l" && isInteger(body)) {
    const v = parseI64(body);
    return v === undefined ? string() : { kind: "Long", value: v };
  }
  if (last === "s" && isInteger(body)) {
    const v = parseIntIn(body, -32768, 32767);
    return v === undefined ? string() : { kind: "Short", value: v };
  }
  if (isInteger(text)) {
    const v = parseI32(text);
    return v === undefined ? string() : { kind: "Int", value: v };
  }
  if (isDecimal(text, true)) {
    const v = parseF64(text);
    return v === undefined ? string() : { kind: "Double", value: v };
  }
  const lower = text.toLowerCase();
  if (lower === "true") return { kind: "Byte", value: 1, rawBool: true };
  if (lower === "false") return { kind: "Byte", value: 0, rawBool: false };
  return string();
}

function parseIntIn(text: string, min: number, max: number): number | undefined {
  const v = parseI32(text);
  return v !== undefined && v >= min && v <= max ? v : undefined;
}

const ALL_DIGITS = /^[0-9]*$/;
const INTEGER = /^(?:0|[1-9][0-9]*)$/;

function stripSign(s: string): string {
  return s[0] === "-" || s[0] === "+" ? s.slice(1) : s;
}

/** `[-+]?(?:0|[1-9][0-9]*)` */
function isInteger(s: string): boolean {
  return INTEGER.test(stripSign(s));
}

/** `[-+]?(?:[0-9]+[.]?|[0-9]*[.][0-9]+)(?:e[-+]?[0-9]+)?`, or with the dot
 * required (`[0-9]+[.]|[0-9]*[.][0-9]+`) when `dotRequired` is set. */
function isDecimal(s: string, dotRequired: boolean): boolean {
  const unsigned = stripSign(s);
  const e = unsigned.search(/[eE]/);
  const mantissa = e < 0 ? unsigned : unsigned.slice(0, e);
  const exponent = e < 0 ? undefined : stripSign(unsigned.slice(e + 1));
  if (exponent !== undefined && (exponent === "" || !ALL_DIGITS.test(exponent))) return false;
  const dot = mantissa.indexOf(".");
  if (dot >= 0) {
    const int = mantissa.slice(0, dot);
    const frac = mantissa.slice(dot + 1);
    return ALL_DIGITS.test(int) && ALL_DIGITS.test(frac) && !(int === "" && frac === "");
  }
  return !dotRequired && mantissa !== "" && ALL_DIGITS.test(mantissa);
}

function pushAll(cx: ArgCtx, effects: readonly Effect[]): void {
  for (const e of effects) cx.effects.push(e);
}

export function check(cx: ArgCtx, node: NbtNode, target: nbtCheck.Target | undefined): void {
  pushAll(cx, nbtCheck.checkValue(cx.data, cx.config, node, target));
}

/** The last value of `kind` that an earlier argument recorded. */
function lastValue<K extends ArgValue["kind"]>(cx: ArgCtx, kind: K): Extract<ArgValue, { kind: K }> | undefined {
  for (let i = cx.values.length - 1; i >= 0; i--) {
    const v = cx.values[i]!;
    if (v.kind === kind) return v as Extract<ArgValue, { kind: K }>;
  }
  return undefined;
}

/** The entity type of the last entity argument (`@a` is a player, otherwise the selector's `type=`). */
function entityId(cx: ArgCtx): string | undefined {
  return lastValue(cx, "Entity")?.entityType;
}

/** The schema of a `minecraft:nbt_compound_tag` argument, from the command it is in. */
export function compoundTarget(cx: ArgCtx): nbtCheck.Target | undefined {
  const p = cx.path;
  if (p[0]?.name === "summon") {
    return { ...nbtCheck.new_("Entity", lastValue(cx, "Id")?.id), whole: true };
  }
  if (p[0]?.name === "data" && p[1]?.name === "merge" && p[2]?.name === "entity") {
    return nbtCheck.new_("Entity", entityId(cx));
  }
  return undefined;
}

/** The schema of a `minecraft:nbt_path` argument: the holder named right before it. */
export function pathTarget(cx: ArgCtx): nbtCheck.Target | undefined {
  switch (cx.prevLiteral()) {
    case "entity":
      return nbtCheck.new_("Entity", entityId(cx));
    case "block":
      return nbtCheck.new_("Block", undefined);
    default:
      return undefined;
  }
}

/** The `minecraft:nbt_compound_tag` argument. */
export function compoundArgument(r: Reader, cx: ArgCtx): PResult<void> {
  const node = parseCompound(r, modern(cx.data));
  if (node instanceof ParseError) return node;
  check(cx, node, compoundTarget(cx));
  return undefined;
}

/** The `minecraft:nbt_tag` argument. With a `spyglass.json`, the tag of `data
 * modify <entity|block> ... value` has a schema (see `nbtCheck.checkModifyValue`);
 * DHP never types it. */
export function tagArgument(r: Reader, cx: ArgCtx): PResult<void> {
  const node = parseTag(r, modern(cx.data));
  if (node instanceof ParseError) return node;
  const modify = cx.config.spyglass ? modifyValueTarget(cx) : undefined;
  if (modify !== undefined) {
    const [target, element, path] = modify;
    pushAll(cx, nbtCheck.checkModifyValue(cx.data, cx.config, path, target, element, node));
  } else {
    check(cx, node, undefined);
  }
  return undefined;
}

/** For the tag of `data modify <entity|block> <target> <path> <op> value`: the
 * holder's schema, whether the tag is a list element, and the target path. */
function modifyValueTarget(cx: ArgCtx): [nbtCheck.Target, boolean, NbtPathNode[]] | undefined {
  const p = cx.path;
  if (p.length < 7 || p[0]!.name !== "data" || p[1]!.name !== "modify" || p[4]!.name !== "targetPath" || p[p.length - 1]!.name !== "value") {
    return undefined;
  }
  const holder = p[2]!.name;
  const op = p[5]!.name;
  let target: nbtCheck.Target;
  if (holder === "entity") target = nbtCheck.new_("Entity", entityId(cx));
  else if (holder === "block") target = nbtCheck.new_("Block", undefined);
  else return undefined;
  target = { ...target, whole: op !== "merge" };
  const path = lastValue(cx, "Path");
  if (path === undefined) return undefined;
  return [target, op === "append" || op === "prepend" || op === "insert", path.path];
}

/** The `minecraft:nbt_path` argument. */
export function pathArgument(r: Reader, cx: ArgCtx): PResult<void> {
  const nodes = parsePath(r, modern(cx.data));
  if (nodes instanceof ParseError) return nodes;
  pushAll(cx, nbtCheck.checkPath(cx.data, cx.config, nodes, pathTarget(cx)));
  cx.values.push({ kind: "Path", path: nodes });
  return undefined;
}

/** A compound inside another argument (selector `nbt=`, block and item NBT). */
export function compoundValue(r: Reader, cx: ArgCtx, target: nbtCheck.Target | undefined): PResult<void> {
  if (r.peek() !== "{") return r.error("Expected '{'");
  const node = parseCompound(r, modern(cx.data));
  if (node instanceof ParseError) return node;
  check(cx, node, target);
  return undefined;
}
