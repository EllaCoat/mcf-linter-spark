// The work runs in a worker whose stack is large enough for the deepest commands, which are
// parsed recursively, one level per argument, up to `MAX_NODES` levels.

import { Worker, isMainThread, parentPort } from "node:worker_threads";

import { start } from "./cli.ts";

const STACK_SIZE_MB = 64;

if (isMainThread) {
  const argv = process.argv.slice(2);
  const lsp = argv[0] === "lsp";
  // The server reads its stdin in the worker, so this thread hands the input over.
  const worker = new Worker(new URL(import.meta.url), { argv, stdin: lsp, resourceLimits: { stackSizeMb: STACK_SIZE_MB } });
  if (lsp) process.stdin.pipe(worker.stdin!);
  worker.on("message", (code: number) => {
    process.exitCode = code;
  });
  worker.on("error", (e) => {
    process.stderr.write(`mcf-linter-spark: ${e.stack ?? e.message}\n`);
    process.exitCode = 2;
  });
  worker.on("exit", (code) => {
    if (!lsp) return;
    process.exitCode ??= code;
    process.stdin.unpipe(worker.stdin!);
    process.stdin.destroy();
  });
} else if (process.argv[2] === "lsp") {
  (await import("./lsp/server.ts")).run();
} else {
  parentPort!.postMessage(await start(process.argv.slice(2)));
}
