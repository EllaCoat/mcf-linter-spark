import assert from "node:assert/strict";
import { test } from "node:test";

import { forVersion, loadVersionData } from "../../src/core/data.ts";
import * as datajson from "../../src/core/datajson.ts";
import { ParseError } from "../../src/core/diag.ts";
import type { Kind } from "../../src/core/facts.ts";
import { parseDocument } from "../../src/core/json.ts";
import { CheckLimit } from "../../src/core/mcdoc.ts";

for (const v of ["1.20.4", "1.21", "1.21.4", "1.21.5", "1.21.11", "26.1", "26.2", "26.3"]) await loadVersionData(v);

/** `code message` of each diagnostic, then `ref kind id` of each reference. */
function run(kind: Kind, text: string): string[] {
  return runIn("1.20.4", kind, text);
}

function runIn(version: string, kind: Kind, text: string): string[] {
  const data = forVersion(version);
  const doc = data.mcdoc;
  const c = datajson.check(text, datajson.reading(kind), datajson.schema(kind, doc)!, doc, data);
  const out = c.diags.map((d) => `${d.code} ${d.message}`);
  out.push(...c.refs.map((r) => `ref ${r.kind} ${r.id}`));
  return out;
}

test("a_value_past_the_check_limit_is_checked_in_part_with_a_warning", () => {
  const data = forVersion("1.20.4");
  const doc = data.mcdoc;
  const text = `{"condition": "minecraft:any_of", "terms": [{"condition": "minecraft:random_chance", "chance": 0.5}]}`;
  const node = parseDocument(text, "Strict");
  assert.ok(!(node instanceof ParseError));
  const schema = datajson.schema("predicate", doc)!;
  const codes = (c: datajson.Checked) => c.diags.map((d) => d.code);
  assert.deepEqual(codes(datajson.checked(new datajson.Checker(doc, data, text), node, schema)), []);
  assert.deepEqual(codes(datajson.checked(new datajson.Checker(doc, data, text, new CheckLimit(1)), node, schema)), ["jsonCheckLimit"]);
});

test("nested_text_components_are_checked_once_per_level", () => {
  const advancement = (inner: string) => {
    let title = inner;
    for (let i = 0; i < 24; i++) title = `{"text": "a", "extra": [${title}]}`;
    return `{"criteria": {"a": {"trigger": "minecraft:tick"}}, "display": {"icon": {"id": "minecraft:stone"}, "title": ${title}, "description": "a"}}`;
  };
  assert.deepEqual(runIn("1.21", "advancement", advancement(`{"text": "a"}`)), []);
  assert.deepEqual(runIn("1.21", "advancement", advancement(`{"text": "a", "bogus": 1}`)), ["jsonUnknownKey Unknown key “bogus”"]);
  let title = `{"text": "a"}`;
  for (let i = 0; i < 24; i++) title = `{"text": "a", "separator": ${title}}`;
  const separators = `{"criteria": {"a": {"trigger": "minecraft:tick"}}, "display": {"icon": {"item": "minecraft:stone"}, "title": ${title}, "description": "a"}}`;
  assert.deepEqual(runIn("1.20.4", "advancement", separators), ["jsonUnknownKey Unknown key “separator”"]);
});

test("duplicate_keys_of_a_large_object_are_found_in_linear_time", () => {
  const members = Array.from({ length: 20_000 }, (_, i) => `"c${i}": {"trigger": "minecraft:tick"}`);
  const text = `{"criteria": {${members.join(", ")}, "c0": {"trigger": "minecraft:tick"}}}`;
  assert.deepEqual(run("advancement", text), ["jsonDuplicateKey Duplicate key “c0”; the last one is used"]);
});

test("items_of_entities_without_an_id_are_checked_in_linear_time", () => {
  let entity = `{"id": "minecraft:pig", "bogus": 1}`;
  for (let i = 0; i < 12; i++) {
    entity = `{"Items": [{"Slot": 0, "id": "minecraft:stone", "components": {"minecraft:entity_data": ${entity}}}]}`;
  }
  const modifier = `{"type": "minecraft:set_components", "components": {"minecraft:entity_data": ${entity}}}`;
  assert.deepEqual(runIn("26.3", "item_modifier", modifier), [
    "jsonUnknownKey Unknown key “Slot”",
    "jsonUnknownKey Unknown key “id”",
    "jsonUnknownKey Unknown key “components”",
    "jsonMissingKey Missing key “id”",
  ]);
});

test("predicates_follow_the_condition_dispatcher", () => {
  assert.deepEqual(run("predicate", `{"condition": "minecraft:random_chance", "chance": 0.5}`), []);
  assert.deepEqual(run("predicate", `{"condition": "random_chance", "chancee": 0.5}`), [
    "jsonUnknownKey Unknown key “chancee”",
    "jsonMissingKey Missing key “chance”",
  ]);
  assert.deepEqual(run("predicate", `{"condition": "random_chance", "chance": 2}`), ["jsonRange Expected a number in 0..1"]);
  assert.deepEqual(run("predicate", `[{"condition": "nope"}]`), ["undeclaredSymbol Cannot find loot_condition_type “minecraft:nope”"]);
  assert.deepEqual(run("predicate", `{"condition": "reference", "name": "t:p"}`), ["ref predicate t:p"]);
});

test("nbt_in_json_takes_a_number_for_a_boolean", () => {
  const spawner = (entity: string) => `{"spawn_potentials": [{"data": {"entity": ${entity}}, "weight": 1}]}`;
  assert.deepEqual(runIn("1.21.5", "trial_spawner", spawner(`{"id": "minecraft:zombie", "IsBaby": 1}`)), []);
  assert.deepEqual(runIn("1.21.5", "trial_spawner", spawner(`{"id": "minecraft:zombie", "IsBaby": "yes"}`)), ["jsonType Expected a boolean"]);
  const components = (component: string, value: string) =>
    `{"function": "minecraft:set_components", "components": {"minecraft:${component}": ${value}}}`;
  for (const v of ["1.21.4", "1.21.5"]) {
    for (const [component, value] of [
      ["entity_data", `{"id": "minecraft:item_frame", "Invisible": 1}`],
      ["entity_data", `{"id": "minecraft:pig", "Passengers": [{"id": "minecraft:zombie", "NoAI": 1}]}`],
      ["bucket_entity_data", `{"NoAI": 1}`],
      ["block_entity_data", `{"id": "minecraft:command_block", "auto": 1}`],
    ] as const) {
      assert.deepEqual(runIn(v, "item_modifier", components(component, value)), [], `${v} ${component} ${value}`);
    }
    assert.deepEqual(runIn(v, "item_modifier", components("bucket_entity_data", `{"NoAI": "yes"}`)), ["jsonType Expected a boolean"], v);
  }
  assert.deepEqual(runIn("1.21.5", "tag/item", `{"values": [{"id": "minecraft:stone", "required": 0}]}`), ["jsonType Expected a boolean"]);
});

test("wolf_sounds_have_a_step_sound_from_26_1", () => {
  const names = ["ambient_sound", "death_sound", "growl_sound", "hurt_sound", "pant_sound", "whine_sound"];
  const set = (step: string) => `{${names.map((n) => `"${n}": "entity.wolf.step"`).join(", ")}${step}}`;
  const sounds = (step: string) => `{"adult_sounds": ${set(step)}, "baby_sounds": ${set(step)}}`;
  const step = `, "step_sound": "entity.wolf.step"`;
  assert.deepEqual(runIn("26.1", "wolf_sound_variant", sounds(step)), []);
  assert.deepEqual(runIn("26.1", "wolf_sound_variant", sounds("")), Array(2).fill("jsonMissingKey Missing key “step_sound”"));
  assert.deepEqual(runIn("1.21.11", "wolf_sound_variant", set(step)), ["jsonUnknownKey Unknown key “step_sound”"]);
});

test("the_map_extending_recipe_of_26_3_transmutes_its_result", () => {
  const recipe = (result: string) =>
    `{"type": "minecraft:crafting_special_mapextending", "map": "#minecraft:extendable_maps", "material": "minecraft:paper", "result": ${result}}`;
  const diags = (version: string, result: string) => runIn(version, "recipe", recipe(result)).filter((m) => !m.startsWith("ref "));
  assert.deepEqual(diags("26.3", "{}"), []);
  assert.deepEqual(diags("26.3", `"minecraft:filled_map"`), []);
  assert.deepEqual(diags("26.2", "{}"), ["jsonMissingKey Missing key “id”"]);
});

test("values_of_the_wrong_shape_name_what_fits", () => {
  const messages = run("loot_table", `{"pools": [{"rolls": "x", "entries": [{"type": "item", "name": "minecraft:not_an_item"}]}]}`);
  assert.deepEqual(messages, ["jsonType Expected a float or an object", "undeclaredSymbol Cannot find item “minecraft:not_an_item”"]);
  assert.deepEqual(run("predicate", `{"condition": "entity_properties", "entity": "target", "predicate": {}}`), [
    "jsonType Expected “this”, “killer”, “direct_killer” or “killer_player”",
  ]);
});

test("tag_entries_resolve_by_registry", () => {
  assert.deepEqual(run("tag/item", `{"values": ["stone", "#t:gems", "t:custom"]}`), ["ref tag/item t:gems"]);
  assert.deepEqual(run("tag/item", `{"values": ["minecraft:nope"]}`), ["undeclaredSymbol Cannot find item “minecraft:nope”"]);
  assert.deepEqual(run("tag/item", `{"values": [{"id": "minecraft:nope", "required": false}]}`), []);
  assert.deepEqual(run("tag/item", `{"values": [{"id": "minecraft:nope", "required": 0}]}`), ["jsonType Expected a boolean"]);
  assert.deepEqual(run("tag/function", `{"values": ["t:main"]}`), ["ref function t:main"]);
});

test("a_tag_entry_is_required_as_the_game_codec_reads_it", () => {
  const cases: [string, boolean][] = [
    ["{id: 'a', required: false}", false],
    ["{id: 'a', required: FALSE}", false],
    ["{id: 'a', required: 0}", false],
    ["{id: 'a', required: 256}", false],
    ["{id: 'a', required: 0.5}", false],
    ["{id: 'a', required: 1}", true],
    ["{id: 'a', required: 'false'}", true],
    ["{id: 'a', required: null}", true],
    ["{id: 'a', required: false, required: true}", true],
    ["{id: 'a'}", true],
  ];
  for (const [text, required] of cases) {
    const entry = parseDocument(text, "Lenient");
    assert.ok(!(entry instanceof ParseError), text);
    assert.equal(datajson.tagEntryRequired(entry), required, text);
  }
});

test("advancements_reference_functions_and_may_omit_the_root_background", () => {
  const root = `{"display": {"icon": {"item": "stone"}, "title": "a", "description": "b"}, "criteria": {"a": {"trigger": "tick"}}, "rewards": {"function": "t:reward"}}`;
  assert.deepEqual(run("advancement", root), ["ref function t:reward"]);
});

test("objectives_and_teams_in_predicates_are_references", () => {
  const scores = `{"condition": "entity_scores", "entity": "this", "scores": {"Hp": 1}}`;
  assert.deepEqual(run("predicate", scores), ["ref objective Hp"]);
  const team = `{"condition": "entity_properties", "entity": "this", "predicate": {"team": "red"}}`;
  assert.deepEqual(run("predicate", team), ["ref team red"]);
  const number = `{"condition": "value_check", "value": {"type": "score", "target": "this", "score": "Mp"}, "range": 1}`;
  assert.deepEqual(run("predicate", number), ["ref objective Mp"]);
});

test("an_id_on_a_reference_lets_enum_values_omit_the_namespace", () => {
  const messages = run("dimension_type", `{"effects": "minecraft:overworld"}`);
  assert.ok(!messages.some((m) => m.includes("overworld")), JSON.stringify(messages));
});

test("syntax_errors_stop_the_check", () => {
  const malformed = "jsonSyntax Malformed JSON (strings need double quotes; comments and single quotes are not allowed)";
  assert.deepEqual(run("predicate", `{'condition': 'random_chance', 'chance': 0.5}`), [malformed]);
  assert.deepEqual(run("predicate", "// a comment\n{}"), [malformed]);
  assert.deepEqual(run("tag/block", `{"values": []} {}`), ["jsonSyntax Unexpected content after the JSON value"]);
});

test("an_item_predicate_may_count_the_items", () => {
  const equipment = `{"condition": "entity_properties", "entity": "this", "predicate": {"equipment": {"mainhand": {"items": ["minecraft:stone"], "count": {"min": 2}}}}}`;
  assert.deepEqual(run("predicate", equipment), []);
});

test("special_crafting_recipes_take_a_category", () => {
  assert.deepEqual(run("recipe", `{"type": "minecraft:crafting_special_armordye", "category": "misc"}`), []);
  assert.deepEqual(run("recipe", `{"type": "minecraft:crafting_decorated_pot", "category": "misc"}`), []);
  assert.deepEqual(run("recipe", `{"type": "minecraft:crafting_special_repairitem", "categry": "misc"}`), ["jsonUnknownKey Unknown key “categry”"]);
});

test("a_trailing_comma_is_named_as_such", () => {
  const advancement = `{"criteria": {"a": {"trigger": "minecraft:tick"}}, "requirements": [["a"],]}`;
  assert.deepEqual(run("advancement", advancement), ["jsonSyntax Trailing comma before ']'"]);
  assert.deepEqual(run("tag/block", `{"values": [],}`), ["jsonSyntax Trailing comma before '}'"]);
  assert.deepEqual(run("tag/block", `{"values": [];}`), ["jsonSyntax Trailing ';' before '}'"]);
});

test("a_comment_after_the_value_of_a_lenient_file_is_an_error", () => {
  assert.deepEqual(run("tag/block", `// before\n{"values": []} // after`), ["jsonSyntax Unexpected content after the JSON value"]);
});

test("an_unquoted_string_is_marked_over_its_whole_text", () => {
  const data = forVersion("1.20.4");
  const text = "{values: [nope]}";
  const c = datajson.check(text, "Lenient", datajson.schema("tag/block", data.mcdoc)!, data.mcdoc, data);
  const spans = c.diags.map((d) => text.slice(d.start, d.end));
  assert.deepEqual(spans, ["nope"]);
});

test("each_kind_is_read_as_the_game_reads_it", () => {
  assert.deepEqual(run("predicate", `{"condition": "random_chance", "chance": 0.5} {}`), []);
  const lenient = `/* stones */ {values = ['stone'; "#minecraft:logs",] # end\n}`;
  assert.deepEqual(run("tag/block", lenient), ["jsonType Expected a string or an object", "ref tag/block minecraft:logs"]);
  assert.deepEqual(run("predicate", `\ufeff{"condition": "random_chance", "chance": 0.5}`), []);
});

/** The labels offered where `|` stands, with `t:main` as the project's only function. */
function offered(kind: Kind, text: string): string[] {
  const data = forVersion("1.20.4");
  const doc = data.mcdoc;
  const offset = text.indexOf("|");
  const ids = (k: Kind) => (k === "function" ? ["t:main"] : []);
  return datajson.complete(text.replaceAll("|", ""), offset, datajson.schema(kind, doc)!, doc, data, ids).map((s) => s.insert);
}

test("keys_follow_the_dispatcher_and_skip_the_present_ones", () => {
  assert.deepEqual(offered("predicate", `{"condition": "random_chance", "|`), [`"chance"`]);
  assert.deepEqual(offered("loot_table", `{"pools": [{"rol|`), [`"rolls"`]);
});

test("keys_of_a_map_by_id_come_from_the_registry", () => {
  let keys = offered("predicate", `{"condition": "entity_properties", "entity": "this", "predicate": {"effects": {"minecraft:spe|`);
  assert.ok(keys.includes(`"minecraft:speed"`), JSON.stringify(keys));
  keys = offered("predicate", `{"condition": "entity_properties", "entity": "this", "predicate": {"effects": {"speed": {}, "minecraft:spe|`);
  assert.ok(!keys.includes(`"minecraft:speed"`), JSON.stringify(keys));
});

test("values_come_from_registries_enums_booleans_and_the_project", () => {
  assert.ok(offered("predicate", `{"condition": "|"}`).includes(`"minecraft:random_chance"`));
  assert.ok(offered("predicate", `{"condition": "ran|"}`).includes(`"minecraft:random_chance"`));
  assert.deepEqual(offered("predicate", `{"condition": "entity_properties", "entity": "k|"}`), [`"killer"`, `"killer_player"`]);
  assert.ok(offered("tag/item", `{"values": ["sto|`).includes(`"minecraft:stone"`));
  assert.deepEqual(offered("trim_pattern", `{"decal": |}`), ["true", "false"]);
  assert.deepEqual(offered("advancement", `{"rewards": {"function": "|"}}`), [`"t:main"`]);
});
