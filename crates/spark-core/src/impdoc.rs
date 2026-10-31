//! IMP-Doc: `#>` doc comments, their annotations, and visibility, following
//! DHP 3.4.19 (`DocCommentPlugin.ts`, `ClientCache.ts`).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use regex::Regex;

/// Types that may follow `@within` (DHP's `FileTypes`).
pub const FILE_TYPES: &[&str] = &[
    "advancement", "damage_type", "dimension", "dimension_type", "function", "item_modifier", "loot_table",
    "predicate", "recipe", "structure", "tag/block", "tag/damage_type", "tag/entity_type", "tag/fluid",
    "tag/function", "tag/game_event", "tag/item", "tag/worldgen/biome", "tag/worldgen/configured_carver",
    "tag/worldgen/configured_decorator", "tag/worldgen/configured_feature", "tag/worldgen/configured_structure_feature",
    "tag/worldgen/configured_surface_builder", "tag/worldgen/density_function", "tag/worldgen/noise",
    "tag/worldgen/noise_settings", "tag/worldgen/placed_feature", "tag/worldgen/processor_list",
    "tag/worldgen/structure", "tag/worldgen/structure_set", "tag/worldgen/template_pool", "worldgen/biome",
    "worldgen/configured_carver", "worldgen/configured_decorator", "worldgen/configured_feature",
    "worldgen/configured_structure_feature", "worldgen/configured_surface_builder", "worldgen/density_function",
    "worldgen/flat_level_generator_preset", "worldgen/noise", "worldgen/noise_settings", "worldgen/placed_feature",
    "worldgen/processor_list", "worldgen/structure", "worldgen/structure_set", "worldgen/template_pool",
    "worldgen/world_preset",
];

/// Types that `#declare` accepts besides the file types.
pub const MISC_TYPES: &[&str] = &["bossbar", "entity", "objective", "score_holder", "storage", "tag", "team", "sequence"];

pub fn is_file_type(t: &str) -> bool {
    FILE_TYPES.contains(&t)
}

pub fn declarable_type(t: &str) -> Option<&'static str> {
    FILE_TYPES.iter().chain(MISC_TYPES).find(|&&k| k == t).copied()
}

/// Whether ids of this type carry a namespace (`minecraft:` is added when omitted).
pub fn is_namespaced_type(t: &str) -> bool {
    is_file_type(t) || t == "bossbar" || t == "storage"
}

/// One visibility entry: which caller type and id pattern may see a declaration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Visibility {
    /// A file type or `*`.
    pub kind: Box<str>,
    /// A regex source in DHP's glob notation (`*`, `**`, `?` still unexpanded).
    pub pattern: Box<str>,
}

/// The visibility of one declaration or definition site.
/// `None`: the site has no visibility (always visible). `Some([])`: use the
/// default visibility. Otherwise visible when any entry matches.
pub type SiteVisibility = Option<Arc<[Visibility]>>;

/// DHP's `escapeIdentityPattern`.
fn escape_pattern(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    for c in s.chars() {
        if matches!(c, '-' | '/' | '\\' | '^' | '$' | '+' | '.' | '(' | ')' | '|' | '[' | ']' | '{' | '}') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// The pattern of `@public`. It matches every id as `**` does, but no
/// `@within` can produce it because their patterns are escaped, so the modified
/// Spyglass's public / restricted distinction can be read from the entries.
pub const PUBLIC_PATTERN: &str = ".{0,}";

/// The visibility for `@private` / `@internal` / `@public` (`getCacheVisibilities`).
pub fn named_visibility(name: &str, def_kind: &str, def_id: &str) -> Vec<Visibility> {
    match name {
        "private" => vec![Visibility { kind: def_kind.into(), pattern: def_id.into() }],
        "internal" => {
            let ns = def_id.split_once(':').map_or("minecraft", |(ns, _)| ns);
            let mut v = vec![Visibility { kind: "*".into(), pattern: format!("{ns}:**").into() }];
            if ns != "minecraft" {
                v.push(Visibility { kind: "*".into(), pattern: "minecraft:**".into() });
            }
            v
        }
        _ => vec![Visibility { kind: "*".into(), pattern: PUBLIC_PATTERN.into() }],
    }
}

fn compiled(pattern: &str) -> Option<Arc<Regex>> {
    static CACHE: OnceLock<Mutex<HashMap<Box<str>, Option<Arc<Regex>>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(r) = cache.lock().unwrap().get(pattern) {
        return r.clone();
    }
    let source = format!(
        "^{}$",
        pattern.replace('?', "[^:/]").replace("**/", ".{0,}").replace("**", ".{0,}").replace('*', "[^:/]{0,}")
    );
    // A pattern that is not a valid regex never matches, as in DHP.
    let r = Regex::new(&source).ok().map(Arc::new);
    cache.lock().unwrap().insert(pattern.into(), r.clone());
    r
}

fn shortest(id: &str) -> &str {
    id.strip_prefix("minecraft:").unwrap_or(id)
}

/// `testID` for one entry: may a caller of `caller_kind` with `caller_id` see it?
pub fn entry_matches(v: &Visibility, caller_kind: &str, caller_id: &str) -> bool {
    if &*v.kind != "*" && &*v.kind != caller_kind {
        return false;
    }
    let p = &*v.pattern;
    if p == PUBLIC_PATTERN {
        return true;
    }
    if !p.contains(['*', '?', '\\', '.', '[', '(', '{', '+', '^', '$', '|']) {
        return p == caller_id || p == shortest(caller_id);
    }
    match compiled(p) {
        Some(re) => re.is_match(caller_id) || re.is_match(shortest(caller_id)),
        None => false,
    }
}

/// `testID` for a site. `default` is the default visibility setting and
/// `def` the definition file's kind and id (used by a non-public default).
pub fn site_visible(site: &SiteVisibility, caller_kind: &str, caller_id: &str, default: &DefaultVisibility, def: Option<(&str, &str)>) -> bool {
    match site {
        None => true,
        Some(entries) if !entries.is_empty() => entries.iter().any(|v| entry_matches(v, caller_kind, caller_id)),
        Some(_) => match default {
            DefaultVisibility::Entries(entries) => entries.iter().any(|v| entry_matches(v, caller_kind, caller_id)),
            DefaultVisibility::Named(name) => match def {
                Some((k, id)) => named_visibility(name, k, id).iter().any(|v| entry_matches(v, caller_kind, caller_id)),
                None => true,
            },
        },
    }
}

#[derive(Clone, Debug)]
pub enum DefaultVisibility {
    Named(String),
    Entries(Vec<Visibility>),
}

impl DefaultVisibility {
    pub fn from_config(v: &serde_json::Value) -> DefaultVisibility {
        match v {
            serde_json::Value::String(s) => DefaultVisibility::Named(s.clone()),
            serde_json::Value::Object(o) => DefaultVisibility::Entries(vec![Visibility {
                kind: o.get("type").and_then(|t| t.as_str()).unwrap_or("*").into(),
                pattern: o.get("pattern").and_then(|t| t.as_str()).unwrap_or("**").into(),
            }]),
            _ => DefaultVisibility::Named("public".into()),
        }
    }
}

/// One annotation token: its text and its byte range in the file.
#[derive(Clone, Debug)]
pub struct Token {
    pub text: String,
    pub start: u32,
    pub end: u32,
}

/// A parsed doc comment block.
#[derive(Clone, Debug, Default)]
pub struct DocComment {
    pub plain_text: String,
    /// Annotations flattened into paths (`[@within, function, ns:a]`).
    pub annotations: Vec<Vec<Token>>,
}

/// The annotation that decides a doc comment's visibility, as the modified
/// Spyglass names it in its messages (`parseVisibility`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Scope {
    #[default]
    Default,
    Public,
    Within,
    Internal,
    Private,
}

impl DocComment {
    pub fn scope(&self) -> Scope {
        let has = |names: &[&str]| self.annotations.iter().any(|a| a.first().is_some_and(|t| names.contains(&t.text.as_str())));
        if has(&["@public", "@api"]) {
            Scope::Public
        } else if has(&["@within"]) {
            Scope::Within
        } else if has(&["@internal"]) {
            Scope::Internal
        } else if has(&["@private"]) {
            Scope::Private
        } else {
            Scope::Default
        }
    }

    /// The text shown on hover (`DocCommentNode.valueOf`).
    pub fn display(&self) -> String {
        let mut s = self.plain_text.trim_end().to_string();
        for a in &self.annotations {
            s.push_str("\n\n");
            s.push_str(&a.iter().map(|t| t.text.as_str()).collect::<Vec<_>>().join(" "));
        }
        s
    }

    /// `getVisibility`. Errors are returned as (start, end, message).
    /// With `strip_modifiers`, tokens such as `@readonly` after `@within` are
    /// dropped first, as the modified Spyglass does; they are returned too.
    pub fn visibility(&self, current_id: &str, strip_modifiers: bool) -> (Vec<Visibility>, Vec<(u32, u32, String)>, Vec<Token>) {
        let mut out = Vec::new();
        let mut errors = Vec::new();
        let mut modifiers = Vec::new();
        for full in &self.annotations {
            let Some(head) = full.first() else { continue };
            let stripped: Vec<Token>;
            let a: &[Token] = if strip_modifiers && head.text == "@within" {
                let (mods, rest): (Vec<&Token>, Vec<&Token>) = full[1..].iter().partition(|t| t.text.starts_with('@'));
                modifiers.extend(mods.into_iter().cloned());
                stripped = std::iter::once(head.clone()).chain(rest.into_iter().cloned()).collect();
                &stripped
            } else {
                full
            };
            match head.text.as_str() {
                "@private" => out.extend(named_visibility("private", "function", current_id)),
                "@internal" => out.extend(named_visibility("internal", "function", current_id)),
                "@public" | "@api" => out.extend(named_visibility("public", "function", current_id)),
                "@within" => match a.len() {
                    1 => errors.push((head.start, head.end, "Expected more arguments but got nothing".to_string())),
                    2 => out.push(Visibility { kind: "*".into(), pattern: escape_pattern(&a[1].text).into() }),
                    _ => {
                        let t = &a[1].text;
                        if is_file_type(t) || t == "*" {
                            out.push(Visibility { kind: t.as_str().into(), pattern: escape_pattern(&a[2].text).into() });
                        } else {
                            errors.push((a[1].start, a[1].end, format!("Expected a file type or '*' but got '{t}'")));
                        }
                    }
                },
                _ => {}
            }
        }
        (out, errors, modifiers)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vis(kind: &str, pattern: &str) -> Visibility {
        Visibility { kind: kind.into(), pattern: escape_pattern(pattern).into() }
    }

    #[test]
    fn glob_matches_like_dhp() {
        assert!(entry_matches(&vis("*", "example:item/**"), "function", "example:item/sword/use/x"));
        assert!(entry_matches(&vis("function", "example:a/*"), "function", "example:a/b"));
        assert!(!entry_matches(&vis("function", "example:a/*"), "function", "example:a/b/c"));
        assert!(!entry_matches(&vis("function", "example:a/*"), "tag/function", "example:a/b"));
        assert!(!entry_matches(&vis("*", "a:**/b"), "function", "a:b"));
        assert!(entry_matches(&vis("*", "a:**/b"), "function", "a:x/b"));
        // `*` alone matches only ids whose shortest form has no ':' or '/'.
        assert!(entry_matches(&vis("*", "*"), "function", "minecraft:load"));
        assert!(!entry_matches(&vis("*", "*"), "function", "example:load"));
        assert!(entry_matches(&vis("*", "example:x/y.m"), "function", "example:x/y.m"));
        assert!(!entry_matches(&vis("*", "example:x/y.m"), "function", "example:x/yXm"));
    }

    #[test]
    fn private_and_internal() {
        let p = named_visibility("private", "function", "a:b/c");
        assert!(p.iter().any(|v| entry_matches(v, "function", "a:b/c")));
        assert!(!p.iter().any(|v| entry_matches(v, "function", "a:b/d")));
        let i = named_visibility("internal", "function", "a:b");
        assert!(i.iter().any(|v| entry_matches(v, "function", "a:zz/y")));
        assert!(i.iter().any(|v| entry_matches(v, "function", "minecraft:zz")));
        assert!(!i.iter().any(|v| entry_matches(v, "function", "b:zz")));
    }
}
