// Runs the Rust version and this one on the same data packs and compares what they write:
// the exit code, the text (or GitHub) output, `--json`, and `--symbols`.
//
// Usage:
//   node scripts/compare.ts --rust <mcf-linter-spark.exe> --out <dir> [--show 10] -- <check arguments>
//
// The check arguments are passed to both (for example `<root> --ignore 'animated_java:**'`).
// Exits with 0 when everything is the same, 1 when something differs.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const own = sep < 0 ? argv : argv.slice(0, sep);
const checkArgs = sep < 0 ? [] : argv.slice(sep + 1);
const flag = (name: string) => {
  const i = own.indexOf(`--${name}`);
  return i < 0 ? undefined : own[i + 1];
};
const rust = flag("rust");
const outDir = flag("out");
const show = Number(flag("show") ?? "10");
if (rust === undefined || outDir === undefined || checkArgs.length === 0) {
  console.error("usage: node scripts/compare.ts --rust <mcf-linter-spark.exe> --out <dir> [--show 10] -- <check arguments>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const cli = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const sides = { rust: [rust], ts: [process.execPath, cli] } as const;

type Run = { status: number | null; stdout: string; json: string; symbols: string; ms: number; stderr: string };

function runSide(name: keyof typeof sides): Run {
  const [cmd, ...pre] = sides[name];
  const json = join(outDir!, `${name}.jsonl`);
  const symbols = join(outDir!, `${name}.symbols.json`);
  writeFileSync(json, "");
  writeFileSync(symbols, "");
  const started = performance.now();
  const r = spawnSync(cmd, [...pre, "check", ...checkArgs, "--json", json, "--symbols", symbols], { encoding: "utf8", maxBuffer: 1 << 30 });
  const ms = Math.round(performance.now() - started);
  writeFileSync(join(outDir!, `${name}.stdout.txt`), r.stdout ?? "");
  writeFileSync(join(outDir!, `${name}.stderr.txt`), r.stderr ?? "");
  return { status: r.status, stdout: r.stdout ?? "", json: readFileSync(json, "utf8"), symbols: readFileSync(symbols, "utf8"), ms, stderr: r.stderr ?? "" };
}

/** Lines only on one side, as multisets (order is compared separately). */
function lineDiff(a: string, b: string): { onlyA: string[]; onlyB: string[]; sameOrder: boolean } {
  const la = a.split("\n");
  const lb = b.split("\n");
  const count = new Map<string, number>();
  for (const l of lb) count.set(l, (count.get(l) ?? 0) + 1);
  const onlyA: string[] = [];
  for (const l of la) {
    const n = count.get(l) ?? 0;
    if (n > 0) count.set(l, n - 1);
    else onlyA.push(l);
  }
  const onlyB = [...count].flatMap(([l, n]) => Array<string>(n).fill(l));
  return { onlyA, onlyB, sameOrder: a === b };
}

const r = runSide("rust");
const t = runSide("ts");
let same = true;
console.log(`rust: exit ${r.status}, ${r.ms} ms | ts: exit ${t.status}, ${t.ms} ms`);
if (r.status !== t.status) {
  same = false;
  console.log(`exit code differs: rust ${r.status}, ts ${t.status}`);
  console.log(`ts stderr: ${t.stderr.slice(0, 2000)}`);
}
for (const [what, a, b] of [
  ["stdout", r.stdout, t.stdout],
  ["--json", r.json, t.json],
  ["--symbols", r.symbols, t.symbols],
] as const) {
  if (a === b) {
    console.log(`${what}: same (${a.split("\n").length - 1} lines, ${a.length} chars)`);
    continue;
  }
  same = false;
  const d = lineDiff(a, b);
  console.log(`${what}: differs — ${d.onlyA.length} lines only in rust, ${d.onlyB.length} only in ts${d.onlyA.length + d.onlyB.length === 0 ? " (same lines, different order)" : ""}`);
  for (const l of d.onlyA.slice(0, show)) console.log(`  rust: ${l.slice(0, 300)}`);
  for (const l of d.onlyB.slice(0, show)) console.log(`  ts:   ${l.slice(0, 300)}`);
}
console.log(`outputs: ${outDir}`);
process.exit(same ? 0 : 1);
