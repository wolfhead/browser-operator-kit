import { access, readFile } from "node:fs/promises";
import path from "node:path";

if (!process.argv[2]) throw new Error("Usage: validate-manifest.mjs <manifest.json>");
const manifestPath = path.resolve(process.argv[2]);
const extensionRoot = path.dirname(manifestPath);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const worker = await readFile(path.join(extensionRoot, "observer-service-worker.js"), "utf8");
const runtime = await readFile(path.join(extensionRoot, "observer", "runtime.js"), "utf8");
const errors = [];

if (manifest.manifest_version !== 3) errors.push("manifest_version must be 3");
if (manifest.name !== "Browser Operator Kit Page Observer") errors.push("the installed extension name must stay generic");
if (manifest.background?.service_worker !== "observer-service-worker.js") {
  errors.push("the descriptor-driven Page Observer worker must be the only loaded service worker");
}
const permissions = new Set(manifest.permissions ?? []);
for (const forbidden of ["debugger", "nativeMessaging", "offscreen"]) {
  if (permissions.has(forbidden)) errors.push(`forbidden Page Observer permission: ${forbidden}`);
}
for (const required of ["activeTab", "alarms", "scripting", "sidePanel", "storage", "tabs"]) {
  if (!permissions.has(required)) errors.push(`missing Page Observer permission: ${required}`);
}
if ((manifest.content_scripts ?? []).length !== 0) {
  errors.push("Page Observer must not inject persistent content scripts or page overlays");
}
if (/chrome\.tabs\.(update|create|remove)|chrome\.windows\.update/.test(worker)) {
  errors.push("Page Observer worker must not navigate, focus, or close page tabs/windows");
}
if (!worker.includes('case "observer.captureVisibleTab"') || !worker.includes("observer.captureVisibleTab()")) {
  errors.push("Page Observer worker must expose adapter-guarded visible-tab capture");
}
if (/\.click\(|\.focus\(|\.scroll(To|By)?\(|dispatchEvent\(|element\.value\s*=/.test(runtime)) {
  errors.push("Page Observer runtime must not mutate or interact with the observed page");
}
if (!manifest.side_panel?.default_path) errors.push("side_panel.default_path is required");
const optionalHostPermissions = new Set(manifest.optional_host_permissions ?? []);
for (const required of ["http://*/*", "https://*/*"]) {
  if (!optionalHostPermissions.has(required)) errors.push(`missing optional site permission: ${required}`);
}
for (const permission of manifest.host_permissions ?? []) {
  if (
    permission !== "<all_urls>" &&
    !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/\*$/.test(permission)
  ) {
    errors.push(`the generic extension may only have persistent loopback permissions or the explicit screenshot prerequisite '<all_urls>': ${permission}`);
  }
}
for (const relativePath of ["observer/descriptor-schema.json", manifest.side_panel?.default_path]) {
  try { await access(path.join(extensionRoot, relativePath)); } catch { errors.push(`missing extension artifact: ${relativePath}`); }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Validated generic read-only Page Observer manifest with runtime adapter permissions.");
}
