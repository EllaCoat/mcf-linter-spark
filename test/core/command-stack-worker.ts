// Parses lines in a worker whose stack is as large as the CLI's (64 MiB).
import { parentPort, workerData } from "node:worker_threads";

import { parseCommand } from "../../src/core/command.ts";
import { Config } from "../../src/core/config.ts";
import { loadVersionData } from "../../src/core/data.ts";

const { version, lines } = workerData as { version: string; lines: string[] };
const data = await loadVersionData(version);
parentPort!.postMessage(lines.map((line) => parseCommand(line, 0, data, new Config()).error?.message));
