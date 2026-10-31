// Runs inside VSCode (see run.mjs): checks that mcf-linter-spark reports a diagnostic,
// clears it after the edit that fixes it, shows the IMP-Doc hover, and that an
// edit reaches the diagnostics quickly.
const assert = require("node:assert");
const path = require("node:path");
const vscode = require("vscode");

async function waitFor(get, ok, timeoutMs) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = get();
    if (ok(value)) return value;
    if (Date.now() > end) throw new Error(`timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

exports.run = async function run() {
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const uri = vscode.Uri.file(path.join(ws, "pack", "data", "t", "functions", "main.mcfunction"));
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  const sparkDiagnostics = () => vscode.languages.getDiagnostics(uri).filter((d) => d.source === "mcf-linter-spark");

  const before = await waitFor(sparkDiagnostics, (d) => d.length > 0, 20000);
  console.log(`diagnostic: ${before[0].message} (${before[0].code})`);
  assert.strictEqual(before[0].code, "strictFunctionCheck");

  const text = doc.getText();
  const at = text.indexOf("missing");
  const started = Date.now();
  await editor.edit((e) => e.replace(new vscode.Range(doc.positionAt(at), doc.positionAt(at + "missing".length)), "lib"));
  await waitFor(sparkDiagnostics, (d) => d.length === 0, 5000);
  console.log(`cleared after the fix in ${Date.now() - started} ms`);

  const pos = doc.positionAt(doc.getText().indexOf("t:lib") + 2);
  const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", uri, pos);
  const shown = hovers.flatMap((h) => h.contents.map((c) => (typeof c === "string" ? c : c.value))).join("\n");
  console.log(`hover: ${shown.replace(/\s+/g, " ")}`);
  assert.ok(shown.includes("Says hello"), "hover shows the IMP-Doc text");

  const definitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", uri, pos);
  const targets = definitions.map((d) => path.basename((d.targetUri ?? d.uri).fsPath));
  console.log(`definition: ${targets.join(", ")}`);
  assert.ok(targets.includes("lib.mcfunction"), "the definition of t:lib is its file");

  const end = doc.lineAt(doc.lineCount - 1).range.end;
  await editor.edit((e) => e.insert(end, "\nfunction t:"));
  const cursor = doc.lineAt(doc.lineCount - 1).range.end;
  const list = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", uri, cursor);
  const labels = list.items.map((i) => (typeof i.label === "string" ? i.label : i.label.label));
  console.log(`completion: ${labels.filter((l) => l.startsWith("t:")).join(", ")}`);
  assert.ok(labels.includes("t:lib"), "completion offers the pack's function");
  await editor.edit((e) => e.delete(new vscode.Range(end, cursor)));
  await waitFor(sparkDiagnostics, (d) => d.length === 0, 5000);

  const times = [];
  for (let i = 0; i < 20; i++) {
    const broken = sparkDiagnostics().length > 0;
    const [from, to] = broken ? ["missing", "lib"] : ["lib", "missing"];
    const offset = doc.getText().indexOf(`t:${from}`) + 2;
    const t0 = Date.now();
    await editor.edit((e) => e.replace(new vscode.Range(doc.positionAt(offset), doc.positionAt(offset + from.length)), to));
    await waitFor(sparkDiagnostics, (d) => d.length > 0 !== broken, 5000);
    times.push(Date.now() - t0);
  }
  times.sort((a, b) => a - b);
  console.log(`edit -> diagnostics: p50 ${times[10]} ms, p95 ${times[18]} ms, max ${times[19]} ms`);
  assert.ok(times[18] < 200, "edits are not held back before they reach the server");
};
