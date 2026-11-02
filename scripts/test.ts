// `pnpm test [<file>...] [--node-test-option=value...]`. Node takes every argument after the first
// file pattern (or after `--`) as another pattern, so the options go before the patterns here.
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2).filter((a) => a !== "--");
const options = args.filter((a) => a.startsWith("-"));
const patterns = args.filter((a) => !a.startsWith("-"));
const r = spawnSync(
  process.execPath,
  [
    "--test",
    ...options,
    "--test-reporter=./test/reporter.ts",
    "--test-reporter-destination=stdout",
    "--test-reporter=spec",
    "--test-reporter-destination=test-results.log",
    ...(patterns.length ? patterns : ["test/**/*.test.ts"]),
  ],
  { stdio: "inherit" },
);
if (r.error) {
  console.error(`could not run the tests: ${r.error.message}`);
  process.exitCode = 2;
} else if (r.signal) {
  console.error(`the test run was stopped by ${r.signal}`);
  process.exitCode = 1;
} else {
  process.exitCode = r.status ?? 1;
}
