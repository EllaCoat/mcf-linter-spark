// The language server: diagnostics for the workspace, IMP-Doc hovers, completion, definitions,
// references, and the links in comments.

import { statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type CompletionItem,
  CompletionItemKind,
  type CompletionList,
  type Connection,
  type Diagnostic,
  DiagnosticSeverity,
  type DocumentLink,
  ErrorCodes,
  FileChangeType,
  type Hover,
  type InitializeParams,
  type InitializeResult,
  type Location,
  MessageType,
  type Position,
  ProposedFeatures,
  ResponseError,
  ShowMessageNotification,
  type SignatureHelp,
  TextDocumentSyncKind,
  type TextDocumentContentChangeEvent,
  createConnection,
} from "vscode-languageserver/node";

import { compareStr, isControl, trimEndWhiteSpace } from "../core/chars.ts";
import { type Candidate, type Category, type Source, collectStoragePaths, complete, signature } from "../core/complete.ts";
import { Config } from "../core/config.ts";
import * as datajson from "../core/datajson.ts";
import type { Severity } from "../core/diag.ts";
import { type Kind, kind } from "../core/facts.ts";
import { commentLinks } from "../core/mcfunction.ts";
import { LineIndex } from "../core/position.ts";
import { type FileId, Project, canonicalize, defaultMaxDepth, joinPath, pathEquals, readDir, readText, sortUnique } from "../core/project.ts";

/** Runs the server over the process's stdin and stdout until the client ends the session. */
export function run(): void {
  const connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
  new Server(connection);
  connection.listen();
}

const CAPABILITIES: InitializeResult = {
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    hoverProvider: true,
    completionProvider: { triggerCharacters: [" ", "@", "[", "=", ",", ":", "/", ".", "{", "#", "!", "~", "^", '"'] },
    signatureHelpProvider: { triggerCharacters: [" "] },
    definitionProvider: true,
    referencesProvider: true,
    documentLinkProvider: { resolveProvider: false },
  },
};

function workspaceRoot(params: InitializeParams): string | undefined {
  const first = params.workspaceFolders?.[0];
  if (first !== undefined) return toFilePath(first.uri);
  return params.rootUri === null || params.rootUri === undefined ? undefined : toFilePath(params.rootUri);
}

function toFilePath(uri: string): string | undefined {
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

function toFileUrl(path: string): URL | undefined {
  try {
    return pathToFileURL(path);
  } catch {
    return undefined;
  }
}

/** The key of a path in the editor's open documents: `\` for every separator and a capital drive
 * letter, so that the spellings of one path that the editor and the file system give match. */
function pathId(path: string): string {
  const p = path.replaceAll("/", "\\");
  return /^[a-z]:/.test(p) ? p[0]!.toUpperCase() + p.slice(1) : p;
}

function ignoreFailure(sent: Promise<void>): void {
  sent.catch(() => {});
}

type Work<T> = () => T | Promise<T>;

class Server {
  private readonly connection: Connection;
  private root: string | undefined = undefined;
  private ignore: string[] = [];
  /** `maxDepth` of the initialization options; `undefined` uses `defaultMaxDepth`. */
  private maxDepth: number | undefined = undefined;
  private project: Project | undefined = undefined;
  /** Files that currently show diagnostics in the client. */
  private published = new Set<string>();
  /** The text of each open document. The editor's text wins over the file on disk. */
  private readonly open = new Map<string, string>();
  /** The NBT paths used in each storage, for completion. Built when first needed, then
   * updated file by file as texts change. */
  private storagePaths: StorageIndex | undefined = undefined;
  /** The messages are handled one at a time in the order they arrive: loading the project is
   * asynchronous, and the messages after it must see the loaded project. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(connection: Connection) {
    this.connection = connection;
    connection.onInitialize((params) => {
      this.root = workspaceRoot(params);
      const options = params.initializationOptions as { ignore?: unknown; maxDepth?: unknown } | null | undefined;
      if (Array.isArray(options?.ignore)) this.ignore = options.ignore.filter((s): s is string => typeof s === "string");
      const depth = options?.maxDepth;
      if (typeof depth === "number" && Number.isInteger(depth) && depth >= 0) this.maxDepth = depth;
      return CAPABILITIES;
    });
    connection.onInitialized(() => {
      this.notification(() => {
        if (this.root === undefined) {
          process.stderr.write("mcf-linter-spark lsp: the client sent no workspace folder\n");
          process.exit(2);
        }
        return this.reload();
      });
    });
    connection.onRequest((method) => {
      throw new ResponseError(ErrorCodes.MethodNotFound, `unsupported request ${method}`);
    });
    connection.onHover((p) => this.enqueue(() => this.hover(p.textDocument.uri, p.position)));
    connection.onCompletion((p) => this.enqueue(() => this.completion(p.textDocument.uri, p.position)));
    connection.onSignatureHelp((p) => this.enqueue(() => this.signatureHelp(p.textDocument.uri, p.position)));
    connection.onDefinition((p) => this.enqueue(() => this.definition(p.textDocument.uri, p.position)));
    connection.onReferences((p) => this.enqueue(() => this.references(p.textDocument.uri, p.position, p.context.includeDeclaration)));
    connection.onDocumentLinks((p) => this.enqueue(() => this.documentLinks(p.textDocument.uri)));
    connection.onDidOpenTextDocument((p) => {
      this.notification(() => {
        const path = toFilePath(p.textDocument.uri);
        if (path !== undefined) this.openText(path, p.textDocument.text);
      });
    });
    connection.onDidChangeTextDocument((p) => {
      this.notification(() => {
        const path = toFilePath(p.textDocument.uri);
        if (path !== undefined) this.openText(path, applyChanges(this.open.get(pathId(path)) ?? "", p.contentChanges));
      });
    });
    connection.onDidCloseTextDocument((p) => {
      this.notification(() => {
        const path = toFilePath(p.textDocument.uri);
        if (path === undefined) return;
        this.open.delete(pathId(path));
        if (isFile(path)) this.setText(path, readText(path));
        else this.remove(path);
      });
    });
    connection.onDidChangeWatchedFiles((p) => {
      this.notification(async () => {
        for (const change of p.changes) await this.fileChanged(change.uri, change.type);
      });
    });
  }

  private notification(work: Work<void>): void {
    this.enqueue(work).catch((e: unknown) => {
      this.connection.console.error(`mcf-linter-spark: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    });
  }

  private enqueue<T>(work: Work<T>): Promise<T> {
    const run = this.tail.then(work);
    this.tail = run.catch(() => {});
    return run;
  }

  /** Whether a change of `path` changes the configuration (see `Config.load`). */
  private isConfig(path: string): boolean {
    const root = this.root!;
    return pathEquals(path, joinPath(joinPath(root, ".vscode"), "settings.json")) || pathEquals(path, joinPath(root, "spyglass.json"));
  }

  /** Loads the whole project and publishes every file's diagnostics. */
  private async reload(): Promise<void> {
    const root = this.root!;
    this.storagePaths = undefined;
    let config: Config;
    try {
      config = Config.load(root);
    } catch (e) {
      this.connection.console.warn(`mcf-linter-spark: cannot read the settings: ${(e as Error).message}`);
      config = new Config();
    }
    const maxDepth = this.maxDepth ?? defaultMaxDepth(config);
    let project: Project;
    try {
      project = await Project.load(root, config, { ignore: this.ignore, maxDepth });
    } catch (e) {
      this.showMessage(MessageType.Error, `mcf-linter-spark: ${(e as Error).message}. Reload the window to try again.`);
      return;
    }
    for (const notice of project.notices) this.showMessage(MessageType.Warning, `mcf-linter-spark: ${notice}`);
    project.enableIncremental();
    for (const [path, text] of this.open) {
      const fid = project.fileIdOf(path);
      if (fid !== undefined) project.setText(fid, text);
    }
    const all = project.allDiagnostics();
    const stale = [...this.published];
    this.published = new Set();
    this.project = project;
    for (const path of stale) this.sendDiagnostics(path, []);
    for (const [fid] of all) this.publish(fid);
  }

  /** A `window/showMessage` notification; `connection.window.show*Message` sends a request that waits for the user. */
  private showMessage(type: MessageType, message: string): void {
    ignoreFailure(this.connection.sendNotification(ShowMessageNotification.type, { type, message }));
  }

  private openText(path: string, text: string): void {
    this.open.set(pathId(path), text);
    this.setText(path, text);
  }

  private setText(path: string, text: string): void {
    const project = this.project;
    if (project === undefined) return;
    let fid = project.fileIdOf(path);
    let affected: FileId[];
    if (fid !== undefined) {
      affected = project.setText(fid, text);
    } else {
      const added = project.addFile(path);
      if (added === undefined) return;
      fid = added[0];
      affected = sortUnique([...added[1], ...project.setText(fid, text)]);
    }
    if (this.storagePaths !== undefined && project.files[fid]!.kind === kind.FUNCTION) this.storagePaths.set(fid, text);
    // The edited file first, even with no diagnostics, so that the client
    // always learns the result of the edit; then the files that depend on it.
    this.publishForced(fid);
    const edited = fid;
    this.publishAll(affected.filter((x) => x !== edited));
  }

  private publishForced(fid: FileId): void {
    const project = this.project;
    if (project === undefined) return;
    const f = project.files[fid]!;
    this.sendDiagnostics(f.path, f.ignored || f.removed ? [] : toLsp(project, fid));
  }

  private async fileChanged(uri: string, type: number): Promise<void> {
    this.storagePaths = undefined;
    const path = toFilePath(uri);
    if (path === undefined) return;
    if (this.isConfig(path)) {
      await this.reload();
      return;
    }
    if (type === FileChangeType.Deleted) {
      this.remove(path);
      return;
    }
    const paths = isDir(path) ? filesIn(path) : [path];
    const project = this.project;
    if (project === undefined) return;
    let affected: FileId[] = [];
    for (const p of paths) {
      const text = this.open.get(pathId(p));
      if (text !== undefined) {
        if (project.fileIdOf(p) === undefined) {
          const added = project.addFile(p);
          if (added !== undefined) affected.push(...added[1], ...project.setText(added[0], text));
        }
      } else {
        const added = project.addFile(p);
        if (added !== undefined) affected.push(...added[1]);
      }
    }
    affected = sortUnique(affected);
    this.publishAll(affected);
  }

  private remove(path: string): void {
    this.storagePaths = undefined;
    const project = this.project;
    if (project === undefined) return;
    const fid = project.fileIdOf(path);
    const removed = fid !== undefined ? [fid] : project.filesUnder(path);
    const affected: FileId[] = [];
    const paths: string[] = [];
    for (const f of removed) {
      paths.push(project.files[f]!.path);
      affected.push(...project.removeFile(f));
    }
    for (const p of paths) this.sendDiagnostics(p, []);
    this.publishAll(sortUnique(affected));
  }

  private publishAll(files: readonly FileId[]): void {
    for (const fid of files) this.publish(fid);
  }

  private publish(fid: FileId): void {
    const project = this.project;
    if (project === undefined) return;
    const f = project.files[fid]!;
    const diagnostics = f.ignored || f.removed ? [] : toLsp(project, fid);
    if (diagnostics.length === 0 && !this.published.has(f.path)) return;
    this.sendDiagnostics(f.path, diagnostics);
  }

  private sendDiagnostics(path: string, diagnostics: Diagnostic[]): void {
    const url = toFileUrl(path);
    if (url === undefined) return;
    if (diagnostics.length === 0) this.published.delete(path);
    else this.published.add(path);
    ignoreFailure(this.connection.sendDiagnostics({ uri: url.href, diagnostics }));
  }

  private hover(uri: string, pos: Position): Hover | null {
    const project = this.project;
    if (project === undefined) return null;
    const path = toFilePath(uri);
    const fid = path === undefined ? undefined : project.fileIdOf(path);
    if (fid === undefined) return null;
    const f = project.files[fid]!;
    const offset = new LineIndex(f.text).offset(f.text, pos.line, pos.character);
    const symbol = project.symbolAt(fid, offset);
    if (symbol === undefined) return null;
    const [k, id] = symbol;
    const docs: string[] = [];
    for (const site of project.sites(k, id)) {
      if (site.doc !== undefined && !docs.includes(site.doc)) docs.push(site.doc);
    }
    let value = `**${k}** ${codeSpan(id)}`;
    for (const d of docs) {
      value += "\n\n---\n\n";
      value += markdownDoc(linkedDoc(project, d));
    }
    return { contents: { kind: "markdown", value } };
  }

  private completion(uri: string, pos: Position): CompletionList | null {
    const items = this.jsonCompletion(uri, pos);
    if (items !== undefined) return { isIncomplete: true, items };
    const before = this.lineBefore(uri, pos);
    if (before === undefined) return null;
    const [fid, line] = before;
    const project = this.project;
    if (project === undefined) return null;
    const source = new ProjectSource(project, fid, pos.line, line, this);
    const found = complete(line, project.data, project.config, source);
    // Candidates are filtered by the typed text here, so the client asks again as it grows.
    return { isIncomplete: true, items: found.map((c) => completionItem(c, pos)) };
  }

  /** Keys and values at the cursor of a data pack JSON file; `undefined` for other files. */
  private jsonCompletion(uri: string, pos: Position): CompletionItem[] | undefined {
    const project = this.project;
    if (project === undefined) return undefined;
    const path = toFilePath(uri);
    const fid = path === undefined ? undefined : project.fileIdOf(path);
    if (fid === undefined) return undefined;
    const f = project.files[fid]!;
    const doc = project.data.mcdoc;
    const schema = datajson.schema(f.kind, doc);
    if (schema === undefined) return undefined;
    const index = new LineIndex(f.text);
    const offset = index.offset(f.text, pos.line, pos.character);
    const at = (o: number): Position => {
      const [line, character] = index.position(f.text, o);
      return { line, character };
    };
    return datajson.complete(f.text, offset, schema, doc, project.data, (k) => project.ids(k)).map((s) => ({
      label: s.label,
      kind: s.key ? CompletionItemKind.Property : CompletionItemKind.Value,
      detail: s.detail,
      filterText: s.insert,
      textEdit: { range: { start: at(s.start), end: at(s.end) }, newText: s.insert },
    }));
  }

  /** The function file being edited and its text up to the cursor on the cursor's line. */
  private lineBefore(uri: string, pos: Position): [FileId, string] | undefined {
    const project = this.project;
    if (project === undefined) return undefined;
    const path = toFilePath(uri);
    const fid = path === undefined ? undefined : project.fileIdOf(path);
    if (fid === undefined) return undefined;
    const f = project.files[fid]!;
    if (f.kind !== kind.FUNCTION) return undefined;
    const index = new LineIndex(f.text);
    const start = index.offset(f.text, pos.line, 0);
    const end = index.offset(f.text, pos.line, pos.character);
    return [fid, f.text.slice(start, end)];
  }

  private signatureHelp(uri: string, pos: Position): SignatureHelp | null {
    const before = this.lineBefore(uri, pos);
    if (before === undefined) return null;
    const project = this.project;
    if (project === undefined) return null;
    const s = signature(before[1], project.data, project.config);
    if (s === undefined) return null;
    return {
      signatures: [{ label: s.label, parameters: s.parts.map(([a, b]) => ({ label: [a, b] })), activeParameter: s.active }],
      activeSignature: 0,
      activeParameter: s.active,
    };
  }

  private definition(uri: string, pos: Position): Location | Location[] | null {
    const project = this.project;
    if (project === undefined) return null;
    const path = toFilePath(uri);
    const fid = path === undefined ? undefined : project.fileIdOf(path);
    if (fid === undefined) return null;
    const f = project.files[fid]!;
    const offset = new LineIndex(f.text).offset(f.text, pos.line, pos.character);
    const link = project.linkLineAt(fid, offset);
    if (link !== undefined) {
      const [file, line] = link;
      const target = toFileUrl(project.files[file]!.path);
      if (target === undefined) return null;
      const at = { line: line - 1, character: 0 };
      return { uri: target.href, range: { start: at, end: at } };
    }
    const symbol = project.symbolAt(fid, offset);
    if (symbol === undefined) return null;
    const locations = project.definitions(symbol[0], symbol[1]).flatMap((s) => location(project, s) ?? []);
    return locations.length === 0 ? null : locations;
  }

  private references(uri: string, pos: Position, includeDeclaration: boolean): Location[] | null {
    const project = this.project;
    if (project === undefined) return null;
    const path = toFilePath(uri);
    const fid = path === undefined ? undefined : project.fileIdOf(path);
    if (fid === undefined) return null;
    const f = project.files[fid]!;
    const offset = new LineIndex(f.text).offset(f.text, pos.line, pos.character);
    const symbol = project.symbolAt(fid, offset);
    if (symbol === undefined) return null;
    const spans = project.references(symbol[0], symbol[1]);
    if (includeDeclaration) spans.push(...project.definitions(symbol[0], symbol[1]));
    return spans.flatMap((s) => location(project, s) ?? []);
  }

  private documentLinks(uri: string): DocumentLink[] | null {
    const project = this.project;
    if (project === undefined) return null;
    const path = toFilePath(uri);
    const fid = path === undefined ? undefined : project.fileIdOf(path);
    if (fid === undefined) return null;
    const out: DocumentLink[] = [];
    for (const l of project.files[fid]!.facts.links) {
      const target = linkTarget(project, l.target.id, l.line);
      if (target === undefined) continue;
      const where = location(project, [fid, l.target.start, l.target.end]);
      if (where === undefined) continue;
      out.push({ range: where.range, target: target.href });
    }
    return out;
  }

  storageIndex(project: Project): StorageIndex {
    this.storagePaths ??= StorageIndex.build(project);
    return this.storagePaths;
  }
}

function completionItem(c: Candidate, pos: Position): CompletionItem {
  return {
    label: c.label,
    kind: completionKind(c.category),
    // After a folder or an option name, the next part is completed at once.
    command: c.category === "Folder" || c.label.endsWith("=") ? { title: "Suggest", command: "editor.action.triggerSuggest" } : undefined,
    detail: c.detail,
    textEdit: { range: { start: { line: pos.line, character: c.start }, end: pos }, newText: c.label },
  };
}

function completionKind(category: Category): CompletionItemKind {
  switch (category) {
    case "Keyword":
      return CompletionItemKind.Keyword;
    case "Selector":
      return CompletionItemKind.Variable;
    case "Symbol":
      return CompletionItemKind.Reference;
    case "Folder":
      return CompletionItemKind.Folder;
    case "Value":
      return CompletionItemKind.Value;
    case "Property":
      return CompletionItemKind.Property;
    case "Coordinates":
      return CompletionItemKind.Unit;
  }
}

// ponytail: a LineIndex per location costs O(file size) each; cache one per file for the call if references to a name used in thousands of places get slow
function location(project: Project, [file, start, end]: [FileId, number, number]): Location | undefined {
  const f = project.files[file]!;
  const index = new LineIndex(f.text);
  const pos = (offset: number): Position => {
    const [line, character] = index.position(f.text, offset);
    return { line, character };
  };
  const url = toFileUrl(f.path);
  return url === undefined ? undefined : { uri: url.href, range: { start: pos(start), end: pos(end) } };
}

/** The file of a function, with `#L<line>` for the editor to open it at that line. */
function linkTarget(project: Project, id: string, line: number | undefined): URL | undefined {
  const fid = project.functionFile(id);
  if (fid === undefined) return undefined;
  const url = toFileUrl(project.files[fid]!.path);
  if (url !== undefined && line !== undefined) url.hash = `L${line}`;
  return url;
}

/** A doc comment with its links to functions pointing at their files. */
function linkedDoc(project: Project, doc: string): string {
  let out = doc;
  for (const [start, end, id, line] of commentLinks(doc).reverse()) {
    const url = linkTarget(project, id, line);
    if (url !== undefined) out = out.slice(0, start) + url.href + out.slice(end);
  }
  return out;
}

/** The project's symbols and storage paths as the edited file sees them. */
class ProjectSource implements Source {
  private readonly project: Project;
  private readonly fid: FileId;
  private readonly line: number;
  private readonly before: string;
  private readonly server: Server;

  constructor(project: Project, fid: FileId, line: number, before: string, server: Server) {
    this.project = project;
    this.fid = fid;
    this.line = line;
    this.before = before;
    this.server = server;
  }

  symbols(k: Kind): string[] {
    return this.project.visibleIds(this.fid, k);
  }

  storagePaths(storage: string): string[] {
    const index = this.server.storageIndex(this.project);
    return storagePathsWhileTyping(index, this.fid, this.project.files[this.fid]!.text, this.line, this.before, storage);
  }
}

export function storagePathsWhileTyping(index: StorageIndex, fid: FileId, text: string, line: number, before: string, storage: string): string[] {
  const space = Math.max(before.lastIndexOf(" "), before.lastIndexOf("\t"));
  const finished = space < 0 ? "" : before.slice(0, space + 1);
  let kept = "";
  let i = 0;
  for (let start = 0; start < text.length; i++) {
    const nl = text.indexOf("\n", start);
    const end = nl < 0 ? text.length : nl + 1;
    kept += i === line ? `${finished}\n` : text.slice(start, end);
    start = end;
  }
  const own = new Map<string, Set<string>>();
  collectStoragePaths(kept, own);
  const paths = index.pathsBesides(fid, storage);
  for (const p of own.get(storage) ?? []) paths.add(p);
  return [...paths].sort(compareStr);
}

/** The NBT paths that each function uses in storages, counted over all functions. */
export class StorageIndex {
  private readonly byFile = new Map<FileId, [string, string][]>();
  private readonly counts = new Map<string, Map<string, number>>();

  static build(project: Project): StorageIndex {
    const index = new StorageIndex();
    for (let fid = 0; fid < project.files.length; fid++) {
      const f = project.files[fid]!;
      if (f.kind === kind.FUNCTION && !f.removed) index.set(fid, f.text);
    }
    return index;
  }

  /** Replaces what the function `fid` contributes with what `text` uses. */
  set(fid: FileId, text: string): void {
    for (const [storage, path] of this.byFile.get(fid) ?? []) {
      const paths = this.counts.get(storage);
      const n = paths?.get(path);
      if (paths !== undefined && n !== undefined) {
        if (n - 1 === 0) paths.delete(path);
        else paths.set(path, n - 1);
      }
    }
    this.byFile.delete(fid);
    const found = new Map<string, Set<string>>();
    collectStoragePaths(text, found);
    const entries: [string, string][] = [];
    for (const [storage, paths] of found) for (const p of paths) entries.push([storage, p]);
    for (const [storage, path] of entries) {
      let paths = this.counts.get(storage);
      if (paths === undefined) this.counts.set(storage, (paths = new Map()));
      paths.set(path, (paths.get(path) ?? 0) + 1);
    }
    this.byFile.set(fid, entries);
  }

  pathsBesides(fid: FileId, storage: string): Set<string> {
    const own = new Set<string>();
    for (const [s, p] of this.byFile.get(fid) ?? []) if (s === storage) own.add(p);
    const out = new Set<string>();
    for (const [p, n] of this.counts.get(storage) ?? []) if (n > (own.has(p) ? 1 : 0)) out.add(p);
    return out;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return false;
  }
}


function filesIn(dir: string): string[] {
  const out: string[] = [];
  const pending = [dir];
  const seen = new Set<string>();
  const root = canonicalize(dir);
  if (root !== undefined) seen.add(root);
  for (let d = pending.pop(); d !== undefined; d = pending.pop()) {
    for (const e of readDir(d) ?? []) {
      const p = joinPath(d, e.name);
      if (!isDir(p)) {
        out.push(p);
      } else if (!e.name.startsWith(".") && e.name !== "node_modules") {
        const real = canonicalize(p);
        if (real === undefined || !seen.has(real)) {
          if (real !== undefined) seen.add(real);
          pending.push(p);
        }
      }
    }
  }
  return out;
}


/** Applies the changes of an incremental `didChange`, in order. Ranges are in
 * UTF-16 positions of the text as each change finds it. */
export function applyChanges(text: string, changes: readonly TextDocumentContentChangeEvent[]): string {
  let out = text;
  for (const change of changes) {
    if ("range" in change) {
      const index = new LineIndex(out);
      const start = index.offset(out, change.range.start.line, change.range.start.character);
      const end = Math.max(index.offset(out, change.range.end.line, change.range.end.character), start);
      out = out.slice(0, start) + change.text + out.slice(end);
    } else {
      out = change.text;
    }
  }
  return out;
}

/** Keeps the doc's line breaks in Markdown. */
export function markdownDoc(doc: string): string {
  const lines = doc.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => `${trimEndWhiteSpace(l).replaceAll("![", "&#33;[")}  `).join("\n");
}

export function codeSpan(text: string): string {
  let escaped = "";
  for (const c of text) escaped += isControl(c) ? escapeDebug(c) : c;
  let longest = 0;
  for (const run of escaped.split(/[^`]/)) longest = Math.max(longest, run.length);
  const fence = "`".repeat(longest + 1);
  const pad = escaped.startsWith("`") || escaped.endsWith("`") ? " " : "";
  return `${fence}${pad}${escaped}${pad}${fence}`;
}

/** A control character as an escape: `\0`, `\t`, `\r`, `\n`, else `\u{..}`. */
function escapeDebug(c: string): string {
  switch (c) {
    case "\0":
      return "\\0";
    case "\t":
      return "\\t";
    case "\r":
      return "\\r";
    case "\n":
      return "\\n";
    default:
      return `\\u{${c.codePointAt(0)!.toString(16)}}`;
  }
}

function toLsp(project: Project, fid: FileId): Diagnostic[] {
  const f = project.files[fid]!;
  const index = new LineIndex(f.text);
  const pos = (offset: number): Position => {
    const [line, character] = index.position(f.text, offset);
    return { line, character };
  };
  return project.diagnostics(fid).map((d) => ({
    range: { start: pos(d.start), end: pos(d.end) },
    severity: severityOf(d.severity),
    code: d.code,
    source: "mcf-linter-spark",
    message: d.message,
  }));
}

function severityOf(s: Severity): DiagnosticSeverity {
  switch (s) {
    case "Error":
      return DiagnosticSeverity.Error;
    case "Warning":
      return DiagnosticSeverity.Warning;
    case "Information":
      return DiagnosticSeverity.Information;
    case "Hint":
      return DiagnosticSeverity.Hint;
  }
}
