import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArguments(process.argv.slice(2));
const adapterPath = path.resolve(options.adapter);
const outputDirectory = path.resolve(options.output);

await buildExtension({ adapterPath, outputDirectory });
console.log(`Built '${path.relative(packageRoot, outputDirectory)}' from '${path.relative(packageRoot, adapterPath)}'.`);

export async function buildExtension({ adapterPath, outputDirectory }) {
  const adapterDirectory = path.dirname(adapterPath);
  const adapter = JSON.parse(await readFile(adapterPath, "utf8"));
  validateAdapter(adapter);

  await rm(outputDirectory, { recursive: true, force: true });
  await cp(path.join(packageRoot, "extension"), outputDirectory, { recursive: true });

  const descriptorDirectory = path.join(outputDirectory, "eye", "descriptors");
  await rm(descriptorDirectory, { recursive: true, force: true });
  await mkdir(descriptorDirectory, { recursive: true });
  const descriptorPaths = [];
  for (const [index, configuredPath] of adapter.extension.descriptors.entries()) {
    const source = path.resolve(adapterDirectory, configuredPath);
    const fileName = `${String(index + 1).padStart(2, "0")}-${path.basename(configuredPath)}`;
    await cp(source, path.join(descriptorDirectory, fileName));
    descriptorPaths.push(`eye/descriptors/${fileName}`);
  }
  await writeFile(
    path.join(outputDirectory, "eye", "descriptor-registry.js"),
    `export const DESCRIPTOR_PATHS = ${JSON.stringify(descriptorPaths, null, 2)};\n`
  );

  const manifestPath = path.join(outputDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.name = `${adapter.displayName} Eye`;
  manifest.version = adapter.version;
  manifest.host_permissions = [...new Set([
    ...(manifest.host_permissions || []),
    ...adapter.extension.hostPermissions,
    ...adapter.extension.bridgeUrls.map(bridgeHostPermission)
  ])];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  for (const relativeFile of ["eye-service-worker.js", "sidepanel/sidepanel.js"]) {
    const file = path.join(outputDirectory, relativeFile);
    const source = await readFile(file, "utf8");
    const bridgePattern = /const BRIDGE_URLS = \[[\s\S]*?\];/;
    if (!bridgePattern.test(source)) throw new Error(`Could not find bridge URL injection point in ${relativeFile}.`);
    const replaced = source.replace(
      bridgePattern,
      `const BRIDGE_URLS = ${JSON.stringify(adapter.extension.bridgeUrls, null, 2)};`
    );
    await writeFile(file, replaced);
  }
}

function bridgeHostPermission(value) {
  const url = new URL(value);
  if (!["ws:", "wss:"].includes(url.protocol)) throw new Error(`Bridge URL '${value}' must use ws or wss.`);
  const scheme = url.protocol === "wss:" ? "https:" : "http:";
  return `${scheme}//${url.host}/*`;
}

function validateAdapter(adapter) {
  if (adapter?.schemaVersion !== 1 || !adapter.id || !adapter.displayName || !adapter.version) {
    throw new Error("Adapter requires schemaVersion 1, id, displayName, and version.");
  }
  if (!Array.isArray(adapter.extension?.descriptors) || adapter.extension.descriptors.length === 0) {
    throw new Error("Adapter requires at least one extension descriptor.");
  }
  if (!Array.isArray(adapter.extension?.hostPermissions) || !Array.isArray(adapter.extension?.bridgeUrls)) {
    throw new Error("Adapter extension requires hostPermissions and bridgeUrls arrays.");
  }
}

function parseArguments(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!["--adapter", "--output"].includes(flag) || !value) {
      throw new Error("Usage: build-extension.mjs --adapter <adapter.json> --output <directory>");
    }
    options[flag.slice(2)] = value;
  }
  if (!options.adapter || !options.output) {
    throw new Error("Usage: build-extension.mjs --adapter <adapter.json> --output <directory>");
  }
  return options;
}
