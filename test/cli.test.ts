import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { lineStartPath } from "../src/cli.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function writePack(root: string, files: [string, string][]): void {
  rmSync(root, { recursive: true, force: true });
  for (const [rel, text] of files) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
}

function check(...args: string[]) {
  return spawnSync(process.execPath, [CLI, "check", ...args], { encoding: "utf8" });
}

function testRoot(name: string): string {
  return join(tmpdir(), "ai-agent", "mcf-linter-spark-tests", name);
}

function lineCount(s: string): number {
  return s.split("\n").filter((l, i, all) => i < all.length - 1 || l !== "").length;
}

test("a_path_that_reads_as_a_workflow_command_does_not_start_a_line", () => {
  assert.equal(lineStartPath(" ::warning title=x::y/data/t/function/f.mcfunction"), "./ ::warning title=x::y/data/t/function/f.mcfunction");
  assert.equal(lineStartPath("pack/data/t/function/f.mcfunction"), "pack/data/t/function/f.mcfunction");
});

test("the_deepest_nesting_the_parsers_allow_is_checked_without_overflowing_the_stack", () => {
  const root = testRoot("cli-deepest-nesting");
  const chain = `execute ${"as @s ".repeat(4090)}run `;
  const passengers = `${"{Passengers:[".repeat(255)}{}${"]}".repeat(255)}`;
  let text = '"a"';
  for (let i = 0; i < 255; i++) text = `{text:"a",extra:[${text}]}`;
  const fn = `${chain}summon minecraft:pig ~ ~ ~ ${passengers}\n${chain}tellraw @a ${text}\n`;
  writePack(root, [
    ["pack.mcmeta", '{"pack": {"pack_format": 48, "description": ""}}'],
    [".vscode/settings.json", '{"datapack.env.cmdVersion": "26.3"}'],
    ["data/t/function/f.mcfunction", fn],
  ]);
  const output = check(root);
  assert.ok(output.status === 0 || output.status === 1, `${output.status}: ${output.stderr}`);
});

test("control_characters_from_the_files_do_not_start_lines_of_the_output", () => {
  const root = testRoot("cli-control-characters");
  const advancement = '{"criteria": {"a": {"trigger": "minecraft:tick"}}, "rewards": {"function": "t:a\\n::error file=x::injected\\u001b[2J"}}';
  writePack(root, [
    ["pack.mcmeta", '{"pack": {"pack_format": 48, "description": ""}}'],
    ["data/t/advancement/x.json", advancement],
    ["settings.json", '{"datapack.env.cmdVersion": "1.21"}'],
  ]);
  for (const format of ["text", "github"]) {
    const { stdout } = check(root, "--config", join(root, "settings.json"), "--format", format);
    assert.equal(lineCount(stdout), 1, `${format}: ${stdout}`);
    assert.ok(stdout.includes("injected"), `${format}: ${stdout}`);
    assert.ok(!stdout.includes("\u001b"), `${format}: ${stdout}`);
  }
});

test("a_file_name_that_reads_as_a_workflow_command_is_written_escaped", () => {
  const root = testRoot("cli-workflow-command");
  writePack(root, [
    ["pack.mcmeta", '{"pack": {"pack_format": 48, "description": ""}}'],
    ["data/t/function/##[error]x.mcfunction", "function t:missing\n"],
    ["settings.json", '{"datapack.env.cmdVersion": "1.21"}'],
  ]);
  for (const format of ["text", "github"]) {
    const { stdout } = check(root, "--config", join(root, "settings.json"), "--format", format);
    assert.equal(lineCount(stdout), 1, `${format}: ${stdout}`);
    assert.ok(!stdout.includes("##["), `${format}: ${stdout}`);
  }
});
