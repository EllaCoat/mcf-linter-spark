// Starts VSCode with only this extension, on test/fixtures/editor, and runs suite.ts.
//
// Usage: node test/run.mts <path to Code.exe or the code binary> [<extension directory>]
// The extension directory defaults to this source tree (run `pnpm run bundle` first); pass the
// `extension/` directory of an unpacked VSIX to test the package itself.
// Uses fresh user-data and extensions directories under MCF_LINTER_SPARK_VSCODE_TEST_DIR (default:
// the temporary directory of the OS) so that the user's VSCode profile is not touched.

import { runTests } from "@vscode/test-electron";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const vscodeExecutablePath = process.argv[2];
if (!vscodeExecutablePath) {
  console.error("usage: node test/run.mts <path to Code.exe or the code binary> [<extension directory>]");
  process.exit(2);
}
const base = process.env.MCF_LINTER_SPARK_VSCODE_TEST_DIR ?? tmpdir();
mkdirSync(base, { recursive: true });
const work = mkdtempSync(join(base, "mcf-linter-spark-vscode-"));
const fixture = join(here, "fixtures", "editor");

// VSCode loads the tests as a CommonJS module that exports `run`.
await build({ entryPoints: [join(here, "suite.ts")], bundle: true, platform: "node", format: "cjs", external: ["vscode"], outfile: join(work, "suite.js"), logLevel: "warning" });

await runTests({
  vscodeExecutablePath,
  extensionDevelopmentPath: process.argv[3] ? resolve(process.argv[3]) : resolve(here, ".."),
  extensionTestsPath: join(work, "suite.js"),
  launchArgs: [fixture, "--disable-extensions", `--user-data-dir=${join(work, "user")}`, `--extensions-dir=${join(work, "ext")}`],
});
