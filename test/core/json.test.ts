import assert from "node:assert/strict";
import { test } from "node:test";

import { ParseError } from "../../src/core/diag.ts";
import { parseDocument, parsePartial, type Node } from "../../src/core/json.ts";

/** `name key-span value-span` of each member. */
function keys(node: Node): string[] {
  if (node.json.kind !== "Object") throw new Error("an object");
  return node.json.fields.map(([k, v]) => {
    if (v.key === undefined) throw new Error("a key");
    return `${k} (${v.key[0]}, ${v.key[1]}) (${v.start}, ${v.end})`;
  });
}

test("partial_text_keeps_the_keys_and_values_typed_so_far", () => {
  let text = '{"condition": "random_chance", "cha';
  assert.deepEqual(keys(parsePartial(text)), ["condition (1, 12) (14, 29)", "cha (31, 35) (35, 35)"]);
  text = '{"a": , "b": tr';
  assert.deepEqual(keys(parsePartial(text)), ["a (1, 4) (6, 6)", "b (8, 11) (13, 15)"]);
  const root = parsePartial('{"values": ["stone", "#mine').json;
  if (root.kind !== "Object") throw new Error("an object");
  const list = root.fields[0]![1].json;
  if (list.kind !== "Array") throw new Error("an array");
  assert.deepEqual(list.items[1]!.json, { kind: "Str", value: "#mine" });
});

// Offsets around characters outside ASCII, which take more than one UTF-8 byte.

test("utf16_offsets_of_keys_and_values", () => {
  const node = parseDocument('{"\u00e9\u{1f600}": "x"}', "Strict");
  if (node instanceof ParseError || node.json.kind !== "Object") throw new Error("an object");
  const member = node.json.fields[0]![1];
  assert.deepEqual([member.key, member.start, member.end], [[1, 6], 8, 11]);
});

test("short_unicode_escape_with_wide_characters", () => {
  // Fewer than 4 units after the backslash-u that take 4 or more UTF-8 bytes are an invalid escape, not an unterminated one.
  for (const [text, message] of [
    ['"\\u\u00e9\u00e9', "Invalid unicode escape"],
    ['"\\u1\u00e9', "Unterminated escape sequence"],
    ['"\\u12', "Unterminated escape sequence"],
  ] as const) {
    const e = parseDocument(text, "Strict");
    assert.ok(e instanceof ParseError);
    assert.equal(e.message, message);
    assert.equal(e.start, 3);
  }
});

test("lone_surrogate_escape_becomes_replacement_character", () => {
  const value = (text: string) => {
    const node = parseDocument(text, "Strict");
    if (node instanceof ParseError || node.json.kind !== "Str") throw new Error("a string");
    return node.json.value;
  };
  assert.equal(value('"\\ud83d\\ude00"'), "\u{1f600}");
  assert.equal(value('"\\ud83d"'), "\ufffd");
  assert.equal(value('"\\ude00"'), "\ufffd");
  assert.equal(value('"\\ud83d\\u0041"'), "\ufffdA");
});
