//! The language server over stdio as an editor drives it: the completion follows the release
//! that the project's settings name.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

use lsp_types::Url;
use serde_json::{Value, json};

struct Client {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: i64,
}

impl Client {
    fn start(root: &Path) -> Client {
        let mut child = Command::new(env!("CARGO_BIN_EXE_mcf-linter-spark"))
            .arg("lsp")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let mut client = Client { child, stdin, stdout, next_id: 1 };
        let uri = Url::from_file_path(root).unwrap();
        client.request("initialize", json!({ "processId": null, "rootUri": uri, "capabilities": {}, "workspaceFolders": [{ "uri": uri, "name": "t" }] }));
        client.notify("initialized", json!({}));
        client
    }

    fn send(&mut self, message: &Value) {
        let body = message.to_string();
        write!(self.stdin, "Content-Length: {}\r\n\r\n{body}", body.len()).unwrap();
        self.stdin.flush().unwrap();
    }

    fn receive(&mut self) -> Value {
        let mut length = 0;
        loop {
            let mut line = String::new();
            self.stdout.read_line(&mut line).unwrap();
            let line = line.trim_end();
            if line.is_empty() {
                break;
            }
            if let Some(n) = line.strip_prefix("Content-Length: ") {
                length = n.parse().unwrap();
            }
        }
        let mut body = vec![0; length];
        self.stdout.read_exact(&mut body).unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        loop {
            let message = self.receive();
            if message.get("id") == Some(&json!(id)) && message.get("method").is_none() {
                return message["result"].clone();
            }
        }
    }

    fn notify(&mut self, method: &str, params: Value) {
        self.send(&json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        self.request("shutdown", Value::Null);
        self.notify("exit", Value::Null);
        let _ = self.child.wait();
    }
}

/// The labels the server completes at the end of each of `lines`, the lines of a function in a
/// project of `version` with `files` besides.
fn labels_of_lines(version: &str, functions: &str, lines: &[&str], files: &[(&str, &str)]) -> Vec<Vec<String>> {
    static PROJECTS: AtomicUsize = AtomicUsize::new(0);
    let n = PROJECTS.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join("ai-agent").join("mcf-linter-spark-tests").join(format!("lsp-{version}-{n}"));
    let _ = std::fs::remove_dir_all(&root);
    let main = root.join("data").join("t").join(functions).join("main.mcfunction");
    let settings = format!(r#"{{"datapack.env.cmdVersion": "{version}"}}"#);
    let text = lines.join("\n");
    for (path, text) in [(root.join("pack.mcmeta"), "{}"), (root.join(".vscode").join("settings.json"), settings.as_str()), (main.clone(), text.as_str())]
        .into_iter()
        .chain(files.iter().map(|(rel, text)| (root.join(rel), *text)))
    {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
    let mut client = Client::start(&root);
    let uri = Url::from_file_path(&main).unwrap();
    client.notify("textDocument/didOpen", json!({ "textDocument": { "uri": uri, "languageId": "mcfunction", "version": 1, "text": text } }));
    (0..lines.len())
        .map(|n| {
            let result = client.request("textDocument/completion", json!({ "textDocument": { "uri": uri }, "position": { "line": n, "character": lines[n].len() } }));
            let items = result.get("items").unwrap_or(&result).as_array().cloned().unwrap_or_default();
            items.iter().filter_map(|i| i["label"].as_str().map(str::to_string)).collect()
        })
        .collect()
}

fn labels(version: &str, functions: &str, line: &str, files: &[(&str, &str)]) -> Vec<String> {
    labels_of_lines(version, functions, &[line], files).remove(0)
}

fn has(labels: &[String], label: &str) -> bool {
    labels.iter().any(|l| l == label)
}

#[test]
fn completion_works_in_every_release() {
    let since = |version: &str, first: &str| spark_core::version::cmp(&spark_core::version::parse(version), &spark_core::version::parse(first)).is_ge();
    for (version, _) in spark_core::version::RELEASES {
        let functions = if since(version, "1.21") { "function" } else { "functions" };
        let item = if since(version, "1.20.5") { ("give @s diamond_sword[dam", "damage") } else { ("give @s diamond_sword{Dam", "Damage:") };
        let lines = ["gamem", "kill @", item.0, "function t:"];
        let got = labels_of_lines(version, functions, &lines, &[]);
        assert!(has(&got[0], "gamemode"), "{version}: {:?}", got[0]);
        assert!(has(&got[1], "@s"), "{version}: {:?}", got[1]);
        assert_eq!(has(&got[1], "@n"), since(version, "1.21"), "{version}: {:?}", got[1]);
        assert!(has(&got[2], item.1), "{version}: {:?}", got[2]);
        assert!(has(&got[3], "t:main"), "{version}: {:?}", got[3]);
    }
}

#[test]
fn completion_follows_the_release_of_the_project() {
    let old = labels("1.20.4", "functions", "give @s diamond_sword{Dam", &[]);
    assert!(has(&old, "Damage:"), "{old:?}");
    let enchantments = labels("1.21", "function", "enchant @s t:", &[("data/t/enchantment/sharp.json", "{}")]);
    assert!(has(&enchantments, "t:sharp"), "{enchantments:?}");

    let components = labels("1.21.5", "function", "give @s diamond_sword[dam", &[]);
    assert!(has(&components, "damage"), "{components:?}");
    let text = labels("1.21.5", "function", "tellraw @a {te", &[]);
    assert!(has(&text, "text:"), "{text:?}");

    let features = labels("26.3", "function", "place feature t:", &[("data/t/worldgen/feature/tree.json", "{}")]);
    assert!(has(&features, "t:tree"), "{features:?}");
    let slots = labels("26.3", "function", "execute if items entity @s mob.", &[]);
    assert!(has(&slots, "mob.inventory."), "{slots:?}");
}
