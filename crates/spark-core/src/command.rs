//! Parses one command line against the command tree, like Brigadier's
//! `CommandDispatcher.parse`, and collects what the arguments report.

use crate::args::{self, ArgCtx, ArgValue, PathNode};
use crate::config::Config;
use crate::data::VersionData;
use crate::diag::{Diagnostic, ParseError};
use crate::facts::{Def, Ref};
use crate::reader::Reader;
use crate::tree::{NodeId, NodeKind, ROOT};

#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    Diag(Diagnostic),
    Ref(Ref),
    /// A reference that Spyglass 4 binds as a definition: the storage of a
    /// data command, a score holder that a command writes. Only the IMP-Doc
    /// rules of the modified Spyglass treat it differently from `Ref`.
    Write(Ref),
    Def(Def),
}

#[derive(Default)]
pub struct CommandResult {
    pub error: Option<ParseError>,
    pub effects: Vec<Effect>,
}

pub fn parse_command(line: &str, base: u32, data: &VersionData, config: &Config) -> CommandResult {
    let w = Walker { data, config, src: line, base };
    let mut path = Vec::new();
    let mut values = Vec::new();
    match w.children(ROOT, 0, &mut path, &mut values) {
        Ok(effects) => CommandResult { error: None, effects },
        Err((error, effects)) => CommandResult { error: Some(error), effects },
    }
}

struct Walker<'a> {
    data: &'a VersionData,
    config: &'a Config,
    src: &'a str,
    base: u32,
}

type Outcome = Result<Vec<Effect>, (ParseError, Vec<Effect>)>;

impl<'a> Walker<'a> {
    fn err_at(&self, pos: usize, message: &str) -> ParseError {
        let end = self.src[pos..].find(' ').map_or(self.src.len(), |i| pos + i);
        ParseError::new(self.base + pos as u32, self.base + end as u32, message)
    }

    /// Parses the children of `node` starting at byte `pos` of the line.
    fn children(&self, node: NodeId, pos: usize, path: &mut Vec<PathNode<'a>>, values: &mut Vec<ArgValue>) -> Outcome {
        let tree = &self.data.tree;
        let n = tree.node(node);
        let word_end = self.src[pos..].find(' ').map_or(self.src.len(), |i| pos + i);
        let word = &self.src[pos..word_end];
        if let Some(&lit) = n.literals.iter().find(|&&c| tree.node(c).name() == word) {
            return self.after_node(lit, word_end, Vec::new(), path, values);
        }
        if n.arguments.is_empty() {
            let message = if node == ROOT { "Unknown command" } else { "Incorrect argument for command" };
            return Err((self.err_at(pos, message), Vec::new()));
        }
        let mut best: Option<(ParseError, Vec<Effect>)> = None;
        for &arg in &n.arguments {
            let NodeKind::Argument { name, parser } = &tree.node(arg).kind else { continue };
            let mut effects = Vec::new();
            let mut reader = Reader { src: self.src, pos, base: self.base };
            let saved = values.len();
            let mut cx = ArgCtx { data: self.data, config: self.config, effects: &mut effects, name, path, values };
            let outcome = match args::parse(parser, &mut reader, &mut cx) {
                Ok(()) => self.after_node(arg, reader.pos, effects, path, values),
                Err(e) => Err((e, effects)),
            };
            if outcome.is_err() {
                values.truncate(saved);
            }
            match outcome {
                Ok(effects) => return Ok(effects),
                Err((e, effects)) => {
                    if best.as_ref().is_none_or(|(b, _)| e.start > b.start) {
                        best = Some((e, effects));
                    }
                }
            }
        }
        Err(best.expect("at least one argument was tried"))
    }

    /// Continues after `node` has consumed the line up to `end`.
    fn after_node(&self, node: NodeId, end: usize, mut effects: Vec<Effect>, path: &mut Vec<PathNode<'a>>, values: &mut Vec<ArgValue>) -> Outcome {
        let tree: &'a crate::tree::CommandTree = &self.data.tree;
        let n = tree.node(node);
        if end >= self.src.len() {
            if n.executable {
                return Ok(effects);
            }
            let at = self.base + end as u32;
            return Err((ParseError::new(at, at, "Unknown or incomplete command"), effects));
        }
        if self.src.as_bytes()[end] != b' ' {
            return Err((self.err_at(end, "Expected whitespace to end one argument, but found trailing data"), effects));
        }
        let next = n.redirect.unwrap_or(node);
        if !tree.node(next).has_children() {
            return Err((self.err_at(end + 1, "Incorrect argument for command"), effects));
        }
        // A redirect to the root starts a new command; other redirects (execute
        // subcommands) keep the path so that arguments see their own literals.
        let result = if n.redirect == Some(ROOT) {
            let outer = std::mem::take(path);
            let outer_values = std::mem::take(values);
            let result = self.children(next, end + 1, path, values);
            *path = outer;
            *values = outer_values;
            result
        } else {
            path.push(PathNode { name: n.name(), literal: matches!(n.kind, NodeKind::Literal(_)) });
            let result = self.children(next, end + 1, path, values);
            path.pop();
            result
        };
        match result {
            Ok(rest) => {
                effects.extend(rest);
                Ok(effects)
            }
            Err((e, rest)) => {
                effects.extend(rest);
                Err((e, effects))
            }
        }
    }
}
