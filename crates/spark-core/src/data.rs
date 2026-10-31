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
use crate::version::{RELEASES, release_index};

pub struct VersionData {
    pub version: &'static str,
    /// `version` as numbers, for `at_least`.
    release: Vec<u32>,
    pub tree: CommandTree,
    /// Registry name (`minecraft:block`) to entry ids (`minecraft:stone`). Data pack contents
    /// (`minecraft:loot_table`, `minecraft:worldgen/biome`) list the vanilla data pack's ids.
    pub registries: HashMap<String, HashSet<String>>,
    /// Block id to its properties and their allowed values.
    pub blocks: HashMap<String, Vec<(String, Vec<String>)>>,
    /// Tag registry (`block`, `worldgen/biome`) to vanilla tag ids.
    pub tags: HashMap<String, HashSet<String>>,
    pub mcdoc: McDoc,
    /// The data pack kinds the version reads: the file kinds, and `tag/<registry>` for every
    /// registry.
    kinds: HashSet<Kind>,
}

/// Data pack contents that the game reads through its registries, by registry (which is also the
/// directory under `data/<ns>/`), with the release that started reading them and the one that
/// stopped ("" for none). From `RegistryDataLoader` and the `since` / `until` of vanilla-mcdoc.
const REGISTRY_KINDS: &[(Kind, &str, &str)] = &[
    ("chat_type", "", ""),
    ("damage_type", "", ""),
    ("dimension", "", ""),
    ("dimension_type", "", ""),
    ("trim_material", "", ""),
    ("trim_pattern", "", ""),
    ("worldgen/biome", "", ""),
    ("worldgen/configured_carver", "", "26.3"),
    ("worldgen/configured_feature", "", "26.3"),
    ("worldgen/density_function", "", ""),
    ("worldgen/flat_level_generator_preset", "", ""),
    ("worldgen/multi_noise_biome_source_parameter_list", "", ""),
    ("worldgen/noise", "", ""),
    ("worldgen/noise_settings", "", ""),
    ("worldgen/placed_feature", "", ""),
    ("worldgen/processor_list", "", ""),
    ("worldgen/structure", "", ""),
    ("worldgen/structure_set", "", ""),
    ("worldgen/template_pool", "", ""),
    ("worldgen/world_preset", "", ""),
    ("banner_pattern", "1.20.5", ""),
    ("wolf_variant", "1.20.5", ""),
    ("enchantment", "1.21", ""),
    ("enchantment_provider", "1.21", ""),
    ("jukebox_song", "1.21", ""),
    ("painting_variant", "1.21", ""),
    ("instrument", "1.21.2", ""),
    ("trial_spawner", "1.21.2", ""),
    ("cat_variant", "1.21.5", ""),
    ("chicken_variant", "1.21.5", ""),
    ("cow_variant", "1.21.5", ""),
    ("frog_variant", "1.21.5", ""),
    ("pig_variant", "1.21.5", ""),
    ("wolf_sound_variant", "1.21.5", ""),
    ("test_environment", "1.21.5", ""),
    ("test_instance", "1.21.5", ""),
    ("dialog", "1.21.6", ""),
    ("timeline", "1.21.11", ""),
    ("zombie_nautilus_variant", "1.21.11", ""),
    ("cat_sound_variant", "26.1", ""),
    ("chicken_sound_variant", "26.1", ""),
    ("cow_sound_variant", "26.1", ""),
    ("pig_sound_variant", "26.1", ""),
    ("trade_set", "26.1", ""),
    ("villager_trade", "26.1", ""),
    ("world_clock", "26.1", ""),
    ("sulfur_cube_archetype", "26.2", ""),
    ("block_transformer", "26.3", ""),
    ("context_float_provider", "26.3", ""),
    ("context_int_provider", "26.3", ""),
    ("decorated_pot_pattern", "26.3", ""),
    ("slot_source", "26.3", ""),
    ("worldgen/block_state_provider", "26.3", ""),
    ("worldgen/carver", "26.3", ""),
    ("worldgen/feature", "26.3", ""),
    ("worldgen/material_condition", "26.3", ""),
    ("worldgen/material_rule", "26.3", ""),
];

const STRUCTURES_1_21: &[&str] = &[
    "ancient_city", "bastion_remnant", "buried_treasure", "desert_pyramid", "end_city", "fortress", "igloo", "jungle_pyramid",
    "mansion", "mineshaft", "mineshaft_mesa", "monument", "nether_fossil", "ocean_ruin_cold", "ocean_ruin_warm", "pillager_outpost",
    "ruined_portal", "ruined_portal_desert", "ruined_portal_jungle", "ruined_portal_mountain", "ruined_portal_nether",
    "ruined_portal_ocean", "ruined_portal_swamp", "shipwreck", "shipwreck_beached", "stronghold", "swamp_hut", "trail_ruins",
    "trial_chambers", "village_desert", "village_plains", "village_savanna", "village_snowy", "village_taiga",
];

const STRUCTURE_TAGS_1_21: &[&str] = &[
    "cats_spawn_as_black", "cats_spawn_in", "dolphin_located", "eye_of_ender_located", "mineshaft", "ocean_ruin",
    "on_ocean_explorer_maps", "on_treasure_maps", "on_trial_chambers_maps", "on_woodland_explorer_maps", "ruined_portal",
    "shipwreck", "village",
];

/// The kinds whose directory took a singular name in 1.21 (`project::RENAMED_DIRS`).
const RENAMED_KINDS: [Kind; 8] = [
    kind::FUNCTION,
    kind::FUNCTION_TAG,
    kind::ADVANCEMENT,
    kind::LOOT_TABLE,
    kind::PREDICATE,
    kind::RECIPE,
    kind::ITEM_MODIFIER,
    kind::STRUCTURE,
];

/// A commit of the `generated` branch of SpyglassMC/vanilla-mcdoc. One file covers every
/// version: members carry `since` / `until`.
const MCDOC_COMMIT: &str = "5aab1da2ff00955cdb66f0d6c2a1154ef691a015";

/// mcmeta keys that are neither registries of the game nor data pack contents.
const NOT_REGISTRIES: [&str; 7] = ["atlas", "block_definition", "font", "model", "texture", "datapack", "dimension"];

/// Returns the data for a game version, downloading it on first use.
pub fn for_version(version: &str) -> Result<&'static VersionData, String> {
    static SLOTS: [OnceLock<VersionData>; RELEASES.len()] = [const { OnceLock::new() }; RELEASES.len()];
    let Some(index) = release_index(version) else {
        return Err(format!("unsupported game version '{version}' (supported: 1.20.3, {})", RELEASES.map(|(r, _)| r).join(", ")));
    };
    let slot = &SLOTS[index];
    if let Some(data) = slot.get() {
        return Ok(data);
    }
    // One download at a time: the temporary file of a download is named by the process.
    static LOADING: Mutex<()> = Mutex::new(());
    let _guard = LOADING.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(data) = slot.get() {
        return Ok(data);
    }
    let data = load(RELEASES[index])?;
    Ok(slot.get_or_init(|| data))
}

type RegistryLists = HashMap<String, Vec<String>>;
/// Block id without namespace to `[properties, default state]`.
type BlockSummary = HashMap<String, (serde_json::Map<String, Value>, Value)>;

fn load((version, mcmeta_commit): (&'static str, &str)) -> Result<VersionData, String> {
    let dir = cache_root()?.join(format!("{version}-{}", &mcmeta_commit[..12]));
    let mcmeta = |name: &str| format!("https://raw.githubusercontent.com/misode/mcmeta/{mcmeta_commit}/{name}/data.min.json");
    let commands: Value = read_or_fetch(&dir, "commands", &mcmeta("commands"))?;
    let registries: RegistryLists = read_or_fetch(&dir, "registries", &mcmeta("registries"))?;
    let blocks: BlockSummary = read_or_fetch(&dir, "blocks", &mcmeta("blocks"))?;
    let url = format!("https://raw.githubusercontent.com/SpyglassMC/vanilla-mcdoc/{MCDOC_COMMIT}/symbols.json");
    let symbols: Value = read_or_fetch(&dir, &format!("vanilla-mcdoc-{}", &MCDOC_COMMIT[..12]), &url)?;
    let mcdoc = McDoc::from_json(&symbols, version)?;
    from_summaries(version, &commands, &registries, &blocks, mcdoc)
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
    version: &'static str,
    commands: &Value,
    lists: &RegistryLists,
    block_props: &BlockSummary,
    mcdoc: McDoc,
) -> Result<VersionData, String> {
    let with_namespace = |ids: &[String]| -> HashSet<String> {
        ids.iter().map(|id| if id.contains(':') { id.clone() } else { format!("minecraft:{id}") }).collect()
    };

    let mut registry_sets = HashMap::new();
    let mut tags = HashMap::new();
    for (key, ids) in lists {
        if key.starts_with("experiment/") || NOT_REGISTRIES.contains(&key.as_str()) {
            continue;
        }
        match key.strip_prefix("tag/") {
            Some(registry) => tags.insert(registry.to_string(), with_namespace(ids)),
            None => registry_sets.insert(format!("minecraft:{key}"), with_namespace(ids)),
        };
    }
    if let Some(tables) = registry_sets.get_mut("minecraft:loot_table") {
        tables.insert("minecraft:empty".to_string());
    }
    if matches!(version, "1.21" | "1.21.1") {
        let ids = |names: &[&str]| names.iter().map(|n| format!("minecraft:{n}")).collect::<Vec<_>>();
        registry_sets.entry("minecraft:worldgen/structure".to_string()).or_default().extend(ids(STRUCTURES_1_21));
        tags.entry("worldgen/structure".to_string()).or_default().extend(ids(STRUCTURE_TAGS_1_21));
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

    let release = crate::version::parse(version);
    let reads = |v: &str| v.is_empty() || crate::version::cmp(&release, &crate::version::parse(v)).is_ge();
    let mut kinds: HashSet<Kind> = RENAMED_KINDS.into_iter().collect();
    kinds.extend(REGISTRY_KINDS.iter().filter(|(_, since, until)| reads(since) && (until.is_empty() || !reads(until))).map(|(k, _, _)| *k));
    let tagged: Vec<String> = registry_sets
        .keys()
        .map(|r| r.trim_start_matches("minecraft:").to_string())
        .chain(kinds.iter().filter(|k| !k.starts_with("tag/")).map(|k| k.to_string()))
        .collect();
    for registry in tagged {
        let name = format!("tag/{registry}");
        if !kinds.contains(name.as_str()) {
            // Kinds are `&'static str`, and the data of a version lives as long as the process.
            kinds.insert(Box::leak(name.into_boxed_str()));
        }
    }

    Ok(VersionData {
        version,
        release,
        tree: CommandTree::from_json(commands),
        registries: registry_sets,
        blocks,
        tags,
        mcdoc,
        kinds,
    })
}

impl VersionData {
    /// Whether the version is `v` (`[1, 21]`) or later.
    pub fn at_least(&self, v: &[u32]) -> bool {
        crate::version::cmp(&self.release, v).is_ge()
    }

    pub fn registry_has(&self, registry: &str, id: &str) -> bool {
        self.registries.get(registry).is_some_and(|s| s.contains(id))
    }

    /// The data pack kind named like a registry (`loot_table`, `tag/block`), if the version reads
    /// files of it.
    pub fn file_kind(&self, name: &str) -> Option<Kind> {
        self.kinds.get(name).copied()
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
            Some(registry) => self.tags.get(registry),
            None => self.registries.get(&format!("minecraft:{k}")),
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
        from_summaries("1.20.4", &commands, &serde_json::from_str(registries).unwrap(), &serde_json::from_str(blocks).unwrap(), mcdoc).unwrap()
    }

    #[test]
    fn mcmeta_summaries_become_registries_and_tags() {
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
        assert!(d.vanilla_json_has(kind::LOOT_TABLE, "minecraft:chests/igloo_chest"));
        assert!(d.vanilla_json_has(kind::TEMPLATE_POOL, "minecraft:village/plains/houses"));
        assert!(d.vanilla_json_has(kind::BLOCK_TAG, "minecraft:doors"));
        assert!(d.tags["damage_type"].contains("minecraft:is_fire"));
        assert_eq!(d.registries.len(), 4);
        assert_eq!(d.blocks["minecraft:oak_door"], vec![("open".to_string(), vec!["true".to_string(), "false".to_string()])]);
        assert!(d.blocks["minecraft:stone"].is_empty());
    }

    #[test]
    fn every_release_loads_its_own_data() {
        for (version, _) in RELEASES {
            let d = for_version(version).unwrap();
            assert_eq!(d.version, version);
            assert!(d.registry_has("minecraft:block", "minecraft:stone"), "{version}");
            assert!(d.tree.node(crate::tree::ROOT).has_children(), "{version}");
        }
        assert!(std::ptr::eq(for_version("1.20.3").unwrap(), for_version("1.20.4").unwrap()));
        assert!(for_version("1.20.2").is_err());
    }

    #[test]
    fn vanilla_structures_of_every_release_resolve() {
        for (version, _) in RELEASES {
            let d = for_version(version).unwrap();
            assert!(d.vanilla_json_has("worldgen/structure", "minecraft:village_plains"), "{version}");
            assert!(d.vanilla_json_has("tag/worldgen/structure", "minecraft:village"), "{version}");
        }
    }

    #[test]
    fn the_empty_loot_table_exists_without_a_file() {
        let d = summaries(r#"{ "block": ["stone"], "loot_table": ["chests/igloo_chest"] }"#, "{}");
        assert!(d.vanilla_json_has(kind::LOOT_TABLE, "minecraft:empty"));
    }
}
