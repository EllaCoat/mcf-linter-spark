import assert from "node:assert/strict";
import { test } from "node:test";

import { ParseError } from "../../src/core/diag.ts";
import { Reader } from "../../src/core/reader.ts";

test("reads_quoted_strings_with_escapes", () => {
  const r = new Reader('"a\\"b\\\\c" rest', 0);
  assert.equal(r.readQuoted(), 'a"b\\c');
  assert.equal(r.rest(), " rest");
});

test("rejects_invalid_escape", () => {
  const r = new Reader('"a\\n"', 0);
  assert.ok(r.readQuoted() instanceof ParseError);
});

test("reads_numbers_like_brigadier", () => {
  assert.equal(new Reader("-12 ", 0).readInt(), -12);
  assert.ok(new Reader("1.5", 0).readInt() instanceof ParseError);
  assert.equal(new Reader(".5", 0).readDouble(), 0.5);
  assert.ok(new Reader("abc", 0).readDouble() instanceof ParseError);
});
