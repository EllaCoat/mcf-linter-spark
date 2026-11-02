import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { compareStr } from "../../src/core/chars.ts";
import { Config } from "../../src/core/config.ts";
import { loadVersionData } from "../../src/core/data.ts";
import { type Kind, kind } from "../../src/core/facts.ts";
import {
  type FileId,
  Project,
  classify,
  comparePaths,
  discoverPacks,
  functionTagRefs,
  joinPath,
  pathStartsWith,
  readText,
  stripPrefix,
} from "../../src/core/project.ts";
import { RELEASES, cmp, parse } from "../../src/core/version.ts";

const old = await loadVersionData("1.20.4");
const new121 = await loadVersionData("1.21");
const latest = await loadVersionData("26.3");

const TESTS = join(tmpdir(), "ai-agent", "mcf-linter-spark-ts-tests");

/** Writes the files under a fresh directory of the tests and returns it. */
function writeFiles(name: string, files: readonly (readonly [string, string])[]): string {
  const root = join(TESTS, name);
  rmSync(root, { recursive: true, force: true });
  for (const [rel, text] of files) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return root;
}

function load(root: string, config: Config = new Config()): Promise<Project> {
  return Project.load(root, config, { ignore: [], maxDepth: 0 });
}

function fidOf(p: Project, rel: string): FileId {
  const fid = p.files.findIndex((f) => f.rel === rel);
  assert.notEqual(fid, -1, rel);
  return fid;
}

/** The code and the text of each diagnostic of a file. */
function reported(p: Project, rel: string): [string, string][] {
  const fid = fidOf(p, rel);
  const text = p.files[fid]!.text;
  return p.diagnostics(fid).map((d) => [d.code, text.slice(d.start, d.end)]);
}

function sorted(v: string[]): string[] {
  return [...v].sort(compareStr);
}

test("classifies_paths", () => {
  assert.deepEqual(classify("functions/a/b.mcfunction", old), [kind.FUNCTION, "a/b"]);
  assert.deepEqual(classify("functions/a/.mcfunction", old), [kind.FUNCTION, "a/"]);
  assert.deepEqual(classify("tags/functions/load.json", old), [kind.FUNCTION_TAG, "load"]);
  assert.deepEqual(classify("worldgen/biome/x.json", old), ["worldgen/biome", "x"]);
  assert.deepEqual(classify("worldgen/template_pool/a/b.json", old), ["worldgen/template_pool", "a/b"]);
  assert.deepEqual(classify("tags/worldgen/biome/x.json", old), ["tag/worldgen/biome", "x"]);
  assert.deepEqual(classify("tags/damage_type/x.json", old), ["tag/damage_type", "x"]);
  assert.equal(classify("functions/readme.txt", old), undefined);
  assert.equal(classify("function/a/b.mcfunction", old), undefined);
  assert.equal(classify("tags/block/x.json", old), undefined);
  assert.equal(classify("enchantment/x.json", old), undefined);

  assert.deepEqual(classify("function/a/b.mcfunction", new121), [kind.FUNCTION, "a/b"]);
  assert.deepEqual(classify("tags/block/x.json", new121), [kind.BLOCK_TAG, "x"]);
  assert.equal(classify("functions/a/b.mcfunction", new121), undefined);
  assert.deepEqual(classify("damage_type/x.json", new121), [kind.DAMAGE_TYPE, "x"]);
  assert.deepEqual(classify("enchantment/x.json", new121), ["enchantment", "x"]);
  assert.deepEqual(classify("tags/enchantment/x.json", new121), ["tag/enchantment", "x"]);
  assert.equal(classify("tag/enchantment/x.json", new121), undefined);
  assert.equal(classify("tag/worldgen/biome/x.json", new121), undefined);
  assert.equal(classify("worldgen/feature/x.json", new121), undefined);

  assert.deepEqual(classify("worldgen/feature/x.json", latest), ["worldgen/feature", "x"]);
  assert.equal(classify("worldgen/configured_feature/x.json", latest), undefined);
});

test("reads_function_tag_values", () => {
  const text = '{"values": ["a:b", "#a:t", {"id": "c:d", "required": false}, {"id": "e:f"}]}';
  const refs = functionTagRefs(text);
  const ids = refs.map((e): [Kind, string, boolean] => [e.target.kind, e.target.id, e.required]);
  assert.deepEqual(ids, [
    [kind.FUNCTION, "a:b", true],
    [kind.FUNCTION_TAG, "a:t", true],
    [kind.FUNCTION, "c:d", false],
    [kind.FUNCTION, "e:f", true],
  ]);
  assert.equal(text.slice(refs[0]!.target.start, refs[0]!.target.end), "a:b");
});

test("function_tags_are_read_as_leniently_as_the_game_reads_them", () => {
  const text = "// loaded first\n{values: ['a:b', \"#a:t\"; load]}";
  const refs = functionTagRefs(text);
  const found = refs.map((e): [Kind, string, string] => [e.target.kind, e.target.id, text.slice(e.target.start, e.target.end)]);
  assert.deepEqual(found, [
    [kind.FUNCTION, "a:b", "a:b"],
    [kind.FUNCTION_TAG, "a:t", "#a:t"],
    [kind.FUNCTION, "minecraft:load", "load"],
  ]);
});

test("visible_ids_follow_the_imp_doc_visibility", async () => {
  const root = writeFiles("visible_ids", [
    ["pack.mcmeta", "{}"],
    ["data/t/functions/api.mcfunction", "#> t:api\n# @public\n"],
    ["data/t/functions/internal.mcfunction", "#> t:internal\n# @within function t:caller\n"],
    ["data/t/functions/caller.mcfunction", ""],
    ["data/t/functions/other.mcfunction", ""],
    ["data/t/functions/_index.d.mcfunction", "#> t:_index.d\n# @private\n\n#> holders\n# @within function t:caller\n    #declare score_holder $Secret\n"],
  ]);
  const p = await load(root);
  const caller = fidOf(p, "data/t/functions/caller.mcfunction");
  const other = fidOf(p, "data/t/functions/other.mcfunction");
  let functions = sorted(p.visibleIds(caller, kind.FUNCTION));
  assert.ok(functions.includes("t:api") && functions.includes("t:internal"));
  functions = sorted(p.visibleIds(other, kind.FUNCTION));
  assert.ok(functions.includes("t:api") && !functions.includes("t:internal"));
  assert.deepEqual(p.visibleIds(caller, kind.SCORE_HOLDER), ["$Secret"]);
  assert.deepEqual(p.visibleIds(other, kind.SCORE_HOLDER), []);
});

test("a_1_21_pack_is_read_from_the_singular_directories", async () => {
  const root = writeFiles("singular_dirs", [
    ["pack.mcmeta", "{}"],
    ["data/t/function/main.mcfunction", "function t:lib\nfunction t:old\n"],
    ["data/t/function/lib.mcfunction", "say lib\n"],
    ["data/t/functions/old.mcfunction", "say old\n"],
    ["data/t/tags/function/load.json", '{"values": ["t:main"]}'],
  ]);
  const config = Config.fromSettings('{"datapack.env.cmdVersion": "1.21", "datapack.lint.strictFunctionCheck": ["error", true]}');
  let p = await load(root, config);
  const ids = p.files.map((f): [Kind, string] => [f.kind, f.id]).sort((a, b) => compareStr(a[0], b[0]) || compareStr(a[1], b[1]));
  assert.deepEqual(ids, [
    [kind.FUNCTION, "t:lib"],
    [kind.FUNCTION, "t:main"],
    [kind.FUNCTION_TAG, "t:load"],
  ]);
  const unresolved = reported(p, "data/t/function/main.mcfunction").map((d) => d[1]);
  assert.deepEqual(unresolved, ["t:old"]);
  assert.equal(p.notices.length, 0);

  p = await load(root);
  assert.equal(p.files.length, 1);
  assert.equal(p.notices.length, 1);
  assert.ok(p.notices[0]!.startsWith("data/t/function/ is laid out for 1.21 and later"), p.notices[0]);
});

test("every_release_checks_a_pack_laid_out_for_it", async () => {
  for (const [version] of RELEASES) {
    const since = (v: number[]): boolean => cmp(parse(version), v) >= 0;
    const dir = (plural: string): string => (since([1, 21]) ? plural.slice(0, -1) : plural);
    const predicate = since([26, 3])
      ? '{"type": "minecraft:random_chance", "chance": 0.5}'
      : '{"condition": "minecraft:random_chance", "chance": 0.5}';
    const root = writeFiles(`release-${version}`, [
      [`data/t/${dir("functions")}/main.mcfunction`, "function t:lib\nfunction #t:load\nloot give @s loot t:chest\nexecute if predicate t:p run say hi\n"],
      [`data/t/${dir("functions")}/lib.mcfunction`, "say lib\n"],
      [`data/t/tags/${dir("functions")}/load.json`, '{"values": ["t:lib"]}'],
      [`data/t/${dir("loot_tables")}/chest.json`, '{"pools": []}'],
      [`data/t/${dir("predicates")}/p.json`, predicate],
      ["pack.mcmeta", "{}"],
    ]);
    const settings = JSON.stringify({
      "datapack.env.cmdVersion": version,
      "datapack.lint.strictFunctionCheck": ["error", true],
      "datapack.lint.strictFunctionTagCheck": ["error", true],
      "datapack.lint.strictLootTableCheck": ["error", true],
      "datapack.lint.strictPredicateCheck": ["error", true],
    });
    const p = await load(root, Config.fromSettings(settings));
    assert.equal(p.files.length, 5, version);
    const diagnostics = p.allDiagnostics().flatMap(([, d]) => d.map((x) => x.message));
    assert.deepEqual(diagnostics, [], version);
  }
});

test("data_pack_registries_of_each_release_resolve_the_packs_own_files", async () => {
  const check = async (version: string, files: readonly (readonly [string, string])[], main: string): Promise<[string, string][]> => {
    const all: (readonly [string, string])[] = [...files, ["pack.mcmeta", "{}"]];
    if (!files.some(([rel]) => rel === main)) all.push([main, ""]);
    const root = writeFiles(`registries-${version}`, all);
    const settings = JSON.stringify({ "datapack.env.cmdVersion": version, "datapack.lint.strictEnchantmentCheck": ["error", "always"] });
    const p = await load(root, Config.fromSettings(settings));
    return reported(p, main);
  };
  const main120 = "data/t/functions/main.mcfunction";
  const reported120 = await check(
    "1.20.4",
    [
      [main120, "locate biome t:b\nlocate biome t:none\nenchant @s t:e\n"],
      ["data/t/worldgen/biome/b.json", "{}"],
      ["data/t/enchantment/e.json", "{}"],
    ],
    main120,
  );
  assert.deepEqual(reported120, [
    ["unresolved", "t:none"],
    ["strictEnchantmentCheck", "t:e"],
  ]);

  const main = "data/t/function/main.mcfunction";
  const reported121 = await check(
    "1.21",
    [
      [main, "enchant @s t:e\nenchant @s t:none\nexecute if biome ~ ~ ~ #t:b run say hi\n"],
      ["data/t/enchantment/e.json", "{}"],
      ["data/t/tags/worldgen/biome/b.json", '{"values": []}'],
    ],
    main,
  );
  assert.deepEqual(reported121, [["strictEnchantmentCheck", "t:none"]]);

  const reported263 = await check(
    "26.3",
    [
      [main, "place feature t:f\nplace feature t:none\ndialog show @s t:d\ndialog show @s minecraft:server_links\n"],
      ["data/t/worldgen/feature/f.json", "{}"],
      ["data/t/dialog/d.json", "{}"],
    ],
    main,
  );
  assert.deepEqual(reported263, [["unresolved", "t:none"]]);
});

test("ids_of_26_3_written_as_old_slots_or_numbers_are_warnings_unless_a_pack_defines_them", async () => {
  const main = "data/t/function/main.mcfunction";
  const lines = [
    "item replace entity @s horse.saddle with stone",
    "item replace entity @s minecraft:horse.armor with stone",
    "execute if items entity @s villager.7 * run say a",
    "execute if items entity @s minecraft:weapon.mainhand * run say a",
    "compute default integer -1",
    "compute default float 1.5",
    "compute default float 2d",
    "compute default integer 3b",
    "item replace entity @s villager.3 with stone",
    "item replace entity @s villager.8 with stone",
    "compute default integer t:none",
    "test locate t:x",
    "item replace entity @s saddle with stone",
    "execute if items entity @s mob.inventory.7 * run say a",
    'compute default integer {type:"minecraft:constant",value:-1}',
    'compute default float {type:"minecraft:constant",value:1.5f}',
  ];
  const root = writeFiles("misread-ids", [
    ["pack.mcmeta", "{}"],
    [main, `${lines.join("\n")}\n`],
    ["data/minecraft/slot_source/villager.3.json", "{}"],
  ]);
  const p = await load(root, Config.fromSettings('{"datapack.env.cmdVersion": "26.3"}'));
  const found = p.diagnostics(fidOf(p, main)).map((d) => [d.severity, d.message]);
  const warning = (m: string): string[] => ["Warning", m];
  const hint = (m: string): string[] => ["Hint", m];
  assert.deepEqual(found, [
    warning("Failed to resolve slot_source 'minecraft:horse.saddle': 'horse.saddle' is no longer a slot, so it is read as an id. The slot is now 'saddle'"),
    warning("Failed to resolve slot_source 'minecraft:horse.armor': 'horse.armor' is no longer a slot, so it is read as an id. The slot is now 'armor.body'"),
    warning("Failed to resolve slot_source 'minecraft:villager.7': 'villager.7' is no longer a slot, so it is read as an id. The slot is now 'mob.inventory.7'"),
    warning("Failed to resolve slot_source 'minecraft:weapon.mainhand': a slot with a namespace is read as an id. Write the slot as 'weapon.mainhand'"),
    warning('Failed to resolve context_int_provider \'minecraft:-1\': a number here is read as an id. Write a constant as {type:"minecraft:constant",value:-1}'),
    warning('Failed to resolve context_float_provider \'minecraft:1.5\': a number here is read as an id. Write a constant as {type:"minecraft:constant",value:1.5f}'),
    warning('Failed to resolve context_float_provider \'minecraft:2d\': a number here is read as an id. Write a constant as {type:"minecraft:constant",value:2f}'),
    warning('Failed to resolve context_int_provider \'minecraft:3b\': a number here is read as an id. Write a constant as {type:"minecraft:constant",value:3}'),
    hint("Failed to resolve slot_source 'minecraft:villager.8'"),
    hint("Failed to resolve context_int_provider 't:none'"),
    hint("Failed to resolve test_instance 't:x'"),
  ]);
});

test("a_missing_dimension_type_is_a_hint_whatever_the_registry_rule", async () => {
  const dimension = '{"type": "t:missing", "generator": {"type": "minecraft:flat", "settings": {"layers": [], "biome": "minecraft:plains"}}}';
  const root = writeFiles("dimension_type", [
    ["pack.mcmeta", "{}"],
    ["data/t/dimension/d.json", dimension],
  ]);
  const config = Config.fromSettings('{"datapack.lint.strictDimensionTypeCheck": ["error", "always"]}');
  const p = await load(root, config);
  const codes = reported(p, "data/t/dimension/d.json").map((d) => d[0]);
  assert.ok(codes.includes("unresolved") && !codes.includes("strictDimensionTypeCheck"), String(codes));
});

/** A pack written under the temp directory, with the IMP-Doc rules of the
 * modified Spyglass enabled. */
function spyglassProject(name: string, files: readonly (readonly [string, string])[]): Promise<Project> {
  const root = writeFiles(name, [...files, ["pack.mcmeta", "{}"]]);
  const config = new Config();
  config.mergeSpyglass('{"lint": {"impDocVisibilityConflict": "warning", "impDocBareDeclaration": "warning", "impDocPrivateBestEffort": "warning"}}');
  return load(root, config);
}

test("writes_under_a_doc_block_conflict_with_restricted_declarations", async () => {
  const p = await spyglassProject("conflict-writes", [
    [
      "data/a/functions/load.mcfunction",
      "#> a:load\n# @public\n\n#> init\n    scoreboard players set $X Global 0\n    execute unless data storage b: _ run say hi\n\nscoreboard players set $Y Global 0\n",
    ],
    [
      "data/b/functions/_index.d.mcfunction",
      "#> b:_index.d\n# @private\n\n#> Val\n# @within function a:load\n    #declare score_holder $X\n    #declare score_holder $Y\n    #declare storage b:\n",
    ],
  ]);
  const codes = reported(p, "data/a/functions/load.mcfunction").filter((d) => d[0] === "impDocVisibilityConflict");
  assert.deepEqual(codes, [
    ["impDocVisibilityConflict", "$X"],
    ["impDocVisibilityConflict", "b:"],
  ]);
});

test("a_written_symbol_resolves_with_a_spyglass_json", async () => {
  const text =
    "data get storage a:x V\ndata modify storage b:s V set value 1\nscoreboard players set $A O 1\nscoreboard players get $A O\nscoreboard players get $B O\n";
  const p = await spyglassProject("written", [
    ["data/a/functions/f.mcfunction", text],
    ["data/b/functions/_index.d.mcfunction", "#> b:_index.d\n# @private\n\n#> v\n# @within function b:**\n    #declare storage b:s\n"],
  ]);
  const unresolved = reported(p, "data/a/functions/f.mcfunction")
    .filter((d) => d[0] === "unresolved")
    .map((d) => d[1]);
  assert.deepEqual(unresolved, ["$B"]);
});

test("restricted_references_are_worded_as_the_modified_spyglass_does", async () => {
  const p = await spyglassProject("restricted-messages", [
    ["data/a/functions/private.mcfunction", "#> a:private\n# @private\n\nsay hi\n"],
    ["data/a/functions/within.mcfunction", "#> a:within\n# @within function a:x\n\nsay hi\n"],
    ["data/a/functions/internal.mcfunction", "#> a:internal\n# @internal\n\nsay hi\n"],
    ["data/b/functions/caller.mcfunction", "function a:private\nfunction a:within\nfunction a:internal\n"],
  ]);
  const fid = fidOf(p, "data/b/functions/caller.mcfunction");
  const messages = p
    .diagnostics(fid)
    .filter((d) => d.code === "impDocPrivate")
    .map((d) => d.message);
  assert.deepEqual(messages, [
    "Function “a:private” is private to “a:private” and cannot be called from “b:caller”",
    "Function “a:within” is restricted by “a:within” and cannot be called from “b:caller”",
    "Function “a:internal” is internal to the namespace of “a:internal” and cannot be called from “b:caller”",
  ]);
});

test("a_function_that_loses_the_linked_line_rechecks_the_link", async () => {
  const p = await spyglassProject("link-recheck", [
    ["data/t/functions/a.mcfunction", "# [b](t:b#L3)\nsay a\n"],
    ["data/t/functions/b.mcfunction", "say 1\nsay 2\nsay 3\n"],
    ["data/t/functions/c.mcfunction", "function t:b\n"],
  ]);
  p.enableIncremental();
  const [a, b, c] = ["a", "b", "c"].map((n) => fidOf(p, `data/t/functions/${n}.mcfunction`)) as [FileId, FileId, FileId];
  const affected = p.setText(b, "say 1\n");
  assert.ok(affected.includes(a) && !affected.includes(c), String(affected));
  assert.deepEqual(reported(p, "data/t/functions/a.mcfunction"), [["commentLink", "t:b#L3"]]);
});

test("an_edit_that_only_changes_the_scope_rewords_the_referrers", async () => {
  const p = await spyglassProject("scope-edit", [
    ["data/a/functions/f.mcfunction", "#> a:f\n# @private\n\nsay hi\n"],
    ["data/b/functions/caller.mcfunction", "function a:f\n"],
  ]);
  p.enableIncremental();
  const target = fidOf(p, "data/a/functions/f.mcfunction");
  const caller = fidOf(p, "data/b/functions/caller.mcfunction");
  const affected = p.setText(target, "#> a:f\n# @within function a:f\n\nsay hi\n");
  assert.ok(affected.includes(caller));
  const messages = p.diagnostics(caller).map((d) => d.message);
  assert.deepEqual(messages, ["Function “a:f” is restricted by “a:f” and cannot be called from “b:caller”"]);
});

test("within_everything_is_restricted_for_conflicts", async () => {
  const p = await spyglassProject("conflict-within-all", [
    ["data/a/functions/buff.mcfunction", "#> a:buff\n# @public\n\n#>buff\n    data modify storage api: ID set value 1\n"],
    ["data/minecraft/functions/declares.d.mcfunction", "#> minecraft:declares.d\n# @private\n\n#> declare\n# @within **\n    #declare storage api:\n"],
  ]);
  const codes = reported(p, "data/a/functions/buff.mcfunction").filter((d) => d[0] === "impDocVisibilityConflict");
  assert.deepEqual(codes, [["impDocVisibilityConflict", "api:"]]);
});

test("commands_and_json_ids_are_references_to_functions", async () => {
  const p = await spyglassProject("references", [
    ["data/t/functions/a.mcfunction", "function t:b\n"],
    ["data/t/functions/b.mcfunction", "say 1\n"],
    ["data/t/advancements/x.json", '{"criteria": {"a": {"trigger": "minecraft:tick"}}, "rewards": {"function": "t:b"}}'],
  ]);
  assert.equal(p.references(kind.FUNCTION, "t:b").length, 2);
  const json = fidOf(p, "data/t/advancements/x.json");
  const at = p.files[json]!.text.indexOf("t:b");
  assert.deepEqual(p.symbolAt(json, at + 1), [kind.FUNCTION, "t:b"]);
});

test("a_missing_optional_function_tag_entry_is_not_reported", async () => {
  const p = await spyglassProject("optional-tag-entries", [
    ["data/t/functions/private.mcfunction", "#> t:private\n# @private\n\nsay hi\n"],
    [
      "data/t/tags/functions/load.json",
      '{"values": [{"id": "t:missing", "required": false}, {"id": "#t:no_tag", "required": false}, {"id": "t:private", "required": false}, "t:missing2"]}',
    ],
  ]);
  const fid = fidOf(p, "data/t/tags/functions/load.json");
  const messages = p.diagnostics(fid).map((d) => d.message);
  assert.deepEqual(messages, ["Function “t:private” is private to “t:private” and cannot be called from “t:load”", "Failed to resolve function 't:missing2'"]);
  assert.equal(p.references(kind.FUNCTION, "t:missing").length, 1);
});

test("comment_links_name_a_function_and_a_line_it_has", async () => {
  const p = await spyglassProject("comment-links", [
    ["data/t/functions/a.mcfunction", "# see [b](t:b#L2), [far](t:b#L9), [gone](t:none), [web](https://example.com/a)\nsay a\n"],
    ["data/t/functions/b.mcfunction", "say 1\nsay 2\n"],
  ]);
  assert.deepEqual(reported(p, "data/t/functions/a.mcfunction"), [
    ["commentLink", "t:b#L9"],
    ["commentLink", "t:none"],
  ]);
  assert.equal(p.references(kind.FUNCTION, "t:b").length, 2);
});

test("a_comment_link_with_a_line_leads_to_that_line", async () => {
  const p = await spyglassProject("comment-link-line", [
    ["data/t/functions/a.mcfunction", "# [b](t:b#L2) [top](t:b)\nsay a\n"],
    ["data/t/functions/b.mcfunction", "say 1\nsay 2\n"],
  ]);
  const a = p.fileIdOf(joinPath(p.root, "data/t/functions/a.mcfunction"))!;
  assert.notEqual(a, undefined);
  const b = p.functionFile("t:b")!;
  const text = p.files[a]!.text;
  assert.deepEqual(p.linkLineAt(a, text.indexOf("t:b#") + 1), [b, 2]);
  assert.equal(p.linkLineAt(a, text.indexOf("t:b)") + 1), undefined);
});

// The rules for paths, directory listings and text decoding where this project does not follow
// the defaults of `node:path` and `node:fs`.

test("paths_are_compared_by_component", () => {
  assert.equal(pathStartsWith("/a/b/c", "/a/b"), true);
  assert.equal(pathStartsWith("/a/bc", "/a/b"), false);
  assert.equal(pathStartsWith("/a/b", "/a/b/c"), false);
  assert.equal(pathStartsWith("/a//b/./c", "/a/b"), true);
  assert.equal(pathStartsWith("./a/b", "."), true);
  assert.equal(pathStartsWith("a/b", "."), false);
  assert.equal(stripPrefix("/a/b/c/d", "/a/b"), "c/d");
  assert.equal(stripPrefix("/a/b", "/a/b"), "");
  assert.equal(stripPrefix("/a/b/", "/a"), "b");
  assert.equal(stripPrefix("/a/bc", "/a/b"), undefined);
  assert.equal(stripPrefix("./a/./b", "."), "a/./b");
  assert.ok(comparePaths("a/b", "a-b/x") < 0);
  assert.ok(comparePaths("a", "a/b") < 0);
  assert.ok(comparePaths("a/b", "a/b") === 0);
  assert.ok(comparePaths("/a", "a") < 0);
  assert.equal(joinPath("a", "b"), process.platform === "win32" ? "a\\b" : "a/b");
  assert.equal(joinPath("a/", "b"), "a/b");
  assert.equal(joinPath("", "b"), "b");
  if (process.platform === "win32") {
    assert.equal(pathStartsWith("C:\\a\\b", "c:/a"), true);
    assert.equal(pathStartsWith("C:\\ab", "C:\\a"), false);
    assert.equal(pathStartsWith("C:\\A\\b", "C:\\a"), false);
    assert.equal(stripPrefix("C:\\a/b\\c", "c:\\a"), "b\\c");
    assert.equal(pathStartsWith("\\\\srv\\share\\x", "\\\\srv\\share"), true);
  }
});

test("text_is_read_as_from_utf8_lossy_reads_it", () => {
  const root = writeFiles("read-text", []);
  mkdirSync(root, { recursive: true });
  const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0xe2, 0x82, 0x62, 0xf0, 0x90, 0x80, 0x63, 0xff, 0xed, 0xa0, 0x80]);
  writeFileSync(join(root, "bytes"), bytes);
  assert.equal(readText(join(root, "bytes")), "\ufeffa\ufffdb\ufffdc\ufffd\ufffd\ufffd\ufffd");
  assert.equal(readText(join(root, "missing")), "");
  assert.equal(readText(root), "");
});

test("packs_are_found_in_path_order_and_a_link_back_to_the_root_is_skipped", () => {
  const root = writeFiles("discover", [
    ["a/b/pack.mcmeta", "{}"],
    ["a/b/data/x", ""],
    ["a-b/pack.mcmeta", "{}"],
    ["a-b/data/x", ""],
    [".hidden/pack.mcmeta", "{}"],
    [".hidden/data/x", ""],
    ["node_modules/pack.mcmeta", "{}"],
    ["node_modules/data/x", ""],
    ["c/d/e/pack.mcmeta", "{}"],
    ["c/d/e/data/x", ""],
  ]);
  symlinkSync(root, join(root, "loop"), "junction");
  assert.deepEqual(discoverPacks(root, 2), [join(root, "a", "b"), join(root, "a-b")]);
  assert.deepEqual(discoverPacks(root, 3), [join(root, "a", "b"), join(root, "a-b"), join(root, "c", "d", "e")]);
  assert.equal(discoverPacks(root, Infinity).length, 3);
  assert.deepEqual(discoverPacks(root, 0), []);
});

test("a_link_to_a_directory_is_listed_as_a_file_and_not_followed", async () => {
  const root = writeFiles("links", [
    ["pack.mcmeta", "{}"],
    ["data/t/functions/real.mcfunction", "say 1\n"],
    ["elsewhere/inner.mcfunction", "say 2\n"],
  ]);
  symlinkSync(join(root, "elsewhere"), join(root, "data", "t", "functions", "linked.mcfunction"), "junction");
  symlinkSync(join(root, "data", "t"), join(root, "data", "t", "functions", "back"), "junction");
  const p = await load(root);
  const files = p.files.map((f): [string, string] => [f.id, f.text]).sort((a, b) => compareStr(a[0], b[0]));
  assert.deepEqual(files, [
    ["t:linked", ""],
    ["t:real", "say 1\n"],
  ]);
});

test("files_can_be_added_and_removed", async () => {
  const root = writeFiles("add-remove", [
    ["pack.mcmeta", "{}"],
    ["data/t/functions/a.mcfunction", "function t:b\n"],
  ]);
  const config = new Config();
  config.setRule("strictFunctionCheck", ["error", true]);
  const p = await load(root, config);
  p.enableIncremental();
  const a = fidOf(p, "data/t/functions/a.mcfunction");
  assert.deepEqual(p.diagnostics(a).map((d) => d.message), ["Failed to resolve function 't:b'"]);

  const path = join(root, "data", "t", "functions", "b.mcfunction");
  writeFileSync(path, "say b\n");
  const added = p.addFile(path)!;
  assert.ok(added[1].includes(a) && added[1].includes(added[0]), String(added[1]));
  assert.equal(p.files[added[0]]!.rel, "data/t/functions/b.mcfunction");
  assert.equal(p.files[added[0]]!.id, "t:b");
  assert.deepEqual(p.diagnostics(a), []);
  assert.equal(p.fileIdOf(path.toUpperCase()), added[0]);
  assert.deepEqual(p.filesUnder(join(root, "data")), [a, added[0]]);
  assert.equal(p.addFile(join(root, "data", "t", "functions", "readme.txt")), undefined);
  assert.equal(p.addFile(join(root, "outside", "x.mcfunction")), undefined);

  const removed = p.removeFile(added[0]);
  assert.deepEqual(removed, [a]);
  assert.equal(p.fileIdOf(path), undefined);
  assert.deepEqual(p.filesUnder(join(root, "data")), [a]);
  assert.deepEqual(p.diagnostics(a).map((d) => d.message), ["Failed to resolve function 't:b'"]);
  assert.deepEqual(p.ids(kind.FUNCTION), ["t:a"]);
});
