// vsce packages only the files inside the extension folder.
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extension = join(here, "..");
const repo = join(extension, "..", "..");
const exe = process.platform === "win32" ? "mcf-linter-spark.exe" : "mcf-linter-spark";
const source = join(repo, "target", "release", exe);
if (!existsSync(source)) {
  console.error(`${source} not found; run "cargo build --release" first`);
  process.exit(1);
}
rmSync(join(extension, "bin"), { recursive: true, force: true });
mkdirSync(join(extension, "bin"));
copyFileSync(source, join(extension, "bin", exe));
for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
  copyFileSync(join(repo, file), join(extension, file));
}
console.log(`copied ${exe}, LICENSE, THIRD_PARTY_NOTICES.md`);
