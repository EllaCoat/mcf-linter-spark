// JSON values as `JSON.parse` returns them, and accessors for them. Code that walks an object goes
// through `sortedEntries`, so the keys are visited (and their diagnostics reported) in code-point
// order, not in the order of the file.

import { compareStr } from "./chars.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export function isObject(v: JsonValue | undefined): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The member of an object, `undefined` for anything else. */
export function get(v: JsonValue | undefined, key: string): JsonValue | undefined {
  return isObject(v) && Object.hasOwn(v, key) ? v[key] : undefined;
}

/** The element of an array, `undefined` for anything else. */
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

/** A non-negative integer that fits in 64 bits. */
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

/** The members of an object, keys sorted by code point. */
export function sortedEntries(obj: JsonObject): [string, JsonValue][] {
  return Object.entries(obj).sort((a, b) => compareStr(a[0], b[0]));
}

export function sortedKeys(obj: JsonObject): string[] {
  return Object.keys(obj).sort(compareStr);
}

/** The value at a JSON Pointer (RFC 6901) such as `/a/0`. */
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

/** `JSON.stringify` with object keys sorted by code point. */
export function stringifySorted(v: JsonValue): string {
  if (Array.isArray(v)) return `[${v.map(stringifySorted).join(",")}]`;
  if (isObject(v)) return `{${sortedEntries(v).map(([k, x]) => `${JSON.stringify(k)}:${stringifySorted(x)}`).join(",")}}`;
  return JSON.stringify(v);
}

/** Deep equality of two values. */
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
