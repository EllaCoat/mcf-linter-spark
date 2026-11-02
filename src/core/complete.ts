// Completion for one command line. Walks the command tree like `parseCommand` up to the cursor
// and lists what may come next there. Only the language server calls it.

import {
  ArgCtx,
  type ArgValue,
  ENTITY_ANCHORS,
  GAMEMODES,
  HEIGHTMAPS,
  type PathNode,
  TEMPLATE_MIRRORS,
  TEMPLATE_ROTATIONS,
  isAllowedInResourceLocation,
  parse as parseArgument,
} from "./args/index.ts";
import * as basic from "./args/basic.ts";
import * as entity from "./args/entity.ts";
import * as nbt from "./args/nbt.ts";
import * as nbtCheck from "./args/nbt_check.ts";
import { compareStr, isAscii, trimEndWhiteSpace, trimStartWhiteSpace, trimWhiteSpace } from "./chars.ts";
import { type Effect, MAX_NODES } from "./command.ts";
import type { Config } from "./config.ts";
import { DIMENSIONS, type VersionData } from "./data.ts";
import { ParseError } from "./diag.ts";
import { type Kind, fullId, kind } from "./facts.ts";
import { Reader, isAllowedInUnquoted, isQuote } from "./reader.ts";
import { type NodeId, type Parser, ROOT, hasChildren, nodeName } from "./tree.ts";

export interface Candidate {
  /** The text that replaces the line from `start` up to the cursor. */
  label: string;
  /** Offset (UTF-16) in the line where the replaced text starts. */
  start: number;
  category: Category;
  /** Where the candidate comes from: a symbol kind (`function`) or a registry (`item`). */
  detail: string | undefined;
}

export type Category =
  | "Keyword"
  | "Selector"
  /** A symbol of the project or the vanilla data (function, objective, loot table, ...). */
  | "Symbol"
  /** A part of an id that ends at `/` or `:`: more ids continue after it. */
  | "Folder"
  /** A registry id or a fixed value. */
  | "Value"
  /** A selector option or a block state property. */
  | "Property"
  | "Coordinates";

/** What the project offers to the edited file. */
export interface Source {
  /** Ids of a symbol kind that the edited file may reference. */
  symbols(k: Kind): string[];
  /** NBT paths that the project uses in a storage, such as `Return.Difficulty`. */
  storagePaths(storage: string): string[];
}

/** Candidates for the cursor at the end of `line`, the text of the line before the cursor. */
export function complete(line: string, data: VersionData, config: Config, source: Source): Candidate[] {
  const indent = indentOf(line);
  const rest = line.slice(indent);
  if (rest.startsWith("#")) return [];
  const start = indent + (rest.startsWith("$") ? 1 : 0);
  const w = new Walker(data, config, line.slice(start), source);
  w.children(ROOT, 0, [], [], 0);
  const out = w.out;
  for (const c of out) c.start += start;
  out.sort((a, b) => a.start - b.start || compareStr(a.label, b.label));
  const unique: Candidate[] = [];
  for (const c of out) {
    const last = unique[unique.length - 1];
    if (last === undefined || last.start !== c.start || last.label !== c.label) unique.push(c);
  }
  return unique;
}

/** The usage of the command at the cursor: the nodes already typed, then what may follow. */
export interface Signature {
  label: string;
  /** Ranges (UTF-16) of the parts of `label`, one per node. */
  parts: [number, number][];
  /** The part the cursor is in. */
  active: number;
}

const MAX_SHOWN_CHOICES = 16;

/** The usage for the cursor at the end of `line`, as `complete` reads the line. */
export function signature(line: string, data: VersionData, config: Config): Signature | undefined {
  const rest = line.slice(indentOf(line));
  if (rest.startsWith("#")) return undefined;
  const src = rest.slice(rest.startsWith("$") ? 1 : 0);
  const tree = data.tree;
  const typed: NodeId[] = [];
  let node = ROOT;
  let pos = 0;
  const path: PathNode[] = [];
  const values: ArgValue[] = [];
  for (;;) {
    const n = tree.node(node);
    const space = src.indexOf(" ", pos);
    const wordEnd = space < 0 ? src.length : space;
    let next: [NodeId, number] | undefined;
    if (wordEnd < src.length) {
      const word = src.slice(pos, wordEnd);
      const lit = n.literals.find((c) => nodeName(tree.node(c)) === word);
      if (lit !== undefined) next = [lit, wordEnd];
    }
    if (next === undefined && wordEnd < src.length) {
      const saved = values.length;
      for (const arg of n.arguments) {
        const a = tree.node(arg);
        if (a.kind.kind !== "Argument") continue;
        truncate(values, saved);
        const effects: Effect[] = [];
        const reader = new Reader(src, 0, pos);
        const cx = new ArgCtx(data, config, effects, a.kind.name, path, values);
        if (!(parseArgument(a.kind.parser, reader, cx) instanceof ParseError) && src[reader.pos] === " ") {
          const leaf = a.literals.length === 0 && a.arguments.length === 0 && a.redirect === undefined;
          if (next === undefined || !leaf) next = [arg, reader.pos];
          if (!leaf) break;
        }
      }
    }
    if (next === undefined) break;
    const [child, end] = next;
    const c = tree.node(child);
    if (c.redirect === ROOT) {
      typed.length = 0;
      path.length = 0;
      values.length = 0;
      node = ROOT;
    } else {
      typed.push(child);
      path.push({ name: nodeName(c), literal: c.kind.kind === "Literal" });
      node = c.redirect ?? child;
      if (c.redirect !== undefined) {
        const i = typed.indexOf(c.redirect);
        if (i >= 0) typed.length = i + 1;
      }
    }
    pos = end + 1;
  }
  const usage = (id: NodeId): string => {
    const k = tree.node(id).kind;
    switch (k.kind) {
      case "Argument":
        return `<${k.name}>`;
      case "Literal":
        return k.name;
      case "Root":
        return "";
    }
  };
  const segments = typed.map(usage);
  const active = segments.length;
  // What may follow: one choice is shown with the single choices after it; several in parentheses.
  let at = node;
  for (let step = 0; step < 8; step++) {
    const n = tree.node(at);
    const children = [...n.literals, ...n.arguments];
    if (children.length === 0) break;
    if (children.length === 1) {
      const only = children[0]!;
      segments.push(usage(only));
      const redirect = tree.node(only).redirect;
      at = redirect ?? only;
      if (redirect !== undefined) break;
    } else if (children.length > MAX_SHOWN_CHOICES) {
      segments.push("…");
      break;
    } else {
      segments.push(`(${children.map(usage).join("|")})`);
      break;
    }
  }
  if (typed.length === 0 || segments.length <= active) return undefined;
  let label = "";
  const parts: [number, number][] = [];
  for (const s of segments) {
    if (label !== "") label += " ";
    parts.push([label.length, label.length + s.length]);
    label += s;
  }
  return { label, parts, active };
}

class Walker {
  readonly data: VersionData;
  readonly config: Config;
  readonly src: string;
  readonly source: Source;
  readonly out: Candidate[] = [];

  constructor(data: VersionData, config: Config, src: string, source: Source) {
    this.data = data;
    this.config = config;
    this.src = src;
    this.source = source;
  }

  children(node: NodeId, pos: number, path: PathNode[], values: ArgValue[], depth: number): void {
    // ponytail: recursion; the JS stack ends at about 1000 levels of `execute run` (MAX_NODES is 8192), iterate if lines like that matter
    if (depth >= MAX_NODES) return;
    const data = this.data;
    const tree = data.tree;
    const n = tree.node(node);
    const len = this.src.length;
    const space = this.src.indexOf(" ", pos);
    const wordEnd = space < 0 ? len : space;
    const word = this.src.slice(pos, wordEnd);
    if (wordEnd === len) {
      for (const lit of n.literals) {
        const name = nodeName(tree.node(lit));
        if (startsWithIgnoreCase(name, word)) this.push(name, pos, "Keyword", undefined);
      }
    } else {
      const lit = n.literals.find((c) => nodeName(tree.node(c)) === word);
      if (lit !== undefined) {
        this.after(lit, wordEnd, path, values, depth);
        return;
      }
    }
    for (const arg of n.arguments) {
      const k = tree.node(arg).kind;
      if (k.kind !== "Argument") continue;
      const saved = values.length;
      const effects: Effect[] = [];
      const reader = new Reader(this.src, 0, pos);
      const cx = new ArgCtx(data, this.config, effects, k.name, path, values);
      const result = parseArgument(k.parser, reader, cx);
      if (result instanceof ParseError) {
        // The error is in the text after the last space: the part being typed.
        if (!this.src.slice(Math.min(result.start, len)).includes(" ")) {
          truncate(values, saved);
          this.argument(k.parser, k.name, pos, path, values);
        }
      } else if (reader.pos < len) {
        if (this.src[reader.pos] === " ") this.after(arg, reader.pos, path, values, depth);
      } else {
        // The argument reaches the cursor: it is still being typed.
        truncate(values, saved);
        this.argument(k.parser, k.name, pos, path, values);
      }
      truncate(values, saved);
    }
  }

  /** Continues after `node`, which the line has consumed up to the space at `end`. */
  after(node: NodeId, end: number, path: PathNode[], values: ArgValue[], depth: number): void {
    const tree = this.data.tree;
    const n = tree.node(node);
    const next = n.redirect ?? node;
    if (!hasChildren(tree.node(next))) return;
    if (n.redirect === ROOT) {
      this.children(next, end + 1, [], [], depth + 1);
    } else {
      path.push({ name: nodeName(n), literal: n.kind.kind === "Literal" });
      this.children(next, end + 1, path, values, depth + 1);
      path.pop();
    }
  }

  /** Candidates for an argument that starts at `pos` and reaches the cursor. */
  argument(parser: Parser, name: string, pos: number, path: readonly PathNode[], values: ArgValue[]): void {
    const partial = this.src.slice(pos);
    switch (parser.kind) {
      case "Bool":
        this.values(["true", "false"], partial, pos);
        break;
      case "Gamemode":
        this.values(GAMEMODES, partial, pos);
        break;
      case "EntityAnchor":
        this.values(ENTITY_ANCHORS, partial, pos);
        break;
      case "Heightmap":
        this.values(HEIGHTMAPS, partial, pos);
        break;
      case "TemplateMirror":
        this.values(TEMPLATE_MIRRORS, partial, pos);
        break;
      case "TemplateRotation":
        this.values(TEMPLATE_ROTATIONS, partial, pos);
        break;
      case "Color":
        this.values(basic.COLORS, partial, pos);
        break;
      case "TeamColor":
        this.values(basic.COLORS.slice(0, 16), partial, pos);
        break;
      case "SwingAnimation":
        this.values(basic.SWING_ANIMATIONS, partial, pos);
        break;
      case "Operation":
        this.values(["=", "+=", "-=", "*=", "/=", "%=", "<", ">", "><"], partial, pos);
        break;
      case "ObjectiveCriteria":
        this.values(basic.SIMPLE_CRITERIA, partial, pos);
        break;
      case "ScoreboardSlot":
        this.values(["list", "sidebar", "below_name"], partial, pos);
        break;
      case "ItemSlot":
        this.slots(partial, pos, false);
        break;
      case "ItemSlots":
        this.slots(partial, pos, true);
        break;
      case "SlotSource": {
        this.slots(partial, pos, true);
        const k = this.probe(parser, name, path, values);
        if (k !== undefined) this.symbol(k, partial, pos);
        break;
      }
      case "Swizzle":
        this.values(["xyz", "xy", "xz", "yz", "x", "y", "z"], partial, pos);
        break;
      case "Entity":
        this.selector(partial, pos, parser.playersOnly);
        break;
      case "GameProfile":
        this.selector(partial, pos, true);
        break;
      case "ScoreHolder":
        if (!partial.startsWith("@")) {
          this.ids(this.source.symbols(kind.SCORE_HOLDER), partial, pos, kind.SCORE_HOLDER);
          this.values(["*"], partial, pos);
        }
        this.selector(partial, pos, false);
        break;
      case "BlockPos":
      case "Vec3":
        this.coordinates(["~ ~ ~", "^ ^ ^"], partial, pos);
        break;
      case "ColumnPos":
      case "Vec2":
      case "Rotation":
        this.coordinates(["~ ~"], partial, pos);
        break;
      case "Angle":
        this.coordinates(["~"], partial, pos);
        break;
      case "BlockState":
        this.block(partial, pos, false);
        break;
      case "BlockPredicate":
        this.block(partial, pos, true);
        break;
      case "ItemStack":
        this.item(partial, pos, false);
        break;
      case "ItemPredicate":
        this.item(partial, pos, true);
        break;
      case "Particle":
        this.particle(partial, pos);
        break;
      case "Function":
        if (partial.startsWith("#")) this.tagIds(this.source.symbols(kind.FUNCTION_TAG), partial.slice(1), pos + 1, kind.FUNCTION_TAG);
        else this.ids(this.source.symbols(kind.FUNCTION), partial, pos, kind.FUNCTION);
        break;
      case "Dimension":
        this.ids(DIMENSIONS, partial, pos, kind.DIMENSION);
        break;
      case "Resource":
      case "ResourceKey": {
        const k = this.probe(parser, name, path, values);
        if (k !== undefined) this.symbol(k, partial, pos);
        else this.resource(parser.registry, partial, pos, false);
        break;
      }
      case "ResourceOrTag":
      case "ResourceOrTagKey":
        this.resource(parser.registry, partial, pos, true);
        break;
      case "ResourceLocation":
        if (name === "sound") {
          this.registry("minecraft:sound_event", partial, pos);
          break;
        }
        this.symbolOf(parser, name, partial, pos, path, values);
        break;
      case "ResourceOrId":
      case "Objective":
      case "Team":
        this.symbolOf(parser, name, partial, pos, path, values);
        break;
      case "String":
        if (parser.string === "Word") this.symbolOf(parser, name, partial, pos, path, values);
        break;
      case "Component":
      case "Style":
        if (nbt.modern(this.data)) {
          const category = parser.kind === "Component" ? "Text" : "Style";
          this.compound(nbtCheck.new_(category, undefined), partial, pos);
        }
        break;
      case "NbtCompoundTag": {
        const target = this.nbtTarget(nbt.compoundTarget, name, path, values);
        this.compound(target, partial, pos);
        break;
      }
      case "NbtPath": {
        if (path.findLast((n) => n.literal)?.name === "storage") {
          const before = trimEndWhiteSpace(this.src.slice(0, pos));
          const storage = before.slice(before.lastIndexOf(" ") + 1);
          this.storagePath(fullId(storage), partial, pos);
        } else {
          const target = this.nbtTarget(nbt.pathTarget, name, path, values);
          this.nbtPath(target, partial, pos);
        }
        break;
      }
      default:
        break;
    }
  }

  /** The symbols of the kind that parsing a sample id with the argument shows. */
  private symbolOf(parser: Parser, name: string, partial: string, pos: number, path: readonly PathNode[], values: ArgValue[]): void {
    const k = this.probe(parser, name, path, values);
    if (k !== undefined) this.symbol(k, partial, pos);
  }

  /** The schema of an NBT argument, as the analysis finds it. */
  private nbtTarget(
    find: (cx: ArgCtx) => nbtCheck.Target | undefined,
    name: string,
    path: readonly PathNode[],
    values: ArgValue[],
  ): nbtCheck.Target | undefined {
    const effects: Effect[] = [];
    return find(new ArgCtx(this.data, this.config, effects, name, path, values));
  }

  /** Keys of the compound the cursor is in. `text` starts with the outermost `{` at `pos`. */
  private compound(target: nbtCheck.Target | undefined, text: string, pos: number): void {
    if (target === undefined) return;
    const cursor = compoundCursor(text);
    if (cursor === undefined) return;
    const [steps, keyStart] = cursor;
    const key = text.slice(keyStart);
    for (const [name, tag] of nbtCheck.keysAt(this.data, target, stepKeys(steps))) {
      if (startsWithIgnoreCase(name, key)) this.push(`${name}:`, pos + keyStart, "Property", tag);
    }
  }

  /** Keys for the last segment of an NBT path into an entity or a block. */
  private nbtPath(target: nbtCheck.Target | undefined, text: string, pos: number): void {
    if (target === undefined) return;
    const cursor = pathCursor(text);
    if (cursor === undefined) return;
    const [steps, segStart] = cursor;
    const segment = text.slice(segStart);
    for (const [name, tag] of nbtCheck.keysAt(this.data, target, stepKeys(steps))) {
      if (startsWithIgnoreCase(name, segment)) this.push(name, pos + segStart, "Property", tag);
    }
  }

  /** The next segment of the paths that the project uses in a storage. */
  private storagePath(storage: string, text: string, pos: number): void {
    const cursor = pathCursor(text);
    if (cursor === undefined) return;
    const [steps, segStart] = cursor;
    const parent = steps.flatMap((s) => (s.kind === "Key" ? [s.key] : [])).join(".");
    const segment = text.slice(segStart);
    for (const p of this.source.storagePaths(storage)) {
      let rest: string | undefined;
      if (parent === "") rest = p;
      else if (p.startsWith(parent) && p[parent.length] === ".") rest = p.slice(parent.length + 1);
      if (rest === undefined) continue;
      const dot = rest.indexOf(".");
      const next = dot < 0 ? rest : rest.slice(0, dot);
      if (startsWithIgnoreCase(next, segment)) this.push(next, pos + segStart, "Property", kind.STORAGE);
    }
  }

  /** The kind of symbol an argument references, found by parsing a sample id with it. */
  private probe(parser: Parser, name: string, path: readonly PathNode[], values: ArgValue[]): Kind | undefined {
    const saved = values.length;
    const effects: Effect[] = [];
    const reader = new Reader("probe", 0, 0);
    parseArgument(parser, reader, new ArgCtx(this.data, this.config, effects, name, path, values));
    truncate(values, saved);
    for (const e of effects) {
      if (e.kind === "Ref" || e.kind === "Write") return e.ref.kind;
    }
    return undefined;
  }

  /** The project's ids of a kind, with the vanilla ones it resolves against. */
  private symbol(k: Kind, partial: string, pos: number): void {
    const ids = [...this.source.symbols(k)];
    const vanilla = this.data.vanillaJson(k);
    if (vanilla !== undefined) for (const id of vanilla) ids.push(id);
    this.ids(ids, partial, pos, k);
  }

  private resource(registry: string, partial: string, pos: number, allowTag: boolean): void {
    const short = registry.startsWith("minecraft:") ? registry.slice("minecraft:".length) : registry;
    if (partial.startsWith("#")) {
      if (allowTag) {
        const tags = [...(this.data.tags.get(short) ?? [])];
        const k = this.data.fileKind(`tag/${short}`);
        if (k !== undefined) for (const id of this.source.symbols(k)) tags.push(id);
        this.tagIds(tags, partial.slice(1), pos + 1, registry);
      }
      return;
    }
    // The contents of a data pack kind include the project's files.
    const k = this.data.fileKind(short);
    if (k !== undefined) {
      this.symbol(k, partial, pos);
      return;
    }
    this.ids(this.data.registries.get(registry) ?? [], partial, pos, short);
  }

  /** The slot names of the version, the numbered ones by their prefix; with `groups`, the
   * groups of slots (`container.*`) too. */
  private slots(partial: string, pos: number, groups: boolean): void {
    const slots = basic.slots(this.data);
    const names = [...slots.names];
    for (const [prefix] of slots.numbered) names.push(prefix);
    if (groups) {
      for (const [prefix] of slots.numbered) names.push(`${prefix}*`);
      names.push("weapon.*", "armor.*");
    }
    this.values(names, partial, pos);
  }

  private particle(partial: string, pos: number): void {
    if (this.data.atLeast([1, 20, 5])) {
      const brace = partial.indexOf("{");
      if (brace >= 0) {
        const target = nbtCheck.new_("Particle", fullId(partial.slice(0, brace)));
        this.compound(target, partial.slice(brace), pos + brace);
        return;
      }
    }
    this.registry("minecraft:particle_type", partial, pos);
  }

  private registry(registry: string, partial: string, pos: number): void {
    this.ids(this.data.registries.get(registry) ?? [], partial, pos, registry.startsWith("minecraft:") ? registry.slice("minecraft:".length) : registry);
  }

  private block(partial: string, pos: number, predicate: boolean): void {
    const brace = partial.indexOf("{");
    if (brace >= 0) {
      if (!partial.startsWith("#")) {
        const bracket = partial.indexOf("[");
        const id = fullId(partial.slice(0, bracket >= 0 ? bracket : brace));
        this.compound(nbtCheck.new_("Block", id), partial.slice(brace), pos + brace);
      }
      return;
    }
    const open = partial.indexOf("[");
    if (open >= 0) {
      if (partial.startsWith("#") || partial.indexOf("]", open) >= 0) return;
      const id = fullId(partial.slice(0, open));
      const props = this.data.blocks.get(id);
      if (props === undefined) return;
      const innerStart = open + 1;
      const comma = partial.lastIndexOf(",");
      const segStart = comma >= innerStart ? comma + 1 : innerStart;
      const seg = trimStartWhiteSpace(partial.slice(segStart));
      const segPos = pos + partial.length - seg.length;
      const eq = seg.indexOf("=");
      if (eq >= 0) {
        const key = seg.slice(0, eq);
        const value = trimStartWhiteSpace(seg.slice(eq + 1));
        const found = props.find(([k]) => k === trimEndWhiteSpace(key));
        if (found !== undefined) this.values(found[1], value, pos + partial.length - value.length);
      } else {
        const used = new Set<string>();
        for (const p of partial.slice(innerStart, segStart).split(",")) {
          const e = p.indexOf("=");
          if (e >= 0) used.add(trimWhiteSpace(p.slice(0, e)));
        }
        for (const [key] of props) {
          if (!used.has(key) && startsWithIgnoreCase(key, seg)) this.push(`${key}=`, segPos, "Property", undefined);
        }
      }
      return;
    }
    if (predicate && partial.startsWith("#")) {
      const tags = [...this.source.symbols(kind.BLOCK_TAG), ...(this.data.tags.get("block") ?? [])];
      this.tagIds(tags, partial.slice(1), pos + 1, kind.BLOCK_TAG);
      return;
    }
    this.registry("minecraft:block", partial, pos);
  }

  private item(partial: string, pos: number, predicate: boolean): void {
    if (this.data.atLeast([1, 20, 5])) {
      this.itemComponents(partial, pos, predicate);
      return;
    }
    const brace = partial.indexOf("{");
    if (brace >= 0) {
      if (!partial.startsWith("#")) {
        const id = fullId(partial.slice(0, brace));
        this.compound(nbtCheck.new_("Item", id), partial.slice(brace), pos + brace);
      }
      return;
    }
    if (predicate && partial.startsWith("#")) {
      const tags = [...this.source.symbols(kind.ITEM_TAG), ...(this.data.tags.get("item") ?? [])];
      this.tagIds(tags, partial.slice(1), pos + 1, kind.ITEM_TAG);
      return;
    }
    this.registry("minecraft:item", partial, pos);
  }

  /** An item stack or predicate of 1.20.5 and later: the item, then the component (or
   * predicate) being typed inside `[...]`, or its SNBT value after `=` (`~`). */
  private itemComponents(partial: string, pos: number, predicate: boolean): void {
    const open = partial.indexOf("[");
    if (open < 0) {
      if (predicate && partial.startsWith("#")) {
        const tags = [...this.source.symbols(kind.ITEM_TAG), ...(this.data.tags.get("item") ?? [])];
        this.tagIds(tags, partial.slice(1), pos + 1, kind.ITEM_TAG);
        return;
      }
      if (predicate) this.values(["*"], partial, pos);
      this.registry("minecraft:item", partial, pos);
      return;
    }
    let depth = 0;
    let quote: string | undefined;
    let segStart = open + 1;
    for (let i = open + 1; i < partial.length; i++) {
      const b = partial[i]!;
      if (quote !== undefined) {
        if (b === quote) quote = undefined;
      } else if (b === '"' || b === "'") quote = b;
      else if (b === "{" || b === "[") depth += 1;
      else if (b === "}" || b === "]") depth -= 1;
      else if (depth === 0 && (b === "," || (predicate && b === "|"))) segStart = i + 1;
    }
    if (depth < 0) return;
    let seg = trimStartWhiteSpace(partial.slice(segStart));
    if (seg.startsWith("!")) seg = seg.slice(1);
    const segPos = pos + partial.length - seg.length;
    const predicates = this.data.atLeast([1, 21, 5]) ? "minecraft:data_component_predicate_type" : "minecraft:item_sub_predicate_type";
    const op = firstIndexOf(seg, "=~");
    if (op >= 0) {
      const value = trimStartWhiteSpace(seg.slice(op + 1));
      if (value.startsWith("{")) {
        const category = seg[op] === "~" ? "ComponentPredicate" : "DataComponent";
        const target = nbtCheck.new_(category, fullId(trimEndWhiteSpace(seg.slice(0, op))));
        this.compound(target, value, pos + partial.length - value.length);
      }
    } else {
      this.registry("minecraft:data_component_type", seg, segPos);
      if (predicate) {
        this.registry(predicates, seg, segPos);
        this.ids(["minecraft:count"], seg, segPos, "data_component_type");
      }
    }
  }

  private selector(partial: string, pos: number, playersOnly: boolean): void {
    const open = partial.indexOf("[");
    if (open < 0) {
      if (partial === "" || partial.startsWith("@")) {
        let types: readonly string[];
        if (playersOnly) types = ["@a", "@p", "@r", "@s"];
        else if (!this.data.atLeast([1, 21])) types = ["@a", "@e", "@p", "@r", "@s"];
        else types = ["@a", "@e", "@n", "@p", "@r", "@s"];
        for (const t of types) {
          if (startsWithIgnoreCase(t, partial)) this.push(t, pos, "Selector", undefined);
        }
      }
      return;
    }
    const inner = open + 1;
    // The option being typed starts after the last ',' or '[' outside braces and quotes.
    let depth = 0;
    let quote: string | undefined;
    let segStart = inner;
    for (let i = inner; i < partial.length; i++) {
      const b = partial[i]!;
      if (quote !== undefined) {
        if (b === quote) quote = undefined;
      } else if (b === '"' || b === "'") quote = b;
      else if (b === "{" || b === "[") depth += 1;
      else if (b === "}" || b === "]") {
        if (depth === 0) return;
        depth -= 1;
      } else if (b === "," && depth === 0) segStart = i + 1;
    }
    const seg = trimStartWhiteSpace(partial.slice(segStart));
    const segPos = pos + partial.length - seg.length;
    const eq = seg.indexOf("=");
    if (eq < 0) {
      for (const option of entity.SELECTOR_OPTIONS) {
        if (startsWithIgnoreCase(option, seg)) this.push(`${option}=`, segPos, "Property", undefined);
      }
      return;
    }
    const key = seg.slice(0, eq);
    let value = trimStartWhiteSpace(seg.slice(eq + 1));
    if (value.startsWith("!")) value = value.slice(1);
    value = trimStartWhiteSpace(value);
    const valuePos = pos + partial.length - value.length;
    switch (trimEndWhiteSpace(key)) {
      case "type":
        if (value.startsWith("#")) {
          const tags = [...this.source.symbols(kind.ENTITY_TYPE_TAG), ...(this.data.tags.get("entity_type") ?? [])];
          this.tagIds(tags, value.slice(1), valuePos + 1, kind.ENTITY_TYPE_TAG);
        } else {
          this.registry("minecraft:entity_type", value, valuePos);
        }
        break;
      case "tag":
        this.ids(this.source.symbols(kind.ENTITY_TAG), value, valuePos, kind.ENTITY_TAG);
        break;
      case "team":
        this.ids(this.source.symbols(kind.TEAM), value, valuePos, kind.TEAM);
        break;
      case "gamemode":
        this.values(GAMEMODES, value, valuePos);
        break;
      case "sort":
        this.values(entity.SORTS, value, valuePos);
        break;
      case "predicate":
        this.symbol(kind.PREDICATE, value, valuePos);
        break;
      case "nbt":
        if (value.startsWith("{")) {
          const target = nbtCheck.new_("Entity", selectorType(partial.slice(inner, segStart)));
          this.compound(target, value, valuePos);
        }
        break;
      case "scores":
      case "advancements": {
        if (!value.startsWith("{")) return;
        const body = value.slice(1);
        const entry = trimStartWhiteSpace(body.slice(body.lastIndexOf(",") + 1));
        if (entry.includes("=")) return;
        const entryPos = pos + partial.length - entry.length;
        if (trimEndWhiteSpace(key) === "scores") this.ids(this.source.symbols(kind.OBJECTIVE), entry, entryPos, kind.OBJECTIVE);
        else this.symbol(kind.ADVANCEMENT, entry, entryPos);
        break;
      }
      default:
        break;
    }
  }

  private coordinates(forms: readonly string[], partial: string, pos: number): void {
    for (const f of forms) {
      if (f.startsWith(partial)) this.push(f, pos, "Coordinates", undefined);
    }
  }

  private values(values: readonly string[], partial: string, pos: number): void {
    for (const v of values) {
      if (startsWithIgnoreCase(v, partial)) this.push(v, pos, "Value", undefined);
    }
  }

  /** Tags: `ids` without `#`, `partial` after the `#` at `pos - 1`. */
  private tagIds(ids: Iterable<string>, partial: string, pos: number, detail: string): void {
    const before = this.out.length;
    this.ids(ids, partial, pos, detail);
    for (let i = before; i < this.out.length; i++) {
      const c = this.out[i]!;
      c.label = `#${c.label}`;
      c.start -= 1;
    }
  }

  /** Full ids filtered by the typed text. Ids in `minecraft:` also match without the
   * namespace. A candidate stops after the next `:` or `/`, so that a long list of ids
   * comes one level at a time. */
  private ids(ids: Iterable<string>, partial: string, pos: number, detail: string): void {
    const category: Category = detail.startsWith("minecraft:") || this.data.registries.has(`minecraft:${detail}`) ? "Value" : "Symbol";
    const seen = new Set<string>();
    for (const id of ids) {
      for (const form of id.startsWith("minecraft:") ? [id, id.slice("minecraft:".length)] : [id]) {
        if (!startsWithIgnoreCase(form, partial)) continue;
        const sep = firstIndexOf(form, ":/", partial.length);
        const label = sep >= 0 ? form.slice(0, sep + 1) : form;
        if (seen.has(label)) continue;
        seen.add(label);
        this.push(label, pos, sep >= 0 ? "Folder" : category, detail);
      }
    }
  }

  private push(label: string, start: number, category: Category, detail: string | undefined): void {
    this.out.push({ label, start, category, detail });
  }
}

function indentOf(line: string): number {
  let indent = 0;
  while (line[indent] === " " || line[indent] === "\t") indent += 1;
  return indent;
}

function truncate(values: unknown[], len: number): void {
  if (values.length > len) values.length = len;
}

/** The first index at or after `from` of any character in `chars`, or -1. */
function firstIndexOf(text: string, chars: string, from = 0): number {
  for (let i = from; i < text.length; i++) {
    if (chars.includes(text[i]!)) return i;
  }
  return -1;
}

/** Whether `text` starts with `prefix`, comparing ASCII letters without case. */
function startsWithIgnoreCase(text: string, prefix: string): boolean {
  if (text.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    const a = text.charCodeAt(i);
    const b = prefix.charCodeAt(i);
    if (a !== b && asciiLower(a) !== asciiLower(b)) return false;
  }
  return true;
}

function asciiLower(unit: number): number {
  return unit >= 0x41 && unit <= 0x5a ? unit + 0x20 : unit;
}

/** A step from a compound to a tag inside it. */
type Step =
  | { kind: "Key"; key: string }
  /** An element of a list. */
  | { kind: "Element" };

type Frame = { kind: "Compound"; key: string | undefined; atKey: boolean; token: number } | { kind: "List" };

/** For the cursor at the end of SNBT `text` (starting with `{`): the steps to the compound
 * the cursor is in, and the offset where the key being typed starts. `undefined` when the cursor
 * is not where a key goes. */
function compoundCursor(text: string): [Step[], number] | undefined {
  const frames: Frame[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const top = frames[frames.length - 1];
    switch (c) {
      case '"':
      case "'": {
        const close = text.indexOf(c, i + 1);
        if (close < 0) return undefined;
        i = close;
        break;
      }
      case "{":
        frames.push({ kind: "Compound", key: undefined, atKey: true, token: i + 1 });
        break;
      case "[":
        frames.push({ kind: "List" });
        break;
      case "}":
      case "]":
        if (frames.pop() === undefined) return undefined;
        break;
      case ":":
        if (top?.kind === "Compound" && top.atKey) {
          top.key = unquote(trimWhiteSpace(text.slice(top.token, i)));
          top.atKey = false;
        }
        break;
      case ",":
        if (top?.kind === "Compound") {
          top.key = undefined;
          top.atKey = true;
          top.token = i + 1;
        }
        break;
      default:
        break;
    }
  }
  const last = frames[frames.length - 1];
  if (last?.kind !== "Compound" || !last.atKey) return undefined;
  const keyStart = text.length - trimStartWhiteSpace(text.slice(last.token)).length;
  const steps: Step[] = [];
  for (const f of frames.slice(0, -1)) {
    if (f.kind === "List") steps.push({ kind: "Element" });
    else if (f.key !== undefined) steps.push({ kind: "Key", key: f.key });
    else return undefined;
  }
  return [steps, keyStart];
}

/** For the cursor at the end of NBT path `text`: the steps before the last segment, and
 * where that segment starts. `undefined` inside brackets or quotes. */
function pathCursor(text: string): [Step[], number] | undefined {
  const steps: Step[] = [];
  let seg = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      const close = text.indexOf(c, i + 1);
      if (close < 0) return undefined;
      i = close;
    } else if (c === "[" || c === "{") {
      if (i > seg) steps.push({ kind: "Key", key: unquote(text.slice(seg, i)) });
      const end = closing(text, i);
      if (end === undefined) return undefined;
      i = end;
      if (c === "[") steps.push({ kind: "Element" });
      seg = i + 1;
    } else if (c === ".") {
      if (i > seg) steps.push({ kind: "Key", key: unquote(text.slice(seg, i)) });
      seg = i + 1;
    }
  }
  return [steps, seg];
}

/** The index of the bracket that closes the one at `open`. */
function closing(text: string, open: number): number | undefined {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      const close = text.indexOf(c, i + 1);
      if (close < 0) return undefined;
      i = close;
    } else if (c === "[" || c === "{") depth += 1;
    else if (c === "]" || c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return undefined;
}

function topLevelColon(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      const close = text.indexOf(c, i + 1);
      if (close < 0) return text.length;
      i = close;
    } else if (c === "[" || c === "{") depth += 1;
    else if (c === "]" || c === "}") depth -= 1;
    else if (c === ":" && depth === 0) return i;
  }
  return text.length;
}


/** The text without one quote at each end; unchanged unless it has both. */
function unquote(s: string): string {
  return s.length >= 2 && isQuote(s[0]!) && isQuote(s[s.length - 1]!) ? s.slice(1, -1) : s;
}

function stepKeys(steps: readonly Step[]): (string | undefined)[] {
  return steps.map((s) => (s.kind === "Key" ? s.key : undefined));
}

/** The entity type a selector's options fix with `type=`. */
function selectorType(options: string): string | undefined {
  for (const o of options.split(",")) {
    const eq = o.indexOf("=");
    if (eq < 0) continue;
    const v = trimWhiteSpace(o.slice(eq + 1));
    if (trimWhiteSpace(o.slice(0, eq)) === "type" && !v.startsWith("!") && !v.startsWith("#")) return fullId(v);
  }
  return undefined;
}

export const MAX_STORAGE_KEYS = 64;

/** Adds the NBT paths that `storage <id> <path>` uses in a function's text, with every
 * prefix (`Return`, `Return.Difficulty`), by storage id. Elements and filters are dropped.
 * IMP-Doc lines such as `# @input storage api: Argument.ID` count as well. The sets keep the
 * order of insertion, not a sorted order. */
export function collectStoragePaths(text: string, out: Map<string, Set<string>>): void {
  const isId = (s: string): boolean => {
    if (s === "") return false;
    for (let i = 0; i < s.length; i++) if (!isAllowedInResourceLocation(s[i]!)) return false;
    return true;
  };
  for (const line of lines(text)) {
    const tokens = line.split(" ");
    for (let t = 0; t + 3 <= tokens.length; t++) {
      const [w0, w1, w2] = [tokens[t]!, tokens[t + 1]!, tokens[t + 2]!];
      if (w0 !== "storage" || !isId(w1) || !isAscii(w2) || w2.startsWith("{") || w2.includes("$(")) continue;
      let path = w2.slice(0, topLevelColon(w2));
      while (path.endsWith("?")) path = path.slice(0, -1);
      const cursor = pathCursor(path);
      if (cursor === undefined) continue;
      const [steps, seg] = cursor;
      const keys = steps.flatMap((s) => (s.kind === "Key" ? [s.key] : []));
      const last = unquote(path.slice(seg));
      if (last !== "") keys.push(last);
      if (keys.some((k) => ![...k].every(isAllowedInUnquoted))) continue;
      keys.length = Math.min(keys.length, MAX_STORAGE_KEYS);
      const id = fullId(w1);
      let set = out.get(id);
      if (set === undefined) {
        set = new Set();
        out.set(id, set);
      }
      for (let n = 1; n <= keys.length; n++) set.add(keys.slice(0, n).join("."));
    }
  }
}

/** The lines without `\n` or `\r\n`, and no empty line after the last one. A `\r` alone stays
 * in the line. */
function lines(text: string): string[] {
  const out = text.split("\n");
  if (out[out.length - 1] === "") out.pop();
  return out.map((l, i) => (i < out.length - 1 || text.endsWith("\n")) && l.endsWith("\r") ? l.slice(0, -1) : l);
}
