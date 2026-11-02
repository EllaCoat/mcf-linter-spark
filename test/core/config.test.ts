import assert from "node:assert/strict";
import { test } from "node:test";

import { Config, stripJsonc } from "../../src/core/config.ts";

test("reads_flat_and_nested_rules", () => {
  const c = Config.fromSettings(`{
                // comment
                "datapack.lint.strictFunctionCheck": ["error", true],
                "datapack": { "lint": { "nbtBoolean": ["warning", false] } },
                "datapack.env.cmdVersion": "1.20.3",
            }`);
  assert.equal(c.cmdVersion, "1.20.3");
  assert.equal(c.rule("strictFunctionCheck")?.[0], "Error");
  assert.equal(c.rule("nbtBoolean"), undefined);
});

test("drops_a_trailing_comma_before_a_comment", () => {
  assert.equal(JSON.parse(stripJsonc('{"a": 1,\n  // "b": 2\n}')).a, 1);
  assert.deepEqual(JSON.parse(stripJsonc("[1, /* 2 */ ]")), [1]);
});

test("imp_doc_rules_need_a_spyglass_json", () => {
  const c = Config.fromSettings('{"datapack.lint.impDocBareDeclaration": "warning"}');
  assert.equal(c.spyglassRule("impDocBareDeclaration"), undefined);
  c.mergeSpyglass('{"lint": {"impDocVisibilityConflict": "warning"}}');
  assert.equal(c.spyglassRule("impDocVisibilityConflict"), "Warning");
});

test("the_game_version_of_a_spyglass_json_yields_to_cmd_version", () => {
  let c = Config.fromSettings("{}");
  c.mergeSpyglass('{"env": {"gameVersion": "1.21.5"}}');
  assert.equal(c.cmdVersion, "1.21.5");
  c = Config.fromSettings('{"datapack.env.cmdVersion": "1.20.4"}');
  c.mergeSpyglass('{"env": {"gameVersion": "26.3"}}');
  assert.equal(c.cmdVersion, "1.20.4");
  c = Config.fromSettings("{}");
  c.mergeSpyglass('{"env": {"gameVersion": "Auto"}}');
  assert.equal(c.cmdVersion, "1.20.4");
});

test("keeps_non_ascii_text", () => {
  const v = JSON.parse(stripJsonc('{"a": "日本語", /* x */ "b": 1,}'));
  assert.equal(v.a, "日本語");
});
