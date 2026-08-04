import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(packageRoot, "dist", "server");
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

for (const [entry, outfile] of [
  ["eye-server.js", "web-eye-server.mjs"],
  ["hand-server.js", "native-hand-server.mjs"],
  ["operator-server-entry.js", "web-operator-server.mjs"]
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
      js: "import { createRequire as __webOperatorCreateRequire } from 'node:module'; const require = __webOperatorCreateRequire(import.meta.url);"
    }
  });
}
console.log("Built generic Web Eye, Native Hand, and Web Operator MCP servers.");
