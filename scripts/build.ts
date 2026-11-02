// Builds what is distributed:
// - dist/mcf-linter-spark.mjs: the command and the language server as one file that `node` runs
//   without node_modules, and dist/THIRD_PARTY_NOTICES.md for it.
// - editors/vscode/dist/: the extension and the same server, with editors/vscode/LICENSE and
//   editors/vscode/THIRD_PARTY_NOTICES.md, which vsce packages into the VSIX.
//
// Usage: node scripts/build.ts

import { type Metafile, build } from "esbuild";
import { copyFileSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const extension = join(repo, "editors", "vscode");

// VSCode 1.91, the oldest the extension supports, runs extensions and the server on Node 20.
const common = { bundle: true, platform: "node", target: "node20", metafile: true, legalComments: "none", logLevel: "warning" } as const;

rmSync(join(repo, "dist"), { recursive: true, force: true });
rmSync(join(extension, "dist"), { recursive: true, force: true });

const command = await build({
  ...common,
  absWorkingDir: repo,
  entryPoints: ["src/main.ts"],
  format: "esm",
  outfile: "dist/mcf-linter-spark.mjs",
  // The CommonJS packages in the bundle call `require` for the Node modules.
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});
const client = await build({
  ...common,
  absWorkingDir: extension,
  entryPoints: ["src/extension.ts"],
  format: "cjs",
  external: ["vscode"],
  outfile: "dist/extension.js",
});

const commandPackages = packagesIn(command.metafile, repo);
writeFileSync(join(repo, "dist", "THIRD_PARTY_NOTICES.md"), notices("mcf-linter-spark.mjs", commandPackages));

copyFileSync(join(repo, "dist", "mcf-linter-spark.mjs"), join(extension, "dist", "server.mjs"));
copyFileSync(join(repo, "LICENSE"), join(extension, "LICENSE"));
const extensionPackages = new Map([...commandPackages, ...packagesIn(client.metafile, extension)]);
writeFileSync(join(extension, "THIRD_PARTY_NOTICES.md"), notices("the VSCode extension", extensionPackages));

console.log("built dist/mcf-linter-spark.mjs and editors/vscode/dist/ with their THIRD_PARTY_NOTICES.md");

/** The npm packages whose files are in a bundle, by name, with the directory of each. */
function packagesIn(metafile: Metafile, workingDir: string): Map<string, string> {
  const packages = new Map<string, string>();
  for (const input of Object.keys(metafile.inputs)) {
    const path = resolve(workingDir, input);
    const marker = path.lastIndexOf("node_modules");
    if (marker < 0) continue;
    const parts = path.slice(marker + "node_modules".length + 1).split(/[\\/]/);
    const name = parts[0]!.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]!;
    packages.set(name, path.slice(0, marker + "node_modules".length + 1 + name.length));
  }
  return packages;
}

/** The repository's THIRD_PARTY_NOTICES.md, then the licenses of `packages`. */
function notices(bundled: string, packages: Map<string, string>): string {
  const sections = [readFileSync(join(repo, "THIRD_PARTY_NOTICES.md"), "utf8").trimEnd(), `## JavaScript packages bundled into ${bundled}`];
  for (const [name, dir] of [...packages].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string; license?: string };
    const files = readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)/i.test(f)).sort();
    const texts = files.map((f) => `\`\`\`text\n${readFileSync(join(dir, f), "utf8").trim()}\n\`\`\``);
    sections.push(`### ${name} ${manifest.version} (${manifest.license ?? "no license field"})\n\n${texts.join("\n\n") || "(no license file in the package)"}`);
  }
  return `${sections.join("\n\n")}\n`;
}
