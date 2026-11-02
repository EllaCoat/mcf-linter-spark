import assert from "node:assert/strict";
import { test } from "node:test";

import * as nbt from "../../src/core/args/nbt.ts";
import { Config } from "../../src/core/config.ts";
import { loadVersionData } from "../../src/core/data.ts";
import { type FileFacts, analyze, commentLinks } from "../../src/core/mcfunction.ts";

const data = await loadVersionData("1.20.4");

function run(text: string): FileFacts {
  return analyze(text, "a:b/c", data, new Config());
}

test("function_doc_with_matching_id_sets_visibility", () => {
  const f = run("#> a:b/c\n# @within function a:b/**\n\nsay hi\n");
  const doc = f.functionDoc!;
  assert.ok(doc, "function doc");
  assert.equal(doc.visibility.length, 1);
  assert.equal(doc.visibility[0]!.kind, "function");
});

test("annotations_deeper_than_the_limit_are_read_up_to_it", () => {
  const f = run(`#> a:b/c\n# @within ${"function ".repeat(10_000)}\nsay hi\n`);
  assert.ok(f.functionDoc !== undefined);
});

test("function_doc_with_other_id_is_ignored", () => {
  const f = run("#> a:other\n# @private\nsay hi\n");
  assert.equal(f.functionDoc, undefined);
});

test("declaration_doc_attaches_indented_lines", () => {
  const f = run("\n#> values\n# @within\n#   function a:b/**\n    #declare score_holder $A\n    #declare score_holder $B\n#declare score_holder $C\n");
  assert.equal(f.decls.length, 3);
  assert.equal(f.decls[0]!.visibility?.length, 1);
  assert.equal(f.decls[1]!.visibility?.length, 1);
  assert.equal(f.decls[2]!.visibility, undefined);
});

test("bare_hash_lines_continue_a_doc", () => {
  let f = run("#> a:b/c\n#\n# text\n#\n# @within function a:x\n\nsay hi\n");
  assert.equal(f.functionDoc!.visibility.length, 1);
  f = run("#> a:b/c\r\n#\r\n# @private\r\nsay hi\r\n");
  assert.equal(f.functionDoc!.visibility.length, 1);
});

test("first_attached_line_at_same_depth_stops_the_chain", () => {
  const f = run("\n#> v\n# @private\n#declare tag A\n#declare tag B\n");
  assert.notEqual(f.decls[0]!.visibility, undefined);
  assert.equal(f.decls[1]!.visibility, undefined);
});

test("alias_lines_are_read_with_the_attached_visibility", () => {
  const text = '\n#> aliases\n# @within function a:**\n    #alias vector origin 0 0 0\n#alias entity "a b" @e[type=marker,limit=1]\n';
  const f = run(text);
  assert.equal(f.aliases.length, 2);
  const a = f.aliases[0]!;
  assert.deepEqual([a.kind, a.name, a.value], ["alias/vector", "origin", "0 0 0"]);
  assert.equal(text.slice(a.start, a.end), "origin");
  assert.equal(a.visibility?.length, 1);
  const b = f.aliases[1]!;
  assert.deepEqual([b.kind, b.name, b.value], ["alias/entity", "a b", "@e[type=marker,limit=1]"]);
  assert.equal(text.slice(b.start, b.end), '"a b"');
  assert.equal(b.visibility, undefined);
});

test("malformed_alias_lines_are_comments", () => {
  for (const line of ["#alias block x y", "#alias vector origin", "#alias vector", "#alias", "#aliases vector x 0 0 0", '#alias vector "x 0']) {
    const f = run(`${line}\n`);
    assert.ok(f.aliases.length === 0 && f.diags.length === 0, line);
  }
});

test("within_children_flatten_per_pattern", () => {
  const f = run("\n#> v\n# @within function\n#     a:x\n#     a:y\n    #declare storage a:s\n");
  assert.equal(f.decls[0]!.visibility!.length, 2);
});

test("macro_lines", () => {
  assert.equal(run("$say $(x)\n").diags.length, 0);
  assert.equal(run("$say hi\n").diags.length, 1);
  assert.equal(run("$say $(x\n").diags.length, 1);
});

test("ids_outside_minecraft_get_a_hint_under_only_default_namespace", () => {
  const config = Config.fromSettings('{"datapack.lint.strictSoundEventCheck": ["error", "only-default-namespace"]}');
  const text = "playsound ogg:x master @a\nplaysound minecraft:nope master @a\n";
  const severities = (c: Config) => analyze(text, "a:b/c", data, c).diags.map((d) => d.severity);
  assert.deepEqual(severities(config), ["Hint", "Error"]);
  config.mergeSpyglass("{}");
  assert.deepEqual(severities(config), ["Error"]);
});

test("nbt_past_512_levels_is_a_warning_in_1_20_4_also_inside_a_string", () => {
  const deep = `${"{a:".repeat(513)}1${"}".repeat(513)}`;
  for (const line of [`data modify storage a:b x set value ${deep}`, `summon area_effect_cloud ~ ~ ~ {Particle:"item stone${deep}"}`]) {
    const found = run(`${line}\n`)
      .diags.filter((d) => d.severity !== "Hint")
      .map((d) => [d.severity, d.message]);
    assert.deepEqual(found, [["Warning", nbt.tooDeepToCheck()]], line);
  }
  const lists = `data modify storage a:b x set value ${"[".repeat(512)}1${"]".repeat(512)}\n`;
  assert.ok(run(lists).diags.every((d) => d.severity === "Hint"));
});

test("vanilla_selector_forms_parse", () => {
  for (const line of ["execute as @e[y_rotation=135..-135] run say a", "kill @e[tag=! Foo]", "kill 0-0-0-0-123456789"]) {
    const f = run(`${line}\n`);
    assert.ok(
      f.diags.every((d) => d.code !== "syntax"),
      `${line}: ${JSON.stringify(f.diags)}`,
    );
  }
  assert.ok(run("kill @e[distance=5..1]\n").diags.some((d) => d.code === "syntax"));
});

test("malformed_declarations_are_comments", () => {
  const f = run("#declare\n#declare foo bar\n#declare storage\n#declare storage a:b\n");
  assert.equal(f.diags.length, 0);
  assert.deepEqual(
    f.decls.map((d) => d.id),
    ["a:b"],
  );
});

test("macro_function_refs_skip_ids_built_at_run_time", () => {
  const f = run("$function a:$(T)/x\n$function a:b/$(T)\n$function a:b/c with storage a:b $(x)\n");
  assert.deepEqual(
    f.macroRefs.map((r) => r.id),
    ["a:b/c"],
  );
});

test("objective_add_inside_doc_gets_visibility", () => {
  const f = run("\n#> obj\n# @public\n    scoreboard objectives add Const dummy\n");
  assert.equal(f.decls.length, 1);
  assert.equal(f.decls[0]!.kind, "objective");
  assert.notEqual(f.decls[0]!.visibility, undefined);
});

test("comment_links_are_markdown_links_to_functions", () => {
  const links = commentLinks("# [a](t:x#L3) [b](t:y/z) [c](https://e.com/a) [d](nons) [e](t:z#L0) (t:w)");
  assert.deepEqual(links, [
    [6, 12, "t:x", 3],
    [18, 23, "t:y/z", undefined],
  ]);
});
