//! What one file contributes to the project: definitions and references.

/// The kind of a resource or symbol, named as IMP-Doc names it
/// (`function`, `tag/function`, `score_holder`, `storage`, ...).
pub type Kind = &'static str;

pub mod kind {
    use super::Kind;
    pub const FUNCTION: Kind = "function";
    pub const FUNCTION_TAG: Kind = "tag/function";
    pub const ADVANCEMENT: Kind = "advancement";
    pub const LOOT_TABLE: Kind = "loot_table";
    pub const PREDICATE: Kind = "predicate";
    pub const RECIPE: Kind = "recipe";
    pub const ITEM_MODIFIER: Kind = "item_modifier";
    pub const STRUCTURE: Kind = "structure";
    pub const STORAGE: Kind = "storage";
    pub const SCORE_HOLDER: Kind = "score_holder";
    pub const OBJECTIVE: Kind = "objective";
    pub const TEAM: Kind = "team";
    pub const BOSSBAR: Kind = "bossbar";
    pub const ENTITY_TAG: Kind = "tag";
    pub const BLOCK_TAG: Kind = "tag/block";
    pub const ITEM_TAG: Kind = "tag/item";
    pub const ENTITY_TYPE_TAG: Kind = "tag/entity_type";
    pub const FLUID_TAG: Kind = "tag/fluid";
    pub const DAMAGE_TYPE: Kind = "damage_type";
    pub const DAMAGE_TYPE_TAG: Kind = "tag/damage_type";
    pub const DIMENSION: Kind = "dimension";
    pub const DIMENSION_TYPE: Kind = "dimension_type";
    pub const TEMPLATE_POOL: Kind = "worldgen/template_pool";
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ref {
    pub kind: Kind,
    /// Full id with namespace; tags without the leading `#`.
    pub id: String,
    pub start: u32,
    pub end: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Def {
    pub kind: Kind,
    pub id: String,
    pub start: u32,
    pub end: u32,
}

/// Normalises a resource location: adds `minecraft:` when the namespace is omitted.
pub fn full_id(id: &str) -> String {
    if id.contains(':') { id.to_string() } else { format!("minecraft:{id}") }
}
