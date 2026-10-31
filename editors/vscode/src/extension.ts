import * as path from "node:path";
import * as vscode from "vscode";
import { LanguageClient, type LanguageClientOptions, type ServerOptions } from "vscode-languageclient/node";

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await start(context);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration("mcfLinterSpark")) {
        await client?.stop();
        await start(context);
      }
    }),
  );
}

export async function deactivate(): Promise<void> {
  await client?.stop();
}

async function start(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration("mcfLinterSpark");
  const exe = process.platform === "win32" ? "mcf-linter-spark.exe" : "mcf-linter-spark";
  const command = config.get<string>("serverPath") || path.join(context.extensionPath, "bin", exe);
  const serverOptions: ServerOptions = { command, args: ["lsp"] };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "mcfunction" },
      { scheme: "file", pattern: "**/data/*/**/*.json" },
    ],
    initializationOptions: { ignore: config.get<string[]>("ignore") ?? [], maxDepth: config.get<number | null>("maxDepth") ?? undefined },
    synchronize: {
      // Every path, so that deleting or renaming a folder reaches the server
      // (VSCode reports only the folder itself, which no file pattern matches).
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*"),
    },
  };
  client = new LanguageClient("mcfLinterSpark", "mcf-linter-spark", serverOptions, clientOptions);
  await client.start();
}
