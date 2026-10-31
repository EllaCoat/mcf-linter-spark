// Writes THIRD_PARTY_NOTICES.md: the data, the Rust crates used to build the
// mcf-linter-spark executable, and the JavaScript packages bundled into the VSCode extension.
//
// Usage (from the repository root, after `pnpm install` in editors/vscode):
//   bun scripts/notices.ts

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");

function run(cmd: string[], cwd: string): string {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "inherit" });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed with ${p.exitCode}`);
  return p.stdout.toString();
}

/** The license files of a package, without the alternatives that its license lets us skip. */
function licenseTexts(dir: string, license: string): string[] {
  let files = readdirSync(dir).filter((f) => /^(licen[cs]e|copying|copyright|notice|unlicense)/i.test(f));
  if (/\bMIT\s+OR\b|\bOR\s+MIT\b|\bMIT\/|\/MIT\b/.test(license) && files.length > 1) {
    files = files.filter((f) => !/apache|unlicense/i.test(f));
  }
  return files.sort().map((f) => readFileSync(join(dir, f), "utf8").trim());
}

type Entry = { name: string; version: string; license: string; texts: string[] };

function section(entries: Entry[]): string {
  return entries
    .map((e) => {
      const texts = e.texts.length ? e.texts.map((t) => "```text\n" + t + "\n```").join("\n\n") : `(no license file in the package; ${e.license})`;
      return `### ${e.name} ${e.version} (${e.license})\n\n${texts}\n`;
    })
    .join("\n");
}

type Metadata = {
  packages: { id: string; name: string; version: string; license?: string; manifest_path: string }[];
  workspace_members: string[];
  resolve: { nodes: { id: string; deps: { pkg: string; dep_kinds: { kind: string | null }[] }[] }[] };
};

function crates(): Entry[] {
  const meta: Metadata = JSON.parse(run(["cargo", "metadata", "--format-version", "1", "--locked"], root));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const stack = [...meta.workspace_members];
  while (stack.length) {
    const id = stack.pop()!;
    for (const d of nodes.get(id)?.deps ?? []) {
      if (d.dep_kinds.some((k) => k.kind === null) && !seen.has(d.pkg)) {
        seen.add(d.pkg);
        stack.push(d.pkg);
      }
    }
  }
  return meta.packages
    .filter((p) => seen.has(p.id) && !meta.workspace_members.includes(p.id))
    .map((p) => ({ name: p.name, version: p.version, license: p.license ?? "unknown", texts: licenseTexts(dirname(p.manifest_path), p.license ?? "") }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

type PnpmLicenses = Record<string, { name: string; versions: string[]; paths: string[]; license: string }[]>;

function jsPackages(): Entry[] {
  const list: PnpmLicenses = JSON.parse(run(["pnpm", "licenses", "list", "--prod", "--json"], join(root, "editors", "vscode")));
  return Object.values(list)
    .flat()
    .map((p) => ({ name: p.name, version: p.versions.join(", "), license: p.license, texts: licenseTexts(p.paths[0], p.license) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const header = `# Third-party notices

mcf-linter-spark is licensed under the MIT License (see \`LICENSE\`). It includes or is
derived from the following third-party material.

## vanilla-mcdoc

On first use mcf-linter-spark downloads the \`symbols.json\` that the \`generated\` branch of
[vanilla-mcdoc](https://github.com/SpyglassMC/vanilla-mcdoc) exports, the schema of NBT and
data pack JSON that it checks against, and caches it on the user's machine. vanilla-mcdoc
is licensed under the MIT License, Copyright (c) 2022 SpyglassMC.

## Spyglass and Datapack Helper Plus

mcf-linter-spark contains no code from these projects. Its diagnostics and their messages are
written to match theirs.

- Spyglass: https://github.com/SpyglassMC/Spyglass, MIT License,
  Copyright (c) 2019-2025 SPGoding and SpyglassMC contributors
- Datapack Helper Plus (datapack-language-server): MIT License,
  Copyright (c) 2019-2020 SPGoding
- datapack-linter: MIT License, Copyright (c) 2020-2024 chen

## Minecraft data

mcf-linter-spark does not include data from Minecraft. On first use it downloads the command
tree, the registries, the block states, and the lists of the vanilla data pack's
resources and tags for the game version from the summary of
[mcmeta](https://github.com/misode/mcmeta) by misode, which is generated with the
data generator of the Minecraft: Java Edition server, and caches them on the user's
machine. mcf-linter-spark is not an official Minecraft product and is not approved by or
associated with Mojang or Microsoft.
`;

const out = `${header}
## Rust crates used to build the mcf-linter-spark executable

${section(crates())}
## JavaScript packages bundled into the VSCode extension

${section(jsPackages())}`;

writeFileSync(join(root, "THIRD_PARTY_NOTICES.md"), out);
console.log("wrote THIRD_PARTY_NOTICES.md");
