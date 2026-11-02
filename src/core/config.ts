// Reads the DHP settings (`datapack.*`) from a VSCode `settings.json`.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { isAsciiWhitespace } from "./chars.ts";
import { type Severity, SparkError, severityParse } from "./diag.ts";
import { asArray, asObject, asStr, get, isObject, pointer, sortedEntries, type JsonValue } from "./json-value.ts";
import { releaseIndex } from "./version.ts";

export class Config {
  /** The game version: `datapack.env.cmdVersion`, else the `env.gameVersion` of a
   * `spyglass.json` when it names a version with data, else 1.20.4. */
  cmdVersion = "1.20.4";
  /** Whether a setting named `cmdVersion` (else it is the default). */
  private versionSet_ = false;
  /** `public` unless `datapack.env.defaultVisibility` says otherwise. */
  defaultVisibility: JsonValue = "public";
  /** Whether the project has a `spyglass.json`, the configuration of the
   * modified Spyglass. Checks where it and DHP disagree follow it then. */
  spyglass = false;
  private readonly lint = new Map<string, JsonValue>();

  /** The settings of the project at `root`: `.vscode/settings.json` (or
   * `explicit`), then `spyglass.json` when it exists. A missing default
   * settings file gives the defaults; a missing `explicit` one is an error. */
  static load(root: string, explicit?: string): Config {
    const settings = explicit ?? join(root, ".vscode", "settings.json");
    let text: string | undefined;
    try {
      text = explicit !== undefined ? readFileSync(settings, "utf8") : readRegular(settings);
    } catch (e) {
      if (explicit !== undefined) throw new SparkError(`${settings}: ${(e as Error).message}`);
    }
    let config: Config;
    if (text === undefined) config = new Config();
    else {
      try {
        config = Config.fromSettings(text);
      } catch (e) {
        throw new SparkError(`${settings}: ${(e as Error).message}`);
      }
    }
    const spyglass = join(root, "spyglass.json");
    let spyglassText: string | undefined;
    try {
      spyglassText = readRegular(spyglass);
    } catch {
      spyglassText = undefined;
    }
    if (spyglassText !== undefined) {
      try {
        config.mergeSpyglass(spyglassText);
      } catch (e) {
        throw new SparkError(`${spyglass}: ${(e as Error).message}`);
      }
    }
    return config;
  }

  /** Parses a VSCode settings file. Keys may be flat (`"datapack.lint.x": ...`)
   * or nested (`"datapack": {"lint": {...}}`). Throws on invalid JSON. */
  static fromSettings(text: string): Config {
    const value = JSON.parse(stripJsonc(text)) as JsonValue;
    const flat = new Map<string, JsonValue>();
    flatten("", value, flat);
    const config = new Config();
    const version = asStr(flat.get("datapack.env.cmdVersion"));
    if (version !== undefined) {
      config.cmdVersion = version;
      config.versionSet_ = true;
    }
    const visibility = flat.get("datapack.env.defaultVisibility");
    if (visibility !== undefined) config.defaultVisibility = visibility;
    for (const [k, v] of flat) {
      if (k.startsWith("datapack.lint.")) config.lint.set(k.slice("datapack.lint.".length), v);
    }
    return config;
  }

  versionSet(): boolean {
    return this.versionSet_;
  }

  /** A diagnostic rule written as `[severity, value]`. Returns `undefined` when the
   * rule is absent, null, or has no severity. */
  rule(name: string): [Severity, JsonValue] | undefined {
    const arr = asArray(this.lint.get(name));
    if (arr === undefined || arr.length !== 2) return undefined;
    const s = asStr(arr[0]);
    const severity = s === undefined ? undefined : severityParse(s);
    if (severity === undefined) return undefined;
    if (arr[1] === null || arr[1] === false) return undefined;
    return [severity, arr[1]!];
  }

  /** Reads the IMP-Doc rules of the modified Spyglass (`impDoc*` under `lint`)
   * from a `spyglass.json`. Settings already given in `settings.json` win. Throws on invalid JSON. */
  mergeSpyglass(text: string): void {
    const value = JSON.parse(stripJsonc(text)) as JsonValue;
    this.spyglass = true;
    // Spyglass also takes `Auto` and `Latest release`, which name no version here.
    const v = asStr(pointer(value, "/env/gameVersion"));
    if (v !== undefined && !this.versionSet_ && releaseIndex(v) !== undefined) {
      this.cmdVersion = v;
      this.versionSet_ = true;
    }
    const lint = asObject(get(value, "lint"));
    if (lint !== undefined) {
      for (const [k, v] of sortedEntries(lint)) {
        if (k.startsWith("impDoc") && !this.lint.has(k)) this.lint.set(k, v);
      }
    }
  }

  /** The severity of a rule written the way Spyglass writes it: `"warning"`,
   * `[severity, value]`, or `true` (warning). `"off"`, `null` and `false` disable it. */
  severityRule(name: string): Severity | undefined {
    const v = this.lint.get(name);
    if (typeof v === "string") return severityParse(v);
    if (v === true) return "Warning";
    if (Array.isArray(v) && v.length === 2 && v[1] !== false && v[1] !== null) {
      const s = asStr(v[0]);
      return s === undefined ? undefined : severityParse(s);
    }
    return undefined;
  }

  /** The severity of an IMP-Doc rule of the modified Spyglass, which only its
   * `spyglass.json` enables. */
  spyglassRule(name: string): Severity | undefined {
    return this.spyglass ? this.severityRule(name) : undefined;
  }

  /** Whether any IMP-Doc rule of the modified Spyglass is enabled. */
  spyglassImpDoc(): boolean {
    return ["impDocVisibilityConflict", "impDocBareDeclaration", "impDocPrivateBestEffort"].some((r) => this.spyglassRule(r) !== undefined);
  }

  /** A `[severity, value]` rule whose value may be `false`, as in the quote
   * rules where `false` means "must not be quoted". `undefined` when absent or null. */
  ruleAny(name: string): [Severity, JsonValue] | undefined {
    const arr = asArray(this.lint.get(name));
    if (arr === undefined || arr.length !== 2) return undefined;
    const s = asStr(arr[0]);
    const severity = s === undefined ? undefined : severityParse(s);
    return severity === undefined ? undefined : [severity, arr[1]!];
  }

  /** The setting as written, `undefined` when it is absent. Unlike `rule`, a
   * `false` value is kept: `nbtBoolean` and the `*Quote` rules use it as a setting. */
  lintValue(name: string): JsonValue | undefined {
    return this.lint.get(name);
  }

  setRule(name: string, value: JsonValue): void {
    this.lint.set(name, value);
  }

  /** A copy (Rust's `Config` is `Clone`). */
  clone(): Config {
    const c = new Config();
    c.cmdVersion = this.cmdVersion;
    c.versionSet_ = this.versionSet_;
    c.defaultVisibility = this.defaultVisibility;
    c.spyglass = this.spyglass;
    for (const [k, v] of this.lint) c.lint.set(k, v);
    return c;
  }
}

function readRegular(path: string): string {
  if (!statSync(path).isFile()) throw new Error("invalid input");
  return readFileSync(path, "utf8");
}

/** Flattens nested objects into dotted keys. A lint rule's value is kept whole,
 * because format-only rules are objects themselves. */
function flatten(prefix: string, v: JsonValue, out: Map<string, JsonValue>): void {
  if (!isObject(v)) return;
  for (const [k, child] of sortedEntries(v)) {
    const key = prefix === "" ? k : `${prefix}.${k}`;
    const isRule = key.startsWith("datapack.lint.") && !key.slice("datapack.lint.".length).includes(".");
    if (isObject(child) && !isRule) flatten(key, child, out);
    else out.set(key, child);
  }
}

/** Removes `//` and `/* *\/` comments and trailing commas so that `JSON.parse` can read JSONC. */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const b = text[i]!;
    if (inString) {
      out += b;
      if (b === "\\" && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (b === '"') inString = false;
      i += 1;
      continue;
    }
    if (b === '"') {
      inString = true;
      out += '"';
      i += 1;
    } else if (b === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (b === "/" && text[i + 1] === "*") {
      i += 2;
      while (i + 1 < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
    } else if (b === ",") {
      const j = skipBlank(text, i + 1);
      if (text[j] !== "}" && text[j] !== "]") out += ",";
      i += 1;
    } else {
      out += b;
      i += 1;
    }
  }
  return out;
}

function skipBlank(text: string, from: number): number {
  let i = from;
  for (;;) {
    while (i < text.length && isAsciiWhitespace(text[i]!)) i += 1;
    if (text[i] === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (text[i] === "/" && text[i + 1] === "*") {
      i += 2;
      while (i + 1 < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
    } else return i;
  }
}
