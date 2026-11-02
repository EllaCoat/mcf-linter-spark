import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "node:worker_threads";

import * as nbt from "../../src/core/args/nbt.ts";
import { type CommandResult, parseCommand } from "../../src/core/command.ts";
import { Config } from "../../src/core/config.ts";
import { forVersion, loadVersionData } from "../../src/core/data.ts";
import { kind } from "../../src/core/facts.ts";
import { RELEASES } from "../../src/core/version.ts";

await Promise.all(RELEASES.map(([v]) => loadVersionData(v)));

/** Parses `line` as `version` reads it, with the default settings. */
export function parseIn(version: string, line: string): CommandResult {
  return parseCommand(line, 0, forVersion(version), new Config());
}

/** The error message of `line` in `version`, or `undefined` when it parses. */
function errorIn(version: string, line: string): string | undefined {
  return parseIn(version, line).error?.message;
}

/** The diagnostics of a line that parses. */
function diagnosticsIn(version: string, line: string): string[] {
  const result = parseIn(version, line);
  assert.equal(result.error?.message, undefined, `${version}: ${line}`);
  return result.effects.flatMap((e) => (e.kind === "Diag" ? [e.diag.message] : []));
}

function refsOf(result: CommandResult): [string, string][] {
  return result.effects.flatMap((e): [string, string][] => (e.kind === "Ref" ? [[e.ref.kind, e.ref.id]] : []));
}

test("item_stacks_take_components_from_1_20_5", () => {
  assert.equal(errorIn("1.20.4", "give @s diamond{display:{Name:'\"a\"'}}"), undefined);
  assert.notEqual(errorIn("1.20.4", "give @s diamond[damage=1]"), undefined);
  assert.equal(errorIn("1.20.5", "give @s diamond_sword[damage=5,!enchantments]"), "Unknown item component 'minecraft:'");
  for (const v of ["1.21", "1.21.5", "26.3"]) {
    assert.equal(errorIn(v, "give @s diamond_sword[damage=5,!enchantments, unbreakable={}]"), undefined, v);
  }
  for (const v of ["1.20.5", "1.21.4", "1.21.5", "26.3"]) {
    assert.equal(errorIn(v, "give @s diamond_sword[damage=5, unbreakable={}]"), undefined, v);
    assert.equal(errorIn(v, "give @s diamond_sword[ damage = 5 ]"), undefined, v);
    assert.notEqual(errorIn(v, "give @s diamond{a:1}"), undefined, v);
    assert.equal(errorIn(v, "give @s diamond[foo=1]"), "Unknown item component 'minecraft:foo'", v);
    assert.equal(errorIn(v, "give @s diamond[damage=1,damage=2]"), "Item component 'minecraft:damage' was repeated, but only one value can be specified", v);
    assert.equal(errorIn(v, "give @s diamond[damage=1,]"), undefined, v);
    assert.equal(errorIn(v, "give @s diamond[damage=1,"), "Expected item component", v);
    assert.deepEqual(diagnosticsIn(v, "give @s diamond[damage='a']"), ["Expected an int tag but got a string tag"], v);
    assert.deepEqual(diagnosticsIn(v, "give @s diamond[damage=1b]"), ["Expected an int tag but got a byte tag (rule: “nbtTypeCheck”)"], v);
    assert.deepEqual(diagnosticsIn(v, "give @s apple[food={nutrition:1}]"), ["Missing key “saturation”"], v);
  }
});

test("item_predicates_test_components_from_1_20_5", () => {
  assert.equal(errorIn("1.20.4", "clear @s #minecraft:swords{Damage:1}"), undefined);
  assert.notEqual(errorIn("1.20.4", "clear @s *"), undefined);
  for (const v of ["1.20.5", "1.21.4", "1.21.5", "26.3"]) {
    assert.equal(errorIn(v, "clear @s *[damage=1|!custom_data,count~{min:1}]"), undefined, v);
    assert.equal(errorIn(v, "clear @s #minecraft:swords[minecraft:damage~{durability:{min:1}}]"), undefined, v);
    assert.equal(errorIn(v, "clear @s stone[count=2]"), undefined, v);
    assert.equal(errorIn(v, "clear @s *[custom_data~{}]"), undefined, v);
    assert.equal(errorIn(v, "clear @s *[bar]"), "Unknown item component 'minecraft:bar'", v);
    assert.equal(errorIn(v, "clear @s *[bar~{}]"), "Unknown item predicate 'minecraft:bar'", v);
    assert.equal(errorIn(v, "clear @s *[ damage=1 , count=1 ]"), undefined, v);
    assert.equal(errorIn(v, "clear @s * [damage=1] 3"), undefined, v);
    assert.equal(errorIn(v, "clear @s *[]"), undefined, v);
    assert.notEqual(errorIn(v, "clear @s *[damage=1,]"), undefined, v);
  }
  assert.notEqual(errorIn("1.21.10", "clear @s *[food~{}]"), undefined);
  assert.equal(errorIn("1.21.11", "clear @s *[food~{}]"), undefined);
  for (const v of ["1.21.11", "26.3"]) {
    assert.deepEqual(diagnosticsIn(v, "clear @s *[food~{a:1}]"), [], v);
    assert.deepEqual(diagnosticsIn(v, "clear @s *[food~1]"), ["Expected a compound tag but got an int tag"], v);
    assert.deepEqual(diagnosticsIn(v, "clear @s *[food~[]]"), ["Expected a compound tag but got a list tag"], v);
  }
});

test("text_components_and_styles_are_snbt_from_1_21_5", () => {
  assert.equal(errorIn("1.21.4", 'tellraw @a {"text":"hi"}'), undefined);
  assert.notEqual(errorIn("1.21.4", 'tellraw @a {text:"hi"}'), undefined);
  assert.equal(errorIn("1.21.4", 'scoreboard objectives modify o numberformat styled {"color":"red"}'), undefined);
  for (const v of ["1.21.5", "26.3"]) {
    assert.deepEqual(diagnosticsIn(v, 'tellraw @a {text:"hi",color:"red",click_event:{action:"run_command",command:"/say hi"}}'), [], v);
    assert.deepEqual(diagnosticsIn(v, 'tellraw @a ["a",{text:"b",bold:true}]'), [], v);
    assert.deepEqual(diagnosticsIn(v, 'tellraw @a "plain"'), [], v);
    assert.deepEqual(diagnosticsIn(v, 'tellraw @a {"text":"hi"}'), [], v);
    assert.deepEqual(diagnosticsIn(v, 'scoreboard objectives modify o numberformat styled {color:"red",bold:true}'), [], v);
    assert.deepEqual(diagnosticsIn(v, 'tellraw @a {text:"a",color:1}'), ["Expected a string tag but got an int tag"], v);
    assert.deepEqual(diagnosticsIn(v, 'tellraw @a {text:"a",clickEvent:{}}'), ["Unknown key “clickEvent”"], v);
  }
});

function nestedCompounds(n: number): string {
  return `data modify storage a:b x set value ${"{a:".repeat(n)}1${"}".repeat(n)}`;
}

function nestedLists(n: number): string {
  return `data modify storage a:b x set value ${"[".repeat(n)}1${"]".repeat(n)}`;
}

function errorsWithLargeStack(version: string, lines: string[]): Promise<(string | undefined)[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./command-stack-worker.ts", import.meta.url), {
      workerData: { version, lines },
      resourceLimits: { stackSizeMb: 64 },
    });
    worker.once("message", resolve);
    worker.once("error", reject);
  });
}

test("nbt_past_512_levels_and_chains_past_the_node_limit_are_errors", async () => {
  for (const v of ["1.21.5", "26.3"]) {
    assert.equal(errorIn(v, nestedCompounds(512)), undefined, v);
    assert.equal(errorIn(v, nestedLists(512)), undefined, v);
    assert.equal(errorIn(v, nestedCompounds(513)), "Resulting NBT too deeply nested", v);
    assert.equal(errorIn(v, nestedLists(513)), "Resulting NBT too deeply nested", v);
  }
  const chain = (n: number) => `execute ${"as @s ".repeat(n)}run say a`;
  const [within, past] = await errorsWithLargeStack("26.3", [chain(4000), chain(4100)]);
  assert.equal(within, undefined);
  assert.equal(past, "Too many arguments in one command (more than 8192)");
});

test("nbt_past_512_levels_is_a_warning_in_releases_whose_server_reads_it", () => {
  for (const v of ["1.20.4", "1.21.4"]) {
    assert.equal(errorIn(v, nestedCompounds(512)), undefined, v);
    for (const line of [nestedCompounds(513), nestedLists(513)]) {
      const e = parseIn(v, line).error!;
      assert.deepEqual([e.severity, e.message], ["Warning", nbt.tooDeepToCheck()], v);
    }
  }
});

test("long_nbt_paths_are_checked", () => {
  assert.equal(errorIn("1.20.4", `data get storage a:b ${"a.".repeat(30_000)}a`), undefined);
});

test("slot_names_of_each_release", () => {
  const slot = (v: string, name: string) => errorIn(v, `item replace entity @s ${name} with stone`);
  assert.equal(slot("1.20.4", "horse.armor"), undefined);
  assert.notEqual(slot("1.20.4", "armor.body"), undefined);
  assert.notEqual(slot("1.20.5", "horse.armor"), undefined);
  assert.equal(slot("1.20.5", "armor.body"), undefined);
  assert.equal(slot("1.20.5", "horse.saddle"), undefined);
  assert.equal(slot("1.20.5", "player.crafting.3"), undefined);
  assert.equal(slot("1.20.5", "contents"), undefined);
  assert.notEqual(slot("1.21.5", "horse.saddle"), undefined);
  assert.equal(slot("1.21.5", "saddle"), undefined);
  assert.equal(slot("1.21.5", "contents"), undefined);
  assert.equal(slot("1.21.11", "villager.3"), undefined);
  assert.notEqual(slot("26.1", "villager.3"), undefined);
  assert.equal(slot("26.1", "mob.inventory.3"), undefined);
  assert.equal(errorIn("26.3", "execute if items entity @s mob.inventory.* minecraft:stone run say hi"), undefined);
  assert.notEqual(errorIn("26.3", "execute if items entity @s villager.* minecraft:stone run say hi"), undefined);
});

test("items_of_entities_without_an_id_are_checked_in_linear_time", () => {
  let items = '{Items:[{Slot:0b,id:"minecraft:stone",bogus:1b}]}';
  for (let i = 0; i < 12; i++) items = `{Items:[{Slot:0b,id:"minecraft:stone",components:{"minecraft:entity_data":${items}}}]}`;
  assert.deepEqual(diagnosticsIn("26.3", `data merge entity @s ${items}`), ["Unknown key “bogus”"]);
  let tags = '{Items:[{Slot:0b,id:"minecraft:stone",Count:1b,bogus:1b}]}';
  for (let i = 0; i < 12; i++) tags = `{Items:[{Slot:0b,id:"minecraft:pig_spawn_egg",Count:1b,tag:{EntityTag:${tags}}}]}`;
  assert.deepEqual(diagnosticsIn("1.20.4", `data merge entity @s ${tags}`), ["Unknown key “bogus”"]);
});

test("nested_text_components_are_checked_in_linear_time", () => {
  let snbt = "{x:1}";
  for (let i = 0; i < 24; i++) snbt = `{x:1,extra:[${snbt}]}`;
  assert.notEqual(diagnosticsIn("26.3", `tellraw @a ${snbt}`).length, 0);
  let separators = '{text:"a"}';
  for (let i = 0; i < 24; i++) separators = `{text:"a",separator:${separators}}`;
  assert.deepEqual(diagnosticsIn("26.3", `tellraw @a ${separators}`), ["Unknown key “separator”"]);
  let json = "1";
  for (let i = 0; i < 40; i++) json = `{"selector":"x","nbt":"y","separator":${json}}`;
  assert.notEqual(errorIn("1.20.4", `tellraw @a ${json}`), undefined);
});

test("the_nearest_entity_selector_from_1_21", () => {
  assert.notEqual(errorIn("1.20.6", "kill @n"), undefined);
  assert.equal(errorIn("1.21", "kill @n[type=zombie]"), undefined);
  assert.equal(errorIn("1.20.6", "say hi @n["), undefined);
  assert.notEqual(errorIn("1.21", "say hi @n["), undefined);
});

test("particle_options_are_snbt_from_1_20_5", () => {
  assert.equal(errorIn("1.20.4", "particle dust 1 0 0 1 ~ ~ ~ 0 0 0 0 1"), undefined);
  assert.equal(errorIn("1.20.5", "particle dust{color:[1f,0f,0f],scale:1f} ~ ~ ~ 0 0 0 0 1"), undefined);
  assert.equal(errorIn("26.3", 'particle minecraft:block{block_state:{Name:"minecraft:stone"}} ~ ~ ~'), undefined);
  assert.equal(errorIn("26.3", "particle flame ~ ~ ~"), undefined);
  assert.notEqual(errorIn("1.20.5", "particle dust 1 0 0 1 ~ ~ ~"), undefined);
  for (const v of ["1.20.5", "1.21.5", "26.3"]) {
    assert.deepEqual(diagnosticsIn(v, "particle flame ~ ~ ~"), [], v);
    assert.deepEqual(diagnosticsIn(v, "particle dust ~ ~ ~"), ["Missing key “color”", "Missing key “scale”"], v);
    assert.equal(diagnosticsIn(v, "particle dust{color:'red',scale:1f} ~ ~ ~").length, 1, v);
  }
  const double = "Expected a float tag but got a double tag (rule: “nbtTypeCheck”)";
  for (const v of ["1.21.2", "1.21.5", "26.3"]) {
    assert.deepEqual(diagnosticsIn(v, "particle dust{color:[1.0,0.0,0.0],scale:1f} ~ ~ ~"), [double, double, double], v);
  }
});

test("json_text_in_a_component_is_lenient_until_1_21_5", () => {
  for (const v of ["1.20.5", "1.21.4"]) {
    assert.deepEqual(diagnosticsIn(v, 'give @s stone[custom_name="a"]'), [], v);
    assert.deepEqual(diagnosticsIn(v, `give @s stone[lore=["'a'"]]`), [], v);
    assert.deepEqual(diagnosticsIn(v, `give @s stone[custom_name='{"text":"a"} b']`), ["Invalid chat component: Did not consume the entire document"], v);
    for (const comment of ["// c", "# c", "/* c */"]) {
      assert.deepEqual(diagnosticsIn(v, `give @s stone[custom_name='"a" ${comment}']`), ["Invalid chat component: Did not consume the entire document"], `${v} ${comment}`);
    }
  }
  assert.ok(diagnosticsIn("1.20.4", 'summon zombie ~ ~ ~ {CustomName:"a"}').some((d) => d.startsWith("Invalid chat component: Malformed JSON")));
});

test("entity_effect_particles_take_an_int_color_from_1_20_5", () => {
  for (const v of ["1.20.5", "1.21.1", "1.21.2", "26.3"]) {
    assert.deepEqual(diagnosticsIn(v, "particle entity_effect{color:-1} ~ ~ ~"), [], v);
    assert.deepEqual(diagnosticsIn(v, "particle entity_effect{color:[1f,0f,0f,1f]} ~ ~ ~"), [], v);
    assert.equal(diagnosticsIn(v, "particle entity_effect{color:[1.0,0.0,0.0,1.0]} ~ ~ ~").length, 4, v);
  }
});

test("snbt_follows_the_grammar_of_the_release", () => {
  assert.equal(errorIn("1.20.4", 'data modify storage t: v set value [1, "a"]'), "Can't insert TAG_String into list of TAG_Int");
  assert.equal(errorIn("1.21.5", 'data modify storage t: v set value [1, "a", {}]'), undefined);
  for (const v of ["1.21.4", "1.21.5"]) assert.equal(errorIn(v, "data modify storage t: v set value 0x1Fub"), undefined, v);
  assert.equal(errorIn("1.21.5", "data modify storage t: v set value 007"), "Decimal numbers can't start with 0");
  assert.equal(errorIn("1.21.4", "data modify storage t: v set value 007"), undefined);
  assert.equal(errorIn("26.3", 'data modify storage t: v set value {id: uuid("f81d4fae-7dec-11d0-a765-00a0c91e6bf6"), on: bool(1)}'), undefined);
  assert.equal(errorIn("26.3", "data get storage t: a{b: 0x1}.c"), undefined);
  assert.equal(errorIn("26.3", "data merge storage t: [1]"), "Expected compound tag");
});

test("every_release_has_no_unknown_parser", () => {
  for (const [version] of RELEASES) {
    const unknown = forVersion(version).tree.nodes.flatMap((n) =>
      n.kind.kind === "Argument" && n.kind.parser.kind === "Unknown" ? [n.kind.parser.id] : [],
    );
    assert.deepEqual(unknown, [], version);
  }
});

test("commands_that_every_release_reads_alike", () => {
  for (const [version] of RELEASES) {
    for (const line of [
      "say hi",
      "function t:lib",
      "scoreboard players set @s obj 1",
      "execute as @a at @s run tp @s ~ ~1 ~",
      "loot give @s loot minecraft:chests/igloo_chest",
      "execute if predicate t:p run say hi",
    ]) {
      assert.equal(errorIn(version, line), undefined, `${version}: ${line}`);
    }
  }
});

test("loot_tables_predicates_and_modifiers_are_ids_or_inline_from_1_20_5", () => {
  const refs = (line: string) => {
    const result = parseIn("1.20.5", line);
    assert.equal(result.error?.message, undefined, line);
    return refsOf(result);
  };
  assert.deepEqual(refs("loot give @s loot chests/igloo_chest"), [[kind.LOOT_TABLE, "minecraft:chests/igloo_chest"]]);
  assert.deepEqual(refs("execute if predicate t:p run say hi"), [[kind.PREDICATE, "t:p"]]);
  assert.deepEqual(refs("item modify entity @s weapon t:m"), [[kind.ITEM_MODIFIER, "t:m"]]);
  assert.deepEqual(refs("loot give @s loot {pools: []}"), []);
  assert.notEqual(errorIn("1.20.4", "loot give @s loot {pools: []}"), undefined);
});

test("json_text_has_a_shadow_color_from_1_21_4", () => {
  const line = (color: string) => `tellraw @s {"text":"a","shadow_color":${color}}`;
  for (const v of ["1.20.4", "1.21.3"]) assert.equal(errorIn(v, line('"red"')), undefined, v);
  assert.equal(errorIn("1.21.4", line("-1")), undefined);
  assert.equal(errorIn("1.21.4", line("[1,0,0,1]")), undefined);
  for (const color of ['"red"', "[1,0,0]"]) {
    assert.equal(errorIn("1.21.4", line(color)), "Invalid chat component: Not a number or a list of four numbers", color);
  }
});

test("only_bossbar_commands_take_a_bossbar_id", () => {
  const refs = (line: string) => {
    const result = parseIn("26.3", line);
    assert.equal(result.error?.message, undefined, line);
    return refsOf(result);
  };
  for (const line of ["bossbar get t:b max", "bossbar set t:b value 1", "bossbar remove t:b", "execute store result bossbar t:b value run say a"]) {
    assert.deepEqual(refs(line), [[kind.BOSSBAR, "t:b"]], line);
  }
  for (const line of ["attribute @s minecraft:max_health modifier add t:m 1 add_value", "stopwatch create t:w", "execute if stopwatch t:w 1.. run say a", "test create t:t"]) {
    assert.deepEqual(refs(line), [], line);
  }
});

test("inline_elements_are_checked_against_their_type", () => {
  for (const v of ["1.20.5", "1.21.5"]) {
    assert.deepEqual(diagnosticsIn(v, "loot give @s loot {pools:[]}"), [], v);
    assert.deepEqual(diagnosticsIn(v, 'item modify entity @s weapon.mainhand {function:"minecraft:set_count",count:2}'), [], v);
    assert.deepEqual(diagnosticsIn(v, 'execute if predicate {condition:"minecraft:random_chance"} run say a'), ["Missing key “chance”"], v);
  }
  assert.deepEqual(diagnosticsIn("26.3", 'execute if predicate {condition:"minecraft:random_chance",chance:0.5f} run say a'), ["Missing key “type”"]);
  assert.deepEqual(diagnosticsIn("26.3", 'dialog show @s {type:"minecraft:notice"}'), ["Missing key “title”"]);
  assert.deepEqual(diagnosticsIn("26.3", 'compute default integer {type:"minecraft:constant"}'), ["Missing key “value”"]);
  const modifier = (m: string) => `item modify entity @s weapon.mainhand ${m}`;
  assert.deepEqual(diagnosticsIn("26.3", modifier('[{type:"minecraft:set_count",count:2},{type:"minecraft:set_count",count:3}]')), []);
  assert.deepEqual(diagnosticsIn("26.3", modifier('[{type:"minecraft:set_count"}]')), ["Missing key “count”"]);
  assert.deepEqual(diagnosticsIn("26.3", 'execute if items entity @s [{type:"minecraft:slot_range",slots:"weapon.mainhand"}] * run say a'), []);
  assert.deepEqual(diagnosticsIn("26.3", modifier('["t:m",{type:"minecraft:set_count",count:3}]')), []);
  assert.deepEqual(diagnosticsIn("26.3", 'execute if items entity @s ["t:s",{type:"minecraft:slot_range",slots:"weapon.offhand"}] * run say a'), []);
  const refs = (v: string, line: string) => refsOf(parseIn(v, line));
  assert.deepEqual(refs("26.3", modifier('["t:m"]')), [[kind.ITEM_MODIFIER, "t:m"]]);
  for (const v of ["1.20.5", "1.21.5"]) {
    assert.deepEqual(diagnosticsIn(v, 'loot give @s loot "t:l"'), [], v);
    assert.deepEqual(refs(v, 'loot give @s loot "t:l"'), [[kind.LOOT_TABLE, "t:l"]], v);
    assert.notEqual(errorIn(v, 'loot give @s loot "T:l"'), undefined, v);
  }
  assert.deepEqual(diagnosticsIn("1.21.6", 'loot give @s loot "t:l"'), ["Expected a compound tag but got a string tag"]);
  assert.deepEqual(diagnosticsIn("1.21.5", modifier('[{type:"minecraft:set_count",count:2}]')), ["Missing key “function”"]);
  const double = "Expected a float tag but got a double tag (rule: “nbtTypeCheck”)";
  assert.deepEqual(diagnosticsIn("1.21.5", modifier('{function:"minecraft:set_count",count:{min:1.0,max:3.0}}')), [double, double]);
});

test("data_pack_ids_in_resource_arguments_are_references", () => {
  const refs = (version: string, line: string) => {
    const result = parseIn(version, line);
    assert.equal(result.error?.message, undefined, `${version}: ${line}`);
    return refsOf(result);
  };
  for (const version of ["1.20.4", "26.3"]) assert.deepEqual(refs(version, "damage @s 1 t:custom"), [[kind.DAMAGE_TYPE, "t:custom"]], version);
  assert.deepEqual(refs("1.21.2", "advancement grant @s only t:a"), [[kind.ADVANCEMENT, "t:a"]]);
  assert.deepEqual(refs("1.21.2", "recipe give @s t:r"), [[kind.RECIPE, "t:r"]]);
  assert.deepEqual(refs("1.20.4", "locate biome t:b"), [["worldgen/biome", "t:b"]]);
  assert.deepEqual(refs("1.21.5", "test locate t:x"), [["test_instance", "t:x"]]);
  assert.deepEqual(refs("1.21.5", "test locate t:*"), []);
  assert.deepEqual(refs("1.20.4", "effect give @s t:e"), []);
  assert.deepEqual(refs("1.20.4", "enchant @s t:e"), []);
  assert.deepEqual(refs("1.21", "enchant @s t:e"), [["enchantment", "t:e"]]);
  assert.deepEqual(refs("1.21", "execute if biome ~ ~ ~ #t:b run say hi"), [["tag/worldgen/biome", "t:b"]]);
});

test("slot_ranges_from_1_20_5", () => {
  assert.equal(errorIn("1.20.5", "execute if items entity @s container.* minecraft:stone"), undefined);
  assert.equal(errorIn("1.20.5", "execute if items entity @s armor.body minecraft:stone"), undefined);
  assert.notEqual(errorIn("1.20.5", "execute if items entity @s container.54 minecraft:stone"), undefined);
  assert.notEqual(errorIn("1.20.5", "execute if items entity @s container.05 minecraft:stone"), undefined);
  assert.equal(errorIn("26.3", "execute if items entity @s weapon.* minecraft:stone"), undefined);
  assert.equal(errorIn("26.3", "execute if slots block ~ ~ ~ t:my_slots run say hi"), undefined);
});

test("colors_and_the_parsers_of_later_releases", () => {
  assert.equal(errorIn("1.21.6", "waypoint modify @s color hex F80"), undefined);
  assert.equal(errorIn("1.21.6", "waypoint modify @s color hex FF8800"), undefined);
  assert.notEqual(errorIn("1.21.6", "waypoint modify @s color hex FF88"), undefined);
  assert.equal(errorIn("1.21.6", "dialog show @s minecraft:server_links"), undefined);
  assert.equal(errorIn("1.21.5", "test run minecraft:*"), undefined);
  assert.equal(errorIn("26.2", "team modify t color red"), undefined);
  assert.equal(errorIn("26.2", "team modify t color reset"), undefined);
  assert.notEqual(errorIn("26.2", "team modify t color bold"), undefined);
  assert.equal(errorIn("26.3", "swing @s mainhand stab"), undefined);
  assert.notEqual(errorIn("26.3", "swing @s mainhand poke"), undefined);
  assert.equal(errorIn("26.3", "place feature minecraft:oak"), undefined);
});
