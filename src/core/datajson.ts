// Data pack JSON files (advancements, predicates, loot tables, tags, ...) checked against the
// vanilla-mcdoc schema the way the mcdoc checker of the modified Spyglass does
// (`packages/mcdoc/src/runtime/checker`): a value its type cannot hold is an error, a key the
// type does not know a warning, and ids are resolved against the registries and the project.
// Where the schema cannot be followed (an unknown reference or dispatcher key), the value is
// accepted.

import { charCount, compareStr } from "./chars.ts";
import { DIMENSIONS, type VersionData } from "./data.ts";
import { type Diagnostic, ParseError, type Severity } from "./diag.ts";
import { type Kind, type Ref, fullId, kind as kinds } from "./facts.ts";
import { type Node, type Reading, parseDocument, parsePartial } from "./json.ts";
import {
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
  type Ty,
  cloneTy,
  defaultIdAttr,
  idShape,
  numKindBounds,
  numKindName,
  rangeContains,
  rangeDescribe,
  sameString,
  stripMinecraft,
  type Tree,
} from "./mcdoc.ts";
import { f64ToI64, fmtF64 } from "./numbers.ts";

/** The schema of a data pack JSON file of this kind, if the schema covers it. */
export function schema(kind: Kind, doc: McDoc): Ty | undefined {
  if (kind.startsWith("tag/")) {
    const entry: IdAttr = { ...defaultIdAttr(), registry: kind.slice("tag/".length), tags: "Allowed" };
    const string: Ty = { kind: "String", len: undefined, id: entry, holds: undefined };
    return { kind: "Concrete", child: { kind: "Reference", path: "::java::data::tag::Tag" }, args: [string] };
  }
  const found = doc.dispatchers.get("minecraft:resource")?.get(kind);
  return found === undefined ? undefined : cloneTy(found);
}

export interface Checked {
  diags: Diagnostic[];
  /** Ids of project resources and tags, for the project to resolve. */
  refs: Ref[];
}

export function reading(kind: Kind): Reading {
  switch (kind) {
    case kinds.ADVANCEMENT:
    case kinds.LOOT_TABLE:
    case kinds.PREDICATE:
    case kinds.ITEM_MODIFIER:
    case kinds.RECIPE:
      return "Strict";
    default:
      return "Lenient";
  }
}

export function check(text: string, reading: Reading, schema: Ty, doc: McDoc, data: VersionData): Checked {
  const node = parseDocument(text, reading);
  if (node instanceof ParseError) {
    const diag: Diagnostic = { start: node.start, end: node.end, severity: "Error", code: "jsonSyntax", message: node.message };
    return { diags: [diag], refs: [] };
  }
  const checker = new Checker(doc, data, text, CheckLimit.forNodes(nodeCount(node)));
  return checked(checker, node, schema);
}

export function checked(checker: Checker, node: Node, schema: Ty): Checked {
  const stack: Stack = [[new NodeTree(node), undefined]];
  const out = checker.value(stack, schema, checker.r.empty);
  if (checker.limit.reached()) out.problem(span(node), "Warning", "jsonCheckLimit", CHECK_LIMIT_MESSAGE);
  return { diags: out.problems, refs: out.refs };
}

function nodeCount(root: Node): number {
  let nodes = 0;
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    nodes += 1;
    switch (node.json.kind) {
      case "Array":
        for (const item of node.json.items) pending.push(item);
        break;
      case "Object":
        for (const [, member] of node.json.fields) pending.push(member);
        break;
      default:
    }
  }
  return nodes;
}

class Out {
  problems: Diagnostic[] = [];
  refs: Ref[] = [];

  errors(): number {
    let n = 0;
    for (const p of this.problems) {
      if (p.severity === "Error") n += 1;
    }
    return n;
  }

  add(other: Out): void {
    for (const p of other.problems) this.problems.push(p);
    for (const r of other.refs) this.refs.push(r);
  }

  problem([start, end]: readonly [number, number], severity: Severity, code: string, message: string): void {
    this.problems.push({ start, end, severity, code, message });
  }
}

/** A JSON value as the `Tree` that the dispatcher indexes of the schema read. */
class NodeTree implements Tree {
  readonly node: Node;

  constructor(node: Node) {
    this.node = node;
  }

  field(name: string): NodeTree | undefined {
    const json = this.node.json;
    if (json.kind !== "Object") return undefined;
    const member = lastMember(json.fields, name);
    return member === undefined ? undefined : new NodeTree(member);
  }

  string(): string | undefined {
    return this.node.json.kind === "Str" ? this.node.json.value : undefined;
  }
}

function lastMember(members: readonly (readonly [string, Node])[], name: string): Node | undefined {
  for (let i = members.length - 1; i >= 0; i--) {
    const [key, value] = members[i]!;
    if (key === name) return value;
  }
  return undefined;
}

/** The JSON values from the root to the one being checked, each with its key in its object. */
type Stack = [NodeTree, string | undefined][];

function top(stack: Path<NodeTree>): Node {
  return stack[stack.length - 1]![0].node;
}

/** The symbol that a string naming an objective, a team, or an entity tag references. */
function symbolKind(holds: Holds | undefined): Kind | undefined {
  switch (holds) {
    case "Objective":
      return kinds.OBJECTIVE;
    case "Team":
      return kinds.TEAM;
    case "Tag":
      return kinds.ENTITY_TAG;
    default:
      return undefined;
  }
}

/** A container is marked at its first character; a long span adds nothing. */
function span(node: Node): [number, number] {
  switch (node.json.kind) {
    case "Array":
    case "Object":
      return [node.start, node.start + 1];
    default:
      return [node.start, node.end];
  }
}

type MemoTable = Map<Ty, Map<Scope, Map<Node, Out>>>;

/** Results of one depth, found by type, scope, and value (compared by reference), and by whether
 * NBT is being checked. */
class Memo {
  private readonly byNbt: [MemoTable, MemoTable] = [new Map(), new Map()];

  get(node: Node, ty: Ty, scope: Scope, nbt: boolean): Out | undefined {
    return this.byNbt[nbt ? 1 : 0].get(ty)?.get(scope)?.get(node);
  }

  set(node: Node, ty: Ty, scope: Scope, nbt: boolean, out: Out): void {
    const table = this.byNbt[nbt ? 1 : 0];
    let scopes = table.get(ty);
    if (scopes === undefined) {
      scopes = new Map();
      table.set(ty, scopes);
    }
    let nodes = scopes.get(scope);
    if (nodes === undefined) {
      nodes = new Map();
      scopes.set(scope, nodes);
    }
    nodes.set(node, out);
  }
}

export class Checker {
  readonly r: Resolver;
  readonly limit: CheckLimit;
  private readonly data: VersionData;
  private readonly text: string;
  /** How many structs that are NBT are being checked. */
  private nbt = 0;
  private readonly checked: Memo[] = [];

  constructor(doc: McDoc, data: VersionData, text: string, limit: CheckLimit = new CheckLimit(Infinity)) {
    this.r = new Resolver(doc);
    this.data = data;
    this.text = text;
    this.limit = limit;
  }

  private insideQuotes([start, end]: readonly [number, number]): [number, number] {
    const c = this.text[start];
    return c === '"' || c === "'" ? [start + 1, Math.max(Math.max(end - 1, 0), start + 1)] : [start, end];
  }

  /** The result is shared with the memo; callers read it and do not change it. */
  value(stack: Stack, ty: Ty, scope: Scope): Out {
    const node = top(stack);
    const depth = stack.length;
    const nbt = this.nbt > 0;
    const known = this.checked[depth]?.get(node, ty, scope, nbt);
    if (known !== undefined) return known;
    if (!this.limit.take()) return new Out();
    const alts = this.r.resolve(ty, scope, stack, false, 0);
    const out = this.alternatives(stack, alts);
    // ponytail: keeps the results one level below the value, so types that differ between two alternatives and meet again further down are checked once per alternative; keep more levels if a schema nests that way
    if (this.checked.length > depth + 2) this.checked.length = depth + 2;
    while (this.checked.length < depth + 2) this.checked.push(new Memo());
    this.checked[depth]!.set(node, ty, scope, nbt, out);
    return out;
  }

  private alternatives(stack: Stack, alts: readonly Alt[]): Out {
    const node = top(stack);
    if (alts.length === 0 || alts.some((a) => a.kind === "Any")) return new Out();
    const nbt = this.nbt > 0;
    const fitting = alts.filter((a) => fits(a, node, nbt));
    if (fitting.length === 0) {
      const out = new Out();
      out.problem(span(node), "Error", "jsonType", `Expected ${expected(alts)}`);
      return out;
    }
    if (fitting.length === 1) return this.alternative(stack, fitting[0]!);
    let best: Out | undefined;
    let bestErrors = 0;
    for (const a of fitting) {
      const out = this.alternative(stack, a);
      const errors = out.errors();
      if (best === undefined || errors < bestErrors || (errors === bestErrors && out.problems.length < best.problems.length)) {
        best = out;
        bestErrors = errors;
      }
    }
    return best ?? new Out();
  }

  /** Checks a value against one alternative whose shape it fits. */
  private alternative(stack: Stack, alt: Alt): Out {
    const node = top(stack);
    const json = node.json;
    const out = new Out();
    if (alt.kind === "Struct") {
      if (json.kind === "Object") {
        const nbt = alt.nbt ? 1 : 0;
        this.nbt += nbt;
        this.object(stack, node, json.fields, alt.fields, alt.open, out);
        this.nbt -= nbt;
      }
    } else if (alt.kind === "Leaf") {
      const { ty, scope, outer } = alt;
      if (ty.kind === "String" && json.kind === "Str") {
        const { len, id, holds } = ty;
        const s = json.value;
        if (len !== undefined && !rangeContains(len, charCount(s))) {
          out.problem(span(node), "Error", "jsonRange", `Expected a string of length ${rangeDescribe(len)}`);
        }
        const valueSpan = this.insideQuotes([node.start, node.end]);
        const attr = id ?? outer;
        if (attr !== undefined) this.id(s, attr, valueSpan, !optionalTagEntry(stack), out);
        const kind = symbolKind(holds);
        if (kind !== undefined) out.refs.push({ kind, id: s, start: valueSpan[0], end: valueSpan[1] });
      } else if (ty.kind === "Number" && json.kind === "Num") {
        number(ty.numKind, ty.range, json.value, node, out);
      } else if (ty.kind === "List" && json.kind === "Array") {
        collectionLength(ty.len, json.items.length, node, out);
        for (const itemNode of json.items) {
          stack.push([new NodeTree(itemNode), undefined]);
          out.add(this.value(stack, ty.item, scope));
          stack.pop();
        }
      } else if (ty.kind === "Array" && json.kind === "Array") {
        collectionLength(ty.len, json.items.length, node, out);
        for (const itemNode of json.items) {
          if (itemNode.json.kind === "Num") number(ty.numKind, ty.range, itemNode.json.value, itemNode, out);
          else out.problem(span(itemNode), "Error", "jsonType", `Expected a ${numKindName(ty.numKind)}`);
        }
      } else if (ty.kind === "Tuple" && json.kind === "Array") {
        const types = ty.items;
        json.items.forEach((itemNode, i) => {
          const t = types[i];
          if (t !== undefined) {
            stack.push([new NodeTree(itemNode), undefined]);
            out.add(this.value(stack, t, scope));
            stack.pop();
          } else {
            out.problem(span(itemNode), "Error", "jsonType", "Expected nothing");
          }
        });
        if (json.items.length < types.length) {
          out.problem(span(node), "Error", "jsonRange", `Expected a list of length ${types.length}`);
        }
      }
    }
    return out;
  }

  private object(
    stack: Stack,
    node: Node,
    members: readonly (readonly [string, Node])[],
    fields: readonly (readonly [Field, Scope])[],
    open: boolean,
    out: Out,
  ): void {
    const seen = new Set<string>();
    for (const [name, value] of members) {
      const keySpan: readonly [number, number] = value.key ?? [value.start, value.start];
      if (seen.has(name)) {
        out.problem(keySpan, "Warning", "jsonDuplicateKey", `Duplicate key “${name}”; the last one is used`);
      } else {
        seen.add(name);
      }
      const found = this.r.field(fields, name, stack);
      if (found !== undefined) {
        const [ty, scope, keyType] = found;
        const kind = keyType === undefined ? undefined : symbolKind(this.r.holds(keyType, scope, stack, true));
        if (kind !== undefined) {
          const [start, end] = this.insideQuotes(keySpan);
          out.refs.push({ kind, id: name, start, end });
        }
        stack.push([new NodeTree(value), name]);
        out.add(this.value(stack, ty, scope));
        stack.pop();
      } else if (!open) {
        out.problem(keySpan, "Warning", "jsonUnknownKey", `Unknown key “${name}”`);
      }
    }
    for (const [f] of fields) {
      if (f.kind === "Pair" && f.key.kind === "Name" && !f.optional) {
        const n = f.key.name;
        if (!members.some(([m]) => m === n)) out.problem(span(node), "Error", "jsonMissingKey", `Missing key “${n}”`);
      }
    }
  }

  /** Checks a resource location; `resolve`: whether it must exist. */
  private id(value: string, attr: IdAttr, span: readonly [number, number], resolve: boolean, out: Out): void {
    const shape = idShape(value, attr);
    if (!shape.ok) {
      out.problem(span, "Error", "jsonId", shape.error);
      return;
    }
    if (shape.value === undefined) return;
    const [isTag, raw] = shape.value;
    const registry = attr.registry;
    if (registry === undefined) return;
    if (attr.definition || attr.path !== undefined || !resolve) return;
    const id = fullId(raw);
    if (attr.exclude.some((e) => fullId(e) === id)) out.problem(span, "Warning", "jsonId", `“${id}” is not allowed here`);
    const [start, end] = span;
    if (isTag || attr.tags === "Implicit") {
      const kind = this.data.fileKind(`tag/${registry}`);
      if (kind !== undefined) out.refs.push({ kind, id, start, end });
      return;
    }
    const kind = this.data.fileKind(registry);
    if (kind !== undefined) {
      out.refs.push({ kind, id, start, end });
    } else if (
      id.startsWith("minecraft:") &&
      this.data.registries.has(`minecraft:${registry}`) &&
      !this.data.registryHas(`minecraft:${registry}`, id)
    ) {
      out.problem(span, "Error", "undeclaredSymbol", `Cannot find ${registry} “${id}”`);
    }
  }

  /** The alternatives of the value on top of `stack`, following the schema from the root
   * through each key and list element on the way. */
  along(schema: Ty, stack: Path<NodeTree>): Alt[] {
    let alts = this.r.resolve(schema, this.r.empty, stack.slice(0, 1), false, 0);
    for (let i = 1; i < stack.length; i++) {
      const [node, key] = stack[i]!;
      const next: [Ty, Scope][] = [];
      for (const alt of alts) {
        if (alt.kind === "Any") return [{ kind: "Any" }];
        if (alt.kind === "Struct") {
          if (key === undefined) continue;
          const found = this.r.field(alt.fields, key, stack.slice(0, i));
          if (found !== undefined) next.push([found[0], found[1]]);
          else if (alt.open) return [{ kind: "Any" }];
        } else if (key === undefined) {
          if (alt.ty.kind === "List") {
            next.push([alt.ty.item, alt.scope]);
          } else if (alt.ty.kind === "Tuple") {
            const siblings = stack[i - 1]![0].node.json;
            if (siblings.kind === "Array") {
              const t = alt.ty.items[siblings.items.indexOf(node.node)];
              if (t !== undefined) next.push([t, alt.scope]);
            }
          }
        }
      }
      const upTo = stack.slice(0, i + 1);
      alts = next.flatMap(([t, s]) => this.r.resolve(t, s, upTo, false, 0));
    }
    return alts;
  }

  /** The values an alternative offers: literal text and whether it is written as a string. */
  values(alt: Alt, projectIds: ProjectIds): [string, boolean][] {
    if (alt.kind !== "Leaf") return [];
    const ty = alt.ty;
    switch (ty.kind) {
      case "Boolean":
        return [
          ["true", false],
          ["false", false],
        ];
      case "Literal":
        return [litText(ty.value)];
      case "Enum":
        return ty.values.map((v) => litText(v));
      case "String": {
        const attr = ty.id ?? alt.outer;
        return attr === undefined ? [] : this.ids(attr, projectIds).map((s): [string, boolean] => [s, true]);
      }
      default:
        return [];
    }
  }

  ids(attr: IdAttr, projectIds: ProjectIds): string[] {
    const registry = attr.registry;
    if (registry === undefined) return [];
    const out: string[] = [];
    if (attr.tags !== "Required" && attr.tags !== "Implicit") {
      const kind = this.data.fileKind(registry);
      if (kind !== undefined) {
        for (const id of projectIds(kind)) out.push(id);
        for (const id of this.data.vanillaJson(kind) ?? []) out.push(id);
        if (kind === kinds.DIMENSION) {
          for (const id of DIMENSIONS) out.push(id);
        }
      } else {
        for (const id of this.data.registries.get(`minecraft:${registry}`) ?? []) out.push(id);
      }
    }
    if (attr.tags !== "No") {
      const kind = this.data.fileKind(`tag/${registry}`);
      if (kind !== undefined) {
        const prefix = attr.tags === "Implicit" ? "" : "#";
        for (const t of projectIds(kind)) out.push(prefix + t);
        for (const t of this.data.vanillaJson(kind) ?? []) out.push(prefix + t);
      }
    }
    out.sort(compareStr);
    return out.filter((id, i) => i === 0 || id !== out[i - 1]);
  }
}

/** The `id` of a tag entry written `{"id": ..., "required": false}`, which the game skips when it is missing. */
function optionalTagEntry(stack: Path<NodeTree>): boolean {
  if (stack.length < 2 || stack[stack.length - 1]![1] !== "id") return false;
  return !tagEntryRequired(stack[stack.length - 2]![0].node);
}

export function tagEntryRequired(entry: Node): boolean {
  if (entry.json.kind !== "Object") return true;
  const json = lastMember(entry.json.fields, "required")?.json;
  if (json?.kind === "Bool") return json.value;
  if (json?.kind === "Num") return BigInt.asIntN(8, f64ToI64(json.value)) !== 0n;
  return true;
}

/** Whether the value has the shape of the alternative (and is its literal or enum value). */
function fits(alt: Alt, node: Node, nbt: boolean): boolean {
  const json = node.json;
  switch (alt.kind) {
    case "Any":
      return true;
    case "Struct":
      return json.kind === "Object";
    case "Leaf": {
      const ty = alt.ty;
      const id = alt.outer !== undefined;
      switch (ty.kind) {
        case "Boolean":
          return json.kind === "Bool" || (json.kind === "Num" && nbt);
        case "String":
          return json.kind === "Str";
        case "Number": {
          if (json.kind !== "Num") return false;
          const bounds = numKindBounds(ty.numKind);
          return bounds === undefined || (bounds[0] <= json.value && json.value <= bounds[1]);
        }
        case "Literal":
          return litMatches(ty.value, json, ty.id || id);
        case "Enum":
          return ty.values.some((v) => litMatches(v, json, ty.id || id));
        case "List":
        case "Array":
        case "Tuple":
          return json.kind === "Array";
        default:
          return false;
      }
    }
  }
}

function litMatches(lit: Lit, json: Node["json"], id: boolean): boolean {
  switch (lit.kind) {
    case "Bool":
      return json.kind === "Bool" && lit.value === json.value;
    case "Num":
      return json.kind === "Num" && lit.value === json.value;
    case "Str":
      return json.kind === "Str" && sameString(lit.value, json.value, id);
  }
}

/** What the alternatives expect, as in "Expected a string or an object". */
function expected(alts: readonly Alt[]): string {
  const names: string[] = [];
  for (const alt of alts) {
    if (alt.kind === "Leaf" && alt.ty.kind === "Enum") {
      for (const v of alt.ty.values) {
        const q = quote(v);
        if (!names.includes(q)) names.push(q);
      }
      continue;
    }
    let name: string;
    switch (alt.kind) {
      case "Any":
        continue;
      case "Struct":
        name = "an object";
        break;
      case "Leaf": {
        const ty = alt.ty;
        switch (ty.kind) {
          case "Boolean":
            name = "a boolean";
            break;
          case "String":
            name = "a string";
            break;
          case "Number": {
            const article = ty.numKind === "Int" ? "an" : "a";
            name = ty.range === undefined ? `${article} ${numKindName(ty.numKind)}` : `${article} ${numKindName(ty.numKind)} in ${rangeDescribe(ty.range)}`;
            break;
          }
          case "Literal":
            name = quote(ty.value);
            break;
          case "List":
          case "Array":
          case "Tuple":
            name = "a list";
            break;
          default:
            continue;
        }
        break;
      }
    }
    if (!names.includes(name)) names.push(name);
  }
  if (names.length === 0) return "nothing";
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

function quote(lit: Lit): string {
  switch (lit.kind) {
    case "Bool":
      return `“${lit.value}”`;
    case "Num":
      return `“${fmtF64(lit.value)}”`;
    case "Str":
      return `“${stripMinecraft(lit.value)}”`;
  }
}

function number(kind: NumKind, range: Range | undefined, v: number, node: Node, out: Out): void {
  const bounds = numKindBounds(kind);
  if (bounds !== undefined && !(bounds[0] <= v && v <= bounds[1])) {
    out.problem(span(node), "Error", "jsonType", `Expected a ${numKindName(kind)}`);
    return;
  }
  if (range !== undefined && !rangeContains(range, v)) {
    out.problem(span(node), "Error", "jsonRange", `Expected a number in ${rangeDescribe(range)}`);
  }
}

function collectionLength(len: Range | undefined, n: number, node: Node, out: Out): void {
  if (len !== undefined && !rangeContains(len, n)) {
    out.problem(span(node), "Error", "jsonRange", `Expected a list of length ${rangeDescribe(len)}`);
  }
}

/** A completion at the cursor of a data pack JSON file. */
export interface Suggestion {
  label: string;
  /** Replaces `start..end`: the label, quoted for a key or a string. */
  insert: string;
  start: number;
  end: number;
  key: boolean;
  detail: string | undefined;
}

/** Where the cursor is: on a key of an object, or on a value (or where one goes). */
type Spot =
  | { kind: "Key"; start: number; end: number; typed: string; present: string[] }
  | { kind: "Value"; start: number; end: number; typed: string }
  /** A new element of the list on top of the stack. */
  | { kind: "Item"; at: number };

/** The ids of the resources of a kind that the project defines. */
export type ProjectIds = (kind: Kind) => string[];

/** The keys and values that fit at `offset`. `projectIds` gives the ids of a kind that the
 * project defines. */
export function complete(text: string, offset: number, schema: Ty, doc: McDoc, data: VersionData, projectIds: ProjectIds): Suggestion[] {
  const root = parsePartial(text);
  const stack: Stack = [[new NodeTree(root), undefined]];
  const spot = locate(text, root, offset, stack);
  if (spot === undefined) return [];
  const checker = new Checker(doc, data, text);
  let alts = checker.along(schema, stack);
  if (spot.kind === "Item") {
    const items: [Ty, Scope][] = [];
    for (const a of alts) {
      if (a.kind === "Leaf" && a.ty.kind === "List") items.push([a.ty.item, a.scope]);
    }
    alts = items.flatMap(([t, s]) => checker.r.resolve(t, s, stack, false, 0));
  }
  const out: Suggestion[] = [];
  const labels = new Set<string>();
  const push = (s: Suggestion): void => {
    if (labels.has(s.label)) return;
    labels.add(s.label);
    out.push(s);
  };
  let valueAt: { start: number; end: number; typed: string } | undefined;
  switch (spot.kind) {
    case "Key": {
      const { start, end, typed, present } = spot;
      const written = (n: string): boolean => present.some((p) => p === n || fullId(p) === fullId(n));
      for (const alt of alts) {
        if (alt.kind !== "Struct") continue;
        for (const [f, scope] of alt.fields) {
          if (f.kind !== "Pair") continue;
          let names: string[];
          if (f.key.kind === "Name") {
            names = [f.key.name];
          } else {
            const t = f.key.ty;
            names = checker.r.keyNames(t, scope, stack);
            for (const resolved of checker.r.resolve(t, scope, stack, true, 0)) {
              if (resolved.kind !== "Leaf" || resolved.ty.kind !== "String") continue;
              const attr = resolved.ty.id ?? resolved.outer;
              if (attr !== undefined) {
                for (const id of checker.ids(attr, projectIds)) names.push(id);
              }
            }
          }
          for (const name of names) {
            if (written(name) || !matchesTyped(name, typed)) continue;
            push({ label: name, insert: `"${name}"`, start, end, key: true, detail: f.desc });
          }
        }
      }
      break;
    }
    case "Value":
      valueAt = { start: spot.start, end: spot.end, typed: spot.typed };
      break;
    case "Item":
      valueAt = { start: spot.at, end: spot.at, typed: "" };
      break;
  }
  if (valueAt !== undefined) {
    const { start, end, typed } = valueAt;
    for (const alt of alts) {
      for (const [label, quoted] of checker.values(alt, projectIds)) {
        if (matchesTyped(label, typed)) {
          push({ label, insert: quoted ? `"${label}"` : label, start, end, key: false, detail: undefined });
        }
      }
    }
  }
  return out;
}

function asciiLowercase(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** Whether a candidate starts with what is typed, ignoring case and a `minecraft:` the user
 * left out. */
function matchesTyped(label: string, typed: string): boolean {
  const l = asciiLowercase(label);
  const t = asciiLowercase(typed);
  return l.startsWith(t) || stripMinecraft(l.replace(/^#+/, "")).startsWith(t.replace(/^#+/, ""));
}

/** Finds what the cursor is on below `node`, the top of `stack`, pushing the values on the way. */
function locate(text: string, node: Node, offset: number, stack: Stack): Spot | undefined {
  const json = node.json;
  let close: string;
  if (json.kind === "Object") close = "}";
  else if (json.kind === "Array") close = "]";
  else return valueSpot(text, node, offset);
  const closed = node.end > node.start + 1 && text[node.end - 1] === close;
  const insideEnd = closed ? node.end - 1 : node.end;
  if (offset <= node.start || offset > insideEnd) return undefined;
  const child = (v: Node): boolean => v.start <= offset && offset <= v.end && (v.start < v.end || v.start === offset);
  if (json.kind === "Object") {
    const fields = json.fields;
    for (const [name, v] of fields) {
      if (v.key === undefined) continue;
      const [ks, ke] = v.key;
      if (ks <= offset && offset <= ke) {
        const typed = text.slice(ks, offset).replace(/^"+/, "");
        const present = fields.filter(([n]) => n !== name).map(([n]) => n);
        return { kind: "Key", start: ks, end: ke, typed, present };
      }
    }
    for (const [name, v] of fields) {
      if (child(v)) {
        stack.push([new NodeTree(v), name]);
        return locate(text, v, offset, stack);
      }
    }
    return { kind: "Key", start: offset, end: offset, typed: "", present: fields.map(([n]) => n) };
  }
  if (json.kind === "Array") {
    for (const v of json.items) {
      if (child(v)) {
        stack.push([new NodeTree(v), undefined]);
        return locate(text, v, offset, stack);
      }
    }
    return { kind: "Item", at: offset };
  }
  return undefined;
}

function valueSpot(text: string, node: Node, offset: number): Spot {
  if (node.start === node.end) return { kind: "Value", start: offset, end: offset, typed: "" };
  const from = text[node.start] === '"' ? node.start + 1 : node.start;
  const to = Math.max(offset, from);
  const typed = to <= text.length ? text.slice(from, to) : "";
  return { kind: "Value", start: node.start, end: node.end, typed };
}

function litText(lit: Lit): [string, boolean] {
  switch (lit.kind) {
    case "Bool":
      return [String(lit.value), false];
    case "Num":
      return [Number.isFinite(lit.value) && lit.value === Math.trunc(lit.value) ? String(f64ToI64(lit.value)) : fmtF64(lit.value), false];
    case "Str":
      return [lit.value, true];
  }
}
