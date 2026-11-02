// Builds what the VSIX holds: the extension (dist/extension.js), the language server as one file
// (dist/server.mjs), and the license files. vsce packages only the files inside this folder.
//
// Usage: node scripts/bundle.mts

import { build } from "esbuild";
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extension = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(extension, "..", "..");
const dist = join(extension, "dist");

// VSCode 1.91, the oldest this extension supports, runs extensions on Node 20.
const common = { bundle: true, platform: "node", target: "node20", absWorkingDir: extension, metafile: true, legalComments: "none", logLevel: "warning" } as const;

rmSync(dist, { recursive: true, force: true });
const client = await build({ ...common, entryPoints: ["src/extension.ts"], format: "cjs", external: ["vscode"], outfile: "dist/extension.js" });
const server = await build({
  ...common,
  entryPoints: [join(repo, "src", "main.ts")],
  format: "esm",
  outfile: "dist/server.mjs",
  // The CommonJS packages in the bundle call `require` for the Node modules.
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});

copyFileSync(join(repo, "LICENSE"), join(extension, "LICENSE"));
writeFileSync(join(extension, "THIRD_PARTY_NOTICES.md"), notices([client.metafile, server.metafile].flatMap((m) => Object.keys(m.inputs))));
console.log("bundled dist/extension.js, dist/server.mjs, LICENSE, THIRD_PARTY_NOTICES.md");

/** The repository's notices (when it has them) and the licenses of the npm packages in the bundles. */
function notices(inputs: string[]): string {
  const packages = new Map<string, string>();
  for (const input of inputs) {
    const path = resolve(extension, input);
    const marker = path.lastIndexOf("node_modules");
    if (marker < 0) continue;
    const parts = path.slice(marker + "node_modules".length + 1).split(/[\\/]/);
    const name = parts[0]!.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]!;
    packages.set(name, path.slice(0, marker + "node_modules".length + 1 + name.length));
  }
  const own = join(repo, "THIRD_PARTY_NOTICES.md");
  const sections = [existsSync(own) ? readFileSync(own, "utf8").trimEnd() : "# Third-party notices"];
  sections.push("## JavaScript packages bundled into this extension");
  for (const [name, dir] of [...packages].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string; license?: string };
    const files = readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)/i.test(f)).sort();
    const texts = files.map((f) => `\`\`\`text\n${readFileSync(join(dir, f), "utf8").trim()}\n\`\`\``);
    sections.push(`### ${name} ${manifest.version} (${manifest.license ?? "no license field"})\n\n${texts.join("\n\n") || "(no license file in the package)"}`);
  }
  return `${sections.join("\n\n")}\n`;
}
