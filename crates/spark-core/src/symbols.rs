//! The declarations and definitions of a project in the shape of the cache that
//! DHP 3.4.19 writes to `.cache/dls.json` (`ClientCache`), for tools built on
//! datapack-linter's cache such as TheSkyBlessing's `make-declares-mcf.mts`.
//! References and docs are left out. DHP's order depends on the history of its
//! cache; here types, ids and positions are sorted so that the same project gives the same file.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::facts::Kind;
use crate::impdoc::{PUBLIC_PATTERN, SiteVisibility};
use crate::position::LineIndex;
use crate::project::{FileState, Project};

#[derive(Default)]
struct Unit {
    dcl: Vec<Value>,
    def: Vec<Value>,
    /// The value of an alias, written as DHP's `foo`.
    alias: Option<String>,
}

pub fn dls_cache(project: &Project) -> Result<Value, String> {
    let root = absolute(&project.root)?;
    let root_uri = file_uri(&root);
    let mut files: Vec<&FileState> = project.files.iter().filter(|f| !f.removed).collect();
    files.sort_by(|a, b| a.rel.cmp(&b.rel));
    let mut cache: BTreeMap<Kind, BTreeMap<String, Unit>> = BTreeMap::new();
    for f in files {
        let uri = format!("{root_uri}/{}", encode_path(&f.rel));
        let index = LineIndex::new(&f.text);
        let pos = |start: u32, end: u32, visibility: &SiteVisibility| position(f, &index, &uri, start, end, visibility);
        let (start, end, visibility) = match &f.facts.function_doc {
            Some(d) => (d.start, d.end, Some(d.visibility.clone())),
            None => (0, 0, None),
        };
        unit(&mut cache, f.kind, &f.id).def.push(pos(start, end, &visibility));
        for d in &f.facts.decls {
            let p = pos(d.start, d.end, &d.visibility);
            let u = unit(&mut cache, d.kind, &d.id);
            if d.declared { u.dcl.push(p) } else { u.def.push(p) }
        }
        for a in &f.facts.aliases {
            let p = pos(a.start, a.end, &a.visibility);
            let u = unit(&mut cache, a.kind, &a.name);
            u.def.push(p);
            u.alias = Some(a.value.clone());
        }
    }
    let mut out = Map::new();
    for (kind, units) in cache {
        let mut by_id = Map::new();
        for (id, u) in units {
            let mut o = Map::new();
            if !u.dcl.is_empty() {
                o.insert("dcl".into(), Value::Array(u.dcl));
            }
            if !u.def.is_empty() {
                o.insert("def".into(), Value::Array(u.def));
            }
            if let Some(value) = u.alias {
                o.insert("foo".into(), Value::String(value));
            }
            by_id.insert(id, Value::Object(o));
        }
        out.insert(kind.to_string(), Value::Object(by_id));
    }
    Ok(json!({ "cache": out }))
}

fn unit<'c>(cache: &'c mut BTreeMap<Kind, BTreeMap<String, Unit>>, kind: Kind, id: &str) -> &'c mut Unit {
    cache.entry(kind).or_default().entry(id.to_string()).or_default()
}

/// DHP's `CachePosition`: UTF-16 offsets in the file, zero-based lines and UTF-16 columns.
fn position(f: &FileState, index: &LineIndex, uri: &str, start: u32, end: u32, visibility: &SiteVisibility) -> Value {
    let text = &*f.text;
    let (start_line, start_char) = index.position(text, start);
    let (end_line, end_char) = index.position(text, end);
    let mut p = json!({
        "uri": uri, "start": index.utf16_offset(text, start), "end": index.utf16_offset(text, end),
        "startLine": start_line, "startChar": start_char, "endLine": end_line, "endChar": end_char,
    });
    if let Some(entries) = visibility {
        // `@public` is kept as `.{0,}` inside; DHP writes `**`.
        let list: Vec<Value> = entries
            .iter()
            .map(|v| {
                let pattern = if &*v.pattern == PUBLIC_PATTERN { "**" } else { &*v.pattern };
                json!({ "type": &*v.kind, "pattern": pattern })
            })
            .collect();
        p["visibility"] = Value::Array(list);
    }
    p
}

/// `.` and `..` are folded so that the URIs start with the checkout directory
/// that tools cut off (`CHECKOUT_PATH` in `make-declares-mcf.mts`).
fn absolute(path: &Path) -> Result<PathBuf, String> {
    let abs = std::path::absolute(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut out = PathBuf::new();
    for c in abs.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            c => out.push(c),
        }
    }
    Ok(out)
}

/// A `file://` URI as VSCode writes it: a Windows drive becomes `/c%3A`.
fn file_uri(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    match s.as_bytes() {
        [d, b':', ..] if d.is_ascii_alphabetic() => format!("file:///{}%3A{}", (*d as char).to_ascii_lowercase(), encode_path(&s[2..])),
        _ => format!("file://{}", encode_path(&s)),
    }
}

fn encode_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~' | b'/') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::project::Options;

    fn cache_of(name: &str, files: &[(&str, &str)]) -> Value {
        let root = std::env::temp_dir().join("ai-agent").join("mcf-linter-spark-tests").join(name);
        let _ = std::fs::remove_dir_all(&root);
        for (rel, text) in files.iter().chain(&[("pack.mcmeta", "{}")]) {
            let path = root.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        let p = Project::load(&root, Config::default(), &Options { ignore: Vec::new(), max_depth: 0 }).unwrap();
        dls_cache(&p).unwrap()["cache"].clone()
    }

    #[test]
    fn declarations_and_definitions_keep_their_positions_and_visibility() {
        let c = cache_of(
            "symbols",
            &[
                ("data/t/functions/api.mcfunction", "#> t:api\n# @public\n"),
                ("data/t/functions/plain.mcfunction", "say hi\n"),
                (
                    "data/t/functions/load.mcfunction",
                    "#> t:load\n# @private\n\n#> objectives\n# @within function t:a/**\n    scoreboard objectives add Count dummy\n\n#> aliases\n# @within t:api\n    #alias vector origin 0 0 0\n#declare storage t:data\n",
                ),
                ("data/t/tags/functions/load.json", r#"{"values": ["t:load"]}"#),
            ],
        );
        let api = &c["function"]["t:api"]["def"][0];
        assert_eq!(api["visibility"], json!([{ "type": "*", "pattern": "**" }]));
        assert_eq!((api["startLine"].clone(), api["startChar"].clone(), api["endChar"].clone()), (json!(0), json!(3), json!(8)));
        assert!(api["uri"].as_str().unwrap().starts_with("file:///"));
        assert!(api["uri"].as_str().unwrap().ends_with("/data/t/functions/api.mcfunction"));
        assert!(c["function"]["t:plain"]["def"][0].get("visibility").is_none());
        assert_eq!(c["function"]["t:load"]["def"][0]["visibility"], json!([{ "type": "function", "pattern": "t:load" }]));
        let count = &c["objective"]["Count"]["def"][0];
        assert_eq!((count["startLine"].clone(), count["visibility"].clone()), (json!(5), json!([{ "type": "function", "pattern": "t:a\\/**" }])));
        let origin = &c["alias/vector"]["origin"];
        assert_eq!(origin["foo"], "0 0 0");
        assert_eq!((origin["def"][0]["startLine"].clone(), origin["def"][0]["visibility"].clone()), (json!(9), json!([{ "type": "*", "pattern": "t:api" }])));
        let data = &c["storage"]["t:data"];
        assert!(data.get("def").is_none() && data["dcl"][0].get("visibility").is_none());
        assert_eq!(c["tag/function"]["t:load"]["def"][0]["start"], 0);
    }

    #[test]
    fn uris_are_written_as_vscode_writes_them() {
        assert_eq!(file_uri(Path::new("/home/runner/work/a b")), "file:///home/runner/work/a%20b");
        assert_eq!(file_uri(Path::new(r"C:\Users\x\pack")), "file:///c%3A/Users/x/pack");
    }

    #[test]
    fn a_root_given_with_dot_dot_gives_the_folded_path() {
        assert!(file_uri(&absolute(Path::new("/a/b/../c/./d")).unwrap()).ends_with("/a/c/d"));
    }
}
