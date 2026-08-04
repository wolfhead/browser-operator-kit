import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeServer } from "../src/bridge-server.js";
import { NativeInputController } from "../src/native-input-controller.js";
import { OperationCatalog } from "../src/operation-catalog.js";
import { findProjectRoot } from "../src/project-root.js";
import { WebCommandRunner } from "../src/web-command-runner.js";

const projectRoot = await findProjectRoot(path.dirname(fileURLToPath(import.meta.url)));
const options = parseArguments(process.argv.slice(2));
const workflowPath = path.resolve(projectRoot, options.workflow);
const reportPath = path.resolve(projectRoot, options.report);
assertInsideProject(workflowPath, projectRoot, "workflow");
assertInsideProject(reportPath, projectRoot, "report");
const workflowDefinition = JSON.parse(await readFile(workflowPath, "utf8"));
const workflow = await expandNamedWorkflow(workflowDefinition);
const log = (level, event, fields = {}) => process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields })}\n`);
const bridge = new BridgeServer({ port: 38493, logger: log });
const hand = new NativeInputController({ projectRoot, logger: log });
const runner = new WebCommandRunner({ bridge, hand, logger: log });

let report;
try {
  await bridge.start();
  await bridge.waitForConnection(75_000);
  report = await runner.executeWorkflow(workflow);
} catch (error) {
  report = {
    ok: false,
    workflowId: workflow?.id ?? null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    commands: [],
    error: { code: "WORKFLOW_BOOTSTRAP_FAILED", stage: "bootstrap", message: error instanceof Error ? error.message : String(error) }
  };
} finally {
  await bridge.stop().catch(() => {});
}

await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ok: report.ok, report: path.relative(projectRoot, reportPath), error: report.error ?? null })}\n`);
if (!report.ok) process.exitCode = 1;

async function expandNamedWorkflow(definition) {
  if (!Array.isArray(definition.operations)) return definition;
  const catalog = new OperationCatalog({ projectRoot });
  const expanded = await Promise.all(definition.operations.map((call) => catalog.expand(call.name, call.parameters || {})));
  const bundleIdentifiers = new Set(expanded.map((item) => item.browserBundleIdentifier));
  if (bundleIdentifiers.size !== 1) throw new Error("One workflow cannot target multiple browser bundle identifiers.");
  return {
    id: definition.id,
    label: definition.label,
    browserBundleIdentifier: expanded[0].browserBundleIdentifier,
    commands: expanded
      .flatMap((item) => item.commands)
      .map((item, index) => ({ ...item, id: `${item.id}-${index + 1}` }))
  };
}

function parseArguments(argumentsList) {
  const options = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (name === "--workflow") options.workflow = value;
    if (name === "--report") options.report = value;
  }
  if (!options.workflow || !options.report) {
    throw new Error("Usage: node scripts/run-web-workflow.mjs --workflow <project-relative-json> --report <project-relative-json>");
  }
  return options;
}

function assertInsideProject(targetPath, rootPath, label) {
  const relative = path.relative(rootPath, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative) && relative !== "") {
    throw new Error(`${label} path must stay inside the project directory.`);
  }
}
