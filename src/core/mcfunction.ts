// Analysis of one `.mcfunction` file: commands, comments, macro lines, IMP-Doc.

import { isAsciiAlphanumeric } from "./chars.ts";
import { parseCommand } from "./command.ts";
import type { Config } from "./config.ts";
import type { VersionData } from "./data.ts";
import { type Diagnostic, ParseError, type Severity } from "./diag.ts";
import { type Kind, type Ref, fullId, kind } from "./facts.ts";
import { DocComment, type Scope, type SiteVisibility, type Token, type Visibility, declarableType, isNamespacedType } from "./impdoc.ts";
import { parseU32 } from "./numbers.ts";
import { Reader } from "./reader.ts";

/** A declaration (`#declare`) or definition (`scoreboard objectives add`, a
 * function file) site. */
export interface Decl {
  kind: Kind;
  id: string;
  start: number;
  end: number;
  visibility: SiteVisibility;
  doc: string | undefined;
  /** True for `#declare` / `#define`; false for a definition by a command. */
  declared: boolean;
  scope: Scope;
}

/** `#alias <entity|uuid|vector> <name> <value>`: DHP's `alias/<type>` cache entry,
 * defined at the name with the attached doc's visibility. */
export interface Alias {
  /** `alias/entity`, `alias/uuid` or `alias/vector`. */
  kind: Kind;
  name: string;
  value: string;
  start: number;
  end: number;
  visibility: SiteVisibility;
}

/** The `#> <id>` doc comment at the top of a function file whose id matches the file. */
export interface FunctionDoc {
  visibility: Visibility[];
  scope: Scope;
  doc: string;
  start: number;
  end: number;
}

export class FileFacts {
  diags: Diagnostic[] = [];
  refs: Ref[] = [];
  decls: Decl[] = [];
  aliases: Alias[] = [];
  functionDoc: FunctionDoc | undefined = undefined;
  /** `function <id>` written in macro lines, which the game parses only when run. */
  macroRefs: Ref[] = [];
  /** Modifiers such as `@readonly` after `@within` (dropped when the
   * modified Spyglass's IMP-Doc rules are enabled). */
  withinModifiers: Token[] = [];
  /** `Write` references attached to a doc block, which the modified
   * Spyglass counts as declarations with the block's visibility. Collected
   * only when its IMP-Doc rules are enabled; DHP resolution ignores them. */
  attachedWrites: Decl[] = [];
  /** With a `spyglass.json`, the `Write` references. The modified
   * Spyglass binds them as definitions: they define their symbol and are not
   * checked as references. Without one they are in `refs`. */
  written: Ref[] = [];
  /** Links in comments to a function and maybe a line of it. */
  links: Link[] = [];
}

/** `[text](namespace:path#L12)` in a comment: the target is a function, the line 1-based. */
export interface Link {
  /** The function, spanning the target inside the parentheses. */
  target: Ref;
  line: number | undefined;
}

const LINK_NAMESPACE = /^[a-z0-9_.-]*$/;
const LINK_PATH = /^[a-z0-9_.\-/]*$/;

/** The Markdown links to functions in `text`: the span of each target inside the
 * parentheses, the function id, and the line. URLs and other targets are not links here. */
export function commentLinks(text: string): [number, number, string, number | undefined][] {
  const out: [number, number, string, number | undefined][] = [];
  let from = 0;
  for (let k = text.indexOf("](", from); k >= 0; k = text.indexOf("](", from)) {
    const open = k + 2;
    from = open;
    if (!text.slice(0, open - 2).includes("[")) continue;
    const close = text.indexOf(")", open);
    if (close < 0) break;
    const target = text.slice(open, close);
    let id = target;
    let line: number | undefined;
    const hash = target.indexOf("#L");
    if (hash >= 0) {
      const n = parseU32(target.slice(hash + 2));
      if (n === undefined || n === 0) continue;
      id = target.slice(0, hash);
      line = n;
    }
    const colon = id.indexOf(":");
    if (colon < 0) continue;
    const ns = id.slice(0, colon);
    const path = id.slice(colon + 1);
    if (ns !== "" && !path.includes("//") && LINK_NAMESPACE.test(ns) && LINK_PATH.test(path)) out.push([open, close, id, line]);
    from = close;
  }
  return out;
}

interface Attached {
  vis: Visibility[];
  doc: string;
  scope: Scope;
}

interface Line {
  start: number;
  text: string;
  /** Whether a line break follows the line in the file. */
  eol: boolean;
}

/** Leading spaces and tabs. */
function indent(line: Line): number {
  let i = 0;
  while (i < line.text.length && (line.text[i] === " " || line.text[i] === "\t")) i++;
  return i;
}

/** The number of spaces and tabs at the start of `s` from `from`. */
function blank(s: string, from: number): number {
  let i = from;
  while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  return i - from;
}

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", start)) {
    const end = i > start && text[i - 1] === "\r" ? i - 1 : i;
    lines.push({ start, text: text.slice(start, end), eol: true });
    start = i + 1;
  }
  if (start < text.length) {
    const t = text.slice(start);
    lines.push({ start, text: t.endsWith("\r") ? t.slice(0, -1) : t, eol: false });
  }
  return lines;
}

export function analyze(text: string, fileId: string, data: VersionData, config: Config): FileFacts {
  const lines = splitLines(text);
  const a = new Analyzer(data, config, fileId);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const content = line.text.slice(indent(line));
    if (content.startsWith("#>")) {
      // A function doc only when nothing but spaces or tabs precede it in the file.
      const isFunctionDoc = i === 0;
      const [doc, next, indentBeforeLastHash] = parseDoc(lines, i, isFunctionDoc);
      if (isFunctionDoc) {
        a.functionDoc(lines[i]!, doc);
        i = next;
        continue;
      }
      const [vis, errors, modifiers] = doc.visibility(fileId, config.spyglassImpDoc(), data);
      for (const [s, e, m] of errors) a.diag(s, e, "Error", "impDoc", m);
      a.facts.withinModifiers.push(...modifiers);
      const attached: Attached = { vis, doc: doc.display(), scope: doc.scope() };
      let j = next;
      if (j < lines.length) {
        a.line(lines[j]!, attached);
        if (indent(lines[j]!) > indentBeforeLastHash) {
          j += 1;
          while (j < lines.length && indent(lines[j]!) > indentBeforeLastHash) {
            a.line(lines[j]!, attached);
            j += 1;
          }
          j -= 1;
        }
        j += 1;
      }
      i = j;
      continue;
    }
    a.line(line, undefined);
    i += 1;
  }
  for (const line of lines) {
    const ws = indent(line);
    if (line.text.startsWith("#", ws)) {
      for (const [s, e, id, at] of commentLinks(line.text.slice(ws))) {
        a.facts.links.push({ target: { kind: kind.FUNCTION, id, start: line.start + ws + s, end: line.start + ws + e }, line: at });
      }
    }
  }
  return a.facts;
}

/** Parses the doc block starting at `lines[i]`. Returns the doc, the index of the
 * first line after the block, and the indentation of the last `#` line. */
function parseDoc(lines: readonly Line[], i: number, isFunctionDoc: boolean): [DocComment, number, number] {
  const doc = new DocComment();
  if (!isFunctionDoc) {
    const first = lines[i]!;
    const from = indent(first) + 2;
    doc.plainText += `${first.text.slice(from + blank(first.text, from))}\n`;
  }
  let indentBeforeLastHash = 0;
  let j = i + 1;
  while (j < lines.length) {
    const line = lines[j]!;
    const ws = indent(line);
    const rest = line.text.slice(ws);
    // DHP's `isWhiteSpace` counts line breaks, so a bare `#` line continues the doc.
    const second = rest[1];
    const continues = second === undefined ? line.eol : second === " " || second === "\t" || second === "@";
    if (!(rest[0] === "#" && continues)) break;
    indentBeforeLastHash = ws;
    const afterHash = ws + 1;
    const contentStart = afterHash + blank(line.text, afterHash);
    if (line.text[contentStart] === "@") {
      const box = { li: j };
      const annos: Anno[] = [];
      parseAnnotation(lines, box, contentStart, contentStart - afterHash, annos, 0);
      j = box.li;
      for (const anno of annos) flatten(anno, [], doc.annotations);
    } else {
      doc.plainText += `${line.text.slice(contentStart)}\n`;
    }
    j += 1;
  }
  return [doc, j, indentBeforeLastHash];
}

interface Anno {
  value: Token;
  children: Anno[];
}

const MAX_ANNOTATION_DEPTH = 64;

/** DHP's `parseAnnotations`: a value, then either more values on the same line
 * (children) or child lines indented by at least two more spaces. */
function parseAnnotation(lines: readonly Line[], li: { li: number }, pos: number, indentWidth: number, out: Anno[], depth: number): void {
  const line = lines[li.li]!;
  const space = line.text.indexOf(" ", pos);
  const end = space < 0 ? line.text.length : space;
  const anno: Anno = { value: { text: line.text.slice(pos, end), start: line.start + pos, end: line.start + end }, children: [] };
  if (depth >= MAX_ANNOTATION_DEPTH) {
    out.push(anno);
    return;
  }
  if (line.text[end] === " ") {
    parseAnnotation(lines, li, end + blank(line.text, end), indentWidth, anno.children, depth + 1);
  } else {
    while (li.li + 1 < lines.length) {
      const nextLine = lines[li.li + 1]!;
      const ws = indent(nextLine);
      if (nextLine.text[ws] !== "#") break;
      const indentStart = ws + 1;
      const indentEnd = indentStart + blank(nextLine.text, indentStart);
      const extra = indentStart + indentWidth < indentEnd ? nextLine.text.slice(indentStart + indentWidth, indentEnd) : "";
      let width = 0;
      for (const c of extra) width += c === "\t" ? 2 : 1;
      if (width < 2) break;
      li.li += 1;
      parseAnnotation(lines, li, indentEnd, indentEnd - indentStart, anno.children, depth + 1);
    }
  }
  out.push(anno);
}

function flatten(anno: Anno, prefix: Token[], out: Token[][]): void {
  prefix.push({ ...anno.value });
  if (anno.children.length === 0) out.push([...prefix]);
  else for (const c of anno.children) flatten(c, prefix, out);
  prefix.pop();
}

// Rust's `\b` is a Unicode word boundary; JS's is ASCII, so the boundary is spelled out.
const MACRO_FUNCTION = /(?<![\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}])function[\t ]+(#?[A-Za-z0-9_.\-]+:[A-Za-z0-9_.\-/]+|#?[A-Za-z0-9_.\-/]+)/dgu;

class Analyzer {
  readonly facts = new FileFacts();
  readonly data: VersionData;
  readonly config: Config;
  readonly fileId: string;

  constructor(data: VersionData, config: Config, fileId: string) {
    this.data = data;
    this.config = config;
    this.fileId = fileId;
  }

  diag(start: number, end: number, severity: Severity, code: string, message: string): void {
    this.facts.diags.push({ start, end, severity, code, message });
  }

  functionDoc(line: Line, doc: DocComment): void {
    const ws = indent(line);
    const after = ws + 2 + blank(line.text, ws + 2);
    let end = line.text.length;
    for (let k = after; k < line.text.length; k++) {
      if (line.text[k] === " " || line.text[k] === "\t") {
        end = k;
        break;
      }
    }
    const id = line.text.slice(after, end);
    if (id === "" || fullId(id) !== this.fileId) return;
    const [vis, errors, modifiers] = doc.visibility(this.fileId, this.config.spyglassImpDoc(), this.data);
    for (const [s, e, m] of errors) this.diag(s, e, "Error", "impDoc", m);
    this.facts.withinModifiers.push(...modifiers);
    this.facts.functionDoc = { visibility: vis, scope: doc.scope(), doc: doc.display(), start: line.start + after, end: line.start + end };
  }

  /** One line outside a doc block, or a command attached to a doc block. */
  line(line: Line, attached: Attached | undefined): void {
    const ws = indent(line);
    let content = line.text.slice(ws);
    let trimmed = content.length;
    while (trimmed > 0 && (content[trimmed - 1] === " " || content[trimmed - 1] === "\t")) trimmed--;
    content = content.slice(0, trimmed);
    if (content === "") return;
    const base = line.start + ws;
    const declared = stripKeyword(content, "#declare") ?? stripKeyword(content, "#define");
    if (declared !== undefined) {
      this.declaration(declared, base + content.length - declared.length, attached);
      return;
    }
    const aliased = stripKeyword(content, "#alias");
    if (aliased !== undefined) {
      this.alias(aliased, base + content.length - aliased.length, attached);
      return;
    }
    if (content.startsWith("#")) return;
    if (content.startsWith("$")) {
      this.macroLine(content.slice(1), base + 1);
      return;
    }
    const result = parseCommand(content, base, this.data, this.config);
    if (result.error !== undefined) this.diag(result.error.start, result.error.end, result.error.severity, "syntax", result.error.message);
    for (const effect of result.effects) {
      switch (effect.kind) {
        case "Diag":
          this.facts.diags.push(effect.diag);
          break;
        case "Ref":
          this.facts.refs.push(effect.ref);
          break;
        case "Write": {
          const r = effect.ref;
          if (attached !== undefined && this.config.spyglassImpDoc()) {
            this.facts.attachedWrites.push({ kind: r.kind, id: r.id, start: r.start, end: r.end, visibility: attached.vis, doc: attached.doc, declared: false, scope: attached.scope });
          }
          if (this.config.spyglass) this.facts.written.push(r);
          else this.facts.refs.push(r);
          break;
        }
        case "Def": {
          const d = effect.def;
          this.facts.decls.push({
            kind: d.kind,
            id: d.id,
            start: d.start,
            end: d.end,
            visibility: attached?.vis,
            doc: attached?.doc,
            declared: false,
            scope: attached?.scope ?? "Default",
          });
          break;
        }
      }
    }
  }

  /** `#declare <type> <id> [description]`; `rest` starts after the keyword.
   * A malformed one is a plain comment, as DHP's `CommandParser` turns a `#`
   * line that fails to parse into a comment without reporting the errors. */
  declaration(restWithSpace: string, restBase: number, attached: Attached | undefined): void {
    if (!restWithSpace.startsWith(" ")) return;
    const rest = restWithSpace.slice(1);
    const space = rest.indexOf(" ");
    const typeEnd = space < 0 ? rest.length : space;
    const k = declarableType(rest.slice(0, typeEnd), this.data);
    if (k === undefined) return;
    const afterType = rest.slice(typeEnd);
    const idStart = restBase + 1 + typeEnd + 1;
    let id = "";
    if (afterType.startsWith(" ")) {
      const s = afterType.slice(1);
      const sp = s.indexOf(" ");
      id = sp < 0 ? s : s.slice(0, sp);
    }
    if (id === "") return;
    this.facts.decls.push({
      kind: k,
      id: isNamespacedType(k) ? fullId(id) : id,
      start: idStart,
      end: idStart + id.length,
      visibility: attached?.vis,
      doc: attached?.doc,
      declared: true,
      scope: attached?.scope ?? "Default",
    });
  }

  /** `#alias <entity|uuid|vector> <name> <value>`; `rest` starts after the keyword.
   * The name is a Brigadier string and the value the rest of the line. A
   * malformed one is a plain comment, as DHP does with a `#` line that fails to parse. */
  alias(restWithSpace: string, restBase: number, attached: Attached | undefined): void {
    if (!restWithSpace.startsWith(" ")) return;
    const rest = restWithSpace.slice(1);
    const space = rest.indexOf(" ");
    if (space < 0) return;
    const ty = rest.slice(0, space);
    const afterType = rest.slice(space + 1);
    const k = ty === "entity" ? "alias/entity" : ty === "uuid" ? "alias/uuid" : ty === "vector" ? "alias/vector" : undefined;
    if (k === undefined) return;
    const nameBase = restBase + 1 + ty.length + 1;
    const r = new Reader(afterType, nameBase);
    const s = r.readString();
    if (s instanceof ParseError) return;
    const [name] = s;
    if (name === "") return;
    const end = r.offset();
    const after = r.rest();
    if (!after.startsWith(" ") || after.length === 1) return;
    this.facts.aliases.push({ kind: k, name, value: after.slice(1), start: nameBase, end, visibility: attached?.vis });
  }

  /** Checks `$(name)` like `StringTemplate.fromString`. */
  macroLine(body: string, base: number): void {
    let count = 0;
    let pos = 0;
    for (let open = body.indexOf("$(", pos); open >= 0; open = body.indexOf("$(", pos)) {
      const close = body.indexOf(")", open + 2);
      if (close < 0) {
        this.diag(base + open, base + body.length, "Error", "macro", "Unterminated macro variable");
        return;
      }
      const name = body.slice(open + 2, close);
      if (name === "" || ![...name].every((c) => isAsciiAlphanumeric(c) || c === "_")) {
        this.diag(base + open, base + close + 1, "Error", "macro", `Invalid macro variable name '${name}'`);
      }
      count += 1;
      pos = close + 1;
    }
    if (count === 0) this.diag(base - 1, base + body.length, "Error", "macro", "Macro line without variables");
    this.macroFunctionRefs(body, base);
  }

  /** `function <id>` in a macro line, as the modified Spyglass finds them:
   * ids that continue with `$(` are built at run time and skipped. */
  macroFunctionRefs(body: string, base: number): void {
    for (const m of body.matchAll(MACRO_FUNCTION)) {
      const [start, end] = m.indices![1]!;
      let k = end;
      while (k < body.length && (isAsciiAlphanumeric(body[k]!) || "_./:-".includes(body[k]!))) k++;
      if (body.startsWith("$(", k)) continue;
      const text = m[1]!;
      const [refKind, id] = text.startsWith("#") ? [kind.FUNCTION_TAG, text.slice(1)] : [kind.FUNCTION, text];
      this.facts.macroRefs.push({ kind: refKind, id: fullId(id), start: base + start, end: base + end });
    }
  }
}

function stripKeyword(content: string, kw: string): string | undefined {
  if (!content.startsWith(kw)) return undefined;
  const rest = content.slice(kw.length);
  return rest === "" || rest.startsWith(" ") ? rest : undefined;
}
