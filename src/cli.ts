import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

import { compareStr, isControl, isWhitespace } from "./core/chars.ts";
import { Config } from "./core/config.ts";
import { SEVERITY_RANK, SparkError, severityAsStr } from "./core/diag.ts";
import { type JsonValue, stringifySorted } from "./core/json-value.ts";
import { LineIndex } from "./core/position.ts";
import { Project, defaultMaxDepth } from "./core/project.ts";
import { dlsCache } from "./core/symbols.ts";

const USAGE = `usage: mcf-linter-spark lsp
       mcf-linter-spark check [<root>] [--config <settings.json>] [--ignore <pattern>]... [--max-depth <n>] [--format text|github] [--json <file>] [--symbols <file>]

'mcf-linter-spark lsp' runs the language server over stdio.

Lints the data packs under <root> (default: the current directory). The DHP
settings are read from <root>/.vscode/settings.json unless --config is given.
A <root>/spyglass.json enables the IMP-Doc rules it sets and the checks of the
modified Spyglass where it differs from DHP.
--ignore takes a resource id pattern (e.g. 'animated_java:**'); matching files
are analysed but not reported. --max-depth sets how many directory levels below
<root> are searched for data packs (default 2, no limit with a spyglass.json).
--symbols writes the declarations and definitions in the shape of the cache
DHP writes to .cache/dls.json. Exits with 1 when an error or a warning is found.`;

interface Args {
  root: string;
  config: string | undefined;
  ignore: string[];
  maxDepth: number | undefined;
  format: "Text" | "Github";
  json: string | undefined;
  symbols: string | undefined;
}

function parseArgs(argv: readonly string[]): Args | string {
  const it = argv[Symbol.iterator]();
  const first = it.next().value;
  if (first === "-h" || first === "--help" || first === undefined) return USAGE;
  if (first !== "check") return `unknown command '${first}'\n\n${USAGE}`;
  const args: Args = { root: ".", config: undefined, ignore: [], maxDepth: undefined, format: "Text", json: undefined, symbols: undefined };
  for (let a = it.next().value; a !== undefined; a = it.next().value) {
    const value = (name: string): string => {
      const v = it.next().value;
      if (v === undefined) throw new ArgError(`${name} needs a value`);
      return v;
    };
    try {
      switch (a) {
        case "--config":
          args.config = value("--config");
          break;
        case "--ignore":
          args.ignore.push(value("--ignore"));
          break;
        case "--max-depth": {
          const v = value("--max-depth");
          if (!/^\+?[0-9]+$/.test(v)) return "--max-depth needs a number";
          args.maxDepth = Number(v.replace("+", ""));
          break;
        }
        case "--format": {
          const f = value("--format");
          if (f === "text") args.format = "Text";
          else if (f === "github") args.format = "Github";
          else return `unknown format '${f}'`;
          break;
        }
        case "--json":
          args.json = value("--json");
          break;
        case "--symbols":
          args.symbols = value("--symbols");
          break;
        case "-h":
        case "--help":
          return USAGE;
        default:
          if (a.startsWith("--")) return `unknown option '${a}'`;
          args.root = a;
      }
    } catch (e) {
      if (e instanceof ArgError) return e.message;
      throw e;
    }
  }
  return args;
}

class ArgError extends Error {}

export async function start(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    process.stderr.write(`${args}\n`);
    return 2;
  }
  try {
    return (await run(args)) ? 1 : 0;
  } catch (e) {
    if (!(e instanceof SparkError)) throw e;
    process.stderr.write(`mcf-linter-spark: ${oneLine(e.message)}\n`);
    return 2;
  }
}

async function run(args: Args): Promise<boolean> {
  const started = performance.now();
  const config = Config.load(args.root, args.config);
  const maxDepth = args.maxDepth ?? defaultMaxDepth(config);
  const project = await Project.load(args.root, config, { ignore: args.ignore, maxDepth });
  for (const notice of project.notices) process.stderr.write(`mcf-linter-spark: ${oneLine(notice)}\n`);
  if (project.files.length === 0) throw new SparkError(`no data pack files found under ${args.root}`);
  const loaded = performance.now() - started;
  const results = project.allDiagnostics();
  results.sort((a, b) => compareStr(project.files[a[0]]!.rel, project.files[b[0]]!.rel));

  const counts = [0, 0, 0, 0];
  const out: string[] = [];
  const json: string[] | undefined = args.json === undefined ? undefined : [];
  for (const [fid, diags] of results) {
    const f = project.files[fid]!;
    const index = new LineIndex(f.text);
    for (const d of diags) {
      counts[SEVERITY_RANK[d.severity]]! += 1;
      const [l1, c1] = index.position(f.text, d.start);
      const [l2, c2] = index.position(f.text, d.end);
      if (args.format === "Github" && (d.severity === "Error" || d.severity === "Warning")) {
        const level = d.severity === "Error" ? "error" : "warning";
        out.push(
          `::${level} file=${escapeProperty(f.rel)},line=${l1 + 1},col=${c1 + 1},endLine=${l2 + 1},endColumn=${c2 + 1},title=${escapeProperty(d.code)}::${escapeData(d.message)}`,
        );
      } else {
        out.push(`${lineStartPath(f.rel)}:${l1 + 1}:${c1 + 1} ${severityAsStr(d.severity)} ${oneLine(d.message)} (${d.code})`);
      }
      json?.push(
        stringifySorted({
          path: f.rel,
          line: l1 + 1,
          column: c1 + 1,
          endLine: l2 + 1,
          endColumn: c2 + 1,
          severity: severityAsStr(d.severity),
          code: d.code,
          message: d.message,
          source: "mcf-linter-spark",
        }),
      );
    }
  }
  if (out.length) process.stdout.write(`${out.join("\n")}\n`);
  if (args.json !== undefined) writeOrFail(args.json, json!.length ? `${json!.join("\n")}\n` : "");
  if (args.symbols !== undefined) {
    const text = stringifySorted(dlsCache(project) as JsonValue);
    const dir = dirname(args.symbols);
    if (dir !== "" && dir !== ".") {
      try {
        mkdirSync(dir, { recursive: true });
      } catch (e) {
        throw new SparkError(`${dir}: ${(e as Error).message}`);
      }
    }
    writeOrFail(args.symbols, text);
  }
  const reported = project.files.filter((f) => !f.ignored).length;
  process.stderr.write(
    `${counts[0]} errors, ${counts[1]} warnings, ${counts[2]} information, ${counts[3]} hints in ${reported} files (${Math.round(performance.now() - started)} ms, load ${Math.round(loaded)} ms)\n`,
  );
  return counts[0]! + counts[1]! > 0;
}

function writeOrFail(path: string, text: string): void {
  try {
    writeFileSync(path, text);
  } catch (e) {
    throw new SparkError(`${path}: ${(e as Error).message}`);
  }
}

/** A control character as an escape: `\t`, `\r`, `\n`, else `\u{..}`. */
function escapeControl(c: string): string {
  if (c === "\t") return "\\t";
  if (c === "\r") return "\\r";
  if (c === "\n") return "\\n";
  return `\\u{${c.codePointAt(0)!.toString(16)}}`;
}

export function oneLine(s: string): string {
  let line = "";
  for (const c of s) line += isControl(c) ? escapeControl(c) : c;
  return line.replaceAll("##[", "##\\[");
}

export function lineStartPath(rel: string): string {
  const path = oneLine(rel);
  let i = 0;
  for (const c of path) {
    if (!isWhitespace(c)) break;
    i += c.length;
  }
  return path.startsWith("::", i) ? `./${path}` : path;
}

function escapeData(s: string): string {
  let out = "";
  for (const c of s) {
    if (c === "%") out += "%25";
    else if (c === "\r") out += "%0D";
    else if (c === "\n") out += "%0A";
    else if (isControl(c)) out += escapeControl(c);
    else out += c;
  }
  return out;
}

function escapeProperty(s: string): string {
  return escapeData(s).replaceAll(":", "%3A").replaceAll(",", "%2C");
}
