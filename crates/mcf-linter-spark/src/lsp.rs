//! The language server: diagnostics for the workspace, IMP-Doc hovers, completion, definitions,
//! references, and the links in comments.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crossbeam_channel::Sender;
use spark_core::config::Config;
use spark_core::diag::Severity;
use spark_core::position::LineIndex;
use spark_core::project::{FileId, Options, Project, default_max_depth, read_text};
use lsp_server::{Connection, Message, Notification, Request, Response};
use lsp_types::notification::{
    DidChangeTextDocument, DidChangeWatchedFiles, DidCloseTextDocument, DidOpenTextDocument, Notification as _,
    PublishDiagnostics,
};
use spark_core::complete::{self, Category};
use spark_core::datajson;
use spark_core::mcfunction;
use spark_core::facts::{Kind, kind};
use lsp_types::request::{
    Completion, DocumentLinkRequest, GotoDefinition, HoverRequest, References, Request as _, SignatureHelpRequest,
};
use lsp_types::{
    Command, CompletionItem, CompletionItemKind, CompletionList, CompletionOptions, CompletionParams, CompletionResponse,
    CompletionTextEdit, Diagnostic, DiagnosticSeverity, DocumentLink, DocumentLinkOptions, DocumentLinkParams, FileChangeType,
    GotoDefinitionParams, GotoDefinitionResponse,
    Hover, HoverContents, HoverParams, HoverProviderCapability, InitializeParams, Location, MarkupContent, MarkupKind,
    NumberOrString, OneOf, ParameterInformation, ParameterLabel, Position, PublishDiagnosticsParams, Range, ReferenceParams,
    ServerCapabilities, SignatureHelp, SignatureHelpOptions, SignatureHelpParams, SignatureInformation,
    TextDocumentContentChangeEvent, TextDocumentSyncCapability, TextDocumentSyncKind, TextEdit, Url,
};

pub fn run() -> Result<(), String> {
    let (connection, io_threads) = Connection::stdio();
    let capabilities = ServerCapabilities {
        text_document_sync: Some(TextDocumentSyncCapability::Kind(TextDocumentSyncKind::INCREMENTAL)),
        hover_provider: Some(HoverProviderCapability::Simple(true)),
        completion_provider: Some(CompletionOptions {
            trigger_characters: Some(
                [" ", "@", "[", "=", ",", ":", "/", ".", "{", "#", "!", "~", "^", "\""].map(str::to_string).to_vec(),
            ),
            ..Default::default()
        }),
        signature_help_provider: Some(SignatureHelpOptions {
            trigger_characters: Some(vec![" ".to_string()]),
            ..Default::default()
        }),
        definition_provider: Some(OneOf::Left(true)),
        references_provider: Some(OneOf::Left(true)),
        document_link_provider: Some(DocumentLinkOptions { resolve_provider: Some(false), work_done_progress_options: Default::default() }),
        ..Default::default()
    };
    let init = connection
        .initialize(serde_json::to_value(capabilities).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let params: InitializeParams = serde_json::from_value(init).map_err(|e| e.to_string())?;
    let root = workspace_root(&params).ok_or("the client sent no workspace folder")?;
    let options = params.initialization_options.as_ref();
    let ignore = options
        .and_then(|o| o.get("ignore"))
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let max_depth = options
        .and_then(|o| o.get("maxDepth"))
        .and_then(|v| v.as_u64())
        .map(|d| d as usize);
    let mut server = Server {
        sender: connection.sender.clone(),
        root,
        ignore,
        max_depth,
        project: None,
        published: HashSet::new(),
        open: HashMap::new(),
        storage_paths: RefCell::new(None),
    };
    server.reload();
    for msg in &connection.receiver {
        match msg {
            Message::Request(req) => {
                if connection.handle_shutdown(&req).map_err(|e| e.to_string())? {
                    break;
                }
                server.request(req);
            }
            Message::Notification(n) => server.notification(n),
            Message::Response(_) => {}
        }
    }
    // The writer thread ends only when every sender is gone.
    drop(server);
    drop(connection);
    io_threads.join().map_err(|e| e.to_string())
}

fn workspace_root(params: &InitializeParams) -> Option<PathBuf> {
    if let Some(folders) = &params.workspace_folders {
        if let Some(f) = folders.first() {
            return f.uri.to_file_path().ok();
        }
    }
    #[allow(deprecated)]
    params.root_uri.as_ref().and_then(|u| u.to_file_path().ok())
}

struct Server {
    sender: Sender<Message>,
    root: PathBuf,
    ignore: Vec<String>,
    /// `maxDepth` of the initialization options; `None` uses `default_max_depth`.
    max_depth: Option<usize>,
    project: Option<Project>,
    /// Files that currently show diagnostics in the client.
    published: HashSet<PathBuf>,
    /// The text of each open document. The editor's text wins over the file on disk.
    open: HashMap<PathBuf, Arc<str>>,
    /// The NBT paths used in each storage, for completion. Built when first needed, then
    /// updated file by file as texts change.
    storage_paths: RefCell<Option<StorageIndex>>,
}

impl Server {
    /// Whether a change of `path` changes the configuration (see `Config::load`).
    fn is_config(&self, path: &Path) -> bool {
        path == self.root.join(".vscode").join("settings.json") || path == self.root.join("spyglass.json")
    }

    /// Loads the whole project and publishes every file's diagnostics.
    fn reload(&mut self) {
        *self.storage_paths.get_mut() = None;
        let config = Config::load(&self.root, None).unwrap_or_else(|e| {
            self.log(&format!("mcf-linter-spark: cannot read the settings: {e}"));
            Config::default()
        });
        let max_depth = self.max_depth.unwrap_or_else(|| default_max_depth(&config));
        match Project::load(&self.root, config, &Options { ignore: self.ignore.clone(), max_depth }) {
            Ok(mut project) => {
                for notice in &project.notices {
                    let params = lsp_types::ShowMessageParams { typ: lsp_types::MessageType::WARNING, message: format!("mcf-linter-spark: {notice}") };
                    let _ = self.sender.send(Message::Notification(Notification::new("window/showMessage".into(), params)));
                }
                project.enable_incremental();
                for (path, text) in &self.open {
                    if let Some(fid) = project.file_id_of(path) {
                        project.set_text(fid, text.clone());
                    }
                }
                let all = project.all_diagnostics();
                let stale: Vec<PathBuf> = std::mem::take(&mut self.published).into_iter().collect();
                self.project = Some(project);
                for path in stale {
                    self.send_diagnostics(&path, Vec::new());
                }
                for (fid, _) in all {
                    self.publish(fid);
                }
            }
            Err(e) => {
                let message = format!("mcf-linter-spark: {e}. Reload the window to try again.");
                let params = lsp_types::ShowMessageParams { typ: lsp_types::MessageType::ERROR, message };
                let _ = self.sender.send(Message::Notification(Notification::new("window/showMessage".into(), params)));
            }
        }
    }

    fn log(&self, message: &str) {
        let params = lsp_types::LogMessageParams { typ: lsp_types::MessageType::WARNING, message: message.to_string() };
        let _ = self.sender.send(Message::Notification(Notification::new("window/logMessage".into(), params)));
    }

    fn request(&mut self, req: Request) {
        if req.method == HoverRequest::METHOD {
            let result = serde_json::from_value::<HoverParams>(req.params).ok().and_then(|p| self.hover(&p));
            let _ = self.sender.send(Message::Response(Response::new_ok(req.id, result)));
        } else if req.method == Completion::METHOD {
            let result = serde_json::from_value::<CompletionParams>(req.params).ok().and_then(|p| self.completion(&p));
            let _ = self.sender.send(Message::Response(Response::new_ok(req.id, result)));
        } else if req.method == SignatureHelpRequest::METHOD {
            let result = serde_json::from_value::<SignatureHelpParams>(req.params).ok().and_then(|p| self.signature_help(&p));
            let _ = self.sender.send(Message::Response(Response::new_ok(req.id, result)));
        } else if req.method == GotoDefinition::METHOD {
            let result = serde_json::from_value::<GotoDefinitionParams>(req.params).ok().and_then(|p| self.definition(&p));
            let _ = self.sender.send(Message::Response(Response::new_ok(req.id, result)));
        } else if req.method == References::METHOD {
            let result = serde_json::from_value::<ReferenceParams>(req.params).ok().and_then(|p| self.references(&p));
            let _ = self.sender.send(Message::Response(Response::new_ok(req.id, result)));
        } else if req.method == DocumentLinkRequest::METHOD {
            let result = serde_json::from_value::<DocumentLinkParams>(req.params).ok().and_then(|p| self.document_links(&p));
            let _ = self.sender.send(Message::Response(Response::new_ok(req.id, result)));
        } else {
            let _ = self.sender.send(Message::Response(Response::new_err(
                req.id,
                lsp_server::ErrorCode::MethodNotFound as i32,
                format!("unsupported request {}", req.method),
            )));
        }
    }

    fn notification(&mut self, n: Notification) {
        match n.method.as_str() {
            DidOpenTextDocument::METHOD => {
                if let Ok(p) = serde_json::from_value::<lsp_types::DidOpenTextDocumentParams>(n.params)
                    && let Ok(path) = p.text_document.uri.to_file_path()
                {
                    self.open_text(path, p.text_document.text.into());
                }
            }
            DidChangeTextDocument::METHOD => {
                if let Ok(p) = serde_json::from_value::<lsp_types::DidChangeTextDocumentParams>(n.params)
                    && let Ok(path) = p.text_document.uri.to_file_path()
                {
                    let current = self.open.get(&path).cloned().unwrap_or_default();
                    let text = apply_changes(&current, p.content_changes);
                    self.open_text(path, text.into());
                }
            }
            DidCloseTextDocument::METHOD => {
                if let Ok(p) = serde_json::from_value::<lsp_types::DidCloseTextDocumentParams>(n.params)
                    && let Ok(path) = p.text_document.uri.to_file_path()
                {
                    self.open.remove(&path);
                    if path.is_file() {
                        let text = read_text(&path);
                        self.set_text(&path, text);
                    } else {
                        self.remove(&path);
                    }
                }
            }
            DidChangeWatchedFiles::METHOD => {
                if let Ok(p) = serde_json::from_value::<lsp_types::DidChangeWatchedFilesParams>(n.params) {
                    for change in p.changes {
                        self.file_changed(&change.uri, change.typ);
                    }
                }
            }
            _ => {}
        }
    }

    fn open_text(&mut self, path: PathBuf, text: Arc<str>) {
        self.open.insert(path.clone(), text.clone());
        self.set_text(&path, text);
    }

    fn set_text(&mut self, path: &Path, text: Arc<str>) {
        let Some(project) = self.project.as_mut() else { return };
        let (fid, affected) = match project.file_id_of(path) {
            Some(fid) => (fid, project.set_text(fid, text.clone())),
            None => match project.add_file(path) {
                Some((fid, mut affected)) => {
                    affected.extend(project.set_text(fid, text.clone()));
                    affected.sort();
                    affected.dedup();
                    (fid, affected)
                }
                None => return,
            },
        };
        if let Some(index) = self.storage_paths.get_mut()
            && project.files[fid as usize].kind == kind::FUNCTION
        {
            index.set(fid, &text);
        }
        // The edited file first, even with no diagnostics, so that the client
        // always learns the result of the edit; then the files that depend on it.
        self.publish_forced(fid);
        let others: Vec<FileId> = affected.into_iter().filter(|&x| x != fid).collect();
        self.publish_all(&others);
    }

    fn publish_forced(&mut self, fid: FileId) {
        let Some(project) = self.project.as_ref() else { return };
        let f = &project.files[fid as usize];
        let path = f.path.clone();
        let diags = if f.ignored || f.removed { Vec::new() } else { to_lsp(project, fid) };
        self.send_diagnostics(&path, diags);
    }

    fn file_changed(&mut self, uri: &Url, typ: FileChangeType) {
        *self.storage_paths.get_mut() = None;
        let Ok(path) = uri.to_file_path() else { return };
        if self.is_config(&path) {
            self.reload();
            return;
        }
        if typ == FileChangeType::DELETED {
            self.remove(&path);
            return;
        }
        let paths = if path.is_dir() { files_in(&path) } else { vec![path] };
        let Some(project) = self.project.as_mut() else { return };
        let mut affected = Vec::new();
        for p in paths {
            let added = match self.open.get(&p) {
                Some(text) if project.file_id_of(&p).is_none() => project.add_file(&p).map(|(fid, mut a)| {
                    a.extend(project.set_text(fid, text.clone()));
                    a
                }),
                Some(_) => None,
                None => project.add_file(&p).map(|(_, a)| a),
            };
            affected.extend(added.into_iter().flatten());
        }
        affected.sort();
        affected.dedup();
        self.publish_all(&affected);
    }

    fn remove(&mut self, path: &Path) {
        *self.storage_paths.get_mut() = None;
        let Some(project) = self.project.as_mut() else { return };
        let removed = match project.file_id_of(path) {
            Some(fid) => vec![fid],
            None => project.files_under(path),
        };
        let mut affected = Vec::new();
        let mut paths = Vec::new();
        for fid in removed {
            paths.push(project.files[fid as usize].path.clone());
            affected.extend(project.remove_file(fid));
        }
        for p in paths {
            self.send_diagnostics(&p, Vec::new());
        }
        affected.sort();
        affected.dedup();
        self.publish_all(&affected);
    }

    fn publish_all(&mut self, files: &[FileId]) {
        for &fid in files {
            self.publish(fid);
        }
    }

    fn publish(&mut self, fid: FileId) {
        let Some(project) = self.project.as_ref() else { return };
        let f = &project.files[fid as usize];
        let path = f.path.clone();
        let diags = if f.ignored || f.removed { Vec::new() } else { to_lsp(project, fid) };
        if diags.is_empty() && !self.published.contains(&path) {
            return;
        }
        self.send_diagnostics(&path, diags);
    }

    fn send_diagnostics(&mut self, path: &Path, diagnostics: Vec<Diagnostic>) {
        let Ok(uri) = Url::from_file_path(path) else { return };
        if diagnostics.is_empty() {
            self.published.remove(path);
        } else {
            self.published.insert(path.to_path_buf());
        }
        let params = PublishDiagnosticsParams { uri, diagnostics, version: None };
        let _ = self.sender.send(Message::Notification(Notification::new(PublishDiagnostics::METHOD.into(), params)));
    }

    fn hover(&self, p: &HoverParams) -> Option<Hover> {
        let project = self.project.as_ref()?;
        let path = p.text_document_position_params.text_document.uri.to_file_path().ok()?;
        let fid = project.file_id_of(&path)?;
        let f = &project.files[fid as usize];
        let pos = p.text_document_position_params.position;
        let offset = LineIndex::new(&f.text).offset(&f.text, pos.line, pos.character);
        let (kind, id) = project.symbol_at(fid, offset)?;
        let mut docs: Vec<&str> = Vec::new();
        for site in project.sites(kind, &id) {
            if let Some(d) = site.doc.as_deref() {
                if !docs.contains(&d) {
                    docs.push(d);
                }
            }
        }
        let mut value = format!("**{kind}** {}", code_span(&id));
        for d in docs {
            value.push_str("\n\n---\n\n");
            value.push_str(&markdown_doc(&linked_doc(project, d)));
        }
        Some(Hover { contents: HoverContents::Markup(MarkupContent { kind: MarkupKind::Markdown, value }), range: None })
    }

    fn completion(&self, p: &CompletionParams) -> Option<CompletionResponse> {
        let pos = p.text_document_position.position;
        if let Some(items) = self.json_completion(&p.text_document_position.text_document.uri, pos) {
            return Some(CompletionResponse::List(CompletionList { is_incomplete: true, items }));
        }
        let (fid, line) = self.line_before(&p.text_document_position.text_document.uri, pos)?;
        let line = line.as_str();
        let project = self.project.as_ref()?;
        let source = ProjectSource { project, fid, line: pos.line, before: line, storage_paths: &self.storage_paths };
        let items = complete::complete(line, project.data, &project.config, &source)
            .into_iter()
            .map(|c| {
                let start = Position { line: pos.line, character: line[..c.start].encode_utf16().count() as u32 };
                CompletionItem {
                    kind: Some(match c.category {
                        Category::Keyword => CompletionItemKind::KEYWORD,
                        Category::Selector => CompletionItemKind::VARIABLE,
                        Category::Symbol => CompletionItemKind::REFERENCE,
                        Category::Folder => CompletionItemKind::FOLDER,
                        Category::Value => CompletionItemKind::VALUE,
                        Category::Property => CompletionItemKind::PROPERTY,
                        Category::Coordinates => CompletionItemKind::UNIT,
                    }),
                    // After a folder or an option name, the next part is completed at once.
                    command: (c.category == Category::Folder || c.label.ends_with('=')).then(|| Command {
                        title: "Suggest".to_string(),
                        command: "editor.action.triggerSuggest".to_string(),
                        arguments: None,
                    }),
                    detail: c.detail,
                    text_edit: Some(CompletionTextEdit::Edit(TextEdit { range: Range { start, end: pos }, new_text: c.label.clone() })),
                    label: c.label,
                    ..Default::default()
                }
            })
            .collect();
        // Candidates are filtered by the typed text here, so the client asks again as it grows.
        Some(CompletionResponse::List(CompletionList { is_incomplete: true, items }))
    }

    /// Keys and values at the cursor of a data pack JSON file; `None` for other files.
    fn json_completion(&self, uri: &Url, pos: Position) -> Option<Vec<CompletionItem>> {
        let project = self.project.as_ref()?;
        let fid = project.file_id_of(&uri.to_file_path().ok()?)?;
        let f = &project.files[fid as usize];
        let doc = &project.data.mcdoc;
        let schema = datajson::schema(f.kind, doc)?;
        let index = LineIndex::new(&f.text);
        let offset = index.offset(&f.text, pos.line, pos.character) as usize;
        let ids = |k| project.ids(k);
        let at = |offset: usize| {
            let (line, character) = index.position(&f.text, offset as u32);
            Position { line, character }
        };
        let items = datajson::complete(&f.text, offset, &schema, doc, project.data, &ids)
            .into_iter()
            .map(|s| CompletionItem {
                kind: Some(if s.key { CompletionItemKind::PROPERTY } else { CompletionItemKind::VALUE }),
                detail: s.detail,
                filter_text: Some(s.insert.clone()),
                text_edit: Some(CompletionTextEdit::Edit(TextEdit { range: Range { start: at(s.start), end: at(s.end) }, new_text: s.insert })),
                label: s.label,
                ..Default::default()
            })
            .collect();
        Some(items)
    }

    /// The function file being edited and its text up to the cursor on the cursor's line.
    fn line_before(&self, uri: &Url, pos: Position) -> Option<(FileId, String)> {
        let project = self.project.as_ref()?;
        let fid = project.file_id_of(&uri.to_file_path().ok()?)?;
        let f = &project.files[fid as usize];
        if f.kind != kind::FUNCTION {
            return None;
        }
        let index = LineIndex::new(&f.text);
        let start = index.offset(&f.text, pos.line, 0) as usize;
        let end = index.offset(&f.text, pos.line, pos.character) as usize;
        Some((fid, f.text[start..end].to_string()))
    }

    fn signature_help(&self, p: &SignatureHelpParams) -> Option<SignatureHelp> {
        let tp = &p.text_document_position_params;
        let (_, line) = self.line_before(&tp.text_document.uri, tp.position)?;
        let project = self.project.as_ref()?;
        let s = complete::signature(&line, project.data, &project.config)?;
        let parameters = s
            .parts
            .iter()
            .map(|&(a, b)| ParameterInformation { label: ParameterLabel::LabelOffsets([a as u32, b as u32]), documentation: None })
            .collect();
        Some(SignatureHelp {
            signatures: vec![SignatureInformation {
                label: s.label,
                documentation: None,
                parameters: Some(parameters),
                active_parameter: Some(s.active as u32),
            }],
            active_signature: Some(0),
            active_parameter: Some(s.active as u32),
        })
    }

    fn definition(&self, p: &GotoDefinitionParams) -> Option<GotoDefinitionResponse> {
        let project = self.project.as_ref()?;
        let tp = &p.text_document_position_params;
        let fid = project.file_id_of(&tp.text_document.uri.to_file_path().ok()?)?;
        let f = &project.files[fid as usize];
        let offset = LineIndex::new(&f.text).offset(&f.text, tp.position.line, tp.position.character);
        if let Some((file, line)) = project.link_line_at(fid, offset) {
            let uri = Url::from_file_path(&project.files[file as usize].path).ok()?;
            let at = Position { line: line - 1, character: 0 };
            return Some(GotoDefinitionResponse::Scalar(Location { uri, range: Range { start: at, end: at } }));
        }
        let (k, id) = project.symbol_at(fid, offset)?;
        let locations: Vec<Location> = project.definitions(k, &id).into_iter().filter_map(|s| location(project, s)).collect();
        if locations.is_empty() { None } else { Some(GotoDefinitionResponse::Array(locations)) }
    }

    fn references(&self, p: &ReferenceParams) -> Option<Vec<Location>> {
        let project = self.project.as_ref()?;
        let tp = &p.text_document_position;
        let fid = project.file_id_of(&tp.text_document.uri.to_file_path().ok()?)?;
        let f = &project.files[fid as usize];
        let offset = LineIndex::new(&f.text).offset(&f.text, tp.position.line, tp.position.character);
        let (k, id) = project.symbol_at(fid, offset)?;
        let mut spans = project.references(k, &id);
        if p.context.include_declaration {
            spans.extend(project.definitions(k, &id));
        }
        Some(spans.into_iter().filter_map(|s| location(project, s)).collect())
    }

    fn document_links(&self, p: &DocumentLinkParams) -> Option<Vec<DocumentLink>> {
        let project = self.project.as_ref()?;
        let fid = project.file_id_of(&p.text_document.uri.to_file_path().ok()?)?;
        let links = &project.files[fid as usize].facts.links;
        Some(
            links
                .iter()
                .filter_map(|l| {
                    let target = Some(link_target(project, &l.target.id, l.line)?);
                    Some(DocumentLink { range: location(project, (fid, l.target.start, l.target.end))?.range, target, tooltip: None, data: None })
                })
                .collect(),
        )
    }
}

fn location(project: &Project, (file, start, end): (FileId, u32, u32)) -> Option<Location> {
    let f = &project.files[file as usize];
    let index = LineIndex::new(&f.text);
    let pos = |offset: u32| {
        let (line, character) = index.position(&f.text, offset);
        Position { line, character }
    };
    Some(Location { uri: Url::from_file_path(&f.path).ok()?, range: Range { start: pos(start), end: pos(end) } })
}

/// The file of a function, with `#L<line>` for the editor to open it at that line.
fn link_target(project: &Project, id: &str, line: Option<u32>) -> Option<Url> {
    let mut url = Url::from_file_path(&project.files[project.function_file(id)? as usize].path).ok()?;
    if let Some(line) = line {
        url.set_fragment(Some(&format!("L{line}")));
    }
    Some(url)
}

/// A doc comment with its links to functions pointing at their files.
fn linked_doc(project: &Project, doc: &str) -> String {
    let mut out = doc.to_string();
    for (start, end, id, line) in mcfunction::comment_links(doc).into_iter().rev() {
        if let Some(url) = link_target(project, &id, line) {
            out.replace_range(start..end, url.as_str());
        }
    }
    out
}

/// The project's symbols and storage paths as the edited file sees them.
struct ProjectSource<'p> {
    project: &'p Project,
    fid: FileId,
    line: u32,
    before: &'p str,
    storage_paths: &'p RefCell<Option<StorageIndex>>,
}

impl complete::Source for ProjectSource<'_> {
    fn symbols(&self, k: Kind) -> Vec<String> {
        self.project.visible_ids(self.fid, k)
    }

    fn storage_paths(&self, storage: &str) -> Vec<String> {
        let mut index = self.storage_paths.borrow_mut();
        let index = index.get_or_insert_with(|| StorageIndex::build(self.project));
        let text = &self.project.files[self.fid as usize].text;
        storage_paths_while_typing(index, self.fid, text, self.line, self.before, storage)
    }
}

fn storage_paths_while_typing(index: &StorageIndex, fid: FileId, text: &str, line: u32, before: &str, storage: &str) -> Vec<String> {
    let finished = before.rfind([' ', '\t']).map_or("", |i| &before[..=i]);
    let mut kept = String::with_capacity(text.len());
    for (i, l) in text.split_inclusive('\n').enumerate() {
        if i == line as usize {
            kept.push_str(finished);
            kept.push('\n');
        } else {
            kept.push_str(l);
        }
    }
    let mut own = HashMap::new();
    complete::collect_storage_paths(&kept, &mut own);
    let mut paths = index.paths_besides(fid, storage);
    paths.extend(own.remove(storage).unwrap_or_default());
    paths.into_iter().collect()
}

/// The NBT paths that each function uses in storages, counted over all functions.
#[derive(Default)]
struct StorageIndex {
    by_file: HashMap<FileId, Vec<(String, String)>>,
    counts: HashMap<String, BTreeMap<String, u32>>,
}

impl StorageIndex {
    fn build(project: &Project) -> StorageIndex {
        let mut index = StorageIndex::default();
        for (fid, f) in project.files.iter().enumerate() {
            if f.kind == kind::FUNCTION && !f.removed {
                index.set(fid as FileId, &f.text);
            }
        }
        index
    }

    /// Replaces what the function `fid` contributes with what `text` uses.
    fn set(&mut self, fid: FileId, text: &str) {
        for (storage, path) in self.by_file.remove(&fid).unwrap_or_default() {
            if let Some(paths) = self.counts.get_mut(&storage)
                && let Some(n) = paths.get_mut(&path)
            {
                *n -= 1;
                if *n == 0 {
                    paths.remove(&path);
                }
            }
        }
        let mut found: HashMap<String, BTreeSet<String>> = HashMap::new();
        complete::collect_storage_paths(text, &mut found);
        let entries: Vec<(String, String)> =
            found.into_iter().flat_map(|(storage, paths)| paths.into_iter().map(move |p| (storage.clone(), p))).collect();
        for (storage, path) in &entries {
            *self.counts.entry(storage.clone()).or_default().entry(path.clone()).or_default() += 1;
        }
        self.by_file.insert(fid, entries);
    }

    fn paths_besides(&self, fid: FileId, storage: &str) -> BTreeSet<String> {
        let own: HashSet<&str> =
            self.by_file.get(&fid).into_iter().flatten().filter(|(s, _)| s == storage).map(|(_, p)| p.as_str()).collect();
        self.counts
            .get(storage)
            .into_iter()
            .flatten()
            .filter(|&(p, &n)| n > u32::from(own.contains(p.as_str())))
            .map(|(p, _)| p.clone())
            .collect()
    }
}

fn files_in(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut pending = vec![dir.to_path_buf()];
    let mut seen: HashSet<PathBuf> = std::fs::canonicalize(dir).into_iter().collect();
    while let Some(d) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if !p.is_dir() {
                out.push(p);
            } else if !name.starts_with('.') && name != "node_modules" && std::fs::canonicalize(&p).map_or(true, |c| seen.insert(c)) {
                pending.push(p);
            }
        }
    }
    out
}

/// Applies the changes of an incremental `didChange`, in order. Ranges are in
/// UTF-16 positions of the text as each change finds it.
fn apply_changes(text: &str, changes: Vec<TextDocumentContentChangeEvent>) -> String {
    let mut text = text.to_string();
    for change in changes {
        match change.range {
            Some(range) => {
                let index = LineIndex::new(&text);
                let start = index.offset(&text, range.start.line, range.start.character) as usize;
                let end = (index.offset(&text, range.end.line, range.end.character) as usize).max(start);
                text.replace_range(start..end, &change.text);
            }
            None => text = change.text,
        }
    }
    text
}

/// Keeps the doc's line breaks in Markdown.
fn markdown_doc(doc: &str) -> String {
    doc.lines().map(|l| format!("{}  ", l.trim_end().replace("![", "&#33;["))).collect::<Vec<_>>().join("\n")
}

fn code_span(text: &str) -> String {
    let text: String = text.chars().map(|c| if c.is_control() { c.escape_debug().to_string() } else { c.to_string() }).collect();
    let longest = text.split(|c| c != '`').map(str::len).max().unwrap_or(0);
    let fence = "`".repeat(longest + 1);
    let pad = if text.starts_with('`') || text.ends_with('`') { " " } else { "" };
    format!("{fence}{pad}{text}{pad}{fence}")
}

fn to_lsp(project: &Project, fid: FileId) -> Vec<Diagnostic> {
    let f = &project.files[fid as usize];
    let index = LineIndex::new(&f.text);
    let pos = |offset: u32| {
        let (line, character) = index.position(&f.text, offset);
        Position { line, character }
    };
    project
        .diagnostics(fid)
        .into_iter()
        .map(|d| Diagnostic {
            range: Range { start: pos(d.start), end: pos(d.end) },
            severity: Some(match d.severity {
                Severity::Error => DiagnosticSeverity::ERROR,
                Severity::Warning => DiagnosticSeverity::WARNING,
                Severity::Information => DiagnosticSeverity::INFORMATION,
                Severity::Hint => DiagnosticSeverity::HINT,
            }),
            code: Some(NumberOrString::String(d.code.to_string())),
            source: Some("mcf-linter-spark".into()),
            message: d.message,
            ..Default::default()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(range: Option<((u32, u32), (u32, u32))>, text: &str) -> TextDocumentContentChangeEvent {
        let range = range.map(|((a, b), (c, d))| Range { start: Position { line: a, character: b }, end: Position { line: c, character: d } });
        TextDocumentContentChangeEvent { range, range_length: None, text: text.to_string() }
    }

    #[test]
    fn applies_incremental_changes_in_utf16_positions() {
        let text = "say あいう\nfunction t:lib\n";
        let edits = vec![
            change(Some(((0, 5), (0, 6))), "X"),
            change(Some(((1, 11), (1, 14))), "missing"),
            change(Some(((2, 0), (2, 0))), "say end\n"),
        ];
        assert_eq!(apply_changes(text, edits), "say あXう\nfunction t:missing\nsay end\n");
        assert_eq!(apply_changes(text, vec![change(None, "whole")]), "whole");
    }

    #[test]
    fn an_image_in_a_doc_is_shown_as_a_link_in_the_hover() {
        assert_eq!(markdown_doc("Spawns a mob ![x](https://example.com/x.png)\n[lib](file:///t.mcfunction)"), "Spawns a mob &#33;[x](https://example.com/x.png)  \n[lib](file:///t.mcfunction)  ");
        assert_eq!(markdown_doc("\\![x](https://example.com/x.png)"), "\\&#33;[x](https://example.com/x.png)  ");
    }

    #[test]
    fn a_symbol_name_with_backticks_stays_in_the_code_span_of_the_hover() {
        assert_eq!(code_span("t:lib"), "`t:lib`");
        assert_eq!(code_span("a`![x](https://example.com/x.png)"), "``a`![x](https://example.com/x.png)``");
        assert_eq!(code_span("``a"), "``` ``a ```");
        assert_eq!(code_span("a\n\n![x](https://example.com/x.png)"), "`a\\n\\n![x](https://example.com/x.png)`");
    }

    #[test]
    fn storage_paths_leave_out_only_the_path_being_typed() {
        let edited = "data get storage lib: Shared\ndata get storage lib: Arr\ndata get storage lib: Own\n";
        let mut index = StorageIndex::default();
        index.set(0, edited);
        index.set(1, "data get storage lib: Array\ndata get storage lib: Shared\n");
        assert_eq!(storage_paths_while_typing(&index, 0, edited, 1, "data get storage lib: Arr", "lib:"), ["Array", "Own", "Shared"]);

        let typed_in_full = "data get storage lib: Array\n";
        index.set(0, typed_in_full);
        assert_eq!(storage_paths_while_typing(&index, 0, typed_in_full, 0, typed_in_full.trim_end(), "lib:"), ["Array", "Shared"]);

        let same_line = "execute if data storage lib: Foo run data remove storage lib: Fo";
        index.set(0, same_line);
        assert_eq!(storage_paths_while_typing(&index, 0, same_line, 0, same_line, "lib:"), ["Array", "Foo", "Shared"]);
    }
}
