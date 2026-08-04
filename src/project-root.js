import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_NAMES = new Set([
  "browser-operator-kit",
  "@browser-operator-kit/core",
  "web-operator-kit",
  "@web-operator-kit/core"
]);

export async function findProjectRoot({ cwd = process.cwd(), moduleUrl = import.meta.url } = {}) {
  const configuredRoot = String(process.env.WEB_AUTOMATION_PROJECT_ROOT || "").trim();
  if (configuredRoot) {
    const resolved = path.resolve(configuredRoot);
    if (await isFrameworkProject(path.join(resolved, "package.json")) ||
        await isFrameworkProject(path.join(resolved, ".codex-plugin", "plugin.json"))) {
      return resolved;
    }
    throw new Error("WEB_AUTOMATION_PROJECT_ROOT does not identify a Browser Operator Kit project.");
  }
  const starts = [path.resolve(cwd), path.dirname(fileURLToPath(moduleUrl))];
  for (const start of starts) {
    let current = start;
    while (true) {
      if (await isFrameworkProject(path.join(current, "package.json")) ||
          await isFrameworkProject(path.join(current, ".codex-plugin", "plugin.json"))) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  throw new Error("Could not locate the Browser Operator Kit project or plugin root.");
}

async function isFrameworkProject(file) {
  try {
    const manifest = JSON.parse(await readFile(file, "utf8"));
    return PROJECT_NAMES.has(manifest.name) ||
      manifest.browserOperatorKit === true || manifest.browserOperatorKit?.adapter === true ||
      manifest.webOperatorKit === true || manifest.webOperatorKit?.adapter === true;
  } catch {
    return false;
  }
}
