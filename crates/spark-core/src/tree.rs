//! The Brigadier command tree from the data generator's `commands.json`.

use serde_json::Value;

pub type NodeId = u32;
pub const ROOT: NodeId = 0;

#[derive(Debug)]
pub enum NodeKind {
    Root,
    Literal(Box<str>),
    Argument { name: Box<str>, parser: Parser },
}

#[derive(Debug)]
pub struct Node {
    pub kind: NodeKind,
    pub literals: Vec<NodeId>,
    pub arguments: Vec<NodeId>,
    pub executable: bool,
    pub redirect: Option<NodeId>,
}

impl Node {
    pub fn name(&self) -> &str {
        match &self.kind {
            NodeKind::Root => "",
            NodeKind::Literal(n) => n,
            NodeKind::Argument { name, .. } => name,
        }
    }

    pub fn has_children(&self) -> bool {
        !self.literals.is_empty() || !self.arguments.is_empty()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StringKind {
    Word,
    Phrase,
    Greedy,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Parser {
    Bool,
    Integer { min: i32, max: i32 },
    Long { min: i64, max: i64 },
    Float { min: f32, max: f32 },
    Double { min: f64, max: f64 },
    String(StringKind),
    Entity { single: bool, players_only: bool },
    ScoreHolder { multiple: bool },
    GameProfile,
    BlockPos,
    ColumnPos,
    Vec3,
    Vec2,
    Rotation,
    Angle,
    Swizzle,
    BlockState,
    BlockPredicate,
    ItemStack,
    ItemPredicate,
    ItemSlot,
    ItemSlots,
    /// A slot range, or a slot source of the registry or inline.
    SlotSource,
    Color,
    /// `color` without `reset`, from 26.2.
    TeamColor,
    HexColor,
    SwingAnimation,
    Component,
    Style,
    Message,
    NbtCompoundTag,
    NbtTag,
    NbtPath,
    Objective,
    ObjectiveCriteria,
    Operation,
    Particle,
    IntRange,
    FloatRange,
    ResourceLocation,
    Function,
    Dimension,
    EntityAnchor,
    Gamemode,
    Heightmap,
    TemplateMirror,
    TemplateRotation,
    ScoreboardSlot,
    Team,
    Time { min: i32 },
    Uuid,
    Resource { registry: Box<str> },
    ResourceOrTag { registry: Box<str> },
    ResourceKey { registry: Box<str> },
    ResourceOrTagKey { registry: Box<str> },
    /// An id of a data pack registry or the element written inline in SNBT, as `ResourceOrIdArgument`
    /// reads `loot_table` and the like. `registry` has no namespace.
    ResourceOrId { registry: &'static str },
    /// An id pattern with `*` and `?`.
    ResourceSelector { registry: Box<str> },
    Unknown(Box<str>),
}

pub struct CommandTree {
    pub nodes: Vec<Node>,
}

impl CommandTree {
    pub fn node(&self, id: NodeId) -> &Node {
        &self.nodes[id as usize]
    }

    pub fn from_json(root: &Value) -> CommandTree {
        let mut tree = CommandTree { nodes: Vec::new() };
        let mut redirects: Vec<(NodeId, Vec<String>)> = Vec::new();
        tree.add(root, NodeKind::Root, &mut redirects);
        for (id, path) in redirects {
            let mut target = ROOT;
            for segment in &path {
                let node = tree.node(target);
                target = *node
                    .literals
                    .iter()
                    .chain(node.arguments.iter())
                    .find(|&&c| tree.node(c).name() == segment)
                    .expect("redirect target exists");
            }
            tree.nodes[id as usize].redirect = Some(target);
        }
        tree
    }

    fn add(&mut self, v: &Value, kind: NodeKind, redirects: &mut Vec<(NodeId, Vec<String>)>) -> NodeId {
        let id = self.nodes.len() as NodeId;
        self.nodes.push(Node {
            kind,
            literals: Vec::new(),
            arguments: Vec::new(),
            executable: v.get("executable").and_then(Value::as_bool).unwrap_or(false),
            redirect: None,
        });
        if let Some(path) = v.get("redirect").and_then(Value::as_array) {
            redirects.push((id, path.iter().filter_map(|s| s.as_str().map(str::to_string)).collect()));
        } else if v.get("type").and_then(Value::as_str) != Some("root")
            && v.get("children").is_none()
            && !v.get("executable").and_then(Value::as_bool).unwrap_or(false)
        {
            // Brigadier serialises `execute run` as a redirect-less node with no children;
            // it means "redirect to root".
            redirects.push((id, Vec::new()));
        }
        if let Some(children) = v.get("children").and_then(Value::as_object) {
            for (name, child) in children {
                let child_kind = match child.get("type").and_then(Value::as_str) {
                    Some("literal") => NodeKind::Literal(name.as_str().into()),
                    _ => NodeKind::Argument { name: name.as_str().into(), parser: parse_parser(child) },
                };
                let is_literal = matches!(child_kind, NodeKind::Literal(_));
                let child_id = self.add(child, child_kind, redirects);
                let node = &mut self.nodes[id as usize];
                if is_literal {
                    node.literals.push(child_id);
                } else {
                    node.arguments.push(child_id);
                }
            }
        }
        id
    }
}

fn parse_parser(v: &Value) -> Parser {
    let id = v.get("parser").and_then(Value::as_str).unwrap_or("");
    let props = v.get("properties");
    let prop = |k: &str| props.and_then(|p| p.get(k));
    let f64_prop = |k: &str, d: f64| prop(k).and_then(Value::as_f64).unwrap_or(d);
    let str_prop = |k: &str| prop(k).and_then(Value::as_str).unwrap_or("").into();
    match id {
        "brigadier:bool" => Parser::Bool,
        "brigadier:integer" => Parser::Integer {
            min: f64_prop("min", i32::MIN as f64) as i32,
            max: f64_prop("max", i32::MAX as f64) as i32,
        },
        "brigadier:long" => Parser::Long {
            min: f64_prop("min", i64::MIN as f64) as i64,
            max: f64_prop("max", i64::MAX as f64) as i64,
        },
        "brigadier:float" => Parser::Float {
            min: f64_prop("min", f32::MIN as f64) as f32,
            max: f64_prop("max", f32::MAX as f64) as f32,
        },
        "brigadier:double" => Parser::Double { min: f64_prop("min", f64::MIN), max: f64_prop("max", f64::MAX) },
        "brigadier:string" => Parser::String(match prop("type").and_then(Value::as_str) {
            Some("greedy") => StringKind::Greedy,
            Some("phrase") => StringKind::Phrase,
            _ => StringKind::Word,
        }),
        "minecraft:entity" => Parser::Entity {
            single: prop("amount").and_then(Value::as_str) == Some("single"),
            players_only: prop("type").and_then(Value::as_str) == Some("players"),
        },
        "minecraft:score_holder" => {
            Parser::ScoreHolder { multiple: prop("amount").and_then(Value::as_str) == Some("multiple") }
        }
        "minecraft:game_profile" => Parser::GameProfile,
        "minecraft:block_pos" => Parser::BlockPos,
        "minecraft:column_pos" => Parser::ColumnPos,
        "minecraft:vec3" => Parser::Vec3,
        "minecraft:vec2" => Parser::Vec2,
        "minecraft:rotation" => Parser::Rotation,
        "minecraft:angle" => Parser::Angle,
        "minecraft:swizzle" => Parser::Swizzle,
        "minecraft:block_state" => Parser::BlockState,
        "minecraft:block_predicate" => Parser::BlockPredicate,
        "minecraft:item_stack" => Parser::ItemStack,
        "minecraft:item_predicate" => Parser::ItemPredicate,
        "minecraft:item_slot" => Parser::ItemSlot,
        "minecraft:item_slots" => Parser::ItemSlots,
        "minecraft:slot_source" => Parser::SlotSource,
        "minecraft:color" => Parser::Color,
        "minecraft:team_color" => Parser::TeamColor,
        "minecraft:hex_color" => Parser::HexColor,
        "minecraft:swing_animation" => Parser::SwingAnimation,
        "minecraft:component" => Parser::Component,
        "minecraft:style" => Parser::Style,
        "minecraft:message" => Parser::Message,
        "minecraft:nbt_compound_tag" => Parser::NbtCompoundTag,
        "minecraft:nbt_tag" => Parser::NbtTag,
        "minecraft:nbt_path" => Parser::NbtPath,
        "minecraft:objective" => Parser::Objective,
        "minecraft:objective_criteria" => Parser::ObjectiveCriteria,
        "minecraft:operation" => Parser::Operation,
        "minecraft:particle" => Parser::Particle,
        "minecraft:int_range" => Parser::IntRange,
        "minecraft:float_range" => Parser::FloatRange,
        "minecraft:resource_location" => Parser::ResourceLocation,
        "minecraft:function" => Parser::Function,
        "minecraft:dimension" => Parser::Dimension,
        "minecraft:entity_anchor" => Parser::EntityAnchor,
        "minecraft:gamemode" => Parser::Gamemode,
        "minecraft:heightmap" => Parser::Heightmap,
        "minecraft:template_mirror" => Parser::TemplateMirror,
        "minecraft:template_rotation" => Parser::TemplateRotation,
        "minecraft:scoreboard_slot" => Parser::ScoreboardSlot,
        "minecraft:team" => Parser::Team,
        "minecraft:time" => Parser::Time { min: f64_prop("min", 0.0) as i32 },
        "minecraft:uuid" => Parser::Uuid,
        "minecraft:resource" => Parser::Resource { registry: str_prop("registry") },
        "minecraft:resource_or_tag" => Parser::ResourceOrTag { registry: str_prop("registry") },
        "minecraft:resource_key" => Parser::ResourceKey { registry: str_prop("registry") },
        "minecraft:resource_or_tag_key" => Parser::ResourceOrTagKey { registry: str_prop("registry") },
        "minecraft:resource_selector" => Parser::ResourceSelector { registry: str_prop("registry") },
        "minecraft:loot_table" => Parser::ResourceOrId { registry: "loot_table" },
        "minecraft:loot_predicate" => Parser::ResourceOrId { registry: "predicate" },
        "minecraft:loot_modifier" => Parser::ResourceOrId { registry: "item_modifier" },
        "minecraft:dialog" => Parser::ResourceOrId { registry: "dialog" },
        "minecraft:feature" => Parser::ResourceOrId { registry: "worldgen/feature" },
        "minecraft:context_float_provider" => Parser::ResourceOrId { registry: "context_float_provider" },
        "minecraft:context_int_provider" => Parser::ResourceOrId { registry: "context_int_provider" },
        other => Parser::Unknown(other.into()),
    }
}
