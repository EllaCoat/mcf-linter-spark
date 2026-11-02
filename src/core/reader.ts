import { charAt, isAsciiAlphanumeric, isAsciiDigit, isWhitespace } from "./chars.ts";
import { ParseError } from "./diag.ts";
import { parseF64, parseI32, parseI64 } from "./numbers.ts";

export type PResult<T> = T | ParseError;

export function isAllowedNumber(c: string): boolean {
  return isAsciiDigit(c) || c === "." || c === "-";
}

export function isAllowedInUnquoted(c: string): boolean {
  return isAsciiAlphanumeric(c) || c === "_" || c === "-" || c === "." || c === "+";
}

export function isQuote(c: string): boolean {
  return c === '"' || c === "'";
}

/** Brigadier's StringReader over one command line. Offsets returned by the
 * reader are file offsets: `base` is the offset of `src[0]` in the file. */
export class Reader {
  src: string;
  pos: number;
  base: number;

  constructor(src: string, base: number, pos = 0) {
    this.src = src;
    this.pos = pos;
    this.base = base;
  }

  /** A copy at the same position (Rust's `Reader` is `Copy`). */
  clone(): Reader {
    return new Reader(this.src, this.base, this.pos);
  }

  offset(): number {
    return this.base + this.pos;
  }

  offsetOf(pos: number): number {
    return this.base + pos;
  }

  canRead(): boolean {
    return this.pos < this.src.length;
  }

  canReadN(n: number): boolean {
    return this.pos + n <= this.src.length;
  }

  peek(): string | undefined {
    return this.src[this.pos];
  }

  peekAt(n: number): string | undefined {
    return this.src[this.pos + n];
  }

  peekChar(): string | undefined {
    return charAt(this.src, this.pos);
  }

  rest(): string {
    return this.src.slice(this.pos);
  }

  skip(): void {
    const c = this.peekChar();
    if (c !== undefined) this.pos += c.length;
  }

  error(message: string): ParseError {
    const end = this.pos + (this.peekChar()?.length ?? 0);
    return new ParseError(this.offset(), this.offsetOf(end), message);
  }

  errorSpan(start: number, message: string): ParseError {
    const end = this.pos > start ? this.pos : start + (charAt(this.src, start)?.length ?? 0);
    return new ParseError(this.offsetOf(start), this.offsetOf(end), message);
  }

  skipWhitespace(): void {
    for (let c = this.peekChar(); c !== undefined && isWhitespace(c); c = this.peekChar()) this.pos += c.length;
  }

  expect(c: string): PResult<void> {
    if (this.peek() === c) {
      this.pos += 1;
      return;
    }
    return this.error(`Expected '${c}'`);
  }

  tryConsume(c: string): boolean {
    if (this.peek() === c) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  readWhile(f: (c: string) => boolean): string {
    const start = this.pos;
    while (this.pos < this.src.length && f(this.src[this.pos]!)) this.pos += 1;
    return this.src.slice(start, this.pos);
  }

  readUnquoted(): string {
    return this.readWhile(isAllowedInUnquoted);
  }

  /** Reads up to the next space (or the end of the line). */
  readWord(): string {
    const start = this.pos;
    for (let c = this.peekChar(); c !== undefined && c !== " "; c = this.peekChar()) this.pos += c.length;
    return this.src.slice(start, this.pos);
  }

  readQuoted(): PResult<string> {
    const start = this.pos;
    const quote = this.peek();
    if (quote === undefined || !isQuote(quote)) return this.error("Expected quote to start a string");
    this.pos += 1;
    const r = this.readUntil(quote);
    return r instanceof ParseError ? new ParseError(this.offsetOf(start), r.end, r.message) : r;
  }

  readUntil(terminator: string): PResult<string> {
    let out = "";
    let escaped = false;
    for (let c = this.peekChar(); c !== undefined; c = this.peekChar()) {
      this.pos += c.length;
      if (escaped) {
        if (c === terminator || c === "\\") {
          out += c;
          escaped = false;
        } else {
          this.pos -= c.length;
          return this.error(`Invalid escape sequence '${c}' in quoted string`);
        }
      } else if (c === "\\") {
        escaped = true;
      } else if (c === terminator) {
        return out;
      } else {
        out += c;
      }
    }
    return new ParseError(this.offset(), this.offset(), "Unclosed quoted string");
  }

  /** Returns the string and the quote character used, if any. */
  readString(): PResult<[string, string | undefined]> {
    const q = this.peek();
    if (q !== undefined && isQuote(q)) {
      const s = this.readQuoted();
      return s instanceof ParseError ? s : [s, q];
    }
    return [this.readUnquoted(), undefined];
  }

  private readNumberText(what: string): PResult<[number, string]> {
    const start = this.pos;
    const text = this.readWhile(isAllowedNumber);
    if (text === "") return this.error(`Expected ${what}`);
    return [start, text];
  }

  readInt(): PResult<number> {
    const r = this.readNumberText("integer");
    if (r instanceof ParseError) return r;
    const [start, text] = r;
    return parseI32(text) ?? this.errorSpan(start, `Invalid integer '${text}'`);
  }

  readLong(): PResult<bigint> {
    const r = this.readNumberText("long");
    if (r instanceof ParseError) return r;
    const [start, text] = r;
    return parseI64(text) ?? this.errorSpan(start, `Invalid long '${text}'`);
  }

  readDouble(): PResult<number> {
    const r = this.readNumberText("double");
    if (r instanceof ParseError) return r;
    const [start, text] = r;
    return parseJavaDouble(text) ?? this.errorSpan(start, `Invalid double '${text}'`);
  }

  readFloat(): PResult<number> {
    const r = this.readNumberText("float");
    if (r instanceof ParseError) return r;
    const [start, text] = r;
    const v = parseJavaDouble(text);
    return v === undefined ? this.errorSpan(start, `Invalid float '${text}'`) : Math.fround(v);
  }

  readBool(): PResult<boolean> {
    const start = this.pos;
    const r = this.readString();
    if (r instanceof ParseError) return r;
    const [s] = r;
    if (s === "true") return true;
    if (s === "false") return false;
    if (s === "") return this.error("Expected bool");
    return this.errorSpan(start, `Invalid bool, expected true or false but found '${s}'`);
  }
}

/** Java's Double.parseDouble accepts forms such as ".5" and "1." that Rust also
 * accepts; "-" alone and repeated signs are rejected by both. */
export function parseJavaDouble(text: string): number | undefined {
  if (text === "-" || text === "." || text === "-.") return undefined;
  return parseF64(text);
}
