// What one file contributes to the project: definitions and references.

/** The kind of a resource or symbol, named as IMP-Doc names it
 * (`function`, `tag/function`, `score_holder`, `storage`, ...). */
export type Kind = string;

export const kind = {
  FUNCTION: "function",
  FUNCTION_TAG: "tag/function",
  ADVANCEMENT: "advancement",
  LOOT_TABLE: "loot_table",
  PREDICATE: "predicate",
  RECIPE: "recipe",
  ITEM_MODIFIER: "item_modifier",
  STRUCTURE: "structure",
  STORAGE: "storage",
  SCORE_HOLDER: "score_holder",
  OBJECTIVE: "objective",
  TEAM: "team",
  BOSSBAR: "bossbar",
  ENTITY_TAG: "tag",
  BLOCK_TAG: "tag/block",
  ITEM_TAG: "tag/item",
  ENTITY_TYPE_TAG: "tag/entity_type",
  FLUID_TAG: "tag/fluid",
  DAMAGE_TYPE: "damage_type",
  DAMAGE_TYPE_TAG: "tag/damage_type",
  DIMENSION: "dimension",
  DIMENSION_TYPE: "dimension_type",
  TEMPLATE_POOL: "worldgen/template_pool",
} as const;

export interface Ref {
  kind: Kind;
  /** Full id with namespace; tags without the leading `#`. */
  id: string;
  start: number;
  end: number;
}

export interface Def {
  kind: Kind;
  id: string;
  start: number;
  end: number;
}

/** Normalises a resource location: adds `minecraft:` when the namespace is omitted. */
export function fullId(id: string): string {
  return id.includes(":") ? id : `minecraft:${id}`;
}
