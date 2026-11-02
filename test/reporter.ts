import { relative, resolve } from "node:path";
import type { TestEvent } from "node:test/reporters";
import { inspect } from "node:util";

const LOG = "test-results.log";
const SHOWN_FAILURES = 20;
const SHOWN_OUTPUT = 2000;

// `scripts/test.ts` also runs node's `spec` reporter into the log; a direct `node --test` does not.
const logged = process.execArgv.includes(`--test-reporter-destination=${LOG}`);
const fullOutput = logged ? `the full output is in ${LOG}` : "run it through `pnpm test` to keep the full output";

type Failure = { name: string; file: string; where: string; text: string };

function show(value: unknown): string {
  return inspect(value, { depth: 6, breakLength: Infinity });
}

function describeError(error: unknown): string {
  const outer = error as { cause?: unknown; exitCode?: unknown; signal?: unknown } | undefined;
  const exit =
    outer?.exitCode !== undefined && outer.exitCode !== null ? [`  the test process exited with ${String(outer.exitCode)}${outer.signal ? ` (${String(outer.signal)})` : ""}`] : [];
  const e = outer?.cause ?? error;
  if (!e || typeof e !== "object") return [String(e), ...exit].join("\n");
  const { name, message, expected, actual, stack } = e as { name?: unknown; message?: unknown; expected?: unknown; actual?: unknown; stack?: unknown };
  const text = String(message ?? show(e));
  const lines = [typeof name === "string" && name !== "Error" && !text.startsWith(name) ? `${name}: ${text}` : text];
  // assert's deep comparisons already put a diff in the message.
  if (("expected" in e || "actual" in e) && !text.includes("\n")) lines.push(`  expected: ${show(expected)}`, `  actual:   ${show(actual)}`);
  if (typeof stack === "string") {
    const frames = stack.split("\n").filter((l) => /^\s+at /.test(l) && !/node:|node_modules/.test(l));
    for (const f of frames.slice(0, 3)) lines.push(`  ${f.trim()}`);
  }
  return [...lines, ...exit].join("\n");
}

export default async function* reporter(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  const failures: Failure[] = [];
  const output = new Map<string, string[]>();
  const note = (file: string | undefined, text: string) => {
    const key = file ? relative(process.cwd(), file) : "";
    output.set(key, [...(output.get(key) ?? []), text]);
  };
  const files = new Set<string>();
  let emptyFiles = 0;
  let summary: { success: boolean; counts: { tests: number; passed: number; skipped: number; todo: number; cancelled: number } } | undefined;

  for await (const event of source) {
    if ((event.type === "test:pass" || event.type === "test:fail") && event.data.file !== undefined) files.add(event.data.file);
    switch (event.type) {
      case "test:pass":
        // node counts a file that registers no test as one passing test named by the path given to it.
        if (event.data.file !== undefined && resolve(event.data.name) === event.data.file) emptyFiles++;
        break;
      case "test:fail": {
        const { data } = event;
        if (data.todo || (data.details.error as { failureType?: string }).failureType === "subtestsFailed") break;
        const file = data.file ? relative(process.cwd(), data.file) : "";
        failures.push({ name: data.name, file, where: `${file || "?"}:${data.line ?? "?"}:${data.column ?? "?"}`, text: describeError(data.details.error) });
        break;
      }
      case "test:stderr":
        note(event.data.file, event.data.message);
        break;
      case "test:diagnostic":
        // Errors raised after a test ended reach reporters only as diagnostics of the file.
        if (event.data.file) note(event.data.file, `${event.data.message}\n`);
        break;
      case "test:summary":
        if (event.data.file === undefined) summary = event.data;
        else files.add(event.data.file);
        break;
      default:
        break;
    }
  }

  for (const f of failures.slice(0, SHOWN_FAILURES)) yield `FAIL ${f.name} (${f.where})\n${f.text}\n\n`;
  const byText = new Map<string, string[]>();
  for (const file of new Set(failures.slice(0, SHOWN_FAILURES).map((f) => f.file))) {
    const text = (output.get(file) ?? []).join("");
    if (text) byText.set(text, [...(byText.get(text) ?? []), file || "the run"]);
  }
  for (const [text, where] of byText) yield `output of ${where.join(", ")}:\n${text.slice(0, SHOWN_OUTPUT)}\n\n`;
  const omitted = failures.length - Math.min(failures.length, SHOWN_FAILURES);
  if (omitted) yield `${omitted} more failures are not shown; ${fullOutput}\n`;
  if ([...byText.keys()].some((t) => t.length > SHOWN_OUTPUT)) yield `output above is cut at ${SHOWN_OUTPUT} characters; ${fullOutput}\n`;

  const c = summary?.counts ?? { tests: 0, passed: 0, skipped: 0, todo: 0, cancelled: 0 };
  const passed = c.passed - emptyFiles;
  // Also counts suites and hooks that failed, which node leaves out of its test counts.
  const failed = failures.length;
  const skipped = c.skipped + c.todo;
  const scope = `${files.size} file${files.size === 1 ? "" : "s"}`;
  if (passed === 0 && failed === 0 && c.cancelled === 0) {
    yield `No tests ran in ${scope}${skipped ? ` (${skipped} skipped)` : ""}.\n`;
    return;
  }
  const ok = summary?.success === true;
  yield `${ok ? "ok" : "FAILED"}: ${scope}, ${passed} passed, ${failed} failed, ${c.cancelled} cancelled, ${skipped} skipped${ok ? "" : `; ${fullOutput}`}\n`;
}
