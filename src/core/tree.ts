// The Brigadier command tree from the data generator's `commands.json`.

import { asArray, asBool, asF64, asObject, asStr, get, sortedEntries, type JsonValue } from "./json-value.ts";
import { F32_MAX, F64_MAX, I32_MAX, I32_MIN, f64ToI32, f64ToI64 } from "./numbers.ts";

export type NodeId = number;
export const ROOT: NodeId = 0;

export type NodeKind = { kind: "Root" } | { kind: "Literal"; name: string } | { kind: "Argument"; name: string; parser: Parser };

export interface Node {
  kind: NodeKind;
  literals: NodeId[];
  arguments: NodeId[];
  executable: boolean;
  redirect: NodeId | undefined;
}

export function nodeName(node: Node): string {
  return node.kind.kind === "Root" ? "" : node.kind.name;
}

export function hasChildren(node: Node): boolean {
  return node.literals.length > 0 || node.arguments.length > 0;
}

export type StringKind = "Word" | "Phrase" | "Greedy";

export type Parser =
  | { kind: "Bool" }
  | { kind: "Integer"; min: number; max: number }
  | { kind: "Long"; min: bigint; max: bigint }
  | { kind: "Float"; min: number; max: number }
  | { kind: "Double"; min: number; max: number }
  | { kind: "String"; string: StringKind }
  | { kind: "Entity"; single: boolean; playersOnly: boolean }
  | { kind: "ScoreHolder"; multiple: boolean }
  | { kind: "GameProfile" }
  | { kind: "BlockPos" }
  | { kind: "ColumnPos" }
  | { kind: "Vec3" }
  | { kind: "Vec2" }
  | { kind: "Rotation" }
  | { kind: "Angle" }
  | { kind: "Swizzle" }
  | { kind: "BlockState" }
  | { kind: "BlockPredicate" }
  | { kind: "ItemStack" }
  | { kind: "ItemPredicate" }
  | { kind: "ItemSlot" }
  | { kind: "ItemSlots" }
  /** A slot range, or a slot source of the registry or inline. */
  | { kind: "SlotSource" }
  | { kind: "Color" }
  /** `color` without `reset`, from 26.2. */
  | { kind: "TeamColor" }
  | { kind: "HexColor" }
  | { kind: "SwingAnimation" }
  | { kind: "Component" }
  | { kind: "Style" }
  | { kind: "Message" }
  | { kind: "NbtCompoundTag" }
  | { kind: "NbtTag" }
  | { kind: "NbtPath" }
  | { kind: "Objective" }
  | { kind: "ObjectiveCriteria" }
  | { kind: "Operation" }
  | { kind: "Particle" }
  | { kind: "IntRange" }
  | { kind: "FloatRange" }
  | { kind: "ResourceLocation" }
  | { kind: "Function" }
  | { kind: "Dimension" }
  | { kind: "EntityAnchor" }
  | { kind: "Gamemode" }
  | { kind: "Heightmap" }
  | { kind: "TemplateMirror" }
  | { kind: "TemplateRotation" }
  | { kind: "ScoreboardSlot" }
  | { kind: "Team" }
  | { kind: "Time"; min: number }
  | { kind: "Uuid" }
  | { kind: "Resource"; registry: string }
  | { kind: "ResourceOrTag"; registry: string }
  | { kind: "ResourceKey"; registry: string }
  | { kind: "ResourceOrTagKey"; registry: string }
  /** An id of a data pack registry or the element written inline in SNBT, as `ResourceOrIdArgument`
   * reads `loot_table` and the like. `registry` has no namespace. */
  | { kind: "ResourceOrId"; registry: string }
  /** An id pattern with `*` and `?`. */
  | { kind: "ResourceSelector"; registry: string }
  | { kind: "Unknown"; id: string };

export class CommandTree {
  readonly nodes: Node[] = [];

  node(id: NodeId): Node {
    return this.nodes[id]!;
  }

  static fromJson(root: JsonValue): CommandTree {
    const tree = new CommandTree();
    const redirects: [NodeId, string[]][] = [];
    tree.add(root, { kind: "Root" }, redirects);
    for (const [id, path] of redirects) {
      let target = ROOT;
      for (const segment of path) {
        const node = tree.node(target);
        const found = [...node.literals, ...node.arguments].find((c) => nodeName(tree.node(c)) === segment);
        if (found === undefined) throw new Error("redirect target exists");
        target = found;
      }
      tree.nodes[id]!.redirect = target;
    }
    return tree;
  }

  private add(v: JsonValue, kind: NodeKind, redirects: [NodeId, string[]][]): NodeId {
    const id = this.nodes.length;
    const executable = asBool(get(v, "executable")) ?? false;
    this.nodes.push({ kind, literals: [], arguments: [], executable, redirect: undefined });
    const redirect = asArray(get(v, "redirect"));
    if (redirect !== undefined) {
      redirects.push([id, redirect.flatMap((s) => (typeof s === "string" ? [s] : []))]);
    } else if (asStr(get(v, "type")) !== "root" && get(v, "children") === undefined && !executable) {
      // Brigadier serialises `execute run` as a redirect-less node with no children;
      // it means "redirect to root".
      redirects.push([id, []]);
    }
    const children = asObject(get(v, "children"));
    if (children !== undefined) {
      for (const [name, child] of sortedEntries(children)) {
        const childKind: NodeKind =
          asStr(get(child, "type")) === "literal" ? { kind: "Literal", name } : { kind: "Argument", name, parser: parseParser(child) };
        const childId = this.add(child, childKind, redirects);
        const node = this.nodes[id]!;
        if (childKind.kind === "Literal") node.literals.push(childId);
        else node.arguments.push(childId);
      }
    }
    return id;
  }
}

function parseParser(v: JsonValue): Parser {
  const id = asStr(get(v, "parser")) ?? "";
  const props = get(v, "properties");
  const prop = (k: string) => get(props, k);
  const f64Prop = (k: string, d: number) => asF64(prop(k)) ?? d;
  const strProp = (k: string) => asStr(prop(k)) ?? "";
  switch (id) {
    case "brigadier:bool":
      return { kind: "Bool" };
    case "brigadier:integer":
      return { kind: "Integer", min: f64ToI32(f64Prop("min", I32_MIN)), max: f64ToI32(f64Prop("max", I32_MAX)) };
    case "brigadier:long":
      return { kind: "Long", min: f64ToI64(f64Prop("min", -9223372036854775808)), max: f64ToI64(f64Prop("max", 9223372036854775807)) };
    case "brigadier:float":
      return { kind: "Float", min: Math.fround(f64Prop("min", -F32_MAX)), max: Math.fround(f64Prop("max", F32_MAX)) };
    case "brigadier:double":
      return { kind: "Double", min: f64Prop("min", -F64_MAX), max: f64Prop("max", F64_MAX) };
    case "brigadier:string": {
      const t = asStr(prop("type"));
      return { kind: "String", string: t === "greedy" ? "Greedy" : t === "phrase" ? "Phrase" : "Word" };
    }
    case "minecraft:entity":
      return { kind: "Entity", single: asStr(prop("amount")) === "single", playersOnly: asStr(prop("type")) === "players" };
    case "minecraft:score_holder":
      return { kind: "ScoreHolder", multiple: asStr(prop("amount")) === "multiple" };
    case "minecraft:game_profile":
      return { kind: "GameProfile" };
    case "minecraft:block_pos":
      return { kind: "BlockPos" };
    case "minecraft:column_pos":
      return { kind: "ColumnPos" };
    case "minecraft:vec3":
      return { kind: "Vec3" };
    case "minecraft:vec2":
      return { kind: "Vec2" };
    case "minecraft:rotation":
      return { kind: "Rotation" };
    case "minecraft:angle":
      return { kind: "Angle" };
    case "minecraft:swizzle":
      return { kind: "Swizzle" };
    case "minecraft:block_state":
      return { kind: "BlockState" };
    case "minecraft:block_predicate":
      return { kind: "BlockPredicate" };
    case "minecraft:item_stack":
      return { kind: "ItemStack" };
    case "minecraft:item_predicate":
      return { kind: "ItemPredicate" };
    case "minecraft:item_slot":
      return { kind: "ItemSlot" };
    case "minecraft:item_slots":
      return { kind: "ItemSlots" };
    case "minecraft:slot_source":
      return { kind: "SlotSource" };
    case "minecraft:color":
      return { kind: "Color" };
    case "minecraft:team_color":
      return { kind: "TeamColor" };
    case "minecraft:hex_color":
      return { kind: "HexColor" };
    case "minecraft:swing_animation":
      return { kind: "SwingAnimation" };
    case "minecraft:component":
      return { kind: "Component" };
    case "minecraft:style":
      return { kind: "Style" };
    case "minecraft:message":
      return { kind: "Message" };
    case "minecraft:nbt_compound_tag":
      return { kind: "NbtCompoundTag" };
    case "minecraft:nbt_tag":
      return { kind: "NbtTag" };
    case "minecraft:nbt_path":
      return { kind: "NbtPath" };
    case "minecraft:objective":
      return { kind: "Objective" };
    case "minecraft:objective_criteria":
      return { kind: "ObjectiveCriteria" };
    case "minecraft:operation":
      return { kind: "Operation" };
    case "minecraft:particle":
      return { kind: "Particle" };
    case "minecraft:int_range":
      return { kind: "IntRange" };
    case "minecraft:float_range":
      return { kind: "FloatRange" };
    case "minecraft:resource_location":
      return { kind: "ResourceLocation" };
    case "minecraft:function":
      return { kind: "Function" };
    case "minecraft:dimension":
      return { kind: "Dimension" };
    case "minecraft:entity_anchor":
      return { kind: "EntityAnchor" };
    case "minecraft:gamemode":
      return { kind: "Gamemode" };
    case "minecraft:heightmap":
      return { kind: "Heightmap" };
    case "minecraft:template_mirror":
      return { kind: "TemplateMirror" };
    case "minecraft:template_rotation":
      return { kind: "TemplateRotation" };
    case "minecraft:scoreboard_slot":
      return { kind: "ScoreboardSlot" };
    case "minecraft:team":
      return { kind: "Team" };
    case "minecraft:time":
      return { kind: "Time", min: f64ToI32(f64Prop("min", 0)) };
    case "minecraft:uuid":
      return { kind: "Uuid" };
    case "minecraft:resource":
      return { kind: "Resource", registry: strProp("registry") };
    case "minecraft:resource_or_tag":
      return { kind: "ResourceOrTag", registry: strProp("registry") };
    case "minecraft:resource_key":
      return { kind: "ResourceKey", registry: strProp("registry") };
    case "minecraft:resource_or_tag_key":
      return { kind: "ResourceOrTagKey", registry: strProp("registry") };
    case "minecraft:resource_selector":
      return { kind: "ResourceSelector", registry: strProp("registry") };
    case "minecraft:loot_table":
      return { kind: "ResourceOrId", registry: "loot_table" };
    case "minecraft:loot_predicate":
      return { kind: "ResourceOrId", registry: "predicate" };
    case "minecraft:loot_modifier":
      return { kind: "ResourceOrId", registry: "item_modifier" };
    case "minecraft:dialog":
      return { kind: "ResourceOrId", registry: "dialog" };
    case "minecraft:feature":
      return { kind: "ResourceOrId", registry: "worldgen/feature" };
    case "minecraft:context_float_provider":
      return { kind: "ResourceOrId", registry: "context_float_provider" };
    case "minecraft:context_int_provider":
      return { kind: "ResourceOrId", registry: "context_int_provider" };
    default:
      return { kind: "Unknown", id };
  }
}
