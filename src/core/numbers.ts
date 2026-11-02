// Number parsing, casting, and formatting with the results of Rust's `str::parse`, `as`, and
// `Display`, which the diagnostics' messages and ranges depend on.

export const I32_MIN = -2147483648;
export const I32_MAX = 2147483647;
export const U32_MAX = 4294967295;
export const I64_MIN = -9223372036854775808n;
export const I64_MAX = 9223372036854775807n;
export const F32_MAX = 3.4028234663852886e38;
export const F64_MAX = Number.MAX_VALUE;

const INTEGER = /^[+-]?[0-9]+$/;
const UNSIGNED = /^\+?[0-9]+$/;
const FLOAT = /^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/;
const SPECIAL_FLOAT = /^([+-]?)(inf|infinity|nan)$/i;

function parseInteger(text: string, min: bigint, max: bigint, pattern: RegExp): bigint | undefined {
  if (!pattern.test(text)) return undefined;
  const v = BigInt(text.startsWith("+") ? text.slice(1) : text);
  return v < min || v > max ? undefined : v;
}

/** `text.parse::<i32>()`. */
export function parseI32(text: string): number | undefined {
  const v = parseInteger(text, BigInt(I32_MIN), BigInt(I32_MAX), INTEGER);
  return v === undefined ? undefined : Number(v);
}

/** `text.parse::<u32>()`. */
export function parseU32(text: string): number | undefined {
  const v = parseInteger(text, 0n, BigInt(U32_MAX), UNSIGNED);
  return v === undefined ? undefined : Number(v);
}

/** `text.parse::<i64>()`. */
export function parseI64(text: string): bigint | undefined {
  return parseInteger(text, I64_MIN, I64_MAX, INTEGER);
}

/** `text.parse::<f64>()`. */
export function parseF64(text: string): number | undefined {
  if (FLOAT.test(text)) return Number(text);
  const special = SPECIAL_FLOAT.exec(text);
  if (!special) return undefined;
  if (special[2]!.toLowerCase() === "nan") return NaN;
  return special[1] === "-" ? -Infinity : Infinity;
}

/** `x as i32` for an `f64`: truncates toward zero, saturates at the ends, and NaN is 0. */
export function f64ToI32(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x >= I32_MAX) return I32_MAX;
  if (x <= I32_MIN) return I32_MIN;
  return Math.trunc(x);
}

/** `x as i64` for an `f64`. */
export function f64ToI64(x: number): bigint {
  if (Number.isNaN(x)) return 0n;
  if (x >= 9223372036854775807) return I64_MAX;
  if (x <= -9223372036854775808) return I64_MIN;
  return BigInt(Math.trunc(x));
}

/** Expands `1.5e-7` or `1e+21` into plain decimal digits. */
function plain(text: string): string {
  const m = /^(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!m) return text;
  const digits = m[1]! + (m[2] ?? "");
  const point = m[1]!.length + Number(m[3]);
  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + "0".repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

function special(x: number): string | undefined {
  if (Number.isNaN(x)) return "NaN";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  return undefined;
}

/** `format!("{}", x)` of an `f64`: the shortest digits that read back as `x`, never in exponent form. */
export function fmtF64(x: number): string {
  const s = special(x);
  if (s !== undefined) return s;
  return (x < 0 ? "-" : "") + plain(String(Math.abs(x)));
}

/** `format!("{}", x)` of an `f32` (`x` holds the `f32` value). */
export function fmtF32(x: number): string {
  const s = special(x);
  if (s !== undefined) return s;
  const a = Math.abs(x);
  let digits = String(a);
  for (let p = 1; p <= 9; p++) {
    const t = a.toPrecision(p);
    if (Math.fround(Number(t)) === a) {
      digits = String(Number(t));
      break;
    }
  }
  return (x < 0 ? "-" : "") + plain(digits);
}
