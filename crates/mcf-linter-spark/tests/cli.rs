use std::path::Path;
use std::process::Command;

fn write_pack(root: &Path, files: &[(&str, &str)]) {
    let _ = std::fs::remove_dir_all(root);
    for (rel, text) in files {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
}

#[test]
fn control_characters_from_the_files_do_not_start_lines_of_the_output() {
    let root = std::env::temp_dir().join("ai-agent").join("mcf-linter-spark-tests").join("cli-control-characters");
    let advancement = r#"{"criteria": {"a": {"trigger": "minecraft:tick"}}, "rewards": {"function": "t:a\n::error file=x::injected\u001b[2J"}}"#;
    write_pack(
        &root,
        &[
            ("pack.mcmeta", r#"{"pack": {"pack_format": 48, "description": ""}}"#),
            ("data/t/advancement/x.json", advancement),
            ("settings.json", r#"{"datapack.env.cmdVersion": "1.21"}"#),
        ],
    );
    let settings = root.join("settings.json");
    for format in ["text", "github"] {
        let output = Command::new(env!("CARGO_BIN_EXE_mcf-linter-spark"))
            .arg("check")
            .arg(&root)
            .arg("--config")
            .arg(&settings)
            .args(["--format", format])
            .output()
            .unwrap();
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert_eq!(stdout.lines().count(), 1, "{format}: {stdout}");
        assert!(stdout.contains("injected"), "{format}: {stdout}");
        assert!(!stdout.contains('\u{1b}'), "{format}: {stdout}");
    }
}

#[test]
fn a_file_name_that_reads_as_a_workflow_command_is_written_escaped() {
    let root = std::env::temp_dir().join("ai-agent").join("mcf-linter-spark-tests").join("cli-workflow-command");
    write_pack(
        &root,
        &[
            ("pack.mcmeta", r#"{"pack": {"pack_format": 48, "description": ""}}"#),
            ("data/t/function/##[error]x.mcfunction", "function t:missing\n"),
            ("settings.json", r#"{"datapack.env.cmdVersion": "1.21"}"#),
        ],
    );
    let settings = root.join("settings.json");
    for format in ["text", "github"] {
        let output = Command::new(env!("CARGO_BIN_EXE_mcf-linter-spark"))
            .arg("check")
            .arg(&root)
            .arg("--config")
            .arg(&settings)
            .args(["--format", format])
            .output()
            .unwrap();
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert_eq!(stdout.lines().count(), 1, "{format}: {stdout}");
        assert!(!stdout.contains("##["), "{format}: {stdout}");
    }
}
