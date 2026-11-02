import assert from "node:assert/strict";
import { test } from "node:test";

import { blockPos, rotation, vec2, vec3 } from "../../../src/core/args/coords.ts";
import { ParseError } from "../../../src/core/diag.ts";
import { type PResult, Reader } from "../../../src/core/reader.ts";

function ok(f: (r: Reader) => PResult<void>, s: string): boolean {
  const r = new Reader(s, 0);
  return !(f(r) instanceof ParseError) && !r.canRead();
}

test("parses_coordinates", () => {
  assert.ok(ok(blockPos, "~ ~1 ~-2"));
  assert.ok(ok(blockPos, "1 2 3"));
  assert.ok(!ok(blockPos, "1.5 2 3"));
  assert.ok(ok(blockPos, "~1.5 ~ ~"));
  assert.ok(ok(vec3, "^ ^ ^1"));
  assert.ok(!ok(vec3, "^ ~ ^"));
  assert.ok(!ok(vec3, "1 2"));
  assert.ok(ok(vec2, "~ 90"));
  assert.ok(!ok(rotation, "^ ^"));
});
