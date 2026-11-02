// IMP-Doc: `#>` doc comments, their annotations, and visibility, following
// DHP 3.4.19 (`DocCommentPlugin.ts`, `ClientCache.ts`).

import { isWhitespace } from "./chars.ts";
import type { VersionData } from "./data.ts";
import type { Kind } from "./facts.ts";
import { asStr, get, isObject, type JsonValue } from "./json-value.ts";

/** Types that may follow `@within` (DHP's `FileTypes`). */
export const FILE_TYPES: readonly string[] = [
  "advancement", "damage_type", "dimension", "dimension_type", "function", "item_modifier", "loot_table",
  "predicate", "recipe", "structure", "tag/block", "tag/damage_type", "tag/entity_type", "tag/fluid",
  "tag/function", "tag/game_event", "tag/item", "tag/worldgen/biome", "tag/worldgen/configured_carver",
  "tag/worldgen/configured_decorator", "tag/worldgen/configured_feature", "tag/worldgen/configured_structure_feature",
  "tag/worldgen/configured_surface_builder", "tag/worldgen/density_function", "tag/worldgen/noise",
  "tag/worldgen/noise_settings", "tag/worldgen/placed_feature", "tag/worldgen/processor_list",
  "tag/worldgen/structure", "tag/worldgen/structure_set", "tag/worldgen/template_pool", "worldgen/biome",
  "worldgen/configured_carver", "worldgen/configured_decorator", "worldgen/configured_feature",
  "worldgen/configured_structure_feature", "worldgen/configured_surface_builder", "worldgen/density_function",
  "worldgen/flat_level_generator_preset", "worldgen/noise", "worldgen/noise_settings", "worldgen/placed_feature",
  "worldgen/processor_list", "worldgen/structure", "worldgen/structure_set", "worldgen/template_pool",
  "worldgen/world_preset",
];

/** Types that `#declare` accepts besides the file types. */
export const MISC_TYPES: readonly string[] = ["bossbar", "entity", "objective", "score_holder", "storage", "tag", "team", "sequence"];

/** DHP's file types, and the data pack kinds of the version (`enchantment` since 1.21). */
export function isFileType(t: string, data: VersionData): boolean {
  return FILE_TYPES.includes(t) || data.fileKind(t) !== undefined;
}

export function declarableType(t: string, data: VersionData): Kind | undefined {
  return FILE_TYPES.includes(t) || MISC_TYPES.includes(t) ? t : data.fileKind(t);
}

/** Whether ids of this declarable type carry a namespace (`minecraft:` is added when omitted). */
export function isNamespacedType(t: string): boolean {
  return !MISC_TYPES.includes(t) || t === "bossbar" || t === "storage";
}

/** One visibility entry: which caller type and id pattern may see a declaration. */
export interface Visibility {
  /** A file type or `*`. */
  readonly kind: string;
  /** A regex source in DHP's glob notation (`*`, `**`, `?` still unexpanded). */
  readonly pattern: string;
}

export function visibilityEquals(a: Visibility, b: Visibility): boolean {
  return a.kind === b.kind && a.pattern === b.pattern;
}

/** The visibility of one declaration or definition site.
 * `undefined`: the site has no visibility (always visible). `[]`: use the
 * default visibility. Otherwise visible when any entry matches. */
export type SiteVisibility = readonly Visibility[] | undefined;

/** DHP's `escapeIdentityPattern`. */
export function escapePattern(s: string): string {
  return s.replace(/[-/\\^$+.()|[\]{}]/g, "\\$&");
}

/** The pattern of `@public`. It matches every id as `**` does, but no
 * `@within` can produce it because their patterns are escaped, so the modified
 * Spyglass's public / restricted distinction can be read from the entries. */
export const PUBLIC_PATTERN = ".{0,}";

/** The visibility for `@private` / `@internal` / `@public` (`getCacheVisibilities`). */
export function namedVisibility(name: string, defKind: string, defId: string): Visibility[] {
  switch (name) {
    case "private":
      return [{ kind: defKind, pattern: defId }];
    case "internal": {
      const colon = defId.indexOf(":");
      const ns = colon < 0 ? "minecraft" : defId.slice(0, colon);
      const v: Visibility[] = [{ kind: "*", pattern: `${ns}:**` }];
      if (ns !== "minecraft") v.push({ kind: "*", pattern: "minecraft:**" });
      return v;
    }
    default:
      return [{ kind: "*", pattern: PUBLIC_PATTERN }];
  }
}

const compiledCache = new Map<string, RegExp | undefined>();

function compiled(pattern: string): RegExp | undefined {
  if (compiledCache.has(pattern)) return compiledCache.get(pattern);
  const source = `^${pattern.replaceAll("?", "[^:/]").replaceAll("**/", ".{0,}").replaceAll("**", ".{0,}").replaceAll("*", "[^:/]{0,}")}$`;
  // A pattern that is not a valid regex never matches, as in DHP.
  let re: RegExp | undefined;
  try {
    re = new RegExp(source);
  } catch {
    re = undefined;
  }
  compiledCache.set(pattern, re);
  return re;
}

function shortest(id: string): string {
  return id.startsWith("minecraft:") ? id.slice("minecraft:".length) : id;
}

const GLOB_OR_REGEX_CHAR = /[*?\\.[({+^$|]/;

/** `testID` for one entry: may a caller of `callerKind` with `callerId` see it? */
export function entryMatches(v: Visibility, callerKind: string, callerId: string): boolean {
  if (v.kind !== "*" && v.kind !== callerKind) return false;
  const p = v.pattern;
  if (p === PUBLIC_PATTERN) return true;
  if (!GLOB_OR_REGEX_CHAR.test(p)) return p === callerId || p === shortest(callerId);
  const re = compiled(p);
  return re !== undefined && (re.test(callerId) || re.test(shortest(callerId)));
}

/** `testID` for a site. `defaultVisibility` is the default visibility setting and
 * `def` the definition file's kind and id (used by a non-public default). */
export function siteVisible(
  site: SiteVisibility,
  callerKind: string,
  callerId: string,
  defaultVisibility: DefaultVisibility,
  def: readonly [string, string] | undefined,
): boolean {
  if (site === undefined) return true;
  if (site.length > 0) return site.some((v) => entryMatches(v, callerKind, callerId));
  if (defaultVisibility.kind === "Entries") return defaultVisibility.entries.some((v) => entryMatches(v, callerKind, callerId));
  if (def === undefined) return true;
  return namedVisibility(defaultVisibility.name, def[0], def[1]).some((v) => entryMatches(v, callerKind, callerId));
}

export type DefaultVisibility = { kind: "Named"; name: string } | { kind: "Entries"; entries: Visibility[] };

export function defaultVisibilityFromConfig(v: JsonValue): DefaultVisibility {
  if (typeof v === "string") return { kind: "Named", name: v };
  if (isObject(v)) {
    return { kind: "Entries", entries: [{ kind: asStr(get(v, "type")) ?? "*", pattern: asStr(get(v, "pattern")) ?? "**" }] };
  }
  return { kind: "Named", name: "public" };
}

/** One annotation token: its text and its range in the file (UTF-16 code units). */
export interface Token {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** The annotation that decides a doc comment's visibility, as the modified
 * Spyglass names it in its messages (`parseVisibility`). */
export type Scope = "Default" | "Public" | "Within" | "Internal" | "Private";

/** A parsed doc comment block. */
export class DocComment {
  plainText: string;
  /** Annotations flattened into paths (`[@within, function, ns:a]`). */
  annotations: Token[][];

  constructor(plainText = "", annotations: Token[][] = []) {
    this.plainText = plainText;
    this.annotations = annotations;
  }

  scope(): Scope {
    const has = (names: readonly string[]): boolean =>
      this.annotations.some((a) => {
        const head = a[0];
        return head !== undefined && names.includes(head.text);
      });
    if (has(["@public", "@api"])) return "Public";
    if (has(["@within"])) return "Within";
    if (has(["@internal"])) return "Internal";
    if (has(["@private"])) return "Private";
    return "Default";
  }

  /** The text shown on hover (`DocCommentNode.valueOf`). */
  display(): string {
    let s = trimEnd(this.plainText);
    for (const a of this.annotations) {
      s += "\n\n";
      s += a.map((t) => t.text).join(" ");
    }
    return s;
  }

  /** `getVisibility`. Errors are returned as (start, end, message).
   * With `stripModifiers`, tokens such as `@readonly` after `@within` are
   * dropped first, as the modified Spyglass does; they are returned too. */
  visibility(currentId: string, stripModifiers: boolean, data: VersionData): [Visibility[], [number, number, string][], Token[]] {
    const out: Visibility[] = [];
    const errors: [number, number, string][] = [];
    const modifiers: Token[] = [];
    for (const full of this.annotations) {
      const head = full[0];
      if (head === undefined) continue;
      let a: readonly Token[];
      if (stripModifiers && head.text === "@within") {
        const rest: Token[] = [];
        for (const t of full.slice(1)) (t.text.startsWith("@") ? modifiers : rest).push(t);
        a = [head, ...rest];
      } else {
        a = full;
      }
      switch (head.text) {
        case "@private":
          out.push(...namedVisibility("private", "function", currentId));
          break;
        case "@internal":
          out.push(...namedVisibility("internal", "function", currentId));
          break;
        case "@public":
        case "@api":
          out.push(...namedVisibility("public", "function", currentId));
          break;
        case "@within": {
          if (a.length === 1) {
            errors.push([head.start, head.end, "Expected more arguments but got nothing"]);
          } else if (a.length === 2) {
            out.push({ kind: "*", pattern: escapePattern(a[1]!.text) });
          } else {
            const t = a[1]!;
            if (isFileType(t.text, data) || t.text === "*") {
              out.push({ kind: t.text, pattern: escapePattern(a[2]!.text) });
            } else {
              errors.push([t.start, t.end, `Expected a file type or '*' but got '${t.text}'`]);
            }
          }
          break;
        }
        default:
          break;
      }
    }
    return [out, errors, modifiers];
  }
}

/** Strips trailing Unicode White_Space, which differs from JS's `trimEnd` at U+0085 and U+FEFF. */
function trimEnd(s: string): string {
  let end = s.length;
  while (end > 0 && isWhitespace(s[end - 1]!)) end -= 1;
  return s.slice(0, end);
}
