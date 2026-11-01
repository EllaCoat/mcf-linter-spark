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

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::facts::kind;
    use crate::tree::Parser;
    use crate::version::RELEASES;

    /// Parses `line` as `version` reads it, with the default settings.
    pub(crate) fn parse_in(version: &str, line: &str) -> CommandResult {
        parse_command(line, 0, crate::data::for_version(version).unwrap(), &Config::default())
    }

    /// The error message of `line` in `version`, or `None` when it parses.
    fn error_in(version: &str, line: &str) -> Option<String> {
        parse_in(version, line).error.map(|e| e.message)
    }

    /// The diagnostics of a line that parses.
    fn diagnostics_in(version: &str, line: &str) -> Vec<String> {
        let result = parse_in(version, line);
        assert_eq!(result.error.map(|e| e.message), None, "{version}: {line}");
        result.effects.into_iter().filter_map(|e| if let Effect::Diag(d) = e { Some(d.message) } else { None }).collect()
    }

    #[test]
    fn item_stacks_take_components_from_1_20_5() {
        assert_eq!(error_in("1.20.4", "give @s diamond{display:{Name:'\"a\"'}}"), None);
        assert!(error_in("1.20.4", "give @s diamond[damage=1]").is_some());
        assert_eq!(error_in("1.20.5", "give @s diamond_sword[damage=5,!enchantments]").as_deref(), Some("Unknown item component 'minecraft:'"));
        for v in ["1.21", "1.21.5", "26.3"] {
            assert_eq!(error_in(v, "give @s diamond_sword[damage=5,!enchantments, unbreakable={}]"), None, "{v}");
        }
        for v in ["1.20.5", "1.21.4", "1.21.5", "26.3"] {
            assert_eq!(error_in(v, "give @s diamond_sword[damage=5, unbreakable={}]"), None, "{v}");
            assert_eq!(error_in(v, "give @s diamond_sword[ damage = 5 ]"), None, "{v}");
            assert!(error_in(v, "give @s diamond{a:1}").is_some(), "{v}");
            assert_eq!(error_in(v, "give @s diamond[foo=1]").as_deref(), Some("Unknown item component 'minecraft:foo'"), "{v}");
            assert_eq!(
                error_in(v, "give @s diamond[damage=1,damage=2]").as_deref(),
                Some("Item component 'minecraft:damage' was repeated, but only one value can be specified"),
                "{v}"
            );
            assert_eq!(error_in(v, "give @s diamond[damage=1,]"), None, "{v}");
            assert_eq!(error_in(v, "give @s diamond[damage=1,").as_deref(), Some("Expected item component"), "{v}");
            assert_eq!(diagnostics_in(v, "give @s diamond[damage='a']"), ["Expected an int tag but got a string tag"], "{v}");
            assert_eq!(diagnostics_in(v, "give @s diamond[damage=1b]"), ["Expected an int tag but got a byte tag (rule: “nbtTypeCheck”)"], "{v}");
            assert_eq!(diagnostics_in(v, "give @s apple[food={nutrition:1}]"), ["Missing key “saturation”"], "{v}");
        }
    }

    fn none() -> Vec<String> {
        Vec::new()
    }

    #[test]
    fn item_predicates_test_components_from_1_20_5() {
        assert_eq!(error_in("1.20.4", "clear @s #minecraft:swords{Damage:1}"), None);
        assert!(error_in("1.20.4", "clear @s *").is_some());
        for v in ["1.20.5", "1.21.4", "1.21.5", "26.3"] {
            assert_eq!(error_in(v, "clear @s *[damage=1|!custom_data,count~{min:1}]"), None, "{v}");
            assert_eq!(error_in(v, "clear @s #minecraft:swords[minecraft:damage~{durability:{min:1}}]"), None, "{v}");
            assert_eq!(error_in(v, "clear @s stone[count=2]"), None, "{v}");
            assert_eq!(error_in(v, "clear @s *[custom_data~{}]"), None, "{v}");
            assert_eq!(error_in(v, "clear @s *[bar]").as_deref(), Some("Unknown item component 'minecraft:bar'"), "{v}");
            assert_eq!(error_in(v, "clear @s *[bar~{}]").as_deref(), Some("Unknown item predicate 'minecraft:bar'"), "{v}");
            assert_eq!(error_in(v, "clear @s *[ damage=1 , count=1 ]"), None, "{v}");
            assert_eq!(error_in(v, "clear @s * [damage=1] 3"), None, "{v}");
            assert_eq!(error_in(v, "clear @s *[]"), None, "{v}");
            assert!(error_in(v, "clear @s *[damage=1,]").is_some(), "{v}");
        }
        assert!(error_in("1.21.10", "clear @s *[food~{}]").is_some());
        assert_eq!(error_in("1.21.11", "clear @s *[food~{}]"), None);
        for v in ["1.21.11", "26.3"] {
            assert_eq!(diagnostics_in(v, "clear @s *[food~{a:1}]"), none(), "{v}");
            assert_eq!(diagnostics_in(v, "clear @s *[food~1]"), ["Expected a compound tag but got an int tag"], "{v}");
            assert_eq!(diagnostics_in(v, "clear @s *[food~[]]"), ["Expected a compound tag but got a list tag"], "{v}");
        }
    }

    #[test]
    fn text_components_and_styles_are_snbt_from_1_21_5() {
        assert_eq!(error_in("1.21.4", "tellraw @a {\"text\":\"hi\"}"), None);
        assert!(error_in("1.21.4", "tellraw @a {text:\"hi\"}").is_some());
        assert_eq!(error_in("1.21.4", "scoreboard objectives modify o numberformat styled {\"color\":\"red\"}"), None);
        let none: Vec<String> = Vec::new();
        for v in ["1.21.5", "26.3"] {
            assert_eq!(diagnostics_in(v, "tellraw @a {text:\"hi\",color:\"red\",click_event:{action:\"run_command\",command:\"/say hi\"}}"), none, "{v}");
            assert_eq!(diagnostics_in(v, "tellraw @a [\"a\",{text:\"b\",bold:true}]"), none, "{v}");
            assert_eq!(diagnostics_in(v, "tellraw @a \"plain\""), none, "{v}");
            assert_eq!(diagnostics_in(v, "tellraw @a {\"text\":\"hi\"}"), none, "{v}");
            assert_eq!(diagnostics_in(v, "scoreboard objectives modify o numberformat styled {color:\"red\",bold:true}"), none, "{v}");
            assert_eq!(diagnostics_in(v, "tellraw @a {text:\"a\",color:1}"), ["Expected a string tag but got an int tag"], "{v}");
            assert_eq!(diagnostics_in(v, "tellraw @a {text:\"a\",clickEvent:{}}"), ["Unknown key “clickEvent”"], "{v}");
        }
    }

    #[test]
    fn slot_names_of_each_release() {
        let slot = |v: &str, name: &str| error_in(v, &format!("item replace entity @s {name} with stone"));
        assert_eq!(slot("1.20.4", "horse.armor"), None);
        assert!(slot("1.20.4", "armor.body").is_some());
        assert!(slot("1.20.5", "horse.armor").is_some());
        assert_eq!(slot("1.20.5", "armor.body"), None);
        assert_eq!(slot("1.20.5", "horse.saddle"), None);
        assert_eq!(slot("1.20.5", "player.crafting.3"), None);
        assert_eq!(slot("1.20.5", "contents"), None);
        assert!(slot("1.21.5", "horse.saddle").is_some());
        assert_eq!(slot("1.21.5", "saddle"), None);
        assert_eq!(slot("1.21.5", "contents"), None);
        assert_eq!(slot("1.21.11", "villager.3"), None);
        assert!(slot("26.1", "villager.3").is_some());
        assert_eq!(slot("26.1", "mob.inventory.3"), None);
        assert_eq!(error_in("26.3", "execute if items entity @s mob.inventory.* minecraft:stone run say hi"), None);
        assert!(error_in("26.3", "execute if items entity @s villager.* minecraft:stone run say hi").is_some());
    }

    #[test]
    fn items_of_entities_without_an_id_are_checked_in_linear_time() {
        let items = (0..12).fold("{Items:[{Slot:0b,id:\"minecraft:stone\",bogus:1b}]}".to_string(), |inner, _| {
            format!("{{Items:[{{Slot:0b,id:\"minecraft:stone\",components:{{\"minecraft:entity_data\":{inner}}}}}]}}")
        });
        assert_eq!(diagnostics_in("26.3", &format!("data merge entity @s {items}")), ["Unknown key “bogus”"]);
        let tags = (0..12).fold("{Items:[{Slot:0b,id:\"minecraft:stone\",Count:1b,bogus:1b}]}".to_string(), |inner, _| {
            format!("{{Items:[{{Slot:0b,id:\"minecraft:pig_spawn_egg\",Count:1b,tag:{{EntityTag:{inner}}}}}]}}")
        });
        assert_eq!(diagnostics_in("1.20.4", &format!("data merge entity @s {tags}")), ["Unknown key “bogus”"]);
    }

    #[test]
    fn nested_text_components_are_checked_in_linear_time() {
        let mut snbt = "{x:1}".to_string();
        for _ in 0..24 {
            snbt = format!("{{x:1,extra:[{snbt}]}}");
        }
        assert!(!diagnostics_in("26.3", &format!("tellraw @a {snbt}")).is_empty());
        let separators = (0..24).fold("{text:\"a\"}".to_string(), |inner, _| format!("{{text:\"a\",separator:{inner}}}"));
        assert_eq!(diagnostics_in("26.3", &format!("tellraw @a {separators}")), ["Unknown key “separator”"]);
        let mut json = "1".to_string();
        for _ in 0..40 {
            json = format!(r#"{{"selector":"x","nbt":"y","separator":{json}}}"#);
        }
        assert!(error_in("1.20.4", &format!("tellraw @a {json}")).is_some());
    }

    #[test]
    fn the_nearest_entity_selector_from_1_21() {
        assert!(error_in("1.20.6", "kill @n").is_some());
        assert_eq!(error_in("1.21", "kill @n[type=zombie]"), None);
        assert_eq!(error_in("1.20.6", "say hi @n["), None);
        assert!(error_in("1.21", "say hi @n[").is_some());
    }

    #[test]
    fn particle_options_are_snbt_from_1_20_5() {
        assert_eq!(error_in("1.20.4", "particle dust 1 0 0 1 ~ ~ ~ 0 0 0 0 1"), None);
        assert_eq!(error_in("1.20.5", "particle dust{color:[1f,0f,0f],scale:1f} ~ ~ ~ 0 0 0 0 1"), None);
        assert_eq!(error_in("26.3", "particle minecraft:block{block_state:{Name:\"minecraft:stone\"}} ~ ~ ~"), None);
        assert_eq!(error_in("26.3", "particle flame ~ ~ ~"), None);
        assert!(error_in("1.20.5", "particle dust 1 0 0 1 ~ ~ ~").is_some());
        for v in ["1.20.5", "1.21.5", "26.3"] {
            assert_eq!(diagnostics_in(v, "particle flame ~ ~ ~"), none(), "{v}");
            assert_eq!(diagnostics_in(v, "particle dust ~ ~ ~"), ["Missing key “color”", "Missing key “scale”"], "{v}");
            assert_eq!(diagnostics_in(v, "particle dust{color:'red',scale:1f} ~ ~ ~").len(), 1, "{v}");
        }
        let double = "Expected a float tag but got a double tag (rule: “nbtTypeCheck”)";
        for v in ["1.21.2", "1.21.5", "26.3"] {
            assert_eq!(diagnostics_in(v, "particle dust{color:[1.0,0.0,0.0],scale:1f} ~ ~ ~"), [double, double, double], "{v}");
        }
    }

    #[test]
    fn json_text_in_a_component_is_lenient_until_1_21_5() {
        for v in ["1.20.5", "1.21.4"] {
            assert_eq!(diagnostics_in(v, "give @s stone[custom_name=\"a\"]"), none(), "{v}");
            assert_eq!(diagnostics_in(v, "give @s stone[lore=[\"'a'\"]]"), none(), "{v}");
            assert_eq!(diagnostics_in(v, "give @s stone[custom_name='{\"text\":\"a\"} b']"), ["Invalid chat component: Did not consume the entire document"], "{v}");
            for comment in ["// c", "# c", "/* c */"] {
                assert_eq!(diagnostics_in(v, &format!("give @s stone[custom_name='\"a\" {comment}']")), ["Invalid chat component: Did not consume the entire document"], "{v} {comment}");
            }
        }
        assert!(diagnostics_in("1.20.4", "summon zombie ~ ~ ~ {CustomName:\"a\"}").iter().any(|d| d.starts_with("Invalid chat component: Malformed JSON")));
    }

    #[test]
    fn entity_effect_particles_take_an_int_color_from_1_20_5() {
        for v in ["1.20.5", "1.21.1", "1.21.2", "26.3"] {
            assert_eq!(diagnostics_in(v, "particle entity_effect{color:-1} ~ ~ ~"), none(), "{v}");
            assert_eq!(diagnostics_in(v, "particle entity_effect{color:[1f,0f,0f,1f]} ~ ~ ~"), none(), "{v}");
            assert_eq!(diagnostics_in(v, "particle entity_effect{color:[1.0,0.0,0.0,1.0]} ~ ~ ~").len(), 4, "{v}");
        }
    }

    #[test]
    fn snbt_follows_the_grammar_of_the_release() {
        assert_eq!(error_in("1.20.4", "data modify storage t: v set value [1, \"a\"]").as_deref(), Some("Can't insert TAG_String into list of TAG_Int"));
        assert_eq!(error_in("1.21.5", "data modify storage t: v set value [1, \"a\", {}]"), None);
        for v in ["1.21.4", "1.21.5"] {
            assert_eq!(error_in(v, "data modify storage t: v set value 0x1Fub"), None, "{v}");
        }
        assert_eq!(error_in("1.21.5", "data modify storage t: v set value 007").as_deref(), Some("Decimal numbers can't start with 0"));
        assert_eq!(error_in("1.21.4", "data modify storage t: v set value 007"), None);
        assert_eq!(error_in("26.3", "data modify storage t: v set value {id: uuid(\"f81d4fae-7dec-11d0-a765-00a0c91e6bf6\"), on: bool(1)}"), None);
        assert_eq!(error_in("26.3", "data get storage t: a{b: 0x1}.c"), None);
        assert_eq!(error_in("26.3", "data merge storage t: [1]").as_deref(), Some("Expected compound tag"));
    }

    #[test]
    fn every_release_has_no_unknown_parser() {
        for (version, _) in RELEASES {
            let data = crate::data::for_version(version).unwrap();
            let unknown: Vec<_> = data
                .tree
                .nodes
                .iter()
                .filter_map(|n| match &n.kind {
                    NodeKind::Argument { parser: Parser::Unknown(id), .. } => Some(id.to_string()),
                    _ => None,
                })
                .collect();
            assert!(unknown.is_empty(), "{version}: {unknown:?}");
        }
    }

    #[test]
    fn commands_that_every_release_reads_alike() {
        for (version, _) in RELEASES {
            for line in [
                "say hi",
                "function t:lib",
                "scoreboard players set @s obj 1",
                "execute as @a at @s run tp @s ~ ~1 ~",
                "loot give @s loot minecraft:chests/igloo_chest",
                "execute if predicate t:p run say hi",
            ] {
                assert_eq!(error_in(version, line), None, "{version}: {line}");
            }
        }
    }

    #[test]
    fn loot_tables_predicates_and_modifiers_are_ids_or_inline_from_1_20_5() {
        let refs = |line: &str| -> Vec<(&str, String)> {
            let result = parse_in("1.20.5", line);
            assert_eq!(result.error.map(|e| e.message), None, "{line}");
            result.effects.into_iter().filter_map(|e| if let Effect::Ref(r) = e { Some((r.kind, r.id)) } else { None }).collect()
        };
        assert_eq!(refs("loot give @s loot chests/igloo_chest"), [(kind::LOOT_TABLE, "minecraft:chests/igloo_chest".to_string())]);
        assert_eq!(refs("execute if predicate t:p run say hi"), [(kind::PREDICATE, "t:p".to_string())]);
        assert_eq!(refs("item modify entity @s weapon t:m"), [(kind::ITEM_MODIFIER, "t:m".to_string())]);
        assert_eq!(refs("loot give @s loot {pools: []}"), []);
        assert!(error_in("1.20.4", "loot give @s loot {pools: []}").is_some());
    }

    #[test]
    fn json_text_has_a_shadow_color_from_1_21_4() {
        let line = |color: &str| format!(r#"tellraw @s {{"text":"a","shadow_color":{color}}}"#);
        for v in ["1.20.4", "1.21.3"] {
            assert_eq!(error_in(v, &line("\"red\"")), None, "{v}");
        }
        assert_eq!(error_in("1.21.4", &line("-1")), None);
        assert_eq!(error_in("1.21.4", &line("[1,0,0,1]")), None);
        for color in ["\"red\"", "[1,0,0]"] {
            assert_eq!(error_in("1.21.4", &line(color)).as_deref(), Some("Invalid chat component: Not a number or a list of four numbers"), "{color}");
        }
    }

    #[test]
    fn only_bossbar_commands_take_a_bossbar_id() {
        let refs = |line: &str| -> Vec<(&str, String)> {
            let result = parse_in("26.3", line);
            assert_eq!(result.error.map(|e| e.message), None, "{line}");
            result.effects.into_iter().filter_map(|e| if let Effect::Ref(r) = e { Some((r.kind, r.id)) } else { None }).collect()
        };
        for line in ["bossbar get t:b max", "bossbar set t:b value 1", "bossbar remove t:b", "execute store result bossbar t:b value run say a"] {
            assert_eq!(refs(line), [(kind::BOSSBAR, "t:b".to_string())], "{line}");
        }
        for line in ["attribute @s minecraft:max_health modifier add t:m 1 add_value", "stopwatch create t:w", "execute if stopwatch t:w 1.. run say a", "test create t:t"] {
            assert_eq!(refs(line), [], "{line}");
        }
    }

    #[test]
    fn inline_elements_are_checked_against_their_type() {
        for v in ["1.20.5", "1.21.5"] {
            assert_eq!(diagnostics_in(v, "loot give @s loot {pools:[]}"), none(), "{v}");
            assert_eq!(diagnostics_in(v, "item modify entity @s weapon.mainhand {function:\"minecraft:set_count\",count:2}"), none(), "{v}");
            assert_eq!(diagnostics_in(v, "execute if predicate {condition:\"minecraft:random_chance\"} run say a"), ["Missing key “chance”"], "{v}");
        }
        assert_eq!(diagnostics_in("26.3", "execute if predicate {condition:\"minecraft:random_chance\",chance:0.5f} run say a"), ["Missing key “type”"]);
        assert_eq!(diagnostics_in("26.3", "dialog show @s {type:\"minecraft:notice\"}"), ["Missing key “title”"]);
        assert_eq!(diagnostics_in("26.3", "compute default integer {type:\"minecraft:constant\"}"), ["Missing key “value”"]);
        let modifier = |m: &str| format!("item modify entity @s weapon.mainhand {m}");
        assert_eq!(diagnostics_in("26.3", &modifier("[{type:\"minecraft:set_count\",count:2},{type:\"minecraft:set_count\",count:3}]")), none());
        assert_eq!(diagnostics_in("26.3", &modifier("[{type:\"minecraft:set_count\"}]")), ["Missing key “count”"]);
        assert_eq!(diagnostics_in("26.3", "execute if items entity @s [{type:\"minecraft:slot_range\",slots:\"weapon.mainhand\"}] * run say a"), none());
        assert_eq!(diagnostics_in("26.3", &modifier("[\"t:m\",{type:\"minecraft:set_count\",count:3}]")), none());
        assert_eq!(diagnostics_in("26.3", "execute if items entity @s [\"t:s\",{type:\"minecraft:slot_range\",slots:\"weapon.offhand\"}] * run say a"), none());
        let refs = |v: &str, line: &str| -> Vec<(&str, String)> {
            parse_in(v, line).effects.into_iter().filter_map(|e| if let Effect::Ref(r) = e { Some((r.kind, r.id)) } else { None }).collect()
        };
        assert_eq!(refs("26.3", &modifier("[\"t:m\"]")), [(kind::ITEM_MODIFIER, "t:m".to_string())]);
        for v in ["1.20.5", "1.21.5"] {
            assert_eq!(diagnostics_in(v, "loot give @s loot \"t:l\""), none(), "{v}");
            assert_eq!(refs(v, "loot give @s loot \"t:l\""), [(kind::LOOT_TABLE, "t:l".to_string())], "{v}");
            assert!(error_in(v, "loot give @s loot \"T:l\"").is_some(), "{v}");
        }
        assert_eq!(diagnostics_in("1.21.6", "loot give @s loot \"t:l\""), ["Expected a compound tag but got a string tag"]);
        assert_eq!(diagnostics_in("1.21.5", &modifier("[{type:\"minecraft:set_count\",count:2}]")), ["Missing key “function”"]);
        let double = "Expected a float tag but got a double tag (rule: “nbtTypeCheck”)";
        assert_eq!(diagnostics_in("1.21.5", &modifier("{function:\"minecraft:set_count\",count:{min:1.0,max:3.0}}")), [double, double]);
    }

    #[test]
    fn data_pack_ids_in_resource_arguments_are_references() {
        let refs = |version: &str, line: &str| -> Vec<(&str, String)> {
            let result = parse_in(version, line);
            assert_eq!(result.error.map(|e| e.message), None, "{version}: {line}");
            result.effects.into_iter().filter_map(|e| if let Effect::Ref(r) = e { Some((r.kind, r.id)) } else { None }).collect()
        };
        for version in ["1.20.4", "26.3"] {
            assert_eq!(refs(version, "damage @s 1 t:custom"), [(kind::DAMAGE_TYPE, "t:custom".to_string())], "{version}");
        }
        assert_eq!(refs("1.21.2", "advancement grant @s only t:a"), [(kind::ADVANCEMENT, "t:a".to_string())]);
        assert_eq!(refs("1.21.2", "recipe give @s t:r"), [(kind::RECIPE, "t:r".to_string())]);
        assert_eq!(refs("1.20.4", "locate biome t:b"), [("worldgen/biome", "t:b".to_string())]);
        assert_eq!(refs("1.21.5", "test locate t:x"), [("test_instance", "t:x".to_string())]);
        assert_eq!(refs("1.21.5", "test locate t:*"), []);
        assert_eq!(refs("1.20.4", "effect give @s t:e"), []);
        assert_eq!(refs("1.20.4", "enchant @s t:e"), []);
        assert_eq!(refs("1.21", "enchant @s t:e"), [("enchantment", "t:e".to_string())]);
        assert_eq!(refs("1.21", "execute if biome ~ ~ ~ #t:b run say hi"), [("tag/worldgen/biome", "t:b".to_string())]);
    }

    #[test]
    fn slot_ranges_from_1_20_5() {
        assert_eq!(error_in("1.20.5", "execute if items entity @s container.* minecraft:stone"), None);
        assert_eq!(error_in("1.20.5", "execute if items entity @s armor.body minecraft:stone"), None);
        assert!(error_in("1.20.5", "execute if items entity @s container.54 minecraft:stone").is_some());
        assert!(error_in("1.20.5", "execute if items entity @s container.05 minecraft:stone").is_some());
        assert_eq!(error_in("26.3", "execute if items entity @s weapon.* minecraft:stone"), None);
        assert_eq!(error_in("26.3", "execute if slots block ~ ~ ~ t:my_slots run say hi"), None);
    }

    #[test]
    fn colors_and_the_parsers_of_later_releases() {
        assert_eq!(error_in("1.21.6", "waypoint modify @s color hex F80"), None);
        assert_eq!(error_in("1.21.6", "waypoint modify @s color hex FF8800"), None);
        assert!(error_in("1.21.6", "waypoint modify @s color hex FF88").is_some());
        assert_eq!(error_in("1.21.6", "dialog show @s minecraft:server_links"), None);
        assert_eq!(error_in("1.21.5", "test run minecraft:*"), None);
        assert_eq!(error_in("26.2", "team modify t color red"), None);
        assert_eq!(error_in("26.2", "team modify t color reset"), None);
        assert!(error_in("26.2", "team modify t color bold").is_some());
        assert_eq!(error_in("26.3", "swing @s mainhand stab"), None);
        assert!(error_in("26.3", "swing @s mainhand poke").is_some());
        assert_eq!(error_in("26.3", "place feature minecraft:oak"), None);
    }
}
