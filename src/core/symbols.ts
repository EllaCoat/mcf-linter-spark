// The declarations and definitions of a project in the shape of the cache that
// DHP 3.4.19 writes to `.cache/dls.json` (`ClientCache`), for tools built on
// datapack-linter's cache such as TheSkyBlessing's `make-declares-mcf.mts`.
// References and docs are left out. DHP's order depends on the history of its
// cache; here types, ids and positions are sorted so that the same project gives the same file.

import { resolve } from "node:path";

import { compareStr, isAsciiAlphabetic } from "./chars.ts";
import { SparkError } from "./diag.ts";
import type { Kind } from "./facts.ts";
import { PUBLIC_PATTERN, type SiteVisibility } from "./impdoc.ts";
import type { JsonObject, JsonValue } from "./json-value.ts";
import { LineIndex } from "./position.ts";
import type { FileState, Project } from "./project.ts";

interface Unit {
  dcl: JsonObject[];
  def: JsonObject[];
  /** The value of an alias, written as DHP's `foo`. */
  alias: string | undefined;
}

/** The cache as a `JsonValue`. Its objects hold their keys in insertion order, which for
 * integer-like ids is not serde_json's: write it with `stringifySorted`. */
export function dlsCache(project: Project): JsonValue {
  const root = absolute(project.root);
  const rootUri = fileUri(root);
  const files = project.files.filter((f) => !f.removed);
  files.sort((a, b) => compareStr(a.rel, b.rel));
  const cache = new Map<Kind, Map<string, Unit>>();
  for (const f of files) {
    const uri = `${rootUri}/${encodePath(f.rel)}`;
    const index = new LineIndex(f.text);
    const pos = (start: number, end: number, visibility: SiteVisibility): JsonObject => position(f, index, uri, start, end, visibility);
    const doc = f.facts.functionDoc;
    unit(cache, f.kind, f.id).def.push(pos(doc?.start ?? 0, doc?.end ?? 0, doc?.visibility));
    for (const d of f.facts.decls) {
      const p = pos(d.start, d.end, d.visibility);
      const u = unit(cache, d.kind, d.id);
      if (d.declared) u.dcl.push(p);
      else u.def.push(p);
    }
    for (const a of f.facts.aliases) {
      const p = pos(a.start, a.end, a.visibility);
      const u = unit(cache, a.kind, a.name);
      u.def.push(p);
      u.alias = a.value;
    }
  }
  const out: [string, JsonValue][] = [];
  for (const k of [...cache.keys()].sort(compareStr)) {
    const units = cache.get(k)!;
    const byId: [string, JsonValue][] = [];
    for (const id of [...units.keys()].sort(compareStr)) {
      const u = units.get(id)!;
      const o: JsonObject = {};
      if (u.dcl.length !== 0) o["dcl"] = u.dcl;
      if (u.def.length !== 0) o["def"] = u.def;
      if (u.alias !== undefined) o["foo"] = u.alias;
      byId.push([id, o]);
    }
    // `fromEntries` defines own properties, so an id such as `__proto__` stays a key.
    out.push([k, Object.fromEntries(byId)]);
  }
  return { cache: Object.fromEntries(out) };
}

function unit(cache: Map<Kind, Map<string, Unit>>, k: Kind, id: string): Unit {
  let units = cache.get(k);
  if (units === undefined) {
    units = new Map();
    cache.set(k, units);
  }
  let u = units.get(id);
  if (u === undefined) {
    u = { dcl: [], def: [], alias: undefined };
    units.set(id, u);
  }
  return u;
}

/** DHP's `CachePosition`: UTF-16 offsets in the file, zero-based lines and UTF-16 columns. */
function position(f: FileState, index: LineIndex, uri: string, start: number, end: number, visibility: SiteVisibility): JsonObject {
  const [startLine, startChar] = index.position(f.text, start);
  const [endLine, endChar] = index.position(f.text, end);
  // The keys are in serde_json's order.
  const p: JsonObject = {
    end: index.utf16Offset(f.text, end),
    endChar,
    endLine,
    start: index.utf16Offset(f.text, start),
    startChar,
    startLine,
    uri,
  };
  if (visibility !== undefined) {
    // `@public` is kept as `.{0,}` inside; DHP writes `**`.
    p["visibility"] = visibility.map((v) => ({ pattern: v.pattern === PUBLIC_PATTERN ? "**" : v.pattern, type: v.kind }));
  }
  return p;
}

/** `.` and `..` are folded so that the URIs start with the checkout directory
 * that tools cut off (`CHECKOUT_PATH` in `make-declares-mcf.mts`). */
export function absolute(path: string): string {
  if (path === "") throw new SparkError(`${path}: cannot make an empty path absolute`);
  return resolve(path);
}

/** A `file://` URI as VSCode writes it: a Windows drive becomes `/c%3A`. */
export function fileUri(path: string): string {
  const s = path.replaceAll("\\", "/");
  if (s.length >= 2 && s[1] === ":" && isAsciiAlphabetic(s[0]!)) return `file:///${s[0]!.toLowerCase()}%3A${encodePath(s.slice(2))}`;
  return `file://${encodePath(s)}`;
}

const UNRESERVED = /^[A-Za-z0-9\-._~/]*$/;

function encodePath(s: string): string {
  if (UNRESERVED.test(s)) return s;
  let out = "";
  for (const b of Buffer.from(s, "utf8")) {
    if ((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x2d || b === 0x2e || b === 0x5f || b === 0x7e || b === 0x2f) {
      out += String.fromCharCode(b);
    } else out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}
