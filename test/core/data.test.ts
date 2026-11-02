import assert from "node:assert/strict";
import { test } from "node:test";

import { SparkError } from "../../src/core/diag.ts";
import { type VersionData, blockSummary, forVersion, fromSummaries, loadVersionData, registryLists } from "../../src/core/data.ts";
import { kind } from "../../src/core/facts.ts";
import { McDoc } from "../../src/core/mcdoc.ts";
import { ROOT, hasChildren } from "../../src/core/tree.ts";
import { RELEASES } from "../../src/core/version.ts";

function summaries(registries: string, blocks: string): VersionData {
  const commands = { type: "root", children: {} };
  const mcdoc = McDoc.fromJson({ mcdoc: {}, "mcdoc/dispatcher": {} }, "1.20.4");
  return fromSummaries("1.20.4", commands, registryLists(JSON.parse(registries))!, blockSummary(JSON.parse(blocks))!, mcdoc);
}

// Not in the Rust tests: `for_version` loaded the data itself. This one runs before any load.
test("for_version_needs_the_data_loaded", () => {
  assert.throws(() => forVersion("26.3"), /not loaded/);
  assert.throws(() => forVersion("1.20.2"), /unsupported game version '1\.20\.2' \(supported: 1\.20\.3, 1\.20\.4, /);
});

test("mcmeta_summaries_become_registries_and_tags", () => {
  const d = summaries(
    `{
                "block": ["stone", "oak_door"],
                "command_argument_type": ["brigadier:bool"],
                "loot_table": ["chests/igloo_chest"],
                "worldgen/template_pool": ["village/plains/houses"],
                "tag/block": ["doors"],
                "tag/damage_type": ["is_fire"],
                "experiment/bundle/recipe": ["bundle"],
                "model": ["block/stone"]
            }`,
    `{ "oak_door": [{ "open": ["true", "false"] }, { "open": "false" }] }`,
  );
  assert.ok(d.registryHas("minecraft:block", "minecraft:stone"));
  assert.ok(d.registryHas("minecraft:command_argument_type", "brigadier:bool"));
  assert.ok(d.vanillaJsonHas(kind.LOOT_TABLE, "minecraft:chests/igloo_chest"));
  assert.ok(d.vanillaJsonHas(kind.TEMPLATE_POOL, "minecraft:village/plains/houses"));
  assert.ok(d.vanillaJsonHas(kind.BLOCK_TAG, "minecraft:doors"));
  assert.ok(d.tags.get("damage_type")!.has("minecraft:is_fire"));
  assert.equal(d.registries.size, 4);
  assert.deepEqual(d.blocks.get("minecraft:oak_door"), [["open", ["true", "false"]]]);
  assert.deepEqual(d.blocks.get("minecraft:stone"), []);
});

test("every_release_loads_its_own_data", async () => {
  for (const [version] of RELEASES) {
    const d = await loadVersionData(version);
    assert.equal(d.version, version);
    assert.ok(d.registryHas("minecraft:block", "minecraft:stone"), version);
    assert.ok(hasChildren(d.tree.node(ROOT)), version);
    assert.equal(forVersion(version), d);
  }
  assert.equal(await loadVersionData("1.20.3"), await loadVersionData("1.20.4"));
  assert.equal(forVersion("1.20.3"), forVersion("1.20.4"));
  await assert.rejects(loadVersionData("1.20.2"), SparkError);
  assert.throws(() => forVersion("1.20.2"), SparkError);
});

test("vanilla_structures_of_every_release_resolve", async () => {
  for (const [version] of RELEASES) {
    const d = await loadVersionData(version);
    assert.ok(d.vanillaJsonHas("worldgen/structure", "minecraft:village_plains"), version);
    assert.ok(d.vanillaJsonHas("tag/worldgen/structure", "minecraft:village"), version);
  }
});

test("the_empty_loot_table_exists_without_a_file", () => {
  const d = summaries(`{ "block": ["stone"], "loot_table": ["chests/igloo_chest"] }`, "{}");
  assert.ok(d.vanillaJsonHas(kind.LOOT_TABLE, "minecraft:empty"));
});
