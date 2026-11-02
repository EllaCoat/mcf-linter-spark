import assert from "node:assert/strict";
import { test } from "node:test";

import type { JsonValue } from "../../src/core/json-value.ts";
import { McDoc, idAttr, isResourceLocation, range, rangeContains, rangeDescribe } from "../../src/core/mcdoc.ts";

function litStr(s: string): JsonValue {
  return { kind: "literal", value: { kind: "string", value: s } };
}

test("version_attributes_leave_out_fields_members_and_entries", () => {
  const root: JsonValue = {
    mcdoc: {
      "::a::S": {
        kind: "struct",
        fields: [
          { kind: "pair", key: "old", type: { kind: "int" }, attributes: [{ name: "until", value: litStr("1.20.3") }] },
          { kind: "pair", key: "now", type: { kind: "int" }, attributes: [{ name: "since", value: litStr("1.20.4") }] },
          { kind: "pair", key: "new", type: { kind: "int" }, attributes: [{ name: "since", value: litStr("1.20.5") }] },
          { kind: "pair", key: "next", type: { kind: "int" }, attributes: [{ name: "since", value: litStr("26.3") }] },
        ],
      },
    },
    "mcdoc/dispatcher": {
      "minecraft:resource": {
        kept: { kind: "reference", path: "::a::S" },
        later: { kind: "reference", path: "::a::S", attributes: [{ name: "since", value: litStr("1.21") }] },
      },
    },
  };
  const doc = McDoc.fromJson(root, "1.20.4");
  const s = doc.types.get("::a::S");
  assert.ok(s?.kind === "Struct");
  const names = s.fields.flatMap((f) => (f.kind === "Pair" && f.key.kind === "Name" ? [f.key.name] : []));
  assert.deepEqual(names, ["now"]);
  assert.ok(doc.dispatchers.get("minecraft:resource")!.has("kept"));
  assert.ok(!doc.dispatchers.get("minecraft:resource")!.has("later"));
});

test("id_attributes_read_both_forms", () => {
  const plain = idAttr(litStr("item"));
  assert.equal(plain.registry, "item");
  const tree = idAttr({
    kind: "tree",
    values: {
      registry: litStr("block"),
      tags: litStr("allowed"),
      definition: { kind: "literal", value: { kind: "boolean", value: true } },
    },
  });
  assert.deepEqual([tree.registry, tree.tags, tree.definition], ["block", "Allowed", true]);
});

test("resource_locations_may_have_an_empty_path_after_a_namespace", () => {
  assert.ok(isResourceLocation("lib:") && isResourceLocation("a:b/c") && isResourceLocation("stone"));
  assert.ok(!isResourceLocation("") && !isResourceLocation("Stone") && !isResourceLocation("a:b:c"));
});

test("ranges_follow_the_exclusive_bits", () => {
  const r = range({ kind: 2, min: 0, max: 1 })!;
  assert.ok(!rangeContains(r, 0) && rangeContains(r, 0.5) && rangeContains(r, 1));
  assert.equal(rangeDescribe(r), "0<..1");
});
