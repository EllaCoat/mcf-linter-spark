// A project: the data packs under one root, their files, the symbol index,
// and the checks that need the whole project (references and visibility).

import { type Dir, type Dirent, type Stats, lstatSync, opendirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { sep } from "node:path";

import { misreadId } from "./args/basic.ts";
import { registryRule } from "./args/index.ts";
import { compareStr } from "./chars.ts";
import type { Config } from "./config.ts";
import { type VersionData, loadVersionData } from "./data.ts";
import * as datajson from "./datajson.ts";
import { type Diagnostic, ParseError, type Severity } from "./diag.ts";
import { type Kind, type Ref, fullId, kind } from "./facts.ts";
import {
  type DefaultVisibility,
  PUBLIC_PATTERN,
  type Scope,
  type SiteVisibility,
  type Visibility,
  defaultVisibilityFromConfig,
  entryMatches,
  siteVisible,
  visibilityEquals,
} from "./impdoc.ts";
import { type Node, parseDocument } from "./json.ts";
import { FileFacts, type Link, analyze } from "./mcfunction.ts";

export type FileId = number;

export interface FileState {
  path: string;
  /** Path relative to the project root, with `/` separators. */
  rel: string;
  kind: Kind;
  id: string;
  text: string;
  facts: FileFacts;
  /** References from a function tag's `values`. */
  tagRefs: TagEntry[];
  /** Ids in a data pack JSON file, which only need to exist: IMP-Doc is not written in JSON. */
  jsonRefs: Ref[];
  /** True when `ignore` patterns exclude the file from reports. */
  ignored: boolean;
  /** True once the file has been deleted on disk. */
  removed: boolean;
}

export interface TagEntry {
  target: Ref;
  required: boolean;
}

export interface Site {
  file: FileId;
  visibility: SiteVisibility;
  doc: string | undefined;
  scope: Scope;
}

/** `(kind, id)` as `kind\0id`. No kind holds a NUL, so the first one splits it, and comparing
 * the strings by code point orders the pairs as the tuple does. */
type Key = string;

function keyOf(k: Kind, id: string): Key {
  return `${k}\0${id}`;
}

function keyKind(key: Key): Kind {
  return key.slice(0, key.indexOf("\0"));
}

function keyId(key: Key): string {
  return key.slice(key.indexOf("\0") + 1);
}

const NO_SITES: readonly Site[] = [];

export interface Options {
  /** Resource id patterns (DHP glob) whose files are analysed but not reported. */
  ignore: readonly string[];
  /** How many directory levels below the root are searched for data packs. */
  maxDepth: number;
}

/** The search depth of datapack-linter (DHP 3.x): the root and two levels below it. */
export const DEFAULT_MAX_DEPTH = 2;

/** The search depth when `--max-depth` is not given: DHP's, or no limit with a
 * `spyglass.json`, as the modified Spyglass finds every `pack.mcmeta`. */
export function defaultMaxDepth(config: Config): number {
  return config.spyglass ? Infinity : DEFAULT_MAX_DEPTH;
}

/** Paths are compared case-insensitively with `\` separators, as Windows does. */
function pathKey(p: string): string {
  return p.replaceAll("/", "\\").toLowerCase();
}

interface Entry {
  path: string;
  rel: string;
  kind: Kind;
  id: string;
  /** The listing says it is a regular file (not a link), so `readText` need not stat it. */
  regular: boolean;
}

export class Project {
  readonly root: string;
  readonly config: Config;
  readonly data: VersionData;
  /** Files by id. A deleted file keeps its slot with `removed` set. */
  readonly files: FileState[];
  /** What the user should know about how the project was read, for the CLI and the editor
   * to show once. */
  readonly notices: string[];
  private readonly packs: string[];
  private readonly defaultVisibility: DefaultVisibility;
  private readonly ignore: Visibility[];
  private readonly index = new Map<Key, Site[]>();
  /** Files with `attachedWrites` of a key, for `impDocVisibilityConflict`. */
  private readonly writes = new Map<Key, FileId[]>();
  /** How many files write a key (`FileFacts.written`; empty without a `spyglass.json`). */
  private readonly written = new Map<Key, number>();
  private readonly byPath: Map<string, FileId>;
  /** Which files reference a key; built only for incremental use (the editor). */
  private referrers: Map<Key, Set<FileId>> | undefined = undefined;

  private constructor(fields: {
    root: string;
    config: Config;
    data: VersionData;
    files: FileState[];
    notices: string[];
    packs: string[];
    defaultVisibility: DefaultVisibility;
    ignore: Visibility[];
    byPath: Map<string, FileId>;
  }) {
    this.root = fields.root;
    this.config = fields.config;
    this.data = fields.data;
    this.files = fields.files;
    this.notices = fields.notices;
    this.packs = fields.packs;
    this.defaultVisibility = fields.defaultVisibility;
    this.ignore = fields.ignore;
    this.byPath = fields.byPath;
  }

  /** Reads the project. Only the vanilla data of the version is awaited; the rest is synchronous. */
  static async load(root: string, config: Config, options: Options): Promise<Project> {
    const data = await loadVersionData(config.cmdVersion);
    const packs = discoverPacks(root, options.maxDepth);
    const entries: Entry[] = [];
    for (const pack of packs) collectFiles(root, pack, data, entries);
    const ignore: Visibility[] = options.ignore.map((p) => ({ kind: "*", pattern: p }));
    const defaultVisibility = defaultVisibilityFromConfig(config.defaultVisibility);
    const files: FileState[] = [];
    for (const { path, rel, kind: k, id, regular } of entries) {
      const ignored = ignore.some((v) => entryMatches(v, k, id));
      const text = k === kind.STRUCTURE ? "" : regular ? readFile(path) : readText(path);
      const f: FileState = { path, rel, kind: k, id, text, facts: new FileFacts(), tagRefs: [], jsonRefs: [], ignored, removed: false };
      analyzeFile(f, data, config);
      files.push(f);
    }
    const byPath = new Map<string, FileId>();
    for (let i = 0; i < files.length; i++) byPath.set(pathKey(files[i]!.path), i);
    const notices = config.versionSet() ? [] : unreadLayout(root, packs);
    const project = new Project({ root, config, data, files, notices, packs, defaultVisibility, ignore, byPath });
    for (let fid = 0; fid < files.length; fid++) {
      const f = files[fid]!;
      for (const [key, site] of sitesOf(fid, f)) {
        const v = project.index.get(key);
        if (v === undefined) project.index.set(key, [site]);
        else v.push(site);
      }
      for (const [key] of writesOf(fid, f)) {
        const v = project.writes.get(key);
        if (v === undefined) project.writes.set(key, [fid]);
        else if (v[v.length - 1] !== fid) v.push(fid);
      }
      for (const key of writtenOf(f)) project.written.set(key, (project.written.get(key) ?? 0) + 1);
    }
    return project;
  }

  /** Builds the reverse reference index that the incremental updates use. */
  enableIncremental(): void {
    const referrers = new Map<Key, Set<FileId>>();
    for (let fid = 0; fid < this.files.length; fid++) {
      for (const r of referenced(this.files[fid]!)) addToSet(referrers, keyOf(r.kind, r.id), fid);
    }
    this.referrers = referrers;
  }

  fileIdOf(path: string): FileId | undefined {
    const fid = this.byPath.get(pathKey(path));
    return fid !== undefined && !this.files[fid]!.removed ? fid : undefined;
  }

  filesUnder(dir: string): FileId[] {
    const prefix = `${pathKey(dir)}\\`;
    const out: FileId[] = [];
    for (const [key, fid] of this.byPath) {
      if (key.startsWith(prefix) && !this.files[fid]!.removed) out.push(fid);
    }
    return out.sort(byNumber);
  }

  /** Replaces a file's text and re-analyses it. Returns the files whose
   * diagnostics may have changed, including the file itself. */
  setText(fid: FileId, text: string): FileId[] {
    const before = this.detach(fid);
    const f = this.files[fid]!;
    const lines = countLines(f.text);
    f.text = text;
    analyzeFile(f, this.data, this.config);
    const after = this.attach(fid);
    const out = this.affected(fid, before, after);
    if (f.kind === kind.FUNCTION && countLines(f.text) !== lines) {
      const set = this.referrers?.get(keyOf(kind.FUNCTION, f.id));
      if (set !== undefined) {
        for (const x of set) {
          const g = this.files[x]!;
          if (!g.removed && g.facts.links.some((l) => l.target.id === f.id)) out.push(x);
        }
        return sortUnique(out);
      }
    }
    return out;
  }

  /** Adds a file created on disk. Returns its id and the affected files, or
   * `undefined` when the path is not a data pack file of this project. */
  addFile(path: string): [FileId, FileId[]] | undefined {
    const existing = this.fileIdOf(path);
    if (existing !== undefined) return [existing, this.setText(existing, readText(path))];
    const pack = this.packs.find((p) => pathStartsWith(path, joinPath(p, "data")));
    if (pack === undefined) return undefined;
    const inData = stripPrefix(path, joinPath(pack, "data"));
    if (inData === undefined) return undefined;
    const relInData = toSlash(inData);
    const slash = relInData.indexOf("/");
    if (slash < 0) return undefined;
    const ns = relInData.slice(0, slash);
    const classified = classify(relInData.slice(slash + 1), this.data);
    if (classified === undefined) return undefined;
    const [k, idPath] = classified;
    const id = `${ns}:${idPath}`;
    const rel = toSlash(stripPrefix(path, this.root) ?? path);
    const ignored = this.isIgnored(k, id);
    const text = k !== kind.STRUCTURE ? readText(path) : "";
    const f: FileState = { path, rel, kind: k, id, text, facts: new FileFacts(), tagRefs: [], jsonRefs: [], ignored, removed: false };
    analyzeFile(f, this.data, this.config);
    const fid = this.files.length;
    this.files.push(f);
    this.byPath.set(pathKey(path), fid);
    const after = this.attach(fid);
    return [fid, this.affected(fid, [], after)];
  }

  /** Removes a file deleted on disk. Returns the affected files. */
  removeFile(fid: FileId): FileId[] {
    const before = this.detach(fid);
    const f = this.files[fid]!;
    f.removed = true;
    f.facts = new FileFacts();
    f.tagRefs = [];
    f.jsonRefs = [];
    return this.affected(fid, before, []).filter((x) => x !== fid);
  }

  /** Removes a file's sites and references from the indexes. Returns its
   * sites and attached writes. */
  private detach(fid: FileId): [Key, Site][] {
    const f = this.files[fid]!;
    const sites = sitesOf(fid, f);
    for (const [key] of sites) {
      const v = this.index.get(key);
      if (v !== undefined) {
        retain(v, (s) => s.file !== fid);
        if (v.length === 0) this.index.delete(key);
      }
    }
    const writes = writesOf(fid, f);
    for (const [key] of writes) {
      const v = this.writes.get(key);
      if (v !== undefined) {
        retain(v, (x) => x !== fid);
        if (v.length === 0) this.writes.delete(key);
      }
    }
    for (const w of writes) sites.push(w);
    for (const key of writtenOf(f)) {
      const n = this.written.get(key);
      if (n !== undefined) {
        if (n - 1 === 0) this.written.delete(key);
        else this.written.set(key, n - 1);
      }
      sites.push([key, { file: fid, visibility: undefined, doc: undefined, scope: "Default" }]);
    }
    if (this.referrers !== undefined) {
      for (const r of referenced(f)) this.referrers.get(keyOf(r.kind, r.id))?.delete(fid);
    }
    return sites;
  }

  /** Adds a file's sites and references to the indexes. Returns its sites
   * and attached writes. */
  private attach(fid: FileId): [Key, Site][] {
    const f = this.files[fid]!;
    const sites = sitesOf(fid, f);
    for (const [key, site] of sites) {
      const v = this.index.get(key);
      if (v === undefined) this.index.set(key, [site]);
      else v.push(site);
    }
    const writes = writesOf(fid, f);
    for (const [key] of writes) {
      const v = this.writes.get(key);
      if (v === undefined) this.writes.set(key, [fid]);
      else if (!v.includes(fid)) v.push(fid);
    }
    for (const w of writes) sites.push(w);
    for (const key of writtenOf(f)) {
      this.written.set(key, (this.written.get(key) ?? 0) + 1);
      sites.push([key, { file: fid, visibility: undefined, doc: undefined, scope: "Default" }]);
    }
    if (this.referrers !== undefined) {
      for (const r of referenced(f)) addToSet(this.referrers, keyOf(r.kind, r.id), fid);
    }
    return sites;
  }

  /** The file itself plus the referrers of every key whose sites changed,
   * and, for `impDocVisibilityConflict`, the files declaring those keys. */
  private affected(fid: FileId, before: readonly [Key, Site][], after: readonly [Key, Site][]): FileId[] {
    const b = signature(before);
    const a = signature(after);
    const out = new Set<FileId>([fid]);
    if (!signaturesEqual(b, a)) {
      if (this.referrers !== undefined) {
        for (const list of [b, a]) {
          for (const { key } of list) {
            const set = this.referrers.get(key);
            if (set !== undefined) for (const x of set) out.add(x);
          }
        }
      }
      if (this.config.spyglassRule("impDocVisibilityConflict") !== undefined) {
        for (const list of [b, a]) {
          for (const { key } of list) {
            for (const s of this.index.get(key) ?? NO_SITES) out.add(s.file);
            for (const x of this.writes.get(key) ?? []) out.add(x);
          }
        }
      }
    }
    const result: FileId[] = [];
    for (const x of out) if (!this.files[x]!.removed) result.push(x);
    return result.sort(byNumber);
  }

  /** The reference or declaration covering an offset of a file, if any. */
  symbolAt(fid: FileId, offset: number): [Kind, string] | undefined {
    const f = this.files[fid]!;
    const covers = (r: { start: number; end: number }): boolean => r.start <= offset && offset <= r.end;
    for (const r of f.facts.refs) if (covers(r)) return [r.kind, r.id];
    for (const e of f.tagRefs) if (covers(e.target)) return [e.target.kind, e.target.id];
    for (const r of f.jsonRefs) if (covers(r)) return [r.kind, r.id];
    for (const l of f.facts.links) if (covers(l.target)) return [l.target.kind, l.target.id];
    for (const r of f.facts.written) if (covers(r)) return [r.kind, r.id];
    for (const d of f.facts.decls) if (covers(d)) return [d.kind, d.id];
    const doc = f.facts.functionDoc;
    if (doc !== undefined && covers(doc)) return [f.kind, f.id];
    return undefined;
  }

  /** Where a symbol is declared or defined: the declaration lines, and the doc comment (or
   * the start) of a file whose id is the symbol. */
  definitions(k: Kind, id: string): [FileId, number, number][] {
    const out: [FileId, number, number][] = [];
    for (const site of this.sites(k, id)) {
      const f = this.files[site.file]!;
      if (f.kind === k && f.id === id) {
        const doc = f.facts.functionDoc;
        out.push([site.file, doc?.start ?? 0, doc?.end ?? 0]);
      } else {
        for (const d of f.facts.decls) if (d.kind === k && d.id === id) out.push([site.file, d.start, d.end]);
      }
    }
    out.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    return out.filter((x, i) => i === 0 || x[0] !== out[i - 1]![0] || x[1] !== out[i - 1]![1] || x[2] !== out[i - 1]![2]);
  }

  isIgnored(k: Kind, id: string): boolean {
    return this.ignore.some((v) => entryMatches(v, k, id));
  }

  /** All diagnostics of one file: its own and those of its references. */
  diagnostics(fid: FileId): Diagnostic[] {
    const f = this.files[fid]!;
    const out = [...f.facts.diags];
    for (const r of f.facts.refs) {
      const d = this.checkRef(f, r);
      if (d !== undefined) out.push(d);
    }
    for (const e of f.tagRefs) {
      if (!(e.required || this.defined(e.target))) continue;
      const d = this.checkRef(f, e.target);
      if (d !== undefined) out.push(d);
    }
    for (const r of f.jsonRefs) {
      const d = this.checkJsonRef(r);
      if (d !== undefined) out.push(d);
    }
    for (const l of f.facts.links) {
      const d = this.checkLink(l);
      if (d !== undefined) out.push(d);
    }
    for (const d of this.spyglassImpDocRules(fid)) out.push(d);
    return out.sort((x, y) => x.start - y.start || x.end - y.end);
  }

  /** The IMP-Doc rules of the modified Spyglass, each enabled by its
   * `impDoc*` setting in `spyglass.json`. */
  private spyglassImpDocRules(fid: FileId): Diagnostic[] {
    const f = this.files[fid]!;
    const out: Diagnostic[] = [];
    if (this.config.spyglassImpDoc()) {
      for (const t of f.facts.withinModifiers) {
        const message = `Unknown @within modifier "${t.text}" is ignored`;
        out.push({ start: t.start, end: t.end, severity: "Warning", code: "impDocWithinModifier", message });
      }
    }
    const bare = this.config.spyglassRule("impDocBareDeclaration");
    if (bare !== undefined) {
      for (const d of f.facts.decls) {
        if (!(d.declared && d.visibility === undefined)) continue;
        const message = `Declaration of ${d.kind} “${d.id}” owns no IMP-Doc block, so no “@public” / “@private” / “@within” annotation applies to it and the symbol is declared public; move it under a “#>” block of its own to scope it`;
        out.push({ start: d.start, end: d.end, severity: bare, code: "impDocBareDeclaration", message });
      }
    }
    const bestEffort = this.config.spyglassRule("impDocPrivateBestEffort");
    if (bestEffort !== undefined) {
      for (const r of f.facts.macroRefs) {
        let message: string;
        if (r.kind === kind.FUNCTION && this.sites(r.kind, r.id).length === 0 && !this.vanillaHas(r.kind, r.id)) {
          message = `Function “${r.id}” is referenced in a macro line but is not declared anywhere`;
        } else if (!this.isVisible(f, r) && this.sites(r.kind, r.id).length !== 0) {
          const scope = this.restriction(r.kind, r.id) ?? "restricted";
          message = `Function “${r.id}” is ${scope} and cannot be called from “${f.id}” (referenced in a macro line)`;
        } else continue;
        out.push({ start: r.start, end: r.end, severity: bestEffort, code: "impDocPrivateBestEffort", message });
      }
    }
    const conflict = this.config.spyglassRule("impDocVisibilityConflict");
    if (conflict !== undefined) for (const d of this.visibilityConflicts(fid, conflict)) out.push(d);
    return out;
  }

  /** `impDocVisibilityConflict`: a symbol whose visibility sources mix public
   * and restricted ones, reported in the symbol's owner file once per pair. */
  private visibilityConflicts(fid: FileId, severity: Severity): Diagnostic[] {
    interface Source {
      file: FileId;
      start: number;
      end: number;
      public: boolean;
      header: boolean;
    }
    const isPublic = (v: readonly Visibility[]): boolean => v.length === 0 || v.some((e) => e.pattern === PUBLIC_PATTERN);
    const f = this.files[fid]!;
    const keys: Key[] = [];
    for (const d of f.facts.decls) if (d.declared || d.visibility !== undefined) keys.push(keyOf(d.kind, d.id));
    for (const d of f.facts.attachedWrites) if (d.declared || d.visibility !== undefined) keys.push(keyOf(d.kind, d.id));
    if (f.facts.functionDoc !== undefined) keys.push(keyOf(f.kind, f.id));
    keys.sort(compareStr);
    const out: Diagnostic[] = [];
    for (let ki = 0; ki < keys.length; ki++) {
      const key = keys[ki]!;
      if (ki > 0 && key === keys[ki - 1]) continue;
      const keyK = keyKind(key);
      const keyI = keyId(key);
      const siteFiles: FileId[] = [];
      for (const s of this.sites(keyK, keyI)) siteFiles.push(s.file);
      for (const x of this.writes.get(key) ?? []) siteFiles.push(x);
      sortUnique(siteFiles);
      let definition: FileId | undefined;
      let header: Source | undefined;
      const decls: Source[] = [];
      for (const sf of siteFiles) {
        const g = this.files[sf]!;
        if (keyK === kind.FUNCTION && g.kind === kind.FUNCTION && g.id === keyI) {
          definition = sf;
          if (g.facts.functionDoc !== undefined) {
            header = { file: sf, start: 0, end: 0, public: isPublic(g.facts.functionDoc.visibility), header: true };
          }
        }
        for (const list of [g.facts.decls, g.facts.attachedWrites]) {
          for (const d of list) {
            if (!(d.kind === keyK && d.id === keyI && (d.declared || d.visibility !== undefined))) continue;
            const pub = d.visibility === undefined || isPublic(d.visibility);
            decls.push({ file: sf, start: d.start, end: d.end, public: pub, header: false });
          }
        }
      }
      decls.sort((x, y) => compareStr(this.files[x.file]!.rel, this.files[y.file]!.rel) || x.start - y.start);
      const owner = definition ?? decls[0]?.file;
      if (owner !== fid) continue;
      let range: [number, number];
      if (definition !== undefined) range = [0, 0];
      else {
        const own = decls.find((s) => s.file === fid);
        if (own === undefined) continue;
        range = [own.start, own.end];
      }
      const sources: Source[] = header === undefined ? decls : [header, ...decls];
      for (let i = 0; i < sources.length; i++) {
        for (let j = i + 1; j < sources.length; j++) {
          const a = sources[i]!;
          const b = sources[j]!;
          if (a.public === b.public) continue;
          const place = b.header ? "the function header" : `“${this.files[b.file]!.rel}”`;
          const [here, there] = a.public ? ["public", "restricted"] : ["restricted", "public"];
          const message = `Visibility of “${keyI}” is contradictory: it is declared ${here} here but ${there} in ${place}, so the union makes it public everywhere`;
          out.push({ start: range[0], end: range[1], severity, code: "impDocVisibilityConflict", message });
        }
      }
    }
    return out;
  }

  /** Whether `r` resolves for `caller`. A symbol without sites that a
   * command writes is defined with no visibility (the modified Spyglass). */
  private isVisible(caller: FileState, r: Ref): boolean {
    if (this.vanillaHas(r.kind, r.id)) return true;
    const sites = this.sites(r.kind, r.id);
    if (sites.length === 0) return this.written.has(keyOf(r.kind, r.id));
    return sites.some((s) => this.siteVisibleTo(caller, s));
  }

  private defined(r: Ref): boolean {
    return this.vanillaHas(r.kind, r.id) || this.sites(r.kind, r.id).length !== 0 || this.written.has(keyOf(r.kind, r.id));
  }

  private siteVisibleTo(caller: FileState, s: Site): boolean {
    const def = this.files[s.file]!;
    return siteVisible(s.visibility, caller.kind, caller.id, this.defaultVisibility, [def.kind, def.id]);
  }

  /** The ids of a kind declared or defined in the project, whatever their visibility. */
  ids(k: Kind): string[] {
    const out: string[] = [];
    for (const key of this.index.keys()) if (keyKind(key) === k) out.push(keyId(key));
    return out.sort(compareStr);
  }

  /** The ids of a kind declared or defined in the project that file `caller` may
   * reference, by the visibility the diagnostics apply. Vanilla ids are not included. */
  visibleIds(caller: FileId, k: Kind): string[] {
    const c = this.files[caller]!;
    const out: string[] = [];
    for (const [key, sites] of this.index) {
      if (keyKind(key) === k && sites.some((s) => this.siteVisibleTo(c, s))) out.push(keyId(key));
    }
    for (const key of this.written.keys()) {
      if (keyKind(key) === k && !this.index.has(key)) out.push(keyId(key));
    }
    return out;
  }

  /** Diagnostics of every reported file. */
  allDiagnostics(): [FileId, Diagnostic[]][] {
    const out: [FileId, Diagnostic[]][] = [];
    for (let fid = 0; fid < this.files.length; fid++) {
      const f = this.files[fid]!;
      if (f.ignored || f.removed) continue;
      const d = this.diagnostics(fid);
      if (d.length !== 0) out.push([fid, d]);
    }
    return out;
  }

  sites(k: Kind, id: string): readonly Site[] {
    return this.index.get(keyOf(k, id)) ?? NO_SITES;
  }

  private checkRef(caller: FileState, r: Ref): Diagnostic | undefined {
    if (this.isVisible(caller, r)) return undefined;
    const unresolved = this.unresolvedSeverity(r.kind, r.id);
    if (unresolved === undefined) return undefined;
    const [severity, rule] = unresolved;
    if (this.config.spyglass) {
      const scope = this.restriction(r.kind, r.id);
      if (scope !== undefined) {
        const message =
          r.kind === kind.FUNCTION
            ? `Function “${r.id}” is ${scope} and cannot be called from “${caller.id}”`
            : `Symbol “${r.id}” in category “${r.kind}” is ${scope} and cannot be referenced from “${caller.id}”`;
        return { start: r.start, end: r.end, severity, code: "impDocPrivate", message };
      }
    }
    const advice = misreadId(r.kind, r.id, this.data);
    if (advice !== undefined) {
      const message = `Failed to resolve ${r.kind} '${r.id}': ${advice}`;
      return { start: r.start, end: r.end, severity: "Warning", code: rule ?? "unresolved", message };
    }
    const message = `Failed to resolve ${r.kind} '${r.id}'`;
    return { start: r.start, end: r.end, severity, code: rule ?? "unresolved", message };
  }

  /** How the modified Spyglass describes a restricted symbol
   * (`describeVisibilityScope`): by the first restricting site, the
   * definition before the declarations, and the file that owns its doc. */
  private restriction(k: Kind, id: string): string | undefined {
    let site: Site | undefined;
    let bestNotDefinition = false;
    let bestRel = "";
    for (const s of this.sites(k, id)) {
      if (s.scope !== "Within" && s.scope !== "Internal" && s.scope !== "Private") continue;
      const f = this.files[s.file]!;
      const notDefinition = !(f.kind === k && f.id === id);
      if (site === undefined || (notDefinition ? 1 : 0) < (bestNotDefinition ? 1 : 0) || (notDefinition === bestNotDefinition && compareStr(f.rel, bestRel) < 0)) {
        site = s;
        bestNotDefinition = notDefinition;
        bestRel = f.rel;
      }
    }
    if (site === undefined) return undefined;
    const owner = this.files[site.file]!.id;
    if (site.scope === "Private") return `private to “${owner}”`;
    if (site.scope === "Internal") return `internal to the namespace of “${owner}”`;
    return `restricted by “${owner}”`;
  }

  /** The severity of an unresolved reference, or `undefined` when it is not reported. */
  private unresolvedSeverity(k: Kind, id: string): [Severity, string | undefined] | undefined {
    let rule: string;
    switch (k) {
      case kind.FUNCTION:
        rule = "strictFunctionCheck";
        break;
      case kind.FUNCTION_TAG:
        rule = "strictFunctionTagCheck";
        break;
      case kind.ADVANCEMENT:
        rule = "strictAdvancementCheck";
        break;
      case kind.LOOT_TABLE:
        rule = "strictLootTableCheck";
        break;
      case kind.PREDICATE:
        rule = "strictPredicateCheck";
        break;
      case kind.RECIPE:
        rule = "strictRecipeCheck";
        break;
      case kind.BLOCK_TAG:
        rule = "strictBlockTagCheck";
        break;
      case kind.ENTITY_TYPE_TAG:
        rule = "strictEntityTypeTagCheck";
        break;
      case kind.FLUID_TAG:
        rule = "strictFluidTagCheck";
        break;
      case kind.ITEM_TAG:
        rule = "strictItemTagCheck";
        break;
      case kind.BOSSBAR:
        rule = "strictBossbarCheck";
        break;
      case kind.STORAGE:
        rule = "strictStorageCheck";
        break;
      case kind.SCORE_HOLDER:
        rule = "strictScoreHolderCheck";
        break;
      case kind.ENTITY_TAG:
        rule = "strictTagCheck";
        break;
      case kind.TEAM:
        rule = "strictTeamCheck";
        break;
      case kind.OBJECTIVE:
        // DHP reports unknown objectives as warnings whatever the setting says.
        return this.config.rule("strictObjectiveCheck") === undefined ? undefined : ["Warning", "strictObjectiveCheck"];
      default: {
        // Since 1.21 data packs define enchantments and the like, which the rule of the
        // registry still governs.
        const registry = k === "dimension_type" ? undefined : registryRule(`minecraft:${k}`);
        if (registry === undefined) return ["Hint", undefined];
        // As `ArgCtx.checkRegistry` treats ids outside `minecraft:`.
        if (!id.startsWith("minecraft:") && this.config.rule(registry)?.[1] === "only-default-namespace") {
          return this.config.spyglass ? undefined : ["Hint", registry];
        }
        rule = registry;
      }
    }
    const configured = this.config.rule(rule);
    return configured === undefined ? ["Hint", undefined] : [configured[0], rule];
  }

  private checkLink(link: Link): Diagnostic | undefined {
    const r = link.target;
    const fid = this.functionFile(r.id);
    let message: string;
    if (fid === undefined) message = `The link names no function: “${r.id}”`;
    else if (link.line !== undefined && link.line > Math.max(countLines(this.files[fid]!.text), 1)) message = `“${r.id}” has no line ${link.line}`;
    else return undefined;
    return { start: r.start, end: r.end, severity: "Information", code: "commentLink", message };
  }

  functionFile(id: string): FileId | undefined {
    return this.sites(kind.FUNCTION, id).find((s) => this.files[s.file]!.kind === kind.FUNCTION)?.file;
  }

  linkLineAt(fid: FileId, offset: number): [FileId, number] | undefined {
    const link = this.files[fid]!.facts.links.find((l) => l.target.start <= offset && offset <= l.target.end);
    if (link === undefined) return undefined;
    const target = this.functionFile(link.target.id);
    return target === undefined || link.line === undefined ? undefined : [target, link.line];
  }

  /** Every reference to a symbol in the project, as the file and the span. */
  references(k: Kind, id: string): [FileId, number, number][] {
    const out: [FileId, number, number][] = [];
    for (let fid = 0; fid < this.files.length; fid++) {
      const f = this.files[fid]!;
      if (f.removed) continue;
      for (const r of referenced(f)) if (r.kind === k && r.id === id) out.push([fid, r.start, r.end]);
      for (const r of f.facts.written) if (r.kind === k && r.id === id) out.push([fid, r.start, r.end]);
    }
    return out;
  }

  private checkJsonRef(r: Ref): Diagnostic | undefined {
    const key = keyOf(r.kind, r.id);
    if (this.data.vanillaJsonHas(r.kind, r.id) || this.index.has(key) || this.written.has(key)) return undefined;
    const unresolved = this.unresolvedSeverity(r.kind, r.id);
    if (unresolved === undefined) return undefined;
    const message = `Failed to resolve ${r.kind} '${r.id}'`;
    return { start: r.start, end: r.end, severity: unresolved[0], code: unresolved[1] ?? "unresolved", message };
  }

  private vanillaHas(k: Kind, id: string): boolean {
    return this.data.vanillaJsonHas(k, id);
  }
}

function analyzeFile(f: FileState, data: VersionData, config: Config): void {
  if (f.kind === kind.FUNCTION) {
    f.facts = analyze(f.text, f.id, data, config);
    return;
  }
  if (f.kind === kind.FUNCTION_TAG) f.tagRefs = functionTagRefs(f.text);
  f.facts = new FileFacts();
  f.jsonRefs = [];
  const schema = datajson.schema(f.kind, data.mcdoc);
  if (schema !== undefined) {
    const checked = datajson.check(f.text, datajson.reading(f.kind), schema, data.mcdoc, data);
    f.facts.diags = checked.diags;
    // A function tag's ids are its `tagRefs`, which IMP-Doc visibility applies to.
    if (f.kind !== kind.FUNCTION_TAG) f.jsonRefs = checked.refs;
  }
}

/** Every id a file references, for the reverse index. */
function* referenced(f: FileState): Generator<Ref> {
  yield* f.facts.refs;
  for (const e of f.tagRefs) yield e.target;
  yield* f.facts.macroRefs;
  yield* f.jsonRefs;
  for (const l of f.facts.links) yield l.target;
}

/** The text of a regular file, with invalid UTF-8 replaced by U+FFFD; empty for anything else. */
export function readText(path: string): string {
  return stat(path)?.isFile() === true ? readFile(path) : "";
}

function readFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** The declaration and definition sites a file contributes. */
function sitesOf(fid: FileId, f: FileState): [Key, Site][] {
  if (f.removed) return [];
  // A function file defines its id; a matching function doc gives that
  // definition its visibility. Other files define their id with no visibility.
  const doc = f.facts.functionDoc;
  const out: [Key, Site][] = [[keyOf(f.kind, f.id), { file: fid, visibility: doc?.visibility, doc: doc?.doc, scope: doc?.scope ?? "Default" }]];
  for (const d of f.facts.decls) out.push([keyOf(d.kind, d.id), { file: fid, visibility: d.visibility, doc: d.doc, scope: d.scope }]);
  return out;
}

function writtenOf(f: FileState): Key[] {
  const keys = f.facts.written.map((r) => keyOf(r.kind, r.id));
  keys.sort(compareStr);
  return keys.filter((key, i) => i === 0 || key !== keys[i - 1]);
}

function writesOf(fid: FileId, f: FileState): [Key, Site][] {
  return f.facts.attachedWrites.map((w) => [keyOf(w.kind, w.id), { file: fid, visibility: w.visibility, doc: undefined, scope: w.scope }]);
}

interface Signature {
  key: Key;
  visibility: SiteVisibility;
  scope: Scope;
}

function signature(v: readonly [Key, Site][]): Signature[] {
  const out = v.map(([key, site]) => ({ key, visibility: site.visibility, scope: site.scope }));
  return out.sort((x, y) => compareStr(x.key, y.key));
}

function signaturesEqual(a: readonly Signature[], b: readonly Signature[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => {
      const y = b[i]!;
      return x.key === y.key && x.scope === y.scope && visibilitiesEqual(x.visibility, y.visibility);
    })
  );
}

function visibilitiesEqual(a: SiteVisibility, b: SiteVisibility): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((v, i) => visibilityEquals(v, b[i]!));
}

/** References in a function tag: `values` entries as strings or `{"id": ...}`. */
export function functionTagRefs(text: string): TagEntry[] {
  const root = parseDocument(text, "Lenient");
  if (root instanceof ParseError) return [];
  const values = field(root, "values")?.json;
  if (values?.kind !== "Array") return [];
  const refs: TagEntry[] = [];
  for (const entry of values.items) {
    const value = entry.json.kind === "Object" ? field(entry, "id") : entry;
    const required = entry.json.kind === "Object" ? datajson.tagEntryRequired(entry) : true;
    if (value === undefined || value.json.kind !== "Str") continue;
    const raw = value.json.value;
    const quoted = text[value.start] === '"' || text[value.start] === "'";
    const start = quoted ? value.start + 1 : value.start;
    const end = quoted ? value.end - 1 : value.end;
    const [k, id]: [Kind, string] = raw.startsWith("#") ? [kind.FUNCTION_TAG, raw.slice(1)] : [kind.FUNCTION, raw];
    refs.push({ target: { kind: k, id: fullId(id), start, end }, required });
  }
  return refs;
}

/** The last member of an object with this name, as a repeated key overwrites the earlier ones. */
function field(node: Node, name: string): Node | undefined {
  if (node.json.kind !== "Object") return undefined;
  const members = node.json.fields;
  for (let i = members.length - 1; i >= 0; i--) if (members[i]![0] === name) return members[i]![1];
  return undefined;
}

/** Directories under `root` (the root itself and up to `maxDepth` levels
 * below) that contain a `data` directory and a `pack.mcmeta`. Hidden
 * directories and `node_modules` are skipped. */
export function discoverPacks(root: string, maxDepth: number): string[] {
  const packs: string[] = [];
  let level = [root];
  const seen = new Set<string>();
  const rootReal = canonicalize(root);
  if (rootReal !== undefined) seen.add(rootReal);
  for (let depth = 0; depth <= maxDepth; depth++) {
    if (level.length === 0) break;
    const next: string[] = [];
    for (const dir of level) {
      if (stat(joinPath(dir, "pack.mcmeta"))?.isFile() === true && stat(joinPath(dir, "data"))?.isDirectory() === true) {
        packs.push(dir);
        continue;
      }
      if (depth < maxDepth) {
        for (const e of readDir(dir) ?? []) {
          const p = joinPath(dir, e.name);
          if (e.name.startsWith(".") || e.name === "node_modules" || stat(p)?.isDirectory() !== true) continue;
          const real = canonicalize(p);
          if (real === undefined) next.push(p);
          else if (!seen.has(real)) {
            seen.add(real);
            next.push(p);
          }
        }
      }
    }
    level = next;
  }
  return packs.sort(comparePaths);
}

/** The directories renamed in 1.21: the name before, the one since, the kind, and the file
 * extension. */
const RENAMED_DIRS: readonly (readonly [string, string, Kind, string])[] = [
  ["functions/", "function/", kind.FUNCTION, ".mcfunction"],
  ["tags/functions/", "tags/function/", kind.FUNCTION_TAG, ".json"],
  ["tags/blocks/", "tags/block/", kind.BLOCK_TAG, ".json"],
  ["tags/items/", "tags/item/", kind.ITEM_TAG, ".json"],
  ["tags/entity_types/", "tags/entity_type/", kind.ENTITY_TYPE_TAG, ".json"],
  ["tags/fluids/", "tags/fluid/", kind.FLUID_TAG, ".json"],
  ["tags/game_events/", "tags/game_event/", "tag/game_event", ".json"],
  ["advancements/", "advancement/", kind.ADVANCEMENT, ".json"],
  ["loot_tables/", "loot_table/", kind.LOOT_TABLE, ".json"],
  ["predicates/", "predicate/", kind.PREDICATE, ".json"],
  ["recipes/", "recipe/", kind.RECIPE, ".json"],
  ["item_modifiers/", "item_modifier/", kind.ITEM_MODIFIER, ".json"],
  ["structures/", "structure/", kind.STRUCTURE, ".nbt"],
];

const RENAMED_KINDS: ReadonlySet<Kind> = new Set(RENAMED_DIRS.map((d) => d[2]));

/** The kind and the id-relative path of a file under `data/<ns>/`, as the version names the
 * directories. */
export function classify(relInNs: string, data: VersionData): [Kind, string] | undefined {
  const singular = singularDirs(data);
  for (const [plural, single, k, ext] of RENAMED_DIRS) {
    const dir = singular ? single : plural;
    if (relInNs.startsWith(dir)) {
      const rest = relInNs.slice(dir.length);
      return rest.endsWith(ext) ? [k, rest.slice(0, rest.length - ext.length)] : undefined;
    }
  }
  // The other kinds are named by their registry, which may have several parts
  // (`worldgen/biome`): the longest leading part of the path that names one.
  const tag = relInNs.startsWith("tags/");
  const rest = tag ? relInNs.slice("tags/".length) : relInNs;
  let found: [Kind, string] | undefined;
  for (let i = rest.indexOf("/"); i >= 0; i = rest.indexOf("/", i + 1)) {
    const name = rest.slice(0, i);
    let k: Kind | undefined;
    if (tag) k = data.fileKind(`tag/${name}`);
    else {
      k = data.fileKind(name);
      if (k !== undefined && k.startsWith("tag/")) k = undefined;
    }
    if (k !== undefined && !RENAMED_KINDS.has(k)) found = [k, rest.slice(i + 1)];
  }
  if (found === undefined) return undefined;
  const [k, file] = found;
  return file.endsWith(".json") ? [k, file.slice(0, file.length - ".json".length)] : undefined;
}

/** Whether the version names its data pack directories in the singular (1.21 and later). */
function singularDirs(data: VersionData): boolean {
  return data.atLeast([1, 21]);
}

/** A notice for a pack laid out for 1.21 and later when no setting names the version, as the
 * default 1.20.4 does not read those directories. */
function unreadLayout(root: string, packs: readonly string[]): string[] {
  let dir: string | undefined;
  search: for (const pack of packs) {
    const dataDir = joinPath(pack, "data");
    const namespaces = readDir(dataDir);
    if (namespaces === undefined) continue;
    for (const ns of namespaces) {
      for (const [, single] of RENAMED_DIRS) {
        const d = joinPath(joinPath(dataDir, ns.name), single);
        if (stat(d)?.isDirectory() === true) {
          dir = d;
          break search;
        }
      }
    }
  }
  if (dir === undefined) return [];
  const rel = toSlash(stripPrefix(dir, root) ?? dir).replace(/\/+$/, "");
  return [
    `${rel}/ is laid out for 1.21 and later, but no version is set, so the pack is read as 1.20.4 and the files under it are skipped. Set the version with datapack.env.cmdVersion in .vscode/settings.json or env.gameVersion in spyglass.json.`,
  ];
}

function collectFiles(root: string, pack: string, data: VersionData, out: Entry[]): void {
  const dataDir = joinPath(pack, "data");
  const namespaces = readDir(dataDir);
  if (namespaces === undefined) return;
  for (const ns of namespaces) {
    const nsRoot = joinPath(dataDir, ns.name);
    if (stat(nsRoot)?.isDirectory() !== true) continue;
    // What `strip_prefix(root)` of a file under it gives, up to the file's path in the namespace.
    const nsRel = toSlash(stripPrefix(nsRoot, root) ?? nsRoot);
    const stack: { dir: string; rel: string }[] = [{ dir: nsRoot, rel: "" }];
    for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
      const rd = readDir(top.dir);
      if (rd === undefined) continue;
      for (const e of rd) {
        const name = toSlash(e.name);
        const relInNs = top.rel === "" ? name : `${top.rel}/${name}`;
        if (isRealDirectory(e, top.dir)) {
          stack.push({ dir: joinPath(top.dir, e.name), rel: relInNs });
          continue;
        }
        const classified = classify(relInNs, data);
        if (classified === undefined) continue;
        out.push({ path: joinPath(top.dir, e.name), rel: `${nsRel}/${relInNs}`, kind: classified[0], id: `${ns.name}:${classified[1]}`, regular: e.isFile() });
      }
    }
  }
}

function toSlash(p: string): string {
  return p.replaceAll("\\", "/");
}

// What Rust's `Path` does and `node:path` does not: components compare, not strings. Joining
// appends without normalising, so `./a` stays `./a`.

const WINDOWS = sep === "\\";

function isSeparator(c: string): boolean {
  return c === "/" || (WINDOWS && c === "\\");
}

interface PathParts {
  /** `C:` (the letter in upper case) or `\\server\share`; empty without one. */
  prefix: string;
  root: boolean;
  /** `.` only first, as `Path::components` keeps it; `..` stays. */
  names: string[];
  starts: number[];
  ends: number[];
}

const UNC_PREFIX = /^\\\\([^\\/]+)[\\/]([^\\/]+)/;

// ponytail: verbatim (`\\?\`) and device (`\\.\`) prefixes are read as ordinary paths
function parsePath(p: string): PathParts {
  let prefix = "";
  let i = 0;
  if (WINDOWS) {
    const unc = UNC_PREFIX.exec(p);
    if (unc !== null) {
      prefix = `\\\\${unc[1]}\\${unc[2]}`;
      i = unc[0].length;
    } else if (/^[A-Za-z]:/.test(p)) {
      prefix = p.slice(0, 2).toUpperCase();
      i = 2;
    }
  }
  const root = (i < p.length && isSeparator(p[i]!)) || prefix.startsWith("\\\\");
  const names: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let start = i;
  for (let j = i; j <= p.length; j++) {
    if (j < p.length && !isSeparator(p[j]!)) continue;
    if (j > start) {
      const name = p.slice(start, j);
      if (name !== "." || (names.length === 0 && prefix === "" && !root)) {
        names.push(name);
        starts.push(start);
        ends.push(j);
      }
    }
    start = j + 1;
  }
  return { prefix, root, names, starts, ends };
}

/** `Path::starts_with`: whole components, case-sensitive except for a drive letter. */
export function pathStartsWith(path: string, base: string): boolean {
  return startsWithParts(parsePath(path), parsePath(base));
}

function startsWithParts(a: PathParts, b: PathParts): boolean {
  return a.prefix === b.prefix && a.root === b.root && b.names.length <= a.names.length && b.names.every((n, i) => a.names[i] === n);
}

/** `Path::strip_prefix`: the rest of `path` after the components of `base`, with its own
 * separators, or `undefined` when `base` is not a prefix. */
export function stripPrefix(path: string, base: string): string | undefined {
  const a = parsePath(path);
  const b = parsePath(base);
  if (!startsWithParts(a, b)) return undefined;
  const n = b.names.length;
  return n === a.names.length ? "" : path.slice(a.starts[n]!, a.ends[a.ends.length - 1]!);
}

/** `Path::join` of a relative name. */
export function joinPath(base: string, name: string): string {
  if (base === "") return name;
  if (isSeparator(base[base.length - 1]!) || (WINDOWS && /^[A-Za-z]:$/.test(base))) return base + name;
  return base + sep + name;
}

/** `Path::cmp`: component by component, a path that is a prefix of another first. */
export function comparePaths(a: string, b: string): number {
  const x = componentKeys(parsePath(a));
  const y = componentKeys(parsePath(b));
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const c = compareStr(x[i]!, y[i]!);
    if (c !== 0) return c;
  }
  return x.length - y.length;
}

/** `Path == Path`: the same components. */
export function pathEquals(a: string, b: string): boolean {
  return comparePaths(a, b) === 0;
}

/** The components in `Component`'s order: prefix, root, `.`, `..`, then names. */
function componentKeys(parts: PathParts): string[] {
  const keys: string[] = [];
  if (parts.prefix !== "") keys.push(`0${parts.prefix}`);
  if (parts.root) keys.push("1");
  for (const n of parts.names) keys.push(n === "." ? "2" : n === ".." ? "3" : `4${n}`);
  return keys;
}

// File system reads that fail as Rust's do: a path that cannot be read is absent.

function stat(path: string): Stats | undefined {
  try {
    return statSync(path, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

function canonicalize(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

/** The entries of a directory in the order the file system lists them, as `read_dir` does.
 * `readdirSync` is about twice as fast but does not promise that order. */
function readDir(dir: string): Dirent[] | undefined {
  let d: Dir;
  try {
    d = opendirSync(dir);
  } catch {
    return undefined;
  }
  const out: Dirent[] = [];
  try {
    for (let e = d.readSync(); e !== null; e = d.readSync()) out.push(e);
  } catch {
    // an entry that cannot be read ends the listing
  } finally {
    d.closeSync();
  }
  return out;
}

/** `DirEntry::file_type().is_dir()`: a symlink to a directory is not one. */
function isRealDirectory(e: Dirent, dir: string): boolean {
  if (e.isDirectory()) return true;
  if (e.isFile() || e.isSymbolicLink()) return false;
  // The listing gave no type for this entry.
  try {
    return lstatSync(joinPath(dir, e.name), { throwIfNoEntry: false })?.isDirectory() === true;
  } catch {
    return false;
  }
}

/** `str::lines().count()`. */
function countLines(text: string): number {
  let n = 0;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) n++;
  return text.length > 0 && !text.endsWith("\n") ? n + 1 : n;
}

function byNumber(a: number, b: number): number {
  return a - b;
}

/** Sorts ascending and drops repeats, in place. */
function sortUnique(v: number[]): number[] {
  v.sort(byNumber);
  let w = 0;
  for (let r = 0; r < v.length; r++) if (r === 0 || v[r] !== v[r - 1]) v[w++] = v[r]!;
  v.length = w;
  return v;
}

function retain<T>(v: T[], keep: (x: T) => boolean): void {
  let w = 0;
  for (let r = 0; r < v.length; r++) if (keep(v[r]!)) v[w++] = v[r]!;
  v.length = w;
}

function addToSet(map: Map<Key, Set<FileId>>, key: Key, fid: FileId): void {
  const set = map.get(key);
  if (set === undefined) map.set(key, new Set([fid]));
  else set.add(fid);
}
