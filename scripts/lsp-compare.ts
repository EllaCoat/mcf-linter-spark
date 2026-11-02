// Runs the Rust language server and this one on the same project with the same messages, and
// compares what they answer: the capabilities, the diagnostics published at startup and after
// each edit, and the results of completion, hover, definition, references, signature help and
// document links at many positions of sampled functions and data pack JSON files.
//
// Usage:
//   node scripts/lsp-compare.ts --rust <mcf-linter-spark.exe> --root <project root>
//     [--functions 24] [--jsons 12] [--positions 24] [--edits 4] [--show 10] [--init '{"ignore": [], "maxDepth": 2}']
//
// Exits with 0 when everything is the same, 1 when something differs.

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { type Json, LspClient, type Notification, ResponseFailure } from "../test/lsp/client.ts";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? undefined : argv[i + 1];
};
const rust = flag("rust");
const rootFlag = flag("root");
if (rust === undefined || rootFlag === undefined) {
  console.error("usage: node scripts/lsp-compare.ts --rust <mcf-linter-spark.exe> --root <project root> [--functions 24] [--jsons 12] [--positions 24] [--edits 4] [--show 10] [--init <initializationOptions as JSON>]");
  process.exit(2);
}
const root = resolve(rootFlag);
const FUNCTIONS = Number(flag("functions") ?? "24");
const JSONS = Number(flag("jsons") ?? "12");
const POSITIONS = Number(flag("positions") ?? "24");
const EDITS = Number(flag("edits") ?? "4");
const SHOW = Number(flag("show") ?? "10");
const INIT = flag("init") === undefined ? undefined : (JSON.parse(flag("init")!) as Json);

const cli = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const sides = {
  rust: new LspClient(rust, ["lsp"], { stderr: "pipe", timeoutMs: 600_000 }),
  ts: new LspClient(process.execPath, [cli, "lsp"], { stderr: "pipe", timeoutMs: 600_000 }),
};

/** Stable text for comparing values: object keys in order. */
function canon(v: unknown): string {
  return JSON.stringify(v, (_, x: unknown) => (x !== null && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
}

interface Tally {
  compared: number;
  different: number;
  /** Comparisons where the answer holds something (not null, not an empty list). */
  filled: number;
}
const tallies = new Map<string, Tally>();
const shown: string[] = [];
const times = { rust: new Map<string, number>(), ts: new Map<string, number>() };

function record(category: string, same: boolean, describe: () => string, filled = false): void {
  const t = tallies.get(category) ?? { compared: 0, different: 0, filled: 0 };
  tallies.set(category, t);
  t.compared += 1;
  if (filled) t.filled += 1;
  if (!same) {
    t.different += 1;
    if (shown.length < SHOW) shown.push(`${category}: ${describe()}`);
  }
}

function clip(s: string, n = 500): string {
  return s.length > n ? `${s.slice(0, n)}... (${s.length} chars)` : s;
}

/** A response, or the failure that came back instead. */
async function ask(side: keyof typeof sides, method: string, params: Json, label = method): Promise<Json> {
  const started = performance.now();
  try {
    return await sides[side].request(method, params);
  } catch (e) {
    if (e instanceof ResponseFailure) return { failure: e.code, message: e.message };
    throw e;
  } finally {
    times[side].set(label, (times[side].get(label) ?? 0) + performance.now() - started);
  }
}

async function compareRequest(category: string, method: string, params: Json, where: string): Promise<void> {
  const [a, b] = await Promise.all([ask("rust", method, params), ask("ts", method, params)]);
  const ca = canon(a);
  const cb = canon(b);
  record(category, ca === cb, () => `${where}\n  rust: ${clip(ca)}\n  ts:   ${clip(cb)}`, isFilled(a));
}

function isFilled(answer: Json): boolean {
  if (answer === null || answer === undefined) return false;
  if (Array.isArray(answer)) return answer.length > 0;
  const items = (answer as { items?: unknown }).items;
  return !(Array.isArray(items) && items.length === 0);
}

/** Answers come in order, so the notifications before the answer to a request are all there are. */
async function barrier(): Promise<[Notification[], Notification[]]> {
  const nowhere = { textDocument: { uri: "file:///nowhere/x.mcfunction" }, position: { line: 0, character: 0 } };
  await Promise.all([ask("rust", "textDocument/hover", nowhere, "waiting for the notifications"), ask("ts", "textDocument/hover", nowhere, "waiting for the notifications")]);
  return [sides.rust.takeNotifications(), sides.ts.takeNotifications()];
}

function compareNotifications(category: string, a: Notification[], b: Notification[], where: string): void {
  const same = a.length === b.length && a.every((n, i) => canon(n) === canon(b[i]));
  record(category, same, () => {
    const i = a.findIndex((n, k) => canon(n) !== canon(b[k]));
    const at = i < 0 ? Math.min(a.length, b.length) : i;
    return `${where}: ${a.length} messages from rust, ${b.length} from ts; first difference at ${at}\n  rust: ${clip(canon(a[at]))}\n  ts:   ${clip(canon(b[at]))}`;
  });
}

/** After a reload the files that showed diagnostics are cleared first, in the order of a hash set
 * on the Rust side (it changes from run to run); the files that show diagnostics again follow. */
function compareReload(category: string, a: Notification[], b: Notification[], where: string): void {
  const cleared = (v: Notification[]) => {
    let n = 0;
    while (n < v.length && (v[n]!.params as { diagnostics?: unknown[] }).diagnostics?.length === 0) n++;
    return n;
  };
  const [ca, cb] = [cleared(a), cleared(b)];
  const sortedCleared = (v: Notification[], n: number) => v.slice(0, n).map(canon).sort();
  const sameCleared = ca === cb && canon(sortedCleared(a, ca)) === canon(sortedCleared(b, cb));
  record(`${category} (files cleared first, as a set)`, sameCleared, () => `${where}: ${ca} cleared on the rust side, ${cb} on the ts side`);
  compareNotifications(`${category} (files shown again, in order)`, a.slice(ca), b.slice(cb), where);
}

function notifyBoth(method: string, params: Json): void {
  sides.rust.notify(method, params);
  sides.ts.notify(method, params);
}

// The files to ask about.

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
}

function evenly<T>(items: readonly T[], n: number): T[] {
  if (n <= 0 || items.length === 0) return [];
  if (items.length <= n) return [...items];
  return Array.from({ length: n }, (_, i) => items[Math.floor(((i + 0.5) * items.length) / n)]!);
}

const all: string[] = [];
walk(root, all);
all.sort();
const inData = (p: string): boolean => /[\\/]data[\\/][^\\/]+[\\/]/.test(relative(root, p));
const functions = all.filter((p) => p.endsWith(".mcfunction") && inData(p));
const jsons = all.filter((p) => p.endsWith(".json") && inData(p));
const read = new Map<string, string>();
const textOf = (p: string): string => {
  let t = read.get(p);
  if (t === undefined) read.set(p, (t = readFileSync(p, "utf8")));
  return t;
};
// Half evenly over all, the rest among the ones with comment links, storage paths and IMP-Doc.
const interesting = (re: RegExp) => functions.filter((p) => re.test(textOf(p)));
const chosenFunctions = [
  ...new Set([
    ...evenly(functions, Math.ceil(FUNCTIONS / 2)),
    ...evenly(interesting(/\]\([a-z0-9_.-]+:/), Math.floor(FUNCTIONS / 6)),
    ...evenly(interesting(/\bstorage\b/), Math.floor(FUNCTIONS / 6)),
    ...evenly(interesting(/^#> /m), Math.floor(FUNCTIONS / 6)),
  ]),
];
const chosenJsons = evenly(jsons, JSONS);

/** Positions spread over the text: line starts and ends, and the edges and middles of the words. */
function positionsOf(text: string, count: number): { line: number; character: number }[] {
  const lines = text.split("\n");
  const numbered = lines.map((l, i) => [l, i] as const).filter(([l]) => l.length > 0);
  const perLine = 4;
  const out: { line: number; character: number }[] = [];
  for (const [l, line] of evenly(numbered, Math.ceil(count / perLine))) {
    const cols = new Set<number>([0, l.length]);
    for (const m of l.matchAll(/\S+/g)) {
      cols.add(m.index);
      cols.add(m.index + 1);
      cols.add(m.index + Math.floor(m[0].length / 2));
      cols.add(m.index + m[0].length);
    }
    for (const character of evenly([...cols].sort((a, b) => a - b), perLine)) out.push({ line, character });
  }
  // Beyond the end of a line and of the file.
  out.push({ line: 0, character: 9999 }, { line: lines.length + 3, character: 0 });
  return out;
}

const tally = () =>
  [...tallies].map(([c, t]) => `${c}: ${t.compared} compared, ${t.compared - t.different} identical, ${t.different} different${t.filled ? ` (${t.filled} with a non-empty answer)` : ""}`);

async function main(): Promise<void> {
  const started = performance.now();
  const [initA, initB] = await Promise.all([sides.rust.start(root, INIT), sides.ts.start(root, INIT)]);
  record("initialize", canon(initA) === canon(initB), () => `rust: ${clip(canon(initA))}\n  ts:   ${clip(canon(initB))}`);
  const [startupA, startupB] = await barrier();
  const published = (v: Notification[]) => v.filter((n) => n.method === "textDocument/publishDiagnostics");
  const diagnosticCount = (v: Notification[]) => published(v).reduce((n, m) => n + ((m.params as { diagnostics: unknown[] }).diagnostics.length), 0);
  console.log(
    `startup: rust ${published(startupA).length} files / ${diagnosticCount(startupA)} diagnostics, ts ${published(startupB).length} files / ${diagnosticCount(startupB)} diagnostics (${Math.round(performance.now() - started)} ms)`,
  );
  // Files first, then each file's diagnostics, so that a difference says what differs.
  const byUri = (v: Notification[]) => new Map(published(v).map((n) => [(n.params as { uri: string }).uri, canon(n.params)]));
  const ua = byUri(startupA);
  const ub = byUri(startupB);
  for (const uri of new Set([...ua.keys(), ...ub.keys()])) record("startup diagnostics (per file)", ua.get(uri) === ub.get(uri), () => `${uri}\n  rust: ${clip(ua.get(uri) ?? "(none)")}\n  ts:   ${clip(ub.get(uri) ?? "(none)")}`);
  compareNotifications("startup messages (in order)", startupA, startupB, "startup");

  for (const [files, language] of [
    [chosenFunctions, "mcfunction"],
    [chosenJsons, "json"],
  ] as const) {
    for (const file of files) {
      const text = textOf(file);
      const uri = pathToFileURL(file).href;
      const rel = relative(root, file);
      notifyBoth("textDocument/didOpen", { textDocument: { uri, languageId: language, version: 1, text } });
      const [na, nb] = await barrier();
      compareNotifications("didOpen messages", na, nb, rel);
      const document = { uri };
      await compareRequest("documentLink", "textDocument/documentLink", { textDocument: document }, rel);
      for (const [n, position] of positionsOf(text, POSITIONS).entries()) {
        const where = `${rel}:${position.line + 1}:${position.character + 1}`;
        const params = { textDocument: document, position };
        await compareRequest(`completion (${language})`, "textDocument/completion", params, where);
        await compareRequest(`hover (${language})`, "textDocument/hover", params, where);
        await compareRequest(`definition (${language})`, "textDocument/definition", params, where);
        await compareRequest(`references (${language})`, "textDocument/references", { ...params, context: { includeDeclaration: n % 2 === 0 } }, where);
        if (language === "mcfunction") await compareRequest("signatureHelp", "textDocument/signatureHelp", params, where);
      }
      notifyBoth("textDocument/didClose", { textDocument: document });
      const [ca, cb] = await barrier();
      compareNotifications("didClose messages", ca, cb, rel);
    }
  }

  // Edits: an incremental change, a whole-text change, a close, and files that appear and go.
  for (const file of evenly(chosenFunctions, EDITS)) {
    const text = textOf(file);
    const uri = pathToFileURL(file).href;
    const rel = relative(root, file);
    const lines = text.split("\n");
    const steps: [string, Json][] = [
      ["append a call of a missing function", { textDocument: { uri, version: 2 }, contentChanges: [{ range: { start: { line: lines.length - 1, character: lines[lines.length - 1]!.length }, end: { line: lines.length - 1, character: lines[lines.length - 1]!.length } }, text: "\nfunction zz_unknown:missing\nscoreboard players set $Spark Undefined.Objective 1\n" }] }],
      ["replace the first line", { textDocument: { uri, version: 3 }, contentChanges: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: lines[0]!.length } }, text: "say あいう🙂 ![x](zz_unknown:missing)" }] }],
      ["replace the whole text", { textDocument: { uri, version: 4 }, contentChanges: [{ text: text.replaceAll("function ", "function zz_") }] }],
    ];
    notifyBoth("textDocument/didOpen", { textDocument: { uri, languageId: "mcfunction", version: 1, text } });
    compareNotifications("didOpen messages", ...(await barrier()), rel);
    for (const [what, params] of steps) {
      notifyBoth("textDocument/didChange", params);
      compareNotifications("didChange messages", ...(await barrier()), `${rel}: ${what}`);
      const here = { textDocument: { uri }, position: { line: 0, character: 5 } };
      await compareRequest("completion (after an edit)", "textDocument/completion", here, `${rel}: ${what}`);
      await compareRequest("hover (after an edit)", "textDocument/hover", here, `${rel}: ${what}`);
    }
    notifyBoth("textDocument/didClose", { textDocument: { uri } });
    compareNotifications("didClose messages", ...(await barrier()), rel);

    // The file goes away and comes back, as the client's file watcher reports it.
    notifyBoth("workspace/didChangeWatchedFiles", { changes: [{ uri, type: 3 }] });
    compareNotifications("watched file deleted", ...(await barrier()), rel);
    notifyBoth("workspace/didChangeWatchedFiles", { changes: [{ uri, type: 1 }] });
    compareNotifications("watched file created", ...(await barrier()), rel);
  }

  // A document of a file that does not exist yet, in a pack.
  const namespaceDir = functions[0] === undefined ? undefined : resolve(functions[0], "..");
  if (namespaceDir !== undefined) {
    const uri = pathToFileURL(join(namespaceDir, "zz_lsp_compare_new.mcfunction")).href;
    notifyBoth("textDocument/didOpen", { textDocument: { uri, languageId: "mcfunction", version: 1, text: "function zz_unknown:missing\nsay hi\n" } });
    compareNotifications("new document messages", ...(await barrier()), "a new function");
    await compareRequest("completion (new document)", "textDocument/completion", { textDocument: { uri }, position: { line: 0, character: 9 } }, "a new function");
    notifyBoth("textDocument/didClose", { textDocument: { uri } });
    compareNotifications("new document closed", ...(await barrier()), "a new function");
  }

  // The same request that neither supports.
  await compareRequest("unsupported request", "textDocument/documentSymbol", { textDocument: { uri: pathToFileURL(chosenFunctions[0] ?? root).href } }, "documentSymbol");

  // A change of the settings reloads everything.
  const settings = pathToFileURL(join(root, ".vscode", "settings.json")).href;
  notifyBoth("workspace/didChangeWatchedFiles", { changes: [{ uri: settings, type: 2 }] });
  compareReload("reload messages (settings changed)", ...(await barrier()), "settings.json");

  const codes = await Promise.all([sides.rust.close(), sides.ts.close()]);
  record("exit code after shutdown", codes[0] === codes[1] && codes[0] === 0, () => `rust ${codes[0]}, ts ${codes[1]}`);

  await compareMessagesToTheUser();
}

/** What a client is told when the project cannot be read as it is: on small projects of their own. */
async function compareMessagesToTheUser(): Promise<void> {
  const scenarios: [string, string, string][] = [
    ["a game version that is not supported", '{"datapack.env.cmdVersion": "1.19"}', "functions"],
    ["settings that cannot be read", "{not json", "functions"],
    ["1.21 directory names with no version set", "{}", "function"],
  ];
  for (const [what, settings, layout] of scenarios) {
    const dir = join(tmpdir(), "mcf-linter-spark-lsp-compare", "messages");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, ".vscode"), { recursive: true });
    mkdirSync(join(dir, "data", "t", layout), { recursive: true });
    writeFileSync(join(dir, "pack.mcmeta"), "{}");
    writeFileSync(join(dir, ".vscode", "settings.json"), settings);
    writeFileSync(join(dir, "data", "t", layout, "a.mcfunction"), "say hi\n");
    const heard: Notification[][] = [];
    for (const [command, args] of [[rust!, ["lsp"]], [process.execPath, [cli, "lsp"]]] as const) {
      const client = new LspClient(command, args, { timeoutMs: 60_000 });
      await client.start(dir);
      await client.request("textDocument/hover", { textDocument: { uri: "file:///nowhere/x.mcfunction" }, position: { line: 0, character: 0 } });
      heard.push(client.takeNotifications());
      await client.close();
    }
    // The reason an unreadable settings file gives is the JSON parser's own wording, which differs.
    const plain = (v: Notification[]) => v.map((n) => canon(n).replace(/(settings\.json: )[^"]*/, "$1(reason)"));
    const same = canon(plain(heard[0]!)) === canon(plain(heard[1]!));
    record("messages to the user", same, () => `${what}\n  rust: ${clip(canon(heard[0]))}\n  ts:   ${clip(canon(heard[1]))}`, heard[0]!.length > 0);
  }
}

try {
  await main();
} catch (e) {
  console.error(`stopped: ${(e as Error).stack ?? e}`);
  for (const [name, client] of Object.entries(sides)) {
    console.error(`${name} stderr: ${client.stderr.trim() || "(nothing)"}`);
    client.kill();
  }
  console.error(tally().join("\n"));
  process.exit(2);
}

console.log(tally().join("\n"));
const different = [...tallies.values()].reduce((n, t) => n + t.different, 0);
const compared = [...tallies.values()].reduce((n, t) => n + t.compared, 0);
const seconds = (m: Map<string, number>) => [...m].map(([k, v]) => `${k.replace("textDocument/", "")} ${(v / 1000).toFixed(1)}`).join(", ");
console.log(`time spent answering (s): rust ${seconds(times.rust)}\n                          ts ${seconds(times.ts)}`);
console.log(`${compared} comparisons, ${compared - different} identical, ${different} different`);
for (const s of shown) console.log(`\n${s}`);
process.exit(different === 0 ? 0 : 1);
