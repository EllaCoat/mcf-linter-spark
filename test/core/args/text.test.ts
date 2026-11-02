import assert from "node:assert/strict";
import { test } from "node:test";

import { ArgCtx, type ArgValue } from "../../../src/core/args/index.ts";
import { component, isJavaUuid, style } from "../../../src/core/args/text.ts";
import type { Effect } from "../../../src/core/command.ts";
import { Config } from "../../../src/core/config.ts";
import { forVersion, loadVersionData } from "../../../src/core/data.ts";
import { ParseError } from "../../../src/core/diag.ts";
import { MAX_DEPTH, parseValue } from "../../../src/core/json.ts";
import { type PResult, Reader } from "../../../src/core/reader.ts";

await loadVersionData("1.20.4");

interface Parsed {
  result: PResult<void>;
  end: number;
  effects: Effect[];
}

function parseWith(f: (r: Reader, cx: ArgCtx) => PResult<void>, src: string, base: number): Parsed {
  const effects: Effect[] = [];
  const values: ArgValue[] = [];
  const cx = new ArgCtx(forVersion("1.20.4"), new Config(), effects, "message", [], values);
  const r = new Reader(src, base);
  const result = f(r, cx);
  return { result, end: r.pos, effects };
}

function parseComponent(src: string): Parsed {
  return parseWith(component, src, 0);
}

function errorOf(p: Parsed): ParseError {
  assert.ok(p.result instanceof ParseError, "should be rejected");
  return p.result;
}

function assertOk(p: Parsed): void {
  if (p.result instanceof ParseError) assert.fail(p.result.message);
}

function refs(p: Parsed): [string, string, number, number][] {
  return p.effects.flatMap((e): [string, string, number, number][] =>
    e.kind === "Ref" || e.kind === "Write" ? [[e.ref.kind, e.ref.id, e.ref.start, e.ref.end]] : [],
  );
}

function kinds(p: Parsed): string[] {
  return refs(p).map((r) => r[0]);
}

/** File offsets of the first `needle` in `src`. */
function at(src: string, needle: string, base: number): [number, number] {
  const index = src.indexOf(needle);
  assert.notEqual(index, -1, needle);
  return [index + base, index + needle.length + base];
}

function accepts(sources: readonly string[]): void {
  for (const src of sources) {
    const p = parseComponent(src);
    if (p.result instanceof ParseError) assert.fail(`${src}: ${p.result.message}`);
    assert.equal(p.end, src.length, src);
  }
}

function rejects(sources: readonly string[]): void {
  for (const src of sources) {
    assert.ok(parseComponent(src).result instanceof ParseError, `${src} should be rejected`);
  }
}

function syntaxEnd(src: string): number | undefined {
  const r = new Reader(src, 0);
  return parseValue(r, 0) instanceof ParseError ? undefined : r.pos;
}

test("strings_accept_json_escapes_that_brigadier_rejects", () => {
  accepts(['"a\\n"', '{"text":"a\\u0002b\\n\\t\\r\\b\\f\\/\\\'\\"\\\\"}', '["é",{"text":"😀 \\ud83d"}]']);
  const r = new Reader('"😀A\\n"', 0);
  const parsed = parseValue(r, 0);
  assert.ok(!(parsed instanceof ParseError));
  assert.deepEqual(parsed.json, { kind: "Str", value: "\u{1F600}A\n" });
});

test("syntax_matches_gson_strict_mode", () => {
  // Positions are what Gson's `JsonReader` reports after reading one value.
  const cases: [string, number | undefined][] = [
    ['"a"', 3],
    ['"a" b', 3],
    ["'a'", undefined],
    ["a", undefined],
    ['{text:"a"}', undefined],
    ["{'text':'a'}", undefined],
    ['{"text":"a"}', 12],
    ['{"text":"a"} x', 12],
    ['{"text":"a"}x', 12],
    ['{"text": "a" ,\t"bold" : true }', 30],
    ['{"text":"a",}', undefined],
    ['{,"text":"a"}', undefined],
    ['{"text":"a" "b":1}', undefined],
    ['{"text" "a"}', undefined],
    ['{"text"="a"}', undefined],
    ['{"a":1;"b":2}', undefined],
    ['{"a":}', undefined],
    ['{"a"}', undefined],
    ["{", undefined],
    ['{"a":1', undefined],
    ["{}", 2],
    ["{ }", 3],
    ['{"a":{"b":[1,{"c":null}]}}', 26],
    ["[", undefined],
    ["[]", 2],
    ["[ ]", 3],
    ["[1", undefined],
    ["[1,", undefined],
    ["[1,]", undefined],
    ["[,1]", undefined],
    ["[1 2]", undefined],
    ["[1;2]", undefined],
    ["[[]]", 4],
    ['["a",["b"],{"c":1}]', 19],
    ["1", 1],
    ["1 2", 1],
    ["-1", 2],
    ["-0", 2],
    ["0", 1],
    ["00", undefined],
    ["01", undefined],
    ["-", undefined],
    ["-a", undefined],
    ["+1", undefined],
    [".5", undefined],
    ["-.5", undefined],
    ["1.", undefined],
    ["1.5", 3],
    ["1.5.5", undefined],
    ["1e3", 3],
    ["1E+3", 4],
    ["1e-3", 4],
    ["1e", undefined],
    ["1e+", undefined],
    ["1.e3", undefined],
    ["12abc", undefined],
    ["1,", 1],
    ["1]", 1],
    ["1}", 1],
    ["1:", 1],
    ["1/", undefined],
    ["1;", undefined],
    ["1#", undefined],
    ["1=", undefined],
    ["1\f", 1],
    ["true", 4],
    ["false", 5],
    ["null", 4],
    ["TRUE", 4],
    ["tRuE", 4],
    ["Null", 4],
    ["nul", undefined],
    ["truex", undefined],
    ["true1", undefined],
    ["true,", 4],
    ["true]", 4],
    ["true/", undefined],
    ["nulll", undefined],
    ["NaN", undefined],
    ["Infinity", undefined],
    ['"a\\n"', 5],
    ['"a\\u0002"', 9],
    ['"a\\x"', undefined],
    ['"a\\u00"', undefined],
    ['"a\\u00zz"', undefined],
    ['"a\\u12"', undefined],
    ['"a\\', undefined],
    ['"a\\\'"', 5],
    ['"a\\/"', 5],
    ['"a\\"b"', 6],
    ['"a\\\\"', 5],
    ['"a\\b\\f\\n\\r\\t"', 13],
    ['"\\ud83d"', 8],
    ['"\\ude00"', 8],
    ['"unterminated', undefined],
    ['"a\nb"', 5],
    ['"a\tb"', 5],
    ['"a\\\nb"', 6],
    ["// c\n1", undefined],
    ["/*x*/1", undefined],
    ["#x\n1", undefined],
    ["/ 1", undefined],
    [' "a"', 4],
    ['\n"a"', 4],
    ['\t"a"', 4],
    ['\r"a"', 4],
    ['\f"a"', undefined],
    ["]", undefined],
    ["}", undefined],
    [",", undefined],
    [":", undefined],
    [")", undefined],
    ["\\", undefined],
    ["@", undefined],
    ["", undefined],
    ['{"a":[1,2,3],"b":{"c":"d"}}', 27],
  ];
  for (const [src, expected] of cases) {
    assert.equal(syntaxEnd(src), expected, JSON.stringify(src));
  }
});

test("nesting_is_bounded", () => {
  const deep = (n: number): string => "[".repeat(n) + "]".repeat(n);
  assert.notEqual(syntaxEnd(deep(MAX_DEPTH)), undefined);
  assert.equal(syntaxEnd(deep(MAX_DEPTH + 1)), undefined);
});

test("syntax_errors_point_at_the_problem", () => {
  let e = errorOf(parseComponent('{"text":"a",}'));
  assert.deepEqual([e.start, e.end], [12, 13]);
  assert.ok(e.message.startsWith("Invalid chat component: "), e.message);

  e = errorOf(parseWith(component, '["a" "b"]', 40));
  assert.deepEqual([e.start, e.end], [45, 46]);

  e = errorOf(parseComponent('{"text":"a\\x"}'));
  assert.deepEqual([e.start, e.end], [11, 12]);

  e = errorOf(parseWith(style, '{"bold":tru', 0));
  assert.ok(e.message.startsWith("Invalid style: "), e.message);
});

test("the_value_ends_where_the_json_ends", () => {
  const p = parseComponent('{"text":"a"} rest');
  assertOk(p);
  assert.equal(p.end, 12);
  assert.equal(parseComponent('"a"').end, 3);
});

test("plain_strings_arrays_and_extra", () => {
  accepts([
    '"hello"',
    '""',
    '[""]',
    '["a",{"text":"b"},["c"]]',
    '{"text":"a"}',
    '{"text":""}',
    '{"text":"a","extra":["b",{"text":"c","extra":[{"text":"d","extra":["e"]}]}]}',
    '{"text":"a","extra":null}',
    '{"text":"a","unknown":1,"other":{}}',
  ]);
  rejects([
    "",
    "'hello'",
    "hello",
    "1",
    "1.5",
    "true",
    "false",
    "null",
    "[]",
    "[[]]",
    "{}",
    '{"extra":["a"]}',
    '{"text":1}',
    '{"text":true}',
    '{"text":null}',
    '{"text":[]}',
    '{"text":{"text":"a"}}',
    '{"text":"a","extra":[]}',
    '{"text":"a","extra":"b"}',
    '{"text":"a","extra":[1]}',
    '{"text":"a","extra":[true]}',
    '{"text":"a","extra":[{"text":"b"},{"unknown":1}]}',
    '{"text":"a","extra":[{"text":"b","color":"bogus"}]}',
    '{text:"a"}',
    '{"text":"a",}',
    '["a",]',
    '["a" "b"]',
  ]);
});

test("duplicate_and_null_keys_follow_gson_and_jsonops", () => {
  accepts([
    '{"text":"a","text":"b"}',
    '{"text":"a","color":"bogus","color":"red"}',
    '{"text":null,"translate":"a"}',
    '{"type":null,"text":"a"}',
    '{"text":"a","bold":null,"clickEvent":null,"hoverEvent":null}',
  ]);
  rejects(['{"text":"a","color":"red","color":"bogus"}', '{"text":"a","text":null}']);
});

test("the_first_contents_that_decodes_wins", () => {
  accepts([
    '{"text":true,"translate":"a"}',
    '{"text":true,"keybind":"k"}',
    '{"text":"a","translate":1}',
    '{"text":"a","translate":{}}',
  ]);
  rejects(['{"text":true,"translate":true}', '{"bold":true}']);
});

test("explicit_type_selects_the_contents", () => {
  accepts([
    '{"type":"text","text":"a"}',
    '{"type":"translatable","translate":"a"}',
    '{"type":"keybind","keybind":"k"}',
    '{"type":"score","score":{"name":"a","objective":"b"}}',
    '{"type":"selector","selector":"@a"}',
    '{"type":"nbt","nbt":"a","storage":"x:y"}',
  ]);
  rejects([
    '{"type":"text","translate":"a"}',
    '{"type":"foo","text":"a"}',
    '{"type":"TEXT","text":"a"}',
    '{"type":1,"text":"a"}',
    '{"type":true,"text":"a"}',
  ]);
});

test("translatable_with_arguments", () => {
  accepts([
    '{"translate":"a"}',
    '{"translate":"a","with":[]}',
    '{"translate":"a","with":["x",1,1.5,true,{"text":"y"},["a",{"text":"b"}]]}',
    '{"translate":"a","fallback":"b"}',
    '{"translate":"a","fallback":true}',
    '{"translate":"a","with":[{"translate":"b","with":["c"]}],"color":"red"}',
  ]);
  rejects([
    '{"translate":1}',
    '{"translate":true}',
    '{"translate":"a","with":"x"}',
    '{"translate":"a","with":{}}',
    '{"translate":"a","with":[null]}',
    '{"translate":"a","with":[[]]}',
    '{"translate":"a","with":[{"bogus":1}]}',
  ]);
});

test("keybind_needs_a_string", () => {
  accepts(['{"keybind":"key.jump"}']);
  rejects(['{"keybind":1}', '{"keybind":true}']);
});

test("score_reports_objective_and_holder", () => {
  const src = '{"score":{"name":"#kills","objective":"stat"}}';
  const p = parseWith(component, src, 100);
  assertOk(p);
  const name = at(src, "#kills", 100);
  const objective = at(src, "stat", 100);
  assert.deepEqual(refs(p), [
    ["score_holder", "#kills", name[0], name[1]],
    ["objective", "stat", objective[0], objective[1]],
  ]);

  assert.deepEqual(kinds(parseComponent('{"score":{"name":"*","objective":"o"}}')), ["objective"]);

  // the selector's offsets start at its string content
  const selectorSrc = '{"score":{"name":"@a[tag=x]","objective":"o"}}';
  const selectorParsed = parseWith(component, selectorSrc, 7);
  assertOk(selectorParsed);
  const tag = at(selectorSrc, "x", 7);
  const quoted = at(selectorSrc, '"o"', 7);
  assert.deepEqual(refs(selectorParsed), [
    ["tag", "x", tag[0], tag[1]],
    ["objective", "o", quoted[0] + 1, quoted[1] - 1],
  ]);

  rejects([
    '{"score":{"name":"x"}}',
    '{"score":{"objective":"o"}}',
    '{"score":"x"}',
    '{"score":{"name":1,"objective":"o"}}',
    '{"score":{"name":"x","objective":true}}',
  ]);
});

test("selector_reports_references_inside_the_pattern", () => {
  const p = parseComponent('{"selector":"@e[tag=boss]","separator":{"text":", "}}');
  assertOk(p);
  assert.deepEqual(
    refs(p).map((r) => [r[0], r[1]]),
    [["tag", "boss"]],
  );

  // a pattern that does not parse, or a player name, adds nothing and is not an error
  for (const src of ['{"selector":"@e[tag="}', '{"selector":"Steve"}', '{"selector":"@q"}']) {
    const q = parseComponent(src);
    assertOk(q);
    assert.deepEqual(refs(q), [], src);
  }
  rejects([
    '{"selector":true}',
    '{"selector":"@a","separator":true}',
    '{"selector":"@a","separator":[]}',
    '{"selector":"@a","separator":{"bogus":1}}',
  ]);
});

test("nbt_reports_storage_and_selector", () => {
  const src = '{"nbt":"a.b","storage":"example:data"}';
  const p = parseWith(component, src, 10);
  assertOk(p);
  const id = at(src, "example:data", 10);
  assert.deepEqual(refs(p), [["storage", "example:data", id[0], id[1]]]);

  assert.equal(refs(parseComponent('{"nbt":"a","storage":"data"}'))[0]![1], "minecraft:data");

  const entityParsed = parseComponent('{"nbt":"a","entity":"@s[tag=x]"}');
  assertOk(entityParsed);
  assert.deepEqual(kinds(entityParsed), ["tag"]);

  accepts([
    '{"nbt":"a","block":"~ ~ ~"}',
    '{"nbt":"a","storage":"x:y/z.w-v_u","interpret":true,"separator":{"text":","}}',
    '{"nbt":"a","source":"storage","storage":"x:y"}',
    '{"nbt":"a","source":"entity","entity":"@s"}',
    '{"nbt":"a","source":"block","block":"~ ~ ~"}',
    '{"nbt":"a","entity":true,"storage":"x:y"}',
    '{"nbt":"a","storage":"x:y","interpret":"yes","separator":[]}',
    '{"nbt":"a","storage":"x:y","separator":true}',
  ]);
  rejects([
    '{"nbt":"a"}',
    '{"nbt":true,"storage":"x:y"}',
    '{"nbt":"a","storage":"X"}',
    '{"nbt":"a","storage":"x:Y"}',
    '{"nbt":"a","storage":"x:y:z"}',
    '{"nbt":"a","storage":1}',
    '{"nbt":"a","entity":1}',
    '{"nbt":"a","source":"foo","storage":"x:y"}',
    '{"nbt":"a","source":"storage","entity":"@s"}',
    '{"nbt":"a","source":1,"storage":"x:y"}',
  ]);
});

test("a_failed_alternative_leaves_no_references", () => {
  // `translatable` fails on its second argument after the first reported a storage
  const p = parseComponent('{"translate":"a","with":[{"nbt":"a","storage":"x:y"},[]],"keybind":"k"}');
  assertOk(p);
  assert.deepEqual(refs(p), []);

  // an invalid nbt separator is dropped together with what it referenced
  const src = '{"nbt":"a","storage":"x:y","separator":{"score":{"name":"n","objective":"o"},"bold":"x"}}';
  const q = parseComponent(src);
  assertOk(q);
  assert.deepEqual(kinds(q), ["storage"]);
});

test("style_fields", () => {
  accepts([
    '{"text":"a","color":"red"}',
    '{"text":"a","color":"white"}',
    '{"text":"a","color":"dark_red"}',
    '{"text":"a","color":"light_purple"}',
    '{"text":"a","color":"#ff0000"}',
    '{"text":"a","color":"#FF00"}',
    '{"text":"a","color":"#ffffff"}',
    '{"text":"a","color":"#+ff"}',
    '{"text":"a","color":"#0000000000000ff"}',
    '{"text":"a","bold":true,"italic":false,"underlined":1,"strikethrough":0.5,"obfuscated":true}',
    '{"text":"a","insertion":"x","font":"minecraft:uniform"}',
    '{"text":"a","font":"x:y/z"}',
  ]);
  rejects([
    '{"text":"a","color":"bogus"}',
    '{"text":"a","color":"RED"}',
    '{"text":"a","color":"grey"}',
    '{"text":"a","color":"reset"}',
    '{"text":"a","color":"#1000000"}',
    '{"text":"a","color":"#-1"}',
    '{"text":"a","color":"#"}',
    '{"text":"a","color":"#xyz"}',
    '{"text":"a","color":1}',
    '{"text":"a","color":true}',
    '{"text":"a","bold":"true"}',
    '{"text":"a","bold":[]}',
    '{"text":"a","italic":"x"}',
    '{"text":"a","insertion":true}',
    '{"text":"a","insertion":1}',
    '{"text":"a","font":"Foo"}',
    '{"text":"a","font":1}',
  ]);
});

test("click_events", () => {
  accepts([
    '{"text":"a","clickEvent":{"action":"run_command","value":"/say hi"}}',
    '{"text":"a","clickEvent":{"action":"suggest_command","value":"x"}}',
    '{"text":"a","clickEvent":{"action":"open_url","value":"http://x"}}',
    '{"text":"a","clickEvent":{"action":"change_page","value":"1"}}',
    '{"text":"a","clickEvent":{"action":"copy_to_clipboard","value":"x"}}',
  ]);
  rejects([
    '{"text":"a","clickEvent":{"action":"open_file","value":"x"}}',
    '{"text":"a","clickEvent":{"action":"foo","value":"x"}}',
    '{"text":"a","clickEvent":{"action":1,"value":"x"}}',
    '{"text":"a","clickEvent":{"action":"run_command"}}',
    '{"text":"a","clickEvent":{"action":"run_command","value":1}}',
    '{"text":"a","clickEvent":{"action":"run_command","value":true}}',
    '{"text":"a","clickEvent":{"value":"x"}}',
    '{"text":"a","clickEvent":"x"}',
    '{"text":"a","clickEvent":[]}',
  ]);
});

test("hover_events", () => {
  accepts([
    '{"text":"a","hoverEvent":{"action":"show_text","contents":"x"}}',
    '{"text":"a","hoverEvent":{"action":"show_text","contents":{"text":"x","hoverEvent":{"action":"show_text","contents":"y"}}}}',
    '{"text":"a","hoverEvent":{"action":"show_text","contents":["x",{"text":"y"}]}}',
    '{"text":"a","hoverEvent":{"action":"show_text","value":{"text":"x"}}}',
    '{"text":"a","hoverEvent":{"action":"show_item","contents":"minecraft:stone"}}',
    '{"text":"a","hoverEvent":{"action":"show_item","contents":{"id":"minecraft:stone","count":2,"tag":"{a:1}"}}}',
    '{"text":"a","hoverEvent":{"action":"show_item","contents":{"id":"minecraft:stone","count":true}}}',
    '{"text":"a","hoverEvent":{"action":"show_item","contents":{"id":"minecraft:nonexistent"}}}',
    '{"text":"a","hoverEvent":{"action":"show_item","value":"{id:\\"minecraft:stone\\",Count:1b}"}}',
    '{"text":"a","hoverEvent":{"action":"show_entity","contents":{"type":"minecraft:pig","id":"00000000-0000-0000-0000-000000000000","name":{"text":"x"}}}}',
    '{"text":"a","hoverEvent":{"action":"show_entity","contents":{"type":"minecraft:nonexistent","id":[0,0,0,0]}}}',
    '{"text":"a","hoverEvent":{"action":"show_entity","contents":{"type":"minecraft:pig","id":"0-0-0-0-0"}}}',
    '{"text":"a","hoverEvent":{"action":"show_entity","contents":"x","value":"y"}}',
  ]);
  rejects([
    '{"text":"a","hoverEvent":"x"}',
    '{"text":"a","hoverEvent":[]}',
    '{"text":"a","hoverEvent":{"contents":"x"}}',
    '{"text":"a","hoverEvent":{"action":"foo","contents":"x"}}',
    '{"text":"a","hoverEvent":{"action":1,"contents":"x"}}',
    '{"text":"a","hoverEvent":{"action":null,"contents":"x"}}',
    '{"text":"a","hoverEvent":{"action":"show_text"}}',
    '{"text":"a","hoverEvent":{"action":"show_text","contents":[]}}',
    '{"text":"a","hoverEvent":{"action":"show_text","contents":true}}',
    '{"text":"a","hoverEvent":{"action":"show_text","contents":1}}',
    '{"text":"a","hoverEvent":{"action":"show_text","contents":{"bogus":1}}}',
    '{"text":"a","hoverEvent":{"action":"show_text","contents":[],"value":[]}}',
    '{"text":"a","hoverEvent":{"action":"show_item","contents":{"count":2}}}',
    '{"text":"a","hoverEvent":{"action":"show_item","contents":{"id":"Foo"}}}',
    '{"text":"a","hoverEvent":{"action":"show_item","contents":{"id":"minecraft:stone","count":"2"}}}',
    '{"text":"a","hoverEvent":{"action":"show_item","contents":{"id":"minecraft:stone","tag":{"a":1}}}}',
    '{"text":"a","hoverEvent":{"action":"show_item","contents":1}}',
    '{"text":"a","hoverEvent":{"action":"show_entity","contents":{"type":"minecraft:pig"}}}',
    '{"text":"a","hoverEvent":{"action":"show_entity","contents":{"id":"0-0-0-0-0"}}}',
    '{"text":"a","hoverEvent":{"action":"show_entity","contents":{"type":"Pig","id":"0-0-0-0-0"}}}',
    '{"text":"a","hoverEvent":{"action":"show_entity","contents":{"type":"minecraft:pig","id":"bad"}}}',
    '{"text":"a","hoverEvent":{"action":"show_entity","contents":{"type":"minecraft:pig","id":[0,0,0]}}}',
    '{"text":"a","hoverEvent":{"action":"show_entity","contents":{"type":"minecraft:pig","id":[0,0,0,"a"]}}}',
    '{"text":"a","hoverEvent":{"action":"show_entity","contents":{"type":"minecraft:pig","id":"0-0-0-0-0","name":[]}}}',
  ]);
});

test("hover_references_come_only_from_the_form_that_decodes", () => {
  let src = '{"text":"a","hoverEvent":{"action":"show_text","contents":{"nbt":"a","storage":"x:y"}}}';
  assert.deepEqual(kinds(parseComponent(src)), ["storage"]);

  // `contents` fails after reporting a storage; the legacy `value` is what decodes
  src = '{"text":"a","hoverEvent":{"action":"show_text","contents":{"nbt":"a","storage":"x:y","bold":"x"},"value":"v"}}';
  const p = parseComponent(src);
  assertOk(p);
  assert.deepEqual(refs(p), []);
});

test("java_uuid_parsing", () => {
  // Results of `UUID.fromString` on the same strings.
  const cases: [string, boolean][] = [
    ["00000000-0000-0000-0000-000000000000", true],
    ["0-0-0-0-0", true],
    ["1-2-3-4-5", true],
    ["+1-+2-3-4-5", true],
    ["-1-2-3-4-5", false],
    ["1-2-3-4", false],
    ["1-2-3-4-5-6", false],
    ["123456789-0-0-0-0", true],
    ["ffffffffffffffff-0-0-0-0", false],
    ["7fffffffffffffff-0-0-0-0", true],
    ["8000000000000000-0-0-0-0", false],
    ["00000000-0000-0000-0000-0000000000000", false],
    ["00000000-0000-0000-0000-000000000000x", false],
    ["x-x-x-x-x", false],
    ["--0-0-0-0", false],
    ["0--0-0-0", false],
    ["0-0-0-0-", false],
    ["-0-0-0-0", false],
    ["@s", false],
    ["abc", false],
  ];
  for (const [s, ok] of cases) {
    assert.equal(isJavaUuid(s), ok, s);
  }
});

test("invalid_values_are_marked_where_they_are", () => {
  const src = '{"text":"a","color":"bogus"}';
  let e = errorOf(parseWith(component, src, 50));
  const bogus = at(src, '"bogus"', 50);
  assert.deepEqual([e.start, e.end], bogus);
  assert.equal(e.message, "Invalid chat component: Invalid color: bogus");

  // an object is marked at its `{`, not over its whole text
  e = errorOf(parseComponent('["a",{"bogus":1}]'));
  assert.deepEqual([e.start, e.end], [5, 6]);
  assert.ok(e.message.includes("No matching codec found"), e.message);

  // with several alternatives, the error comes from the one whose key is present
  e = errorOf(parseComponent('{"translate":"a","with":"x"}'));
  assert.ok(e.message.includes("Not a JSON array"), e.message);
});

test("style_argument", () => {
  for (const src of [
    "{}",
    '{"bold":true}',
    '{"insertion":"x","color":"#123456"}',
    '{"color":"red","bold":true,"hoverEvent":{"action":"show_text","contents":"a"}}',
    '{"clickEvent":{"action":"run_command","value":"/x"}}',
    '{"font":"minecraft:x"}',
    '{"text":"ignored"}',
  ]) {
    const p = parseWith(style, src, 0);
    if (p.result instanceof ParseError) assert.fail(`${src}: ${p.result.message}`);
    assert.equal(p.end, src.length);
  }
  for (const src of [
    "",
    "[]",
    '"x"',
    "true",
    "1",
    "null",
    '{"color":"bogus"}',
    '{"bold":"true"}',
    "{bold:true}",
    "{'bold':true}",
  ]) {
    assert.ok(parseWith(style, src, 0).result instanceof ParseError, src);
  }
  assert.equal(parseWith(style, '{"bold":true} x', 0).end, 13);
});
