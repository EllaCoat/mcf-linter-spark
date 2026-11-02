import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { Config } from "../../src/core/config.ts";
import { type JsonValue, asStr, at, get, stringifySorted } from "../../src/core/json-value.ts";
import { Project } from "../../src/core/project.ts";
import { absolute, dlsCache, fileUri } from "../../src/core/symbols.ts";

/** The member or element at each step of `path`. */
function dig(v: JsonValue | undefined, ...path: (string | number)[]): JsonValue | undefined {
  for (const step of path) v = typeof step === "number" ? at(v, step) : get(v, step);
  return v;
}

async function cacheOf(name: string, files: readonly (readonly [string, string])[]): Promise<JsonValue | undefined> {
  const root = join(tmpdir(), "ai-agent", "mcf-linter-spark-ts-tests", name);
  rmSync(root, { recursive: true, force: true });
  for (const [rel, text] of [...files, ["pack.mcmeta", "{}"]] as const) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  const p = await Project.load(root, new Config(), { ignore: [], maxDepth: 0 });
  return get(dlsCache(p), "cache");
}

test("declarations_and_definitions_keep_their_positions_and_visibility", async () => {
  const c = await cacheOf("symbols", [
    ["data/t/functions/api.mcfunction", "#> t:api\n# @public\n"],
    ["data/t/functions/plain.mcfunction", "say hi\n"],
    [
      "data/t/functions/load.mcfunction",
      "#> t:load\n# @private\n\n#> objectives\n# @within function t:a/**\n    scoreboard objectives add Count dummy\n\n#> aliases\n# @within t:api\n    #alias vector origin 0 0 0\n#declare storage t:data\n",
    ],
    ["data/t/tags/functions/load.json", '{"values": ["t:load"]}'],
  ]);
  const api = dig(c, "function", "t:api", "def", 0);
  assert.deepEqual(get(api, "visibility"), [{ type: "*", pattern: "**" }]);
  assert.deepEqual([get(api, "startLine"), get(api, "startChar"), get(api, "endChar")], [0, 3, 8]);
  assert.ok(asStr(get(api, "uri"))!.startsWith("file:///"));
  assert.ok(asStr(get(api, "uri"))!.endsWith("/data/t/functions/api.mcfunction"));
  assert.equal(get(dig(c, "function", "t:plain", "def", 0), "visibility"), undefined);
  assert.deepEqual(dig(c, "function", "t:load", "def", 0, "visibility"), [{ type: "function", pattern: "t:load" }]);
  const count = dig(c, "objective", "Count", "def", 0);
  assert.deepEqual([get(count, "startLine"), get(count, "visibility")], [5, [{ type: "function", pattern: "t:a\\/**" }]]);
  const origin = dig(c, "alias/vector", "origin");
  assert.equal(get(origin, "foo"), "0 0 0");
  assert.deepEqual([dig(origin, "def", 0, "startLine"), dig(origin, "def", 0, "visibility")], [9, [{ type: "*", pattern: "t:api" }]]);
  const data = dig(c, "storage", "t:data");
  assert.ok(get(data, "def") === undefined && get(dig(data, "dcl", 0), "visibility") === undefined);
  assert.equal(dig(c, "tag/function", "t:load", "def", 0, "start"), 0);
});

test("uris_are_written_as_vscode_writes_them", () => {
  assert.equal(fileUri("/home/runner/work/a b"), "file:///home/runner/work/a%20b");
  assert.equal(fileUri("C:\\Users\\x\\pack"), "file:///c%3A/Users/x/pack");
});

test("a_root_given_with_dot_dot_gives_the_folded_path", () => {
  assert.ok(fileUri(absolute("/a/b/../c/./d")).endsWith("/a/c/d"));
});

// Not in the Rust tests: the keys of the cache are written in serde_json's order, which an integer-like
// id would break in a plain object, and the file URI percent-encodes UTF-8 bytes.
test("the_cache_is_written_in_serde_json_order", async () => {
  const c = await cacheOf("symbols-order", [
    ["data/t/functions/a.mcfunction", "#declare tag 10\n#declare tag 2\n#declare tag __proto__\n"],
    ["data/t/functions/日本.mcfunction", "#> t:日本\n# @public\n"],
  ]);
  const text = stringifySorted(c!);
  assert.ok(text.indexOf('"10":') < text.indexOf('"2":') && text.indexOf('"2":') < text.indexOf('"__proto__":'), text);
  const jp = dig(c, "function", "t:日本", "def", 0);
  assert.ok(asStr(get(jp, "uri"))!.endsWith("/data/t/functions/%E6%97%A5%E6%9C%AC.mcfunction"));
  assert.equal(JSON.stringify(get(jp, "visibility")), '[{"pattern":"**","type":"*"}]');
  assert.deepEqual(Object.keys(jp as object), ["end", "endChar", "endLine", "start", "startChar", "startLine", "uri", "visibility"]);
});
