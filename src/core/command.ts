// Parses one command line against the command tree, like Brigadier's
// `CommandDispatcher.parse`, and collects what the arguments report.

import { ArgCtx, type ArgValue, type PathNode, parse as parseArgument } from "./args/index.ts";
import type { Config } from "./config.ts";
import type { VersionData } from "./data.ts";
import { type Diagnostic, ParseError } from "./diag.ts";
import type { Def, Ref } from "./facts.ts";
import { Reader } from "./reader.ts";
import { type NodeId, ROOT, hasChildren, nodeName } from "./tree.ts";

export type Effect =
  | { kind: "Diag"; diag: Diagnostic }
  | { kind: "Ref"; ref: Ref }
  /** A reference that Spyglass 4 binds as a definition: the storage of a
   * data command, a score holder that a command writes. Only the IMP-Doc
   * rules of the modified Spyglass treat it differently from `Ref`. */
  | { kind: "Write"; ref: Ref }
  | { kind: "Def"; def: Def };

export interface CommandResult {
  error: ParseError | undefined;
  effects: Effect[];
}

export const MAX_NODES = 8192;

export function parseCommand(line: string, base: number, data: VersionData, config: Config): CommandResult {
  const w = new Walker(data, config, line, base);
  const outcome = w.children(ROOT, 0, [], [], 0);
  return outcome.ok ? { error: undefined, effects: outcome.effects } : { error: outcome.error, effects: outcome.effects };
}

type Outcome = { ok: true; effects: Effect[] } | { ok: false; error: ParseError; effects: Effect[] };

class Walker {
  readonly data: VersionData;
  readonly config: Config;
  readonly src: string;
  readonly base: number;

  constructor(data: VersionData, config: Config, src: string, base: number) {
    this.data = data;
    this.config = config;
    this.src = src;
    this.base = base;
  }

  errAt(pos: number, message: string): ParseError {
    const space = this.src.indexOf(" ", pos);
    const end = space < 0 ? this.src.length : space;
    return new ParseError(this.base + pos, this.base + end, message);
  }

  /** Parses the children of `node` starting at `pos` of the line. */
  children(node: NodeId, pos: number, path: PathNode[], values: ArgValue[], depth: number): Outcome {
    if (depth >= MAX_NODES) {
      return { ok: false, error: this.errAt(pos, `Too many arguments in one command (more than ${MAX_NODES})`), effects: [] };
    }
    const tree = this.data.tree;
    const n = tree.node(node);
    const space = this.src.indexOf(" ", pos);
    const wordEnd = space < 0 ? this.src.length : space;
    const word = this.src.slice(pos, wordEnd);
    const lit = n.literals.find((c) => nodeName(tree.node(c)) === word);
    if (lit !== undefined) return this.afterNode(lit, wordEnd, [], path, values, depth);
    if (n.arguments.length === 0) {
      return { ok: false, error: this.errAt(pos, node === ROOT ? "Unknown command" : "Incorrect argument for command"), effects: [] };
    }
    let best: { error: ParseError; effects: Effect[] } | undefined;
    for (const arg of n.arguments) {
      const k = tree.node(arg).kind;
      if (k.kind !== "Argument") continue;
      const effects: Effect[] = [];
      const reader = new Reader(this.src, this.base, pos);
      const saved = values.length;
      const cx = new ArgCtx(this.data, this.config, effects, k.name, path, values);
      const r = parseArgument(k.parser, reader, cx);
      const outcome: Outcome = r instanceof ParseError ? { ok: false, error: r, effects } : this.afterNode(arg, reader.pos, effects, path, values, depth);
      if (!outcome.ok) values.length = saved;
      if (outcome.ok) return outcome;
      if (best === undefined || outcome.error.start > best.error.start) best = { error: outcome.error, effects: outcome.effects };
    }
    if (best === undefined) throw new Error("at least one argument was tried");
    return { ok: false, ...best };
  }

  /** Continues after `node` has consumed the line up to `end`. */
  afterNode(node: NodeId, end: number, effects: Effect[], path: PathNode[], values: ArgValue[], depth: number): Outcome {
    const tree = this.data.tree;
    const n = tree.node(node);
    if (end >= this.src.length) {
      if (n.executable) return { ok: true, effects };
      const at = this.base + end;
      return { ok: false, error: new ParseError(at, at, "Unknown or incomplete command"), effects };
    }
    if (this.src[end] !== " ") {
      return { ok: false, error: this.errAt(end, "Expected whitespace to end one argument, but found trailing data"), effects };
    }
    const next = n.redirect ?? node;
    if (!hasChildren(tree.node(next))) return { ok: false, error: this.errAt(end + 1, "Incorrect argument for command"), effects };
    // A redirect to the root starts a new command; other redirects (execute
    // subcommands) keep the path so that arguments see their own literals.
    let result: Outcome;
    if (n.redirect === ROOT) {
      const outer = path.splice(0);
      const outerValues = values.splice(0);
      result = this.children(next, end + 1, path, values, depth + 1);
      path.length = 0;
      path.push(...outer);
      values.length = 0;
      values.push(...outerValues);
    } else {
      path.push({ name: nodeName(n), literal: n.kind.kind === "Literal" });
      result = this.children(next, end + 1, path, values, depth + 1);
      path.pop();
    }
    for (const e of result.effects) effects.push(e);
    return result.ok ? { ok: true, effects } : { ok: false, error: result.error, effects };
  }
}
