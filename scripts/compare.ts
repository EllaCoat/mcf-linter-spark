// Compares mcf-linter-spark's diagnostics with another linter's, both as JSON lines with
// path, line, column, endLine, endColumn, severity, code, message.
//
// Usage:
//   bun scripts/compare.ts <mcf-linter-spark.jsonl> <reference.jsonl> [--severity error,warning] [--show 5] [--out <dir>]
//
// Two diagnostics match when they are in the same file and line with the same
// severity and their column ranges overlap (or either range is empty).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type D = {
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: string;
  code: string | null;
  message: string;
};

function flag(name: string): string | undefined {
  const i = Bun.argv.indexOf(`--${name}`);
  return i >= 0 ? Bun.argv[i + 1] : undefined;
}

const [sparkPath, refPath] = Bun.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"));
if (!sparkPath || !refPath) {
  console.error("usage: bun scripts/compare.ts <mcf-linter-spark.jsonl> <reference.jsonl> [--severity error,warning] [--show 5] [--out <dir>]");
  process.exit(2);
}
const severities = new Set((flag("severity") ?? "error,warning,information,hint").split(","));
const show = Number(flag("show") ?? "3");
const outDir = flag("out");

function load(path: string): D[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as D)
    .filter((d) => severities.has(d.severity));
}

const ours = load(sparkPath);
const ref = load(refPath);

function overlaps(a: D, b: D): boolean {
  if (a.endLine !== a.line || b.endLine !== b.line) return true;
  const aEmpty = a.endColumn <= a.column;
  const bEmpty = b.endColumn <= b.column;
  if (aEmpty || bEmpty) return Math.abs(a.column - b.column) <= 1 || (a.column >= b.column && a.column <= b.endColumn) || (b.column >= a.column && b.column <= a.endColumn);
  return a.column < b.endColumn && b.column < a.endColumn;
}

const byKey = new Map<string, D[]>();
for (const d of ours) {
  const k = `${d.path}\u0000${d.line}\u0000${d.severity}`;
  (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(d);
}
const matchedOurs = new Set<D>();
const onlyRef: D[] = [];
for (const r of ref) {
  const cands = byKey.get(`${r.path}\u0000${r.line}\u0000${r.severity}`) ?? [];
  const m = cands.find((c) => !matchedOurs.has(c) && overlaps(c, r));
  if (m) matchedOurs.add(m);
  else onlyRef.push(r);
}
const onlyOurs = ours.filter((d) => !matchedOurs.has(d));

// Groups by severity, code and the message with quoted parts and numbers removed.
function shape(d: D): string {
  const msg = d.message
    .replace(/[“"'‘「][^”"'’」]*[”"'’」]/g, "‘…’")
    .replace(/\d+(\.\d+)?/g, "N")
    .slice(0, 110);
  return `${d.severity} | ${d.code ?? "-"} | ${msg}`;
}

function report(title: string, list: D[]) {
  const groups = new Map<string, D[]>();
  for (const d of list) (groups.get(shape(d)) ?? groups.set(shape(d), []).get(shape(d))!).push(d);
  console.log(`\n## ${title}: ${list.length}`);
  for (const [k, g] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${String(g.length).padStart(6)}  ${k}`);
    for (const d of g.slice(0, show)) console.log(`          ${d.path}:${d.line}:${d.column}`);
  }
}

console.log(`matched ${matchedOurs.size} | only reference ${onlyRef.length} | only mcf-linter-spark ${onlyOurs.length}`);
report("only in the reference", onlyRef);
report("only in mcf-linter-spark", onlyOurs);

if (outDir) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "only-reference.jsonl"), onlyRef.map((d) => JSON.stringify(d)).join("\n") + "\n");
  writeFileSync(join(outDir, "only-mcf-linter-spark.jsonl"), onlyOurs.map((d) => JSON.stringify(d)).join("\n") + "\n");
}
