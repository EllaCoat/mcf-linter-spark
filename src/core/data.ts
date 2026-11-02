// Vanilla data for one game version. The command tree, registries, block states, and the
// lists of vanilla data pack contents come from the summary of misode/mcmeta, and the schema of
// data pack JSON and NBT from vanilla-mcdoc; both are downloaded on first use and cached on disk.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SparkError } from "./diag.ts";
import { type Kind, kind } from "./facts.ts";
import { type JsonObject, type JsonValue, asArray, asObject, isObject, sortedEntries } from "./json-value.ts";
import { McDoc, stripMinecraft } from "./mcdoc.ts";
import { CommandTree } from "./tree.ts";
import { RELEASES, cmp, parse, releaseIndex } from "./version.ts";

export class VersionData {
  readonly version: string;
  /** `version` as numbers, for `atLeast`. */
  private readonly release: number[];
  readonly tree: CommandTree;
  /** Registry name (`minecraft:block`) to entry ids (`minecraft:stone`). Data pack contents
   * (`minecraft:loot_table`, `minecraft:worldgen/biome`) list the vanilla data pack's ids. */
  readonly registries: Map<string, Set<string>>;
  /** Block id to its properties and their allowed values. */
  readonly blocks: Map<string, [string, string[]][]>;
  /** Tag registry (`block`, `worldgen/biome`) to vanilla tag ids. */
  readonly tags: Map<string, Set<string>>;
  readonly mcdoc: McDoc;
  /** The data pack kinds the version reads: the file kinds, and `tag/<registry>` for every
   * registry. */
  private readonly kinds: Set<Kind>;

  constructor(fields: {
    version: string;
    release: number[];
    tree: CommandTree;
    registries: Map<string, Set<string>>;
    blocks: Map<string, [string, string[]][]>;
    tags: Map<string, Set<string>>;
    mcdoc: McDoc;
    kinds: Set<Kind>;
  }) {
    this.version = fields.version;
    this.release = fields.release;
    this.tree = fields.tree;
    this.registries = fields.registries;
    this.blocks = fields.blocks;
    this.tags = fields.tags;
    this.mcdoc = fields.mcdoc;
    this.kinds = fields.kinds;
  }

  /** Whether the version is `v` (`[1, 21]`) or later. */
  atLeast(v: readonly number[]): boolean {
    return cmp(this.release, v) >= 0;
  }

  registryHas(registry: string, id: string): boolean {
    return this.registries.get(registry)?.has(id) ?? false;
  }

  /** The data pack kind named like a registry (`loot_table`, `tag/block`), if the version reads
   * files of it. */
  fileKind(name: string): Kind | undefined {
    return this.kinds.has(name) ? name : undefined;
  }

  /** Whether the vanilla data pack has a JSON resource or tag of this kind (`worldgen/biome`,
   * `tag/block`). */
  vanillaJsonHas(k: Kind, id: string): boolean {
    if (k === kind.DIMENSION) return DIMENSIONS.includes(id);
    return this.vanillaJson(k)?.has(id) ?? false;
  }

  /** The vanilla ids of a data pack JSON kind other than dimensions. */
  vanillaJson(k: Kind): Set<string> | undefined {
    return k.startsWith("tag/") ? this.tags.get(k.slice("tag/".length)) : this.registries.get(`minecraft:${k}`);
  }
}

/** Data pack contents that the game reads through its registries, by registry (which is also the
 * directory under `data/<ns>/`), with the release that started reading them and the one that
 * stopped ("" for none). From `RegistryDataLoader` and the `since` / `until` of vanilla-mcdoc. */
const REGISTRY_KINDS: readonly (readonly [Kind, string, string])[] = [
  ["chat_type", "", ""],
  ["damage_type", "", ""],
  ["dimension", "", ""],
  ["dimension_type", "", ""],
  ["trim_material", "", ""],
  ["trim_pattern", "", ""],
  ["worldgen/biome", "", ""],
  ["worldgen/configured_carver", "", "26.3"],
  ["worldgen/configured_feature", "", "26.3"],
  ["worldgen/density_function", "", ""],
  ["worldgen/flat_level_generator_preset", "", ""],
  ["worldgen/multi_noise_biome_source_parameter_list", "", ""],
  ["worldgen/noise", "", ""],
  ["worldgen/noise_settings", "", ""],
  ["worldgen/placed_feature", "", ""],
  ["worldgen/processor_list", "", ""],
  ["worldgen/structure", "", ""],
  ["worldgen/structure_set", "", ""],
  ["worldgen/template_pool", "", ""],
  ["worldgen/world_preset", "", ""],
  ["banner_pattern", "1.20.5", ""],
  ["wolf_variant", "1.20.5", ""],
  ["enchantment", "1.21", ""],
  ["enchantment_provider", "1.21", ""],
  ["jukebox_song", "1.21", ""],
  ["painting_variant", "1.21", ""],
  ["instrument", "1.21.2", ""],
  ["trial_spawner", "1.21.2", ""],
  ["cat_variant", "1.21.5", ""],
  ["chicken_variant", "1.21.5", ""],
  ["cow_variant", "1.21.5", ""],
  ["frog_variant", "1.21.5", ""],
  ["pig_variant", "1.21.5", ""],
  ["wolf_sound_variant", "1.21.5", ""],
  ["test_environment", "1.21.5", ""],
  ["test_instance", "1.21.5", ""],
  ["dialog", "1.21.6", ""],
  ["timeline", "1.21.11", ""],
  ["zombie_nautilus_variant", "1.21.11", ""],
  ["cat_sound_variant", "26.1", ""],
  ["chicken_sound_variant", "26.1", ""],
  ["cow_sound_variant", "26.1", ""],
  ["pig_sound_variant", "26.1", ""],
  ["trade_set", "26.1", ""],
  ["villager_trade", "26.1", ""],
  ["world_clock", "26.1", ""],
  ["sulfur_cube_archetype", "26.2", ""],
  ["block_transformer", "26.3", ""],
  ["context_float_provider", "26.3", ""],
  ["context_int_provider", "26.3", ""],
  ["decorated_pot_pattern", "26.3", ""],
  ["slot_source", "26.3", ""],
  ["worldgen/block_state_provider", "26.3", ""],
  ["worldgen/carver", "26.3", ""],
  ["worldgen/feature", "26.3", ""],
  ["worldgen/material_condition", "26.3", ""],
  ["worldgen/material_rule", "26.3", ""],
];

const STRUCTURES_1_21 = [
  "ancient_city", "bastion_remnant", "buried_treasure", "desert_pyramid", "end_city", "fortress", "igloo", "jungle_pyramid",
  "mansion", "mineshaft", "mineshaft_mesa", "monument", "nether_fossil", "ocean_ruin_cold", "ocean_ruin_warm", "pillager_outpost",
  "ruined_portal", "ruined_portal_desert", "ruined_portal_jungle", "ruined_portal_mountain", "ruined_portal_nether",
  "ruined_portal_ocean", "ruined_portal_swamp", "shipwreck", "shipwreck_beached", "stronghold", "swamp_hut", "trail_ruins",
  "trial_chambers", "village_desert", "village_plains", "village_savanna", "village_snowy", "village_taiga",
];

const STRUCTURE_TAGS_1_21 = [
  "cats_spawn_as_black", "cats_spawn_in", "dolphin_located", "eye_of_ender_located", "mineshaft", "ocean_ruin",
  "on_ocean_explorer_maps", "on_treasure_maps", "on_trial_chambers_maps", "on_woodland_explorer_maps", "ruined_portal",
  "shipwreck", "village",
];

/** The kinds whose directory took a singular name in 1.21 (`project::RENAMED_DIRS`). */
const RENAMED_KINDS: readonly Kind[] = [
  kind.FUNCTION,
  kind.FUNCTION_TAG,
  kind.ADVANCEMENT,
  kind.LOOT_TABLE,
  kind.PREDICATE,
  kind.RECIPE,
  kind.ITEM_MODIFIER,
  kind.STRUCTURE,
];

/** A commit of the `generated` branch of SpyglassMC/vanilla-mcdoc. One file covers every
 * version: members carry `since` / `until`. */
const MCDOC_COMMIT = "5aab1da2ff00955cdb66f0d6c2a1154ef691a015";

/** mcmeta keys that are neither registries of the game nor data pack contents. */
const NOT_REGISTRIES = ["atlas", "block_definition", "font", "model", "texture", "datapack", "dimension"];

const SLOTS: (VersionData | undefined)[] = RELEASES.map(() => undefined);
const LOADING = new Map<number, Promise<VersionData>>();
/** The loads wait for each other, so one download runs at a time. */
let queue: Promise<unknown> = Promise.resolve();

function unsupported(version: string): SparkError {
  return new SparkError(`unsupported game version '${version}' (supported: 1.20.3, ${RELEASES.map(([r]) => r).join(", ")})`);
}

/** Loads the data for a game version, downloading it on first use. The data of a version is
 * loaded once; 1.20.3 shares the 1.20.4 data. */
export async function loadVersionData(version: string): Promise<VersionData> {
  const index = releaseIndex(version);
  if (index === undefined) throw unsupported(version);
  const loaded = SLOTS[index];
  if (loaded !== undefined) return loaded;
  let pending = LOADING.get(index);
  if (pending === undefined) {
    const run = queue.then(() => load(RELEASES[index]!));
    queue = run.catch(() => undefined);
    pending = run.then(
      (data) => {
        SLOTS[index] = data;
        LOADING.delete(index);
        return data;
      },
      (e: unknown) => {
        LOADING.delete(index);
        throw e;
      },
    );
    LOADING.set(index, pending);
  }
  return pending;
}

/** The data of a game version that `loadVersionData` has loaded. */
export function forVersion(version: string): VersionData {
  const index = releaseIndex(version);
  if (index === undefined) throw unsupported(version);
  const data = SLOTS[index];
  if (data === undefined) throw new SparkError(`the vanilla data for game version '${version}' is not loaded; call loadVersionData first`);
  return data;
}

export type RegistryLists = Map<string, string[]>;
/** Block id without namespace to `[properties, default state]`. */
export type BlockSummary = Map<string, [JsonObject, JsonValue]>;

async function load([version, mcmetaCommit]: readonly [string, string]): Promise<VersionData> {
  const dir = join(cacheRoot(), `${version}-${mcmetaCommit.slice(0, 12)}`);
  const mcmeta = (name: string) => `https://raw.githubusercontent.com/misode/mcmeta/${mcmetaCommit}/${name}/data.min.json`;
  const commands = await readOrFetch(dir, "commands", mcmeta("commands"), (v) => v);
  const registries = await readOrFetch(dir, "registries", mcmeta("registries"), registryLists);
  const blocks = await readOrFetch(dir, "blocks", mcmeta("blocks"), blockSummary);
  const url = `https://raw.githubusercontent.com/SpyglassMC/vanilla-mcdoc/${MCDOC_COMMIT}/symbols.json`;
  const symbols = await readOrFetch(dir, `vanilla-mcdoc-${MCDOC_COMMIT.slice(0, 12)}`, url, (v) => v);
  const mcdoc = McDoc.fromJson(symbols, version);
  return fromSummaries(version, commands, registries, blocks, mcdoc);
}

/** `MCF_LINTER_SPARK_DATA_DIR`, or the user's cache directory of the platform. */
function cacheRoot(): string {
  const dir = process.env["MCF_LINTER_SPARK_DATA_DIR"];
  if (dir !== undefined) return dir;
  let base: string | undefined;
  if (process.platform === "win32") base = process.env["LOCALAPPDATA"];
  else if (process.platform === "darwin") {
    const home = process.env["HOME"];
    base = home === undefined ? undefined : join(home, "Library", "Caches");
  } else {
    const xdg = process.env["XDG_CACHE_HOME"];
    const home = process.env["HOME"];
    base = xdg ?? (home === undefined ? undefined : join(home, ".cache"));
  }
  if (base === undefined) throw new SparkError("cannot find a cache directory for the vanilla data; set MCF_LINTER_SPARK_DATA_DIR");
  return join(base, "mcf-linter-spark");
}

/** The JSON in `bytes` as `convert` reads it, or why it cannot be. */
function decode<T>(bytes: Uint8Array, convert: (v: JsonValue) => T | undefined): { value: T } | { error: string } {
  let json: JsonValue;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)) as JsonValue;
  } catch (e) {
    return { error: `unexpected content: ${errorText(e)}` };
  }
  const value = convert(json);
  return value === undefined ? { error: "unexpected content: the JSON has another shape than expected" } : { value };
}

function errorText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause instanceof Error ? `: ${e.cause.message}` : "";
  return e.message + cause;
}

/** Reads `<dir>/<name>.json`, downloading it from `url` when the file is missing or unreadable.
 * The download is written to a temporary file and renamed only after it parses, so an
 * interrupted run leaves no broken cache. */
async function readOrFetch<T>(dir: string, name: string, url: string, convert: (v: JsonValue) => T | undefined): Promise<T> {
  const path = join(dir, `${name}.json`);
  try {
    const cached = decode(readFileSync(path), convert);
    if ("value" in cached) return cached.value;
  } catch {
    // missing or unreadable: download it
  }
  const fail = (e: string) =>
    new SparkError(
      `cannot download the vanilla data from ${url}: ${e}. Check the network, or put the file at ${path} (the folder can be set with MCF_LINTER_SPARK_DATA_DIR)`,
    );
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw fail(`${dir}: ${errorText(e)}`);
  }
  const tmp = join(dir, `${name}.json.${process.pid}.tmp`);
  let bytes: Buffer;
  try {
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`the server answered ${response.status} ${response.statusText}`.trim());
    bytes = Buffer.from(await response.arrayBuffer());
    writeFileSync(tmp, bytes);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw fail(errorText(e));
  }
  const parsed = decode(bytes, convert);
  if ("error" in parsed) {
    rmSync(tmp, { force: true });
    throw fail(parsed.error);
  }
  try {
    renameSync(tmp, path);
  } catch (e) {
    throw fail(`${path}: ${errorText(e)}`);
  }
  return parsed.value;
}

/** `HashMap<String, Vec<String>>`: an object of arrays of strings. */
export function registryLists(v: JsonValue): RegistryLists | undefined {
  const o = asObject(v);
  if (o === undefined) return undefined;
  const out: RegistryLists = new Map();
  for (const [key, ids] of sortedEntries(o)) {
    const list = asArray(ids);
    if (list === undefined || !list.every((x) => typeof x === "string")) return undefined;
    out.set(key, list as string[]);
  }
  return out;
}

/** `HashMap<String, (Map<String, Value>, Value)>`: an object of two-element arrays. */
export function blockSummary(v: JsonValue): BlockSummary | undefined {
  const o = asObject(v);
  if (o === undefined) return undefined;
  const out: BlockSummary = new Map();
  for (const [id, entry] of sortedEntries(o)) {
    const pair = asArray(entry);
    if (pair === undefined || pair.length !== 2 || !isObject(pair[0])) return undefined;
    out.set(id, [pair[0], pair[1]!]);
  }
  return out;
}

export function fromSummaries(version: string, commands: JsonValue, lists: RegistryLists, blockProps: BlockSummary, mcdoc: McDoc): VersionData {
  const withNamespace = (ids: readonly string[]): Set<string> => new Set(ids.map((id) => (id.includes(":") ? id : `minecraft:${id}`)));

  const registrySets = new Map<string, Set<string>>();
  const tags = new Map<string, Set<string>>();
  for (const [key, ids] of lists) {
    if (key.startsWith("experiment/") || NOT_REGISTRIES.includes(key)) continue;
    if (key.startsWith("tag/")) tags.set(key.slice("tag/".length), withNamespace(ids));
    else registrySets.set(`minecraft:${key}`, withNamespace(ids));
  }
  registrySets.get("minecraft:loot_table")?.add("minecraft:empty");
  if (version === "1.21" || version === "1.21.1") {
    const ids = (names: readonly string[]) => names.map((n) => `minecraft:${n}`);
    let structures = registrySets.get("minecraft:worldgen/structure");
    if (structures === undefined) {
      structures = new Set();
      registrySets.set("minecraft:worldgen/structure", structures);
    }
    for (const id of ids(STRUCTURES_1_21)) structures.add(id);
    let structureTags = tags.get("worldgen/structure");
    if (structureTags === undefined) {
      structureTags = new Set();
      tags.set("worldgen/structure", structureTags);
    }
    for (const id of ids(STRUCTURE_TAGS_1_21)) structureTags.add(id);
  }

  // The summary lists only blocks that have properties.
  const blockIds = registrySets.get("minecraft:block");
  if (blockIds === undefined) throw new SparkError("registries summary: no block registry");
  const blocks = new Map<string, [string, string[]][]>();
  for (const id of blockIds) {
    const props: [string, string[]][] = [];
    const found = blockProps.get(stripMinecraft(id));
    if (found !== undefined) {
      for (const [k, v] of sortedEntries(found[0])) {
        const values: string[] = [];
        for (const x of asArray(v) ?? []) {
          if (typeof x === "string") values.push(x);
        }
        props.push([k, values]);
      }
    }
    blocks.set(id, props);
  }
  mcdoc.addBlockStates(blocks);

  const release = parse(version);
  const reads = (v: string) => v === "" || cmp(release, parse(v)) >= 0;
  const kinds = new Set<Kind>(RENAMED_KINDS);
  for (const [k, since, until] of REGISTRY_KINDS) {
    if (reads(since) && (until === "" || !reads(until))) kinds.add(k);
  }
  const tagged: string[] = [];
  for (const r of registrySets.keys()) {
    let name = r;
    while (name.startsWith("minecraft:")) name = name.slice("minecraft:".length);
    tagged.push(name);
  }
  for (const k of kinds) {
    if (!k.startsWith("tag/")) tagged.push(k);
  }
  for (const registry of tagged) kinds.add(`tag/${registry}`);

  return new VersionData({ version, release, tree: CommandTree.fromJson(commands), registries: registrySets, blocks, tags, mcdoc, kinds });
}

/** The dimensions of a world without data packs. */
export const DIMENSIONS: readonly string[] = ["minecraft:overworld", "minecraft:the_nether", "minecraft:the_end"];
