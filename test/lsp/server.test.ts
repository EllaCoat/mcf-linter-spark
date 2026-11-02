// The language server over stdio as an editor drives it: the completion follows the release
// that the project's settings name.

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { TextDocumentContentChangeEvent } from "vscode-languageserver/node";

import { RELEASES, cmp, parse } from "../../src/core/version.ts";
import { StorageIndex, applyChanges, codeSpan, markdownDoc, storagePathsWhileTyping } from "../../src/lsp/server.ts";
import { LspClient, ResponseFailure } from "./client.ts";

const CLI = fileURLToPath(new URL("../../src/main.ts", import.meta.url));

let projects = 0;

function projectRoot(name: string): string {
  return join(tmpdir(), "ai-agent", "mcf-linter-spark-tests", name);
}

function writeFiles(root: string, files: readonly (readonly [string, string])[]): void {
  rmSync(root, { recursive: true, force: true });
  for (const [rel, text] of files) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
}

function startServer(): LspClient {
  return new LspClient(process.execPath, [CLI, "lsp"]);
}

/** The labels the server completes at the end of each of `lines`, the lines of a function in a
 * project of `version` with `files` besides. */
async function labelsOfLines(version: string, functions: string, lines: readonly string[], files: readonly (readonly [string, string])[]): Promise<string[][]> {
  const root = projectRoot(`lsp-${version}-${projects++}`);
  const main = join(root, "data", "t", functions, "main.mcfunction");
  const text = lines.join("\n");
  writeFiles(root, [
    ["pack.mcmeta", "{}"],
    [join(".vscode", "settings.json"), `{"datapack.env.cmdVersion": "${version}"}`],
    [join("data", "t", functions, "main.mcfunction"), text],
    ...files,
  ]);
  const client = startServer();
  try {
    await client.start(root);
    const uri = pathToFileURL(main).href;
    client.notify("textDocument/didOpen", { textDocument: { uri, languageId: "mcfunction", version: 1, text } });
    const out: string[][] = [];
    for (let n = 0; n < lines.length; n++) {
      const result = (await client.request("textDocument/completion", { textDocument: { uri }, position: { line: n, character: lines[n]!.length } })) as
        | { items?: { label?: unknown }[] }
        | null;
      const items = result?.items ?? [];
      out.push(items.flatMap((i) => (typeof i.label === "string" ? [i.label] : [])));
    }
    return out;
  } finally {
    await client.close();
  }
}

async function labels(version: string, functions: string, line: string, files: readonly (readonly [string, string])[]): Promise<string[]> {
  return (await labelsOfLines(version, functions, [line], files))[0]!;
}

function has(found: readonly string[], label: string): boolean {
  return found.includes(label);
}

function change(range: [[number, number], [number, number]] | undefined, text: string): TextDocumentContentChangeEvent {
  if (range === undefined) return { text };
  const [[a, b], [c, d]] = range;
  return { range: { start: { line: a, character: b }, end: { line: c, character: d } }, text };
}

test("applies_incremental_changes_in_utf16_positions", () => {
  const text = "say あいう\nfunction t:lib\n";
  const edits = [change([[0, 5], [0, 6]], "X"), change([[1, 11], [1, 14]], "missing"), change([[2, 0], [2, 0]], "say end\n")];
  assert.equal(applyChanges(text, edits), "say あXう\nfunction t:missing\nsay end\n");
  assert.equal(applyChanges(text, [change(undefined, "whole")]), "whole");
});

test("an_image_in_a_doc_is_shown_as_a_link_in_the_hover", () => {
  assert.equal(
    markdownDoc("Spawns a mob ![x](https://example.com/x.png)\n[lib](file:///t.mcfunction)"),
    "Spawns a mob &#33;[x](https://example.com/x.png)  \n[lib](file:///t.mcfunction)  ",
  );
  assert.equal(markdownDoc("\\![x](https://example.com/x.png)"), "\\&#33;[x](https://example.com/x.png)  ");
});

test("a_symbol_name_with_backticks_stays_in_the_code_span_of_the_hover", () => {
  assert.equal(codeSpan("t:lib"), "`t:lib`");
  assert.equal(codeSpan("a`![x](https://example.com/x.png)"), "``a`![x](https://example.com/x.png)``");
  assert.equal(codeSpan("``a"), "``` ``a ```");
  assert.equal(codeSpan("a\n\n![x](https://example.com/x.png)"), "`a\\n\\n![x](https://example.com/x.png)`");
});

test("storage_paths_leave_out_only_the_path_being_typed", () => {
  const edited = "data get storage lib: Shared\ndata get storage lib: Arr\ndata get storage lib: Own\n";
  const index = new StorageIndex();
  index.set(0, edited);
  index.set(1, "data get storage lib: Array\ndata get storage lib: Shared\n");
  assert.deepEqual(storagePathsWhileTyping(index, 0, edited, 1, "data get storage lib: Arr", "lib:"), ["Array", "Own", "Shared"]);

  const typedInFull = "data get storage lib: Array\n";
  index.set(0, typedInFull);
  assert.deepEqual(storagePathsWhileTyping(index, 0, typedInFull, 0, typedInFull.trimEnd(), "lib:"), ["Array", "Shared"]);

  const sameLine = "execute if data storage lib: Foo run data remove storage lib: Fo";
  index.set(0, sameLine);
  assert.deepEqual(storagePathsWhileTyping(index, 0, sameLine, 0, sameLine, "lib:"), ["Array", "Foo", "Shared"]);
});

test("completion_works_in_every_release", { timeout: 1_800_000 }, async () => {
  const since = (version: string, first: string): boolean => cmp(parse(version), parse(first)) >= 0;
  for (const [version] of RELEASES) {
    const functions = since(version, "1.21") ? "function" : "functions";
    const item = since(version, "1.20.5") ? (["give @s diamond_sword[dam", "damage"] as const) : (["give @s diamond_sword{Dam", "Damage:"] as const);
    const lines = ["gamem", "kill @", item[0], "function t:"];
    const got = await labelsOfLines(version, functions, lines, []);
    assert.ok(has(got[0]!, "gamemode"), `${version}: ${JSON.stringify(got[0])}`);
    assert.ok(has(got[1]!, "@s"), `${version}: ${JSON.stringify(got[1])}`);
    assert.equal(has(got[1]!, "@n"), since(version, "1.21"), `${version}: ${JSON.stringify(got[1])}`);
    assert.ok(has(got[2]!, item[1]), `${version}: ${JSON.stringify(got[2])}`);
    assert.ok(has(got[3]!, "t:main"), `${version}: ${JSON.stringify(got[3])}`);
  }
});

test("completion_follows_the_release_of_the_project", { timeout: 600_000 }, async () => {
  const old = await labels("1.20.4", "functions", "give @s diamond_sword{Dam", []);
  assert.ok(has(old, "Damage:"), JSON.stringify(old));
  const enchantments = await labels("1.21", "function", "enchant @s t:", [[join("data", "t", "enchantment", "sharp.json"), "{}"]]);
  assert.ok(has(enchantments, "t:sharp"), JSON.stringify(enchantments));

  const components = await labels("1.21.5", "function", "give @s diamond_sword[dam", []);
  assert.ok(has(components, "damage"), JSON.stringify(components));
  const text = await labels("1.21.5", "function", "tellraw @a {te", []);
  assert.ok(has(text, "text:"), JSON.stringify(text));

  const features = await labels("26.3", "function", "place feature t:", [[join("data", "t", "worldgen", "feature", "tree.json"), "{}"]]);
  assert.ok(has(features, "t:tree"), JSON.stringify(features));
  const slots = await labels("26.3", "function", "execute if items entity @s mob.", []);
  assert.ok(has(slots, "mob.inventory."), JSON.stringify(slots));
});

// The tests below run what the editor test (`editors/vscode/test`)
// runs, through the worker that gives the server its stack.

interface Published {
  uri: string;
  diagnostics: { code: string; message: string; source: string; severity: number }[];
}

test("an_edit_reaches_the_diagnostics_and_the_server_exits_with_0_after_shutdown", { timeout: 120_000 }, async () => {
  const root = projectRoot("lsp-session");
  writeFiles(root, [
    ["pack.mcmeta", '{"pack": {"pack_format": 26, "description": "t"}}'],
    [join(".vscode", "settings.json"), '{"datapack.lint.strictFunctionCheck": ["error", true], "datapack.env.cmdVersion": "1.21"}'],
    [join("data", "t", "function", "main.mcfunction"), "function t:missing\n"],
    [join("data", "t", "function", "lib.mcfunction"), "#> t:lib\n# Says hello\n# @public\n\nsay hello\n"],
  ]);
  const main = pathToFileURL(join(root, "data", "t", "function", "main.mcfunction")).href;
  const client = startServer();
  try {
    const init = (await client.start(root)) as { capabilities: { textDocumentSync: number; completionProvider: { triggerCharacters: string[] } } };
    assert.equal(init.capabilities.textDocumentSync, 2);
    assert.equal(init.capabilities.completionProvider.triggerCharacters.length, 14);

    client.notify("textDocument/didOpen", { textDocument: { uri: main, languageId: "mcfunction", version: 1, text: "function t:missing\n" } });
    // Requests are answered in order, so the notifications before the answer are all there is.
    await client.request("textDocument/hover", { textDocument: { uri: main }, position: { line: 0, character: 0 } });
    const published = client.takeNotifications().filter((n) => n.method === "textDocument/publishDiagnostics").map((n) => n.params as Published);
    const shown = published.filter((p) => p.uri === main).at(-1)!;
    assert.deepEqual(
      shown.diagnostics.map((d) => [d.code, d.source, d.severity]),
      [["strictFunctionCheck", "mcf-linter-spark", 1]],
    );

    client.notify("textDocument/didChange", {
      textDocument: { uri: main, version: 2 },
      contentChanges: [{ range: { start: { line: 0, character: 11 }, end: { line: 0, character: 18 } }, text: "lib" }],
    });
    const position = { line: 0, character: 13 };
    const hover = (await client.request("textDocument/hover", { textDocument: { uri: main }, position })) as { contents: { value: string } };
    assert.equal(hover.contents.value, "**function** `t:lib`\n\n---\n\nSays hello  \n  \n@public  ");
    const cleared = client.takeNotifications().filter((n) => n.method === "textDocument/publishDiagnostics").map((n) => n.params as Published);
    assert.deepEqual(
      cleared.filter((p) => p.uri === main).map((p) => p.diagnostics),
      [[]],
    );

    const definition = (await client.request("textDocument/definition", { textDocument: { uri: main }, position })) as { uri: string }[];
    assert.deepEqual(
      definition.map((l) => l.uri.slice(l.uri.lastIndexOf("/") + 1)),
      ["lib.mcfunction"],
    );
    const references = (await client.request("textDocument/references", { textDocument: { uri: main }, position, context: { includeDeclaration: false } })) as unknown[];
    assert.equal(references.length, 1);

    client.notify("textDocument/didChange", {
      textDocument: { uri: main, version: 3 },
      contentChanges: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, text: "function t:" }],
    });
    const completion = (await client.request("textDocument/completion", { textDocument: { uri: main }, position: { line: 1, character: 11 } })) as {
      isIncomplete: boolean;
      items: { label: string }[];
    };
    assert.equal(completion.isIncomplete, true);
    assert.ok(completion.items.some((i) => i.label === "t:lib"));
  } finally {
    assert.equal(await client.close(), 0);
  }
});

test("a_request_the_server_does_not_support_is_refused", { timeout: 120_000 }, async () => {
  const root = projectRoot("lsp-unsupported");
  writeFiles(root, [["pack.mcmeta", "{}"]]);
  const client = startServer();
  try {
    await client.start(root);
    await assert.rejects(
      client.request("textDocument/documentSymbol", { textDocument: { uri: pathToFileURL(join(root, "x.mcfunction")).href } }),
      (e: unknown) => e instanceof ResponseFailure && e.code === -32601 && e.message === "unsupported request textDocument/documentSymbol",
    );
  } finally {
    await client.close();
  }
});

test("a_client_without_a_workspace_folder_ends_the_server_with_2", { timeout: 120_000 }, async () => {
  const client = new LspClient(process.execPath, [CLI, "lsp"], { stderr: "pipe" });
  await client.request("initialize", { processId: null, rootUri: null, capabilities: {} });
  client.notify("initialized", {});
  assert.equal(await client.exited, 2);
  assert.match(client.stderr, /the client sent no workspace folder/);
});

test("a_function_nested_as_deep_as_the_parsers_allow_is_analysed_in_the_server_without_overflowing_the_stack", { timeout: 120_000 }, async () => {
  const root = projectRoot("lsp-deepest-nesting");
  const text = `execute ${"as @s ".repeat(4090)}run function t:missing\n`;
  writeFiles(root, [
    ["pack.mcmeta", "{}"],
    [join(".vscode", "settings.json"), '{"datapack.env.cmdVersion": "1.21", "datapack.lint.strictFunctionCheck": ["error", true]}'],
    [join("data", "t", "function", "f.mcfunction"), text],
  ]);
  const uri = pathToFileURL(join(root, "data", "t", "function", "f.mcfunction")).href;
  const client = startServer();
  try {
    await client.start(root);
    await client.request("textDocument/hover", { textDocument: { uri }, position: { line: 0, character: 0 } });
    const atStartup = client.takeNotifications().filter((n) => n.method === "textDocument/publishDiagnostics").map((n) => n.params as Published);
    assert.deepEqual(atStartup.map((p) => [p.uri, p.diagnostics.map((d) => d.code)]), [[uri, ["strictFunctionCheck"]]]);

    client.notify("textDocument/didOpen", { textDocument: { uri, languageId: "mcfunction", version: 1, text } });
    client.notify("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: "say hi\n" }],
    });
    await client.request("textDocument/hover", { textDocument: { uri }, position: { line: 1, character: 0 } });
    const edited = client.takeNotifications().filter((n) => n.method === "textDocument/publishDiagnostics").map((n) => n.params as Published);
    assert.deepEqual(edited.map((p) => p.diagnostics.map((d) => d.code)), [["strictFunctionCheck"], ["strictFunctionCheck"]]);
  } finally {
    assert.equal(await client.close(), 0);
  }
});

test("the_ignore_and_max_depth_options_of_the_client_decide_which_files_show_diagnostics", { timeout: 120_000 }, async () => {
  const root = projectRoot("lsp-options");
  writeFiles(root, [
    [join("sub", "pack.mcmeta"), "{}"],
    [join("sub", ".vscode", "settings.json"), "{}"],
    [".vscode/settings.json", '{"datapack.env.cmdVersion": "1.21", "datapack.lint.strictFunctionCheck": ["error", true]}'],
    [join("sub", "data", "t", "function", "f.mcfunction"), "function t:missing\n"],
  ]);
  const shownBy = async (options: unknown): Promise<string[]> => {
    const client = startServer();
    try {
      await client.start(root, options);
      await client.request("textDocument/hover", { textDocument: { uri: "file:///nowhere/x.mcfunction" }, position: { line: 0, character: 0 } });
      const published = client.takeNotifications().filter((n) => n.method === "textDocument/publishDiagnostics").map((n) => n.params as Published);
      return published.map((p) => p.uri.slice(p.uri.lastIndexOf("/") + 1));
    } finally {
      await client.close();
    }
  };
  assert.deepEqual(await shownBy({}), ["f.mcfunction"]);
  assert.deepEqual(await shownBy({ maxDepth: 0 }), []);
  assert.deepEqual(await shownBy({ ignore: ["t:**"] }), []);
  assert.deepEqual(await shownBy({ ignore: ["other:**"], maxDepth: 1 }), ["f.mcfunction"]);
});

test("a_project_that_cannot_be_read_as_it_is_is_reported_to_the_user_with_window_showMessage", { timeout: 120_000 }, async () => {
  const messagesFor = async (name: string, settings: string, layout: string): Promise<{ type: number; message: string }[]> => {
    const root = projectRoot(name);
    writeFiles(root, [
      ["pack.mcmeta", "{}"],
      [join(".vscode", "settings.json"), settings],
      [join("data", "t", layout, "a.mcfunction"), "say hi\n"],
    ]);
    const client = startServer();
    try {
      await client.start(root);
      await client.request("textDocument/hover", { textDocument: { uri: "file:///nowhere/x.mcfunction" }, position: { line: 0, character: 0 } });
      return client
        .takeNotifications()
        .filter((n) => n.method === "window/showMessage")
        .map((n) => n.params as { type: number; message: string });
    } finally {
      await client.close();
    }
  };
  const unsupported = await messagesFor("lsp-message-version", '{"datapack.env.cmdVersion": "1.19"}', "functions");
  assert.equal(unsupported.length, 1);
  assert.equal(unsupported[0]!.type, 1);
  assert.match(unsupported[0]!.message, /^mcf-linter-spark: unsupported game version '1\.19' .*\. Reload the window to try again\.$/);

  const layout = await messagesFor("lsp-message-layout", "{}", "function");
  assert.equal(layout.length, 1);
  assert.equal(layout[0]!.type, 2);
  assert.match(layout[0]!.message, /^mcf-linter-spark: data\/t\/function\/ is laid out for 1\.21 and later/);
});
