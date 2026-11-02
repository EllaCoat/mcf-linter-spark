import assert from "node:assert/strict";
import { test } from "node:test";

import { DocComment, entryMatches, escapePattern, namedVisibility, type Visibility } from "../../src/core/impdoc.ts";

function vis(kind: string, pattern: string): Visibility {
  return { kind, pattern: escapePattern(pattern) };
}

test("glob_matches_like_dhp", () => {
  assert.ok(entryMatches(vis("*", "example:item/**"), "function", "example:item/sword/use/x"));
  assert.ok(entryMatches(vis("function", "example:a/*"), "function", "example:a/b"));
  assert.ok(!entryMatches(vis("function", "example:a/*"), "function", "example:a/b/c"));
  assert.ok(!entryMatches(vis("function", "example:a/*"), "tag/function", "example:a/b"));
  assert.ok(!entryMatches(vis("*", "a:**/b"), "function", "a:b"));
  assert.ok(entryMatches(vis("*", "a:**/b"), "function", "a:x/b"));
  // `*` alone matches only ids whose shortest form has no ':' or '/'.
  assert.ok(entryMatches(vis("*", "*"), "function", "minecraft:load"));
  assert.ok(!entryMatches(vis("*", "*"), "function", "example:load"));
  assert.ok(entryMatches(vis("*", "example:x/y.m"), "function", "example:x/y.m"));
  assert.ok(!entryMatches(vis("*", "example:x/y.m"), "function", "example:x/yXm"));
});

test("private_and_internal", () => {
  const p = namedVisibility("private", "function", "a:b/c");
  assert.ok(p.some((v) => entryMatches(v, "function", "a:b/c")));
  assert.ok(!p.some((v) => entryMatches(v, "function", "a:b/d")));
  const i = namedVisibility("internal", "function", "a:b");
  assert.ok(i.some((v) => entryMatches(v, "function", "a:zz/y")));
  assert.ok(i.some((v) => entryMatches(v, "function", "minecraft:zz")));
  assert.ok(!i.some((v) => entryMatches(v, "function", "b:zz")));
});

// This test has no Rust counterpart: `trim_end` strips Unicode White_Space, which JS's `trimEnd` does not match.
test("display_trims_unicode_white_space", () => {
  assert.equal(new DocComment("text\u0085\u00a0\u2028 \n").display(), "text");
  assert.equal(new DocComment("text\ufeff").display(), "text\ufeff");
});
