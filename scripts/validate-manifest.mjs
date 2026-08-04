import { access, readFile } from "node:fs/promises";
import path from "node:path";

if (!process.argv[2]) throw new Error("Usage: validate-manifest.mjs <manifest.json>");
const manifestPath = path.resolve(process.argv[2]);
const extensionRoot = path.dirname(manifestPath);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const worker = await readFile(path.join(extensionRoot, "eye-service-worker.js"), "utf8");
const runtime = await readFile(path.join(extensionRoot, "eye", "runtime.js"), "utf8");
const registry = await readFile(path.join(extensionRoot, "eye", "descriptor-registry.js"), "utf8");
const errors = [];

if (manifest.manifest_version !== 3) errors.push("manifest_version must be 3");
if (manifest.background?.service_worker !== "eye-service-worker.js") {
  errors.push("the descriptor-driven Eye worker must be the only loaded service worker");
}
const permissions = new Set(manifest.permissions ?? []);
for (const forbidden of ["debugger", "nativeMessaging", "offscreen"]) {
  if (permissions.has(forbidden)) errors.push(`forbidden Eye permission: ${forbidden}`);
}
for (const required of ["alarms", "scripting", "sidePanel", "storage", "tabs"]) {
  if (!permissions.has(required)) errors.push(`missing Eye permission: ${required}`);
}
if ((manifest.content_scripts ?? []).length !== 0) {
  errors.push("Eye must not inject persistent content scripts or page overlays");
}
if (/chrome\.tabs\.(update|create|remove|captureVisibleTab)|chrome\.windows\.update/.test(worker)) {
  errors.push("Eye worker must not navigate, focus, close, or capture page tabs/windows");
}
if (/\.click\(|\.focus\(|\.scroll(To|By)?\(|dispatchEvent\(|element\.value\s*=/.test(runtime)) {
  errors.push("Eye runtime must not mutate or interact with the observed page");
}
if (!manifest.side_panel?.default_path) errors.push("side_panel.default_path is required");

const descriptorPaths = [...registry.matchAll(/["'](eye\/descriptors\/[^"']+\.json)["']/g)]
  .map((match) => match[1]);
if (descriptorPaths.length === 0) errors.push("generated descriptor registry must not be empty");
for (const relativePath of descriptorPaths) {
  try {
    const descriptor = JSON.parse(await readFile(path.join(extensionRoot, relativePath), "utf8"));
    if (descriptor.schemaVersion !== 1 || !descriptor.id || !Array.isArray(descriptor.pages)) {
      errors.push(`invalid Eye descriptor: ${relativePath}`);
    }
  } catch {
    errors.push(`missing or invalid Eye descriptor artifact: ${relativePath}`);
  }
}
for (const relativePath of ["eye/descriptor-schema.json", manifest.side_panel?.default_path]) {
  try { await access(path.join(extensionRoot, relativePath)); } catch { errors.push(`missing extension artifact: ${relativePath}`); }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Validated read-only Eye manifest with ${descriptorPaths.length} descriptor(s).`);
}
