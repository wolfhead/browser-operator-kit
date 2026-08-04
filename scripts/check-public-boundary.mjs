import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignored = new Set([".git", "dist", "node_modules", "output"]);
const forbiddenWords = ["bo" + "ss", "zhi" + "pin", "recr" + "uit", "招" + "聘", "简" + "历", "牛" + "人"];
const violations = [];

await walk(packageRoot);
if (violations.length) {
  console.error(`Public boundary contains private business terms:\n${violations.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("Public boundary contains no private adapter terms.");
}

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (/\.(?:js|mjs|json|md|py|swift|html|css)$/.test(entry.name)) {
      const text = await readFile(file, "utf8");
      const normalized = text.toLocaleLowerCase("en-US");
      if (forbiddenWords.some((word) => normalized.includes(word))) {
        violations.push(path.relative(packageRoot, file));
      }
    }
  }
}
