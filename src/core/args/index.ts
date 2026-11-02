// Argument parsers. Each follows the 1.20.4 vanilla parser of the same name and
// reports references, definitions, and lint diagnostics through `ArgCtx`.

import { isAsciiDigit, isAsciiLowercase } from "../chars.ts";
import type { Effect } from "../command.ts";
import type { Config } from "../config.ts";
import type { VersionData } from "../data.ts";
import { ParseError, type Severity } from "../diag.ts";
import { type Kind, fullId, kind } from "../facts.ts";
import { asBool, asStr } from "../json-value.ts";
import { conventionNames, followsConvention, stringQuoteProblems } from "../lint.ts";
import type { PResult, Reader } from "../reader.ts";
import type { Parser } from "../tree.ts";
import * as basic from "./basic.ts";
import * as blockitem from "./blockitem.ts";
import * as coords from "./coords.ts";
import * as entity from "./entity.ts";
import * as nbt from "./nbt.ts";
import * as text from "./text.ts";

/** What an argument tells the arguments after it (for example the NBT context). */
export type ArgValue =
  /** An entity argument: the entity type its NBT is checked against
   * (`undefined` when the selector does not fix one). */
  | { kind: "Entity"; entityType: string | undefined }
  /** A registry id such as `summon`'s entity type. */
  | { kind: "Id"; id: string }
  /** An NBT path, for the `data modify ... value` tag after it. */
  | { kind: "Path"; path: nbt.NbtPathNode[] };

export interface PathNode {
  name: string;
  literal: boolean;
}

export class ArgCtx {
  readonly data: VersionData;
  readonly config: Config;
  readonly effects: Effect[];
  /** The argument node's name (`targets`, `loot_table`, ...). */
  readonly name: string;
  /** Names of the nodes before this argument in the current command
   * (after `execute ... run`, only the nodes of the inner command). */
  readonly path: readonly PathNode[];
  /** Values recorded by the earlier arguments of the current command. */
  readonly values: ArgValue[];

  constructor(data: VersionData, config: Config, effects: Effect[], name: string, path: readonly PathNode[], values: ArgValue[]) {
    this.data = data;
    this.config = config;
    this.effects = effects;
    this.name = name;
    this.path = path;
    this.values = values;
  }

  prevLiteral(): string | undefined {
    for (let i = this.path.length - 1; i >= 0; i--) if (this.path[i]!.literal) return this.path[i]!.name;
    return undefined;
  }

  /** True when the nodes right before this argument are exactly these literals. */
  follows(literals: readonly string[]): boolean {
    if (this.path.length < literals.length) return false;
    const from = this.path.length - literals.length;
    return literals.every((l, i) => this.path[from + i]!.literal && this.path[from + i]!.name === l);
  }

  diag(start: number, end: number, severity: Severity, code: string, message: string): void {
    this.effects.push({ kind: "Diag", diag: { start, end, severity, code, message } });
  }

  reference(k: Kind, id: string, start: number, end: number): void {
    this.effects.push({ kind: "Ref", ref: { kind: k, id: fullId(id), start, end } });
  }

  /** For symbols that are names rather than resource locations
   * (score holders, entity tags, objectives, teams). */
  referenceName(k: Kind, name: string, start: number, end: number): void {
    this.effects.push({ kind: "Ref", ref: { kind: k, id: name, start, end } });
  }

  /** A reference that Spyglass 4 binds as a definition (see `Effect` `Write`).
   * `id` is already normalised. */
  writeReference(k: Kind, id: string, start: number, end: number): void {
    this.effects.push({ kind: "Write", ref: { kind: k, id, start, end } });
  }

  define(k: Kind, id: string, start: number, end: number): void {
    this.effects.push({ kind: "Def", def: { kind: k, id, start, end } });
  }

  /** Reports `name` when it does not follow the naming convention of `rule`
   * (`nameOfObjectives`, `nameOfTags`, ...). */
  naming(rule: string, what: string, name: string, start: number, end: number): void {
    const r = this.config.rule(rule);
    if (r === undefined) return;
    const [severity, convention] = r;
    if (!followsConvention(name, convention)) {
      this.diag(start, end, severity, rule, `Invalid ${what} '${name}' which doesn't follow ${conventionNames(convention)}`);
    }
  }

  /** `stringQuote` / `stringQuoteType` for a quotable string argument. */
  stringQuote(quoted: string | undefined, value: string, start: number, end: number): void {
    this.quoteRules("stringQuote", "stringQuoteType", quoted, value, start, end);
  }

  /** A pair of quote rules (`<x>Quote` / `<x>QuoteType`) for one string. */
  quoteRules(quoteRule: string, typeRule: string, quoted: string | undefined, value: string, start: number, end: number): void {
    const q = this.config.ruleAny(quoteRule);
    const qb = q === undefined ? undefined : asBool(q[1]);
    const quote = q !== undefined && qb !== undefined ? ([q[0], qb] as const) : undefined;
    const t = this.config.ruleAny(typeRule);
    const ts = t === undefined ? undefined : asStr(t[1]);
    const quoteType = t !== undefined && ts !== undefined ? ([t[0], ts] as const) : undefined;
    const problems = stringQuoteProblems(
      quoted,
      value,
      quote === undefined ? undefined : [quoteRule, quote[1]],
      quoteType === undefined ? undefined : [typeRule, quoteType[1]],
    );
    for (const [rule, message] of problems) {
      const severity = rule === quoteRule ? quote?.[0] : quoteType?.[0];
      if (severity !== undefined) this.diag(start, end, severity, rule, message);
    }
  }

  /** Checks an id against a vanilla registry under the matching `strict*Check` rule. */
  checkRegistry(registry: string, id: string, start: number, end: number): void {
    const rule = registryRule(registry);
    if (rule === undefined) return;
    const r = this.config.rule(rule);
    if (r === undefined) return;
    let [severity] = r;
    const mode = r[1];
    const full = fullId(id);
    if (asStr(mode) === "only-default-namespace" && !full.startsWith("minecraft:")) {
      // DHP still hints at such ids; the modified Spyglass is silent.
      if (this.config.spyglass) return;
      severity = "Hint";
    }
    if (!this.data.registryHas(registry, full)) {
      const what = registry.startsWith("minecraft:") ? registry.slice("minecraft:".length) : registry;
      this.diag(start, end, severity, rule, `Failed to resolve ${what} '${full}'`);
    }
  }
}

/** The `strict*Check` rule that governs a vanilla registry. */
export function registryRule(registry: string): string | undefined {
  switch (registry) {
    case "minecraft:block":
      return "strictBlockCheck";
    case "minecraft:item":
      return "strictItemCheck";
    case "minecraft:entity_type":
      return "strictEntityTypeCheck";
    case "minecraft:enchantment":
      return "strictEnchantmentCheck";
    case "minecraft:mob_effect":
      return "strictMobEffectCheck";
    case "minecraft:attribute":
      return "strictAttributeCheck";
    case "minecraft:particle_type":
      return "strictParticleTypeCheck";
    case "minecraft:potion":
      return "strictPotionCheck";
    case "minecraft:sound_event":
      return "strictSoundEventCheck";
    case "minecraft:painting_variant":
      return "strictMotiveCheck";
    case "minecraft:fluid":
      return "strictFluidCheck";
    case "minecraft:dimension_type":
      return "strictDimensionTypeCheck";
    default:
      return undefined;
  }
}

export function isAllowedInResourceLocation(c: string): boolean {
  return isAsciiDigit(c) || isAsciiLowercase(c) || c === "_" || c === ":" || c === "/" || c === "." || c === "-";
}

const NAMESPACE_CHAR = /^[0-9a-z_.-]*$/;
const PATH_CHAR = /^[0-9a-z_.\-/]*$/;

/** Reads a resource location like `ResourceLocation.read`. Returns the
 * position where it started and the raw text. */
export function readResourceLocation(r: Reader): PResult<[number, string]> {
  const start = r.pos;
  const text = r.readWhile(isAllowedInResourceLocation);
  const colon = text.indexOf(":");
  const [ns, path] = colon < 0 ? ["minecraft", text] : [text.slice(0, colon), text.slice(colon + 1)];
  if (!NAMESPACE_CHAR.test(ns) || !PATH_CHAR.test(path)) {
    r.pos = start;
    return r.errorSpan(start, `Invalid resource location '${text}'`);
  }
  return [start, text];
}

export const ENTITY_ANCHORS: readonly string[] = ["eyes", "feet"];
export const GAMEMODES: readonly string[] = ["survival", "creative", "adventure", "spectator"];
export const HEIGHTMAPS: readonly string[] = ["world_surface_wg", "world_surface", "ocean_floor_wg", "ocean_floor", "motion_blocking", "motion_blocking_no_leaves"];
export const TEMPLATE_MIRRORS: readonly string[] = ["none", "left_right", "front_back"];
export const TEMPLATE_ROTATIONS: readonly string[] = ["none", "clockwise_90", "180", "counterclockwise_90"];

export function parse(parser: Parser, r: Reader, cx: ArgCtx): PResult<void> {
  switch (parser.kind) {
    case "Bool": {
      const b = r.readBool();
      return typeof b === "boolean" ? undefined : b;
    }
    case "Integer":
      return basic.integer(r, BigInt(parser.min), BigInt(parser.max), false);
    case "Long":
      return basic.integer(r, parser.min, parser.max, true);
    case "Float":
      return basic.float(r, parser.min, parser.max, false);
    case "Double":
      return basic.float(r, parser.min, parser.max, true);
    case "String":
      if (parser.string === "Word") return basic.word(r, cx);
      if (parser.string === "Phrase") return basic.phrase(r, cx);
      r.pos = r.src.length;
      return undefined;
    case "Entity":
      return entity.entity(r, cx, parser.single, parser.playersOnly);
    case "ScoreHolder":
      return entity.scoreHolder(r, cx, parser.multiple);
    case "GameProfile":
      return entity.gameProfile(r, cx);
    case "BlockPos":
      return coords.blockPos(r);
    case "ColumnPos":
      return coords.columnPos(r);
    case "Vec3":
      return coords.vec3(r);
    case "Vec2":
      return coords.vec2(r);
    case "Rotation":
      return coords.rotation(r);
    case "Angle":
      return coords.angle(r);
    case "Swizzle":
      return basic.swizzle(r);
    case "BlockState":
      return blockitem.blockState(r, cx, false);
    case "BlockPredicate":
      return blockitem.blockState(r, cx, true);
    case "ItemStack":
      return blockitem.item(r, cx, false);
    case "ItemPredicate":
      return blockitem.item(r, cx, true);
    case "ItemSlot":
      return basic.itemSlot(r, cx.data);
    case "ItemSlots":
      return basic.itemSlots(r, cx.data);
    case "SlotSource":
      return basic.slotSource(r, cx);
    case "Color":
      return basic.oneOf(r, basic.COLORS, "color");
    case "TeamColor":
      return basic.oneOf(r, basic.COLORS.slice(0, 16), "color");
    case "HexColor":
      return basic.hexColor(r);
    case "SwingAnimation":
      return basic.oneOf(r, basic.SWING_ANIMATIONS, "swing animation");
    case "Component":
      return text.component(r, cx);
    case "Style":
      return text.style(r, cx);
    case "Message":
      return basic.message(r, cx);
    case "NbtCompoundTag":
      return nbt.compoundArgument(r, cx);
    case "NbtTag":
      return nbt.tagArgument(r, cx);
    case "NbtPath":
      return nbt.pathArgument(r, cx);
    case "Objective":
      return basic.objective(r, cx);
    case "ObjectiveCriteria":
      return basic.objectiveCriteria(r, cx);
    case "Operation":
      return basic.operation(r);
    case "Particle":
      return blockitem.particle(r, cx);
    case "IntRange": {
      const v = basic.range(r, false);
      return v instanceof ParseError ? v : undefined;
    }
    case "FloatRange": {
      const v = basic.range(r, true);
      return v instanceof ParseError ? v : undefined;
    }
    case "ResourceLocation":
      return basic.resourceLocation(r, cx);
    case "Function":
      return basic.function_(r, cx);
    case "Dimension": {
      const loc = readResourceLocation(r);
      if (loc instanceof ParseError) return loc;
      const [start, id] = loc;
      cx.reference(kind.DIMENSION, id, r.offsetOf(start), r.offset());
      return undefined;
    }
    case "EntityAnchor":
      return basic.oneOf(r, ENTITY_ANCHORS, "entity anchor");
    case "Gamemode":
      return basic.oneOf(r, GAMEMODES, "game mode");
    case "Heightmap":
      return basic.oneOf(r, HEIGHTMAPS, "heightmap");
    case "TemplateMirror":
      return basic.oneOf(r, TEMPLATE_MIRRORS, "mirror");
    case "TemplateRotation":
      return basic.oneOf(r, TEMPLATE_ROTATIONS, "rotation");
    case "ScoreboardSlot":
      return basic.scoreboardSlot(r);
    case "Team":
      return basic.team(r, cx);
    case "Time":
      return basic.time(r, parser.min);
    case "Uuid":
      return basic.uuid(r);
    case "Resource":
    case "ResourceKey":
      return basic.resource(r, cx, parser.registry, false);
    case "ResourceOrTag":
    case "ResourceOrTagKey":
      return basic.resource(r, cx, parser.registry, true);
    case "ResourceOrId":
      return basic.resourceOrId(r, cx, parser.registry);
    case "ResourceSelector":
      return basic.resourceSelector(r, cx, parser.registry);
    case "Unknown":
      return r.error(`Unsupported argument type ${parser.id}`);
  }
}
