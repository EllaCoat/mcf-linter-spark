// JSON syntax as Gson's `JsonReader` reads it, strict or lenient, keeping the spans of values and keys.

import { charAt, isAsciiHexDigit, utf8Len } from "./chars.ts";
import { ParseError } from "./diag.ts";
import { parseF64 } from "./numbers.ts";
import { Reader, type PResult } from "./reader.ts";

/** Offsets are UTF-16 code units into the reader's source. */
export interface Node {
  json: Json;
  start: number;
  end: number;
  /** For an object member's value, the range of its key. */
  key: [number, number] | undefined;
}

export type Json =
  | { kind: "Null" }
  | { kind: "Bool"; value: boolean }
  | { kind: "Num"; value: number }
  | { kind: "Str"; value: string }
  | { kind: "Array"; items: Node[] }
  | { kind: "Object"; fields: [string, Node][] };

export type Reading = "Strict" | "Lenient";

// ponytail: the call stack bounds the nesting; vanilla only fails on a JVM stack overflow
export const MAX_DEPTH = 256;

const MALFORMED = "Malformed JSON (strings need double quotes; comments and single quotes are not allowed)";

const BOM = "\uFEFF";

/** What ends a bare word (`unquoted`). */
const UNQUOTED_STOP = "/\\;#={}[]:, \t\f\r\n";
/** What ends a number or keyword; a lenient reader also ends it at `LENIENT_LITERAL_END`. */
const LITERAL_END = "{}[]:, \t\f\r\n";
const LENIENT_LITERAL_END = "/\\;#=";
/** What ends a word in `parsePartial`. */
const WORD_STOP = ',}]:"{[ \t\r\n';

/** A whole file. A byte order mark at the start is skipped, as Gson does. */
export function parseDocument(text: string, reading: Reading): Node | ParseError {
  const r = new Reader(text, 0);
  if (text.startsWith(BOM)) r.pos += BOM.length;
  const lenient = reading === "Lenient";
  const node = value(r, 0, lenient);
  if (node instanceof ParseError) return node;
  if (lenient) {
    const e = skipWhitespace(r, false);
    if (e instanceof ParseError) return e;
    if (r.canRead()) return r.error("Unexpected content after the JSON value");
  }
  return node;
}

export function parseValue(r: Reader, depth: number): PResult<Node> {
  return value(r, depth, false);
}

export function parseWholeLenientValue(r: Reader): PResult<Node> {
  const node = value(r, 0, true);
  if (node instanceof ParseError) return node;
  const e = skipWhitespace(r, false);
  if (e instanceof ParseError) return e;
  if (r.canRead()) return r.error("Did not consume the entire document");
  return node;
}

function value(r: Reader, depth: number, lenient: boolean): PResult<Node> {
  const e = skipWhitespace(r, lenient);
  if (e instanceof ParseError) return e;
  const start = r.pos;
  const c = r.peek();
  let json: Json;
  if (c === undefined) {
    return r.error("Unexpected end of input");
  } else if (c === '"' || (c === "'" && lenient)) {
    const s = parseString(r);
    if (s instanceof ParseError) return s;
    json = { kind: "Str", value: s };
  } else if ((c === "[" || c === "{") && depth >= MAX_DEPTH) {
    return r.error("Nesting is too deep");
  } else if (c === "[" || c === "{") {
    const j = c === "[" ? parseArray(r, depth, lenient) : parseObject(r, depth, lenient);
    if (j instanceof ParseError) return j;
    json = j;
  } else {
    const j = parseLiteral(r, lenient);
    if (j instanceof ParseError) return j;
    json = j;
  }
  return { json, start, end: r.pos, key: undefined };
}

const isJsonWhitespace = (c: string): boolean => c === " " || c === "\t" || c === "\r" || c === "\n";
const isNotLineEnd = (c: string): boolean => c !== "\n" && c !== "\r";

/** Gson skips only these four whitespace characters, and in a lenient reader the comments `//`
 * and `#` (to the end of the line) and block comments. */
function skipWhitespace(r: Reader, lenient: boolean): PResult<void> {
  for (;;) {
    r.readWhile(isJsonWhitespace);
    if (!lenient) {
      return;
    } else if (r.src.startsWith("//", r.pos) || r.src.startsWith("#", r.pos)) {
      r.readWhile(isNotLineEnd);
    } else if (r.src.startsWith("/*", r.pos)) {
      const close = r.src.indexOf("*/", r.pos + 2);
      if (close < 0) return r.error("Unterminated comment");
      r.pos = close + 2;
    } else {
      return;
    }
  }
}

function parseArray(r: Reader, depth: number, lenient: boolean): PResult<Json> {
  r.pos += 1;
  const items: Node[] = [];
  let e = skipWhitespace(r, lenient);
  if (e instanceof ParseError) return e;
  if (r.tryConsume("]")) return { kind: "Array", items };
  for (;;) {
    e = skipWhitespace(r, lenient);
    if (e instanceof ParseError) return e;
    const c = r.peek();
    if (lenient && (c === "," || c === ";" || c === "]")) {
      items.push({ json: { kind: "Null" }, start: r.pos, end: r.pos, key: undefined });
    } else if (c === "]") {
      return r.error("Trailing comma before ']'");
    } else {
      const item = value(r, depth + 1, lenient);
      if (item instanceof ParseError) return item;
      items.push(item);
    }
    e = skipWhitespace(r, lenient);
    if (e instanceof ParseError) return e;
    const d = r.peek();
    if (d === ",") {
      r.pos += 1;
    } else if (d === ";" && lenient) {
      r.pos += 1;
    } else if (d === "]") {
      r.pos += 1;
      return { kind: "Array", items };
    } else if (d === undefined) {
      return r.error("Unterminated array");
    } else {
      return r.error("Expected ',' or ']'");
    }
  }
}

function parseObject(r: Reader, depth: number, lenient: boolean): PResult<Json> {
  r.pos += 1;
  const fields: [string, Node][] = [];
  let e = skipWhitespace(r, lenient);
  if (e instanceof ParseError) return e;
  if (r.tryConsume("}")) return { kind: "Object", fields };
  let separator = ",";
  for (;;) {
    e = skipWhitespace(r, lenient);
    if (e instanceof ParseError) return e;
    const keyStart = r.pos;
    const c = r.peek();
    let name: string;
    if (c === "}" && separator === ";") {
      return r.error("Trailing ';' before '}'");
    } else if (c === "}") {
      return r.error("Trailing comma before '}'");
    } else if (c === '"' || (c === "'" && lenient)) {
      const s = parseString(r);
      if (s instanceof ParseError) return s;
      name = s;
    } else if (c === undefined) {
      return r.error("Unterminated object");
    } else if (lenient) {
      const word = unquoted(r);
      if (word === "") return r.error("Expected name");
      name = word;
    } else {
      return r.error(MALFORMED);
    }
    const key: [number, number] = [keyStart, r.pos];
    e = skipWhitespace(r, lenient);
    if (e instanceof ParseError) return e;
    const colon = r.peek();
    if (colon === ":") {
      r.pos += 1;
    } else if (colon === "=" && lenient) {
      r.pos += 1;
      r.tryConsume(">");
    } else {
      return r.error("Expected ':'");
    }
    const member = value(r, depth + 1, lenient);
    if (member instanceof ParseError) return member;
    member.key = key;
    fields.push([name, member]);
    e = skipWhitespace(r, lenient);
    if (e instanceof ParseError) return e;
    const d = r.peek();
    if (d === ",") {
      separator = ",";
      r.pos += 1;
    } else if (d === ";" && lenient) {
      separator = ";";
      r.pos += 1;
    } else if (d === "}") {
      r.pos += 1;
      return { kind: "Object", fields };
    } else if (d === undefined) {
      return r.error("Unterminated object");
    } else {
      return r.error("Expected ',' or '}'");
    }
  }
}

const isUnquotedChar = (c: string): boolean => !UNQUOTED_STOP.includes(c);

function unquoted(r: Reader): string {
  return r.readWhile(isUnquotedChar);
}

/** `true`, `false`, `null` (each letter in either case) and numbers. A lenient reader takes
 * any other word as a string without quotes. */
function parseLiteral(r: Reader, lenient: boolean): PResult<Json> {
  const { src, pos } = r;
  const numLen = numberLen(src, pos);
  let found: { len: number; json: Json } | undefined;
  if (numLen !== undefined) {
    found = { len: numLen, json: { kind: "Num", value: parseF64(src.slice(pos, pos + numLen)) ?? NaN } };
  } else {
    found = keyword(src, pos);
  }
  if (found !== undefined && literalEnds(src, pos + found.len, lenient)) {
    r.pos += found.len;
    return found.json;
  }
  if (lenient) {
    const word = unquoted(r);
    return word === "" ? r.error("Expected a value") : { kind: "Str", value: word };
  }
  return r.error(MALFORMED);
}

function literalEnds(src: string, index: number, lenient: boolean): boolean {
  const c = src[index];
  return c === undefined || LITERAL_END.includes(c) || (lenient && LENIENT_LITERAL_END.includes(c));
}

const KEYWORDS: readonly (readonly [string, Json])[] = [
  ["true", { kind: "Bool", value: true }],
  ["false", { kind: "Bool", value: false }],
  ["null", { kind: "Null" }],
];

function keyword(src: string, pos: number): { len: number; json: Json } | undefined {
  for (const [word, json] of KEYWORDS) {
    if (startsWithIgnoreAsciiCase(src, pos, word)) return { len: word.length, json };
  }
  return undefined;
}

/** Whether `src` has `word` (lowercase ASCII) at `pos`, ignoring the case of ASCII letters only. */
function startsWithIgnoreAsciiCase(src: string, pos: number, word: string): boolean {
  if (pos + word.length > src.length) return false;
  for (let i = 0; i < word.length; i++) {
    let u = src.charCodeAt(pos + i);
    if (u >= 0x41 && u <= 0x5a) u += 0x20;
    if (u !== word.charCodeAt(i)) return false;
  }
  return true;
}

function digitsFrom(src: string, from: number): number {
  let n = 0;
  while (isDigitCode(src.charCodeAt(from + n))) n += 1;
  return n;
}

function isDigitCode(u: number): boolean {
  return u >= 0x30 && u <= 0x39;
}

/** The length of the number at `pos`: `-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?` */
function numberLen(src: string, pos: number): number | undefined {
  let i = pos;
  if (src.charCodeAt(i) === 0x2d) i += 1;
  const first = src.charCodeAt(i);
  if (first === 0x30) i += 1;
  else if (first >= 0x31 && first <= 0x39) i += digitsFrom(src, i);
  else return undefined;
  if (src[i] === ".") {
    const n = digitsFrom(src, i + 1);
    if (n === 0) return undefined;
    i += 1 + n;
  }
  const e = src[i];
  if (e === "e" || e === "E") {
    const s = src[i + 1];
    const sign = s === "+" || s === "-" ? 1 : 0;
    const n = digitsFrom(src, i + 1 + sign);
    if (n === 0) return undefined;
    i += 1 + sign + n;
  }
  return i - pos;
}

function parseString(r: Reader): PResult<string> {
  const start = r.pos;
  const quote = r.peekChar() ?? '"';
  r.pos += 1;
  let out = "";
  for (;;) {
    const c = r.peekChar();
    if (c === undefined) return r.errorSpan(start, "Unterminated string");
    r.pos += c.length;
    if (c === "\\") {
      const decoded = parseEscape(r);
      if (decoded instanceof ParseError) return decoded;
      out += decoded;
    } else if (c === quote) {
      return out;
    } else {
      out += c;
    }
  }
}

/** Reads the character after a backslash. */
function parseEscape(r: Reader): PResult<string> {
  const c = r.peekChar();
  if (c === undefined) return r.error("Unterminated escape sequence");
  let decoded: string;
  switch (c) {
    case '"':
    case "'":
    case "\\":
    case "/":
    case "\n":
      decoded = c;
      break;
    case "b":
      decoded = "\b";
      break;
    case "f":
      decoded = "\f";
      break;
    case "n":
      decoded = "\n";
      break;
    case "r":
      decoded = "\r";
      break;
    case "t":
      decoded = "\t";
      break;
    case "u":
      r.pos += 1;
      return parseUnicodeEscape(r);
    default:
      return r.error("Invalid escape sequence");
  }
  r.pos += c.length;
  return decoded;
}

/** After `\u`. A lone surrogate becomes U+FFFD. */
function parseUnicodeEscape(r: Reader): PResult<string> {
  const high = parseHex4(r);
  if (high instanceof ParseError) return high;
  if (high >= 0xd800 && high < 0xdc00 && r.src.startsWith("\\u", r.pos)) {
    const before = r.pos;
    r.pos += 2;
    const low = parseHex4(r);
    if (typeof low === "number" && low >= 0xdc00 && low < 0xe000) {
      return String.fromCodePoint(0x10000 + ((high - 0xd800) << 10) + (low - 0xdc00));
    }
    r.pos = before;
  }
  return high >= 0xd800 && high < 0xe000 ? "�" : String.fromCodePoint(high);
}

function parseHex4(r: Reader): PResult<number> {
  const digits = r.src.slice(r.pos, r.pos + 4);
  // Fewer than 4 units that take 4 or more UTF-8 bytes are an invalid escape, not an unterminated one.
  if (digits.length < 4 && utf8Len(digits) < 4) return r.error("Unterminated escape sequence");
  if (digits.length < 4) return r.error("Invalid unicode escape");
  for (let i = 0; i < 4; i++) {
    if (!isAsciiHexDigit(digits[i]!)) return r.error("Invalid unicode escape");
  }
  r.pos += 4;
  return Number.parseInt(digits, 16);
}

/** Reads as much of a value as the text has, for completion while it is typed. Strings,
 * objects, and lists left open end at the end of the text (a string also at the end of its
 * line), a key with no value yet gets an empty `null` where the value would start, a word
 * that is no JSON literal is read as a string, and a character that starts nothing is skipped. */
export function parsePartial(text: string): Node {
  const p = new PartialParser(text);
  p.whitespace();
  return p.value(0);
}

class PartialParser {
  readonly text: string;
  pos = 0;

  constructor(text: string) {
    this.text = text;
  }

  peek(): string | undefined {
    return this.text[this.pos];
  }

  whitespace(): void {
    for (let c = this.peek(); c === " " || c === "\t" || c === "\r" || c === "\n"; c = this.peek()) this.pos += 1;
  }

  empty(): Node {
    return { json: { kind: "Null" }, start: this.pos, end: this.pos, key: undefined };
  }

  value(depth: number): Node {
    const start = this.pos;
    const c = this.peek();
    let json: Json;
    if (c === undefined || c === "," || c === "}" || c === "]" || c === ":") {
      return this.empty();
    } else if (c === "{" && depth < MAX_DEPTH) {
      json = this.object(depth);
    } else if (c === "[" && depth < MAX_DEPTH) {
      json = this.array(depth);
    } else if (c === '"') {
      json = { kind: "Str", value: this.string() };
    } else {
      const word = this.word();
      if (word === "true") {
        json = { kind: "Bool", value: true };
      } else if (word === "false") {
        json = { kind: "Bool", value: false };
      } else if (word === "null") {
        json = { kind: "Null" };
      } else {
        const n = parseF64(word);
        json = n === undefined ? { kind: "Str", value: word } : { kind: "Num", value: n };
      }
    }
    return { json, start, end: this.pos, key: undefined };
  }

  word(): string {
    const start = this.pos;
    for (let c = this.peek(); c !== undefined; c = this.peek()) {
      if (WORD_STOP.includes(c)) break;
      this.pos += 1;
    }
    return this.text.slice(start, this.pos);
  }

  string(): string {
    this.pos += 1;
    let out = "";
    for (let c = charAt(this.text, this.pos); c !== undefined; c = charAt(this.text, this.pos)) {
      if (c === '"') {
        this.pos += 1;
        break;
      } else if (c === "\n") {
        break;
      } else if (c === "\\") {
        this.pos += 1;
        const e = charAt(this.text, this.pos);
        if (e !== undefined) {
          this.pos += e.length;
          out += e === "n" ? "\n" : e === "t" ? "\t" : e;
        }
      } else {
        this.pos += c.length;
        out += c;
      }
    }
    return out;
  }

  object(depth: number): Json {
    this.pos += 1;
    const fields: [string, Node][] = [];
    for (;;) {
      this.whitespace();
      const c = this.peek();
      if (c === undefined) {
        break;
      } else if (c === "}") {
        this.pos += 1;
        break;
      } else if (c === "," || c === "{" || c === "[" || c === ":") {
        this.pos += 1;
        continue;
      }
      const keyStart = this.pos;
      const name = c === '"' ? this.string() : this.word();
      if (this.pos === keyStart) {
        this.pos += 1;
        continue;
      }
      const key: [number, number] = [keyStart, this.pos];
      this.whitespace();
      let member: Node;
      if (this.peek() === ":") {
        this.pos += 1;
        this.whitespace();
        member = this.value(depth + 1);
      } else {
        member = this.empty();
      }
      member.key = key;
      fields.push([name, member]);
    }
    return { kind: "Object", fields };
  }

  array(depth: number): Json {
    this.pos += 1;
    const items: Node[] = [];
    for (;;) {
      this.whitespace();
      const c = this.peek();
      if (c === undefined) {
        break;
      } else if (c === "]") {
        this.pos += 1;
        break;
      } else if (c === ",") {
        this.pos += 1;
        continue;
      }
      const before = this.pos;
      const item = this.value(depth + 1);
      if (this.pos === before) {
        this.pos += 1;
        continue;
      }
      items.push(item);
    }
    return { kind: "Array", items };
  }
}
