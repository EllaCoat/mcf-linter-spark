//! Analysis of one `.mcfunction` file: commands, comments, macro lines, IMP-Doc.

use std::sync::Arc;

use crate::command::{Effect, parse_command};
use crate::config::Config;
use crate::data::VersionData;
use crate::diag::{Diagnostic, Severity};
use crate::facts::{Kind, Ref, full_id, kind};
use crate::impdoc::{self, DocComment, Scope, SiteVisibility, Token, Visibility};

/// A declaration (`#declare`) or definition (`scoreboard objectives add`, a
/// function file) site.
#[derive(Clone, Debug)]
pub struct Decl {
    pub kind: Kind,
    pub id: String,
    pub start: u32,
    pub end: u32,
    pub visibility: SiteVisibility,
    pub doc: Option<Arc<str>>,
    /// True for `#declare` / `#define`; false for a definition by a command.
    pub declared: bool,
    pub scope: Scope,
}

/// The `#> <id>` doc comment at the top of a function file whose id matches the file.
#[derive(Clone, Debug)]
pub struct FunctionDoc {
    pub visibility: Arc<[Visibility]>,
    pub scope: Scope,
    pub doc: Arc<str>,
    pub start: u32,
    pub end: u32,
}

#[derive(Default, Debug)]
pub struct FileFacts {
    pub diags: Vec<Diagnostic>,
    pub refs: Vec<Ref>,
    pub decls: Vec<Decl>,
    pub function_doc: Option<FunctionDoc>,
    /// `function <id>` written in macro lines, which the game parses only when run.
    pub macro_refs: Vec<Ref>,
    /// Modifiers such as `@readonly` after `@within` (dropped when the
    /// modified Spyglass's IMP-Doc rules are enabled).
    pub within_modifiers: Vec<Token>,
    /// `Effect::Write` references attached to a doc block, which the modified
    /// Spyglass counts as declarations with the block's visibility. Collected
    /// only when its IMP-Doc rules are enabled; DHP resolution ignores them.
    pub attached_writes: Vec<Decl>,
    /// With a `spyglass.json`, the `Effect::Write` references. The modified
    /// Spyglass binds them as definitions: they define their symbol and are not
    /// checked as references. Without one they are in `refs`.
    pub written: Vec<Ref>,
    /// Links in comments to a function and maybe a line of it.
    pub links: Vec<Link>,
}

/// `[text](namespace:path#L12)` in a comment: the target is a function, the line 1-based.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Link {
    /// The function, spanning the target inside the parentheses.
    pub target: Ref,
    pub line: Option<u32>,
}

/// The Markdown links to functions in `text`: the span of each target inside the
/// parentheses, the function id, and the line. URLs and other targets are not links here.
pub fn comment_links(text: &str) -> Vec<(usize, usize, String, Option<u32>)> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(k) = text[from..].find("](") {
        let open = from + k + 2;
        from = open;
        if !text[..open - 2].contains('[') {
            continue;
        }
        let Some(len) = text[open..].find(')') else { break };
        let target = &text[open..open + len];
        let (id, line) = match target.split_once("#L") {
            Some((id, n)) => match n.parse::<u32>() {
                Ok(n) if n > 0 => (id, Some(n)),
                _ => continue,
            },
            None => (target, None),
        };
        let Some((ns, path)) = id.split_once(':') else { continue };
        let valid = !ns.is_empty()
            && !path.contains("//")
            && ns.bytes().all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-' | b'.'))
            && path.bytes().all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-' | b'.' | b'/'));
        if valid {
            out.push((open, open + len, id.to_string(), line));
        }
        from = open + len;
    }
    out
}

struct Attached {
    vis: Arc<[Visibility]>,
    doc: Arc<str>,
    scope: Scope,
}

struct Line<'a> {
    start: usize,
    text: &'a str,
    /// Whether a line break follows the line in the file.
    eol: bool,
}

impl Line<'_> {
    /// Leading spaces and tabs.
    fn indent(&self) -> usize {
        self.text.len() - self.text.trim_start_matches([' ', '\t']).len()
    }
}

fn split_lines(text: &str) -> Vec<Line<'_>> {
    let mut lines = Vec::new();
    let mut start = 0;
    for (i, b) in text.bytes().enumerate() {
        if b == b'\n' {
            let end = if i > start && text.as_bytes()[i - 1] == b'\r' { i - 1 } else { i };
            lines.push(Line { start, text: &text[start..end], eol: true });
            start = i + 1;
        }
    }
    if start < text.len() {
        let t = &text[start..];
        lines.push(Line { start, text: t.strip_suffix('\r').unwrap_or(t), eol: false });
    }
    lines
}

pub fn analyze(text: &str, file_id: &str, data: &VersionData, config: &Config) -> FileFacts {
    let lines = split_lines(text);
    let mut a = Analyzer { data, config, file_id, facts: FileFacts::default() };
    let mut i = 0;
    while i < lines.len() {
        let line = &lines[i];
        let content = &line.text[line.indent()..];
        if content.starts_with("#>") {
            // A function doc only when nothing but spaces or tabs precede it in the file.
            let is_function_doc = i == 0;
            let (doc, next, indent_before_last_hash) = parse_doc(&lines, i, is_function_doc);
            if is_function_doc {
                a.function_doc(&lines[i], &doc);
                i = next;
                continue;
            }
            let (vis, errors, modifiers) = doc.visibility(file_id, config.spyglass_imp_doc());
            for (s, e, m) in errors {
                a.diag(s, e, Severity::Error, "impDoc", m);
            }
            a.facts.within_modifiers.extend(modifiers);
            let attached = Attached { vis: vis.into(), doc: doc.display().into(), scope: doc.scope() };
            let mut j = next;
            if j < lines.len() {
                a.line(&lines[j], Some(&attached));
                if lines[j].indent() > indent_before_last_hash {
                    j += 1;
                    while j < lines.len() && lines[j].indent() > indent_before_last_hash {
                        a.line(&lines[j], Some(&attached));
                        j += 1;
                    }
                    j -= 1;
                }
                j += 1;
            }
            i = j;
            continue;
        }
        a.line(line, None);
        i += 1;
    }
    for line in &lines {
        let indent = line.indent();
        if line.text[indent..].starts_with('#') {
            for (s, e, id, at) in comment_links(&line.text[indent..]) {
                let (start, end) = ((line.start + indent + s) as u32, (line.start + indent + e) as u32);
                a.facts.links.push(Link { target: Ref { kind: kind::FUNCTION, id, start, end }, line: at });
            }
        }
    }
    a.facts
}

/// Parses the doc block starting at `lines[i]`. Returns the doc, the index of the
/// first line after the block, and the indentation of the last `#` line.
fn parse_doc(lines: &[Line], i: usize, is_function_doc: bool) -> (DocComment, usize, usize) {
    let mut doc = DocComment::default();
    if !is_function_doc {
        let first = &lines[i];
        let after = first.text[first.indent() + 2..].trim_start_matches([' ', '\t']);
        doc.plain_text.push_str(after);
        doc.plain_text.push('\n');
    }
    let mut indent_before_last_hash = 0;
    let mut j = i + 1;
    while j < lines.len() {
        let line = &lines[j];
        let ws = line.indent();
        let rest = &line.text[ws..];
        let b = rest.as_bytes();
        // DHP's `isWhiteSpace` counts line breaks, so a bare `#` line continues the doc.
        let continues = match b.get(1) {
            Some(b' ' | b'\t' | b'@') => true,
            None => line.eol,
            _ => false,
        };
        if b.first() == Some(&b'#') && continues {
            indent_before_last_hash = ws;
            let after_hash = ws + 1;
            let content_start = after_hash + (rest[1..].len() - rest[1..].trim_start_matches([' ', '\t']).len());
            if line.text.as_bytes().get(content_start) == Some(&b'@') {
                let mut annos = Vec::new();
                let indent = content_start - after_hash;
                parse_annotation(lines, &mut j, content_start, indent, &mut annos);
                for anno in annos {
                    flatten(&anno, &mut Vec::new(), &mut doc.annotations);
                }
            } else {
                doc.plain_text.push_str(&line.text[content_start..]);
                doc.plain_text.push('\n');
            }
            j += 1;
        } else {
            break;
        }
    }
    (doc, j, indent_before_last_hash)
}

struct Anno {
    value: Token,
    children: Vec<Anno>,
}

/// DHP's `parseAnnotations`: a value, then either more values on the same line
/// (children) or child lines indented by at least two more spaces.
fn parse_annotation(lines: &[Line], li: &mut usize, pos: usize, indent: usize, out: &mut Vec<Anno>) {
    let line = &lines[*li];
    let end = line.text[pos..].find(' ').map_or(line.text.len(), |k| pos + k);
    let value = Token {
        text: line.text[pos..end].to_string(),
        start: (line.start + pos) as u32,
        end: (line.start + end) as u32,
    };
    let mut anno = Anno { value, children: Vec::new() };
    if line.text.as_bytes().get(end) == Some(&b' ') {
        let next = end + (line.text[end..].len() - line.text[end..].trim_start_matches([' ', '\t']).len());
        parse_annotation(lines, li, next, indent, &mut anno.children);
    } else {
        while *li + 1 < lines.len() {
            let next_line = &lines[*li + 1];
            let ws = next_line.indent();
            if next_line.text.as_bytes().get(ws) != Some(&b'#') {
                break;
            }
            let indent_start = ws + 1;
            let indent_end = indent_start
                + (next_line.text[indent_start..].len() - next_line.text[indent_start..].trim_start_matches([' ', '\t']).len());
            let extra = if indent_start + indent < indent_end { &next_line.text[indent_start + indent..indent_end] } else { "" };
            let width: usize = extra.chars().map(|c| if c == '\t' { 2 } else { 1 }).sum();
            if width < 2 {
                break;
            }
            *li += 1;
            parse_annotation(lines, li, indent_end, indent_end - indent_start, &mut anno.children);
        }
    }
    out.push(anno);
}

fn flatten(anno: &Anno, prefix: &mut Vec<Token>, out: &mut Vec<Vec<Token>>) {
    prefix.push(anno.value.clone());
    if anno.children.is_empty() {
        out.push(prefix.clone());
    } else {
        for c in &anno.children {
            flatten(c, prefix, out);
        }
    }
    prefix.pop();
}

struct Analyzer<'a> {
    data: &'a VersionData,
    config: &'a Config,
    file_id: &'a str,
    facts: FileFacts,
}

impl Analyzer<'_> {
    fn diag(&mut self, start: u32, end: u32, severity: Severity, code: &'static str, message: impl Into<String>) {
        self.facts.diags.push(Diagnostic { start, end, severity, code, message: message.into() });
    }

    fn function_doc(&mut self, line: &Line, doc: &DocComment) {
        let ws = line.indent();
        let after = ws + 2 + (line.text[ws + 2..].len() - line.text[ws + 2..].trim_start_matches([' ', '\t']).len());
        let end = line.text[after..].find([' ', '\t']).map_or(line.text.len(), |k| after + k);
        let id = &line.text[after..end];
        if id.is_empty() || full_id(id) != self.file_id {
            return;
        }
        let (vis, errors, modifiers) = doc.visibility(self.file_id, self.config.spyglass_imp_doc());
        for (s, e, m) in errors {
            self.diag(s, e, Severity::Error, "impDoc", m);
        }
        self.facts.within_modifiers.extend(modifiers);
        self.facts.function_doc = Some(FunctionDoc {
            visibility: vis.into(),
            scope: doc.scope(),
            doc: doc.display().into(),
            start: (line.start + after) as u32,
            end: (line.start + end) as u32,
        });
    }

    /// One line outside a doc block, or a command attached to a doc block.
    fn line(&mut self, line: &Line, attached: Option<&Attached>) {
        let ws = line.indent();
        let content = line.text[ws..].trim_end_matches([' ', '\t']);
        if content.is_empty() {
            return;
        }
        let base = (line.start + ws) as u32;
        if let Some(rest) = strip_keyword(content, "#declare").or_else(|| strip_keyword(content, "#define")) {
            let kw_len = content.len() - rest.len();
            self.declaration(rest, base + kw_len as u32, attached);
            return;
        }
        if content.starts_with('#') {
            return;
        }
        if let Some(body) = content.strip_prefix('$') {
            self.macro_line(body, base + 1);
            return;
        }
        let result = parse_command(content, base, self.data, self.config);
        if let Some(e) = result.error {
            self.diag(e.start, e.end, Severity::Error, "syntax", e.message);
        }
        for effect in result.effects {
            match effect {
                Effect::Diag(d) => self.facts.diags.push(d),
                Effect::Ref(r) => self.facts.refs.push(r),
                Effect::Write(r) => {
                    if let Some(a) = attached.filter(|_| self.config.spyglass_imp_doc()) {
                        self.facts.attached_writes.push(Decl {
                            kind: r.kind,
                            id: r.id.clone(),
                            start: r.start,
                            end: r.end,
                            visibility: Some(a.vis.clone()),
                            doc: Some(a.doc.clone()),
                            declared: false,
                            scope: a.scope,
                        });
                    }
                    if self.config.spyglass { self.facts.written.push(r) } else { self.facts.refs.push(r) }
                }
                Effect::Def(d) => self.facts.decls.push(Decl {
                    kind: d.kind,
                    id: d.id,
                    start: d.start,
                    end: d.end,
                    visibility: attached.map(|a| a.vis.clone()),
                    doc: attached.map(|a| a.doc.clone()),
                    declared: false,
                    scope: attached.map_or(Scope::Default, |a| a.scope),
                }),
            }
        }
    }

    /// `#declare <type> <id> [description]`; `rest` starts after the keyword.
    /// A malformed one is a plain comment, as DHP's `CommandParser` turns a `#`
    /// line that fails to parse into a comment without reporting the errors.
    fn declaration(&mut self, rest: &str, rest_base: u32, attached: Option<&Attached>) {
        let Some(rest) = rest.strip_prefix(' ') else { return };
        let type_end = rest.find(' ').unwrap_or(rest.len());
        let ty = &rest[..type_end];
        let type_start = rest_base + 1;
        let Some(kind) = impdoc::declarable_type(ty) else { return };
        let after_type = &rest[type_end..];
        let id_start = type_start + type_end as u32 + 1;
        let id = after_type.strip_prefix(' ').map(|s| &s[..s.find(' ').unwrap_or(s.len())]).unwrap_or("");
        if id.is_empty() {
            return;
        }
        let id_text = if impdoc::is_namespaced_type(kind) { full_id(id) } else { id.to_string() };
        self.facts.decls.push(Decl {
            kind,
            id: id_text,
            start: id_start,
            end: id_start + id.len() as u32,
            visibility: attached.map(|a| a.vis.clone()),
            doc: attached.map(|a| a.doc.clone()),
            declared: true,
            scope: attached.map_or(Scope::Default, |a| a.scope),
        });
    }

    /// Checks `$(name)` like `StringTemplate.fromString`.
    fn macro_line(&mut self, body: &str, base: u32) {
        let mut count = 0;
        let mut pos = 0;
        while let Some(k) = body[pos..].find("$(") {
            let open = pos + k;
            let Some(close_rel) = body[open + 2..].find(')') else {
                self.diag(base + open as u32, base + body.len() as u32, Severity::Error, "macro", "Unterminated macro variable");
                return;
            };
            let close = open + 2 + close_rel;
            let name = &body[open + 2..close];
            if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
                self.diag(base + open as u32, base + close as u32 + 1, Severity::Error, "macro", format!("Invalid macro variable name '{name}'"));
            }
            count += 1;
            pos = close + 1;
        }
        if count == 0 {
            self.diag(base - 1, base + body.len() as u32, Severity::Error, "macro", "Macro line without variables");
        }
        self.macro_function_refs(body, base);
    }

    /// `function <id>` in a macro line, as the modified Spyglass finds them:
    /// ids that continue with `$(` are built at run time and skipped.
    fn macro_function_refs(&mut self, body: &str, base: u32) {
        static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        let re = RE.get_or_init(|| {
            regex::Regex::new(r"\bfunction[\t ]+(#?[A-Za-z0-9_.\-]+:[A-Za-z0-9_.\-/]+|#?[A-Za-z0-9_.\-/]+)").expect("valid pattern")
        });
        for caps in re.captures_iter(body) {
            let m = caps.get(1).expect("group 1");
            let rest = body[m.end()..].trim_start_matches(|c: char| c.is_ascii_alphanumeric() || "_./:-".contains(c));
            if rest.starts_with("$(") {
                continue;
            }
            let text = m.as_str();
            let (kind, id) = match text.strip_prefix('#') {
                Some(t) => (crate::facts::kind::FUNCTION_TAG, t),
                None => (crate::facts::kind::FUNCTION, text),
            };
            self.facts.macro_refs.push(Ref { kind, id: full_id(id), start: base + m.start() as u32, end: base + m.end() as u32 });
        }
    }
}

fn strip_keyword<'a>(content: &'a str, kw: &str) -> Option<&'a str> {
    let rest = content.strip_prefix(kw)?;
    if rest.is_empty() || rest.starts_with(' ') { Some(rest) } else { None }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(text: &str) -> FileFacts {
        let data = crate::data::for_version("1.20.4").unwrap();
        analyze(text, "a:b/c", data, &Config::default())
    }

    #[test]
    fn function_doc_with_matching_id_sets_visibility() {
        let f = run("#> a:b/c\n# @within function a:b/**\n\nsay hi\n");
        let doc = f.function_doc.expect("function doc");
        assert_eq!(doc.visibility.len(), 1);
        assert_eq!(&*doc.visibility[0].kind, "function");
    }

    #[test]
    fn function_doc_with_other_id_is_ignored() {
        let f = run("#> a:other\n# @private\nsay hi\n");
        assert!(f.function_doc.is_none());
    }

    #[test]
    fn declaration_doc_attaches_indented_lines() {
        let f = run("\n#> values\n# @within\n#   function a:b/**\n    #declare score_holder $A\n    #declare score_holder $B\n#declare score_holder $C\n");
        assert_eq!(f.decls.len(), 3);
        assert_eq!(f.decls[0].visibility.as_ref().map(|v| v.len()), Some(1));
        assert_eq!(f.decls[1].visibility.as_ref().map(|v| v.len()), Some(1));
        assert!(f.decls[2].visibility.is_none());
    }

    #[test]
    fn bare_hash_lines_continue_a_doc() {
        let f = run("#> a:b/c\n#\n# text\n#\n# @within function a:x\n\nsay hi\n");
        assert_eq!(f.function_doc.expect("function doc").visibility.len(), 1);
        let f = run("#> a:b/c\r\n#\r\n# @private\r\nsay hi\r\n");
        assert_eq!(f.function_doc.expect("function doc").visibility.len(), 1);
    }

    #[test]
    fn first_attached_line_at_same_depth_stops_the_chain() {
        let f = run("\n#> v\n# @private\n#declare tag A\n#declare tag B\n");
        assert!(f.decls[0].visibility.is_some());
        assert!(f.decls[1].visibility.is_none());
    }

    #[test]
    fn within_children_flatten_per_pattern() {
        let f = run("\n#> v\n# @within function\n#     a:x\n#     a:y\n    #declare storage a:s\n");
        let v = f.decls[0].visibility.as_ref().unwrap();
        assert_eq!(v.len(), 2);
    }

    #[test]
    fn macro_lines() {
        assert!(run("$say $(x)\n").diags.is_empty());
        assert_eq!(run("$say hi\n").diags.len(), 1);
        assert_eq!(run("$say $(x\n").diags.len(), 1);
    }

    #[test]
    fn ids_outside_minecraft_get_a_hint_under_only_default_namespace() {
        let data = crate::data::for_version("1.20.4").unwrap();
        let mut config = Config::from_settings(r#"{"datapack.lint.strictSoundEventCheck": ["error", "only-default-namespace"]}"#).unwrap();
        let text = "playsound ogg:x master @a\nplaysound minecraft:nope master @a\n";
        let severities = |c: &Config| analyze(text, "a:b/c", data, c).diags.iter().map(|d| d.severity).collect::<Vec<_>>();
        assert_eq!(severities(&config), [Severity::Hint, Severity::Error]);
        config.merge_spyglass("{}").unwrap();
        assert_eq!(severities(&config), [Severity::Error]);
    }

    #[test]
    fn vanilla_selector_forms_parse() {
        for line in ["execute as @e[y_rotation=135..-135] run say a", "kill @e[tag=! Foo]", "kill 0-0-0-0-123456789"] {
            let f = run(&format!("{line}\n"));
            assert!(f.diags.iter().all(|d| d.code != "syntax"), "{line}: {:?}", f.diags);
        }
        assert!(run("kill @e[distance=5..1]\n").diags.iter().any(|d| d.code == "syntax"));
    }

    #[test]
    fn malformed_declarations_are_comments() {
        let f = run("#declare\n#declare foo bar\n#declare storage\n#declare storage a:b\n");
        assert!(f.diags.is_empty());
        let ids: Vec<&str> = f.decls.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(ids, ["a:b"]);
    }

    #[test]
    fn macro_function_refs_skip_ids_built_at_run_time() {
        let f = run("$function a:$(T)/x\n$function a:b/$(T)\n$function a:b/c with storage a:b $(x)\n");
        let ids: Vec<&str> = f.macro_refs.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["a:b/c"]);
    }

    #[test]
    fn objective_add_inside_doc_gets_visibility() {
        let f = run("\n#> obj\n# @public\n    scoreboard objectives add Const dummy\n");
        assert_eq!(f.decls.len(), 1);
        assert_eq!(f.decls[0].kind, "objective");
        assert!(f.decls[0].visibility.is_some());
    }

    #[test]
    fn comment_links_are_markdown_links_to_functions() {
        let links = comment_links("# [a](t:x#L3) [b](t:y/z) [c](https://e.com/a) [d](nons) [e](t:z#L0) (t:w)");
        let found: Vec<_> = links.iter().map(|(s, e, id, line)| (*s, *e, id.as_str(), *line)).collect();
        assert_eq!(found, [(6, 12, "t:x", Some(3)), (18, 23, "t:y/z", None)]);
    }
}
