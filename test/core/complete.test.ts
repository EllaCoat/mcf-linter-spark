import assert from "node:assert/strict";
import { test } from "node:test";

import { compareStr } from "../../src/core/chars.ts";
import { MAX_STORAGE_KEYS, type Source, collectStoragePaths, complete, signature } from "../../src/core/complete.ts";
import { Config } from "../../src/core/config.ts";
import { forVersion, loadVersionData } from "../../src/core/data.ts";
import { type Kind, kind } from "../../src/core/facts.ts";

for (const v of ["1.20.4", "1.20.5", "1.21", "1.21.2", "1.21.4", "1.21.5", "26.3"]) await loadVersionData(v);

class Fake implements Source {
  symbols(k: Kind): string[] {
    switch (k) {
      case kind.FUNCTION:
        return ["example:item/sword/use", "example:item/bow/use", "example:tick"];
      case kind.FUNCTION_TAG:
        return ["example:item/use"];
      case kind.OBJECTIVE:
        return ["Temporary", "Const"];
      case kind.SCORE_HOLDER:
        return ["$Difficulty"];
      case kind.STORAGE:
        return ["example:temp", "api:"];
      case kind.ENTITY_TAG:
        return ["Enemy"];
      case kind.ADVANCEMENT:
        return ["example:first_join"];
      case kind.DAMAGE_TYPE:
        return ["example:magic"];
      case "enchantment":
        return ["example:sharp"];
      case "dialog":
        return ["example:menu"];
      case "slot_source":
        return ["example:hands"];
      case "worldgen/biome":
        return ["example:glade"];
      case "tag/worldgen/biome":
        return ["example:warm"];
      default:
        return [];
    }
  }

  storagePaths(storage: string): string[] {
    const out = new Map<string, Set<string>>();
    collectStoragePaths(
      [
        "data modify storage api: Argument.ID set value 1\n",
        "# @input storage api: Return.Difficulty : int\n",
        "execute store result storage api: Argument.Damage[0].Amount int 1 run say\n",
        "#   storage lib: Array: [int] @ N\n",
        "#   storage lib: Argument.BoundingCone.Angle: float\n",
        "# see storage lib: Note, then\n",
        "#   storage api: Argument.Silent? : boolean(default: false)\n",
        "#   storage api: Argument.Attacker?: int (entity id)\n",
      ].join(""),
      out,
    );
    return [...(out.get(storage) ?? [])].sort(compareStr);
  }
}

function labels(line: string): [string, number][] {
  return complete(line, forVersion("1.20.4"), new Config(), new Fake()).map((c) => [c.label, c.start]);
}

function has(line: string, label: string, start: number): boolean {
  return labels(line).some(([l, s]) => l === label && s === start);
}

function hasIn(version: string, line: string, label: string, start: number): boolean {
  return complete(line, forVersion(version), new Config(), new Fake()).some((c) => c.label === label && c.start === start);
}

test("data_pack_ids_of_resource_arguments_include_the_project", () => {
  assert.ok(has("damage @s 1 example:", "example:magic", 12));
  assert.ok(hasIn("1.21.2", "advancement grant @s only example:", "example:first_join", 26));
  assert.ok(hasIn("1.21.2", "advancement grant @s only ", "minecraft:", 26));
  assert.ok(hasIn("26.3", "summon zomb", "zombie", 7));
  assert.ok(hasIn("1.21", "enchant @s example:", "example:sharp", 11));
  assert.ok(hasIn("1.21", "enchant @s minecraft:", "minecraft:sharpness", 11));
  assert.ok(!hasIn("1.20.4", "enchant @s example:", "example:sharp", 11));
  assert.ok(hasIn("26.3", "dialog show @s example:", "example:menu", 15));
  assert.ok(hasIn("26.3", "execute if items entity @s example:", "example:hands", 27));
  assert.ok(hasIn("26.3", "execute if items entity @s weap", "weapon", 27));
  assert.ok(has("locate biome example:", "example:glade", 13));
  assert.ok(has("locate biome minecraft:pl", "minecraft:plains", 13));
  assert.ok(has("locate biome #example:", "#example:warm", 13));
  assert.ok(has("locate biome #minecraft:is_o", "#minecraft:is_ocean", 13));
});

test("literals_of_the_command_tree", () => {
  assert.ok(has("exe", "execute", 0));
  assert.ok(has("scoreboard pl", "players", 11));
  assert.ok(!has("scoreboard pl", "objectives", 11));
  assert.ok(has("execute as @s ru", "run", 14));
  assert.ok(has("execute as @s run fun", "function", 18));
});

test("selectors_and_their_options", () => {
  assert.ok(has("kill @", "@e", 5));
  assert.ok(has("kill @e[ty", "type=", 8));
  assert.ok(has("kill @e[tag=Enemy,ty", "type=", 18));
  assert.ok(has("kill @e[type=zomb", "zombie", 13));
  assert.ok(has("kill @e[type=!zomb", "zombie", 14));
  assert.ok(has("kill @e[type=#", "#skeletons", 13));
  assert.ok(has("kill @e[type=#", "#minecraft:", 13));
  assert.ok(has("kill @e[tag=", "Enemy", 12));
  assert.ok(has("execute if entity @e[scores={Te", "Temporary", 29));
  assert.ok(has("tp @a[gamemode=sur", "survival", 15));
});

test("functions_come_one_level_at_a_time", () => {
  assert.ok(has("function ", "example:", 9));
  assert.ok(has("function example:", "example:item/", 9));
  assert.ok(has("function example:", "example:tick", 9));
  assert.ok(!has("function example:", "example:item/sword/use", 9));
  assert.ok(has("function example:item/sword/", "example:item/sword/use", 9));
  assert.ok(has("function #example:", "#example:item/", 9));
});

test("symbols_follow_the_argument", () => {
  assert.ok(has("scoreboard players set @s T", "Temporary", 26));
  assert.ok(has("scoreboard players set @s temp", "Temporary", 26));
  assert.ok(has("execute if entity @e[scores={temp", "Temporary", 29));
  assert.ok(has("scoreboard players get ", "$Difficulty", 23));
  assert.ok(has("data get storage ", "example:", 17));
  assert.ok(has("data get storage example:", "example:temp", 17));
  assert.ok(has("tag @s remove E", "Enemy", 14));
  assert.deepEqual(labels("scoreboard objectives add N"), []);
});

test("vanilla_ids_with_or_without_the_namespace", () => {
  assert.ok(has("give @s diamond_sw", "diamond_sword", 8));
  assert.ok(has("give @s minecraft:diamond_sw", "minecraft:diamond_sword", 8));
  assert.ok(has("loot give @s loot chests/ig", "chests/igloo_chest", 18));
  assert.ok(has("particle fla", "flame", 9));
  assert.ok(has("effect give @s minecraft:spe", "minecraft:speed", 15));
});

test("block_states", () => {
  assert.ok(has("setblock ~ ~ ~ oak_door[fac", "facing=", 24));
  assert.ok(has("setblock ~ ~ ~ oak_door[facing=north,ha", "half=", 37));
  assert.ok(!has("setblock ~ ~ ~ oak_door[facing=north,", "facing=", 37));
  assert.ok(has("setblock ~ ~ ~ oak_door[facing=n", "north", 31));
  assert.ok(has("execute if block ~ ~ ~ #minecraft:do", "#minecraft:doors", 23));
});

test("coordinates_and_fixed_values", () => {
  assert.ok(has("tp @s ", "~ ~ ~", 6));
  assert.ok(has("tp @s ~ ", "~ ~ ~", 6));
  assert.ok(has("gamemode cr", "creative", 9));
  assert.ok(has("scoreboard players operation @s Temporary ", "+=", 42));
});

function usage(line: string): [string, string] | undefined {
  const s = signature(line, forVersion("1.20.4"), new Config());
  if (s === undefined) return undefined;
  const [a, b] = s.parts[s.active]!;
  return [s.label, s.label.slice(a, b)];
}

test("signature_shows_the_typed_nodes_and_what_follows", () => {
  assert.deepEqual(usage("scoreboard players set @s "), ["scoreboard players set <targets> <objective> <score>", "<objective>"]);
  assert.deepEqual(usage("scoreboard "), ["scoreboard (objectives|players)", "(objectives|players)"]);
  assert.deepEqual(usage("execute as @a run tp @s "), usage("tp @s "));
  assert.equal(usage("# comment"), undefined);
});

test("signature_help_stays_short_after_run_in_execute_chains_and_with_many_choices", () => {
  assert.equal(usage("execute as @a run "), undefined);
  assert.equal(usage("execute if entity @s run return run "), undefined);
  assert.equal(usage(""), undefined);
  assert.deepEqual(usage("gamerule "), ["gamerule …", "…"]);
  const execute = "execute (align|anchored|as|at|facing|if|in|on|positioned|rotated|run|store|summon|unless)";
  const next: [string, string] = [execute, execute.slice("execute ".length)];
  assert.deepEqual(usage("execute "), next);
  assert.deepEqual(usage("execute as @a at @s "), next);
  const condition = "(biome|block|blocks|data|dimension|entity|function|loaded|predicate|score)";
  assert.deepEqual(usage("execute as @a if score @s Global matches 1 if "), [`execute if ${condition}`, condition]);
  assert.deepEqual(usage("execute as @a if entity @s[tag=A] store result score @s "), [
    "execute store result score <targets> <objective>",
    "<objective>",
  ]);
});

test("signature_help_follows_the_argument_that_more_can_follow_when_two_read_the_value", () => {
  assert.deepEqual(usage("tp @s "), ["tp <targets> (<destination>|<location>)", "(<destination>|<location>)"]);
  assert.equal(usage("kill @s "), undefined);
});

test("nbt_keys_from_the_schema", () => {
  assert.ok(has("summon zombie ~ ~ ~ {NoA", "NoAI:", 21));
  assert.ok(has("summon zombie ~ ~ ~ {NoAI:1b,Hea", "Health:", 29));
  assert.ok(has("summon zombie ~ ~ ~ {ArmorItems:[{},{Cou", "Count:", 37));
  assert.ok(!has("summon zombie ~ ~ ~ {NoAI:", "NoAI:", 21));
  assert.ok(has("data merge entity @e[type=zombie,limit=1] {IsBa", "IsBaby:", 43));
  assert.ok(has("data get entity @s Inv", "Inventory", 19));
  assert.ok(has("data get entity @e[type=zombie,limit=1] ArmorItems[0].Cou", "Count", 54));
  assert.ok(has("kill @e[nbt={OnGro", "OnGround:", 13));
  assert.ok(has("give @s diamond_sword{Dam", "Damage:", 22));
  assert.ok(has("setblock ~ ~ ~ chest{Ite", "Items:", 21));
  assert.ok(has('summon armor_stand ~ ~ ~ {ArmorItems:[{},{id:"stone",tag:{Dam', "Damage:", 58));
  assert.ok(has("data modify entity @s ArmorItems[0].", "Count", 36));
});

test("item_components_and_particle_options_from_1_20_5", () => {
  assert.ok(hasIn("1.20.5", "give @s diamond_sword[dam", "damage", 22));
  assert.ok(hasIn("26.3", "give @s diamond_sword[damage=1, !enchan", "enchantments", 33));
  assert.ok(hasIn("26.3", "give @s diamond_sword[enchantments={levels:{}},custom_data={}, max_dam", "max_damage", 63));
  assert.ok(hasIn("1.20.5", "give @s diamond_sword[enchantments={lev", "levels:", 36));
  assert.ok(!hasIn("26.3", "give @s diamond_sword{Dam", "Damage:", 22));
  assert.ok(hasIn("26.3", "clear @s *[dam", "damage", 11));
  assert.ok(hasIn("26.3", "clear @s *[custom_data|cou", "count", 23));
  assert.ok(hasIn("26.3", "clear @s *[damage~{dur", "durability:", 19));
  assert.ok(hasIn("1.20.5", "clear @s *[damage~{dur", "durability:", 19));
  assert.ok(hasIn("26.3", "clear @s ", "*", 9));
  assert.ok(hasIn("26.3", "particle dust{sc", "scale:", 14));
  assert.ok(hasIn("26.3", "particle du", "dust", 9));
});

test("text_component_keys_from_1_21_5", () => {
  assert.ok(hasIn("1.21.5", "tellraw @a {te", "text:", 12));
  assert.ok(hasIn("26.3", 'tellraw @a ["a",{text:"b",bo', "bold:", 26));
  assert.ok(hasIn("26.3", "scoreboard objectives modify o numberformat styled {co", "color:", 52));
  assert.ok(!hasIn("1.21.4", "tellraw @a {te", "text:", 12));
});

test("storage_paths_used_in_the_project", () => {
  assert.ok(has("data get storage api: ", "Argument", 22));
  assert.ok(has("data get storage api: ", "Return", 22));
  assert.ok(has("data get storage api: Return.", "Difficulty", 29));
  assert.ok(has("data get storage api: Argument.Damage[0].", "Amount", 41));
  assert.ok(!has("data get storage example:temp ", "Argument", 30));
});

test("storage_paths_are_collected_up_to_the_key_limit", () => {
  const out = new Map<string, Set<string>>();
  collectStoragePaths(`data get storage a:b ${"a.".repeat(10_000)}a\n`, out);
  assert.equal(out.get("a:b")!.size, MAX_STORAGE_KEYS);
});

test("storage_paths_as_imp_doc_lines_write_them", () => {
  assert.ok(has("data get storage lib: ", "Array", 22));
  assert.ok(!has("data get storage lib: ", "Array:", 22));
  assert.ok(has("data get storage lib: Argument.BoundingCone.", "Angle", 44));
  assert.ok(!has("data get storage lib: Argument.BoundingCone.", "Angle:", 44));
  assert.ok(!has("data get storage lib: ", "Note,", 22));
  assert.ok(has("data get storage lib: Arr", "Array", 22));
  assert.ok(has("data get storage lib: Array", "Array", 22));
  assert.ok(has("data get storage api: Return.Difficulty", "Difficulty", 29));
  assert.ok(has("data get storage api: Argument.", "Silent", 31));
  assert.ok(has("data get storage api: Argument.", "Attacker", 31));
  assert.ok(!has("data get storage api: Argument.", "Silent?", 31));
});

test("indented_macro_and_comment_lines", () => {
  assert.ok(has("    function example:", "example:tick", 13));
  assert.ok(has("$function example:", "example:tick", 10));
  assert.deepEqual(labels("# function example:"), []);
  assert.deepEqual(labels("#> example:"), []);
});
