import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePath, parseTag } from "../../../src/core/args/nbt.ts";
import { type Target, checkPath, checkValue, checkValueWith, new_, numWithin, steps, walkPath } from "../../../src/core/args/nbt_check.ts";
import { type CommandResult, type Effect, parseCommand } from "../../../src/core/command.ts";
import { Config } from "../../../src/core/config.ts";
import { type VersionData, forVersion, loadVersionData } from "../../../src/core/data.ts";
import { ParseError, severityAsStr } from "../../../src/core/diag.ts";
import { CHECK_LIMIT_MESSAGE, CheckLimit, type Range } from "../../../src/core/mcdoc.ts";
import { I64_MAX, I64_MIN } from "../../../src/core/numbers.ts";
import { type PResult, Reader } from "../../../src/core/reader.ts";

await Promise.all([loadVersionData("1.20.4"), loadVersionData("1.21.5")]);

/** Settings that turn on the NBT rules. */
const NBT_RULES = `{
    "datapack.lint.nbtTypeCheck": ["warning", "strictly"],
    "datapack.lint.nbtBoolean": ["warning", false],
    "datapack.lint.nbtCompoundKeyQuote": ["warning", false],
    "datapack.lint.nbtCompoundKeyQuoteType": ["warning", "always double"],
    "datapack.lint.nbtPathQuote": ["warning", false],
    "datapack.lint.nbtPathQuoteType": ["warning", "always double"],
    "datapack.lint.nbtStringQuote": ["warning", true],
    "datapack.lint.nbtStringQuoteType": ["warning", "prefer double"],
    "datapack.lint.nbtListLengthCheck": ["error", true],
    "datapack.lint.nbtArrayLengthCheck": ["warning", true],
    "datapack.lint.strictMobEffectCheck": ["error", "always"]
}`;

const PASCAL = `{"datapack.lint.nameOfNbtCompoundTagKeys": ["information", ["PascalCase", "/^id$/"]]}`;

function data(): VersionData {
  return forVersion("1.20.4");
}

function unwrap<T>(r: PResult<T>): T {
  if (r instanceof ParseError) assert.fail(r.message);
  return r;
}

function describe(effects: readonly Effect[]): string[] {
  return effects.map((e) => {
    switch (e.kind) {
      case "Diag":
        return `${severityAsStr(e.diag.severity)} ${e.diag.start}-${e.diag.end} ${e.diag.message}`;
      case "Ref":
      case "Write":
        return `ref ${e.ref.kind} ${e.ref.id} ${e.ref.start}-${e.ref.end}`;
      case "Def":
        return `def ${e.def.kind} ${e.def.id}`;
    }
  });
}

function value(settings: string, src: string, target: Target | undefined): string[] {
  const node = unwrap(parseTag(new Reader(src, 0), false));
  const config = Config.fromSettings(settings);
  return describe(checkValue(data(), config, node, target));
}

function path(settings: string, src: string, target: Target | undefined): string[] {
  const nodes = unwrap(parsePath(new Reader(src, 0), false));
  const config = Config.fromSettings(settings);
  return describe(checkPath(data(), config, nodes, target));
}

/** Parses a whole command, so that the context of each NBT argument is the real one. */
function command(settings: string, line: string): string[] {
  return diagnosticsOf(Config.fromSettings(settings), line);
}

function diagnosticsOf(config: Config, line: string): string[] {
  const { error, effects }: CommandResult = parseCommand(line, 0, data(), config);
  assert.ok(error === undefined, `${line}: ${error?.message}`);
  return describe(effects.filter((e) => e.kind === "Diag"));
}

function entity(id: string): Target {
  return new_("Entity", `minecraft:${id}`);
}

function item(id: string): Target {
  return new_("Item", `minecraft:${id}`);
}

function q(s: string): string {
  return `“${s}”`;
}

test("type_mismatch_is_strict_with_strictly_and_for_predicates", () => {
  const pig = entity("pig");
  assert.deepEqual(value(NBT_RULES, "{Health:20}", pig), [`warning 8-10 Expected a float tag but got an int tag (rule: ${q("nbtTypeCheck")})`]);
  const loose = `{"datapack.lint.nbtTypeCheck": ["warning", "loosely"]}`;
  assert.deepEqual(value(loose, "{Health:20}", pig), []);
  assert.deepEqual(value(loose, "{Health:20.0f}", pig), []);
  const predicate = { ...entity("pig"), predicate: true };
  assert.equal(value(loose, "{Health:20}", predicate).length, 1);
  // an int stands in for the other number types, a double never for a float
  assert.equal(value(loose, "{Health:20.0d}", pig).length, 1);
  assert.equal(value(loose, '{Health:"x"}', pig).length, 1);
});

test("without_a_type_check_setting_it_is_loosely_and_a_warning", () => {
  const pig = entity("pig");
  assert.deepEqual(value("{}", "{Health:20}", pig), []);
  assert.ok(value("{}", '{Health:"x"}', pig)[0]!.startsWith("warning 8-11 Expected a float tag but got a string tag"));
  const error = `{"datapack.lint.nbtTypeCheck": ["error", "loosely"]}`;
  assert.ok(value(error, '{Health:"x"}', pig)[0]!.startsWith("error "));
});

test("a_type_mismatch_stops_the_checks_inside", () => {
  const pig = entity("pig");
  // `Leash` is a compound; the list inside is not looked at
  assert.equal(value("{}", "{Leash:[{Foo:1}]}", pig).length, 1);
  assert.equal(value("{}", "{Motion:{Foo:1}}", pig).length, 1);
});

test("unknown_keys_are_reported_once_at_the_last_key", () => {
  const pig = entity("pig");
  assert.deepEqual(value("{}", "{Foo:1b}", pig), [`warning 1-4 Unknown key ${q("Foo")}`]);
  // nothing inside an unknown key is checked
  assert.equal(value("{}", '{Foo:{Saddle:"x"}}', pig).length, 1);
  const found = value("{}", "{Foo:1,Foo:2}", pig);
  assert.equal(found.length, 2, JSON.stringify(found));
  assert.ok(found.includes(`warning 7-10 Unknown key ${q("Foo")}`));
  assert.ok(found.includes(`warning 7-10 Duplicate key ${q("Foo")}`));
});

test("a_repeated_key_is_checked_with_its_last_value", () => {
  const pig = entity("pig");
  assert.deepEqual(value(NBT_RULES, '{Saddle:"x",Saddle:1b}', pig), [`warning 12-18 Duplicate key ${q("Saddle")}`]);
  assert.equal(value(NBT_RULES, '{Saddle:1b,Saddle:"x"}', pig).length, 2);
});

test("custom_model_data_allows_other_keys_in_an_item_tag", () => {
  assert.deepEqual(value("{}", "{Foo:1b,Damage:1}", item("stone")), []);
  assert.deepEqual(value("{}", "{Foo:1b}", item("diamond_sword")), []);
  // the exception is for the tag itself, not for the compounds in it
  assert.equal(value("{}", "{display:{Foo:1}}", item("stone")).length, 1);
});

test("marker_data_is_not_checked_but_its_keys_are_named", () => {
  const marker = entity("marker");
  assert.deepEqual(value("{}", "{data:{foo:1b,Bar:{x:[1]}}}", marker), []);
  assert.equal(value("{}", "{Foo:1}", marker).length, 1);
  assert.deepEqual(value(PASCAL, "{data:{foo:1b,Bar:1b}}", marker), [
    `information 7-10 Invalid key ${q("foo")} which doesn't follow ${q("PascalCase")} or ${q("/^id$/")} convention`,
  ]);
});

test("or_takes_the_first_alternative_without_diagnostics", () => {
  const pig = entity("pig");
  assert.deepEqual(value("{}", "{Leash:{UUID:[I;1,2,3,4]}}", pig), []);
  assert.deepEqual(value("{}", "{Leash:{X:1,Y:2,Z:3}}", pig), []);
  // when none is clean, the diagnostics of the last alternative are the result
  const found = value("{}", "{Leash:{X:1,Foo:2}}", pig);
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.ok(found[0]!.includes("Unknown key"));
  assert.ok(value("{}", "{Leash:5}", pig)[0]!.includes("Expected a compound tag but got an int tag"));
});

test("enum_values_are_listed_in_the_order_of_the_file", () => {
  const found = value("{}", "{Color:20b}", entity("sheep"));
  assert.equal(found.length, 1);
  // the options come in the order of the schema
  const options = Array.from({ length: 15 }, (_, i) => q(String(i))).join(", ");
  assert.equal(found[0], `warning 7-10 Expected ${options}, or ${q("15")} but got ${q("20")}`);
  assert.deepEqual(value("{}", "{Color:3b}", entity("sheep")), []);
  const fox = value("{}", '{Type:"x"}', entity("fox"));
  assert.equal(fox.length, 1, JSON.stringify(fox));
  assert.ok(fox[0]!.endsWith(`but got ${q("x")}`));
  // a number where the enum is made of strings is a type mismatch, not an unknown value
  assert.ok(value("{}", "{Type:1}", entity("fox"))[0]!.includes("Expected a string tag but got an int tag"));
});

test("number_ranges_include_both_ends", () => {
  const pig = entity("pig");
  assert.deepEqual(value("{}", "{InLove:-1}", pig), ["warning 8-10 Expected a number between 0 and 2147483647 but got -1"]);
  assert.deepEqual(value("{}", "{InLove:0}", pig), []);
  assert.deepEqual(value("{}", "{InLove:2147483647}", pig), []);
});

test("id_fields_check_the_registry_and_the_characters", () => {
  const pig = entity("pig");
  const effect = (id: string) => `{active_effects:[{id:${id},amplifier:1b,duration:1}]}`;
  assert.deepEqual(value(NBT_RULES, effect('"minecraft:speed"'), pig), []);
  assert.deepEqual(value(NBT_RULES, effect('"speed"'), pig), []);
  const unknown = value(NBT_RULES, effect('"minecraft:foo"'), pig);
  assert.equal(unknown.length, 1);
  assert.ok(unknown[0]!.startsWith("error "));
  assert.ok(
    unknown[0]!.endsWith(
      `Failed to resolve namespaced ID ${q("minecraft:foo")} in registry ${q("minecraft:mob_effect")} (rule: ${q("strictMobEffectCheck")})`,
    ),
  );
  // without the strict setting an unknown id is not reported
  assert.deepEqual(value("{}", effect('"minecraft:foo"'), pig), []);
  const upper = value(NBT_RULES, effect('"minecraft:Speed"'), pig);
  assert.ok(upper.some((d) => d.endsWith("Found non [a-z0-9/._-] character(s)")), JSON.stringify(upper));
  assert.ok(value(NBT_RULES, effect('"#minecraft:speed"'), pig)[0]!.endsWith("Tags are not allowed here"));
  // an Id field wants a quote even where a plain string would not be asked
  const unquoted = value(NBT_RULES, effect("speed"), pig);
  assert.equal(unquoted.length, 1);
  assert.ok(unquoted[0]!.includes("Expected a quote"));
});

test("id_ranges_are_inside_the_quotes_and_data_driven_ids_are_references", () => {
  const pig = entity("pig");
  const found = value(NBT_RULES, '{DeathLootTable:"foo:Bar"}', pig);
  assert.equal(found.length, 2, JSON.stringify(found));
  assert.ok(found.includes("error 21-24 Found non [a-z0-9/._-] character(s)"));
  assert.ok(found.includes("ref loot_table foo:Bar 17-24"));
  assert.ok(value("{}", "{DeathLootTable:'foo:bar'}", pig).includes("ref loot_table foo:bar 17-24"));
});

test("list_and_array_lengths", () => {
  const pig = entity("pig");
  assert.deepEqual(value(NBT_RULES, "{Motion:[0.0d,0.0d]}", pig), [`error 8-19 Expected a collection with length 3 (rule: ${q("nbtListLengthCheck")})`]);
  assert.deepEqual(value(NBT_RULES, "{LoveCause:[I;1,2,3]}", pig), [`warning 11-20 Expected a collection with length 4 (rule: ${q("nbtArrayLengthCheck")})`]);
  assert.deepEqual(value(NBT_RULES, "{Motion:[0.0d,0.0d,0.0d]}", pig), []);
  const off = `{"datapack.lint.nbtListLengthCheck": null, "datapack.lint.nbtArrayLengthCheck": null}`;
  assert.deepEqual(value(off, "{Motion:[0.0d],LoveCause:[I;1]}", pig), []);
  // lists are not checked unless asked, arrays are
  assert.equal(value("{}", "{Motion:[0.0d],LoveCause:[I;1]}", pig).length, 1);
  const between = value(NBT_RULES, "{ArmorDropChances:[0f,0f,0f]}", entity("zombie"));
  assert.ok(between[0]!.includes("length 4"), JSON.stringify(between));
});

test("nbt_boolean_reads_a_false_setting", () => {
  const pig = entity("pig");
  assert.deepEqual(value(NBT_RULES, "{Saddle:true}", pig), [`warning 8-12 Expected a byte tag but got ${q("true")}`]);
  assert.deepEqual(value(NBT_RULES, "{Saddle:1b}", pig), []);
  assert.deepEqual(value(NBT_RULES, "{Saddle:0b}", pig), []);
  const literal = `{"datapack.lint.nbtBoolean": ["information", true]}`;
  assert.deepEqual(value(literal, "{Saddle:1b}", pig), [`information 8-10 Expected ${q("false")} or ${q("true")}`]);
  assert.deepEqual(value(literal, "{Saddle:false}", pig), []);
  // no schema, no judgement; and only Boolean fields are judged
  assert.deepEqual(value(NBT_RULES, "{Saddle:true}", undefined), []);
  assert.ok(value(NBT_RULES, "{InLove:true}", pig).every((d) => !d.includes("a byte tag but got")));
});

test("quotes_of_keys_and_values", () => {
  const pig = entity("pig");
  const found = value(NBT_RULES, `{"Saddle":1b,'Silent':1b,Glowing:1b}`, pig);
  assert.equal(found.length, 3, JSON.stringify(found));
  assert.ok(found[0]!.startsWith(`warning 1-9 Expected an unquoted string but got ${q('"')} (rule: ${q("nbtCompoundKeyQuote")})`));
  assert.ok(found[1]!.includes(`Expected an unquoted string but got ${q("'")}`));
  assert.ok(found[2]!.endsWith(`Double quote (${q('"')}) is preferable here (rule: ${q("nbtCompoundKeyQuoteType")})`));
  // strings: only quoted ones are looked at, and `Team` holds a team reference
  const single = value(NBT_RULES, "{Team:'x'}", pig);
  assert.equal(single.length, 2, JSON.stringify(single));
  assert.ok(single.includes("ref team x 7-8"));
  assert.deepEqual(value(NBT_RULES, '{Team:"x"}', pig), ["ref team x 7-8"]);
  assert.deepEqual(value(NBT_RULES, "{Team:x}", pig), []);
  assert.deepEqual(value(NBT_RULES, "{Team:''}", pig), []);
  assert.ok(value(NBT_RULES, `{Team:'a"b'}`, pig).every((d) => !d.includes("preferable")));
});

test("the_rules_apply_alike_to_the_snbt_of_1_21_5", () => {
  const modern = (src: string): string[] => {
    const node = unwrap(parseTag(new Reader(src, 0), true));
    const config = Config.fromSettings(NBT_RULES);
    return describe(checkValue(forVersion("1.21.5"), config, node, entity("pig")));
  };
  const keys = modern(`{"Silent":1b,'Glowing':1b}`);
  assert.equal(keys.length, 3, JSON.stringify(keys));
  assert.ok(keys[0]!.startsWith(`warning 1-9 Expected an unquoted string but got ${q('"')} (rule: ${q("nbtCompoundKeyQuote")})`));
  assert.ok(keys[2]!.endsWith(`Double quote (${q('"')}) is preferable here (rule: ${q("nbtCompoundKeyQuoteType")})`));
  assert.equal(modern("{Team:'x'}").length, 2);
  // the forms that 1.21.5 adds are neither strings nor quoted keys
  assert.deepEqual(modern('{Silent: bool(1), Air: 0x1Fs, UUID: uuid("f81d4fae-7dec-11d0-a765-00a0c91e6bf6")}'), []);
});

test("inner_strings_hold_references", () => {
  const pig = entity("pig");
  assert.deepEqual(value(NBT_RULES, '{Tags:["Foo","Bar"]}', pig), ["ref tag Foo 8-11", "ref tag Bar 14-17"]);
  // unquoted strings and untyped NBT are not looked into
  assert.deepEqual(value(NBT_RULES, "{Tags:[Foo]}", pig), []);
  assert.deepEqual(value(NBT_RULES, '{Tags:["Foo"]}', undefined), []);
  // an escaped string reports at the whole string
  assert.deepEqual(value(NBT_RULES, '{Tags:["F\\\\oo"]}', pig), ["ref tag F 7-14"]);
});

test("untyped_values_get_only_what_the_parser_reports", () => {
  const settings = `{
        "datapack.lint.nameOfNbtCompoundTagKeys": ["information", "PascalCase"],
        "datapack.lint.nbtCompoundKeyQuote": ["warning", false],
        "datapack.lint.nbtTypeCheck": ["warning", "strictly"],
        "datapack.lint.nbtBoolean": ["warning", false]
    }`;
  const found = value(settings, `{foo:1b,"Bar":128b,Baz:true,Baz:'x',health:"x"}`, undefined);
  assert.equal(found.length, 5, JSON.stringify(found));
  assert.ok(found.some((d) => d.includes(`Invalid key ${q("foo")}`)));
  assert.ok(found.some((d) => d.includes("Expected an unquoted string")));
  assert.ok(found.some((d) => d.includes("Expected a number between -128 and 127 but got 128")));
  assert.ok(found.some((d) => d.includes(`Duplicate key ${q("Baz")}`)));
  assert.ok(found.some((d) => d.includes(`Invalid key ${q("health")}`)));
  // no type check, unknown key, boolean, or string quote without a schema
  for (const rule of ["nbtTypeCheck", "nbtStringQuote", "nbtStringQuoteType"]) {
    assert.ok(found.every((d) => !d.includes(rule)), `${rule}: ${JSON.stringify(found)}`);
  }
  assert.ok(found.every((d) => !d.includes("Unknown key") && !d.includes("a byte tag")));
  assert.deepEqual(value(NBT_RULES, "[Foo,'bar']", undefined), []);
});

test("number_literals_out_of_range_are_warned_about", () => {
  const found = value("{}", "{a:128b,b:-129b,c:32768s,d:2147483648,e:9223372036854775808L,f:127b,g:-128b,h:128}", undefined);
  assert.deepEqual(found, [
    "warning 3-7 Expected a number between -128 and 127 but got 128",
    "warning 10-15 Expected a number between -128 and 127 but got -129",
    "warning 18-24 Expected a number between -32,768 and 32,767 but got 32768",
    "warning 27-37 Expected a number between -2,147,483,648 and 2,147,483,647 but got 2147483648",
    "warning 40-60 Expected a number between -9,223,372,036,854,775,808 and 9,223,372,036,854,775,807 but got 9223372036854775808",
  ]);
  // a list takes them as strings, and so does a number that is not an integer
  assert.equal(value("{}", "[128b,129b]", undefined).length, 2);
  assert.deepEqual(value("{}", `[1.5b,abc,"128b"]`, undefined), []);
});

test("keys_without_a_doc_are_named", () => {
  const pig = entity("pig");
  // a key the schema names is exempt; the others are named whether or not the schema knows them
  const found = value(PASCAL, '{active_effects:[{id:"minecraft:speed",amplifier:1b,foo:1}],Foo:{bar:1}}', pig);
  assert.equal(found.filter((d) => d.startsWith("information")).length, 2, JSON.stringify(found));
  // the keys of each struct of a union are named by the schema
  const display = entity("item_display");
  assert.deepEqual(value(PASCAL, "{transformation:{translation:[0f,0f,0f]}}", display), []);
  assert.deepEqual(value(PASCAL, "{transformation:[1f,0f,0f,0f,0f,1f,0f,0f,0f,0f,1f,0f,0f,0f,0f,1f]}", display), []);
  assert.deepEqual(value(PASCAL, "{Foo:1,id:2}", undefined), []);
  assert.equal(value(PASCAL, "{uuid:1}", undefined).length, 1);
});

test("an_item_tag_follows_the_type_of_the_item", () => {
  // a block item has the tag of any item, whose keys outside the schema are free
  assert.deepEqual(value("{}", '{BlockStateTag:{half:"x"},Foo:1b}', item("oak_stairs")), []);
  assert.equal(value("{}", "{display:{Foo:1}}", item("oak_stairs")).length, 1);
  // a spawn egg's entity follows the id inside it
  assert.equal(value("{}", '{EntityTag:{id:"minecraft:pig",Foo:1}}', item("pig_spawn_egg")).length, 1);
  assert.deepEqual(value("{}", '{EntityTag:{id:"minecraft:pig",Saddle:1b}}', item("pig_spawn_egg")), []);
});

test("registry_supers_follow_the_id_in_the_compound", () => {
  const pig = entity("pig");
  const found = value("{}", '{Passengers:[{id:"minecraft:cow",Foo:1b},{Foo:1b}]}', pig);
  // the second passenger has no id, so every entity's keys are allowed
  assert.deepEqual(found, [`warning 33-36 Unknown key ${q("Foo")}`, `warning 42-45 Unknown key ${q("Foo")}`]);
  assert.deepEqual(value("{}", '{Passengers:[{id:"minecraft:pig",Saddle:1b}]}', pig), []);
  // a cow has no saddle
  assert.equal(value("{}", '{Passengers:[{id:"minecraft:cow",Saddle:1b}]}', pig).length, 1);
  assert.deepEqual(value("{}", "{Passengers:[{Saddle:1b}]}", pig), []);
});

test("the_fallback_is_used_when_the_id_is_unknown", () => {
  const fallback = new_("Entity", undefined);
  assert.deepEqual(value("{}", "{Saddle:1b,Health:1f}", fallback), []);
  assert.equal(value("{}", "{Foo:1b}", fallback).length, 1);
  const unregistered = entity("no_such_entity");
  assert.deepEqual(value("{}", "{Saddle:1b}", unregistered), []);
});

test("path_checks_keys_filters_and_indexes", () => {
  const pig = entity("pig");
  const at = (src: string): string[] => path(NBT_RULES, src, pig);
  assert.deepEqual(at("Health"), []);
  assert.deepEqual(at("Motion[0]"), []);
  assert.deepEqual(at("Motion[]"), []);
  assert.deepEqual(at("Foo"), [`warning 0-3 Unknown key ${q("Foo")}`]);
  const afterKey = at("Health.foo");
  assert.deepEqual(afterKey, ["warning 7-10 Keys are only used for compound tags"]);
  assert.deepEqual(at("Health[0]"), ["warning 6-7 Indices are only used for lists/arrays tags"]);
  // the filter after a non-compound has no schema
  assert.deepEqual(at("Health{a:1}"), ["warning 6-7 Compound filters are only used for compound tags"]);
  // a list element is a tag of the list's value type; an array's has no keys or indexes
  assert.deepEqual(at("Motion[0].x"), ["warning 10-11 Keys are only used for compound tags"]);
  assert.deepEqual(at("LoveCause[0].x"), ["warning 12-13 The current tag doesn't have extra items"]);
  const elementFilter = at("LoveCause[{a:1}]");
  assert.equal(elementFilter[0], "warning 10-11 The current tag doesn't have extra items");
  assert.deepEqual(at("Leash.X"), []);
  assert.equal(at("Leash.Foo").length, 1);
});

test("path_filters_are_checked_against_the_compound_they_follow", () => {
  const pig = entity("pig");
  const at = (src: string): string[] => path(NBT_RULES, src, pig);
  assert.deepEqual(at("Brain{memories:{}}"), []);
  // a passenger's own id picks its type; without one every entity's keys are allowed
  assert.equal(at('Passengers[{id:"minecraft:pig",Foo:1}]').length, 1);
  assert.deepEqual(at('Passengers[{id:"minecraft:pig"}]'), []);
  assert.equal(at("Passengers[{Foo:1}]").length, 1);
  assert.deepEqual(at("Passengers[{Saddle:1b}]"), []);
  // a filter is a predicate: types are strict
  assert.equal(at('Passengers[{id:"minecraft:pig",Health:1}]').length, 1);
  assert.deepEqual(at('Passengers[{id:"minecraft:pig",Health:1f}]'), []);
  // after an unknown key there is no schema
  assert.ok(path(NBT_RULES, "Foo{Saddle:true}", pig).every((d) => !d.includes("Unknown key “Saddle")));
});

test("a_filter_at_the_root_takes_every_type_of_the_category", () => {
  const fallback = new_("Entity", undefined);
  assert.deepEqual(path(NBT_RULES, "{Foo:1}", fallback), [`warning 1-4 Unknown key ${q("Foo")}`]);
  assert.deepEqual(path(NBT_RULES, "{Health:1f}.Health", fallback), []);
  assert.equal(path(NBT_RULES, "{Foo:1}", entity("pig")).length, 1);
});

test("path_marker_data_allows_unknown_keys_below", () => {
  const marker = entity("marker");
  assert.deepEqual(path(NBT_RULES, "data.foo.bar[0].baz", marker), []);
  assert.equal(path(NBT_RULES, "Foo.bar", marker).length, 1);
});

test("path_quotes_apply_without_a_schema", () => {
  const found = path(NBT_RULES, `"a".'b'.c`, undefined);
  assert.equal(found.length, 3, JSON.stringify(found));
  assert.ok(found[0]!.startsWith(`warning 0-3 Expected an unquoted string but got ${q('"')} (rule: ${q("nbtPathQuote")})`));
  assert.deepEqual(path(NBT_RULES, "a.b[0].c{d:1}", undefined), []);
});

test("path_single_quoted_keys_are_read_as_the_game_reads_them", () => {
  // The default quote rules still apply; only the key lookup is checked here.
  const pig = entity("pig");
  const unknown = (found: string[]): string[] => found.filter((d) => d.includes("Unknown key"));
  assert.deepEqual(unknown(path("{}", "'Health'", pig)), []);
  assert.deepEqual(unknown(path("{}", '"Health"', pig)), []);
  assert.deepEqual(unknown(path("{}", "'Nope'", pig)), [`warning 0-6 Unknown key ${q("Nope")}`]);
});

test("path_or_picks_the_first_branch_that_adds_no_diagnostic", () => {
  // `Leash` is an Or of two compounds: X is in the second only, UUID in the first only
  const pig = entity("pig");
  assert.deepEqual(path(NBT_RULES, "Leash.UUID", pig), []);
  assert.deepEqual(path(NBT_RULES, "Leash.X", pig), []);
  assert.equal(path(NBT_RULES, "Leash.Foo", pig).length, 1);
});

test("commands_pick_the_schema_of_each_nbt_argument", () => {
  // summon: the entity named
  assert.equal(command("{}", "summon pig ~ ~ ~ {Foo:1b}").length, 1);
  assert.deepEqual(command("{}", "summon pig ~ ~ ~ {Saddle:1b}"), []);
  assert.equal(command("{}", "summon cow ~ ~ ~ {Saddle:1b}").length, 1);
  // data merge entity: the selector's type; block and storage are untyped
  assert.equal(command("{}", "data merge entity @e[type=cow,limit=1] {Saddle:1b}").length, 1);
  assert.deepEqual(command("{}", "data merge entity @s {Saddle:1b}"), []);
  assert.deepEqual(command("{}", "data merge entity @e[type=pig,limit=1] {Saddle:1b}"), []);
  assert.deepEqual(command("{}", "data merge storage a:b {Foo:1b}"), []);
  assert.deepEqual(command("{}", "data merge block ~ ~ ~ {Foo:1b}"), []);
  // function arguments are never typed
  assert.ok(command("{}", "function a:b {Foo:1b}").every((d) => !d.includes("Unknown key")));
});

test("a_data_modify_value_is_typed_by_the_target_path_with_a_spyglass_json", () => {
  const command = (settings: string, line: string): string[] => {
    const config = Config.fromSettings(settings);
    config.mergeSpyglass("{}");
    return diagnosticsOf(config, line);
  };
  const wrong = command(NBT_RULES, "data modify entity @s Saddle set value {Foo:true}");
  assert.deepEqual(wrong, ["warning 39-49 Expected a byte tag but got a compound tag (rule: “nbtTypeCheck”)"]);
  assert.deepEqual(command(NBT_RULES, "data modify entity @s NoAI set value false"), ["warning 37-42 Expected a byte tag but got “false”"]);
  assert.deepEqual(command(NBT_RULES, "data modify entity @s NoAI set value 1b"), []);
  assert.deepEqual(command(NBT_RULES, "data modify entity @s NoAI set value 1"), ["error 37-38 Expected a boolean"]);
  // number kinds are interchangeable, even with `nbtTypeCheck: strictly`
  assert.deepEqual(command(NBT_RULES, "data modify entity @s Health set value 1d"), []);
  assert.deepEqual(command(NBT_RULES, "data modify entity @s Air set value 1b"), []);
  assert.equal(command(NBT_RULES, 'data modify entity @s CustomName set value "abc"').length, 1);
  assert.deepEqual(command(NBT_RULES, `data modify entity @s CustomName set value '"abc"'`), []);
  // the element type for append / prepend / insert
  assert.deepEqual(command(NBT_RULES, 'data modify entity @s Tags append value "A"'), []);
  assert.equal(command(NBT_RULES, "data modify entity @s Tags insert 0 value 1b").length, 1);
  // no schema: storage, and keys the schema does not know
  assert.deepEqual(command(NBT_RULES, "data modify storage a:b NoAI set value {Foo:true}"), []);
  assert.deepEqual(command(NBT_RULES, "data modify entity @s Foo set value {Foo:true}"), ["warning 22-25 Unknown key “Foo”"]);
});

test("unquoted_strings_need_quotes_only_with_a_spyglass_json", () => {
  const line = 'summon marker ~ ~ ~ {Tags:[A,"B"]}';
  assert.deepEqual(command(NBT_RULES, line), []);
  const config = Config.fromSettings(NBT_RULES);
  config.mergeSpyglass("{}");
  const found = diagnosticsOf(config, line);
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.ok(found[0]!.startsWith("warning 27-28 "), JSON.stringify(found));
});

function withSpyglass(line: string): string[] {
  const config = Config.fromSettings(NBT_RULES);
  config.mergeSpyglass("{}");
  return diagnosticsOf(config, line);
}

test("whole_values_need_the_keys_mcdoc_requires_with_a_spyglass_json", () => {
  const line = `summon text_display ~ ~ ~ {text:'"a"'}`;
  assert.deepEqual(withSpyglass(line), ["error 26-38 Missing key “alignment”"]);
  assert.deepEqual(command(NBT_RULES, line), []);
  assert.deepEqual(withSpyglass(`summon text_display ~ ~ ~ {text:'"a"',alignment:"center"}`), []);
  assert.deepEqual(withSpyglass("summon item_display ~ ~ ~ {item:{}}"), ["error 32-34 Missing key “id”"]);
  assert.deepEqual(withSpyglass("data modify entity @s item set value {}"), ["error 37-39 Missing key “id”"]);
  assert.deepEqual(withSpyglass("data modify entity @s item merge value {}"), []);
  assert.deepEqual(withSpyglass("kill @e[nbt={item:{}}]"), []);
  assert.deepEqual(withSpyglass("summon zombie ~ ~ ~ {ArmorItems:[{},{},{},{}]}"), []);
  assert.deepEqual(withSpyglass("data modify entity @e[type=zombie,limit=1] HandItems[0] set value {}"), []);
  assert.deepEqual(withSpyglass("data modify entity @e[type=zombie,limit=1] HandItems append value {}"), []);
  assert.deepEqual(withSpyglass("summon chest_minecart ~ ~ ~ {Items:[{Slot:0b,Count:1b}]}"), ["error 36-54 Missing key “id”"]);
  assert.deepEqual(withSpyglass("summon sniffer ~ ~ ~ {NoAI:1b}"), []);
  assert.deepEqual(withSpyglass('summon lightning_bolt ~ ~ ~ {Tags:["x"]}'), []);
});

test("teleport_duration_is_0_to_59_with_a_spyglass_json", () => {
  const line = "summon item_display ~ ~ ~ {teleport_duration:60}";
  assert.deepEqual(withSpyglass(line), ["error 45-47 Expected numeric value to be at least 0 and at most 59"]);
  assert.deepEqual(command(NBT_RULES, line), ["warning 45-47 Expected a number between 0 and 59 but got 60"]);
  assert.deepEqual(withSpyglass("summon item_display ~ ~ ~ {teleport_duration:59}"), []);
  const modify = "data modify entity @e[type=text_display,limit=1] teleport_duration set value 60";
  assert.deepEqual(withSpyglass(modify), ["error 77-79 Expected numeric value to be at least 0 and at most 59"]);
});

test("interpret_belongs_to_nbt_components_with_a_spyglass_json", () => {
  const line = `tellraw @s [{"text":"","interpret":false}]`;
  assert.deepEqual(withSpyglass(line), ["error 13-19 Invalid combination of keys “interpret” and “text”", "error 23-34 Invalid combination of keys “interpret” and “text”"]);
  assert.deepEqual(command(NBT_RULES, line), []);
  assert.deepEqual(withSpyglass(`tellraw @s {"nbt":"a","storage":"a:b","interpret":true}`), []);
});

test("an_id_starting_with_a_non_ascii_character_is_reported_on_whole_characters", () => {
  const found = command("{}", 'summon item ~ ~ ~ {Item:{id:"あ",Count:1b}}');
  // the range is the one character, counted in UTF-16 units (3 bytes in UTF-8)
  assert.ok(found.includes("error 29-30 Expected a namespaced ID but got nothing"), JSON.stringify(found));
});

test("a_data_modify_value_is_untyped_without_a_spyglass_json", () => {
  assert.deepEqual(command(NBT_RULES, "data modify entity @s Saddle set value {Foo:true}"), []);
  assert.deepEqual(command(NBT_RULES, "data modify entity @s NoAI set value false"), []);
});

test("a_selector_nbt_sees_the_type_before_it_only", () => {
  const before = command("{}", "kill @e[type=cow,nbt={Saddle:1b}]");
  assert.equal(before.length, 1, JSON.stringify(before));
  assert.deepEqual(command("{}", "kill @e[nbt={Saddle:1b},type=cow]"), []);
  assert.deepEqual(command("{}", "kill @e[type=!cow,nbt={Saddle:1b}]"), []);
  assert.deepEqual(command("{}", "kill @e[type=#minecraft:skeletons,nbt={Saddle:1b}]"), []);
  // @a is a player whatever `type=` says
  assert.equal(command("{}", "kill @a[nbt={Saddle:1b}]").length, 1);
  // a selector's NBT is a predicate: types are strict
  assert.equal(command("{}", "kill @e[type=pig,nbt={Health:20}]").length, 1);
});

test("block_and_item_arguments_pick_their_registry", () => {
  assert.equal(command("{}", "setblock ~ ~ ~ chest{Foo:1b}").length, 1);
  assert.deepEqual(command("{}", "setblock ~ ~ ~ chest{Items:[]}"), []);
  // a block without a block entity has an empty compound
  assert.equal(command("{}", "setblock ~ ~ ~ stone{Items:[]}").length, 1);
  // execute if block is a predicate, clone filtered is not
  assert.equal(command("{}", "execute if block ~ ~ ~ furnace{BurnTime:1}").length, 1);
  assert.deepEqual(command("{}", "clone ~ ~ ~ ~ ~ ~ ~ ~ ~ filtered furnace{BurnTime:1}"), []);
  assert.deepEqual(command("{}", "setblock ~ ~ ~ furnace{BurnTime:1}"), []);
  assert.equal(command("{}", "give @s stone{display:{Foo:1}}").length, 1);
  assert.equal(command("{}", "clear @s stone{Damage:1b}").length, 1);
  assert.deepEqual(command("{}", "give @s stone{Damage:1}"), []);
});

test("commands_pick_the_schema_of_each_path", () => {
  assert.equal(command("{}", "data get entity @e[type=pig,limit=1] Foo").length, 1);
  assert.deepEqual(command("{}", "data get entity @e[type=pig,limit=1] Saddle"), []);
  assert.deepEqual(command("{}", "data get entity @s Saddle"), []);
  assert.equal(command("{}", "data get entity @s Foo").length, 1);
  assert.ok(command("{}", "data get storage a:b Foo.bar").every((d) => !d.includes("Unknown key")));
  assert.equal(command("{}", "data get block ~ ~ ~ Foo").length, 1);
  assert.deepEqual(command("{}", "data get block ~ ~ ~ Items[0].id"), []);
  // a second path in the same command follows the holder before it
  const both = command("{}", "data modify entity @e[type=cow,limit=1] Saddle set from entity @e[type=pig,limit=1] Saddle");
  assert.equal(both.length, 1, JSON.stringify(both));
  assert.ok(command("{}", "execute as @e[type=cow] run data get entity @s Foo")[0]!.includes("Unknown key"));
  assert.equal(command("{}", "execute as @e[type=pig] run summon cow ~ ~ ~ {Saddle:1b}").length, 1);
});

test("integers_are_compared_with_a_range_exactly", () => {
  const r = (min: number | undefined, max: number | undefined): Range => ({ min, max, minExclusive: false, maxExclusive: false });
  assert.ok(numWithin({ kind: "Int", value: I64_MAX }, r(Number(I64_MIN), Number(I64_MAX))));
  assert.ok(numWithin({ kind: "Int", value: 1n << 53n }, r(undefined, 2 ** 53)));
  assert.ok(!numWithin({ kind: "Int", value: (1n << 53n) + 1n }, r(undefined, 2 ** 53)));
  assert.ok(numWithin({ kind: "Int", value: 5n }, r(5, 5)));
  assert.ok(!numWithin({ kind: "Int", value: 5n }, r(5.5, undefined)));
  assert.ok(!numWithin({ kind: "Int", value: -1n }, r(0, undefined)));
  assert.ok(numWithin({ kind: "Float", value: 0.5 }, r(0, 1)));
  assert.ok(!numWithin({ kind: "Float", value: 1.5 }, r(0, 1)));
  assert.ok(!numWithin({ kind: "Float", value: 0 }, { ...r(0, undefined), minExclusive: true }));
});

test("an_area_effect_cloud_reads_its_particle_as_a_particle_argument", () => {
  const found = command("{}", 'summon area_effect_cloud ~ ~ ~ {Particle:"minecraft:nope"}');
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.ok(found[0]!.includes("Unknown particle"), JSON.stringify(found));
  assert.deepEqual(command("{}", 'summon area_effect_cloud ~ ~ ~ {Particle:"dust 1 0 0 1"}'), []);
});

test("an_item_without_its_id_may_be_any_item", () => {
  assert.deepEqual(command("{}", "execute if entity @s[nbt={SelectedItem:{tag:{display:{color:1}}}}]"), []);
  assert.equal(command("{}", 'execute if entity @s[nbt={SelectedItem:{id:"minecraft:stone",tag:{display:{color:1}}}}]').length, 1);
});

test("horses_and_llamas_keep_their_armor_and_decor_in_1_20_4", () => {
  assert.deepEqual(command("{}", 'summon horse ~ ~ ~ {ArmorItem:{id:"minecraft:iron_horse_armor",Count:1b}}'), []);
  assert.deepEqual(command("{}", 'summon trader_llama ~ ~ ~ {DecorItem:{id:"minecraft:red_carpet",Count:1b}}'), []);
  assert.equal(command("{}", 'summon pig ~ ~ ~ {ArmorItem:{id:"minecraft:iron_horse_armor",Count:1b}}').length, 1);
});

test("a_tag_past_the_check_limit_is_checked_in_part_with_a_warning", () => {
  const node = unwrap(parseTag(new Reader('{Passengers:[{id:"minecraft:pig",Health:1.0f}]}', 0), false));
  const config = new Config();
  const pig = entity("pig");
  const limited = (found: string[]): boolean => found.some((d) => d.includes(CHECK_LIMIT_MESSAGE));
  assert.ok(!limited(describe(checkValue(data(), config, node, pig))));
  assert.ok(limited(describe(checkValueWith(data(), config, node, pig, new CheckLimit(1)))));
});

test("a_path_filter_past_the_check_limit_is_checked_in_part_with_a_warning", () => {
  const nodes = unwrap(parsePath(new Reader('Passengers[{id:"minecraft:pig",Health:1.0f}]', 0), false));
  const config = new Config();
  const pig = entity("pig");
  const limited = (found: string[]): boolean => found.some((d) => d.includes(CHECK_LIMIT_MESSAGE));
  assert.ok(!limited(describe(checkPath(data(), config, nodes, pig))));
  assert.ok(limited(describe(walkPath(data(), config, steps(nodes), pig, new CheckLimit(0)))));
});

test("duplicate_keys_of_a_large_compound_are_found_in_linear_time", () => {
  const keys = Array.from({ length: 20_000 }, (_, i) => `k${i}:1b`);
  const found = value("{}", `{${keys.join(",")},k0:1b}`, entity("pig"));
  assert.equal(found.filter((d) => d.includes("Duplicate key")).length, 1);
  assert.equal(found.filter((d) => d.includes("Unknown key")).length, 20_000);
});
