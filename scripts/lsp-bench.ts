// Measures the language server: the time until the startup diagnostics are
// published, and the time from an edit to the edited file's diagnostics.
//
// Usage:
//   bun scripts/lsp-bench.ts <mcf-linter-spark executable> <project root> <file to edit> [--edits 50]
//
// Each edit appends a line to the file and then removes it, alternating, so the
// file's diagnostics change between two states. `--line <text>` sets the line
// (for example a `#declare` that many files depend on); the time until the
// server goes quiet is reported as well.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [exe, root, file] = Bun.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !["--edits", "--line"].includes(all[i - 1]));
const editsFlag = Bun.argv.indexOf("--edits");
const edits = editsFlag >= 0 ? Number(Bun.argv[editsFlag + 1]) : 50;
const lineFlag = Bun.argv.indexOf("--line");
const line = lineFlag >= 0 ? Bun.argv[lineFlag + 1] : "scoreboard players set $SparkBench Undefined.Objective 1";
if (!exe || !root || !file) {
  console.error("usage: bun scripts/lsp-bench.ts <mcf-linter-spark executable> <project root> <file to edit> [--edits 50]");
  process.exit(2);
}

const proc = spawn(exe, ["lsp"], { stdio: ["pipe", "pipe", "inherit"] });
let buffer = Buffer.alloc(0);
const listeners: ((msg: any) => void)[] = [];
proc.stdout.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())![1]);
    if (buffer.length < headerEnd + 4 + length) return;
    const msg = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
    buffer = buffer.subarray(headerEnd + 4 + length);
    for (const l of [...listeners]) l(msg);
  }
});

function send(msg: object) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...msg });
  proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function waitFor(pred: (msg: any) => boolean): Promise<any> {
  return new Promise((res) => {
    const l = (m: any) => {
      if (pred(m)) {
        listeners.splice(listeners.indexOf(l), 1);
        res(m);
      }
    };
    listeners.push(l);
  });
}

/// Resolves when no diagnostics have been published for `quietMs`. With
/// `first`, the quiet period starts only after the first publication.
function waitQuiet(quietMs: number, first = false): Promise<number> {
  return new Promise((res) => {
    let count = 0;
    let timer = first ? undefined : setTimeout(done, quietMs);
    const l = (m: any) => {
      if (m.method === "textDocument/publishDiagnostics") {
        count++;
        clearTimeout(timer);
        timer = setTimeout(done, quietMs);
      }
    };
    function done() {
      listeners.splice(listeners.indexOf(l), 1);
      res(count);
    }
    listeners.push(l);
  });
}

const rootUri = pathToFileURL(resolve(root)).href;
const t0 = performance.now();
send({ id: 1, method: "initialize", params: { processId: null, rootUri, workspaceFolders: [{ uri: rootUri, name: "root" }], capabilities: {} } });
await waitFor((m) => m.id === 1);
send({ method: "initialized", params: {} });
const quiet = 500;
const published = await waitQuiet(quiet, true);
const startup = performance.now() - t0 - quiet;
console.log(`startup: ${startup.toFixed(0)} ms until ${published} files had their diagnostics published`);

const uri = pathToFileURL(resolve(file)).href;
const original = readFileSync(file, "utf8");
const isFor = (m: any) => m.method === "textDocument/publishDiagnostics" && decodeURIComponent(m.params.uri).toLowerCase() === decodeURIComponent(uri).toLowerCase();
send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "mcfunction", version: 1, text: original } } });
await waitQuiet(200);

const times: number[] = [];
const settles: number[] = [];
for (let i = 0; i < edits; i++) {
  const text = i % 2 === 0 ? `${original}\n${line}\n` : original;
  const start = performance.now();
  const got = waitFor(isFor);
  send({ method: "textDocument/didChange", params: { textDocument: { uri, version: i + 2 }, contentChanges: [{ text }] } });
  await got;
  times.push(performance.now() - start);
  await waitQuiet(100);
  settles.push(performance.now() - start - 100);
}
settles.sort((a, b) => a - b);
console.log(`edit -> all affected files republished: p50 ${settles[Math.floor(settles.length / 2)].toFixed(1)} ms, max ${settles[settles.length - 1].toFixed(1)} ms`);
times.sort((a, b) => a - b);
const pct = (p: number) => times[Math.min(times.length - 1, Math.floor((times.length * p) / 100))];
console.log(`edit -> diagnostics of the edited file (${edits} edits): p50 ${pct(50).toFixed(1)} ms, p95 ${pct(95).toFixed(1)} ms, max ${times[times.length - 1].toFixed(1)} ms`);

send({ id: 2, method: "shutdown" });
await waitFor((m) => m.id === 2);
send({ method: "exit" });
proc.stdin.end();
await new Promise((res) => proc.on("exit", res));
process.exit(0);
