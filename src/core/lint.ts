// Style rules from `datapack.lint.*` that do not depend on NBT schemas.

import { asBool, asStr, get, type JsonValue } from "./json-value.ts";

/** DHP's `checkNamingConvention` for one rule value (`[severity, convention]`'s convention). */
export function followsConvention(identity: string, convention: JsonValue): boolean {
  if (Array.isArray(convention)) return convention.some((c) => followsConvention(identity, c));
  if (typeof convention === "string") {
    const s = convention;
    if (s.length >= 2 && s.startsWith("/") && s.endsWith("/")) {
      const r = regex(s.slice(1, -1));
      return r === undefined || r.test(identity);
    }
    let re: string;
    switch (s) {
      case "camelCase":
        re = "^[a-z\\d]+([A-Z\\d]+[a-z\\d]*)*$";
        break;
      case "PascalCase":
        re = "^([A-Z\\d]+[a-z\\d]*)+$";
        break;
      case "snake_case":
        re = "^[a-z\\d]+(_[a-z\\d]+)*$";
        break;
      case "SCREAMING_SNAKE_CASE":
        re = "^[A-Z\\d]+(_[A-Z\\d]+)*$";
        break;
      case "kebab-case":
        re = "^[a-z\\d]+(\\-[a-z\\d]+)*$";
        break;
      case "lowercase":
        re = "^[a-z\\d]+$";
        break;
      case "UPPERCASE":
        re = "^[A-Z\\d]+$";
        break;
      default:
        return true;
    }
    const r = regex(re);
    return r === undefined || r.test(identity);
  }
  if (convention !== null && typeof convention === "object") {
    let id = identity;
    const prefix = asStr(get(convention, "prefix"));
    if (prefix) {
      if (!id.startsWith(prefix)) return false;
      id = id.slice(prefix.length);
    }
    const suffix = asStr(get(convention, "suffix"));
    if (suffix) {
      if (!id.endsWith(suffix)) return false;
      id = id.slice(0, id.length - suffix.length);
    }
    const parts = get(convention, "parts");
    if (parts === undefined || parts === null) return true;
    const sep = asStr(get(convention, "sep")) || undefined;
    if (sep === undefined) {
      return Array.isArray(parts) ? parts.some((p) => followsConvention(id, p)) : followsConvention(id, parts);
    }
    const pieces = id.split(sep);
    if (!Array.isArray(parts)) return pieces.every((p) => followsConvention(p, parts));
    const allowLess = asBool(get(convention, "allowLessParts")) ?? false;
    const allowMore = asBool(get(convention, "allowMoreParts")) ?? false;
    if ((pieces.length < parts.length && !allowLess) || (pieces.length > parts.length && !allowMore)) return false;
    if (parts.length === 0) return true;
    return pieces.every((p, i) => followsConvention(p, parts[Math.min(i, parts.length - 1)]!));
  }
  return true;
}

/** The labels of a convention for messages (`getConventionNames`). */
export function conventionNames(convention: JsonValue): string {
  const items = Array.isArray(convention) ? convention : [convention];
  return items
    .map((v) => {
      if (typeof v === "string") return v;
      if (v !== null && typeof v === "object" && !Array.isArray(v)) return asStr(get(v, "label")) ?? "";
      return "";
    })
    .join(" or ");
}

const REGEX_CACHE = new Map<string, RegExp | undefined>();

function regex(source: string): RegExp | undefined {
  if (REGEX_CACHE.has(source)) return REGEX_CACHE.get(source);
  let r: RegExp | undefined;
  try {
    r = new RegExp(source);
  } catch {
    r = undefined;
  }
  REGEX_CACHE.set(source, r);
  return r;
}

/** The quote character `quoteString` would choose for `value` under a quote type setting. */
export function expectedQuote(value: string, quoteType: string): string {
  switch (quoteType) {
    case "always single":
      return "'";
    case "always double":
      return '"';
    case "prefer single":
      return value.includes("'") && !value.includes('"') ? '"' : "'";
    default:
      return value.includes('"') && !value.includes("'") ? "'" : '"';
  }
}

/** `validateStringQuote`. `quoted` is the quote used in the source, if any.
 * Returns (rule, message) pairs to report. */
export function stringQuoteProblems(
  quoted: string | undefined,
  value: string,
  quoteRule: readonly [string, boolean] | undefined,
  quoteTypeRule: readonly [string, string] | undefined,
): [string, string][] {
  const out: [string, string][] = [];
  const expected = expectedQuote(value, quoteTypeRule?.[1] ?? "prefer double");
  if (quoteRule !== undefined) {
    const [rule, shouldQuote] = quoteRule;
    if (shouldQuote !== (quoted !== undefined)) {
      out.push([rule, shouldQuote ? "Expected a quote" : "Expected an unquoted string"]);
    }
  }
  if (quoted !== undefined && quoteTypeRule !== undefined && quoted !== expected) {
    out.push([quoteTypeRule[0], expected === '"' ? "Prefer double quotes" : "Prefer single quotes"]);
  }
  return out;
}

/** `SelectorArgumentsNode[IsMapSorted]`: are the keys in the configured order?
 * Keys missing from the configuration are skipped. */
export function selectorKeysSorted(keys: readonly string[], order: readonly JsonValue[]): boolean {
  const names = order.filter((k): k is string => typeof k === "string");
  let i = 0;
  for (const key of keys) {
    const pos = names.indexOf(key);
    if (pos < 0) continue;
    if (pos < i) return false;
    i = pos;
  }
  return true;
}
