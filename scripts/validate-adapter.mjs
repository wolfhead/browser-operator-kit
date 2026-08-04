import { access, readFile } from "node:fs/promises";
import path from "node:path";

const adapterPath = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Usage: validate-adapter.mjs <automation.adapter.json>");
const adapter = JSON.parse(await readFile(adapterPath, "utf8"));
const directory = path.dirname(adapterPath);
const errors = [];

if (adapter.schemaVersion !== 1) errors.push("schemaVersion must be 1");
for (const key of ["id", "displayName", "version"]) {
  if (typeof adapter[key] !== "string" || !adapter[key].trim()) errors.push(`${key} must be a non-empty string`);
}
for (const configuredPath of [
  ...(adapter.extension?.descriptors || []),
  ...(adapter.orchestrator?.operationDirectories || [])
]) {
  try { await access(path.resolve(directory, configuredPath)); } catch { errors.push(`missing adapter path: ${configuredPath}`); }
}
for (const value of adapter.orchestrator?.allowedOpenUrls || []) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) errors.push(`unsafe allowedOpenUrl: ${value}`);
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Validated adapter '${adapter.id}'.`);
}
