import assert from "node:assert/strict";
import { test } from "node:test";

import { followsConvention, selectorKeysSorted, stringQuoteProblems } from "../../src/core/lint.ts";

test("chained_pascal_case", () => {
  const c = { label: "ChainedPascalCase", allowLessParts: true, allowMoreParts: true, sep: ".", parts: "/^([A-Z\\d]+[a-z\\d]*)+$/" };
  assert.ok(followsConvention("Foo.BarBaz", c));
  assert.ok(!followsConvention("foo.Bar", c));
  const dollar = { label: "DollerPrefix", prefix: "$" };
  assert.ok(followsConvention("$x", dollar));
  assert.ok(!followsConvention("x", dollar));
  assert.ok(followsConvention("abc", "lowercase"));
});

test("selector_order", () => {
  const order = ["type", "tag", "tagNeg", "limit"];
  assert.ok(selectorKeysSorted(["type", "tag", "tag", "limit"], order));
  assert.ok(!selectorKeysSorted(["tag", "type"], order));
  assert.ok(selectorKeysSorted(["type", "x", "limit"], order));
});

test("quotes", () => {
  assert.equal(stringQuoteProblems(undefined, "a", ["stringQuote", true], undefined).length, 1);
  assert.equal(stringQuoteProblems('"', "a", ["stringQuote", true], ["stringQuoteType", "prefer double"]).length, 0);
  assert.equal(stringQuoteProblems("'", "a", undefined, ["stringQuoteType", "prefer double"]).length, 1);
  assert.equal(stringQuoteProblems("'", 'a"b', undefined, ["stringQuoteType", "prefer double"]).length, 0);
});
