use super::*;
use crate::args::nbt::{parse_path, parse_tag};
use crate::command::{CommandResult, parse_command};
use crate::reader::Reader;

/// Settings that turn on the NBT rules.
const NBT_RULES: &str = r#"{
    "datapack.lint.nbtTypeCheck": ["warning", "strictly"],
    "datapack.lint.nbtBoolean": ["warning", false],
    "datapack.lint.nbtCompoundKeyQuote": ["warning", false],
    "datapack.lint.nbtCompoundKeyQuoteType": ["warning", "always double"],
    "datapack.lint.nbtPathQuote": ["warning", false],
    "datapack.lint.nbtPathQuoteType": ["warning", "always double"],
    "datapack.lint.nbtStringQuote": ["warning", true],
    "datapack.lint.nbtStringQuoteType": ["warning", "prefer double"],
    "datapack.lint.nbtListLengthCheck": ["error", true],
    "datapack.lint.nbtArrayLengthCheck": ["warning", true],
    "datapack.lint.strictMobEffectCheck": ["error", "always"]
}"#;

const PASCAL: &str = r#"{"datapack.lint.nameOfNbtCompoundTagKeys": ["information", ["PascalCase", "/^id$/"]]}"#;

fn data() -> &'static VersionData {
    crate::data::for_version("1.20.4").unwrap()
}

fn describe(effects: &[Effect]) -> Vec<String> {
    effects
        .iter()
        .map(|e| match e {
            Effect::Diag(d) => format!("{} {}-{} {}", d.severity.as_str(), d.start, d.end, d.message),
            Effect::Ref(r) | Effect::Write(r) => format!("ref {} {} {}-{}", r.kind, r.id, r.start, r.end),
            Effect::Def(d) => format!("def {} {}", d.kind, d.id),
        })
        .collect()
}

fn value(settings: &str, src: &str, target: Option<&Target>) -> Vec<String> {
    let node = parse_tag(&mut Reader::new(src, 0), false).unwrap();
    let config = Config::from_settings(settings).unwrap();
    describe(&check_value(data(), &config, &node, target))
}

fn path(settings: &str, src: &str, target: Option<&Target>) -> Vec<String> {
    let nodes = parse_path(&mut Reader::new(src, 0), false).unwrap();
    let config = Config::from_settings(settings).unwrap();
    describe(&check_path(data(), &config, &nodes, target))
}

/// Parses a whole command, so that the context of each NBT argument is the real one.
fn command(settings: &str, line: &str) -> Vec<String> {
    diagnostics_of(&Config::from_settings(settings).unwrap(), line)
}

fn diagnostics_of(config: &Config, line: &str) -> Vec<String> {
    let CommandResult { error, effects } = parse_command(line, 0, data(), config);
    assert!(error.is_none(), "{line}: {error:?}");
    let diagnostics: Vec<Effect> = effects.into_iter().filter(|e| matches!(e, Effect::Diag(_))).collect();
    describe(&diagnostics)
}

fn entity(id: &str) -> Target {
    Target::new(Category::Entity, Some(format!("minecraft:{id}")))
}

fn item(id: &str) -> Target {
    Target::new(Category::Item, Some(format!("minecraft:{id}")))
}

fn q(s: &str) -> String {
    format!("\u{201c}{s}\u{201d}")
}

#[test]
fn type_mismatch_is_strict_with_strictly_and_for_predicates() {
    let pig = entity("pig");
    assert_eq!(value(NBT_RULES, "{Health:20}", Some(&pig)), [format!("warning 8-10 Expected a float tag but got an int tag (rule: {})", q("nbtTypeCheck"))]);
    let loose = r#"{"datapack.lint.nbtTypeCheck": ["warning", "loosely"]}"#;
    assert!(value(loose, "{Health:20}", Some(&pig)).is_empty());
    assert!(value(loose, "{Health:20.0f}", Some(&pig)).is_empty());
    let predicate = Target { predicate: true, ..entity("pig") };
    assert_eq!(value(loose, "{Health:20}", Some(&predicate)).len(), 1);
    // an int stands in for the other number types, a double never for a float
    assert_eq!(value(loose, "{Health:20.0d}", Some(&pig)).len(), 1);
    assert_eq!(value(loose, "{Health:\"x\"}", Some(&pig)).len(), 1);
}

#[test]
fn without_a_type_check_setting_it_is_loosely_and_a_warning() {
    let pig = entity("pig");
    assert!(value("{}", "{Health:20}", Some(&pig)).is_empty());
    assert!(value("{}", "{Health:\"x\"}", Some(&pig))[0].starts_with("warning 8-11 Expected a float tag but got a string tag"));
    let error = r#"{"datapack.lint.nbtTypeCheck": ["error", "loosely"]}"#;
    assert!(value(error, "{Health:\"x\"}", Some(&pig))[0].starts_with("error "));
}

#[test]
fn a_type_mismatch_stops_the_checks_inside() {
    let pig = entity("pig");
    // `Leash` is a compound; the list inside is not looked at
    assert_eq!(value("{}", "{Leash:[{Foo:1}]}", Some(&pig)).len(), 1);
    assert_eq!(value("{}", "{Motion:{Foo:1}}", Some(&pig)).len(), 1);
}

#[test]
fn unknown_keys_are_reported_once_at_the_last_key() {
    let pig = entity("pig");
    assert_eq!(value("{}", "{Foo:1b}", Some(&pig)), [format!("warning 1-4 Unknown key {}", q("Foo"))]);
    // nothing inside an unknown key is checked
    assert_eq!(value("{}", "{Foo:{Saddle:\"x\"}}", Some(&pig)).len(), 1);
    let found = value("{}", "{Foo:1,Foo:2}", Some(&pig));
    assert_eq!(found.len(), 2, "{found:?}");
    assert!(found.contains(&format!("warning 7-10 Unknown key {}", q("Foo"))));
    assert!(found.contains(&format!("warning 7-10 Duplicate key {}", q("Foo"))));
}

#[test]
fn a_repeated_key_is_checked_with_its_last_value() {
    let pig = entity("pig");
    assert_eq!(value(NBT_RULES, "{Saddle:\"x\",Saddle:1b}", Some(&pig)), [format!("warning 12-18 Duplicate key {}", q("Saddle"))]);
    assert_eq!(value(NBT_RULES, "{Saddle:1b,Saddle:\"x\"}", Some(&pig)).len(), 2);
}

#[test]
fn custom_model_data_allows_other_keys_in_an_item_tag() {
    assert!(value("{}", "{Foo:1b,Damage:1}", Some(&item("stone"))).is_empty());
    assert!(value("{}", "{Foo:1b}", Some(&item("diamond_sword"))).is_empty());
    // the exception is for the tag itself, not for the compounds in it
    assert_eq!(value("{}", "{display:{Foo:1}}", Some(&item("stone"))).len(), 1);
}

#[test]
fn marker_data_is_not_checked_but_its_keys_are_named() {
    let marker = entity("marker");
    assert!(value("{}", "{data:{foo:1b,Bar:{x:[1]}}}", Some(&marker)).is_empty());
    assert_eq!(value("{}", "{Foo:1}", Some(&marker)).len(), 1);
    assert_eq!(
        value(PASCAL, "{data:{foo:1b,Bar:1b}}", Some(&marker)),
        [format!("information 7-10 Invalid key {} which doesn't follow {} or {} convention", q("foo"), q("PascalCase"), q("/^id$/"))]
    );
}

#[test]
fn or_takes_the_first_alternative_without_diagnostics() {
    let pig = entity("pig");
    assert!(value("{}", "{Leash:{UUID:[I;1,2,3,4]}}", Some(&pig)).is_empty());
    assert!(value("{}", "{Leash:{X:1,Y:2,Z:3}}", Some(&pig)).is_empty());
    // when none is clean, the diagnostics of the last alternative are the result
    let found = value("{}", "{Leash:{X:1,Foo:2}}", Some(&pig));
    assert_eq!(found.len(), 1, "{found:?}");
    assert!(found[0].contains("Unknown key"));
    assert!(value("{}", "{Leash:5}", Some(&pig))[0].contains("Expected a compound tag but got an int tag"));
}

#[test]
fn enum_values_are_listed_in_the_order_of_the_file() {
    let found = value("{}", "{Color:20b}", Some(&entity("sheep")));
    assert_eq!(found.len(), 1);
    // the options come in the order of the schema
    let options = (0..15).map(|i| q(&i.to_string())).collect::<Vec<_>>().join(", ");
    assert_eq!(found[0], format!("warning 7-10 Expected {options}, or {} but got {}", q("15"), q("20")));
    assert!(value("{}", "{Color:3b}", Some(&entity("sheep"))).is_empty());
    let fox = value("{}", "{Type:\"x\"}", Some(&entity("fox")));
    assert_eq!(fox.len(), 1, "{fox:?}");
    assert!(fox[0].ends_with(&format!("but got {}", q("x"))));
    // a number where the enum is made of strings is a type mismatch, not an unknown value
    assert!(value("{}", "{Type:1}", Some(&entity("fox")))[0].contains("Expected a string tag but got an int tag"));
}

#[test]
fn number_ranges_include_both_ends() {
    let pig = entity("pig");
    assert_eq!(value("{}", "{InLove:-1}", Some(&pig)), ["warning 8-10 Expected a number between 0 and 2147483647 but got -1"]);
    assert!(value("{}", "{InLove:0}", Some(&pig)).is_empty());
    assert!(value("{}", "{InLove:2147483647}", Some(&pig)).is_empty());
}

#[test]
fn id_fields_check_the_registry_and_the_characters() {
    let pig = entity("pig");
    let effect = |id: &str| format!("{{active_effects:[{{id:{id},amplifier:1b,duration:1}}]}}");
    assert!(value(NBT_RULES, &effect("\"minecraft:speed\""), Some(&pig)).is_empty());
    assert!(value(NBT_RULES, &effect("\"speed\""), Some(&pig)).is_empty());
    let unknown = value(NBT_RULES, &effect("\"minecraft:foo\""), Some(&pig));
    assert_eq!(unknown.len(), 1);
    assert!(unknown[0].starts_with("error "));
    assert!(unknown[0].ends_with(&format!(
        "Failed to resolve namespaced ID {} in registry {} (rule: {})",
        q("minecraft:foo"),
        q("minecraft:mob_effect"),
        q("strictMobEffectCheck")
    )));
    // without the strict setting an unknown id is not reported
    assert!(value("{}", &effect("\"minecraft:foo\""), Some(&pig)).is_empty());
    let upper = value(NBT_RULES, &effect("\"minecraft:Speed\""), Some(&pig));
    assert!(upper.iter().any(|d| d.ends_with("Found non [a-z0-9/._-] character(s)")), "{upper:?}");
    assert!(value(NBT_RULES, &effect("\"#minecraft:speed\""), Some(&pig))[0].ends_with("Tags are not allowed here"));
    // an Id field wants a quote even where a plain string would not be asked
    let unquoted = value(NBT_RULES, &effect("speed"), Some(&pig));
    assert_eq!(unquoted.len(), 1);
    assert!(unquoted[0].contains("Expected a quote"));
}

#[test]
fn id_ranges_are_inside_the_quotes_and_data_driven_ids_are_references() {
    let pig = entity("pig");
    let found = value(NBT_RULES, "{DeathLootTable:\"foo:Bar\"}", Some(&pig));
    assert_eq!(found.len(), 2, "{found:?}");
    assert!(found.contains(&"error 21-24 Found non [a-z0-9/._-] character(s)".to_string()));
    assert!(found.contains(&"ref loot_table foo:Bar 17-24".to_string()));
    assert!(value("{}", "{DeathLootTable:'foo:bar'}", Some(&pig)).contains(&"ref loot_table foo:bar 17-24".to_string()));
}

#[test]
fn list_and_array_lengths() {
    let pig = entity("pig");
    assert_eq!(
        value(NBT_RULES, "{Motion:[0.0d,0.0d]}", Some(&pig)),
        [format!("error 8-19 Expected a collection with length 3 (rule: {})", q("nbtListLengthCheck"))]
    );
    assert_eq!(
        value(NBT_RULES, "{LoveCause:[I;1,2,3]}", Some(&pig)),
        [format!("warning 11-20 Expected a collection with length 4 (rule: {})", q("nbtArrayLengthCheck"))]
    );
    assert!(value(NBT_RULES, "{Motion:[0.0d,0.0d,0.0d]}", Some(&pig)).is_empty());
    let off = r#"{"datapack.lint.nbtListLengthCheck": null, "datapack.lint.nbtArrayLengthCheck": null}"#;
    assert!(value(off, "{Motion:[0.0d],LoveCause:[I;1]}", Some(&pig)).is_empty());
    // lists are not checked unless asked, arrays are
    assert_eq!(value("{}", "{Motion:[0.0d],LoveCause:[I;1]}", Some(&pig)).len(), 1);
    let between = value(NBT_RULES, "{ArmorDropChances:[0f,0f,0f]}", Some(&entity("zombie")));
    assert!(between[0].contains("length 4"), "{between:?}");
}

#[test]
fn nbt_boolean_reads_a_false_setting() {
    let pig = entity("pig");
    assert_eq!(value(NBT_RULES, "{Saddle:true}", Some(&pig)), [format!("warning 8-12 Expected a byte tag but got {}", q("true"))]);
    assert!(value(NBT_RULES, "{Saddle:1b}", Some(&pig)).is_empty());
    assert!(value(NBT_RULES, "{Saddle:0b}", Some(&pig)).is_empty());
    let literal = r#"{"datapack.lint.nbtBoolean": ["information", true]}"#;
    assert_eq!(value(literal, "{Saddle:1b}", Some(&pig)), [format!("information 8-10 Expected {} or {}", q("false"), q("true"))]);
    assert!(value(literal, "{Saddle:false}", Some(&pig)).is_empty());
    // no schema, no judgement; and only Boolean fields are judged
    assert!(value(NBT_RULES, "{Saddle:true}", None).is_empty());
    assert!(value(NBT_RULES, "{InLove:true}", Some(&pig)).iter().all(|d| !d.contains("a byte tag but got")));
}

#[test]
fn quotes_of_keys_and_values() {
    let pig = entity("pig");
    let found = value(NBT_RULES, "{\"Saddle\":1b,'Silent':1b,Glowing:1b}", Some(&pig));
    assert_eq!(found.len(), 3, "{found:?}");
    assert!(found[0].starts_with(&format!("warning 1-9 Expected an unquoted string but got {} (rule: {})", q("\""), q("nbtCompoundKeyQuote"))));
    assert!(found[1].contains(&format!("Expected an unquoted string but got {}", q("'"))));
    assert!(found[2].ends_with(&format!("Double quote ({}) is preferable here (rule: {})", q("\""), q("nbtCompoundKeyQuoteType"))));
    // strings: only quoted ones are looked at, and `Team` holds a team reference
    let single = value(NBT_RULES, "{Team:'x'}", Some(&pig));
    assert_eq!(single.len(), 2, "{single:?}");
    assert!(single.contains(&"ref team x 7-8".to_string()));
    assert_eq!(value(NBT_RULES, "{Team:\"x\"}", Some(&pig)), ["ref team x 7-8"]);
    assert!(value(NBT_RULES, "{Team:x}", Some(&pig)).is_empty());
    assert!(value(NBT_RULES, "{Team:''}", Some(&pig)).is_empty());
    assert!(value(NBT_RULES, "{Team:'a\"b'}", Some(&pig)).iter().all(|d| !d.contains("preferable")));
}

#[test]
fn the_rules_apply_alike_to_the_snbt_of_1_21_5() {
    let modern = |src: &str| {
        let node = parse_tag(&mut Reader::new(src, 0), true).unwrap();
        let config = Config::from_settings(NBT_RULES).unwrap();
        describe(&check_value(crate::data::for_version("1.21.5").unwrap(), &config, &node, Some(&entity("pig"))))
    };
    let keys = modern("{\"Silent\":1b,'Glowing':1b}");
    assert_eq!(keys.len(), 3, "{keys:?}");
    assert!(keys[0].starts_with(&format!("warning 1-9 Expected an unquoted string but got {} (rule: {})", q("\""), q("nbtCompoundKeyQuote"))));
    assert!(keys[2].ends_with(&format!("Double quote ({}) is preferable here (rule: {})", q("\""), q("nbtCompoundKeyQuoteType"))));
    assert_eq!(modern("{Team:'x'}").len(), 2);
    // the forms that 1.21.5 adds are neither strings nor quoted keys
    assert!(modern("{Silent: bool(1), Air: 0x1Fs, UUID: uuid(\"f81d4fae-7dec-11d0-a765-00a0c91e6bf6\")}").is_empty());
}

#[test]
fn inner_strings_hold_references() {
    let pig = entity("pig");
    assert_eq!(value(NBT_RULES, "{Tags:[\"Foo\",\"Bar\"]}", Some(&pig)), ["ref tag Foo 8-11", "ref tag Bar 14-17"]);
    // unquoted strings and untyped NBT are not looked into
    assert!(value(NBT_RULES, "{Tags:[Foo]}", Some(&pig)).is_empty());
    assert!(value(NBT_RULES, "{Tags:[\"Foo\"]}", None).is_empty());
    // an escaped string reports at the whole string
    assert_eq!(value(NBT_RULES, "{Tags:[\"F\\\\oo\"]}", Some(&pig)), ["ref tag F 7-14"]);
}

#[test]
fn untyped_values_get_only_what_the_parser_reports() {
    let settings = r#"{
        "datapack.lint.nameOfNbtCompoundTagKeys": ["information", "PascalCase"],
        "datapack.lint.nbtCompoundKeyQuote": ["warning", false],
        "datapack.lint.nbtTypeCheck": ["warning", "strictly"],
        "datapack.lint.nbtBoolean": ["warning", false]
    }"#;
    let found = value(settings, "{foo:1b,\"Bar\":128b,Baz:true,Baz:'x',health:\"x\"}", None);
    assert_eq!(found.len(), 5, "{found:?}");
    assert!(found.iter().any(|d| d.contains(&format!("Invalid key {}", q("foo")))));
    assert!(found.iter().any(|d| d.contains("Expected an unquoted string")));
    assert!(found.iter().any(|d| d.contains("Expected a number between -128 and 127 but got 128")));
    assert!(found.iter().any(|d| d.contains(&format!("Duplicate key {}", q("Baz")))));
    assert!(found.iter().any(|d| d.contains(&format!("Invalid key {}", q("health")))));
    // no type check, unknown key, boolean, or string quote without a schema
    for rule in ["nbtTypeCheck", "nbtStringQuote", "nbtStringQuoteType"] {
        assert!(found.iter().all(|d| !d.contains(rule)), "{rule}: {found:?}");
    }
    assert!(found.iter().all(|d| !d.contains("Unknown key") && !d.contains("a byte tag")));
    assert!(value(NBT_RULES, "[Foo,'bar']", None).is_empty());
}

#[test]
fn number_literals_out_of_range_are_warned_about() {
    let found = value("{}", "{a:128b,b:-129b,c:32768s,d:2147483648,e:9223372036854775808L,f:127b,g:-128b,h:128}", None);
    assert_eq!(
        found,
        [
            "warning 3-7 Expected a number between -128 and 127 but got 128",
            "warning 10-15 Expected a number between -128 and 127 but got -129",
            "warning 18-24 Expected a number between -32,768 and 32,767 but got 32768",
            "warning 27-37 Expected a number between -2,147,483,648 and 2,147,483,647 but got 2147483648",
            "warning 40-60 Expected a number between -9,223,372,036,854,775,808 and 9,223,372,036,854,775,807 but got 9223372036854775808",
        ]
    );
    // a list takes them as strings, and so does a number that is not an integer
    assert_eq!(value("{}", "[128b,129b]", None).len(), 2);
    assert!(value("{}", "[1.5b,abc,\"128b\"]", None).is_empty());
}

#[test]
fn keys_without_a_doc_are_named() {
    let pig = entity("pig");
    // a key the schema names is exempt; the others are named whether or not the schema knows them
    let found = value(PASCAL, "{active_effects:[{id:\"minecraft:speed\",amplifier:1b,foo:1}],Foo:{bar:1}}", Some(&pig));
    assert_eq!(found.iter().filter(|d| d.starts_with("information")).count(), 2, "{found:?}");
    // the keys of each struct of a union are named by the schema
    let display = entity("item_display");
    assert!(value(PASCAL, "{transformation:{translation:[0f,0f,0f]}}", Some(&display)).is_empty());
    assert!(value(PASCAL, "{transformation:[1f,0f,0f,0f,0f,1f,0f,0f,0f,0f,1f,0f,0f,0f,0f,1f]}", Some(&display)).is_empty());
    assert!(value(PASCAL, "{Foo:1,id:2}", None).is_empty());
    assert_eq!(value(PASCAL, "{uuid:1}", None).len(), 1);
}

#[test]
fn an_item_tag_follows_the_type_of_the_item() {
    // a block item has the tag of any item, whose keys outside the schema are free
    assert!(value("{}", "{BlockStateTag:{half:\"x\"},Foo:1b}", Some(&item("oak_stairs"))).is_empty());
    assert_eq!(value("{}", "{display:{Foo:1}}", Some(&item("oak_stairs"))).len(), 1);
    // a spawn egg's entity follows the id inside it
    assert_eq!(value("{}", "{EntityTag:{id:\"minecraft:pig\",Foo:1}}", Some(&item("pig_spawn_egg"))).len(), 1);
    assert!(value("{}", "{EntityTag:{id:\"minecraft:pig\",Saddle:1b}}", Some(&item("pig_spawn_egg"))).is_empty());
}

#[test]
fn registry_supers_follow_the_id_in_the_compound() {
    let pig = entity("pig");
    let found = value("{}", "{Passengers:[{id:\"minecraft:cow\",Foo:1b},{Foo:1b}]}", Some(&pig));
    // the second passenger has no id, so every entity's keys are allowed
    assert_eq!(found, [format!("warning 33-36 Unknown key {}", q("Foo")), format!("warning 42-45 Unknown key {}", q("Foo"))]);
    assert!(value("{}", "{Passengers:[{id:\"minecraft:pig\",Saddle:1b}]}", Some(&pig)).is_empty());
    // a cow has no saddle
    assert_eq!(value("{}", "{Passengers:[{id:\"minecraft:cow\",Saddle:1b}]}", Some(&pig)).len(), 1);
    assert!(value("{}", "{Passengers:[{Saddle:1b}]}", Some(&pig)).is_empty());
}

#[test]
fn the_fallback_is_used_when_the_id_is_unknown() {
    let fallback = Target::new(Category::Entity, None);
    assert!(value("{}", "{Saddle:1b,Health:1f}", Some(&fallback)).is_empty());
    assert_eq!(value("{}", "{Foo:1b}", Some(&fallback)).len(), 1);
    let unregistered = entity("no_such_entity");
    assert!(value("{}", "{Saddle:1b}", Some(&unregistered)).is_empty());
}

#[test]
fn path_checks_keys_filters_and_indexes() {
    let pig = entity("pig");
    let at = |src: &str| path(NBT_RULES, src, Some(&pig));
    assert!(at("Health").is_empty());
    assert!(at("Motion[0]").is_empty());
    assert!(at("Motion[]").is_empty());
    assert_eq!(at("Foo"), [format!("warning 0-3 Unknown key {}", q("Foo"))]);
    let after_key = at("Health.foo");
    assert_eq!(after_key, ["warning 7-10 Keys are only used for compound tags"]);
    assert_eq!(at("Health[0]"), ["warning 6-7 Indices are only used for lists/arrays tags"]);
    // the filter after a non-compound has no schema
    assert_eq!(at("Health{a:1}"), ["warning 6-7 Compound filters are only used for compound tags"]);
    // a list element is a tag of the list's value type; an array's has no keys or indexes
    assert_eq!(at("Motion[0].x"), ["warning 10-11 Keys are only used for compound tags"]);
    assert_eq!(at("LoveCause[0].x"), ["warning 12-13 The current tag doesn't have extra items"]);
    let element_filter = at("LoveCause[{a:1}]");
    assert_eq!(element_filter[0], "warning 10-11 The current tag doesn't have extra items");
    assert!(at("Leash.X").is_empty());
    assert_eq!(at("Leash.Foo").len(), 1);
}

#[test]
fn path_filters_are_checked_against_the_compound_they_follow() {
    let pig = entity("pig");
    let at = |src: &str| path(NBT_RULES, src, Some(&pig));
    assert!(at("Brain{memories:{}}").is_empty());
    // a passenger's own id picks its type; without one every entity's keys are allowed
    assert_eq!(at("Passengers[{id:\"minecraft:pig\",Foo:1}]").len(), 1);
    assert!(at("Passengers[{id:\"minecraft:pig\"}]").is_empty());
    assert_eq!(at("Passengers[{Foo:1}]").len(), 1);
    assert!(at("Passengers[{Saddle:1b}]").is_empty());
    // a filter is a predicate: types are strict
    assert_eq!(at("Passengers[{id:\"minecraft:pig\",Health:1}]").len(), 1);
    assert!(at("Passengers[{id:\"minecraft:pig\",Health:1f}]").is_empty());
    // after an unknown key there is no schema
    assert!(path(NBT_RULES, "Foo{Saddle:true}", Some(&pig)).iter().all(|d| !d.contains("Unknown key \u{201c}Saddle")));
}

#[test]
fn a_filter_at_the_root_takes_every_type_of_the_category() {
    let fallback = Target::new(Category::Entity, None);
    assert_eq!(path(NBT_RULES, "{Foo:1}", Some(&fallback)), [format!("warning 1-4 Unknown key {}", q("Foo"))]);
    assert!(path(NBT_RULES, "{Health:1f}.Health", Some(&fallback)).is_empty());
    assert_eq!(path(NBT_RULES, "{Foo:1}", Some(&entity("pig"))).len(), 1);
}

#[test]
fn path_marker_data_allows_unknown_keys_below() {
    let marker = entity("marker");
    assert!(path(NBT_RULES, "data.foo.bar[0].baz", Some(&marker)).is_empty());
    assert_eq!(path(NBT_RULES, "Foo.bar", Some(&marker)).len(), 1);
}

#[test]
fn path_quotes_apply_without_a_schema() {
    let found = path(NBT_RULES, "\"a\".'b'.c", None);
    assert_eq!(found.len(), 3, "{found:?}");
    assert!(found[0].starts_with(&format!("warning 0-3 Expected an unquoted string but got {} (rule: {})", q("\""), q("nbtPathQuote"))));
    assert!(path(NBT_RULES, "a.b[0].c{d:1}", None).is_empty());
}

#[test]
fn path_single_quoted_keys_are_read_as_the_game_reads_them() {
    // The default quote rules still apply; only the key lookup is checked here.
    let pig = entity("pig");
    let unknown = |found: Vec<String>| found.into_iter().filter(|d| d.contains("Unknown key")).collect::<Vec<_>>();
    assert!(unknown(path("{}", "'Health'", Some(&pig))).is_empty());
    assert!(unknown(path("{}", "\"Health\"", Some(&pig))).is_empty());
    assert_eq!(unknown(path("{}", "'Nope'", Some(&pig))), [format!("warning 0-6 Unknown key {}", q("Nope"))]);
}

#[test]
fn path_or_picks_the_first_branch_that_adds_no_diagnostic() {
    // `Leash` is an Or of two compounds: X is in the second only, UUID in the first only
    let pig = entity("pig");
    assert!(path(NBT_RULES, "Leash.UUID", Some(&pig)).is_empty());
    assert!(path(NBT_RULES, "Leash.X", Some(&pig)).is_empty());
    assert_eq!(path(NBT_RULES, "Leash.Foo", Some(&pig)).len(), 1);
}

#[test]
fn commands_pick_the_schema_of_each_nbt_argument() {
    // summon: the entity named
    assert_eq!(command("{}", "summon pig ~ ~ ~ {Foo:1b}").len(), 1);
    assert!(command("{}", "summon pig ~ ~ ~ {Saddle:1b}").is_empty());
    assert_eq!(command("{}", "summon cow ~ ~ ~ {Saddle:1b}").len(), 1);
    // data merge entity: the selector's type; block and storage are untyped
    assert_eq!(command("{}", "data merge entity @e[type=cow,limit=1] {Saddle:1b}").len(), 1);
    assert!(command("{}", "data merge entity @s {Saddle:1b}").is_empty());
    assert!(command("{}", "data merge entity @e[type=pig,limit=1] {Saddle:1b}").is_empty());
    assert!(command("{}", "data merge storage a:b {Foo:1b}").is_empty());
    assert!(command("{}", "data merge block ~ ~ ~ {Foo:1b}").is_empty());
    // function arguments are never typed
    assert!(command("{}", "function a:b {Foo:1b}").iter().all(|d| !d.contains("Unknown key")));
}

#[test]
fn a_data_modify_value_is_typed_by_the_target_path_with_a_spyglass_json() {
    let command = |settings: &str, line: &str| {
        let mut config = Config::from_settings(settings).unwrap();
        config.merge_spyglass("{}").unwrap();
        diagnostics_of(&config, line)
    };
    let wrong = command(NBT_RULES, "data modify entity @s Saddle set value {Foo:true}");
    assert_eq!(wrong, ["warning 39-49 Expected a byte tag but got a compound tag (rule: “nbtTypeCheck”)"]);
    assert_eq!(command(NBT_RULES, "data modify entity @s NoAI set value false"), ["warning 37-42 Expected a byte tag but got “false”"]);
    assert!(command(NBT_RULES, "data modify entity @s NoAI set value 1b").is_empty());
    assert_eq!(command(NBT_RULES, "data modify entity @s NoAI set value 1"), ["error 37-38 Expected a boolean"]);
    // number kinds are interchangeable, even with `nbtTypeCheck: strictly`
    assert!(command(NBT_RULES, "data modify entity @s Health set value 1d").is_empty());
    assert!(command(NBT_RULES, "data modify entity @s Air set value 1b").is_empty());
    assert_eq!(command(NBT_RULES, "data modify entity @s CustomName set value \"abc\"").len(), 1);
    assert!(command(NBT_RULES, "data modify entity @s CustomName set value '\"abc\"'").is_empty());
    // the element type for append / prepend / insert
    assert!(command(NBT_RULES, "data modify entity @s Tags append value \"A\"").is_empty());
    assert_eq!(command(NBT_RULES, "data modify entity @s Tags insert 0 value 1b").len(), 1);
    // no schema: storage, and keys the schema does not know
    assert!(command(NBT_RULES, "data modify storage a:b NoAI set value {Foo:true}").is_empty());
    assert_eq!(command(NBT_RULES, "data modify entity @s Foo set value {Foo:true}"), ["warning 22-25 Unknown key “Foo”"]);
}

#[test]
fn unquoted_strings_need_quotes_only_with_a_spyglass_json() {
    let line = "summon marker ~ ~ ~ {Tags:[A,\"B\"]}";
    assert!(command(NBT_RULES, line).is_empty());
    let mut config = Config::from_settings(NBT_RULES).unwrap();
    config.merge_spyglass("{}").unwrap();
    let found = diagnostics_of(&config, line);
    assert_eq!(found.len(), 1, "{found:?}");
    assert!(found[0].starts_with("warning 27-28 "), "{found:?}");
}

fn with_spyglass(line: &str) -> Vec<String> {
    let mut config = Config::from_settings(NBT_RULES).unwrap();
    config.merge_spyglass("{}").unwrap();
    diagnostics_of(&config, line)
}

#[test]
fn whole_values_need_the_keys_mcdoc_requires_with_a_spyglass_json() {
    let line = "summon text_display ~ ~ ~ {text:'\"a\"'}";
    assert_eq!(with_spyglass(line), ["error 26-38 Missing key “alignment”"]);
    assert!(command(NBT_RULES, line).is_empty());
    assert!(with_spyglass("summon text_display ~ ~ ~ {text:'\"a\"',alignment:\"center\"}").is_empty());
    assert_eq!(with_spyglass("summon item_display ~ ~ ~ {item:{}}"), ["error 32-34 Missing key “id”"]);
    assert_eq!(with_spyglass("data modify entity @s item set value {}"), ["error 37-39 Missing key “id”"]);
    assert!(with_spyglass("data modify entity @s item merge value {}").is_empty());
    assert!(with_spyglass("kill @e[nbt={item:{}}]").is_empty());
    assert!(with_spyglass("summon zombie ~ ~ ~ {ArmorItems:[{},{},{},{}]}").is_empty());
    assert!(with_spyglass("data modify entity @e[type=zombie,limit=1] HandItems[0] set value {}").is_empty());
    assert!(with_spyglass("data modify entity @e[type=zombie,limit=1] HandItems append value {}").is_empty());
    assert_eq!(with_spyglass("summon chest_minecart ~ ~ ~ {Items:[{Slot:0b,Count:1b}]}"), ["error 36-54 Missing key “id”"]);
    assert!(with_spyglass("summon sniffer ~ ~ ~ {NoAI:1b}").is_empty());
    assert!(with_spyglass("summon lightning_bolt ~ ~ ~ {Tags:[\"x\"]}").is_empty());
}

#[test]
fn teleport_duration_is_0_to_59_with_a_spyglass_json() {
    let line = "summon item_display ~ ~ ~ {teleport_duration:60}";
    assert_eq!(with_spyglass(line), ["error 45-47 Expected numeric value to be at least 0 and at most 59"]);
    assert_eq!(command(NBT_RULES, line), ["warning 45-47 Expected a number between 0 and 59 but got 60"]);
    assert!(with_spyglass("summon item_display ~ ~ ~ {teleport_duration:59}").is_empty());
    let modify = "data modify entity @e[type=text_display,limit=1] teleport_duration set value 60";
    assert_eq!(with_spyglass(modify), ["error 77-79 Expected numeric value to be at least 0 and at most 59"]);
}

#[test]
fn interpret_belongs_to_nbt_components_with_a_spyglass_json() {
    let line = r#"tellraw @s [{"text":"","interpret":false}]"#;
    assert_eq!(
        with_spyglass(line),
        ["error 13-19 Invalid combination of keys “interpret” and “text”", "error 23-34 Invalid combination of keys “interpret” and “text”"]
    );
    assert!(command(NBT_RULES, line).is_empty());
    assert!(with_spyglass(r#"tellraw @s {"nbt":"a","storage":"a:b","interpret":true}"#).is_empty());
}

#[test]
fn an_id_starting_with_a_non_ascii_character_is_reported_on_whole_characters() {
    let found = command("{}", "summon item ~ ~ ~ {Item:{id:\"あ\",Count:1b}}");
    assert!(found.contains(&"error 29-32 Expected a namespaced ID but got nothing".to_string()), "{found:?}");
}

#[test]
fn a_data_modify_value_is_untyped_without_a_spyglass_json() {
    assert!(command(NBT_RULES, "data modify entity @s Saddle set value {Foo:true}").is_empty());
    assert!(command(NBT_RULES, "data modify entity @s NoAI set value false").is_empty());
}

#[test]
fn a_selector_nbt_sees_the_type_before_it_only() {
    let before = command("{}", "kill @e[type=cow,nbt={Saddle:1b}]");
    assert_eq!(before.len(), 1, "{before:?}");
    assert!(command("{}", "kill @e[nbt={Saddle:1b},type=cow]").is_empty());
    assert!(command("{}", "kill @e[type=!cow,nbt={Saddle:1b}]").is_empty());
    assert!(command("{}", "kill @e[type=#minecraft:skeletons,nbt={Saddle:1b}]").is_empty());
    // @a is a player whatever `type=` says
    assert_eq!(command("{}", "kill @a[nbt={Saddle:1b}]").len(), 1);
    // a selector's NBT is a predicate: types are strict
    assert_eq!(command("{}", "kill @e[type=pig,nbt={Health:20}]").len(), 1);
}

#[test]
fn block_and_item_arguments_pick_their_registry() {
    assert_eq!(command("{}", "setblock ~ ~ ~ chest{Foo:1b}").len(), 1);
    assert!(command("{}", "setblock ~ ~ ~ chest{Items:[]}").is_empty());
    // a block without a block entity has an empty compound
    assert_eq!(command("{}", "setblock ~ ~ ~ stone{Items:[]}").len(), 1);
    // execute if block is a predicate, clone filtered is not
    assert_eq!(command("{}", "execute if block ~ ~ ~ furnace{BurnTime:1}").len(), 1);
    assert!(command("{}", "clone ~ ~ ~ ~ ~ ~ ~ ~ ~ filtered furnace{BurnTime:1}").is_empty());
    assert!(command("{}", "setblock ~ ~ ~ furnace{BurnTime:1}").is_empty());
    assert_eq!(command("{}", "give @s stone{display:{Foo:1}}").len(), 1);
    assert_eq!(command("{}", "clear @s stone{Damage:1b}").len(), 1);
    assert!(command("{}", "give @s stone{Damage:1}").is_empty());
}

#[test]
fn commands_pick_the_schema_of_each_path() {
    assert_eq!(command("{}", "data get entity @e[type=pig,limit=1] Foo").len(), 1);
    assert!(command("{}", "data get entity @e[type=pig,limit=1] Saddle").is_empty());
    assert!(command("{}", "data get entity @s Saddle").is_empty());
    assert_eq!(command("{}", "data get entity @s Foo").len(), 1);
    assert!(command("{}", "data get storage a:b Foo.bar").iter().all(|d| !d.contains("Unknown key")));
    assert_eq!(command("{}", "data get block ~ ~ ~ Foo").len(), 1);
    assert!(command("{}", "data get block ~ ~ ~ Items[0].id").is_empty());
    // a second path in the same command follows the holder before it
    let both = command("{}", "data modify entity @e[type=cow,limit=1] Saddle set from entity @e[type=pig,limit=1] Saddle");
    assert_eq!(both.len(), 1, "{both:?}");
    assert!(command("{}", "execute as @e[type=cow] run data get entity @s Foo")[0].contains("Unknown key"));
    assert_eq!(command("{}", "execute as @e[type=pig] run summon cow ~ ~ ~ {Saddle:1b}").len(), 1);
}

#[test]
fn integers_are_compared_with_a_range_exactly() {
    let r = |min: Option<f64>, max: Option<f64>| Range { min, max, min_exclusive: false, max_exclusive: false };
    assert!(Num::Int(i64::MAX).within(&r(Some(i64::MIN as f64), Some(i64::MAX as f64))));
    assert!(Num::Int(1 << 53).within(&r(None, Some((1u64 << 53) as f64))));
    assert!(!Num::Int((1 << 53) + 1).within(&r(None, Some((1u64 << 53) as f64))));
    assert!(Num::Int(5).within(&r(Some(5.0), Some(5.0))));
    assert!(!Num::Int(5).within(&r(Some(5.5), None)));
    assert!(!Num::Int(-1).within(&r(Some(0.0), None)));
    assert!(Num::Float(0.5).within(&r(Some(0.0), Some(1.0))));
    assert!(!Num::Float(1.5).within(&r(Some(0.0), Some(1.0))));
    assert!(!Num::Float(0.0).within(&Range { min_exclusive: true, ..r(Some(0.0), None) }));
}

#[test]
fn an_area_effect_cloud_reads_its_particle_as_a_particle_argument() {
    let found = command("{}", "summon area_effect_cloud ~ ~ ~ {Particle:\"minecraft:nope\"}");
    assert_eq!(found.len(), 1, "{found:?}");
    assert!(found[0].contains("Unknown particle"), "{found:?}");
    assert!(command("{}", "summon area_effect_cloud ~ ~ ~ {Particle:\"dust 1 0 0 1\"}").is_empty());
}

#[test]
fn an_item_without_its_id_may_be_any_item() {
    assert!(command("{}", "execute if entity @s[nbt={SelectedItem:{tag:{display:{color:1}}}}]").is_empty());
    assert_eq!(command("{}", "execute if entity @s[nbt={SelectedItem:{id:\"minecraft:stone\",tag:{display:{color:1}}}}]").len(), 1);
}

#[test]
fn horses_and_llamas_keep_their_armor_and_decor_in_1_20_4() {
    assert!(command("{}", "summon horse ~ ~ ~ {ArmorItem:{id:\"minecraft:iron_horse_armor\",Count:1b}}").is_empty());
    assert!(command("{}", "summon trader_llama ~ ~ ~ {DecorItem:{id:\"minecraft:red_carpet\",Count:1b}}").is_empty());
    assert_eq!(command("{}", "summon pig ~ ~ ~ {ArmorItem:{id:\"minecraft:iron_horse_armor\",Count:1b}}").len(), 1);
}

#[test]
fn a_tag_past_the_check_limit_is_checked_in_part_with_a_warning() {
    let node = parse_tag(&mut Reader::new("{Passengers:[{id:\"minecraft:pig\",Health:1.0f}]}", 0), false).unwrap();
    let config = Config::default();
    let pig = entity("pig");
    let limited = |found: Vec<String>| found.iter().any(|d| d.contains(CHECK_LIMIT_MESSAGE));
    assert!(!limited(describe(&check_value(data(), &config, &node, Some(&pig)))));
    assert!(limited(describe(&check_value_with(data(), &config, &node, Some(&pig), CheckLimit::new(1)))));
}

#[test]
fn a_path_filter_past_the_check_limit_is_checked_in_part_with_a_warning() {
    let nodes = parse_path(&mut Reader::new("Passengers[{id:\"minecraft:pig\",Health:1.0f}]", 0), false).unwrap();
    let config = Config::default();
    let pig = entity("pig");
    let limited = |found: Vec<String>| found.iter().any(|d| d.contains(CHECK_LIMIT_MESSAGE));
    assert!(!limited(describe(&check_path(data(), &config, &nodes, Some(&pig)))));
    assert!(limited(describe(&walk_path(data(), &config, &steps(&nodes), Some(&pig), CheckLimit::new(0)))));
}

#[test]
fn duplicate_keys_of_a_large_compound_are_found_in_linear_time() {
    let keys: Vec<String> = (0..20_000).map(|i| format!("k{i}:1b")).collect();
    let found = value("{}", &format!("{{{},k0:1b}}", keys.join(",")), Some(&entity("pig")));
    assert_eq!(found.iter().filter(|d| d.contains("Duplicate key")).count(), 1);
    assert_eq!(found.iter().filter(|d| d.contains("Unknown key")).count(), 20_000);
}
