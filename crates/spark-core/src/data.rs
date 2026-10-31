//! Vanilla data for one game version. The command tree, registries, block states, and the
//! lists of vanilla data pack contents come from the summary of misode/mcmeta, and the schema of
//! data pack JSON and NBT from vanilla-mcdoc; both are downloaded on first use and cached on disk.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::facts::{Kind, kind};
use crate::mcdoc::McDoc;
use crate::tree::CommandTree;

pub struct VersionData {
    pub version: &'static str,
    pub tree: CommandTree,
    /// Registry name (`minecraft:block`) to entry ids (`minecraft:stone`).
    pub registries: HashMap<String, HashSet<String>>,
    /// Block id to its properties and their allowed values.
    pub blocks: HashMap<String, Vec<(String, Vec<String>)>>,
    /// Data pack directory name (`loot_tables`, `worldgen/biome`) to vanilla resource ids.
    pub resources: HashMap<String, HashSet<String>>,
    /// Tag directory name (`blocks`, `entity_types`) to vanilla tag ids.
    pub tags: HashMap<String, HashSet<String>>,
    pub mcdoc: McDoc,
}

struct Source {
    version: &'static str,
    /// A commit of misode/mcmeta whose tree is the `<version>-summary` tag.
    mcmeta_commit: &'static str,
    /// A commit of the `generated` branch of SpyglassMC/vanilla-mcdoc.
    mcdoc_commit: &'static str,
}

const V1_20_4: Source = Source {
    version: "1.20.4",
    mcmeta_commit: "c85548aae6f200b4cd823bca81528eedfc790de0",
    mcdoc_commit: "5aab1da2ff00955cdb66f0d6c2a1154ef691a015",
};

/// Data pack contents that mcmeta lists among the registries, with the directory name they
/// have in a 1.20.4 data pack.
const DATA_PACK_KINDS: [(&str, &str); 23] = [
    ("advancement", "advancements"),
    ("chat_type", "chat_type"),
    ("damage_type", "damage_type"),
    ("dimension_type", "dimension_type"),
    ("loot_table", "loot_tables"),
    ("recipe", "recipes"),
    ("structure", "structures"),
    ("trim_material", "trim_material"),
    ("trim_pattern", "trim_pattern"),
    ("worldgen/biome", "worldgen/biome"),
    ("worldgen/configured_carver", "worldgen/configured_carver"),
    ("worldgen/configured_feature", "worldgen/configured_feature"),
    ("worldgen/density_function", "worldgen/density_function"),
    ("worldgen/flat_level_generator_preset", "worldgen/flat_level_generator_preset"),
    ("worldgen/multi_noise_biome_source_parameter_list", "worldgen/multi_noise_biome_source_parameter_list"),
    ("worldgen/noise", "worldgen/noise"),
    ("worldgen/noise_settings", "worldgen/noise_settings"),
    ("worldgen/placed_feature", "worldgen/placed_feature"),
    ("worldgen/processor_list", "worldgen/processor_list"),
    ("worldgen/structure", "worldgen/structure"),
    ("worldgen/structure_set", "worldgen/structure_set"),
    ("worldgen/template_pool", "worldgen/template_pool"),
    ("worldgen/world_preset", "worldgen/world_preset"),
];

/// Tag registries whose 1.20.4 data pack directory is plural (`tags/blocks`).
const PLURAL_TAG_DIRS: [(&str, &str); 5] = [
    ("block", "blocks"),
    ("entity_type", "entity_types"),
    ("fluid", "fluids"),
    ("game_event", "game_events"),
    ("item", "items"),
];

/// mcmeta keys that are neither registries of the game nor data pack contents.
const NOT_REGISTRIES: [&str; 7] = ["atlas", "block_definition", "font", "model", "texture", "datapack", "dimension"];

/// Returns the data for a game version, downloading it on first use. 1.20.3 shares the 1.20.4
/// data: the two versions have the same commands.
pub fn for_version(version: &str) -> Result<&'static VersionData, String> {
    static D1_20_4: OnceLock<VersionData> = OnceLock::new();
    let (slot, source) = match version {
        "1.20.3" | "1.20.4" => (&D1_20_4, &V1_20_4),
        _ => return Err(format!("unsupported game version '{version}'")),
    };
    if let Some(data) = slot.get() {
        return Ok(data);
    }
    // One download at a time: the temporary file of a download is named by the process.
    static LOADING: Mutex<()> = Mutex::new(());
    let _guard = LOADING.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(data) = slot.get() {
        return Ok(data);
    }
    let data = load(source)?;
    Ok(slot.get_or_init(|| data))
}

type RegistryLists = HashMap<String, Vec<String>>;
/// Block id without namespace to `[properties, default state]`.
type BlockSummary = HashMap<String, (serde_json::Map<String, Value>, Value)>;

fn load(source: &Source) -> Result<VersionData, String> {
    let dir = cache_root()?.join(format!("{}-{}", source.version, &source.mcmeta_commit[..12]));
    let mcmeta = |name: &str| format!("https://raw.githubusercontent.com/misode/mcmeta/{}/{name}/data.min.json", source.mcmeta_commit);
    let commands: Value = read_or_fetch(&dir, "commands", &mcmeta("commands"))?;
    let registries: RegistryLists = read_or_fetch(&dir, "registries", &mcmeta("registries"))?;
    let blocks: BlockSummary = read_or_fetch(&dir, "blocks", &mcmeta("blocks"))?;
    let commit = source.mcdoc_commit;
    let url = format!("https://raw.githubusercontent.com/SpyglassMC/vanilla-mcdoc/{commit}/symbols.json");
    let symbols: Value = read_or_fetch(&dir, &format!("vanilla-mcdoc-{}", &commit[..12]), &url)?;
    let mcdoc = McDoc::from_json(&symbols, source.version)?;
    from_summaries(source, &commands, &registries, &blocks, mcdoc)
}

/// `MCF_LINTER_SPARK_DATA_DIR`, or the user's cache directory of the platform.
fn cache_root() -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("MCF_LINTER_SPARK_DATA_DIR") {
        return Ok(PathBuf::from(dir));
    }
    let base = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library").join("Caches"))
    } else {
        std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
    };
    base.map(|b| b.join("mcf-linter-spark"))
        .ok_or_else(|| "cannot find a cache directory for the vanilla data; set MCF_LINTER_SPARK_DATA_DIR".to_string())
}

/// Reads `<dir>/<name>.json`, downloading it from `url` when the file is missing or unreadable. The download is written to a temporary file and renamed only after it
/// parses, so an interrupted run leaves no broken cache.
fn read_or_fetch<T: DeserializeOwned>(dir: &Path, name: &str, url: &str) -> Result<T, String> {
    let path = dir.join(format!("{name}.json"));
    if let Ok(bytes) = std::fs::read(&path)
        && let Ok(value) = serde_json::from_slice(&bytes)
    {
        return Ok(value);
    }
    let fail = |e: String| {
        format!(
            "cannot download the vanilla data from {url}: {e}. Check the network, or put the file at {} (the folder can be set with MCF_LINTER_SPARK_DATA_DIR)",
            path.display()
        )
    };
    std::fs::create_dir_all(dir).map_err(|e| fail(format!("{}: {e}", dir.display())))?;
    let tmp = dir.join(format!("{name}.json.{}.tmp", std::process::id()));
    let output = Command::new("curl")
        .args(["--fail", "--silent", "--show-error", "--location", "--max-time", "60", "--output"])
        .arg(&tmp)
        .arg(url)
        .output()
        .map_err(|e| fail(format!("cannot run curl: {e}")))?;
    if !output.status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(fail(String::from_utf8_lossy(&output.stderr).trim().to_string()));
    }
    let parsed = std::fs::read(&tmp)
        .map_err(|e| e.to_string())
        .and_then(|bytes| serde_json::from_slice::<T>(&bytes).map_err(|e| format!("unexpected content: {e}")));
    let value = match parsed {
        Ok(value) => value,
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            return Err(fail(e));
        }
    };
    std::fs::rename(&tmp, &path).map_err(|e| fail(format!("{}: {e}", path.display())))?;
    Ok(value)
}

fn from_summaries(
    source: &Source,
    commands: &Value,
    lists: &RegistryLists,
    block_props: &BlockSummary,
    mcdoc: McDoc,
) -> Result<VersionData, String> {
    let with_namespace = |ids: &[String]| -> HashSet<String> {
        ids.iter().map(|id| if id.contains(':') { id.clone() } else { format!("minecraft:{id}") }).collect()
    };

    let mut registry_sets = HashMap::new();
    let mut resources = HashMap::new();
    let mut tags = HashMap::new();
    for (key, ids) in lists {
        if key.starts_with("experiment/") || NOT_REGISTRIES.contains(&key.as_str()) {
            continue;
        }
        if let Some(registry) = key.strip_prefix("tag/") {
            let dir = PLURAL_TAG_DIRS.iter().find(|(r, _)| *r == registry).map_or(registry, |(_, d)| d);
            tags.insert(dir.to_string(), with_namespace(ids));
        } else if let Some((_, dir)) = DATA_PACK_KINDS.iter().find(|(k, _)| k == key) {
            resources.insert(dir.to_string(), with_namespace(ids));
        } else {
            registry_sets.insert(format!("minecraft:{key}"), with_namespace(ids));
        }
    }
    if let Some(tables) = resources.get_mut("loot_tables") {
        tables.insert("minecraft:empty".to_string());
    }

    // The summary lists only blocks that have properties.
    let block_ids = registry_sets.get("minecraft:block").ok_or("registries summary: no block registry")?;
    let blocks = block_ids
        .iter()
        .map(|id| {
            let props = block_props
                .get(id.strip_prefix("minecraft:").unwrap_or(id))
                .map(|(props, _)| {
                    props
                        .iter()
                        .map(|(k, v)| {
                            let values = v
                                .as_array()
                                .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                                .unwrap_or_default();
                            (k.clone(), values)
                        })
                        .collect()
                })
                .unwrap_or_default();
            (id.clone(), props)
        })
        .collect();
    let mut mcdoc = mcdoc;
    mcdoc.add_block_states(&blocks);

    Ok(VersionData {
        version: source.version,
        tree: CommandTree::from_json(commands),
        registries: registry_sets,
        blocks,
        resources,
        tags,
        mcdoc,
    })
}

impl VersionData {
    pub fn registry_has(&self, registry: &str, id: &str) -> bool {
        self.registries.get(registry).is_some_and(|s| s.contains(id))
    }

    /// The ids of a resource or tag kind that the vanilla data pack defines, for the kinds
    /// whose references resolve against it.
    pub fn vanilla(&self, k: Kind) -> Option<&HashSet<String>> {
        match k {
            kind::ADVANCEMENT => self.resources.get("advancements"),
            kind::LOOT_TABLE => self.resources.get("loot_tables"),
            kind::RECIPE => self.resources.get("recipes"),
            kind::STRUCTURE => self.resources.get("structures"),
            kind::DAMAGE_TYPE => self.resources.get("damage_type"),
            kind::DIMENSION_TYPE => self.resources.get("dimension_type"),
            kind::TEMPLATE_POOL => self.resources.get("worldgen/template_pool"),
            kind::BLOCK_TAG => self.tags.get("blocks"),
            kind::ITEM_TAG => self.tags.get("items"),
            kind::ENTITY_TYPE_TAG => self.tags.get("entity_types"),
            kind::FLUID_TAG => self.tags.get("fluids"),
            kind::DAMAGE_TYPE_TAG => self.tags.get("damage_type"),
            _ => None,
        }
    }

    /// Whether the vanilla data pack has a JSON resource or tag of this kind (`worldgen/biome`,
    /// `tag/block`).
    pub fn vanilla_json_has(&self, k: Kind, id: &str) -> bool {
        if k == kind::DIMENSION {
            return DIMENSIONS.contains(&id);
        }
        self.vanilla_json(k).is_some_and(|s| s.contains(id))
    }

    /// The vanilla ids of a data pack JSON kind other than dimensions.
    pub fn vanilla_json(&self, k: Kind) -> Option<&HashSet<String>> {
        match k.strip_prefix("tag/") {
            Some(registry) => self.tags.get(PLURAL_TAG_DIRS.iter().find(|(r, _)| *r == registry).map_or(registry, |(_, d)| d)),
            None => DATA_PACK_KINDS.iter().find(|(r, _)| *r == k).and_then(|(_, dir)| self.resources.get(*dir)),
        }
    }
}

/// The dimensions of a world without data packs.
pub const DIMENSIONS: &[&str] = &["minecraft:overworld", "minecraft:the_nether", "minecraft:the_end"];

#[cfg(test)]
mod tests {
    use super::*;

    fn summaries(registries: &str, blocks: &str) -> VersionData {
        let commands = serde_json::json!({ "type": "root", "children": {} });
        let mcdoc = McDoc::from_json(&serde_json::json!({ "mcdoc": {}, "mcdoc/dispatcher": {} }), "1.20.4").unwrap();
        from_summaries(&V1_20_4, &commands, &serde_json::from_str(registries).unwrap(), &serde_json::from_str(blocks).unwrap(), mcdoc).unwrap()
    }

    #[test]
    fn mcmeta_summaries_become_registries_resources_and_tags() {
        let d = summaries(
            r#"{
                "block": ["stone", "oak_door"],
                "command_argument_type": ["brigadier:bool"],
                "loot_table": ["chests/igloo_chest"],
                "worldgen/template_pool": ["village/plains/houses"],
                "tag/block": ["doors"],
                "tag/damage_type": ["is_fire"],
                "experiment/bundle/recipe": ["bundle"],
                "model": ["block/stone"]
            }"#,
            r#"{ "oak_door": [{ "open": ["true", "false"] }, { "open": "false" }] }"#,
        );
        assert!(d.registry_has("minecraft:block", "minecraft:stone"));
        assert!(d.registry_has("minecraft:command_argument_type", "brigadier:bool"));
        assert!(d.resources["loot_tables"].contains("minecraft:chests/igloo_chest"));
        assert!(d.resources["worldgen/template_pool"].contains("minecraft:village/plains/houses"));
        assert!(d.tags["blocks"].contains("minecraft:doors"));
        assert!(d.tags["damage_type"].contains("minecraft:is_fire"));
        assert_eq!(d.registries.len(), 2);
        assert_eq!(d.resources.len(), 2);
        assert_eq!(d.blocks["minecraft:oak_door"], vec![("open".to_string(), vec!["true".to_string(), "false".to_string()])]);
        assert!(d.blocks["minecraft:stone"].is_empty());
    }

    #[test]
    fn the_empty_loot_table_exists_without_a_file() {
        let d = summaries(r#"{ "block": ["stone"], "loot_table": ["chests/igloo_chest"] }"#, "{}");
        assert!(d.vanilla(kind::LOOT_TABLE).unwrap().contains("minecraft:empty"));
        assert!(d.vanilla_json_has(kind::LOOT_TABLE, "minecraft:empty"));
    }
}
