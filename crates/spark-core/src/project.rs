//! A project: the data packs under one root, their files, the symbol index,
//! and the checks that need the whole project (references and visibility).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rayon::prelude::*;

use crate::config::Config;
use crate::data::VersionData;
use crate::datajson;
use crate::diag::{Diagnostic, Severity};
use crate::facts::{Kind, Ref, full_id, kind};
use crate::impdoc::{self, DefaultVisibility, SiteVisibility};
use crate::mcfunction::{self, FileFacts, Link};

pub type FileId = u32;

pub struct FileState {
    pub path: PathBuf,
    /// Path relative to the project root, with `/` separators.
    pub rel: String,
    pub kind: Kind,
    pub id: String,
    pub text: Arc<str>,
    pub facts: FileFacts,
    /// References from a function tag's `values`.
    pub tag_refs: Vec<TagEntry>,
    /// Ids in a data pack JSON file, which only need to exist: IMP-Doc is not written in JSON.
    pub json_refs: Vec<Ref>,
    /// True when `ignore` patterns exclude the file from reports.
    pub ignored: bool,
    /// True once the file has been deleted on disk.
    pub removed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TagEntry {
    pub target: Ref,
    pub required: bool,
}

#[derive(Clone, Debug)]
pub struct Site {
    pub file: FileId,
    pub visibility: SiteVisibility,
    pub doc: Option<Arc<str>>,
    pub scope: impdoc::Scope,
}

type Key = (Kind, String);

pub struct Project {
    pub root: PathBuf,
    pub config: Config,
    pub data: &'static VersionData,
    /// Files by id. A deleted file keeps its slot with `removed` set.
    pub files: Vec<FileState>,
    /// What the user should know about how the project was read, for the CLI and the editor
    /// to show once.
    pub notices: Vec<String>,
    packs: Vec<PathBuf>,
    default_visibility: DefaultVisibility,
    ignore: Vec<impdoc::Visibility>,
    index: HashMap<Key, Vec<Site>>,
    /// Files with `attached_writes` of a key, for `impDocVisibilityConflict`.
    writes: HashMap<Key, Vec<FileId>>,
    /// How many files write a key (`FileFacts::written`; empty without a `spyglass.json`).
    written: HashMap<Key, u32>,
    by_path: HashMap<String, FileId>,
    /// Which files reference a key; built only for incremental use (the editor).
    referrers: Option<HashMap<Key, HashSet<FileId>>>,
}

pub struct Options {
    /// Resource id patterns (DHP glob) whose files are analysed but not reported.
    pub ignore: Vec<String>,
    /// How many directory levels below the root are searched for data packs.
    pub max_depth: usize,
}

/// The search depth of datapack-linter (DHP 3.x): the root and two levels below it.
pub const DEFAULT_MAX_DEPTH: usize = 2;

/// The search depth when `--max-depth` is not given: DHP's, or no limit with a
/// `spyglass.json`, as the modified Spyglass finds every `pack.mcmeta`.
pub fn default_max_depth(config: &Config) -> usize {
    if config.spyglass { usize::MAX } else { DEFAULT_MAX_DEPTH }
}

/// Paths are compared case-insensitively with `\` separators, as Windows does.
fn path_key(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\").to_lowercase()
}

impl Project {
    pub fn load(root: &Path, config: Config, options: &Options) -> Result<Project, String> {
        let data = crate::data::for_version(&config.cmd_version)?;
        let packs = discover_packs(root, options.max_depth);
        let mut entries = Vec::new();
        for pack in &packs {
            collect_files(root, pack, data, &mut entries);
        }
        let ignore: Vec<impdoc::Visibility> = options
            .ignore
            .iter()
            .map(|p| impdoc::Visibility { kind: "*".into(), pattern: p.as_str().into() })
            .collect();
        let default_visibility = DefaultVisibility::from_config(&config.default_visibility);
        let files: Vec<FileState> = entries
            .into_par_iter()
            .map(|(path, rel, kind, id)| {
                let ignored = ignore.iter().any(|v| impdoc::entry_matches(v, kind, &id));
                let text: Arc<str> = if kind != kind::STRUCTURE { read_text(&path) } else { "".into() };
                let mut f = FileState { path, rel, kind, id, text, facts: FileFacts::default(), tag_refs: Vec::new(), json_refs: Vec::new(), ignored, removed: false };
                analyze_file(&mut f, data, &config);
                f
            })
            .collect();
        let by_path = files.iter().enumerate().map(|(i, f)| (path_key(&f.path), i as FileId)).collect();
        let notices = if config.version_set() { Vec::new() } else { unread_layout(root, &packs).into_iter().collect() };
        let mut project = Project {
            root: root.to_path_buf(),
            config,
            data,
            files,
            notices,
            packs,
            default_visibility,
            ignore,
            index: HashMap::new(),
            writes: HashMap::new(),
            written: HashMap::new(),
            by_path,
            referrers: None,
        };
        for fid in 0..project.files.len() as FileId {
            for (key, site) in sites_of(fid, &project.files[fid as usize]) {
                project.index.entry(key).or_default().push(site);
            }
            for (key, _) in writes_of(fid, &project.files[fid as usize]) {
                let v = project.writes.entry(key).or_default();
                if v.last() != Some(&fid) {
                    v.push(fid);
                }
            }
            for key in written_of(&project.files[fid as usize]) {
                *project.written.entry(key).or_default() += 1;
            }
        }
        Ok(project)
    }

    /// Builds the reverse reference index that the incremental updates use.
    pub fn enable_incremental(&mut self) {
        let mut referrers: HashMap<Key, HashSet<FileId>> = HashMap::new();
        for (fid, f) in self.files.iter().enumerate() {
            for r in referenced(f) {
                referrers.entry((r.kind, r.id.clone())).or_default().insert(fid as FileId);
            }
        }
        self.referrers = Some(referrers);
    }

    pub fn file_id_of(&self, path: &Path) -> Option<FileId> {
        self.by_path.get(&path_key(path)).copied().filter(|&fid| !self.files[fid as usize].removed)
    }

    pub fn files_under(&self, dir: &Path) -> Vec<FileId> {
        let prefix = path_key(dir) + "\\";
        let mut out: Vec<FileId> = self
            .by_path
            .iter()
            .filter(|(key, fid)| key.starts_with(&prefix) && !self.files[**fid as usize].removed)
            .map(|(_, fid)| *fid)
            .collect();
        out.sort();
        out
    }

    /// Replaces a file's text and re-analyses it. Returns the files whose
    /// diagnostics may have changed, including the file itself.
    pub fn set_text(&mut self, fid: FileId, text: Arc<str>) -> Vec<FileId> {
        let before = self.detach(fid);
        let f = &mut self.files[fid as usize];
        let lines = f.text.lines().count();
        f.text = text;
        analyze_file(f, self.data, &self.config);
        let after = self.attach(fid);
        let mut out = self.affected(fid, &before, &after);
        let f = &self.files[fid as usize];
        if f.kind == kind::FUNCTION
            && f.text.lines().count() != lines
            && let Some(set) = self.referrers.as_ref().and_then(|r| r.get(&(kind::FUNCTION, f.id.clone())))
        {
            let linking = |x: &FileId| !self.files[*x as usize].removed && self.files[*x as usize].facts.links.iter().any(|l| l.target.id == f.id);
            out.extend(set.iter().filter(|x| linking(x)));
            out.sort();
            out.dedup();
        }
        out
    }

    /// Adds a file created on disk. Returns its id and the affected files, or
    /// `None` when the path is not a data pack file of this project.
    pub fn add_file(&mut self, path: &Path) -> Option<(FileId, Vec<FileId>)> {
        if let Some(fid) = self.file_id_of(path) {
            let text = read_text(path);
            return Some((fid, self.set_text(fid, text)));
        }
        let pack = self.packs.iter().find(|p| path.starts_with(p.join("data")))?;
        let rel_in_data = path.strip_prefix(pack.join("data")).ok().map(to_slash)?;
        let (ns, rest) = rel_in_data.split_once('/')?;
        let (kind, id_path) = classify(rest, self.data)?;
        let id = format!("{ns}:{id_path}");
        let rel = path.strip_prefix(&self.root).map(to_slash).unwrap_or_else(|_| to_slash(path));
        let ignored = self.is_ignored(kind, &id);
        let text = if kind != kind::STRUCTURE { read_text(path) } else { "".into() };
        let mut f = FileState { path: path.to_path_buf(), rel, kind, id, text, facts: FileFacts::default(), tag_refs: Vec::new(), json_refs: Vec::new(), ignored, removed: false };
        analyze_file(&mut f, self.data, &self.config);
        let fid = self.files.len() as FileId;
        self.files.push(f);
        self.by_path.insert(path_key(path), fid);
        let after = self.attach(fid);
        Some((fid, self.affected(fid, &[], &after)))
    }

    /// Removes a file deleted on disk. Returns the affected files.
    pub fn remove_file(&mut self, fid: FileId) -> Vec<FileId> {
        let before = self.detach(fid);
        let f = &mut self.files[fid as usize];
        f.removed = true;
        f.facts = FileFacts::default();
        f.tag_refs.clear();
        f.json_refs.clear();
        let mut out = self.affected(fid, &before, &[]);
        out.retain(|&x| x != fid);
        out
    }

    /// Removes a file's sites and references from the indexes. Returns its
    /// sites and attached writes.
    fn detach(&mut self, fid: FileId) -> Vec<(Key, Site)> {
        let mut sites = sites_of(fid, &self.files[fid as usize]);
        for (key, _) in &sites {
            if let Some(v) = self.index.get_mut(key) {
                v.retain(|s| s.file != fid);
                if v.is_empty() {
                    self.index.remove(key);
                }
            }
        }
        let writes = writes_of(fid, &self.files[fid as usize]);
        for (key, _) in &writes {
            if let Some(v) = self.writes.get_mut(key) {
                v.retain(|&x| x != fid);
                if v.is_empty() {
                    self.writes.remove(key);
                }
            }
        }
        sites.extend(writes);
        for key in written_of(&self.files[fid as usize]) {
            if let Some(n) = self.written.get_mut(&key) {
                *n -= 1;
                if *n == 0 {
                    self.written.remove(&key);
                }
            }
            sites.push((key, Site { file: fid, visibility: None, doc: None, scope: impdoc::Scope::Default }));
        }
        if let Some(referrers) = self.referrers.as_mut() {
            let f = &self.files[fid as usize];
            for r in referenced(f) {
                if let Some(set) = referrers.get_mut(&(r.kind, r.id.clone())) {
                    set.remove(&fid);
                }
            }
        }
        sites
    }

    /// Adds a file's sites and references to the indexes. Returns its sites
    /// and attached writes.
    fn attach(&mut self, fid: FileId) -> Vec<(Key, Site)> {
        let mut sites = sites_of(fid, &self.files[fid as usize]);
        for (key, site) in &sites {
            self.index.entry(key.clone()).or_default().push(site.clone());
        }
        let writes = writes_of(fid, &self.files[fid as usize]);
        for (key, _) in &writes {
            let v = self.writes.entry(key.clone()).or_default();
            if !v.contains(&fid) {
                v.push(fid);
            }
        }
        sites.extend(writes);
        for key in written_of(&self.files[fid as usize]) {
            *self.written.entry(key.clone()).or_default() += 1;
            sites.push((key, Site { file: fid, visibility: None, doc: None, scope: impdoc::Scope::Default }));
        }
        if let Some(referrers) = self.referrers.as_mut() {
            let f = &self.files[fid as usize];
            for r in referenced(f) {
                referrers.entry((r.kind, r.id.clone())).or_default().insert(fid);
            }
        }
        sites
    }

    /// The file itself plus the referrers of every key whose sites changed,
    /// and, for `impDocVisibilityConflict`, the files declaring those keys.
    fn affected(&self, fid: FileId, before: &[(Key, Site)], after: &[(Key, Site)]) -> Vec<FileId> {
        let sig = |v: &[(Key, Site)]| -> Vec<(Key, Option<Vec<impdoc::Visibility>>, impdoc::Scope)> {
            let mut s: Vec<_> =
                v.iter().map(|(k, site)| (k.clone(), site.visibility.as_ref().map(|a| a.to_vec()), site.scope)).collect();
            s.sort_by(|a, b| a.0.cmp(&b.0));
            s
        };
        let (b, a) = (sig(before), sig(after));
        let mut out: HashSet<FileId> = HashSet::from([fid]);
        if b != a {
            if let Some(referrers) = &self.referrers {
                for (key, _, _) in b.iter().chain(&a) {
                    if let Some(set) = referrers.get(key) {
                        out.extend(set.iter().copied());
                    }
                }
            }
            if self.config.spyglass_rule("impDocVisibilityConflict").is_some() {
                for (key, _, _) in b.iter().chain(&a) {
                    out.extend(self.sites(key.0, &key.1).iter().map(|s| s.file));
                    out.extend(self.writes.get(key).into_iter().flatten().copied());
                }
            }
        }
        let mut out: Vec<FileId> = out.into_iter().filter(|&x| !self.files[x as usize].removed).collect();
        out.sort();
        out
    }

    /// The reference or declaration covering a byte offset of a file, if any.
    pub fn symbol_at(&self, fid: FileId, offset: u32) -> Option<(Kind, String)> {
        let f = &self.files[fid as usize];
        f.facts
            .refs
            .iter()
            .chain(f.tag_refs.iter().map(|e| &e.target))
            .chain(&f.json_refs)
            .chain(f.facts.links.iter().map(|l| &l.target))
            .chain(&f.facts.written)
            .find(|r| r.start <= offset && offset <= r.end)
            .map(|r| (r.kind, r.id.clone()))
            .or_else(|| {
                f.facts.decls.iter().find(|d| d.start <= offset && offset <= d.end).map(|d| (d.kind, d.id.clone()))
            })
            .or_else(|| {
                f.facts.function_doc.as_ref().filter(|d| d.start <= offset && offset <= d.end).map(|_| (f.kind, f.id.clone()))
            })
    }

    /// Where a symbol is declared or defined: the declaration lines, and the doc comment (or
    /// the start) of a file whose id is the symbol.
    pub fn definitions(&self, k: Kind, id: &str) -> Vec<(FileId, u32, u32)> {
        let mut out = Vec::new();
        for site in self.sites(k, id) {
            let f = &self.files[site.file as usize];
            if f.kind == k && f.id == id {
                let (start, end) = f.facts.function_doc.as_ref().map_or((0, 0), |d| (d.start, d.end));
                out.push((site.file, start, end));
            } else {
                for d in f.facts.decls.iter().filter(|d| d.kind == k && d.id == id) {
                    out.push((site.file, d.start, d.end));
                }
            }
        }
        out.sort();
        out.dedup();
        out
    }

    pub fn is_ignored(&self, kind: Kind, id: &str) -> bool {
        self.ignore.iter().any(|v| impdoc::entry_matches(v, kind, id))
    }

    /// All diagnostics of one file: its own and those of its references.
    pub fn diagnostics(&self, fid: FileId) -> Vec<Diagnostic> {
        let f = &self.files[fid as usize];
        let mut out = f.facts.diags.clone();
        let tag_refs = f.tag_refs.iter().filter(|e| e.required || self.defined(&e.target)).map(|e| &e.target);
        for r in f.facts.refs.iter().chain(tag_refs) {
            if let Some(d) = self.check_ref(f, r) {
                out.push(d);
            }
        }
        out.extend(f.json_refs.iter().filter_map(|r| self.check_json_ref(r)));
        out.extend(f.facts.links.iter().filter_map(|l| self.check_link(l)));
        out.extend(self.spyglass_imp_doc_rules(fid));
        out.sort_by_key(|d| (d.start, d.end));
        out
    }

    /// The IMP-Doc rules of the modified Spyglass, each enabled by its
    /// `impDoc*` setting in `spyglass.json`.
    fn spyglass_imp_doc_rules(&self, fid: FileId) -> Vec<Diagnostic> {
        let f = &self.files[fid as usize];
        let mut out = Vec::new();
        if self.config.spyglass_imp_doc() {
            for t in &f.facts.within_modifiers {
                let message = format!("Unknown @within modifier \"{}\" is ignored", t.text);
                out.push(Diagnostic { start: t.start, end: t.end, severity: Severity::Warning, code: "impDocWithinModifier", message });
            }
        }
        if let Some(severity) = self.config.spyglass_rule("impDocBareDeclaration") {
            for d in f.facts.decls.iter().filter(|d| d.declared && d.visibility.is_none()) {
                let message = format!(
                    "Declaration of {} “{}” owns no IMP-Doc block, so no “@public” / “@private” / “@within” annotation applies to it and the symbol is declared public; move it under a “#>” block of its own to scope it",
                    d.kind, d.id
                );
                out.push(Diagnostic { start: d.start, end: d.end, severity, code: "impDocBareDeclaration", message });
            }
        }
        if let Some(severity) = self.config.spyglass_rule("impDocPrivateBestEffort") {
            for r in &f.facts.macro_refs {
                let message = if r.kind == kind::FUNCTION && self.sites(r.kind, &r.id).is_empty() && !self.vanilla_has(r.kind, &r.id) {
                    format!("Function “{}” is referenced in a macro line but is not declared anywhere", r.id)
                } else if !self.is_visible(f, r) && !self.sites(r.kind, &r.id).is_empty() {
                    let scope = self.restriction(r.kind, &r.id).unwrap_or_else(|| "restricted".into());
                    format!("Function “{}” is {scope} and cannot be called from “{}” (referenced in a macro line)", r.id, f.id)
                } else {
                    continue;
                };
                out.push(Diagnostic { start: r.start, end: r.end, severity, code: "impDocPrivateBestEffort", message });
            }
        }
        if let Some(severity) = self.config.spyglass_rule("impDocVisibilityConflict") {
            out.extend(self.visibility_conflicts(fid, severity));
        }
        out
    }

    /// `impDocVisibilityConflict`: a symbol whose visibility sources mix public
    /// and restricted ones, reported in the symbol's owner file once per pair.
    fn visibility_conflicts(&self, fid: FileId, severity: Severity) -> Vec<Diagnostic> {
        struct Source {
            file: FileId,
            start: u32,
            end: u32,
            public: bool,
            header: bool,
        }
        fn is_public(v: &[impdoc::Visibility]) -> bool {
            v.is_empty() || v.iter().any(|e| &*e.pattern == impdoc::PUBLIC_PATTERN)
        }
        let f = &self.files[fid as usize];
        let mut keys: Vec<Key> = f
            .facts
            .decls
            .iter()
            .chain(&f.facts.attached_writes)
            .filter(|d| d.declared || d.visibility.is_some())
            .map(|d| (d.kind, d.id.clone()))
            .collect();
        if f.facts.function_doc.is_some() {
            keys.push((f.kind, f.id.clone()));
        }
        keys.sort();
        keys.dedup();
        let mut out = Vec::new();
        for key in keys {
            let mut site_files: Vec<FileId> = self
                .sites(key.0, &key.1)
                .iter()
                .map(|s| s.file)
                .chain(self.writes.get(&key).into_iter().flatten().copied())
                .collect();
            site_files.sort();
            site_files.dedup();
            let mut definition = None;
            let mut header = None;
            let mut decls = Vec::new();
            for sf in site_files {
                let g = &self.files[sf as usize];
                if key.0 == kind::FUNCTION && g.kind == kind::FUNCTION && g.id == key.1 {
                    definition = Some(sf);
                    if let Some(doc) = &g.facts.function_doc {
                        header = Some(Source { file: sf, start: 0, end: 0, public: is_public(&doc.visibility), header: true });
                    }
                }
                for d in g
                    .facts
                    .decls
                    .iter()
                    .chain(&g.facts.attached_writes)
                    .filter(|d| d.kind == key.0 && d.id == key.1 && (d.declared || d.visibility.is_some()))
                {
                    let public = d.visibility.as_deref().is_none_or(is_public);
                    decls.push(Source { file: sf, start: d.start, end: d.end, public, header: false });
                }
            }
            decls.sort_by(|a, b| (&self.files[a.file as usize].rel, a.start).cmp(&(&self.files[b.file as usize].rel, b.start)));
            let owner = definition.or_else(|| decls.first().map(|s| s.file));
            if owner != Some(fid) {
                continue;
            }
            let range = if definition.is_some() {
                (0, 0)
            } else {
                match decls.iter().find(|s| s.file == fid) {
                    Some(s) => (s.start, s.end),
                    None => continue,
                }
            };
            let sources: Vec<Source> = header.into_iter().chain(decls).collect();
            for i in 0..sources.len() {
                for j in i + 1..sources.len() {
                    let (a, b) = (&sources[i], &sources[j]);
                    if a.public == b.public {
                        continue;
                    }
                    let place = if b.header { "the function header".to_string() } else { format!("“{}”", self.files[b.file as usize].rel) };
                    let (here, there) = if a.public { ("public", "restricted") } else { ("restricted", "public") };
                    let message = format!(
                        "Visibility of “{}” is contradictory: it is declared {here} here but {there} in {place}, so the union makes it public everywhere",
                        key.1
                    );
                    out.push(Diagnostic { start: range.0, end: range.1, severity, code: "impDocVisibilityConflict", message });
                }
            }
        }
        out
    }

    /// Whether `r` resolves for `caller`. A symbol without sites that a
    /// command writes is defined with no visibility (the modified Spyglass).
    fn is_visible(&self, caller: &FileState, r: &Ref) -> bool {
        if self.vanilla_has(r.kind, &r.id) {
            return true;
        }
        let sites = self.sites(r.kind, &r.id);
        if sites.is_empty() {
            return self.written.contains_key(&(r.kind, r.id.clone()));
        }
        sites.iter().any(|s| self.site_visible_to(caller, s))
    }

    fn defined(&self, r: &Ref) -> bool {
        self.vanilla_has(r.kind, &r.id) || !self.sites(r.kind, &r.id).is_empty() || self.written.contains_key(&(r.kind, r.id.clone()))
    }

    fn site_visible_to(&self, caller: &FileState, s: &Site) -> bool {
        let def = &self.files[s.file as usize];
        impdoc::site_visible(&s.visibility, caller.kind, &caller.id, &self.default_visibility, Some((def.kind, &def.id)))
    }

    /// The ids of a kind declared or defined in the project, whatever their visibility.
    pub fn ids(&self, k: Kind) -> Vec<String> {
        let mut out: Vec<String> = self.index.keys().filter(|(key_kind, _)| *key_kind == k).map(|(_, id)| id.clone()).collect();
        out.sort();
        out
    }

    /// The ids of a kind declared or defined in the project that file `caller` may
    /// reference, by the visibility the diagnostics apply. Vanilla ids are not included.
    pub fn visible_ids(&self, caller: FileId, k: Kind) -> Vec<String> {
        let c = &self.files[caller as usize];
        let mut out: Vec<String> = self
            .index
            .iter()
            .filter(|((key_kind, _), sites)| *key_kind == k && sites.iter().any(|s| self.site_visible_to(c, s)))
            .map(|((_, id), _)| id.clone())
            .collect();
        out.extend(
            self.written
                .keys()
                .filter(|key| key.0 == k && !self.index.contains_key(*key))
                .map(|(_, id)| id.clone()),
        );
        out
    }

    /// Diagnostics of every reported file, in parallel.
    pub fn all_diagnostics(&self) -> Vec<(FileId, Vec<Diagnostic>)> {
        (0..self.files.len() as FileId)
            .into_par_iter()
            .filter(|&fid| !self.files[fid as usize].ignored && !self.files[fid as usize].removed)
            .map(|fid| (fid, self.diagnostics(fid)))
            .filter(|(_, d)| !d.is_empty())
            .collect()
    }

    pub fn sites(&self, kind: Kind, id: &str) -> &[Site] {
        self.index.get(&(kind, id.to_string())).map_or(&[], |v| v.as_slice())
    }

    fn check_ref(&self, caller: &FileState, r: &Ref) -> Option<Diagnostic> {
        if self.is_visible(caller, r) {
            return None;
        }
        let (severity, rule) = self.unresolved_severity(r.kind, &r.id)?;
        if self.config.spyglass
            && let Some(scope) = self.restriction(r.kind, &r.id)
        {
            let message = if r.kind == kind::FUNCTION {
                format!("Function “{}” is {scope} and cannot be called from “{}”", r.id, caller.id)
            } else {
                format!("Symbol “{}” in category “{}” is {scope} and cannot be referenced from “{}”", r.id, r.kind, caller.id)
            };
            return Some(Diagnostic { start: r.start, end: r.end, severity, code: "impDocPrivate", message });
        }
        if let Some(advice) = crate::args::basic::misread_id(r.kind, &r.id, self.data) {
            let message = format!("Failed to resolve {} '{}': {advice}", r.kind, r.id);
            return Some(Diagnostic { start: r.start, end: r.end, severity: Severity::Warning, code: rule.unwrap_or("unresolved"), message });
        }
        let message = format!("Failed to resolve {} '{}'", r.kind, r.id);
        Some(Diagnostic { start: r.start, end: r.end, severity, code: rule.unwrap_or("unresolved"), message })
    }

    /// How the modified Spyglass describes a restricted symbol
    /// (`describeVisibilityScope`): by the first restricting site, the
    /// definition before the declarations, and the file that owns its doc.
    fn restriction(&self, k: Kind, id: &str) -> Option<String> {
        let site = self
            .sites(k, id)
            .iter()
            .filter(|s| matches!(s.scope, impdoc::Scope::Within | impdoc::Scope::Internal | impdoc::Scope::Private))
            .min_by_key(|s| {
                let f = &self.files[s.file as usize];
                (!(f.kind == k && f.id == id), &f.rel)
            })?;
        let owner = &self.files[site.file as usize].id;
        Some(match site.scope {
            impdoc::Scope::Private => format!("private to “{owner}”"),
            impdoc::Scope::Internal => format!("internal to the namespace of “{owner}”"),
            _ => format!("restricted by “{owner}”"),
        })
    }

    /// The severity of an unresolved reference, or `None` when it is not reported.
    fn unresolved_severity(&self, k: Kind, id: &str) -> Option<(Severity, Option<&'static str>)> {
        let rule = match k {
            kind::FUNCTION => "strictFunctionCheck",
            kind::FUNCTION_TAG => "strictFunctionTagCheck",
            kind::ADVANCEMENT => "strictAdvancementCheck",
            kind::LOOT_TABLE => "strictLootTableCheck",
            kind::PREDICATE => "strictPredicateCheck",
            kind::RECIPE => "strictRecipeCheck",
            kind::BLOCK_TAG => "strictBlockTagCheck",
            kind::ENTITY_TYPE_TAG => "strictEntityTypeTagCheck",
            kind::FLUID_TAG => "strictFluidTagCheck",
            kind::ITEM_TAG => "strictItemTagCheck",
            kind::BOSSBAR => "strictBossbarCheck",
            kind::STORAGE => "strictStorageCheck",
            kind::SCORE_HOLDER => "strictScoreHolderCheck",
            kind::ENTITY_TAG => "strictTagCheck",
            kind::TEAM => "strictTeamCheck",
            kind::OBJECTIVE => {
                // DHP reports unknown objectives as warnings whatever the setting says.
                return self.config.rule("strictObjectiveCheck").map(|_| (Severity::Warning, Some("strictObjectiveCheck")));
            }
            // Since 1.21 data packs define enchantments and the like, which the rule of the
            // registry still governs.
            _ => match crate::args::registry_rule(&format!("minecraft:{k}")).filter(|_| k != "dimension_type") {
                // As `ArgCtx::check_registry` treats ids outside `minecraft:`.
                Some(rule)
                    if !id.starts_with("minecraft:")
                        && self.config.rule(rule).is_some_and(|(_, mode)| mode.as_str() == Some("only-default-namespace")) =>
                {
                    return (!self.config.spyglass).then_some((Severity::Hint, Some(rule)));
                }
                Some(rule) => rule,
                None => return Some((Severity::Hint, None)),
            },
        };
        match self.config.rule(rule) {
            Some((severity, _)) => Some((severity, Some(rule))),
            None => Some((Severity::Hint, None)),
        }
    }

    fn check_link(&self, link: &Link) -> Option<Diagnostic> {
        let r = &link.target;
        let message = match (self.function_file(&r.id), link.line) {
            (None, _) => format!("The link names no function: “{}”", r.id),
            (Some(fid), Some(line)) if line as usize > self.files[fid as usize].text.lines().count().max(1) => {
                format!("“{}” has no line {line}", r.id)
            }
            _ => return None,
        };
        Some(Diagnostic { start: r.start, end: r.end, severity: Severity::Information, code: "commentLink", message })
    }

    pub fn function_file(&self, id: &str) -> Option<FileId> {
        self.sites(kind::FUNCTION, id).iter().map(|s| s.file).find(|&f| self.files[f as usize].kind == kind::FUNCTION)
    }

    pub fn link_line_at(&self, fid: FileId, offset: u32) -> Option<(FileId, u32)> {
        let link = self.files[fid as usize].facts.links.iter().find(|l| l.target.start <= offset && offset <= l.target.end)?;
        Some((self.function_file(&link.target.id)?, link.line?))
    }

    /// Every reference to a symbol in the project, as the file and the span.
    pub fn references(&self, k: Kind, id: &str) -> Vec<(FileId, u32, u32)> {
        let mut out = Vec::new();
        for (fid, f) in self.files.iter().enumerate().filter(|(_, f)| !f.removed) {
            for r in referenced(f).chain(&f.facts.written).filter(|r| r.kind == k && r.id == id) {
                out.push((fid as FileId, r.start, r.end));
            }
        }
        out
    }

    fn check_json_ref(&self, r: &Ref) -> Option<Diagnostic> {
        let key = (r.kind, r.id.clone());
        if self.data.vanilla_json_has(r.kind, &r.id) || self.index.contains_key(&key) || self.written.contains_key(&key) {
            return None;
        }
        let (severity, rule) = self.unresolved_severity(r.kind, &r.id)?;
        let message = format!("Failed to resolve {} '{}'", r.kind, r.id);
        Some(Diagnostic { start: r.start, end: r.end, severity, code: rule.unwrap_or("unresolved"), message })
    }

    fn vanilla_has(&self, k: Kind, id: &str) -> bool {
        self.data.vanilla_json_has(k, id)
    }
}

fn analyze_file(f: &mut FileState, data: &VersionData, config: &Config) {
    if f.kind == kind::FUNCTION {
        f.facts = mcfunction::analyze(&f.text, &f.id, data, config);
        return;
    }
    if f.kind == kind::FUNCTION_TAG {
        f.tag_refs = function_tag_refs(&f.text);
    }
    f.facts = FileFacts::default();
    f.json_refs = Vec::new();
    if let Some(schema) = datajson::schema(f.kind, &data.mcdoc) {
        let checked = datajson::check(&f.text, datajson::reading(f.kind), &schema, &data.mcdoc, data);
        f.facts.diags = checked.diags;
        // A function tag's ids are its `tag_refs`, which IMP-Doc visibility applies to.
        if f.kind != kind::FUNCTION_TAG {
            f.json_refs = checked.refs;
        }
    }
}

/// Every id a file references, for the reverse index.
fn referenced(f: &FileState) -> impl Iterator<Item = &Ref> {
    f.facts.refs.iter().chain(f.tag_refs.iter().map(|e| &e.target)).chain(&f.facts.macro_refs).chain(&f.json_refs).chain(f.facts.links.iter().map(|l| &l.target))
}

pub fn read_text(path: &Path) -> Arc<str> {
    std::fs::read(path).map(|b| String::from_utf8_lossy(&b).into_owned().into()).unwrap_or_else(|_| "".into())
}

/// The declaration and definition sites a file contributes.
fn sites_of(fid: FileId, f: &FileState) -> Vec<(Key, Site)> {
    if f.removed {
        return Vec::new();
    }
    // A function file defines its id; a matching function doc gives that
    // definition its visibility. Other files define their id with no visibility.
    let (visibility, doc, scope) = match &f.facts.function_doc {
        Some(d) => (Some(d.visibility.clone()), Some(d.doc.clone()), d.scope),
        None => (None, None, impdoc::Scope::Default),
    };
    let mut out = vec![((f.kind, f.id.clone()), Site { file: fid, visibility, doc, scope })];
    for d in &f.facts.decls {
        out.push(((d.kind, d.id.clone()), Site { file: fid, visibility: d.visibility.clone(), doc: d.doc.clone(), scope: d.scope }));
    }
    out
}

fn written_of(f: &FileState) -> Vec<Key> {
    let mut keys: Vec<Key> = f.facts.written.iter().map(|r| (r.kind, r.id.clone())).collect();
    keys.sort();
    keys.dedup();
    keys
}

fn writes_of(fid: FileId, f: &FileState) -> Vec<(Key, Site)> {
    f.facts
        .attached_writes
        .iter()
        .map(|w| ((w.kind, w.id.clone()), Site { file: fid, visibility: w.visibility.clone(), doc: None, scope: w.scope }))
        .collect()
}

/// References in a function tag: `values` entries as strings or `{"id": ...}`.
fn function_tag_refs(text: &str) -> Vec<TagEntry> {
    use crate::json::{Json, Node, Reading, parse_document};
    let Ok(root) = parse_document(text, Reading::Lenient) else { return Vec::new() };
    fn field<'n>(node: &'n Node, name: &str) -> Option<&'n Node> {
        let Json::Object(members) = &node.json else { return None };
        members.iter().rev().find(|(k, _)| k == name).map(|(_, v)| v)
    }
    let Some(Json::Array(values)) = field(&root, "values").map(|v| &v.json) else { return Vec::new() };
    let mut refs = Vec::new();
    for entry in values {
        let (value, required) = match entry.json {
            Json::Object(_) => (field(entry, "id"), crate::datajson::tag_entry_required(entry)),
            _ => (Some(entry), true),
        };
        let Some(Node { json: Json::Str(raw), start, end, .. }) = value else { continue };
        let quoted = matches!(text.as_bytes().get(*start), Some(b'"' | b'\''));
        let (start, end) = if quoted { (start + 1, end - 1) } else { (*start, *end) };
        let (k, id) = match raw.strip_prefix('#') {
            Some(t) => (kind::FUNCTION_TAG, t),
            None => (kind::FUNCTION, raw.as_str()),
        };
        refs.push(TagEntry { target: Ref { kind: k, id: full_id(id), start: start as u32, end: end as u32 }, required });
    }
    refs
}

/// Directories under `root` (the root itself and up to `max_depth` levels
/// below) that contain a `data` directory and a `pack.mcmeta`. Hidden
/// directories and `node_modules` are skipped.
pub fn discover_packs(root: &Path, max_depth: usize) -> Vec<PathBuf> {
    let mut packs = Vec::new();
    let mut level = vec![root.to_path_buf()];
    for depth in 0..=max_depth {
        if level.is_empty() {
            break;
        }
        let mut next = Vec::new();
        for dir in level {
            if dir.join("pack.mcmeta").is_file() && dir.join("data").is_dir() {
                packs.push(dir.clone());
                continue;
            }
            if depth < max_depth {
                if let Ok(rd) = std::fs::read_dir(&dir) {
                    for e in rd.flatten() {
                        let p = e.path();
                        let name = e.file_name().to_string_lossy().into_owned();
                        if p.is_dir() && !name.starts_with('.') && name != "node_modules" {
                            next.push(p);
                        }
                    }
                }
            }
        }
        level = next;
    }
    packs.sort();
    packs
}

/// The directories renamed in 1.21: the name before, the one since, the kind, and the file
/// extension.
const RENAMED_DIRS: &[(&str, &str, Kind, &str)] = &[
    ("functions/", "function/", kind::FUNCTION, ".mcfunction"),
    ("tags/functions/", "tags/function/", kind::FUNCTION_TAG, ".json"),
    ("tags/blocks/", "tags/block/", kind::BLOCK_TAG, ".json"),
    ("tags/items/", "tags/item/", kind::ITEM_TAG, ".json"),
    ("tags/entity_types/", "tags/entity_type/", kind::ENTITY_TYPE_TAG, ".json"),
    ("tags/fluids/", "tags/fluid/", kind::FLUID_TAG, ".json"),
    ("tags/game_events/", "tags/game_event/", "tag/game_event", ".json"),
    ("advancements/", "advancement/", kind::ADVANCEMENT, ".json"),
    ("loot_tables/", "loot_table/", kind::LOOT_TABLE, ".json"),
    ("predicates/", "predicate/", kind::PREDICATE, ".json"),
    ("recipes/", "recipe/", kind::RECIPE, ".json"),
    ("item_modifiers/", "item_modifier/", kind::ITEM_MODIFIER, ".json"),
    ("structures/", "structure/", kind::STRUCTURE, ".nbt"),
];

/// The kind and the id-relative path of a file under `data/<ns>/`, as the version names the
/// directories.
fn classify<'a>(rel_in_ns: &'a str, data: &VersionData) -> Option<(Kind, &'a str)> {
    let singular = singular_dirs(data);
    for &(plural, single, k, ext) in RENAMED_DIRS {
        if let Some(rest) = rel_in_ns.strip_prefix(if singular { single } else { plural }) {
            return rest.strip_suffix(ext).map(|p| (k, p));
        }
    }
    // The other kinds are named by their registry, which may have several parts
    // (`worldgen/biome`): the longest leading part of the path that names one.
    let (rest, tag) = match rel_in_ns.strip_prefix("tags/") {
        Some(rest) => (rest, true),
        None => (rel_in_ns, false),
    };
    let renamed = |k: &Kind| RENAMED_DIRS.iter().any(|(_, _, r, _)| r == k);
    let mut found = None;
    for (i, _) in rest.match_indices('/') {
        let name = &rest[..i];
        let k = if tag { data.file_kind(&format!("tag/{name}")) } else { data.file_kind(name).filter(|k| !k.starts_with("tag/")) };
        if let Some(k) = k.filter(|k| !renamed(k)) {
            found = Some((k, &rest[i + 1..]));
        }
    }
    let (k, file) = found?;
    file.strip_suffix(".json").map(|p| (k, p))
}

/// Whether the version names its data pack directories in the singular (1.21 and later).
fn singular_dirs(data: &VersionData) -> bool {
    data.at_least(&[1, 21])
}

/// A notice for a pack laid out for 1.21 and later when no setting names the version, as the
/// default 1.20.4 does not read those directories.
fn unread_layout(root: &Path, packs: &[PathBuf]) -> Option<String> {
    let dir = packs.iter().find_map(|pack| {
        let namespaces = std::fs::read_dir(pack.join("data")).ok()?;
        namespaces.flatten().find_map(|ns| RENAMED_DIRS.iter().map(|(_, single, _, _)| ns.path().join(single)).find(|d| d.is_dir()))
    })?;
    let rel = to_slash(dir.strip_prefix(root).unwrap_or(&dir));
    let rel = rel.trim_end_matches('/');
    Some(format!(
        "{rel}/ is laid out for 1.21 and later, but no version is set, so the pack is read as 1.20.4 and the files under it are skipped. Set the version with datapack.env.cmdVersion in .vscode/settings.json or env.gameVersion in spyglass.json."
    ))
}

fn collect_files(root: &Path, pack: &Path, data: &VersionData, out: &mut Vec<(PathBuf, String, Kind, String)>) {
    let Ok(namespaces) = std::fs::read_dir(pack.join("data")) else { return };
    for ns in namespaces.flatten() {
        if !ns.path().is_dir() {
            continue;
        }
        let ns_name = ns.file_name().to_string_lossy().into_owned();
        let ns_root = ns.path();
        let mut stack = vec![ns_root.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            for e in rd.flatten() {
                let p = e.path();
                let Ok(ft) = e.file_type() else { continue };
                if ft.is_dir() {
                    stack.push(p);
                    continue;
                }
                let Some(rel_in_ns) = p.strip_prefix(&ns_root).ok().map(to_slash) else { continue };
                let Some((k, id_path)) = classify(&rel_in_ns, data) else { continue };
                let rel = p.strip_prefix(root).map(to_slash).unwrap_or_else(|_| to_slash(&p));
                out.push((p.clone(), rel, k, format!("{ns_name}:{id_path}")));
            }
        }
    }
}

fn to_slash(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_paths() {
        let old = crate::data::for_version("1.20.4").unwrap();
        assert_eq!(classify("functions/a/b.mcfunction", old), Some((kind::FUNCTION, "a/b")));
        assert_eq!(classify("functions/a/.mcfunction", old), Some((kind::FUNCTION, "a/")));
        assert_eq!(classify("tags/functions/load.json", old), Some((kind::FUNCTION_TAG, "load")));
        assert_eq!(classify("worldgen/biome/x.json", old), Some(("worldgen/biome", "x")));
        assert_eq!(classify("worldgen/template_pool/a/b.json", old), Some(("worldgen/template_pool", "a/b")));
        assert_eq!(classify("tags/worldgen/biome/x.json", old), Some(("tag/worldgen/biome", "x")));
        assert_eq!(classify("tags/damage_type/x.json", old), Some(("tag/damage_type", "x")));
        assert_eq!(classify("functions/readme.txt", old), None);
        assert_eq!(classify("function/a/b.mcfunction", old), None);
        assert_eq!(classify("tags/block/x.json", old), None);
        assert_eq!(classify("enchantment/x.json", old), None);

        let new = crate::data::for_version("1.21").unwrap();
        assert_eq!(classify("function/a/b.mcfunction", new), Some((kind::FUNCTION, "a/b")));
        assert_eq!(classify("tags/block/x.json", new), Some((kind::BLOCK_TAG, "x")));
        assert_eq!(classify("functions/a/b.mcfunction", new), None);
        assert_eq!(classify("damage_type/x.json", new), Some((kind::DAMAGE_TYPE, "x")));
        assert_eq!(classify("enchantment/x.json", new), Some(("enchantment", "x")));
        assert_eq!(classify("tags/enchantment/x.json", new), Some(("tag/enchantment", "x")));
        assert_eq!(classify("tag/enchantment/x.json", new), None);
        assert_eq!(classify("tag/worldgen/biome/x.json", new), None);
        assert_eq!(classify("worldgen/feature/x.json", new), None);

        let latest = crate::data::for_version("26.3").unwrap();
        assert_eq!(classify("worldgen/feature/x.json", latest), Some(("worldgen/feature", "x")));
        assert_eq!(classify("worldgen/configured_feature/x.json", latest), None);
    }

    #[test]
    fn reads_function_tag_values() {
        let refs = function_tag_refs(r##"{"values": ["a:b", "#a:t", {"id": "c:d", "required": false}, {"id": "e:f"}]}"##);
        let ids: Vec<_> = refs.iter().map(|e| (e.target.kind, e.target.id.as_str(), e.required)).collect();
        assert_eq!(
            ids,
            vec![(kind::FUNCTION, "a:b", true), (kind::FUNCTION_TAG, "a:t", true), (kind::FUNCTION, "c:d", false), (kind::FUNCTION, "e:f", true)]
        );
        assert_eq!(&r##"{"values": ["a:b""##[refs[0].target.start as usize..refs[0].target.end as usize], "a:b");
    }

    #[test]
    fn function_tags_are_read_as_leniently_as_the_game_reads_them() {
        let text = "// loaded first\n{values: ['a:b', \"#a:t\"; load]}";
        let refs = function_tag_refs(text);
        let found: Vec<_> = refs.iter().map(|e| &e.target).map(|r| (r.kind, r.id.as_str(), &text[r.start as usize..r.end as usize])).collect();
        assert_eq!(found, vec![(kind::FUNCTION, "a:b", "a:b"), (kind::FUNCTION_TAG, "a:t", "#a:t"), (kind::FUNCTION, "minecraft:load", "load")]);
    }

    #[test]
    fn visible_ids_follow_the_imp_doc_visibility() {
        let root = std::env::temp_dir().join("ai-agent").join("mcf-linter-spark-tests").join("visible_ids");
        let _ = std::fs::remove_dir_all(&root);
        let files = [
            ("pack.mcmeta", "{}"),
            ("data/t/functions/api.mcfunction", "#> t:api\n# @public\n"),
            ("data/t/functions/internal.mcfunction", "#> t:internal\n# @within function t:caller\n"),
            ("data/t/functions/caller.mcfunction", ""),
            ("data/t/functions/other.mcfunction", ""),
            (
                "data/t/functions/_index.d.mcfunction",
                "#> t:_index.d\n# @private\n\n#> holders\n# @within function t:caller\n    #declare score_holder $Secret\n",
            ),
        ];
        for (rel, text) in files {
            let path = root.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        let p = Project::load(&root, Config::default(), &Options { ignore: Vec::new(), max_depth: 0 }).unwrap();
        let fid = |rel: &str| p.files.iter().position(|f| f.rel == rel).unwrap() as FileId;
        let sorted = |mut v: Vec<String>| {
            v.sort();
            v
        };
        let caller = fid("data/t/functions/caller.mcfunction");
        let other = fid("data/t/functions/other.mcfunction");
        let functions = sorted(p.visible_ids(caller, kind::FUNCTION));
        assert!(functions.contains(&"t:api".to_string()) && functions.contains(&"t:internal".to_string()));
        let functions = sorted(p.visible_ids(other, kind::FUNCTION));
        assert!(functions.contains(&"t:api".to_string()) && !functions.contains(&"t:internal".to_string()));
        assert_eq!(p.visible_ids(caller, kind::SCORE_HOLDER), vec!["$Secret".to_string()]);
        assert!(p.visible_ids(other, kind::SCORE_HOLDER).is_empty());
    }

    #[test]
    fn a_1_21_pack_is_read_from_the_singular_directories() {
        let root = std::env::temp_dir().join("ai-agent").join("mcf-linter-spark-tests").join("singular_dirs");
        let _ = std::fs::remove_dir_all(&root);
        let files = [
            ("pack.mcmeta", "{}"),
            ("data/t/function/main.mcfunction", "function t:lib\nfunction t:old\n"),
            ("data/t/function/lib.mcfunction", "say lib\n"),
            ("data/t/functions/old.mcfunction", "say old\n"),
            ("data/t/tags/function/load.json", r#"{"values": ["t:main"]}"#),
        ];
        for (rel, text) in files {
            let path = root.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        let config = Config::from_settings(r#"{"datapack.env.cmdVersion": "1.21", "datapack.lint.strictFunctionCheck": ["error", true]}"#).unwrap();
        let p = Project::load(&root, config, &Options { ignore: Vec::new(), max_depth: 0 }).unwrap();
        let mut ids: Vec<_> = p.files.iter().map(|f| (f.kind, f.id.as_str())).collect();
        ids.sort();
        assert_eq!(ids, [(kind::FUNCTION, "t:lib"), (kind::FUNCTION, "t:main"), (kind::FUNCTION_TAG, "t:load")]);
        let unresolved: Vec<_> = reported(&p, "data/t/function/main.mcfunction").into_iter().map(|d| d.1).collect();
        assert_eq!(unresolved, ["t:old"]);
        assert!(p.notices.is_empty());

        let p = Project::load(&root, Config::default(), &Options { ignore: Vec::new(), max_depth: 0 }).unwrap();
        assert_eq!(p.files.len(), 1);
        assert_eq!(p.notices.len(), 1);
        assert!(p.notices[0].starts_with("data/t/function/ is laid out for 1.21 and later"), "{}", p.notices[0]);
    }

    #[test]
    fn every_release_checks_a_pack_laid_out_for_it() {
        for (version, _) in crate::version::RELEASES {
            let since = |v: &[u32]| crate::version::cmp(&crate::version::parse(version), v).is_ge();
            let dir = |plural: &'static str| if since(&[1, 21]) { plural.strip_suffix('s').unwrap() } else { plural };
            let predicate = if since(&[26, 3]) {
                r#"{"type": "minecraft:random_chance", "chance": 0.5}"#
            } else {
                r#"{"condition": "minecraft:random_chance", "chance": 0.5}"#
            };
            let files = [
                (format!("data/t/{}/main.mcfunction", dir("functions")), "function t:lib\nfunction #t:load\nloot give @s loot t:chest\nexecute if predicate t:p run say hi\n"),
                (format!("data/t/{}/lib.mcfunction", dir("functions")), "say lib\n"),
                (format!("data/t/tags/{}/load.json", dir("functions")), r#"{"values": ["t:lib"]}"#),
                (format!("data/t/{}/chest.json", dir("loot_tables")), r#"{"pools": []}"#),
                (format!("data/t/{}/p.json", dir("predicates")), predicate),
                ("pack.mcmeta".to_string(), "{}"),
            ];
            let root = std::env::temp_dir().join("ai-agent").join("mcf-linter-spark-tests").join(format!("release-{version}"));
            let _ = std::fs::remove_dir_all(&root);
            for (rel, text) in &files {
                let path = root.join(rel);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, text).unwrap();
            }
            let settings = format!(
                r#"{{"datapack.env.cmdVersion": "{version}", "datapack.lint.strictFunctionCheck": ["error", true], "datapack.lint.strictFunctionTagCheck": ["error", true], "datapack.lint.strictLootTableCheck": ["error", true], "datapack.lint.strictPredicateCheck": ["error", true]}}"#
            );
            let p = Project::load(&root, Config::from_settings(&settings).unwrap(), &Options { ignore: Vec::new(), max_depth: 0 }).unwrap();
            assert_eq!(p.files.len(), 5, "{version}");
            let diagnostics: Vec<_> = p.all_diagnostics().into_iter().flat_map(|(_, d)| d).map(|d| d.message).collect();
            assert!(diagnostics.is_empty(), "{version}: {diagnostics:?}");
        }
    }

    #[test]
    fn data_pack_registries_of_each_release_resolve_the_packs_own_files() {
        let check = |version: &str, files: &[(&str, &str)], main: &str| -> Vec<(&'static str, String)> {
            let root = std::env::temp_dir().join("ai-agent").join("mcf-linter-spark-tests").join(format!("registries-{version}"));
            let _ = std::fs::remove_dir_all(&root);
            for (rel, text) in files.iter().chain(&[("pack.mcmeta", "{}"), (main, "")]) {
                let path = root.join(rel);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                if !path.exists() {
                    std::fs::write(path, text).unwrap();
                }
            }
            let settings = format!(r#"{{"datapack.env.cmdVersion": "{version}", "datapack.lint.strictEnchantmentCheck": ["error", "always"]}}"#);
            let p = Project::load(&root, Config::from_settings(&settings).unwrap(), &Options { ignore: Vec::new(), max_depth: 0 }).unwrap();
            reported(&p, main).into_iter().map(|(code, text)| (code, text.to_string())).collect()
        };
        let main_1_20 = "data/t/functions/main.mcfunction";
        let reported_1_20 = check(
            "1.20.4",
            &[
                (main_1_20, "locate biome t:b\nlocate biome t:none\nenchant @s t:e\n"),
                ("data/t/worldgen/biome/b.json", "{}"),
                ("data/t/enchantment/e.json", "{}"),
            ],
            main_1_20,
        );
        assert_eq!(reported_1_20, [("unresolved", "t:none".to_string()), ("strictEnchantmentCheck", "t:e".to_string())]);

        let main = "data/t/function/main.mcfunction";
        let reported_1_21 = check(
            "1.21",
            &[
                (main, "enchant @s t:e\nenchant @s t:none\nexecute if biome ~ ~ ~ #t:b run say hi\n"),
                ("data/t/enchantment/e.json", "{}"),
                ("data/t/tags/worldgen/biome/b.json", r#"{"values": []}"#),
            ],
            main,
        );
        assert_eq!(reported_1_21, [("strictEnchantmentCheck", "t:none".to_string())]);

        let reported_26_3 = check(
            "26.3",
            &[
                (main, "place feature t:f\nplace feature t:none\ndialog show @s t:d\ndialog show @s minecraft:server_links\n"),
                ("data/t/worldgen/feature/f.json", "{}"),
                ("data/t/dialog/d.json", "{}"),
            ],
            main,
        );
        assert_eq!(reported_26_3, [("unresolved", "t:none".to_string())]);
    }

    #[test]
    fn ids_of_26_3_written_as_old_slots_or_numbers_are_warnings_unless_a_pack_defines_them() {
        let root = std::env::temp_dir().join("ai-agent").join("mcf-linter-spark-tests").join("misread-ids");
        let _ = std::fs::remove_dir_all(&root);
        let main = "data/t/function/main.mcfunction";
        let lines = [
            "item replace entity @s horse.saddle with stone",
            "item replace entity @s minecraft:horse.armor with stone",
            "execute if items entity @s villager.7 * run say a",
            "execute if items entity @s minecraft:weapon.mainhand * run say a",
            "compute default integer -1",
            "compute default float 1.5",
            "compute default float 2d",
            "compute default integer 3b",
            "item replace entity @s villager.3 with stone",
            "item replace entity @s villager.8 with stone",
            "compute default integer t:none",
            "test locate t:x",
            "item replace entity @s saddle with stone",
            "execute if items entity @s mob.inventory.7 * run say a",
            "compute default integer {type:\"minecraft:constant\",value:-1}",
            "compute default float {type:\"minecraft:constant\",value:1.5f}",
        ];
        let text = lines.join("\n") + "\n";
        for (rel, text) in [("pack.mcmeta", "{}"), (main, text.as_str()), ("data/minecraft/slot_source/villager.3.json", "{}")] {
            let path = root.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        let config = Config::from_settings(r#"{"datapack.env.cmdVersion": "26.3"}"#).unwrap();
        let p = Project::load(&root, config, &Options { ignore: Vec::new(), max_depth: 0 }).unwrap();
        let fid = p.files.iter().position(|f| f.rel == main).unwrap() as FileId;
        let found: Vec<_> = p.diagnostics(fid).into_iter().map(|d| (d.severity, d.message)).collect();
        let warning = |m: &str| (Severity::Warning, m.to_string());
        let hint = |m: &str| (Severity::Hint, m.to_string());
        assert_eq!(
            found,
            [
                warning("Failed to resolve slot_source 'minecraft:horse.saddle': 'horse.saddle' is no longer a slot, so it is read as an id. The slot is now 'saddle'"),
                warning("Failed to resolve slot_source 'minecraft:horse.armor': 'horse.armor' is no longer a slot, so it is read as an id. The slot is now 'armor.body'"),
                warning("Failed to resolve slot_source 'minecraft:villager.7': 'villager.7' is no longer a slot, so it is read as an id. The slot is now 'mob.inventory.7'"),
                warning("Failed to resolve slot_source 'minecraft:weapon.mainhand': a slot with a namespace is read as an id. Write the slot as 'weapon.mainhand'"),
                warning("Failed to resolve context_int_provider 'minecraft:-1': a number here is read as an id. Write a constant as {type:\"minecraft:constant\",value:-1}"),
                warning("Failed to resolve context_float_provider 'minecraft:1.5': a number here is read as an id. Write a constant as {type:\"minecraft:constant\",value:1.5f}"),
                warning("Failed to resolve context_float_provider 'minecraft:2d': a number here is read as an id. Write a constant as {type:\"minecraft:constant\",value:2f}"),
                warning("Failed to resolve context_int_provider 'minecraft:3b': a number here is read as an id. Write a constant as {type:\"minecraft:constant\",value:3}"),
                hint("Failed to resolve slot_source 'minecraft:villager.8'"),
                hint("Failed to resolve context_int_provider 't:none'"),
                hint("Failed to resolve test_instance 't:x'"),
            ]
        );
    }

    #[test]
    fn a_missing_dimension_type_is_a_hint_whatever_the_registry_rule() {
        let root = std::env::temp_dir().join("ai-agent").join("mcf-linter-spark-tests").join("dimension_type");
        let _ = std::fs::remove_dir_all(&root);
        let dimension = r#"{"type": "t:missing", "generator": {"type": "minecraft:flat", "settings": {"layers": [], "biome": "minecraft:plains"}}}"#;
        for (rel, text) in [("pack.mcmeta", "{}"), ("data/t/dimension/d.json", dimension)] {
            let path = root.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        let config = Config::from_settings(r#"{"datapack.lint.strictDimensionTypeCheck": ["error", "always"]}"#).unwrap();
        let p = Project::load(&root, config, &Options { ignore: Vec::new(), max_depth: 0 }).unwrap();
        let codes: Vec<_> = reported(&p, "data/t/dimension/d.json").into_iter().map(|d| d.0).collect();
        assert!(codes.contains(&"unresolved") && !codes.contains(&"strictDimensionTypeCheck"), "{codes:?}");
    }

    /// A pack written under the temp directory, with the IMP-Doc rules of the
    /// modified Spyglass enabled.
    fn spyglass_project(name: &str, files: &[(&str, &str)]) -> Project {
        let root = std::env::temp_dir().join("ai-agent").join("mcf-linter-spark-tests").join(name);
        let _ = std::fs::remove_dir_all(&root);
        for (rel, text) in files.iter().chain(&[("pack.mcmeta", "{}")]) {
            let path = root.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        let mut config = Config::default();
        config
            .merge_spyglass(r#"{"lint": {"impDocVisibilityConflict": "warning", "impDocBareDeclaration": "warning", "impDocPrivateBestEffort": "warning"}}"#)
            .unwrap();
        Project::load(&root, config, &Options { ignore: Vec::new(), max_depth: 0 }).unwrap()
    }

    fn reported<'a>(p: &'a Project, rel: &str) -> Vec<(&'static str, &'a str)> {
        let fid = p.files.iter().position(|f| f.rel == rel).unwrap() as FileId;
        let text = &p.files[fid as usize].text;
        p.diagnostics(fid).into_iter().map(|d| (d.code, &text[d.start as usize..d.end as usize])).collect()
    }

    #[test]
    fn writes_under_a_doc_block_conflict_with_restricted_declarations() {
        let p = spyglass_project(
            "conflict-writes",
            &[
                (
                    "data/a/functions/load.mcfunction",
                    "#> a:load\n# @public\n\n#> init\n    scoreboard players set $X Global 0\n    execute unless data storage b: _ run say hi\n\nscoreboard players set $Y Global 0\n",
                ),
                (
                    "data/b/functions/_index.d.mcfunction",
                    "#> b:_index.d\n# @private\n\n#> Val\n# @within function a:load\n    #declare score_holder $X\n    #declare score_holder $Y\n    #declare storage b:\n",
                ),
            ],
        );
        let codes: Vec<_> = reported(&p, "data/a/functions/load.mcfunction").into_iter().filter(|d| d.0 == "impDocVisibilityConflict").collect();
        assert_eq!(codes, [("impDocVisibilityConflict", "$X"), ("impDocVisibilityConflict", "b:")]);
    }

    #[test]
    fn a_written_symbol_resolves_with_a_spyglass_json() {
        let text = "data get storage a:x V\ndata modify storage b:s V set value 1\nscoreboard players set $A O 1\nscoreboard players get $A O\nscoreboard players get $B O\n";
        let p = spyglass_project(
            "written",
            &[
                ("data/a/functions/f.mcfunction", text),
                ("data/b/functions/_index.d.mcfunction", "#> b:_index.d\n# @private\n\n#> v\n# @within function b:**\n    #declare storage b:s\n"),
            ],
        );
        let unresolved: Vec<_> = reported(&p, "data/a/functions/f.mcfunction").into_iter().filter(|d| d.0 == "unresolved").map(|d| d.1).collect();
        assert_eq!(unresolved, ["$B"]);
    }

    #[test]
    fn restricted_references_are_worded_as_the_modified_spyglass_does() {
        let p = spyglass_project(
            "restricted-messages",
            &[
                ("data/a/functions/private.mcfunction", "#> a:private\n# @private\n\nsay hi\n"),
                ("data/a/functions/within.mcfunction", "#> a:within\n# @within function a:x\n\nsay hi\n"),
                ("data/a/functions/internal.mcfunction", "#> a:internal\n# @internal\n\nsay hi\n"),
                ("data/b/functions/caller.mcfunction", "function a:private\nfunction a:within\nfunction a:internal\n"),
            ],
        );
        let fid = p.files.iter().position(|f| f.rel == "data/b/functions/caller.mcfunction").unwrap() as FileId;
        let messages: Vec<String> = p.diagnostics(fid).into_iter().filter(|d| d.code == "impDocPrivate").map(|d| d.message).collect();
        assert_eq!(
            messages,
            [
                "Function “a:private” is private to “a:private” and cannot be called from “b:caller”",
                "Function “a:within” is restricted by “a:within” and cannot be called from “b:caller”",
                "Function “a:internal” is internal to the namespace of “a:internal” and cannot be called from “b:caller”",
            ]
        );
    }

    #[test]
    fn a_function_that_loses_the_linked_line_rechecks_the_link() {
        let mut p = spyglass_project(
            "link-recheck",
            &[
                ("data/t/functions/a.mcfunction", "# [b](t:b#L3)\nsay a\n"),
                ("data/t/functions/b.mcfunction", "say 1\nsay 2\nsay 3\n"),
                ("data/t/functions/c.mcfunction", "function t:b\n"),
            ],
        );
        p.enable_incremental();
        let fid = |p: &Project, rel: &str| p.files.iter().position(|f| f.rel == rel).unwrap() as FileId;
        let (a, b, c) = (fid(&p, "data/t/functions/a.mcfunction"), fid(&p, "data/t/functions/b.mcfunction"), fid(&p, "data/t/functions/c.mcfunction"));
        let affected = p.set_text(b, "say 1\n".into());
        assert!(affected.contains(&a) && !affected.contains(&c), "{affected:?}");
        assert_eq!(reported(&p, "data/t/functions/a.mcfunction"), [("commentLink", "t:b#L3")]);
    }

    #[test]
    fn an_edit_that_only_changes_the_scope_rewords_the_referrers() {
        let mut p = spyglass_project(
            "scope-edit",
            &[
                ("data/a/functions/f.mcfunction", "#> a:f\n# @private\n\nsay hi\n"),
                ("data/b/functions/caller.mcfunction", "function a:f\n"),
            ],
        );
        p.enable_incremental();
        let fid = |p: &Project, rel: &str| p.files.iter().position(|f| f.rel == rel).unwrap() as FileId;
        let (target, caller) = (fid(&p, "data/a/functions/f.mcfunction"), fid(&p, "data/b/functions/caller.mcfunction"));
        let affected = p.set_text(target, "#> a:f\n# @within function a:f\n\nsay hi\n".into());
        assert!(affected.contains(&caller));
        let messages: Vec<String> = p.diagnostics(caller).into_iter().map(|d| d.message).collect();
        assert_eq!(messages, ["Function “a:f” is restricted by “a:f” and cannot be called from “b:caller”"]);
    }

    #[test]
    fn within_everything_is_restricted_for_conflicts() {
        let p = spyglass_project(
            "conflict-within-all",
            &[
                ("data/a/functions/buff.mcfunction", "#> a:buff\n# @public\n\n#>buff\n    data modify storage api: ID set value 1\n"),
                ("data/minecraft/functions/declares.d.mcfunction", "#> minecraft:declares.d\n# @private\n\n#> declare\n# @within **\n    #declare storage api:\n"),
            ],
        );
        let codes: Vec<_> = reported(&p, "data/a/functions/buff.mcfunction").into_iter().filter(|d| d.0 == "impDocVisibilityConflict").collect();
        assert_eq!(codes, [("impDocVisibilityConflict", "api:")]);
    }

    #[test]
    fn commands_and_json_ids_are_references_to_functions() {
        let p = spyglass_project(
            "references",
            &[
                ("data/t/functions/a.mcfunction", "function t:b\n"),
                ("data/t/functions/b.mcfunction", "say 1\n"),
                ("data/t/advancements/x.json", r#"{"criteria": {"a": {"trigger": "minecraft:tick"}}, "rewards": {"function": "t:b"}}"#),
            ],
        );
        assert_eq!(p.references(kind::FUNCTION, "t:b").len(), 2);
        let json = p.files.iter().position(|f| f.rel == "data/t/advancements/x.json").unwrap() as FileId;
        let at = p.files[json as usize].text.find("t:b").unwrap() as u32;
        assert_eq!(p.symbol_at(json, at + 1), Some((kind::FUNCTION, "t:b".to_string())));
    }

    #[test]
    fn a_missing_optional_function_tag_entry_is_not_reported() {
        let p = spyglass_project(
            "optional-tag-entries",
            &[
                ("data/t/functions/private.mcfunction", "#> t:private\n# @private\n\nsay hi\n"),
                (
                    "data/t/tags/functions/load.json",
                    r##"{"values": [{"id": "t:missing", "required": false}, {"id": "#t:no_tag", "required": false}, {"id": "t:private", "required": false}, "t:missing2"]}"##,
                ),
            ],
        );
        let fid = p.files.iter().position(|f| f.rel == "data/t/tags/functions/load.json").unwrap() as FileId;
        let messages: Vec<String> = p.diagnostics(fid).into_iter().map(|d| d.message).collect();
        assert_eq!(
            messages,
            ["Function “t:private” is private to “t:private” and cannot be called from “t:load”", "Failed to resolve function 't:missing2'"]
        );
        assert_eq!(p.references(kind::FUNCTION, "t:missing").len(), 1);
    }

    #[test]
    fn comment_links_name_a_function_and_a_line_it_has() {
        let p = spyglass_project(
            "comment-links",
            &[
                ("data/t/functions/a.mcfunction", "# see [b](t:b#L2), [far](t:b#L9), [gone](t:none), [web](https://example.com/a)\nsay a\n"),
                ("data/t/functions/b.mcfunction", "say 1\nsay 2\n"),
            ],
        );
        assert_eq!(reported(&p, "data/t/functions/a.mcfunction"), [("commentLink", "t:b#L9"), ("commentLink", "t:none")]);
        assert_eq!(p.references(kind::FUNCTION, "t:b").len(), 2);
    }

    #[test]
    fn a_comment_link_with_a_line_leads_to_that_line() {
        let p = spyglass_project(
            "comment-link-line",
            &[
                ("data/t/functions/a.mcfunction", "# [b](t:b#L2) [top](t:b)\nsay a\n"),
                ("data/t/functions/b.mcfunction", "say 1\nsay 2\n"),
            ],
        );
        let a = p.file_id_of(&p.root.join("data/t/functions/a.mcfunction")).unwrap();
        let b = p.function_file("t:b").unwrap();
        let text = &p.files[a as usize].text;
        assert_eq!(p.link_line_at(a, text.find("t:b#").unwrap() as u32 + 1), Some((b, 2)));
        assert_eq!(p.link_line_at(a, text.find("t:b)").unwrap() as u32 + 1), None);
    }
}
