import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BridgeServer } from "./bridge-server.js";
import { log, parsePort, resultWithText } from "./mcp-utils.js";
import { NativeInputDriver } from "./native-input-driver.js";
import { OperationCatalog } from "./operation-catalog.js";
import { findProjectRoot } from "./project-root.js";
import { CommandOrchestrator } from "./command-orchestrator.js";

export const DEFAULT_ORCHESTRATOR_BRIDGE_PORT = 38493;

export async function createOrchestratorServer({
  projectRoot = null,
  bridgePort = null,
  bridge = null,
  inputDriver = null,
  catalog = null,
  orchestrator = null,
  readerHandlers = {},
  allowedOpenUrls = [],
  adapter = null,
  adapterPath = process.env.WEB_AUTOMATION_ADAPTER_PATH || null,
  logger = log
} = {}) {
const resolvedProjectRoot = projectRoot || await findProjectRoot();
const resolvedBridgePort = bridgePort ?? parsePort(
  process.env.WEB_ORCHESTRATOR_BRIDGE_PORT ?? process.env.WEB_OPERATOR_BRIDGE_PORT,
  DEFAULT_ORCHESTRATOR_BRIDGE_PORT
);
bridge = bridge || new BridgeServer({ port: resolvedBridgePort, logger, adapter, adapterPath });
inputDriver = inputDriver || new NativeInputDriver({ projectRoot: resolvedProjectRoot, logger });
catalog = catalog || new OperationCatalog({ projectRoot: resolvedProjectRoot });
orchestrator = orchestrator || new CommandOrchestrator({ bridge, inputDriver, logger, allowedOpenUrls });
const registeredReaders = new Map(Object.entries(readerHandlers));
const server = new McpServer(
  { name: "command-orchestrator", version: "1.0.0" },
  { instructions: "Execute declarative Observe → Act → Verify commands. Every command verifies an expected page state and named target, leases foreground focus only for the action and verification window, restores the previous application unless a human takes over, and fails when postconditions do not match." }
);

const assertionValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const assertion = z.object({
  scope: z.enum(["fields", "controls", "values", "collections", "scrollables"]),
  name: z.string().min(1).max(160),
  index: z.number().int().nonnegative().max(499).optional(),
  identityKey: z.string().min(1).max(1_000).optional(),
  path: z.string().max(160).default(""),
  equals: assertionValue.optional(),
  notEquals: assertionValue.optional(),
  atLeast: z.number().finite().optional(),
  atMost: z.number().finite().optional(),
  includes: assertionValue.optional(),
  changed: z.literal(true).optional()
}).superRefine((value, context) => {
  const operators = ["equals", "notEquals", "atLeast", "atMost", "includes", "changed"]
    .filter((name) => value[name] !== undefined || Object.hasOwn(value, name));
  if (operators.length !== 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Assertion requires exactly one comparison operator." });
  }
});
const target = z.object({
  scope: z.enum(["fields", "controls", "collections", "scrollables"]),
  name: z.string().min(1).max(160),
  index: z.number().int().nonnegative().max(499).optional(),
  identityKey: z.string().min(1).max(1_000).optional()
}).superRefine((value, context) => {
  const selectors = Number(value.index !== undefined) + Number(value.identityKey !== undefined);
  if (value.scope === "collections" && selectors !== 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Collection targets require exactly one index or identityKey." });
  }
  if (value.scope !== "collections" && selectors !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Only collection targets accept index or identityKey." });
  }
});
const action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click") }),
  z.object({ type: z.literal("paste"), text: z.string().min(1).max(240) }),
  z.object({ type: z.literal("openUrl"), url: z.string().url().max(2_048) }),
  z.object({
    type: z.literal("scrollUntil"),
    deltaY: z.union([z.literal("recommended"), z.number().int().min(80).max(2_400)]).default("recommended"),
    direction: z.enum(["down", "up"]).default("down"),
    maxAttempts: z.number().int().min(1).max(20).default(8),
    until: assertion
  })
]);
const verificationPolicy = z.object({
  initialDelayMs: z.number().int().min(0).max(2_000).default(0),
  pollIntervalMs: z.number().int().min(0).max(2_000).default(150),
  timeoutMs: z.number().int().min(0).max(15_000).default(1_050),
  stablePasses: z.number().int().min(1).max(3).default(1)
});
const readinessPolicy = z.object({
  initialDelayMs: z.number().int().min(0).max(2_000).default(0),
  pollIntervalMs: z.number().int().min(20).max(1_000).default(100),
  timeoutMs: z.number().int().min(0).max(5_000).default(1_500)
});
const command = z.object({
  id: z.string().min(1).max(120),
  expectedPage: z.string().min(1).max(160).optional(),
  expectedResultPage: z.string().min(1).max(160).optional(),
  foregroundPolicy: z.object({
    activate: z.enum(["ifNeeded", "never"]).default("ifNeeded"),
    restore: z.literal("previousUnlessHumanTakeover").default("previousUnlessHumanTakeover")
  }).optional(),
  target: target.optional(),
  preconditions: z.array(assertion).max(20).default([]),
  action,
  executionPolicy: z.object({
    skipActionWhenPostconditionsPass: z.boolean().default(false)
  }).optional(),
  verificationPolicy: verificationPolicy.optional(),
  readinessPolicy: readinessPolicy.optional(),
  postconditions: z.array(assertion).max(20).default([])
}).superRefine((value, context) => {
  if (value.action.type === "openUrl") {
    if (!value.expectedResultPage || value.expectedPage || value.target || value.preconditions.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "openUrl requires expectedResultPage and cannot declare expectedPage, target, or preconditions."
      });
    }
    return;
  }
  if (!value.expectedPage || !value.target) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Interactive web commands require expectedPage and target." });
  }
});
const workflowInput = {
  id: z.string().min(1).max(120),
  label: z.string().min(1).max(160),
  browserBundleIdentifier: z.string().min(1).max(120).default("com.google.Chrome"),
  commands: z.array(command).min(1).max(50)
};
const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const operationParameter = z.lazy(() => z.union([
  z.string(), z.number(), z.boolean(), z.null(),
  z.array(operationParameter).max(100),
  z.record(z.string().min(1).max(160), operationParameter)
]));
const operationCall = z.object({
  name: z.string().min(1).max(180),
  parameters: z.record(z.string(), operationParameter).default({})
});

server.registerTool("web_list_operations", {
  title: "List configured web operations",
  description: "List the configuration-defined semantic operations that expand into guarded Observe → Act → Verify commands.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async () => {
  const operations = await catalog.list();
  return resultWithText({ operations }, `Found ${operations.length} configured web operation(s).`);
});

server.registerTool("web_execute_operation", {
  title: "Execute one configured web operation",
  description: "Expand a named operation and its parameters into one guarded command, then execute and verify it.",
  inputSchema: operationCall.shape,
  annotations
}, async ({ name, parameters }) => {
  const expanded = await catalog.expand(name, parameters);
  const execution = await executeOperationNodes({
    id: `operation-${name}`,
    label: expanded.description,
    browserBundleIdentifier: expanded.browserBundleIdentifier,
    nodes: instantiateNodes(expanded.nodes)
  });
  return resultWithText({ operation: name, kind: expanded.kind, trace: expanded.trace, ...execution }, execution.report.ok ? `Configured operation '${name}' completed and verified.` : `Configured operation '${name}' failed at ${execution.report.error?.stage}: ${execution.report.error?.message}`);
});

server.registerTool("web_execute_operations", {
  title: "Execute configured web operations",
  description: "Expand a sequence of named operations into guarded commands and execute them in order.",
  inputSchema: {
    id: z.string().min(1).max(120),
    label: z.string().min(1).max(160),
    operations: z.array(operationCall).min(1).max(50)
  },
  annotations
}, async ({ id, label, operations }) => {
  const expanded = await Promise.all(operations.map(({ name, parameters }) => catalog.expand(name, parameters)));
  const browserBundleIdentifiers = new Set(expanded.map((item) => item.browserBundleIdentifier));
  if (browserBundleIdentifiers.size !== 1) throw new Error("One operation sequence cannot target multiple browser bundle identifiers.");
  const execution = await executeOperationNodes({
    id,
    label,
    browserBundleIdentifier: expanded[0].browserBundleIdentifier,
    nodes: instantiateNodes(expanded.flatMap((item) => item.nodes))
  });
  return resultWithText({ operations: expanded.map((item) => item.name), trace: expanded.flatMap((item) => item.trace), ...execution }, execution.report.ok ? `Completed ${expanded.length} configured operation(s).` : `Configured operation sequence failed at ${execution.report.error?.stage}: ${execution.report.error?.message}`);
});

server.registerTool("web_execute_command", {
  title: "Execute one guarded web command",
  description: "Verify page state and a named observer target, temporarily foreground the browser, perform one native input action, restore the previous app, and verify postconditions.",
  inputSchema: {
    id: z.string().min(1).max(120),
    label: z.string().min(1).max(160),
    browserBundleIdentifier: z.string().min(1).max(120).default("com.google.Chrome"),
    command
  },
  annotations
}, async ({ id, label, browserBundleIdentifier, command: webCommand }) => {
  const report = await orchestrator.executeWorkflow({ id, label, browserBundleIdentifier, commands: [webCommand] });
  return resultWithText(report, report.ok ? `Guarded web command '${webCommand.id}' completed and verified.` : `Guarded web command failed at ${report.error?.stage}: ${report.error?.message}`);
});

server.registerTool("web_execute_workflow", {
  title: "Execute a guarded web workflow",
  description: "Run up to 50 declarative Observe → Act → Verify commands, each with independent preconditions, target lookup, foreground lease, action, restoration, and postconditions.",
  inputSchema: workflowInput,
  annotations
}, async (workflow) => {
  const report = await orchestrator.executeWorkflow(workflow);
  return resultWithText(report, report.ok ? `Web workflow '${workflow.id}' completed with ${report.commands.length} verified command(s).` : `Web workflow failed at ${report.error?.stage}: ${report.error?.message}`);
});

function instantiateNodes(nodes) {
  return nodes.map((node, index) => node.type === "command"
    ? { ...node, command: { ...node.command, id: `${node.command.id}-${index + 1}` } }
    : structuredClone(node));
}

async function executeOperationNodes({ id, label, browserBundleIdentifier, nodes }) {
  if (nodes.some((node) => node.type === "reader")) {
    await bridge.waitForConnection(30_000);
  }
  if (nodes.every((node) => node.type === "command")) {
    const report = await orchestrator.executeWorkflow({
      id,
      label,
      browserBundleIdentifier,
      commands: nodes.map((node) => node.command)
    });
    return { report, results: [] };
  }

  const startedAt = new Date().toISOString();
  const steps = [];
  const results = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node.type === "command") {
      const commandReport = await orchestrator.executeWorkflow({
        id: `${id}-command-${index + 1}`,
        label: `${label} · ${node.operation}`,
        browserBundleIdentifier,
        commands: [node.command]
      });
      steps.push({ type: "command", operation: node.operation, report: commandReport });
      if (!commandReport.ok) {
        return {
          report: {
            ok: false,
            workflowId: id,
            startedAt,
            finishedAt: new Date().toISOString(),
            steps,
            error: commandReport.error
          },
          results
        };
      }
      continue;
    }
    if (node.type !== "reader") throw new Error(`Unsupported operation node type '${node.type}'.`);
    try {
      const value = await executeReader(node, { browserBundleIdentifier });
      const resultIndex = results.length;
      results.push({ operation: node.operation, handler: node.handler, value });
      steps.push({ type: "reader", operation: node.operation, handler: node.handler, resultIndex });
    } catch (error) {
      const serialized = {
        name: error?.name || "Error",
        code: error?.code || "READER_FAILED",
        stage: "reader",
        message: error?.message || String(error),
        details: error?.details ?? null
      };
      return {
        report: {
          ok: false,
          workflowId: id,
          startedAt,
          finishedAt: new Date().toISOString(),
          steps,
          error: serialized
        },
        results
      };
    }
  }
  return {
    report: {
      ok: true,
      workflowId: id,
      startedAt,
      finishedAt: new Date().toISOString(),
      steps
    },
    results
  };
}

async function executeReader(node, { browserBundleIdentifier }) {
  if (node.handler === "observer.observe") return await bridge.request("observer.observe", node.input || {}, 10_000);
  const handler = registeredReaders.get(node.handler);
  if (handler) return await handler(node.input || {}, {
    browserBundleIdentifier,
    bridge,
    inputDriver,
    catalog,
    orchestrator,
    projectRoot: resolvedProjectRoot,
    logger
  });
  throw new Error(`Unknown registered reader handler '${node.handler}'.`);
}

return {
  server,
  bridge,
  inputDriver,
  catalog,
  orchestrator,
  projectRoot: resolvedProjectRoot,
  bridgePort: resolvedBridgePort
};
}

export async function startOrchestratorServer(options = {}) {
  const runtime = await createOrchestratorServer(options);
  await runtime.bridge.start();
  await runtime.server.connect(options.transport || new StdioServerTransport());
  (options.logger || log)("info", "command_orchestrator_mcp_started", {
    bridgePort: runtime.bridgePort,
    projectRoot: runtime.projectRoot,
    customReaderCount: Object.keys(options.readerHandlers || {}).length
  });
  return runtime;
}
