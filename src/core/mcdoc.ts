// The vanilla-mcdoc schema (SpyglassMC/vanilla-mcdoc, MIT) as the `symbols.json` of its
// `generated` branch exports it: the named types and the dispatchers. Struct fields, union
// members, enum values, and dispatcher entries whose `since` / `until` exclude the game
// version are left out while loading. `Resolver` follows the types for a value of data pack
// JSON or NBT.

import { charCount, compareStr } from "./chars.ts";
import { SparkError } from "./diag.ts";
import { fullId } from "./facts.ts";
import { asArray, asBool, asF64, asObject, asStr, asU64, get, sortedEntries, type JsonValue } from "./json-value.ts";
import { fmtF64 } from "./numbers.ts";
import { cmp, parse as parseVersion } from "./version.ts";

export class McDoc {
  readonly types: Map<string, Ty>;
  /** Dispatcher (`minecraft:loot_condition`) to its keys (`random_chance`, `%unknown`). */
  readonly dispatchers: Map<string, Map<string, Ty>>;
  /** Dispatcher to one struct of the fields of all its entries. */
  #merged = new Map<string, Ty>();

  constructor(types: Map<string, Ty>, dispatchers: Map<string, Map<string, Ty>>) {
    this.types = types;
    this.dispatchers = dispatchers;
  }

  static fromJson(root: JsonValue, version: string): McDoc {
    const cx = new Loader(parseVersion(version));
    const typeDefs = asObject(get(root, "mcdoc"));
    if (typeDefs === undefined) throw new SparkError('vanilla-mcdoc symbols: no "mcdoc" map');
    const types = new Map<string, Ty>();
    for (const [path, t] of sortedEntries(typeDefs)) types.set(path, cx.ty(t));
    const dispatcherDefs = asObject(get(root, "mcdoc/dispatcher"));
    if (dispatcherDefs === undefined) throw new SparkError('vanilla-mcdoc symbols: no "mcdoc/dispatcher" map');
    const dispatchers = new Map<string, Map<string, Ty>>();
    for (const [registry, entries] of sortedEntries(dispatcherDefs)) {
      const map = new Map<string, Ty>();
      const defs = asObject(entries);
      if (defs !== undefined) {
        for (const [key, t] of sortedEntries(defs)) {
          if (cx.keep(t)) map.set(key, cx.ty(t));
        }
      }
      dispatchers.set(registry, map);
    }
    const doc = new McDoc(types, dispatchers);
    doc.relax(cx.version);
    const merged = new Map<string, Ty>();
    for (const d of MERGED) merged.set(d, doc.merge(d));
    doc.#merged = merged;
    return doc;
  }

  /** The fields of every entry of a dispatcher in one struct, for data whose id is not known
   * (`data get entity @s`, a path through an item's `tag`). A key that several entries have
   * takes any of their types; all keys are optional. An entry whose type the version does not
   * have adds nothing. */
  merged(dispatcher: string): Ty | undefined {
    return this.#merged.get(dispatcher);
  }

  private merge(dispatcher: string): Ty {
    const r = new Resolver(this);
    const entries = [...(this.dispatchers.get(dispatcher) ?? [])].sort((a, b) => compareStr(a[0], b[0]));
    const fields: Field[] = [];
    const byName = new Map<string, number>();
    const seen = new Set<Field>();
    let open = false;
    for (const [, t] of entries) {
      for (const alt of r.resolve(t, r.empty, [], false, 0)) {
        if (alt.kind !== "Struct") continue;
        open ||= alt.open;
        for (const [f] of alt.fields) {
          if (seen.has(f)) continue;
          seen.add(f);
          if (f.kind === "Pair" && f.key.kind === "Name") {
            const n = f.key.name;
            const i = byName.get(n);
            if (i !== undefined) {
              const target = fields[i]!;
              if (target.kind === "Pair" && target.ty.kind === "Union") target.ty.members.push(cloneTy(f.ty));
            } else {
              byName.set(n, fields.length);
              const ty: Ty = { kind: "Union", members: [cloneTy(f.ty)] };
              fields.push({ kind: "Pair", key: { kind: "Name", name: n }, ty, optional: true, desc: f.desc });
            }
          } else fields.push(cloneField(f));
        }
      }
    }
    if (open) fields.push({ kind: "Spread", ty: { kind: "Any" } });
    return { kind: "Struct", fields };
  }

  /** Fills `mcdoc:block_states` with the properties of the game version's blocks, as Spyglass
   * does from the same summary: block id to its properties and their values. */
  addBlockStates(blocks: ReadonlyMap<string, readonly (readonly [string, readonly string[]])[]>): void {
    let states = this.dispatchers.get("mcdoc:block_states");
    if (states === undefined) {
      states = new Map();
      this.dispatchers.set("mcdoc:block_states", states);
    }
    for (const [id, props] of blocks) {
      if (props.length === 0) continue;
      const fields: Field[] = props.map(([name, values]) => ({
        kind: "Pair",
        key: { kind: "Name", name },
        ty: { kind: "Enum", values: values.map((v): Lit => ({ kind: "Str", value: v })), id: false, num: undefined },
        optional: true,
        desc: undefined,
      }));
      states.set(stripMinecraft(id), { kind: "Struct", fields });
    }
  }

  /** Where the schema is stricter than the game reads data packs, or misses a version. */
  private relax(version: readonly number[]): void {
    // The chest block is dispatched to its block entity only since 1.21.9, where copper chests came.
    if (cmp(version, [1, 21, 9]) < 0) {
      const blocks = this.dispatchers.get("minecraft:block");
      if (blocks !== undefined && !blocks.has("chest")) {
        blocks.set("chest", { kind: "Dispatcher", registry: "minecraft:block_entity", index: [{ kind: "Static", value: "chest" }] });
      }
    }
    if (cmp(version, [1, 20, 5]) < 0) {
      const cloud = this.types.get("::java::world::entity::area_effect_cloud::AreaEffectCloud");
      if (cloud?.kind === "Struct") {
        for (const f of cloud.fields) {
          if (f.kind === "Pair" && f.key.kind === "Name" && f.key.name === "Particle") hold(f.ty, "Particle");
        }
      }
    }
    // Mobs read a leash holder's `UUID` from 1.16 to 1.20.4; the schema has only the older pair.
    const leash = this.types.get("::java::world::entity::mob::UUIDLeash");
    if (leash?.kind === "Struct") {
      const uuid: Ty = { kind: "Array", numKind: "Int", range: undefined, len: { min: 4, max: 4, minExclusive: false, maxExclusive: false } };
      leash.fields.push({ kind: "Pair", key: { kind: "Name", name: "UUID" }, ty: uuid, optional: true, desc: undefined });
    }
    if (cmp(version, [1, 20, 5]) < 0) {
      for (const [path, key] of [
        ["::java::world::entity::mob::breedable::horse::Horse", "ArmorItem"],
        ["::java::world::entity::mob::breedable::horse::Llama", "DecorItem"],
      ] as const) {
        const t = this.types.get(path);
        if (t?.kind === "Struct") {
          const ty: Ty = { kind: "Reference", path: "::java::world::item::ItemStack" };
          t.fields.push({ kind: "Pair", key: { kind: "Name", name: key }, ty, optional: true, desc: undefined });
        }
      }
    }
    if (cmp(version, [1, 20, 5]) < 0) {
      const predicate = this.types.get("::java::data::advancement::predicate::ItemPredicate");
      if (predicate?.kind === "Union") {
        for (const member of predicate.members) {
          if (member.kind !== "Struct") continue;
          let durability: Ty | undefined;
          for (const f of member.fields) {
            if (f.kind === "Pair" && f.key.kind === "Name" && f.key.name === "durability") {
              durability = cloneTy(f.ty);
              break;
            }
          }
          if (durability !== undefined) {
            member.fields.push({ kind: "Pair", key: { kind: "Name", name: "count" }, ty: durability, optional: true, desc: undefined });
          }
        }
      }
    }
    if (cmp(version, [26, 1]) < 0) {
      const serializers = this.dispatchers.get("minecraft:recipe_serializer");
      if (serializers !== undefined) {
        const category: Field = {
          kind: "Pair",
          key: { kind: "Name", name: "category" },
          ty: { kind: "Reference", path: "::java::data::recipe::CraftingBookCategory" },
          optional: true,
          desc: undefined,
        };
        const special = [
          "crafting_special_armordye",
          "crafting_special_bookcloning",
          "crafting_special_mapcloning",
          "crafting_special_mapextending",
          "crafting_special_firework_rocket",
          "crafting_special_firework_star",
          "crafting_special_firework_star_fade",
          "crafting_special_tippedarrow",
          "crafting_special_bannerduplicate",
          "crafting_special_shielddecoration",
          "crafting_special_shulkerboxcoloring",
          "crafting_special_suspiciousstew",
          "crafting_special_repairitem",
          "crafting_decorated_pot",
        ];
        for (const name of special) serializers.set(name, { kind: "Struct", fields: [cloneField(category)] });
      }
    }
    // `DisplayInfo` reads `background` with an optional field codec; the schema requires it on
    // root advancements, where it only picks the texture of the tab.
    const rootDisplay = this.types.get("::java::data::advancement::RootAdvancementDisplay");
    if (rootDisplay?.kind === "Struct") {
      for (const f of rootDisplay.fields) {
        if (f.kind === "Pair" && f.key.kind === "Name" && f.key.name === "background") f.optional = true;
      }
    }
    if (cmp(version, [1, 20, 5]) >= 0 && cmp(version, [1, 21, 2]) < 0) {
      const path = "::java::util::particle::TranslucentParticle";
      const legacy = this.types.get(path);
      if (legacy !== undefined) this.types.set(path, { kind: "Union", members: [legacy, { kind: "Number", numKind: "Int", range: undefined }] });
    }
    if (cmp(version, [26, 1]) >= 0) {
      const sounds = this.types.get("::java::data::variants::wolf::WolfSounds");
      if (sounds?.kind === "Struct" && !sounds.fields.some((f) => f.kind === "Pair" && f.key.kind === "Name" && f.key.name === "step_sound")) {
        const ty: Ty = { kind: "Reference", path: "::java::data::util::SoundEventRef" };
        sounds.fields.push({ kind: "Pair", key: { kind: "Name", name: "step_sound" }, ty, optional: false, desc: undefined });
      }
    }
    if (cmp(version, [26, 3]) >= 0) {
      let transmuted: Ty | undefined;
      const transmute = this.types.get("::java::data::recipe::CraftingTransmute");
      if (transmute?.kind === "Struct") {
        for (const f of transmute.fields) {
          if (f.kind === "Pair" && f.key.kind === "Name" && f.key.name === "result") {
            transmuted = f.ty;
            break;
          }
        }
      }
      const extending = this.types.get("::java::data::recipe::CraftingSpecialMapExtending");
      if (transmuted !== undefined && extending?.kind === "Struct") {
        for (const f of extending.fields) {
          if (f.kind === "Pair" && f.key.kind === "Name" && f.key.name === "result") f.ty = cloneTy(transmuted);
        }
      }
    }
  }
}

/** The dispatchers of NBT whose entries are merged for data whose id is not known. */
const MERGED = ["minecraft:entity", "minecraft:block", "minecraft:item", "minecraft:block_entity"] as const;

export type Ty =
  | { kind: "Any" }
  | { kind: "Boolean" }
  | { kind: "String"; len: Range | undefined; id: IdAttr | undefined; holds: Holds | undefined }
  | { kind: "Number"; numKind: NumKind; range: Range | undefined }
  /** `id`: the value is a resource location, compared with `minecraft:` added. */
  | { kind: "Literal"; value: Lit; id: boolean }
  /** `num`: the kind of a numeric enum; `undefined` for strings. */
  | { kind: "Enum"; values: Lit[]; id: boolean; num: NumKind | undefined }
  | { kind: "Struct"; fields: Field[] }
  | { kind: "List"; item: Ty; len: Range | undefined }
  | { kind: "Array"; numKind: NumKind; range: Range | undefined; len: Range | undefined }
  | { kind: "Tuple"; items: Ty[] }
  | { kind: "Union"; members: Ty[] }
  | { kind: "Reference"; path: string }
  /** A type whose strings are resource locations of `attr` (an `#[id]` on a reference). */
  | { kind: "Id"; attr: IdAttr; child: Ty }
  | { kind: "Dispatcher"; registry: string; index: Index[] }
  | { kind: "Indexed"; child: Ty; index: Index[] }
  | { kind: "Template"; child: Ty; params: string[] }
  | { kind: "Concrete"; child: Ty; args: Ty[] };

/** What a string holds besides text, as an attribute on it says. */
export type Holds = "Tag" | "Team" | "Objective" | "Text" | "BlockPredicate" | "Command" | "Particle";

export type NumKind = "Byte" | "Short" | "Int" | "Long" | "Float" | "Double";

/** The values an integer kind holds; floats hold any number. */
export function numKindBounds(k: NumKind): [number, number] | undefined {
  switch (k) {
    case "Byte":
      return [-128, 127];
    case "Short":
      return [-32768, 32767];
    case "Int":
      return [-2147483648, 2147483647];
    case "Long":
      return [-9223372036854775808, 9223372036854775807];
    case "Float":
    case "Double":
      return undefined;
  }
}

export function numKindName(k: NumKind): string {
  switch (k) {
    case "Byte":
      return "byte";
    case "Short":
      return "short";
    case "Int":
      return "int";
    case "Long":
      return "long";
    case "Float":
      return "float";
    case "Double":
      return "double";
  }
}

export type Lit = { kind: "Bool"; value: boolean } | { kind: "Str"; value: string } | { kind: "Num"; value: number };

export interface Range {
  min: number | undefined;
  max: number | undefined;
  minExclusive: boolean;
  maxExclusive: boolean;
}

export function rangeContains(r: Range, v: number): boolean {
  const above = r.min === undefined || (r.minExclusive ? v > r.min : v >= r.min);
  const below = r.max === undefined || (r.maxExclusive ? v < r.max : v <= r.max);
  return above && below;
}

/** `1..`, `0<..<1`, `3` as mcdoc writes ranges. */
export function rangeDescribe(r: Range): string {
  if (r.min === r.max && !r.minExclusive && !r.maxExclusive) return r.min === undefined ? "" : num(r.min);
  let delimiter: string;
  if (r.minExclusive) delimiter = r.maxExclusive ? "<..<" : "<..";
  else delimiter = r.maxExclusive ? "..<" : "..";
  return `${r.min === undefined ? "" : num(r.min)}${delimiter}${r.max === undefined ? "" : num(r.max)}`;
}

function num(v: number): string {
  return Number.isInteger(v) && Math.abs(v) < 1e15 ? String(v) : fmtF64(v);
}

export type Field =
  | { kind: "Pair"; key: Key; ty: Ty; optional: boolean; desc: string | undefined }
  | { kind: "Spread"; ty: Ty };

export type Key = { kind: "Name"; name: string } | { kind: "Type"; ty: Ty };

export type Index =
  /** A key of the dispatcher (`%fallback`, `%none`, or a plain key). */
  | { kind: "Static"; value: string }
  /** A path from the value being checked to the string that is the key. */
  | { kind: "Dynamic"; path: Access[] };

export type Access =
  | { kind: "Field"; name: string }
  | { kind: "Parent" }
  /** The key under which the value sits in its object. */
  | { kind: "Key" };

/** The `#[id]` attribute of a string: a resource location of a registry. */
export interface IdAttr {
  registry: string | undefined;
  tags: Tags;
  /** The string defines the id rather than referencing it. */
  definition: boolean;
  /** The string starts with `!`. */
  negated: boolean;
  /** A path prepended to the value to make the id. */
  path: string | undefined;
  emptyAllowed: boolean;
  exclude: string[];
}

export function defaultIdAttr(): IdAttr {
  return { registry: undefined, tags: "No", definition: false, negated: false, path: undefined, emptyAllowed: false, exclude: [] };
}

/** `Implicit`: the value is the id of a tag, written without `#`. */
export type Tags = "No" | "Allowed" | "Implicit" | "Required";

export function cloneTy(ty: Ty): Ty {
  return structuredClone(ty);
}

export function cloneField(f: Field): Field {
  return structuredClone(f);
}

function hold(ty: Ty, what: Holds): void {
  switch (ty.kind) {
    case "String":
      ty.holds = what;
      break;
    case "Union":
      for (const m of ty.members) hold(m, what);
      break;
    default:
  }
}

/** A value of the data being checked, as far as the index of a dispatcher reads it. */
export interface Tree {
  /** The value of a key of an object or compound; the last one when the key repeats. */
  field(name: string): Tree | undefined;
  string(): string | undefined;
}

/** The values from the root to the one being checked, each with its key in its object. */
export type Path<N extends Tree = Tree> = readonly (readonly [N, string | undefined])[];

/** Template parameters bound to the type arguments, each with the scope it was written in. */
export class Scope {
  readonly params: Map<string, [Ty, Scope]>;

  constructor(params: Map<string, [Ty, Scope]> = new Map()) {
    this.params = params;
  }
}

/** A type with references, dispatchers, generics, and unions resolved for one value. */
export type Alt =
  | { kind: "Any" }
  /** A type that is none of the above, with the `#[id]` of a reference that led to it (`outer`). */
  | { kind: "Leaf"; ty: Ty; scope: Scope; outer: IdAttr | undefined }
  | { kind: "Struct"; fields: [Field, Scope][]; open: boolean; nbt: boolean };

const NBT_ROOTS = ["::java::world::entity::AnyEntity", "::java::world::component::item::BucketEntityData", "::java::world::block::BlockEntityData"];

export const ANY: Ty = { kind: "Any" };

export const CHECK_LIMIT_MESSAGE = "Stopped checking this value against the schema: it takes too many steps";

export class CheckLimit {
  private left: number;
  #reached = false;

  constructor(left: number) {
    this.left = left;
  }

  static forNodes(nodes: number): CheckLimit {
    // ponytail: a fixed budget of checks per node; raise it if a value of a real pack stops being checked
    return new CheckLimit(nodes * 16 + 4096);
  }

  take(): boolean {
    if (this.left === 0) {
      this.#reached = true;
      return false;
    }
    this.left -= 1;
    return true;
  }

  reached(): boolean {
    return this.#reached;
  }
}

export class Resolver {
  readonly doc: McDoc;
  readonly empty = new Scope();
  /** The scope a `Concrete` binds its arguments in, by the concrete type and the scope it is resolved in. */
  private readonly bound = new Map<Ty, Map<Scope, Scope>>();

  constructor(doc: McDoc) {
    this.doc = doc;
  }

  /** The alternatives of `ty` for the value on top of `stack`. `member`: `ty` describes the
   * value itself (a spread or a key) rather than a value inside it. */
  resolve(ty: Ty, scope: Scope, stack: Path, member: boolean, depth: number): Alt[] {
    if (depth > 64) return [{ kind: "Any" }];
    switch (ty.kind) {
      case "Any":
        return [{ kind: "Any" }];
      case "Reference": {
        const param = scope.params.get(ty.path);
        if (param !== undefined) return this.resolve(param[0], param[1], stack, member, depth + 1);
        const t = this.doc.types.get(ty.path);
        if (t === undefined) return [{ kind: "Any" }];
        const alts = this.resolve(t, this.empty, stack, member, depth + 1);
        if (!NBT_ROOTS.includes(ty.path)) return alts;
        return alts.map((alt): Alt => (alt.kind === "Struct" ? { kind: "Struct", fields: alt.fields, open: alt.open, nbt: true } : alt));
      }
      case "Union": {
        const out: Alt[] = [];
        for (const m of ty.members) {
          for (const alt of this.resolve(m, scope, stack, member, depth + 1)) out.push(alt);
        }
        return out;
      }
      case "Id": {
        const attr = ty.attr;
        return this.resolve(ty.child, scope, stack, member, depth + 1).map(
          (alt): Alt => (alt.kind === "Leaf" ? { kind: "Leaf", ty: alt.ty, scope: alt.scope, outer: attr } : alt),
        );
      }
      case "Dispatcher": {
        const map = this.doc.dispatchers.get(ty.registry);
        if (map === undefined) return [{ kind: "Any" }];
        const out: Alt[] = [];
        for (const t of this.dispatch(ty.registry, map, ty.index, stack, member)) {
          for (const alt of this.resolve(t, this.empty, stack, member, depth + 1)) out.push(alt);
        }
        return out;
      }
      case "Indexed": {
        const alts = this.resolve(ty.child, scope, stack, member, depth + 1);
        const only = alts.length === 1 ? alts[0]! : undefined;
        if (only?.kind !== "Struct") return [{ kind: "Any" }];
        const map = new Map<string, [Ty, Scope]>();
        for (const [f, s] of only.fields) {
          if (f.kind === "Pair" && f.key.kind === "Name") map.set(f.key.name, [f.ty, s]);
        }
        const out: Alt[] = [];
        for (const key of this.indexKeys(ty.index, stack, member)) {
          const found = map.get(stripMinecraft(key)) ?? map.get(key);
          if (found === undefined) return [{ kind: "Any" }];
          for (const alt of this.resolve(found[0], found[1], stack, false, depth + 1)) out.push(alt);
        }
        return out;
      }
      case "Concrete": {
        const child = ty.child;
        const template = child.kind === "Reference" && !scope.params.has(child.path) ? this.doc.types.get(child.path) : child;
        if (template === undefined) return [{ kind: "Any" }];
        if (template.kind === "Template") {
          let scopes = this.bound.get(ty);
          if (scopes === undefined) {
            scopes = new Map();
            this.bound.set(ty, scopes);
          }
          let bound = scopes.get(scope);
          if (bound === undefined) {
            const params = new Map<string, [Ty, Scope]>();
            const n = Math.min(template.params.length, ty.args.length);
            for (let i = 0; i < n; i++) params.set(template.params[i]!, [ty.args[i]!, scope]);
            bound = new Scope(params);
            scopes.set(scope, bound);
          }
          return this.resolve(template.child, bound, stack, member, depth + 1);
        }
        return this.resolve(template, scope, stack, member, depth + 1);
      }
      case "Template":
        return this.resolve(ty.child, scope, stack, member, depth + 1);
      case "Struct": {
        const merged: [Field, Scope][] = [];
        let open = false;
        for (const f of ty.fields) {
          if (f.kind === "Pair") {
            merged.push([f, scope]);
            continue;
          }
          const alts = this.resolve(f.ty, scope, stack, true, depth + 1);
          const only = alts.length === 1 ? alts[0]! : undefined;
          if (only?.kind === "Any") open = true;
          else if (only?.kind === "Struct") {
            for (const [pf, ps] of only.fields) merged.push([pf, ps]);
            open ||= only.open;
          }
        }
        return [{ kind: "Struct", fields: merged, open, nbt: false }];
      }
      default:
        return [{ kind: "Leaf", ty, scope, outer: undefined }];
    }
  }

  /** The dispatcher entries the index picks; a missing key falls back to `%unknown`. */
  private dispatch(registry: string, map: ReadonlyMap<string, Ty>, index: readonly Index[], stack: Path, member: boolean): Ty[] {
    const keys = this.indexKeys(index, stack, member);
    const merged = this.doc.merged(registry);
    if (keys.some((k) => k === "%fallback" || (k === "%none" && merged !== undefined && !map.has("%none")))) {
      return merged !== undefined ? [merged] : [...map.values()];
    }
    const out: Ty[] = [];
    for (const key of keys) {
      const t = map.get(stripMinecraft(key)) ?? map.get("%unknown");
      if (t === undefined) return [ANY];
      out.push(t);
    }
    return out;
  }

  /** The keys an index names. Without any value to read (a path, a completion) a dynamic index
   * may name any key: `%fallback`. */
  private indexKeys(index: readonly Index[], stack: Path, member: boolean): string[] {
    return index.map((i) => {
      if (i.kind === "Static") return i.value;
      if (stack.length === 0) return "%fallback";
      return access(stack, member, i.path) ?? "%none";
    });
  }

  /** The field of a struct that holds the key `name`: the last field named so, else the first
   * whose key is a type the name fits. The key's type comes with a field found that way. */
  field(fields: readonly (readonly [Field, Scope])[], name: string, container: Path): [Ty, Scope, Ty | undefined] | undefined {
    for (let i = fields.length - 1; i >= 0; i--) {
      const [f, s] = fields[i]!;
      if (f.kind === "Pair" && f.key.kind === "Name" && f.key.name === name) return [f.ty, s, undefined];
    }
    for (const [f, s] of fields) {
      if (f.kind === "Pair" && f.key.kind === "Type" && this.keyFits(name, f.key.ty, s, container)) return [f.ty, s, f.key.ty];
    }
    return undefined;
  }

  /** What the strings of a type hold, when every string it may be holds the same. */
  holds(ty: Ty, scope: Scope, stack: Path, member: boolean): Holds | undefined {
    const found = this.resolve(ty, scope, stack, member, 0).map((a) => (a.kind === "Leaf" && a.ty.kind === "String" ? a.ty.holds : undefined));
    const first = found[0];
    if (first === undefined) return undefined;
    return found.every((h) => h === first) ? first : undefined;
  }

  /** Whether a key that no field names matches a field whose key is a type. */
  private keyFits(name: string, key: Ty, scope: Scope, stack: Path): boolean {
    return this.resolve(key, scope, stack, true, 0).some((alt) => {
      if (alt.kind === "Any") return true;
      if (alt.kind !== "Leaf") return false;
      const t = alt.ty;
      switch (t.kind) {
        case "String": {
          const id = t.id ?? alt.outer;
          return (t.len === undefined || rangeContains(t.len, charCount(name))) && (id === undefined || idShape(name, id).ok);
        }
        case "Literal":
          return t.value.kind === "Str" && sameString(t.value.value, name, t.id || alt.outer !== undefined);
        case "Enum":
          return t.values.some((v) => v.kind === "Str" && sameString(v.value, name, t.id || alt.outer !== undefined));
        default:
          return false;
      }
    });
  }

  /** The string values the key types of a struct's fields name (`[#[id] string]` gives none). */
  keyNames(key: Ty, scope: Scope, stack: Path): string[] {
    const out: string[] = [];
    for (const alt of this.resolve(key, scope, stack, true, 0)) {
      if (alt.kind !== "Leaf") continue;
      if (alt.ty.kind === "Literal") {
        if (alt.ty.value.kind === "Str") out.push(alt.ty.value.value);
      } else if (alt.ty.kind === "Enum") {
        for (const v of alt.ty.values) {
          if (v.kind === "Str") out.push(v.value);
        }
      }
    }
    return out;
  }
}

/** Follows a dispatcher's accessor from the value being checked to the string it names. The
 * accessor starts at the object holding the value, or at the value itself for a `member`. */
function access(stack: Path, member: boolean, path: readonly Access[]): string | undefined {
  if (stack.length === 0) return undefined;
  const top = stack.length - 1;
  let key = stack[top]![1];
  // A position in `stack`, or a value reached through a field of one.
  let at: number | Tree;
  if (member) at = top;
  else if (top === 0) return undefined;
  else at = top - 1;
  for (const step of path) {
    switch (step.kind) {
      case "Parent": {
        if (typeof at !== "number") return undefined;
        key = stack[at]![1];
        if (at === 0) return undefined;
        at -= 1;
        break;
      }
      case "Key":
        return key;
      case "Field": {
        const node: Tree = typeof at === "number" ? stack[at]![0] : at;
        const next = node.field(step.name);
        if (next === undefined) return undefined;
        at = next;
        key = step.name;
        break;
      }
    }
  }
  const node: Tree = typeof at === "number" ? stack[at]![0] : at;
  return node.string();
}

export function stripMinecraft(s: string): string {
  return s.startsWith("minecraft:") ? s.slice("minecraft:".length) : s;
}

export function sameString(expected: string, actual: string, id: boolean): boolean {
  return id ? fullId(expected) === fullId(actual) : expected === actual;
}

/** `ok` with `[isTag, resource location]`; `undefined` for an empty value that the attribute
 * allows. Else `ok: false` with what is wrong. */
export type IdShape = { ok: true; value: [boolean, string] | undefined } | { ok: false; error: string };

/** Splits an id into whether it names a tag and the resource location, or says why it is not
 * one the attribute accepts. */
export function idShape(value: string, attr: IdAttr): IdShape {
  if (attr.emptyAllowed && value === "") return { ok: true, value: undefined };
  const bang = value.startsWith("!");
  if (attr.negated && !bang) return { ok: false, error: `Expected “!” before “${value}”` };
  if (!attr.negated && bang) return { ok: false, error: `Unexpected “!” in “${value}”` };
  const unprefixed = attr.negated ? value.slice(1) : value;
  const isTag = unprefixed.startsWith("#");
  const raw = isTag ? unprefixed.slice(1) : unprefixed;
  if (isTag && attr.tags !== "Allowed" && attr.tags !== "Required") return { ok: false, error: `Tags are not allowed here: “${unprefixed}”` };
  if (!isTag && attr.tags === "Required") return { ok: false, error: `Expected a tag starting with “#”: “${unprefixed}”` };
  if (!isResourceLocation(raw)) return { ok: false, error: `Invalid resource location “${raw}”` };
  return { ok: true, value: [isTag, raw] };
}

/** A namespaced id may have an empty path (`lib:`), as storages do. */
export function isResourceLocation(s: string): boolean {
  const colon = s.indexOf(":");
  const ns = colon < 0 ? "minecraft" : s.slice(0, colon);
  const path = colon < 0 ? s : s.slice(colon + 1);
  return (colon >= 0 || path !== "") && /^[a-z0-9_.-]*$/.test(ns) && /^[a-z0-9_./-]*$/.test(path);
}

function withoutAttributes(t: JsonValue): JsonValue {
  const o = asObject(t);
  return o === undefined ? t : Object.fromEntries(Object.entries(o).filter(([k]) => k !== "attributes"));
}

function attributes(t: JsonValue): [string, JsonValue | undefined][] {
  const out: [string, JsonValue | undefined][] = [];
  for (const a of asArray(get(t, "attributes")) ?? []) {
    const name = asStr(get(a, "name"));
    if (name !== undefined) out.push([name, get(a, "value")]);
  }
  return out;
}

function literalString(v: JsonValue | undefined): string | undefined {
  if (v === undefined || asStr(get(v, "kind")) !== "literal") return undefined;
  return asStr(get(get(v, "value"), "value"));
}

function literalBool(v: JsonValue | undefined): boolean | undefined {
  return asBool(get(get(v, "value"), "value"));
}

class Loader {
  readonly version: readonly number[];

  constructor(version: readonly number[]) {
    this.version = version;
  }

  keep(t: JsonValue): boolean {
    return attributes(t).every(([name, value]) => {
      const v = literalString(value);
      if (name === "since" && v !== undefined) return cmp(this.version, parseVersion(v)) >= 0;
      if (name === "until" && v !== undefined) return cmp(this.version, parseVersion(v)) < 0;
      return true;
    });
  }

  private tys(list: JsonValue | undefined): Ty[] {
    return (asArray(list) ?? []).filter((t) => this.keep(t)).map((t) => this.ty(t));
  }

  private boxed(t: JsonValue | undefined): Ty {
    return t === undefined ? { kind: "Any" } : this.ty(t);
  }

  ty(t: JsonValue): Ty {
    const kind = asStr(get(t, "kind")) ?? "";
    const attrs = attributes(t);
    const idAttribute = attrs.find(([n]) => n === "id");
    const id = idAttribute === undefined ? undefined : idAttr(idAttribute[1]);
    if (kind === "reference" && id !== undefined) {
      return { kind: "Id", attr: id, child: this.ty(withoutAttributes(t)) };
    }
    switch (kind) {
      case "boolean":
        return { kind: "Boolean" };
      case "string":
        return { kind: "String", len: range(get(t, "lengthRange")), id, holds: stringHolds(attrs) };
      case "byte":
      case "short":
      case "int":
      case "long":
      case "float":
      case "double":
        return { kind: "Number", numKind: numKind(kind), range: range(get(t, "valueRange")) };
      case "literal": {
        const value = lit(get(t, "value"));
        return value === undefined ? { kind: "Any" } : { kind: "Literal", value, id: id !== undefined };
      }
      case "enum": {
        const values: Lit[] = [];
        for (const v of asArray(get(t, "values")) ?? []) {
          if (!this.keep(v)) continue;
          const value = get(v, "value");
          if (typeof value === "string") values.push({ kind: "Str", value });
          else if (typeof value === "number") values.push({ kind: "Num", value });
        }
        const enumKind = asStr(get(t, "enumKind"));
        return { kind: "Enum", values, id: id !== undefined, num: enumKind === undefined || enumKind === "string" ? undefined : numKind(enumKind) };
      }
      case "struct": {
        const fields: Field[] = [];
        for (const f of asArray(get(t, "fields")) ?? []) {
          if (!this.keep(f)) continue;
          if (asStr(get(f, "kind")) === "spread") {
            fields.push({ kind: "Spread", ty: this.boxed(get(f, "type")) });
            continue;
          }
          const k = get(f, "key");
          const key: Key =
            typeof k === "string" ? { kind: "Name", name: k } : k !== undefined ? { kind: "Type", ty: this.ty(k) } : { kind: "Type", ty: { kind: "Any" } };
          fields.push({ kind: "Pair", key, ty: this.boxed(get(f, "type")), optional: asBool(get(f, "optional")) ?? false, desc: asStr(get(f, "desc")) });
        }
        return { kind: "Struct", fields };
      }
      case "list":
        return { kind: "List", item: this.boxed(get(t, "item")), len: range(get(t, "lengthRange")) };
      case "byte_array":
      case "int_array":
      case "long_array":
        return { kind: "Array", numKind: numKind(kind.slice(0, -"_array".length)), range: range(get(t, "valueRange")), len: range(get(t, "lengthRange")) };
      case "tuple":
        return { kind: "Tuple", items: (asArray(get(t, "items")) ?? []).map((i) => this.ty(i)) };
      case "union":
        return { kind: "Union", members: this.tys(get(t, "members")) };
      case "reference": {
        const path = asStr(get(t, "path"));
        return path === undefined ? { kind: "Any" } : { kind: "Reference", path };
      }
      case "dispatcher":
        return { kind: "Dispatcher", registry: asStr(get(t, "registry")) ?? "", index: indices(get(t, "parallelIndices")) };
      case "indexed":
        return { kind: "Indexed", child: this.boxed(get(t, "child")), index: indices(get(t, "parallelIndices")) };
      case "template": {
        const params: string[] = [];
        for (const p of asArray(get(t, "typeParams")) ?? []) {
          const path = asStr(get(p, "path"));
          if (path !== undefined) params.push(path);
        }
        return { kind: "Template", child: this.boxed(get(t, "child")), params };
      }
      case "concrete":
        return { kind: "Concrete", child: this.boxed(get(t, "child")), args: (asArray(get(t, "typeArgs")) ?? []).map((a) => this.ty(a)) };
      default:
        return { kind: "Any" };
    }
  }
}

function stringHolds(attrs: readonly (readonly [string, JsonValue | undefined])[]): Holds | undefined {
  for (const [name] of attrs) {
    switch (name) {
      case "tag":
        return "Tag";
      case "team":
        return "Team";
      case "objective":
        return "Objective";
      case "text_component":
        return "Text";
      case "block_predicate":
        return "BlockPredicate";
      case "command":
        return "Command";
      default:
    }
  }
  return undefined;
}

function numKind(k: string): NumKind {
  switch (k) {
    case "byte":
      return "Byte";
    case "short":
      return "Short";
    case "int":
      return "Int";
    case "long":
      return "Long";
    case "float":
      return "Float";
    default:
      return "Double";
  }
}

function lit(v: JsonValue | undefined): Lit | undefined {
  if (v === undefined) return undefined;
  const value = get(v, "value");
  if (typeof value === "boolean") return { kind: "Bool", value };
  if (typeof value === "string") return { kind: "Str", value };
  if (typeof value === "number") return { kind: "Num", value };
  return undefined;
}

/** `{"kind": 0b10, "min": 0, "max": 1}`: bit 1 makes the minimum exclusive, bit 0 the maximum. */
export function range(v: JsonValue | undefined): Range | undefined {
  if (v === undefined) return undefined;
  const kind = asU64(get(v, "kind")) ?? 0n;
  return { min: asF64(get(v, "min")), max: asF64(get(v, "max")), minExclusive: (kind & 0b10n) !== 0n, maxExclusive: (kind & 0b01n) !== 0n };
}

function indices(v: JsonValue | undefined): Index[] {
  return (asArray(v) ?? []).map((i): Index => {
    if (asStr(get(i, "kind")) === "static") return { kind: "Static", value: asStr(get(i, "value")) ?? "%none" };
    return {
      kind: "Dynamic",
      path: (asArray(get(i, "accessor")) ?? []).map((a): Access => {
        if (typeof a === "string") return { kind: "Field", name: a };
        return asStr(get(a, "keyword")) === "parent" ? { kind: "Parent" } : { kind: "Key" };
      }),
    };
  });
}

export function idAttr(v: JsonValue | undefined): IdAttr {
  if (v === undefined) return defaultIdAttr();
  const registry = literalString(v);
  if (registry !== undefined) return { ...defaultIdAttr(), registry };
  const tree = get(v, "values");
  if (tree === undefined) return defaultIdAttr();
  const s = (k: string) => literalString(get(tree, k));
  let tags: Tags;
  switch (s("tags")) {
    case "allowed":
      tags = "Allowed";
      break;
    case "implicit":
      tags = "Implicit";
      break;
    case "required":
      tags = "Required";
      break;
    default:
      tags = "No";
  }
  const exclude: string[] = [];
  const e = get(tree, "exclude");
  if (e !== undefined && asStr(get(e, "kind")) === "tree") {
    const values = asObject(get(e, "values"));
    if (values !== undefined) {
      for (const [, x] of sortedEntries(values)) {
        const text = literalString(x);
        if (text !== undefined) exclude.push(text);
      }
    }
  } else {
    const text = literalString(e);
    if (text !== undefined) exclude.push(text);
  }
  return {
    registry: s("registry"),
    tags,
    definition: literalBool(get(tree, "definition")) ?? false,
    negated: s("prefix") === "!",
    path: s("path"),
    emptyAllowed: s("empty") === "allowed",
    exclude,
  };
}
