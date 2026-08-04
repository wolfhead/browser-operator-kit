import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.join(projectRoot, "output", "demo", "orchestrator-mcp-acceptance.json");
const orchestratorServer = process.env.WEB_ORCHESTRATOR_ACCEPTANCE_SERVER
  ? path.resolve(projectRoot, process.env.WEB_ORCHESTRATOR_ACCEPTANCE_SERVER)
  : path.join(projectRoot, "dist", "server", "command-orchestrator-server.mjs");
const orchestratorCwd = process.env.WEB_ORCHESTRATOR_ACCEPTANCE_CWD
  ? path.resolve(projectRoot, process.env.WEB_ORCHESTRATOR_ACCEPTANCE_CWD)
  : projectRoot;
const bridgePort = process.env.WEB_ORCHESTRATOR_ACCEPTANCE_BRIDGE_PORT || "38494";
const demoUrl = process.env.WEB_ORCHESTRATOR_DEMO_URL || "http://127.0.0.1:8765/";
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [orchestratorServer],
  cwd: orchestratorCwd,
  env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === "string")),
    WEB_ORCHESTRATOR_BRIDGE_PORT: bridgePort,
    WEB_AUTOMATION_ALLOWED_BUNDLE_IDS: "com.google.chrome.for.testing",
    WEB_AUTOMATION_OPERATION_DIRS: path.join(projectRoot, "demo", "adapter", "operations"),
    WEB_AUTOMATION_ALLOWED_OPEN_URLS: JSON.stringify([demoUrl])
  },
  stderr: "pipe"
});
transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));
const client = new Client({ name: "command-orchestrator-acceptance", version: "1.0.0" });
let result;

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const operationList = await client.callTool({ name: "web_list_operations", arguments: {} });
  const execution = await client.callTool({
    name: "web_execute_operations",
    arguments: {
      id: "orchestrator-mcp-local-acceptance",
      label: "Command Orchestrator MCP 本地命名操作验收",
      operations: [
        {
          name: "demo.search.run",
          parameters: {
            request: {
              keywords: "alpha beta",
              resultText: "已应用：alpha beta"
            }
          }
        },
        { name: "demo.details.scrollToEnd", parameters: {} }
      ]
    }
  });
  const executionResult = execution.structuredContent ?? execution;
  result = {
    ok: executionResult?.report?.ok === true,
    bridgePort: Number(bridgePort),
    toolNames: tools.tools.map((tool) => tool.name),
    configuredOperationCount: operationList.structuredContent?.operations?.length ?? null,
    execution: executionResult
  };
} catch (error) {
  result = { ok: false, error: error instanceof Error ? error.message : String(error) };
} finally {
  await client.close().catch(() => {});
}

await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ok: result.ok, report: path.relative(projectRoot, reportPath), error: result.error ?? result.execution?.report?.error ?? null })}\n`);
if (!result.ok) process.exitCode = 1;
