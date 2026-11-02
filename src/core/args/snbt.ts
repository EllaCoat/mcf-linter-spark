// SNBT of 1.21.5 and later (`SnbtGrammar`, `SnbtOperations`), read into the tree of `nbt.ts`.
// The error messages are the game's (`snbt.parser.*` in `en_us.json`).

import { isAsciiAlphanumeric, isAsciiDigit, isAsciiHexDigit, utf8Len } from "../chars.ts";
import { ParseError } from "../diag.ts";
import { parseF64 } from "../numbers.ts";
import { type PResult, type Reader, isAllowedInUnquoted } from "../reader.ts";
import { MAX_DEPTH, type NbtEntry, type NbtNode, type NbtValue, TOO_DEEP, finish, hasElementSeparator, skipWs } from "./nbt.ts";

/** `TagParser.parseAsArgument`: one value. Leading whitespace is skipped. */
export function parseTag(r: Reader): PResult<NbtNode> {
  skipWs(r);
  return literal(r, 0);
}

/** `TagParser.parseCompoundAsArgument`: a value that must be a compound. */
export function parseCompound(r: Reader): PResult<NbtNode> {
  skipWs(r);
  const start = r.pos;
  const node = literal(r, 0);
  if (node instanceof ParseError) return node;
  return node.value.kind === "Compound" ? node : r.errorSpan(start, "Expected compound tag");
}

function literal(r: Reader, depth: number): PResult<NbtNode> {
  const start = r.pos;
  const c = r.peek();
  if (c === undefined) return r.error("Expected value");
  if ((c === "{" || c === "[") && depth >= MAX_DEPTH) return r.error(TOO_DEEP);
  if (c === "+" || c === "-" || c === "." || isAsciiDigit(c)) {
    const token = r.readWhile(isAllowedInUnquoted);
    const n = number(token, "Int");
    if (n instanceof NumberError) return r.errorSpan(start, n.message);
    return finish(r, start, n.value);
  }
  if (c === '"' || c === "'") {
    const value = quoted(r, c);
    if (value instanceof ParseError) return value;
    return finish(r, start, { kind: "String", value, quote: c });
  }
  if (c === "{") return compound(r, depth);
  if (c === "[") return list(r, depth);
  const word = r.readWhile(isAllowedInUnquoted);
  if (word === "") return r.error("Expected value");
  const beforeArgs = r.pos;
  skipWs(r);
  if (r.peek() === "(") {
    if (depth >= MAX_DEPTH) return r.error(TOO_DEEP);
    return operation(r, start, word, depth);
  }
  r.pos = beforeArgs;
  const lower = word.toLowerCase();
  if (lower === "true") return finish(r, start, { kind: "Byte", value: 1, rawBool: true });
  if (lower === "false") return finish(r, start, { kind: "Byte", value: 0, rawBool: false });
  return finish(r, start, { kind: "String", value: word, quote: undefined });
}

function compound(r: Reader, depth: number): PResult<NbtNode> {
  const start = r.pos;
  r.pos += 1;
  skipWs(r);
  const entries: NbtEntry[] = [];
  while (r.canRead() && r.peek() !== "}") {
    const keyPos = r.pos;
    const q = r.peek();
    let key: string;
    let keyQuote: string | undefined;
    if (q === '"' || q === "'") {
      const k = quoted(r, q);
      if (k instanceof ParseError) return k;
      if (k === "") return r.errorSpan(keyPos, "Key cannot be empty");
      key = k;
      keyQuote = q;
    } else {
      key = r.readWhile(isAllowedInUnquoted);
      if (key === "") return r.error("Expected key");
      keyQuote = undefined;
    }
    const keyEnd = r.offset();
    skipWs(r);
    const colon = r.expect(":");
    if (colon instanceof ParseError) return colon;
    skipWs(r);
    const value = literal(r, depth + 1);
    if (value instanceof ParseError) return value;
    entries.push({ key, keyQuote, keyStart: r.offsetOf(keyPos), keyEnd, value });
    if (!hasElementSeparator(r)) break;
  }
  skipWs(r);
  const close = r.expect("}");
  if (close instanceof ParseError) return close;
  return finish(r, start, { kind: "Compound", entries });
}

function list(r: Reader, depth: number): PResult<NbtNode> {
  const start = r.pos;
  r.pos += 1;
  skipWs(r);
  const first = r.pos;
  const kind = r.peek();
  if (kind === "B" || kind === "I" || kind === "L") {
    r.pos += 1;
    skipWs(r);
    if (r.tryConsume(";")) return arrayTag(r, start, kind);
    r.pos = first;
  }
  const items: NbtNode[] = [];
  while (r.canRead() && r.peek() !== "]") {
    const item = literal(r, depth + 1);
    if (item instanceof ParseError) return item;
    items.push(item);
    if (!hasElementSeparator(r)) break;
  }
  skipWs(r);
  const close = r.expect("]");
  if (close instanceof ParseError) return close;
  return finish(r, start, { kind: "List", items });
}

/** The integer literals after `[B;`, `[I;` or `[L;`. An element without a suffix takes the
 * array's type; one with a suffix may be of a narrower type. */
function arrayTag(r: Reader, start: number, kind: "B" | "I" | "L"): PResult<NbtNode> {
  skipWs(r);
  let element: IntType;
  let allowed: readonly IntType[];
  switch (kind) {
    case "B":
      [element, allowed] = ["Byte", ["Byte"]];
      break;
    case "I":
      [element, allowed] = ["Int", ["Byte", "Short", "Int"]];
      break;
    case "L":
      [element, allowed] = ["Long", ["Byte", "Short", "Int", "Long"]];
      break;
  }
  const items: NbtNode[] = [];
  while (r.canRead() && r.peek() !== "]") {
    const itemPos = r.pos;
    const c = r.peek();
    if (c === undefined || !(c === "+" || c === "-" || isAsciiDigit(c))) return r.error("Invalid array element type");
    const token = r.readWhile(isAllowedInUnquoted);
    const n = number(token, element);
    if (n instanceof NumberError) return r.errorSpan(itemPos, n.message);
    const int = intOf(n.value);
    if (int === undefined || (n.suffixed && !allowed.includes(int[0]))) return r.errorSpan(itemPos, "Invalid array element type");
    items.push(finish(r, itemPos, intValue(element, int[1])));
    if (!hasElementSeparator(r)) break;
  }
  skipWs(r);
  const close = r.expect("]");
  if (close instanceof ParseError) return close;
  switch (kind) {
    case "B":
      return finish(r, start, { kind: "ByteArray", items });
    case "I":
      return finish(r, start, { kind: "IntArray", items });
    case "L":
      return finish(r, start, { kind: "LongArray", items });
  }
}

/** `name(arguments)`: `bool` and `uuid`, each of one argument. */
function operation(r: Reader, start: number, name: string, depth: number): PResult<NbtNode> {
  r.pos += 1;
  skipWs(r);
  const args: NbtNode[] = [];
  while (r.canRead() && r.peek() !== ")") {
    const arg = literal(r, depth + 1);
    if (arg instanceof ParseError) return arg;
    args.push(arg);
    if (!hasElementSeparator(r)) break;
  }
  skipWs(r);
  const close = r.expect(")");
  if (close instanceof ParseError) return close;
  const arg = args[0];
  if (name === "bool" && args.length === 1 && arg !== undefined) {
    const v = arg.value;
    let truth: boolean;
    switch (v.kind) {
      case "Byte":
      case "Short":
      case "Int":
      case "Double":
      case "Float":
        truth = v.value !== 0;
        break;
      case "Long":
        truth = v.value !== 0n;
        break;
      default:
        return r.errorSpan(start, "Expected a number or a boolean");
    }
    return finish(r, start, { kind: "Byte", value: truth ? 1 : 0, rawBool: undefined });
  }
  if (name === "uuid" && args.length === 1 && arg !== undefined) {
    const ints = arg.value.kind === "String" ? uuidInts(arg.value.value) : undefined;
    if (ints === undefined) return r.errorSpan(start, "Expected a string representing a valid UUID");
    const nodes: NbtNode[] = ints.map((v) => finish(r, start, { kind: "Int", value: v }));
    return finish(r, start, { kind: "IntArray", items: nodes });
  }
  return r.errorSpan(start, `No such operation: ${name}/${args.length}`);
}

const U64_MAX = 0xffff_ffff_ffff_ffffn;

/** `UUID.fromString` and `UUIDUtil.uuidToIntArray`. */
function uuidInts(s: string): [number, number, number, number] | undefined {
  const parts = s.split("-");
  if (utf8Len(s) > 36 || parts.length !== 5 || parts.some((p) => p === "" || !/^[0-9a-fA-F]+$/.test(p))) return undefined;
  const fields = parts.map((p) => BigInt(`0x${p}`));
  if (fields.some((f) => f > U64_MAX)) return undefined;
  const [f0, f1, f2, f3, f4] = fields as [bigint, bigint, bigint, bigint, bigint];
  const most = ((f0 & 0xffff_ffffn) << 32n) | ((f1 & 0xffffn) << 16n) | (f2 & 0xffffn);
  const least = ((f3 & 0xffffn) << 48n) | (f4 & 0xffff_ffff_ffffn);
  const i32 = (x: bigint): number => Number(BigInt.asIntN(32, x));
  return [i32(most >> 32n), i32(most), i32(least >> 32n), i32(least)];
}

function quoted(r: Reader, q: string): PResult<string> {
  const start = r.pos;
  r.pos += 1;
  let out = "";
  for (;;) {
    const c = r.peekChar();
    if (c === undefined) return r.errorSpan(start, "Unclosed quoted string");
    if (c === q) {
      r.pos += 1;
      return out;
    }
    if (c === "\\") {
      r.pos += 1;
      const e = escape(r);
      if (e instanceof ParseError) return e;
      out += e;
    } else {
      out += c;
      r.pos += c.length;
    }
  }
}

/** The text that the escape sequence after a `\` stands for. */
function escape(r: Reader): PResult<string> {
  const c = r.peekChar();
  if (c === undefined) return r.error("Invalid string contents");
  r.pos += c.length;
  switch (c) {
    case "b":
      return "\b";
    case "s":
      return " ";
    case "t":
      return "\t";
    case "n":
      return "\n";
    case "f":
      return "\f";
    case "r":
      return "\r";
    case "\\":
    case "'":
    case '"':
      return c;
  }
  let len: number;
  switch (c) {
    case "x":
      len = 2;
      break;
    case "u":
      len = 4;
      break;
    case "U":
      len = 8;
      break;
    case "N": {
      const start = r.pos;
      const open = r.expect("{");
      if (open instanceof ParseError) return open;
      const name = r.readWhile((b) => isAsciiAlphanumeric(b) || b === "-" || b === " ");
      if (name === "" || !r.tryConsume("}")) return r.errorSpan(start, "Invalid Unicode character name");
      // ponytail: Unicode names are not looked up, an unknown name passes; add the name table if it matters
      return "\u{fffd}";
    }
    default:
      r.pos -= c.length;
      return r.error("Invalid string contents");
  }
  const start = r.pos;
  let found = 0;
  while (found < len && start + found < r.src.length && isAsciiHexDigit(r.src[start + found]!)) found++;
  if (found < len) return r.error(`Expected a character literal of length ${len}`);
  const hex = r.src.slice(start, start + len);
  r.pos += len;
  const cp = parseInt(hex, 16);
  if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return r.errorSpan(start, `Invalid Unicode character value: ${hex}`);
  return String.fromCodePoint(cp);
}

type IntType = "Byte" | "Short" | "Int" | "Long";

function intBits(t: IntType): bigint {
  switch (t) {
    case "Byte":
      return 8n;
    case "Short":
      return 16n;
    case "Int":
      return 32n;
    case "Long":
      return 64n;
  }
}

/** The tag of a value already in the type's range (two's complement for unsigned ones). */
function intValue(t: IntType, v: bigint): NbtValue {
  switch (t) {
    case "Byte":
      return { kind: "Byte", value: Number(v), rawBool: undefined };
    case "Short":
      return { kind: "Short", value: Number(v) };
    case "Int":
      return { kind: "Int", value: Number(v) };
    case "Long":
      return { kind: "Long", value: v };
  }
}

function intOf(value: NbtValue): [IntType, bigint] | undefined {
  switch (value.kind) {
    case "Byte":
      return ["Byte", BigInt(value.value)];
    case "Short":
      return ["Short", BigInt(value.value)];
    case "Int":
      return ["Int", BigInt(value.value)];
    case "Long":
      return ["Long", value.value];
    default:
      return undefined;
  }
}

function intType(c: string): IntType | undefined {
  switch (c) {
    case "b":
      return "Byte";
    case "s":
      return "Short";
    case "i":
      return "Int";
    case "l":
      return "Long";
    default:
      return undefined;
  }
}

/** A message-only failure of the number readers, which the caller turns into a `ParseError` with a span. */
class NumberError {
  readonly message: string;

  constructor(message: string) {
    this.message = message;
  }
}

const UNQUOTED_START = "Unquoted strings can't start with digits 0-9, + or -";
const U128_MAX = (1n << 128n) - 1n;

/** A number literal (`SnbtGrammar` 346-436): the value, and whether it had a type suffix. An
 * integer without a suffix is of `defaultType`. */
function number(token: string, defaultType: IntType): { value: NbtValue; suffixed: boolean } | NumberError {
  let negative = false;
  let body = token;
  if (token[0] === "-") {
    negative = true;
    body = token.slice(1);
  } else if (token[0] === "+") {
    body = token.slice(1);
  }
  const lower = body.toLowerCase();
  let radix: 2 | 16 | undefined;
  if (lower.startsWith("0x")) radix = 16;
  else if (lower.startsWith("0b") && /^[01_]/.test(lower.slice(2))) radix = 2;
  if (radix !== undefined) {
    const after = body.slice(2);
    let n = 0;
    while (n < after.length && (after[n] === "_" || isRadixDigit(after[n]!, radix))) n++;
    const digitRun = after.slice(0, n);
    const suffix = after.slice(n);
    if (digitRun === "") return new NumberError(radix === 16 ? "Expected a hexadecimal number" : "Expected a binary number");
    const v = integer(digitRun, radix, negative, suffix, true, defaultType);
    return v instanceof NumberError ? v : { value: v, suffixed: suffix !== "" };
  }
  const digitsEnd = (s: string): number => {
    let i = 0;
    while (i < s.length && (isAsciiDigit(s[i]!) || s[i] === "_")) i++;
    return i;
  };
  const intEnd = digitsEnd(body);
  const intPart = body.slice(0, intEnd);
  let rest = body.slice(intEnd);
  let fraction: string | undefined;
  if (rest.startsWith(".")) {
    const after = rest.slice(1);
    const fractionEnd = digitsEnd(after);
    fraction = after.slice(0, fractionEnd);
    rest = after.slice(fractionEnd);
  }
  if (intPart === "" && (fraction === undefined || fraction === "")) return new NumberError(UNQUOTED_START);
  let exponent: string | undefined;
  let suffix = rest;
  if (rest.startsWith("e") || rest.startsWith("E")) {
    const after = rest.slice(1);
    const signLen = after.startsWith("+") || after.startsWith("-") ? 1 : 0;
    const len = signLen + digitsEnd(after.slice(signLen));
    if (len === signLen) return new NumberError("Expected a decimal number");
    exponent = after.slice(0, len);
    suffix = after.slice(len);
  }
  const hasFloatPart = fraction !== undefined || exponent !== undefined;
  let single: boolean;
  if (suffix === "f" || suffix === "F") {
    single = true;
  } else if (suffix === "d" || suffix === "D") {
    single = false;
  } else if (suffix === "" && hasFloatPart) {
    single = false;
  } else if (hasFloatPart) {
    return new NumberError(UNQUOTED_START);
  } else {
    if (intPart.length > 1 && intPart.startsWith("0")) return new NumberError("Decimal numbers can't start with 0");
    const v = integer(intPart, 10, negative, suffix, false, defaultType);
    return v instanceof NumberError ? v : { value: v, suffixed: suffix !== "" };
  }
  let text = negative ? "-" : "";
  const intDigits = digits(intPart);
  if (intDigits instanceof NumberError) return intDigits;
  text += intDigits;
  if (fraction !== undefined) {
    const fractionDigits = digits(fraction);
    if (fractionDigits instanceof NumberError) return fractionDigits;
    text = `${text}.${fractionDigits}`;
  }
  if (exponent !== undefined) {
    const signLen = exponent.startsWith("+") || exponent.startsWith("-") ? 1 : 0;
    const exponentDigits = digits(exponent.slice(signLen));
    if (exponentDigits instanceof NumberError) return exponentDigits;
    text = `${text}e${exponent.slice(0, signLen)}${exponentDigits}`;
  }
  const parsed = parseF64(text);
  if (parsed === undefined) return new NumberError(`Failed to parse number: ${token}`);
  // ponytail: f64 then f32 rounds twice, unlike Rust's `parse::<f32>`; parse exactly if 25+ digit floats near a midpoint matter
  const v = single ? Math.fround(parsed) : parsed;
  if (!Number.isFinite(v)) return new NumberError("Non-finite numbers are not allowed");
  return { value: single ? { kind: "Float", value: v } : { kind: "Double", value: v }, suffixed: suffix !== "" };
}

function isRadixDigit(c: string, radix: 2 | 16): boolean {
  return radix === 16 ? isAsciiHexDigit(c) : c === "0" || c === "1";
}

/** The digits of one numeral without its `_`, which may only be between digits. */
function digits(run: string): string | NumberError {
  if (run.startsWith("_") || run.endsWith("_")) {
    return new NumberError("Underscore characters are not allowed at the start or end of a number");
  }
  return run.replaceAll("_", "");
}

function integer(
  digitsRun: string,
  radix: 2 | 10 | 16,
  negative: boolean,
  suffix: string,
  unsignedDefault: boolean,
  defaultType: IntType,
): NbtValue | NumberError {
  const lower = suffix.toLowerCase();
  let sign: boolean | undefined;
  let type: IntType | undefined;
  if (lower.length === 0) {
    type = defaultType;
  } else if (lower.length === 1) {
    type = intType(lower);
  } else if (lower.length === 2 && (lower[0] === "u" || lower[0] === "s")) {
    sign = lower[0] === "u";
    type = intType(lower[1]!);
  }
  if (type === undefined) return new NumberError(UNQUOTED_START);
  const clean = digits(digitsRun);
  if (clean instanceof NumberError) return clean;
  const unsigned = sign ?? unsignedDefault;
  const failure = (): NumberError => new NumberError(`Failed to parse number: ${negative ? "-" : ""}${clean}`);
  const magnitude = BigInt(radix === 16 ? `0x${clean}` : radix === 2 ? `0b${clean}` : clean);
  if (magnitude > U128_MAX) return failure();
  const bits = intBits(type);
  const half = 1n << (bits - 1n);
  let value: bigint;
  if (unsigned) {
    if (negative) return new NumberError("Expected a non-negative number");
    if (magnitude >= 1n << bits) return failure();
    value = magnitude >= half ? magnitude - (1n << bits) : magnitude;
  } else {
    if (magnitude > half) return failure();
    value = negative ? -magnitude : magnitude;
    if (value >= half) return failure();
  }
  return intValue(type, value);
}
