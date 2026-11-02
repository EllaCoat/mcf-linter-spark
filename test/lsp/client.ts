// A minimal LSP client over stdio, for the server tests and `scripts/lsp-compare.ts`.

import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

export type Json = unknown;

/** A message the server starts. Requests of the server (they carry an `id`) are not answered. */
export interface Notification {
  method: string;
  params: Json;
  id?: number;
}

/** The response to a request that failed. */
export class ResponseFailure extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

interface Message {
  id?: number;
  method?: string;
  params?: Json;
  result?: Json;
  error?: { code: number; message: string };
}

export class LspClient {
  private readonly child: ChildProcessByStdio<Writable, Readable, Readable | null>;
  private readonly timeoutMs: number;
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, { resolve: (result: Json) => void; reject: (e: Error) => void }>();
  /** What the server started besides responses, in order, until `takeNotifications` takes them. */
  private notifications: Notification[] = [];
  /** What the server wrote to stderr (kept only with `stderr: "pipe"`). */
  stderr = "";
  readonly exited: Promise<number | null>;

  constructor(command: string, args: readonly string[], options: { timeoutMs?: number; stderr?: "ignore" | "pipe" } = {}) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.child = spawn(command, args, { stdio: ["pipe", "pipe", options.stderr ?? "ignore"] }) as typeof this.child;
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    this.exited = new Promise((resolve) => this.child.on("exit", (code) => resolve(code)));
    this.child.stdin.on("error", () => {});
  }

  /** `initialize` with `root` as the workspace folder, then `initialized`. Returns the response. */
  async start(root: string, initializationOptions?: Json): Promise<Json> {
    const uri = pathToFileURL(root).href;
    const result = await this.request("initialize", {
      processId: null,
      rootUri: uri,
      capabilities: {},
      workspaceFolders: [{ uri, name: "t" }],
      initializationOptions,
    });
    this.notify("initialized", {});
    return result;
  }

  private send(message: object): void {
    const body = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const length = Number(/Content-Length: (\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString())![1]);
      if (this.buffer.length < headerEnd + 4 + length) return;
      const message = JSON.parse(this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8")) as Message;
      this.buffer = this.buffer.subarray(headerEnd + 4 + length);
      if (message.method !== undefined) {
        this.notifications.push(message.id === undefined ? { method: message.method, params: message.params } : { method: message.method, params: message.params, id: message.id });
      } else if (message.id !== undefined) {
        const waiting = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiting?.reject(new ResponseFailure(message.error.code, message.error.message));
        else waiting?.resolve(message.result);
      }
    }
  }

  request(method: string, params: Json): Promise<Json> {
    const id = this.nextId++;
    const result = new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no response to ${method} in ${this.timeoutMs} ms`)), this.timeoutMs);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    return result;
  }

  notify(method: string, params: Json): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** The notifications received since the last call. */
  takeNotifications(): Notification[] {
    const taken = this.notifications;
    this.notifications = [];
    return taken;
  }

  /** `shutdown` and `exit`, then the exit code of the server. */
  async close(): Promise<number | null> {
    await this.request("shutdown", null);
    this.notify("exit", null);
    return await this.exited;
  }

  /** Stops the server process without the handshake. */
  kill(): void {
    this.child.kill();
  }
}
