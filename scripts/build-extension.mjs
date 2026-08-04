import { cp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArguments(process.argv.slice(2));
const outputDirectory = path.resolve(options.output);

await buildExtension({
  outputDirectory,
  bridgeUrls: options.bridgeUrls,
  hostPermissions: options.hostPermissions
});
console.log(`Built generic Page Observer extension at '${path.relative(packageRoot, outputDirectory)}'.`);

export async function buildExtension({ outputDirectory, bridgeUrls = [], hostPermissions = [] }) {
  await rm(outputDirectory, { recursive: true, force: true });
  await cp(path.join(packageRoot, "extension"), outputDirectory, { recursive: true });
  if (bridgeUrls.length === 0 && hostPermissions.length === 0) return;

  for (const url of bridgeUrls) validateBridgeUrl(url);
  if (bridgeUrls.length > 0) {
    for (const relativeFile of ["observer-service-worker.js", "sidepanel/sidepanel.js"]) {
      const file = path.join(outputDirectory, relativeFile);
      const source = await readFile(file, "utf8");
      const bridgePattern = /const BRIDGE_URLS = \[[\s\S]*?\];/;
      if (!bridgePattern.test(source)) throw new Error(`Could not find bridge URL injection point in ${relativeFile}.`);
      await writeFile(file, source.replace(
        bridgePattern,
        `const BRIDGE_URLS = ${JSON.stringify(bridgeUrls, null, 2)};`
      ));
    }
  }

  const manifestPath = path.join(outputDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const permission of hostPermissions) validateHostPermission(permission);
  manifest.host_permissions = [...new Set([
    ...(bridgeUrls.length ? bridgeUrls.map(bridgeHostPermission) : manifest.host_permissions || []),
    ...hostPermissions
  ])];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function bridgeHostPermission(value) {
  const url = new URL(value);
  const scheme = url.protocol === "wss:" ? "https:" : "http:";
  return `${scheme}//${url.host}/*`;
}

function validateBridgeUrl(value) {
  const url = new URL(value);
  if (!['ws:', 'wss:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error(`Bridge URL '${value}' must use ws/wss on loopback.`);
  }
}

function validateHostPermission(value) {
  if (!/^https?:\/\/[^/]+\/\*$/.test(value)) {
    throw new Error(`Host permission '${value}' must be an exact http/https match pattern.`);
  }
}

function parseArguments(values) {
  const options = { bridgeUrls: [], hostPermissions: [] };
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    const value = values[index + 1];
    if (flag === "--output" && value) {
      options.output = value;
      index += 1;
      continue;
    }
    if (flag === "--bridge-url" && value) {
      options.bridgeUrls.push(value);
      index += 1;
      continue;
    }
    if (flag === "--host-permission" && value) {
      options.hostPermissions.push(value);
      index += 1;
      continue;
    }
    throw new Error("Usage: build-extension.mjs --output <directory> [--bridge-url <ws-url>]... [--host-permission <match-pattern>]...");
  }
  if (!options.output) {
    throw new Error("Usage: build-extension.mjs --output <directory> [--bridge-url <ws-url>]... [--host-permission <match-pattern>]...");
  }
  return options;
}
