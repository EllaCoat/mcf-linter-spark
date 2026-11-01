mod lsp;

use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Instant;

use spark_core::config::Config;
use spark_core::diag::Severity;
use spark_core::position::LineIndex;
use spark_core::project::{Options, Project, default_max_depth};

const USAGE: &str = "\
usage: mcf-linter-spark lsp
       mcf-linter-spark check [<root>] [--config <settings.json>] [--ignore <pattern>]... [--max-depth <n>] [--format text|github] [--json <file>] [--symbols <file>]

'mcf-linter-spark lsp' runs the language server over stdio.

Lints the data packs under <root> (default: the current directory). The DHP
settings are read from <root>/.vscode/settings.json unless --config is given.
A <root>/spyglass.json enables the IMP-Doc rules it sets and the checks of the
modified Spyglass where it differs from DHP.
--ignore takes a resource id pattern (e.g. 'animated_java:**'); matching files
are analysed but not reported. --max-depth sets how many directory levels below
<root> are searched for data packs (default 2, no limit with a spyglass.json).
--symbols writes the declarations and definitions in the shape of the cache
DHP writes to .cache/dls.json. Exits with 1 when an error or a warning is found.";

enum Format {
    Text,
    Github,
}

struct Args {
    root: PathBuf,
    config: Option<PathBuf>,
    ignore: Vec<String>,
    max_depth: Option<usize>,
    format: Format,
    json: Option<PathBuf>,
    symbols: Option<PathBuf>,
}

fn parse_args() -> Result<Args, String> {
    let mut it = std::env::args().skip(1);
    match it.next().as_deref() {
        Some("check") => {}
        Some("-h" | "--help") | None => return Err(USAGE.to_string()),
        Some(other) => return Err(format!("unknown command '{other}'\n\n{USAGE}")),
    }
    let mut args =
        Args { root: PathBuf::from("."), config: None, ignore: Vec::new(), max_depth: None, format: Format::Text, json: None, symbols: None };
    while let Some(a) = it.next() {
        let mut value = |name: &str| it.next().ok_or_else(|| format!("{name} needs a value"));
        match a.as_str() {
            "--config" => args.config = Some(value("--config")?.into()),
            "--ignore" => args.ignore.push(value("--ignore")?),
            "--max-depth" => {
                args.max_depth = Some(value("--max-depth")?.parse().map_err(|_| "--max-depth needs a number".to_string())?)
            }
            "--format" => {
                args.format = match value("--format")?.as_str() {
                    "text" => Format::Text,
                    "github" => Format::Github,
                    other => return Err(format!("unknown format '{other}'")),
                }
            }
            "--json" => args.json = Some(value("--json")?.into()),
            "--symbols" => args.symbols = Some(value("--symbols")?.into()),
            "-h" | "--help" => return Err(USAGE.to_string()),
            s if s.starts_with("--") => return Err(format!("unknown option '{s}'")),
            s => args.root = PathBuf::from(s),
        }
    }
    Ok(args)
}

const STACK_SIZE: usize = 64 << 20;

fn main() -> ExitCode {
    let pool = rayon::ThreadPoolBuilder::new().stack_size(STACK_SIZE).build_global();
    if let Err(e) = pool {
        eprintln!("mcf-linter-spark: {e}");
        return ExitCode::from(2);
    }
    match std::thread::Builder::new().stack_size(STACK_SIZE).spawn(start) {
        Ok(thread) => thread.join().unwrap_or(ExitCode::from(2)),
        Err(e) => {
            eprintln!("mcf-linter-spark: {e}");
            ExitCode::from(2)
        }
    }
}

fn start() -> ExitCode {
    if std::env::args().nth(1).as_deref() == Some("lsp") {
        return match lsp::run() {
            Ok(()) => ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("mcf-linter-spark lsp: {message}");
                ExitCode::from(2)
            }
        };
    }
    let args = match parse_args() {
        Ok(a) => a,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(2);
        }
    };
    match run(&args) {
        Ok(failed) => {
            if failed {
                ExitCode::from(1)
            } else {
                ExitCode::SUCCESS
            }
        }
        Err(message) => {
            eprintln!("mcf-linter-spark: {}", one_line(&message));
            ExitCode::from(2)
        }
    }
}

fn run(args: &Args) -> Result<bool, String> {
    let started = Instant::now();
    let config = Config::load(&args.root, args.config.as_deref())?;
    let max_depth = args.max_depth.unwrap_or_else(|| default_max_depth(&config));
    let project = Project::load(&args.root, config, &Options { ignore: args.ignore.clone(), max_depth })?;
    for notice in &project.notices {
        eprintln!("mcf-linter-spark: {}", one_line(notice));
    }
    if project.files.is_empty() {
        return Err(format!("no data pack files found under {}", args.root.display()));
    }
    let loaded = started.elapsed();
    let mut results = project.all_diagnostics();
    results.sort_by(|a, b| project.files[a.0 as usize].rel.cmp(&project.files[b.0 as usize].rel));

    let mut counts = [0usize; 4];
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    let mut json = match &args.json {
        Some(p) => Some(std::io::BufWriter::new(std::fs::File::create(p).map_err(|e| format!("{}: {e}", p.display()))?)),
        None => None,
    };
    for (fid, diags) in &results {
        let f = &project.files[*fid as usize];
        let index = LineIndex::new(&f.text);
        for d in diags {
            counts[d.severity as usize] += 1;
            let (l1, c1) = index.position(&f.text, d.start);
            let (l2, c2) = index.position(&f.text, d.end);
            match args.format {
                Format::Github if matches!(d.severity, Severity::Error | Severity::Warning) => {
                    let level = if d.severity == Severity::Error { "error" } else { "warning" };
                    let _ = writeln!(
                        out,
                        "::{level} file={},line={},col={},endLine={},endColumn={},title={}::{}",
                        escape_property(&f.rel),
                        l1 + 1,
                        c1 + 1,
                        l2 + 1,
                        c2 + 1,
                        escape_property(d.code),
                        escape_data(&d.message)
                    );
                }
                _ => {
                    let _ = writeln!(out, "{}:{}:{} {} {} ({})", line_start_path(&f.rel), l1 + 1, c1 + 1, d.severity.as_str(), one_line(&d.message), d.code);
                }
            }
            if let Some(j) = json.as_mut() {
                let line = serde_json::json!({
                    "path": f.rel, "line": l1 + 1, "column": c1 + 1, "endLine": l2 + 1, "endColumn": c2 + 1,
                    "severity": d.severity.as_str(), "code": d.code, "message": d.message, "source": "mcf-linter-spark",
                });
                let _ = writeln!(j, "{line}");
            }
        }
    }
    let _ = out.flush();
    if let Some(mut j) = json {
        j.flush().map_err(|e| e.to_string())?;
    }
    if let Some(p) = &args.symbols {
        let text = serde_json::to_string(&spark_core::symbols::dls_cache(&project)?).map_err(|e| e.to_string())?;
        if let Some(dir) = p.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        std::fs::write(p, text).map_err(|e| format!("{}: {e}", p.display()))?;
    }
    let reported = project.files.iter().filter(|f| !f.ignored).count();
    eprintln!(
        "{} errors, {} warnings, {} information, {} hints in {} files ({} ms, load {} ms)",
        counts[0],
        counts[1],
        counts[2],
        counts[3],
        reported,
        started.elapsed().as_millis(),
        loaded.as_millis()
    );
    Ok(counts[0] + counts[1] > 0)
}

fn one_line(s: &str) -> String {
    let line: String = s.chars().map(|c| if c.is_control() { c.escape_default().to_string() } else { c.to_string() }).collect();
    line.replace("##[", "##\\[")
}

fn line_start_path(rel: &str) -> String {
    let path = one_line(rel);
    if path.trim_start().starts_with("::") { format!("./{path}") } else { path }
}

fn escape_data(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '%' => "%25".to_string(),
            '\r' => "%0D".to_string(),
            '\n' => "%0A".to_string(),
            c if c.is_control() => c.escape_default().to_string(),
            c => c.to_string(),
        })
        .collect()
}

fn escape_property(s: &str) -> String {
    escape_data(s).replace(':', "%3A").replace(',', "%2C")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_that_reads_as_a_workflow_command_does_not_start_a_line() {
        assert_eq!(line_start_path(" ::warning title=x::y/data/t/function/f.mcfunction"), "./ ::warning title=x::y/data/t/function/f.mcfunction");
        assert_eq!(line_start_path("pack/data/t/function/f.mcfunction"), "pack/data/t/function/f.mcfunction");
    }
}
