import assert from "node:assert/strict";
import { test } from "node:test";

import { RELEASES, cmp, parse, releaseIndex } from "../../src/core/version.ts";

test("releases_are_in_order", () => {
  for (let i = 1; i < RELEASES.length; i++) assert.ok(cmp(parse(RELEASES[i - 1]![0]), parse(RELEASES[i]![0])) < 0);
});

test("versions_compare_by_parts", () => {
  assert.equal(cmp(parse("1.21"), parse("1.21.0")), 0);
  assert.ok(cmp(parse("1.21.11"), parse("1.21.9")) > 0);
  assert.ok(cmp(parse("26.1"), parse("1.21.11")) > 0);
});

test("finds_the_data_of_a_version", () => {
  assert.equal(releaseIndex("1.20.3"), 0);
  assert.equal(releaseIndex("26.3"), 19);
  assert.equal(releaseIndex("1.20.2"), undefined);
  assert.equal(releaseIndex("26.4-snapshot-6"), undefined);
});
