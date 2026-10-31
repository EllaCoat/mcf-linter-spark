// Starts VSCode with only this extension, on tests/fixtures/editor, and runs suite.js.
//
// Usage: node test/run.mjs <path to Code.exe or the code binary> [<extension directory>]
// The extension directory defaults to this source tree; pass the `extension/`
// directory of an unpacked VSIX to test the package itself.
// Uses fresh user-data and extensions directories under the given work directory
// (MCF_LINTER_SPARK_VSCODE_TEST_DIR, default: the OS temp directory) so that the user's
// VSCode profile is not touched.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const here = dirname(fileURLToPath(import.meta.url));
const vscodeExecutablePath = process.argv[2];
if (!vscodeExecutablePath) {
  console.error("usage: node test/run.mjs <path to Code.exe or the code binary>");
  process.exit(2);
}
const work = mkdtempSync(join(process.env.MCF_LINTER_SPARK_VSCODE_TEST_DIR ?? tmpdir(), "mcf-linter-spark-vscode-"));
const fixture = resolve(here, "..", "..", "..", "tests", "fixtures", "editor");

await runTests({
  vscodeExecutablePath,
  extensionDevelopmentPath: process.argv[3] ? resolve(process.argv[3]) : resolve(here, ".."),
  extensionTestsPath: join(here, "suite.js"),
  launchArgs: [fixture, "--disable-extensions", `--user-data-dir=${join(work, "user")}`, `--extensions-dir=${join(work, "ext")}`],
});
