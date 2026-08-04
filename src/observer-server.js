import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BridgeServer, DEFAULT_BRIDGE_PORT } from "./bridge-server.js";
import { log, parsePort, resultWithText } from "./mcp-utils.js";

const bridgePort = parsePort(
  process.env.WEB_OBSERVER_BRIDGE_PORT ?? process.env.WEB_EYE_BRIDGE_PORT,
  DEFAULT_BRIDGE_PORT
);
const bridge = new BridgeServer({ port: bridgePort, logger: log });
const server = new McpServer(
  { name: "page-observer", version: "1.0.0" },
  { instructions: "Read page state through descriptor-driven Page Observer tools. The observer never clicks, types, scrolls, focuses a window, or claims that a native input action succeeded. Observe again after every action." }
);
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const dashboardWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const inspectorMutation = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

server.registerTool("observer_status", {
  title: "Check Page Observer status",
  description: "Return the extension bridge, active tab, descriptor count, and observer role.",
  inputSchema: {}, annotations: { ...readOnly, idempotentHint: true }
}, async () => {
  const bridgeStatus = bridge.status();
  const extension = bridgeStatus.connected ? await bridge.request("observer.status", {}, 5_000) : null;
  return resultWithText({ bridge: bridgeStatus, extension }, bridgeStatus.connected ? "Page Observer is connected." : "Page Observer is waiting for the Chrome extension.");
});

server.registerTool("observer_observe", {
  title: "Observe the active web page",
  description: "Read the registered page state, values, controls, geometry, and scroll metrics without changing the page.",
  inputSchema: {}, annotations: readOnly
}, async () => {
  const observation = await bridge.request("observer.observe", {}, 10_000);
  return resultWithText(observation, `Observed '${observation.page}' with ${Object.keys(observation.fields || {}).length + Object.keys(observation.controls || {}).length + Object.keys(observation.scrollables || {}).length} registered targets.`);
});

server.registerTool("observer_inspect_snapshot", {
  title: "Inspect the active page DOM structure",
  description: "Return a bounded flat DOM snapshot from the active tab and its accessible frames. The result is ephemeral and is not written to the dashboard.",
  inputSchema: {
    rootSelector: z.string().max(2_000).default("html"),
    maxDepth: z.number().int().min(0).max(40).default(8),
    maxNodes: z.number().int().min(1).max(20_000).default(4_000),
    includeText: z.boolean().default(false),
    includeHidden: z.boolean().default(true),
    includeGeometry: z.boolean().default(true),
    textLimit: z.number().int().min(0).max(10_000).default(500),
    allFrames: z.boolean().default(true),
    frameIds: z.array(z.number().int().nonnegative()).max(100).optional()
  },
  annotations: readOnly
}, async (input) => {
  const result = await bridge.request("observer.inspect.snapshot", input, 30_000);
  const nodes = result.frames.reduce((count, frame) => count + Number(frame.result?.nodeCount || 0), 0);
  return resultWithText(result, `Inspected ${nodes} DOM nodes across ${result.frames.length} frame(s).`);
});

server.registerTool("observer_inspect_query", {
  title: "Query the active page DOM",
  description: "Run a CSS, XPath, or text query in the active tab and return matching structure, geometry, ancestors, and optionally content. The result is ephemeral.",
  inputSchema: {
    selector: z.string().min(1).max(20_000),
    selectorType: z.enum(["css", "xpath", "text"]).default("css"),
    exactText: z.boolean().default(false),
    pierceShadow: z.boolean().default(false),
    limit: z.number().int().min(1).max(2_000).default(100),
    ancestorDepth: z.number().int().min(0).max(20).default(0),
    includeText: z.boolean().default(false),
    includeValue: z.boolean().default(false),
    includeHtml: z.boolean().default(false),
    textLimit: z.number().int().min(0).max(20_000).default(2_000),
    htmlLimit: z.number().int().min(0).max(50_000).default(5_000),
    computedStyles: z.array(z.string().max(200)).max(50).default([]),
    allFrames: z.boolean().default(true),
    frameIds: z.array(z.number().int().nonnegative()).max(100).optional()
  },
  annotations: readOnly
}, async (input) => {
  const result = await bridge.request("observer.inspect.query", input, 30_000);
  const matches = result.frames.reduce((count, frame) => count + Number(frame.result?.matchCount || 0), 0);
  return resultWithText(result, `Found ${matches} match(es) across ${result.frames.length} frame(s).`);
});

server.registerTool("observer_inspect_evaluate", {
  title: "Execute JavaScript in the active page",
  description: "Explicitly execute arbitrary JavaScript in the active tab. The script may read runtime objects, mutate DOM, send requests, or trigger page behavior. Defaults to the top frame and MAIN page world. ISOLATED is exposed for diagnostics but string evaluation is normally rejected there by Manifest V3 extension CSP.",
  inputSchema: {
    source: z.string().min(1).max(100_000),
    world: z.enum(["MAIN", "ISOLATED"]).default("MAIN"),
    allFrames: z.boolean().default(false),
    frameIds: z.array(z.number().int().nonnegative()).max(100).optional(),
    maxDepth: z.number().int().min(1).max(30).default(8),
    maxEntries: z.number().int().min(1).max(20_000).default(2_000),
    maxStringLength: z.number().int().min(1).max(200_000).default(20_000)
  },
  annotations: inspectorMutation
}, async (input) => {
  const result = await bridge.request("observer.inspect.evaluate", input, 30_000);
  const failures = result.frames.filter((frame) => frame.result?.ok === false).length;
  return resultWithText(result, failures ? `JavaScript completed with ${failures} frame error(s).` : `JavaScript completed in ${result.frames.length} frame(s).`);
});

server.registerTool("observer_reload_extension", {
  title: "Reload the Page Observer extension",
  description: "Ask the running extension to reload itself after extension files change. This does not touch the observed page.",
  inputSchema: {}, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async () => {
  const result = await bridge.request("observer.reload", {}, 5_000);
  return resultWithText(result, "Scheduled a Page Observer extension reload.");
});

server.registerTool("dashboard_begin", {
  title: "Begin a visible automation run",
  description: "Show that automation is running in the extension Side Panel. This changes only extension-local UI state.",
  inputSchema: { label: z.string().min(1).max(120), message: z.string().max(300).default("") }, annotations: dashboardWrite
}, async (input) => resultWithText(await bridge.request("dashboard.begin", input, 5_000), "Started the visible automation run."));

server.registerTool("dashboard_update", {
  title: "Update visible automation status",
  description: "Update the Side Panel run step or waiting state without changing the web page.",
  inputSchema: { status: z.enum(["running", "waiting"]).default("running"), step: z.string().min(1).max(120), message: z.string().max(300).default("") }, annotations: dashboardWrite
}, async (input) => resultWithText(await bridge.request("dashboard.update", input, 5_000), "Updated the visible automation status."));

server.registerTool("dashboard_report_action", {
  title: "Report a native input action receipt",
  description: "Display an independently produced Native Input Driver action receipt in the Side Panel.",
  inputSchema: { actionId: z.string().max(120).default(""), action: z.string().min(1).max(80), status: z.enum(["started", "completed", "failed"]).default("completed"), message: z.string().max(300).default("") }, annotations: dashboardWrite
}, async (input) => resultWithText(await bridge.request("dashboard.action", input, 5_000), "Reported the native input action to the dashboard."));

server.registerTool("dashboard_end", {
  title: "End a visible automation run",
  description: "Mark the Side Panel run completed, failed, or cancelled. This changes only extension-local UI state.",
  inputSchema: { status: z.enum(["completed", "failed", "cancelled"]), message: z.string().max(300).default("") }, annotations: dashboardWrite
}, async (input) => resultWithText(await bridge.request("dashboard.end", input, 5_000), `Ended the visible automation run as ${input.status}.`));

await bridge.start();
await server.connect(new StdioServerTransport());
log("info", "page_observer_mcp_started", { bridgePort });
