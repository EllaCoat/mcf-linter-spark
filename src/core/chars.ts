// Positions and string indexes are UTF-16 code units, as JS strings count them. The helpers here
// count and compare by code point, or by UTF-8 byte, where the checks need that instead.

const WHITESPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/** Unicode White_Space. Unlike `\s`, U+0085 counts and U+FEFF does not. */
export function isWhitespace(c: string): boolean {
  const cp = c.codePointAt(0);
  return cp !== undefined && WHITESPACE.has(cp);
}

/** Whether `c` is a control character (Unicode `Cc`). */
export function isControl(c: string): boolean {
  const cp = c.codePointAt(0)!;
  return cp < 0x20 || (cp >= 0x7f && cp < 0xa0);
}

/** `s` without leading Unicode White_Space. JS's `trimStart` also strips U+FEFF but not U+0085. */
export function trimStartWhiteSpace(s: string): string {
  let start = 0;
  while (start < s.length && isWhitespace(s[start]!)) start += 1;
  return s.slice(start);
}

/** `s` without trailing Unicode White_Space. JS's `trimEnd` also strips U+FEFF but not U+0085. */
export function trimEndWhiteSpace(s: string): string {
  let end = s.length;
  while (end > 0 && isWhitespace(s[end - 1]!)) end -= 1;
  return s.slice(0, end);
}

export function trimWhiteSpace(s: string): string {
  return trimStartWhiteSpace(trimEndWhiteSpace(s));
}

/** Space, tab, LF, form feed, or CR (not vertical tab). */
export function isAsciiWhitespace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";
}

export function isAsciiDigit(c: string): boolean {
  return c.length === 1 && c >= "0" && c <= "9";
}

export function isAsciiAlphabetic(c: string): boolean {
  return c.length === 1 && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z"));
}

export function isAsciiAlphanumeric(c: string): boolean {
  return isAsciiDigit(c) || isAsciiAlphabetic(c);
}

export function isAsciiHexDigit(c: string): boolean {
  return isAsciiDigit(c) || (c.length === 1 && ((c >= "a" && c <= "f") || (c >= "A" && c <= "F")));
}

export function isAsciiLowercase(c: string): boolean {
  return c.length === 1 && c >= "a" && c <= "z";
}

/** Whether every character is ASCII. */
export function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
}

/** The length in UTF-8 bytes. */
export function utf8Len(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const u = s.charCodeAt(i);
    if (u < 0x80) n += 1;
    else if (u < 0x800) n += 2;
    else if (u >= 0xd800 && u <= 0xdbff && i + 1 < s.length && isLowSurrogate(s.charCodeAt(i + 1))) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** The number of code points. */
export function charCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (isHighSurrogate(s.charCodeAt(i)) && i + 1 < s.length && isLowSurrogate(s.charCodeAt(i + 1))) i++;
    n++;
  }
  return n;
}

/** The code point at `pos` as a string (two units for a surrogate pair). */
export function charAt(s: string, pos: number): string | undefined {
  if (pos >= s.length) return undefined;
  const u = s.charCodeAt(pos);
  if (isHighSurrogate(u) && pos + 1 < s.length && isLowSurrogate(s.charCodeAt(pos + 1))) return s.slice(pos, pos + 2);
  return s[pos];
}

/** `index`, moved back to the start of the surrogate pair it falls inside. */
export function floorCharBoundary(s: string, index: number): number {
  if (index >= s.length) return s.length;
  if (index > 0 && isLowSurrogate(s.charCodeAt(index)) && isHighSurrogate(s.charCodeAt(index - 1))) return index - 1;
  return index;
}

/** Orders strings by code point. `<` orders by UTF-16 unit, which puts U+E000..U+FFFF after the code points above U+FFFF. */
export function compareStr(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) {
      // A surrogate (a code point above U+FFFF) sorts after every other unit.
      const sx = x >= 0xd800 && x <= 0xdfff;
      const sy = y >= 0xd800 && y <= 0xdfff;
      if (sx !== sy) return sx ? 1 : -1;
      return x < y ? -1 : 1;
    }
  }
  return a.length - b.length;
}

function isHighSurrogate(u: number): boolean {
  return u >= 0xd800 && u <= 0xdbff;
}

function isLowSurrogate(u: number): boolean {
  return u >= 0xdc00 && u <= 0xdfff;
}

/** `s` in double quotes for a message: `"` and `\` escaped, and control characters other than `\n`, `\r`, `\t`, `\0` as `\u{..}`. */
export function debugStr(s: string): string {
  let out = '"';
  for (const c of s) {
    const cp = c.codePointAt(0)!;
    if (c === '"') out += '\\"';
    else if (c === "\\") out += "\\\\";
    else if (c === "\n") out += "\\n";
    else if (c === "\r") out += "\\r";
    else if (c === "\t") out += "\\t";
    else if (c === "\0") out += "\\0";
    else if (isControl(c)) out += `\\u{${cp.toString(16)}}`;
    else out += c;
  }
  return out + '"';
}
