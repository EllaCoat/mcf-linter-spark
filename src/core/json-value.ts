// JSON values as `JSON.parse` returns them, with accessors in the shape of serde_json's `Value`.
// serde_json (without `preserve_order`) keeps object keys sorted, so code that walks an object
// does so through `sortedEntries` to visit the keys in the same order.

import { compareStr } from "./chars.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export function isObject(v: JsonValue | undefined): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `v.get(key)`: the member of an object, `undefined` for anything else. */
export function get(v: JsonValue | undefined, key: string): JsonValue | undefined {
  return isObject(v) && Object.hasOwn(v, key) ? v[key] : undefined;
}

/** `v.get(index)` of an array. */
export function at(v: JsonValue | undefined, index: number): JsonValue | undefined {
  return Array.isArray(v) ? v[index] : undefined;
}

export function asStr(v: JsonValue | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function asBool(v: JsonValue | undefined): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

export function asF64(v: JsonValue | undefined): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** `as_i64`: an integer that fits in `i64`. */
export function asI64(v: JsonValue | undefined): bigint | undefined {
  if (typeof v !== "number" || !Number.isInteger(v)) return undefined;
  const b = BigInt(v);
  return b >= -9223372036854775808n && b <= 9223372036854775807n ? b : undefined;
}

/** `as_u64`: a non-negative integer that fits in `u64`. */
export function asU64(v: JsonValue | undefined): bigint | undefined {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return undefined;
  const b = BigInt(v);
  return b <= 18446744073709551615n ? b : undefined;
}

export function asArray(v: JsonValue | undefined): JsonValue[] | undefined {
  return Array.isArray(v) ? v : undefined;
}

export function asObject(v: JsonValue | undefined): JsonObject | undefined {
  return isObject(v) ? v : undefined;
}

/** The members of an object in serde_json's order (keys sorted by code point). */
export function sortedEntries(obj: JsonObject): [string, JsonValue][] {
  return Object.entries(obj).sort((a, b) => compareStr(a[0], b[0]));
}

export function sortedKeys(obj: JsonObject): string[] {
  return Object.keys(obj).sort(compareStr);
}

/** `Value::pointer` (RFC 6901). */
export function pointer(v: JsonValue, path: string): JsonValue | undefined {
  if (path === "") return v;
  if (!path.startsWith("/")) return undefined;
  let cur: JsonValue | undefined = v;
  for (const raw of path.slice(1).split("/")) {
    const token = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
      cur = cur[Number(token)];
    } else cur = get(cur, token);
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** `serde_json::to_string` of a value: object keys in sorted order, no spaces. */
export function stringifySorted(v: JsonValue): string {
  if (Array.isArray(v)) return `[${v.map(stringifySorted).join(",")}]`;
  if (isObject(v)) return `{${sortedEntries(v).map(([k, x]) => `${JSON.stringify(k)}:${stringifySorted(x)}`).join(",")}}`;
  return JSON.stringify(v);
}

/** `==` between two values. */
export function jsonEquals(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEquals(x, b[i]));
  if (isObject(a)) {
    if (!isObject(b)) return false;
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && jsonEquals(a[k], b[k]));
  }
  return false;
}
