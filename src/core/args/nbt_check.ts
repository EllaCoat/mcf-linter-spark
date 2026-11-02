// The NBT checks of DHP 3.4.19 (`NbtArgumentParser`, `NbtPathArgumentParser`) against the
// vanilla-mcdoc schema: the type check and the lint rules that work on keys and values.
//
// A compound is checked in two passes as DHP does. `parsePass` is what the parser itself
// reports (key quotes, naming conventions, duplicate keys, number literals out of range); it
// follows the schema only to know which keys it names. `validate` checks the types over the
// finished tree. With a `spyglass.json`, the checks the modified Spyglass makes on top (missing
// keys of a whole value, its range message) apply.

import { charAt, isAsciiAlphanumeric } from "../chars.ts";
import type { Effect } from "../command.ts";
import { Config } from "../config.ts";
import type { VersionData } from "../data.ts";
import { ParseError, type Severity, severityParse } from "../diag.ts";
import { kind as kinds } from "../facts.ts";
import { type JsonValue, asBool, asStr, get } from "../json-value.ts";
import { expectedQuote, followsConvention } from "../lint.ts";
import {
  ANY,
  type Alt,
  CHECK_LIMIT_MESSAGE,
  CheckLimit,
  type Field,
  type Holds,
  type IdAttr,
  type Lit,
  type McDoc,
  type NumKind,
  type Path,
  type Range,
  Resolver,
  type Scope,
  type Tree,
  type Ty,
  numKindBounds,
  numKindName,
  rangeContains,
  sameString,
  stripMinecraft,
} from "../mcdoc.ts";
import { fmtF32, parseF64 } from "../numbers.ts";
import { type PResult, Reader } from "../reader.ts";
import * as blockitem from "./blockitem.ts";
import { ArgCtx, registryRule } from "./index.ts";
import { type NbtEntry, type NbtNode, type NbtPathNode, type NbtValue, modern } from "./nbt.ts";
import * as text from "./text.ts";

/** The dispatcher an NBT's type comes from. */
export type Category =
  | "Entity"
  | "Block"
  | "Item"
  /** The value of an item component (1.20.5), by component type. */
  | "DataComponent"
  /** The value of an item predicate's `~` test, by predicate type. */
  | "ComponentPredicate"
  /** The options of a particle (1.20.5), by particle type. */
  | "Particle"
  /** A text component in SNBT (1.21.5). */
  | "Text"
  /** A text style in SNBT (1.21.5). */
  | "Style"
  /** A data pack element written inline in a command (1.20.5), by its kind (`loot_table`). */
  | "Resource"
  /** An item modifier written inline in a command, which from 26.3 may be a list of ids and
   * modifiers although a file holds one modifier. */
  | "ItemModifier"
  /** A slot source written inline in a command (26.3), which may be a list like an item modifier. */
  | "SlotSource";

/** The dispatcher of the category's types, or the one type of the categories with one. */
export function registry(category: Category): string {
  switch (category) {
    case "Entity":
      return "minecraft:entity";
    case "Block":
      return "minecraft:block";
    case "Item":
      return "minecraft:item";
    case "DataComponent":
      return "minecraft:data_component";
    case "ComponentPredicate":
      return "minecraft:data_component_predicate";
    case "Particle":
      return "minecraft:particle";
    case "Text":
      return "::java::util::text::Text";
    case "Style":
      return "::java::util::text::TextStyle";
    case "Resource":
      return "minecraft:resource";
    case "ItemModifier":
      return "::java::data::item_modifier::ItemModifierArgument";
    case "SlotSource":
      return "::java::data::slot_source::SlotSourceArgument";
  }
}

/** What a typed NBT is checked against. */
export interface Target {
  category: Category;
  /** The id whose type applies. `undefined` merges every type of the category. */
  id: string | undefined;
  /** DHP's `isPredicate`: types must match strictly. */
  predicate: boolean;
  /** The tag is a whole value (a summoned entity, a `data modify` value other than `merge`),
   * so the modified Spyglass reports the keys it lacks. */
  whole: boolean;
}

export function new_(category: Category, id: string | undefined): Target {
  return { category, id, predicate: false, whole: false };
}

/** The type of the target's NBT: the dispatcher's entry for the id (or `%unknown`), or all its
 * entries merged when the id is not known. */
function rootType(doc: McDoc, target: Target): Ty {
  const dispatcher = registry(target.category);
  if (target.category === "Text" || target.category === "Style" || target.category === "ItemModifier" || target.category === "SlotSource") {
    return doc.types.get(dispatcher) ?? ANY;
  }
  if (target.id !== undefined) {
    const entries = doc.dispatchers.get(dispatcher);
    if (entries === undefined) return ANY;
    return entries.get(stripMinecraft(target.id)) ?? entries.get("%unknown") ?? ANY;
  }
  return doc.merged(dispatcher) ?? ANY;
}

/** A tag as the resolver reads it for the index of a dispatcher. */
class NbtTree implements Tree {
  readonly node: NbtNode;

  constructor(node: NbtNode) {
    this.node = node;
  }

  field(name: string): NbtTree | undefined {
    const value = this.node.value;
    if (value.kind !== "Compound") return undefined;
    for (let i = value.entries.length - 1; i >= 0; i--) {
      const e = value.entries[i]!;
      if (e.key === name) return new NbtTree(e.value);
    }
    return undefined;
  }

  string(): string | undefined {
    const value = this.node.value;
    return value.kind === "String" ? value.value : undefined;
  }
}

/** The tags from the root to the one being checked, each with its key in its compound. */
type Stack = [NbtTree, string | undefined][];

function top(stack: Stack): NbtNode {
  return stack[stack.length - 1]![0].node;
}

/** Checks a parsed tag. `target` is `undefined` for an NBT without a schema. */
export function checkValue(data: VersionData, config: Config, node: NbtNode, target: Target | undefined): Effect[] {
  return checkValueWith(data, config, node, target, CheckLimit.forNodes(nodeCount(node)));
}

export function checkValueWith(data: VersionData, config: Config, node: NbtNode, target: Target | undefined, limit: CheckLimit): Effect[] {
  // A component, a predicate value, particle options and a text component may be any tag, not
  // only a compound.
  const decoded = target !== undefined && target.category !== "Entity" && target.category !== "Block" && target.category !== "Item";
  const checker = new Checker(data, config);
  checker.whole = target?.whole ?? false;
  checker.decoded = decoded;
  checker.limit = limit;
  const out: Sink = [];
  const stack: Stack = [[new NbtTree(node), undefined]];
  const alts = target !== undefined ? checker.r.resolve(rootType(data.mcdoc, target), checker.r.empty, stack, false, 0) : [];
  if (target !== undefined && decoded) {
    checker.parsePass(out, stack, alts);
    checker.validate(out, stack, alts, target.predicate);
  } else {
    checker.checkRoot(out, stack, alts, target?.predicate ?? false);
  }
  limitWarning(checker, out, node);
  return out;
}

function nodeCount(root: NbtNode): number {
  let nodes = 0;
  const pending: NbtNode[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    nodes += 1;
    const value = node.value;
    switch (value.kind) {
      case "List":
      case "ByteArray":
      case "IntArray":
      case "LongArray":
        for (const item of value.items) pending.push(item);
        break;
      case "Compound":
        for (const e of value.entries) pending.push(e.value);
        break;
      default:
    }
  }
  return nodes;
}

function limitWarning(checker: Checker, out: Sink, node: NbtNode): void {
  if (checker.limit.reached()) {
    emit(out, node.start, node.start + 1, "Warning", "nbtCheckLimit", CHECK_LIMIT_MESSAGE);
  }
}

/** `Unit.CODEC`, which reads the value of a test that an item has a component: any compound. */
export function checkUnit(node: NbtNode): Effect[] {
  const out: Sink = [];
  const kind = node.value.kind;
  if (kind !== "Compound") {
    const message = `Expected ${articleName("Compound")} but got ${articleName(kind)}`;
    emit(out, node.start, node.end, "Error", "nbtTypeCheck", message);
  }
  return out;
}

/** Checks a parsed NBT path. `target` is `undefined` for a path without a schema (storage). */
export function checkPath(data: VersionData, config: Config, nodes: readonly NbtPathNode[], target: Target | undefined): Effect[] {
  const pathSteps = steps(nodes);
  let filters = 0;
  for (const s of pathSteps) {
    if (s.kind === "Filter") filters += nodeCount(s.node);
    else if (s.kind === "Index" && s.filter !== undefined) filters += nodeCount(s.filter);
  }
  return walkPath(data, config, pathSteps, target, CheckLimit.forNodes(filters));
}

export function walkPath(data: VersionData, config: Config, steps: readonly Step[], target: Target | undefined, limit: CheckLimit): Effect[] {
  const checker = new Checker(data, config);
  checker.limit = limit;
  const out: Sink = [];
  if (target !== undefined) checker.walk(out, steps, [[rootType(data.mcdoc, target), checker.r.empty]]);
  else checker.walk(out, steps, undefined);
  if (checker.limit.reached() && steps.length > 0) {
    const start = stepStart(steps[0]!);
    emit(out, start, start + 1, "Warning", "nbtCheckLimit", CHECK_LIMIT_MESSAGE);
  }
  return out;
}

/** Checks the tag of `data modify <entity|block> <target> <path> <op> value <tag>` against the
 * type at the end of `path`: the element type for `append`, `prepend` and `insert`
 * (`element`), the type itself otherwise. The modified Spyglass types this tag; DHP only parses
 * it, as `checkValue` with no target does. */
export function checkModifyValue(
  data: VersionData,
  config: Config,
  path: readonly NbtPathNode[],
  target: Target,
  element: boolean,
  node: NbtNode,
): Effect[] {
  const checker = new Checker(data, config);
  checker.modify = true;
  checker.whole = target.whole;
  checker.limit = CheckLimit.forNodes(nodeCount(node));
  const pathSteps = steps(path);
  const root = checker.r.resolve(rootType(data.mcdoc, target), checker.r.empty, [], false, 0);
  let end = checker.pathEnd(pathSteps, root);
  if (element && end !== undefined) end = checker.elements(end, undefined);
  const stack: Stack = [[new NbtTree(node), undefined]];
  const alts = end !== undefined ? end.flatMap(([t, s]) => checker.r.resolve(t, s, stack, false, 0)) : [];
  const out: Sink = [];
  checker.parsePass(out, stack, alts);
  checker.validate(out, stack, alts, false);
  limitWarning(checker, out, node);
  return out;
}

/** The keys of the compound that `steps` reach from the target's root (a key, or `undefined`
 * for a list element), with the kind of tag each holds. */
export function keysAt(data: VersionData, target: Target, steps: readonly (string | undefined)[]): [string, string][] {
  const checker = new Checker(data, new Config());
  const r = checker.r;
  let alts = r.resolve(rootType(data.mcdoc, target), r.empty, [], false, 0);
  for (const step of steps) {
    const next = step !== undefined ? checker.fields(alts, step) : checker.altElements(alts, undefined);
    alts = next.flatMap(([t, s]) => r.resolve(t, s, [], false, 0));
  }
  const out: [string, string][] = [];
  for (const alt of alts) {
    if (alt.kind !== "Struct") continue;
    for (const [f, s] of alt.fields) {
      if (f.kind !== "Pair") continue;
      const names = f.key.kind === "Name" ? [f.key.name] : r.keyNames(f.key.ty, s, []);
      for (const name of names) {
        if (!out.some(([n]) => n === name)) {
          out.push([name, tagName(r.resolve(f.ty, s, [], false, 0))]);
        }
      }
    }
  }
  return out;
}

/** The kind of tag the alternatives hold, as the completion shows it. */
function tagName(alts: readonly Alt[]): string {
  const name = (alt: Alt): string => {
    switch (alt.kind) {
      case "Any":
        return "tag";
      case "Struct":
        return "compound";
      case "Leaf": {
        const ty = alt.ty;
        switch (ty.kind) {
          case "Boolean":
            return "boolean";
          case "String":
            return "string";
          case "Number":
            return numKindName(ty.numKind);
          case "Literal":
          case "Enum":
            return "enum";
          case "List":
          case "Tuple":
            return "list";
          case "Array":
            if (ty.numKind === "Byte") return "byte array";
            if (ty.numKind === "Int") return "int array";
            return "long array";
          default:
            return "tag";
        }
      }
    }
  };
  const first = alts[0];
  if (first !== undefined && alts.slice(1).every((a) => name(a) === name(first))) return name(first);
  return "tag";
}

/** The alternatives when they are a schema to follow; `undefined` where any tag is allowed. */
function schema(alts: readonly Alt[]): readonly Alt[] | undefined {
  return alts.length !== 0 && !alts.some((a) => a.kind === "Any") ? alts : undefined;
}

type Sink = Effect[];

function emit(out: Sink, start: number, end: number, severity: Severity, code: string, message: string): void {
  out.push({ kind: "Diag", diag: { start, end, severity, code, message } });
}

function extend(out: Sink, items: readonly Effect[]): void {
  for (const e of items) out.push(e);
}

function cloneEffect(e: Effect): Effect {
  switch (e.kind) {
    case "Diag":
      return { kind: "Diag", diag: { ...e.diag } };
    case "Ref":
      return { kind: "Ref", ref: { ...e.ref } };
    case "Write":
      return { kind: "Write", ref: { ...e.ref } };
    case "Def":
      return { kind: "Def", def: { ...e.def } };
  }
}

function diagCount(out: readonly Effect[]): number {
  let n = 0;
  for (const e of out) if (e.kind === "Diag") n += 1;
  return n;
}

function errorCount(out: readonly Effect[]): number {
  let n = 0;
  for (const e of out) if (e.kind === "Diag" && e.diag.severity === "Error") n += 1;
  return n;
}

/** `punc.quote`. */
function quoted(s: string): string {
  return `“${s}”`;
}

/** `arrayToMessage(items, true, 'or')`. */
function joinOr(items: readonly string[]): string {
  const q = items.map(quoted);
  switch (q.length) {
    case 0:
      return "nothing";
    case 1:
      return q[0]!;
    case 2:
      return `${q[0]!} or ${q[1]!}`;
    default:
      return `${q.slice(0, -1).join(", ")}, or ${q[q.length - 1]!}`;
  }
}

function truthy(v: JsonValue): boolean {
  if (v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "";
  return true;
}

function jsBound(x: number | undefined): string {
  return x === undefined ? "null" : String(x);
}

/** The value of a number tag. An integer is kept exact: a long does not fit a double. */
export type Num = { kind: "Int"; value: bigint } | { kind: "Float"; value: number };

/** Whether the value is in the range, an end left out being open. */
export function numWithin(n: Num, r: Range): boolean {
  let lower = true;
  if (r.min !== undefined) {
    const order = cmpBound(n, r.min);
    lower = order > 0 || (order === 0 && !r.minExclusive);
  }
  let upper = true;
  if (r.max !== undefined) {
    const order = cmpBound(n, r.max);
    upper = order < 0 || (order === 0 && !r.maxExclusive);
  }
  return lower && upper;
}

function cmpBound(n: Num, bound: number): number {
  if (n.kind === "Int") return cmpIntFloat(n.value, bound);
  return n.value < bound ? -1 : n.value > bound ? 1 : 0;
}

function cmpIntFloat(v: bigint, bound: number): number {
  if (bound >= 9.3e18) return -1;
  if (bound <= -9.3e18) return 1;
  const floor = Math.floor(bound);
  const f = BigInt(floor);
  const order = v < f ? -1 : v > f ? 1 : 0;
  return order === 0 && bound > floor ? -1 : order;
}

/** The value of a number tag, and as JavaScript prints it. */
function numberOf(v: NbtValue): [Num, string] | undefined {
  switch (v.kind) {
    case "Byte":
    case "Short":
    case "Int":
      return [{ kind: "Int", value: BigInt(v.value) }, String(v.value)];
    case "Long":
      return [{ kind: "Int", value: v.value }, String(v.value)];
    case "Float": {
      // DHP keeps the double of the literal; the shortest f32 text is that literal in practice.
      const d = parseF64(fmtF32(v.value)) ?? v.value;
      return [{ kind: "Float", value: d }, String(d)];
    }
    case "Double":
      return [{ kind: "Float", value: v.value }, String(v.value)];
    default:
      return undefined;
  }
}

/** The type of a tag as DHP's `NbtNodeTypeName` names it. */
type NbtKind = NbtValue["kind"];

/** `nbt-tag.<name>` of DHP's locale. */
function articleName(kind: NbtKind): string {
  switch (kind) {
    case "Byte":
      return "a byte tag";
    case "Short":
      return "a short tag";
    case "Int":
      return "an int tag";
    case "Long":
      return "a long tag";
    case "Float":
      return "a float tag";
    case "Double":
      return "a double tag";
    case "String":
      return "a string tag";
    case "ByteArray":
      return "a byte array tag";
    case "IntArray":
      return "an int array tag";
    case "LongArray":
      return "a long array tag";
    case "List":
      return "a list tag";
    case "Compound":
      return "a compound tag";
  }
}

function arrayKind(kind: NumKind): NbtKind {
  switch (kind) {
    case "Byte":
      return "ByteArray";
    case "Long":
      return "LongArray";
    default:
      return "IntArray";
  }
}

function isNumberKind(kind: NbtKind): boolean {
  switch (kind) {
    case "Byte":
    case "Short":
    case "Int":
    case "Long":
    case "Float":
    case "Double":
      return true;
    default:
      return false;
  }
}

/** Whether an alternative has the tag's shape, so that what it reports is more than the type. */
function fits(node: NbtNode, alt: Alt): boolean {
  const kind = node.value.kind;
  switch (alt.kind) {
    case "Any":
      return true;
    case "Struct":
      return kind === "Compound";
    case "Leaf": {
      const ty = alt.ty;
      switch (ty.kind) {
        case "List":
        case "Tuple":
          return kind === "List";
        case "String":
          return kind === "String";
        case "Array":
          return kind === arrayKind(ty.numKind);
        case "Number":
          return kind === ty.numKind;
        case "Boolean":
          return kind === "Byte";
        default:
          return false;
      }
    }
  }
}

interface QuoteRule {
  quote: [Severity, boolean] | undefined;
  kind: [Severity, string] | undefined;
  quoteName: string;
  kindName: string;
}

interface Rules {
  typeSeverity: Severity;
  typeStrict: boolean;
  boolean: [Severity, JsonValue] | undefined;
  arrayLength: Severity | undefined;
  listLength: Severity | undefined;
  naming: [Severity, JsonValue] | undefined;
  keyQuote: QuoteRule;
  pathQuote: QuoteRule;
  stringQuote: QuoteRule;
}

/** A rule written as `[severity, value]`. An absent setting takes DHP's default; `null` turns the rule off. */
function readRule(config: Config, name: string, fallback: [Severity, JsonValue] | undefined): [Severity, JsonValue] | undefined {
  const v = config.lintValue(name);
  if (v === undefined) return fallback;
  if (Array.isArray(v) && v.length === 2) {
    const s = asStr(v[0]);
    if (s === undefined) return undefined;
    const severity = severityParse(s);
    return severity === undefined ? undefined : [severity, v[1]!];
  }
  return undefined;
}

function quoteRule(config: Config, quoteName: string, quoteDefault: boolean | undefined, kindName: string, kindDefault: string): QuoteRule {
  const q = readRule(config, quoteName, quoteDefault === undefined ? undefined : ["Warning", quoteDefault]);
  const k = readRule(config, kindName, ["Warning", kindDefault]);
  return {
    quote: q === undefined ? undefined : [q[0], asBool(q[1]) ?? false],
    kind: k === undefined ? undefined : [k[0], asStr(k[1]) ?? "prefer double"],
    quoteName,
    kindName,
  };
}

function readRules(config: Config): Rules {
  const typeCheck = readRule(config, "nbtTypeCheck", undefined);
  const length = (name: string, fallback: [Severity, JsonValue] | undefined): Severity | undefined => {
    const rule = readRule(config, name, fallback);
    return rule !== undefined && truthy(rule[1]) ? rule[0] : undefined;
  };
  return {
    typeSeverity: typeCheck?.[0] ?? "Warning",
    typeStrict: typeCheck !== undefined && asStr(typeCheck[1]) === "strictly",
    boolean: readRule(config, "nbtBoolean", undefined),
    arrayLength: length("nbtArrayLengthCheck", ["Warning", true]),
    listLength: length("nbtListLengthCheck", undefined),
    naming: readRule(config, "nameOfNbtCompoundTagKeys", undefined),
    keyQuote: quoteRule(config, "nbtCompoundKeyQuote", undefined, "nbtCompoundKeyQuoteType", "prefer double"),
    pathQuote: quoteRule(config, "nbtPathQuote", undefined, "nbtPathQuoteType", "always double"),
    stringQuote: quoteRule(config, "nbtStringQuote", true, "nbtStringQuoteType", "prefer double"),
  };
}

const INTEGER_LITERAL = /^[-+]?(?:0|[1-9][0-9]*)$/;

/** A type the schema gives a tag, with the template arguments it was written with. */
type Typed = [Ty, Scope];

function pushDistinct(types: Typed[], ty: Ty, scope: Scope): void {
  if (!types.some(([t, s]) => t === ty && s === scope)) types.push([ty, scope]);
}

/** The effects of a type checked on a tag, by the tag, the type, and the template arguments. */
type Memo = Map<NbtNode, Map<Ty, Map<Scope, Sink>>>;

class Checker {
  readonly r: Resolver;
  readonly data: VersionData;
  readonly config: Config;
  readonly rules: Rules;
  /** The modified Spyglass's typing of a `data modify` value: number kinds
   * are interchangeable, but a boolean must be a byte. */
  modify = false;
  /** `Target.whole`. */
  whole = false;
  /** The game decodes the tag with a codec when it loads the command (a component, a particle's
   * options, a text component in SNBT), so a tag of another shape or without a required key
   * does not load. */
  decoded = false;
  /** By the depth of the tag in the stack, then `pred` (`[false, true]`). */
  private readonly validated: [Memo, Memo][] = [];
  limit = new CheckLimit(Infinity);

  constructor(data: VersionData, config: Config) {
    this.r = new Resolver(data.mcdoc);
    this.data = data;
    this.config = config;
    this.rules = readRules(config);
  }

  checkRoot(out: Sink, stack: Stack, alts: readonly Alt[], predicate: boolean): void {
    this.parsePass(out, stack, alts);
    if (top(stack).value.kind === "Compound") this.validate(out, stack, alts, predicate);
  }

  // ---- following the schema ----

  /** The types of `key` in the structs among `alts`, and whether a field names the key (rather
   * than a field whose key is a type, as `[string]: any` in an item's tag). */
  private fieldTypes(alts: readonly Alt[], key: string, container: Path): [Typed[], boolean] {
    const types: Typed[] = [];
    let named = false;
    for (const alt of alts) {
      if (alt.kind !== "Struct") continue;
      const found = this.r.field(alt.fields, key, container);
      if (found !== undefined) {
        const [ty, scope, keyType] = found;
        pushDistinct(types, ty, scope);
        named ||= keyType === undefined;
      }
    }
    return [types, named];
  }

  fields(alts: readonly Alt[], key: string): Typed[] {
    return this.fieldTypes(alts, key, [])[0];
  }

  /** The types of the elements of the lists among `alts`; `position` picks a tuple's item. */
  elements(alts: readonly Typed[], position: number | undefined): Typed[] {
    const resolved = alts.flatMap(([t, s]) => this.r.resolve(t, s, [], false, 0));
    return this.altElements(resolved, position);
  }

  altElements(alts: readonly Alt[], position: number | undefined): Typed[] {
    const out: Typed[] = [];
    for (const alt of alts) {
      if (alt.kind !== "Leaf") continue;
      const ty = alt.ty;
      if (ty.kind === "List") pushDistinct(out, ty.item, alt.scope);
      else if (ty.kind === "Tuple") {
        if (position !== undefined) {
          const t = ty.items[position];
          if (t !== undefined) pushDistinct(out, t, alt.scope);
        } else {
          for (const t of ty.items) pushDistinct(out, t, alt.scope);
        }
      }
    }
    return out;
  }

  // ---- what the parser reports ----

  parsePass(out: Sink, stack: Stack, alts: readonly Alt[]): void {
    const node = top(stack);
    const value = node.value;
    switch (value.kind) {
      case "Compound": {
        const seen = new Set<string>();
        for (const e of value.entries) {
          this.quoteProblems(out, this.rules.keyQuote, e.keyQuote, e.key, e.keyStart, e.keyEnd);
          const [types, named] = this.fieldTypes(alts, e.key, stack);
          if (!named) this.checkNaming(out, e);
          if (seen.has(e.key)) {
            emit(out, e.keyStart, e.keyEnd, "Warning", "nbtDuplicateKey", `Duplicate key ${quoted(e.key)}`);
          } else {
            seen.add(e.key);
          }
          stack.push([new NbtTree(e.value), e.key]);
          const child = types.flatMap(([t, s]) => this.r.resolve(t, s, stack, false, 0));
          this.parsePass(out, stack, child);
          stack.pop();
        }
        break;
      }
      case "List": {
        for (let i = 0; i < value.items.length; i++) {
          stack.push([new NbtTree(value.items[i]!), undefined]);
          const child = this.altElements(alts, i).flatMap(([t, s]) => this.r.resolve(t, s, stack, false, 0));
          this.parsePass(out, stack, child);
          stack.pop();
        }
        break;
      }
      case "String":
        if (value.quote === undefined) this.checkLiteralRange(out, node, value.value);
        break;
      default:
    }
  }

  private checkNaming(out: Sink, e: NbtEntry): void {
    if (this.rules.naming === undefined) return;
    const [severity, convention] = this.rules.naming;
    if (followsConvention(e.key, convention)) return;
    const labels = Array.isArray(convention) ? convention.map(conventionLabel) : [conventionLabel(convention)];
    const message = `Invalid key ${quoted(e.key)} which doesn't follow ${joinOr(labels)} convention`;
    emit(out, e.keyStart, e.keyEnd, severity, "nameOfNbtCompoundTagKeys", message);
  }

  /** A number written like `128b` that does not fit its type stays a string; DHP warns about it. */
  private checkLiteralRange(out: Sink, node: NbtNode, literal: string): void {
    const last = literal[literal.length - 1];
    let digits: string;
    let min: bigint;
    let max: bigint;
    let minS: string;
    let maxS: string;
    switch (last) {
      case "b":
      case "B":
        [digits, min, max, minS, maxS] = [literal.slice(0, -1), -128n, 127n, "-128", "127"];
        break;
      case "s":
      case "S":
        [digits, min, max, minS, maxS] = [literal.slice(0, -1), -32768n, 32767n, "-32,768", "32,767"];
        break;
      case "l":
      case "L":
        [digits, min, max, minS, maxS] = [literal.slice(0, -1), -(2n ** 63n), 2n ** 63n - 1n, "-9,223,372,036,854,775,808", "9,223,372,036,854,775,807"];
        break;
      default:
        [digits, min, max, minS, maxS] = [literal, -2147483648n, 2147483647n, "-2,147,483,648", "2,147,483,647"];
    }
    if (!INTEGER_LITERAL.test(digits)) return;
    const v = BigInt(digits.startsWith("+") ? digits.slice(1) : digits);
    if (min <= v && v <= max) return;
    let got: string;
    if (last === "l" || last === "L") {
      const trimmed = digits.startsWith("+") ? digits.slice(1) : digits;
      got = trimmed === "-0" ? "0" : trimmed;
    } else {
      got = String(parseF64(digits) ?? NaN);
    }
    emit(out, node.start, node.end, "Warning", "nbtNumberOutOfRange", `Expected a number between ${minS} and ${maxS} but got ${got}`);
  }

  /** `validateStringQuote`. `quote` is the quote the source used, if any. */
  private quoteProblems(out: Sink, rule: QuoteRule, quote: string | undefined, value: string, start: number, end: number): void {
    if (rule.quote === undefined && rule.kind === undefined) return;
    const first = quote ?? charAt(value, 0) ?? " ";
    const expected = expectedQuote(value, rule.kind?.[1] ?? "prefer double");
    if (rule.quote !== undefined) {
      const [severity, shouldQuote] = rule.quote;
      if (shouldQuote !== (quote !== undefined)) {
        const wanted = shouldQuote ? "a quote (“'” or “\"”)" : "an unquoted string";
        const message = `Expected ${wanted} but got ${quoted(first)} (rule: ${quoted(rule.quoteName)})`;
        emit(out, start, end, severity, rule.quoteName, message);
      }
    }
    if (quote !== undefined && rule.kind !== undefined && quote !== expected) {
      const preferred = expected === '"' ? "Double quote (“\"”)" : "Single quote (“'”)";
      const message = `${preferred} is preferable here (rule: ${quoted(rule.kindName)})`;
      emit(out, start, end, rule.kind[0], rule.kindName, message);
    }
  }

  // ---- the type check ----

  /** Checks the tag on top of `stack` against its alternatives: the first that reports
   * nothing, or else the one that reports the least, preferring one of the tag's shape. A codec
   * reads a decoded tag that has only warnings, so for one the fewest errors come first. */
  validate(out: Sink, stack: Stack, alternatives: readonly Alt[], pred: boolean): void {
    const alts = schema(alternatives);
    if (alts === undefined) return;
    if (alts.length === 1) {
      this.validateOne(out, stack, alts[0]!, pred);
      return;
    }
    const node = top(stack);
    let best: [Sink, boolean] | undefined;
    for (const alt of alts) {
      const child: Sink = [];
      this.validateOne(child, stack, alt, pred);
      const n = diagCount(child);
      if (n === 0) {
        extend(out, child);
        return;
      }
      const fit = fits(node, alt);
      let better: boolean;
      if (best === undefined) better = true;
      else {
        const [b, bFit] = best;
        const m = diagCount(b);
        if (this.decoded) {
          const e = errorCount(child);
          const f = errorCount(b);
          better = e < f || (e === f && ((fit && !bFit) || (fit === bFit && n < m)));
        } else {
          better = n < m || (n === m && fit && !bFit);
        }
      }
      if (better) best = [child, fit];
    }
    if (best !== undefined) extend(out, best[0]);
  }

  private validateTyped(out: Sink, stack: Stack, ty: Ty, scope: Scope, pred: boolean): void {
    const node = top(stack);
    const depth = stack.length;
    const hit = this.validated[depth]?.[pred ? 1 : 0].get(node)?.get(ty)?.get(scope);
    if (hit !== undefined) {
      for (const e of hit) out.push(cloneEffect(e));
      return;
    }
    if (!this.limit.take()) return;
    const alts = this.r.resolve(ty, scope, stack, false, 0);
    const effects: Sink = [];
    this.validate(effects, stack, alts, pred);
    for (const e of effects) out.push(cloneEffect(e));
    // ponytail: keeps the results one level below the tag, so types that differ between two alternatives and meet again further down are checked once per alternative; keep more levels if a schema nests that way
    while (this.validated.length < depth + 2) this.validated.push([new Map(), new Map()]);
    this.validated.length = depth + 2;
    const memo = this.validated[depth]![pred ? 1 : 0];
    let byType = memo.get(node);
    if (byType === undefined) {
      byType = new Map();
      memo.set(node, byType);
    }
    let byScope = byType.get(ty);
    if (byScope === undefined) {
      byScope = new Map();
      byType.set(ty, byScope);
    }
    byScope.set(scope, effects);
  }

  private validateOne(out: Sink, stack: Stack, alt: Alt, pred: boolean): void {
    const node = top(stack);
    switch (alt.kind) {
      case "Any":
        return;
      case "Struct": {
        const value = node.value;
        if (this.checkType(out, node, "Compound", pred) && value.kind === "Compound") {
          this.validateCompound(out, stack, value.entries, alt.fields, alt.open, pred);
          this.checkRequired(out, node, alt.fields, pred);
        }
        return;
      }
      case "Leaf": {
        const ty = alt.ty;
        const value = node.value;
        switch (ty.kind) {
          case "Boolean":
            if (this.modify && (value.kind === "Short" || value.kind === "Int" || value.kind === "Long" || value.kind === "Float" || value.kind === "Double")) {
              emit(out, node.start, node.end, "Error", "nbtTypeCheck", "Expected a boolean");
            } else if (this.checkType(out, node, "Byte", pred)) {
              this.checkBoolean(out, node);
            }
            return;
          case "Number":
            if (this.checkType(out, node, ty.numKind, pred)) this.checkNumber(out, node, ty.numKind, ty.range);
            return;
          case "String": {
            const attr = ty.id ?? alt.outer;
            if (attr !== undefined) this.idField(out, node, attr, pred);
            else this.stringField(out, node, ty.holds, pred);
            return;
          }
          case "Literal":
            this.enumField(out, node, [ty.value], undefined, ty.id || alt.outer !== undefined, pred);
            return;
          case "Enum":
            this.enumField(out, node, ty.values, ty.num, ty.id || alt.outer !== undefined, pred);
            return;
          case "List":
            if (this.checkType(out, node, "List", pred) && value.kind === "List") {
              if (ty.len !== undefined) this.checkLength(out, node, ty.len, value.items.length, this.rules.listLength, "nbtListLengthCheck");
              for (const element of value.items) {
                stack.push([new NbtTree(element), undefined]);
                this.validateTyped(out, stack, ty.item, alt.scope, pred);
                stack.pop();
              }
            }
            return;
          case "Tuple":
            if (this.checkType(out, node, "List", pred) && value.kind === "List") {
              const n = ty.items.length;
              const exact: Range = { min: n, max: n, minExclusive: false, maxExclusive: false };
              this.checkLength(out, node, exact, value.items.length, this.rules.listLength, "nbtListLengthCheck");
              const count = Math.min(value.items.length, n);
              for (let i = 0; i < count; i++) {
                stack.push([new NbtTree(value.items[i]!), undefined]);
                this.validateTyped(out, stack, ty.items[i]!, alt.scope, pred);
                stack.pop();
              }
            }
            return;
          case "Array":
            this.arrayField(out, node, ty.numKind, ty.len, ty.range, pred);
            return;
          default:
            return;
        }
      }
    }
  }

  private validateCompound(
    out: Sink,
    stack: Stack,
    entries: readonly NbtEntry[],
    fields: readonly (readonly [Field, Scope])[],
    open: boolean,
    pred: boolean,
  ): void {
    const last = new Map<string, number>();
    entries.forEach((e, i) => last.set(e.key, i));
    const seen = new Set<string>();
    for (const first of entries) {
      // `Object.keys` lists a repeated key once, with the last value and the last key's range.
      if (seen.has(first.key)) continue;
      seen.add(first.key);
      const entry = entries[last.get(first.key)!]!;
      const found = this.r.field(fields, entry.key, stack);
      if (found !== undefined) {
        const [ty, scope] = found;
        stack.push([new NbtTree(entry.value), entry.key]);
        this.validateTyped(out, stack, ty, scope, pred);
        stack.pop();
      } else if (!open) {
        emit(out, entry.keyStart, entry.keyEnd, "Warning", "nbtUnknownKey", `Unknown key ${quoted(entry.key)}`);
      }
    }
  }

  /** The modified Spyglass reports the keys that a whole value lacks, and a decoded tag lacks none. */
  private checkRequired(out: Sink, node: NbtNode, fields: readonly (readonly [Field, Scope])[], pred: boolean): void {
    if (pred || !(this.decoded || (this.config.spyglass && this.whole))) return;
    const value = node.value;
    if (value.kind !== "Compound") return;
    for (const [f] of fields) {
      if (f.kind === "Pair" && f.key.kind === "Name" && !f.optional) {
        const key = f.key.name;
        if (!value.entries.some((e) => e.key === key)) {
          emit(out, node.start, node.end, "Error", "nbtMissingKey", `Missing key ${quoted(key)}`);
        }
      }
    }
  }

  /** `validateNbtNodeType`. Returns whether the tag matches loosely, so that its content is checked. */
  private checkType(out: Sink, node: NbtNode, expected: NbtKind, pred: boolean): boolean {
    const actual = node.value.kind;
    if (this.modify && isNumberKind(actual) && isNumberKind(expected)) return true;
    const strictly = actual === expected;
    const loosely = strictly || (actual === "Int" && (expected === "Byte" || expected === "Short" || expected === "Long" || expected === "Float" || expected === "Double"));
    // `NbtOps` reads any number as a number, and a list or an array as a list.
    const shape = (k: NbtKind): number => (isNumberKind(k) ? 0 : k === "String" ? 1 : k === "Compound" ? 2 : 3);
    if (this.decoded && shape(actual) !== shape(expected)) {
      emit(out, node.start, node.end, "Error", "nbtTypeCheck", `Expected ${articleName(expected)} but got ${articleName(actual)}`);
      return false;
    }
    if (!loosely || ((pred || this.rules.typeStrict) && !strictly)) {
      const message = `Expected ${articleName(expected)} but got ${articleName(actual)} (rule: ${quoted("nbtTypeCheck")})`;
      emit(out, node.start, node.end, this.rules.typeSeverity, "nbtTypeCheck", message);
    }
    return loosely;
  }

  private checkBoolean(out: Sink, node: NbtNode): void {
    if (this.rules.boolean === undefined) return;
    const [severity, expected] = this.rules.boolean;
    const value = node.value;
    const literal = value.kind === "Byte" ? value.rawBool : undefined;
    const differs = typeof expected === "boolean" ? (literal !== undefined) !== expected : true;
    if (!differs) return;
    let message: string;
    if (truthy(expected)) {
      message = `Expected ${joinOr(["false", "true"])}`;
    } else {
      const actual = literal === true ? "true" : literal === false ? "false" : (numberOf(value)?.[1] ?? "");
      message = `Expected a byte tag but got ${quoted(actual)}`;
    }
    emit(out, node.start, node.end, severity, "nbtBoolean", message);
  }

  /** A number out of the schema's range: DHP's warning, or the modified Spyglass's error. DHP's
   * message gives both ends; an end the schema leaves open is the end of the number kind. */
  private checkNumber(out: Sink, node: NbtNode, kind: NumKind, range: Range | undefined): void {
    if (range === undefined) return;
    const number = numberOf(node.value);
    if (number === undefined) return;
    const [value, text] = number;
    if (numWithin(value, range)) return;
    if (this.config.spyglass) {
      emit(out, node.start, node.end, "Error", "nbtNumberRange", `Expected numeric value to be ${spyglassRange(range)}`);
    } else {
      const [lo, hi] = numKindBounds(kind) ?? [-Infinity, Infinity];
      const message = `Expected a number between ${String(range.min ?? lo)} and ${String(range.max ?? hi)} but got ${text}`;
      emit(out, node.start, node.end, "Warning", "nbtNumberRange", message);
    }
  }

  private arrayField(out: Sink, node: NbtNode, kind: NumKind, length: Range | undefined, values: Range | undefined, pred: boolean): void {
    if (!this.checkType(out, node, arrayKind(kind), pred)) return;
    const value = node.value;
    if (value.kind !== "ByteArray" && value.kind !== "IntArray" && value.kind !== "LongArray") return;
    if (length !== undefined) this.checkLength(out, node, length, value.items.length, this.rules.arrayLength, "nbtArrayLengthCheck");
    for (const item of value.items) this.checkNumber(out, item, kind, values);
  }

  private checkLength(out: Sink, node: NbtNode, range: Range, len: number, severity: Severity | undefined, rule: string): void {
    if (severity === undefined) return;
    if (rangeContains(range, len)) return;
    const expected =
      range.min === range.max
        ? `a collection with length ${jsBound(range.min)}`
        : `a collection with length between ${jsBound(range.min)} and ${jsBound(range.max)}`;
    emit(out, node.start, node.end, severity, rule, `Expected ${expected} (rule: ${quoted(rule)})`);
  }

  /** An enum or a literal: a string unless `num` gives the kind of its numbers. */
  private enumField(out: Sink, node: NbtNode, values: readonly Lit[], num: NumKind | undefined, id: boolean, pred: boolean): void {
    const first = values[0];
    let kind: NbtKind;
    if (num !== undefined) kind = num;
    else if (first?.kind === "Num") kind = node.value.kind;
    else if (first?.kind === "Bool") kind = "Byte";
    else kind = "String";
    if (!this.checkType(out, node, kind, pred)) return;
    const value = node.value;
    const actual = value.kind === "String" ? value.value : (numberOf(value)?.[1] ?? "");
    const texts = values.map(litText);
    if (!texts.some((t) => sameString(t, actual, id))) {
      emit(out, node.start, node.end, "Warning", "nbtEnum", `Expected ${joinOr(texts)} but got ${quoted(actual)}`);
    }
  }

  private stringField(out: Sink, node: NbtNode, holds: Holds | undefined, pred: boolean): void {
    if (!this.checkType(out, node, "String", pred)) return;
    const value = node.value;
    if (value.kind !== "String") return;
    if (value.quote !== undefined && value.value !== "") {
      this.stringQuote(out, node, value.value, value.quote);
      if (holds !== undefined) this.innerString(out, node, value.value, holds);
    } else if (value.quote === undefined && this.config.spyglass) {
      // DHP checks quoted strings only; the modified Spyglass checks every string field.
      this.stringQuote(out, node, value.value, undefined);
    }
  }

  private stringQuote(out: Sink, node: NbtNode, value: string, quote: string | undefined): void {
    this.quoteProblems(out, this.rules.stringQuote, quote, value, node.start, node.end);
  }

  /** `validateInnerString`: a string that holds another argument. Commands are not checked. */
  private innerString(out: Sink, node: NbtNode, value: string, holds: Holds): void {
    // Offsets are exact only when the source between the quotes is the value itself.
    const exact = node.end - node.start === value.length + 2;
    const base = exact ? node.start + 1 : node.start;
    const effects: Effect[] = [];
    const cx = new ArgCtx(this.data, this.config, effects, "", [], []);
    const r = new Reader(value, base);
    let result: PResult<void>;
    switch (holds) {
      case "Tag":
      case "Team": {
        const name = r.readUnquoted();
        const s = r.offsetOf(0);
        const e = r.offset();
        if (holds === "Tag") {
          cx.referenceName(kinds.ENTITY_TAG, name, s, e);
          cx.naming("nameOfTags", "tag", name, s, e);
        } else {
          cx.referenceName(kinds.TEAM, name, s, e);
          cx.naming("nameOfTeams", "team", name, s, e);
        }
        result = undefined;
        break;
      }
      case "Text":
        result = this.decoded && !modern(this.data) ? text.lenientComponent(r, cx) : text.component(r, cx);
        break;
      case "BlockPredicate":
        result = blockitem.blockState(r, cx, true);
        break;
      case "Particle":
        result = blockitem.particle(r, cx);
        break;
      case "Command":
      case "Objective":
        return;
    }
    if (result instanceof ParseError) {
      effects.push({ kind: "Diag", diag: { start: result.start, end: result.end, severity: result.severity, code: "syntax", message: result.message } });
    }
    if (!exact) {
      for (const effect of effects) {
        const range = effect.kind === "Diag" ? effect.diag : effect.kind === "Def" ? effect.def : effect.ref;
        range.start = node.start;
        range.end = node.end;
      }
    }
    extend(out, effects);
  }

  private idField(out: Sink, node: NbtNode, attr: IdAttr, pred: boolean): void {
    if (!this.checkType(out, node, "String", pred)) return;
    const value = node.value;
    if (value.kind !== "String") return;
    if (value.value === "") return;
    this.checkIdentity(out, node, value.value, value.quote !== undefined, attr);
    this.stringQuote(out, node, value.value, value.quote);
  }

  /** `IdentityArgumentParser` over the string of an id tag. */
  private checkIdentity(out: Sink, node: NbtNode, value: string, quotedInSource: boolean, attr: IdAttr): void {
    // The offsets inside the string are file offsets only when the source has no escapes.
    const exact = !/[\\"']/.test(value);
    const base = node.start + (quotedInSource ? 1 : 0);
    const span = (a: number, b: number): [number, number] => (exact ? [base + a, base + b] : [node.start, node.end]);
    const problems: [number, number, Severity, string, string][] = [];

    let pos = 0;
    const isTag = value.startsWith("#");
    const tagsAllowed = attr.tags === "Allowed" || attr.tags === "Required";
    if (isTag) {
      pos = 1;
      if (!tagsAllowed) problems.push([0, 1, "Error", "nbtIdentity", "Tags are not allowed here"]);
    }
    const readPart = (): string => {
      const start = pos;
      while (pos < value.length) {
        const c = value[pos]!;
        if (!(isAsciiAlphanumeric(c) || c === "_" || c === "-" || c === "." || c === "+")) break;
        pos += 1;
      }
      const part = value.slice(start, pos);
      if (!/^[a-z0-9/._-]*$/.test(part)) {
        problems.push([start, pos, "Error", "nbtIdentity", "Found non [a-z0-9/._-] character(s)"]);
      }
      return part;
    };
    const first = readPart();
    let namespace: string | undefined;
    const paths: string[] = [];
    if (value[pos] === ":") {
      pos += 1;
      paths.push(readPart());
      namespace = first;
    } else {
      paths.push(first);
    }
    while (value[pos] === "/") {
      pos += 1;
      paths.push(readPart());
    }
    const reg = attr.registry !== undefined && !attr.definition && attr.path === undefined && (!isTag || tagsAllowed) ? attr.registry : undefined;
    if (pos === 0 || (isTag && pos === 1)) {
      const firstChar = charAt(value, 0)?.length ?? 1;
      problems.push([0, firstChar, "Error", "nbtIdentity", "Expected a namespaced ID but got nothing"]);
    } else if (reg !== undefined) {
      const raw = `${namespace !== undefined && namespace !== "" ? namespace : "minecraft"}:${paths.join("/")}`;
      const [start, end] = span(isTag ? 1 : 0, pos);
      const tag = isTag || attr.tags === "Implicit";
      const fileKind = this.data.fileKind(tag ? `tag/${reg}` : reg);
      if (fileKind !== undefined) {
        if (!this.data.vanillaJsonHas(fileKind, raw)) out.push({ kind: "Ref", ref: { kind: fileKind, id: raw, start, end } });
      } else if (!tag) {
        const identity = `minecraft:${reg}`;
        const problem = this.registryProblem(identity, raw);
        if (problem !== undefined) {
          const [severity, rule] = problem;
          const message = `Failed to resolve namespaced ID ${quoted(raw)} in registry ${quoted(identity)} (rule: ${quoted(rule)})`;
          problems.push([0, pos, severity, rule, message]);
        }
      }
    }
    for (const [a, b, severity, code, message] of problems) {
      const [start, end] = span(a, b);
      emit(out, start, end, severity, code, message);
    }
  }

  /** The severity and rule when `id` is not in the registry and the `strict*Check` rule asks for it. */
  private registryProblem(reg: string, id: string): [Severity, string] | undefined {
    // DHP's switch knows the old name `minecraft:motive`, not `minecraft:painting_variant`.
    if (reg === "minecraft:painting_variant" || !this.data.registries.has(reg)) return undefined;
    const rule = registryRule(reg);
    if (rule === undefined) return undefined;
    const found = this.config.rule(rule);
    if (found === undefined) return undefined;
    const [severity, value] = found;
    const mode = asStr(value);
    if (mode === undefined) return undefined;
    let checks: boolean;
    switch (mode) {
      case "always":
        checks = true;
        break;
      case "only-default-namespace":
        checks = id.startsWith("minecraft:");
        break;
      default:
        checks = false;
    }
    return checks && !this.data.registryHas(reg, id) ? [severity, rule] : undefined;
  }

  // ---- NbtPathArgumentParser ----

  /** The types at the end of `steps` from the alternatives `root`. `undefined` where the schema
   * ends or allows any tag. */
  pathEnd(steps: readonly Step[], root: readonly Alt[]): Typed[] | undefined {
    let alts = root;
    let types: Typed[] | undefined;
    for (const step of steps) {
      const current = schema(alts);
      if (current === undefined) return undefined;
      let next: Typed[];
      switch (step.kind) {
        case "Key":
          next = this.fields(current, step.name);
          break;
        case "Filter":
          continue;
        case "Index":
          next = this.altElements(current, undefined);
          break;
      }
      if (next.length === 0) return undefined;
      alts = next.flatMap(([t, s]) => this.r.resolve(t, s, [], false, 0));
      types = next;
    }
    return types;
  }

  /** `parseSpecifiedTypes` for the steps from here on. `types` is the schema at this position,
   * `undefined` outside it. Where the schema allows several types, a step that any of them takes is
   * accepted. */
  walk(out: Sink, steps: readonly Step[], types: Typed[] | undefined): void {
    let current = types;
    for (let i = 0; i < steps.length; i++) current = this.step(out, steps[i]!, steps[i + 1], current);
  }

  private step(out: Sink, step: Step, next: Step | undefined, types: Typed[] | undefined): Typed[] | undefined {
    const resolved = (types ?? []).flatMap(([t, s]) => this.r.resolve(t, s, [], false, 0));
    const alts = schema(resolved);
    const compound = alts?.some((x) => x.kind === "Struct") ?? false;
    switch (step.kind) {
      case "Key": {
        this.quoteProblems(out, this.rules.pathQuote, step.quote, step.name, step.start, step.end);
        if (alts === undefined) return undefined;
        if (!compound) {
          emit(out, step.start, step.end, "Warning", "nbtPathKey", "Keys are only used for compound tags");
          return undefined;
        }
        const found = this.fields(alts, step.name);
        const open = alts.some((x) => x.kind === "Struct" && x.open);
        if (found.length === 0 && !open) {
          emit(out, step.start, step.end, "Warning", "nbtUnknownKey", `Unknown key ${quoted(step.name)}`);
        }
        return found.length !== 0 ? found : undefined;
      }
      case "Filter": {
        if (alts !== undefined && !compound) {
          emit(out, step.node.start, step.node.start + 1, "Warning", "nbtPathFilter", "Compound filters are only used for compound tags");
        }
        this.checkFilter(out, step.node, compound ? (types ?? []) : []);
        return types;
      }
      case "Index": {
        const elements = alts !== undefined ? this.altElements(alts, undefined) : [];
        const isList = elements.length !== 0;
        const isArray = alts?.some((x) => x.kind === "Leaf" && x.ty.kind === "Array") ?? false;
        if (alts !== undefined && !(isList || isArray)) {
          emit(out, step.start, step.start + 1, "Warning", "nbtPathIndex", "Indices are only used for lists/arrays tags");
        }
        const sub = (at: number): void => {
          emit(out, at, at + 1, "Warning", "nbtPathSub", "The current tag doesn't have extra items");
        };
        if (step.filter !== undefined) {
          if (alts !== undefined && !isList) sub(step.filter.start);
          this.checkFilter(out, step.filter, elements);
        }
        if (alts !== undefined && !isList && next !== undefined && stepStart(next) > step.end) sub(step.end);
        return isList ? elements : undefined;
      }
    }
  }

  /** A `{...}` filter of a path is a predicate on the compound there, whose own keys pick its type. */
  private checkFilter(out: Sink, node: NbtNode, types: readonly Typed[]): void {
    const stack: Stack = [[new NbtTree(node), undefined]];
    const alts = types.flatMap(([t, s]) => this.r.resolve(t, s, stack, false, 0));
    const structs = alts.filter((a) => a.kind === "Struct" || a.kind === "Any");
    this.checkRoot(out, stack, structs, true);
  }
}

/** `at least 0 and at most 59` as the modified Spyglass words a range. */
function spyglassRange(r: Range): string {
  const lower = r.min === undefined ? undefined : `${r.minExclusive ? "above" : "at least"} ${String(r.min)}`;
  const upper = r.max === undefined ? undefined : `${r.maxExclusive ? "below" : "at most"} ${String(r.max)}`;
  if (lower !== undefined && upper !== undefined) return `${lower} and ${upper}`;
  return lower ?? upper ?? "";
}

function litText(lit: Lit): string {
  switch (lit.kind) {
    case "Bool":
      return String(lit.value);
    case "Num":
      return String(lit.value);
    case "Str":
      return lit.value;
  }
}

function conventionLabel(v: JsonValue): string {
  if (typeof v === "string") return v;
  if (typeof v === "object" && v !== null && !Array.isArray(v)) return asStr(get(v, "label")) ?? "";
  return "";
}

/** A path node as DHP's parser takes it: a key, a `{...}` filter, or an index. */
export type Step =
  | { kind: "Key"; name: string; quote: string | undefined; start: number; end: number }
  | { kind: "Filter"; node: NbtNode }
  | { kind: "Index"; start: number; end: number; filter: NbtNode | undefined };

function stepStart(step: Step): number {
  return step.kind === "Filter" ? step.node.start : step.start;
}

export function steps(nodes: readonly NbtPathNode[]): Step[] {
  const out: Step[] = [];
  for (const node of nodes) {
    switch (node.kind) {
      case "MatchRoot":
        out.push({ kind: "Filter", node: node.node });
        break;
      case "Key":
        out.push({ kind: "Key", name: node.name, quote: node.quote, start: node.start, end: node.end });
        if (node.filter !== undefined) out.push({ kind: "Filter", node: node.filter });
        break;
      case "Index":
      case "AllElements":
        out.push({ kind: "Index", start: node.start, end: node.end, filter: undefined });
        break;
      case "MatchElement":
        out.push({ kind: "Index", start: node.node.start - 1, end: node.node.end + 1, filter: node.node });
        break;
    }
  }
  return out;
}
