import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(packageRoot, "dist", "server");
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

for (const [entry, outfile] of [
  ["observer-server.js", "page-observer-server.mjs"],
  ["input-driver-server.js", "native-input-server.mjs"],
  ["orchestrator-server-entry.js", "command-orchestrator-server.mjs"]
]) {
  await build({
    entryPoints: [path.join(packageRoot, "src", entry)],
    outfile: path.join(outputDirectory, outfile),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    legalComments: "eof",
    banner: {
      js: "import { createRequire as __browserOperatorCreateRequire } from 'node:module'; const require = __browserOperatorCreateRequire(import.meta.url);"
    }
  });
}
console.log("Built generic Page Observer, Native Input Driver, and Command Orchestrator MCP servers.");
