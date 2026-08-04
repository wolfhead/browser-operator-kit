import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { log, resultWithText } from "./mcp-utils.js";
import { NativeInputDriver } from "./native-input-driver.js";
import { findProjectRoot } from "./project-root.js";

const projectRoot = await findProjectRoot();
const inputDriver = new NativeInputDriver({ projectRoot, logger: log });
const server = new McpServer(
  { name: "native-input", version: "1.0.0" },
  { instructions: "Perform allowlisted native input only after receiving a fresh Page Observer result. Validate the frontmost Chrome window and observation guard before every action. Return an OS action receipt; never claim page-level success." }
);
const point = z.object({ x: z.number().min(-20_000).max(20_000), y: z.number().min(-20_000).max(20_000) });
const guard = z.object({
  observationId: z.string().min(1),
  observedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  expectedWindowBounds: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }),
  tolerance: z.number().min(0).max(40).default(12)
});
const actionAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

server.registerTool("input_status", {
  title: "Check Native Input Driver status", description: "Return Accessibility access, the frontmost app, and frontmost window bounds.",
  inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async () => {
  const status = await inputDriver.status();
  return resultWithText(status, status.available ? `Native Input Driver is available; frontmost app is ${status.frontmostBundleIdentifier}.` : "Native Input Driver is unavailable.");
});

server.registerTool("input_activate_chrome", {
  title: "Activate Chrome", description: "Bring the existing Google Chrome app to the foreground without opening a URL.",
  inputSchema: {}, annotations: actionAnnotations
}, async () => resultWithText(await inputDriver.activateChrome(), "Requested Chrome activation."));

server.registerTool("input_activate_browser", {
  title: "Activate an allowed browser",
  description: "Bring an explicitly allowlisted browser bundle to the foreground without opening a URL.",
  inputSchema: { bundleIdentifier: z.string().min(1).max(120) }, annotations: actionAnnotations
}, async ({ bundleIdentifier }) => {
  const allowed = new Set([
    "com.google.Chrome",
    ...String(process.env.WEB_AUTOMATION_ALLOWED_BUNDLE_IDS || "").split(",").map((value) => value.trim()).filter(Boolean)
  ]);
  if (!allowed.has(bundleIdentifier)) throw new Error("The requested browser bundle is not allowlisted.");
  return resultWithText(await inputDriver.activateBrowser(bundleIdentifier), `Requested activation of allowed browser '${bundleIdentifier}'.`);
});

server.registerTool("input_click", {
  title: "Click a named observer target", description: "Move along a human-like path and click a fresh observer coordinate after validating the OS window guard.",
  inputSchema: { point, guard, seed: z.number().int().nonnegative().optional() }, annotations: actionAnnotations
}, async (input) => runGuarded({ type: "moveClick", point: input.point, seed: input.seed }, input.guard));

server.registerTool("input_paste_text", {
  title: "Paste text into a named observer field", description: "Click and paste through the clipboard into a fresh observer coordinate after validating the OS window guard.",
  inputSchema: { point, guard, text: z.string().min(1).max(240), seed: z.number().int().nonnegative().optional() }, annotations: actionAnnotations
}, async (input) => runGuarded({ type: "typeText", point: input.point, text: input.text, seed: input.seed }, input.guard));

server.registerTool("input_scroll", {
  title: "Scroll a named observer viewport", description: "Send a human-shaped native wheel sequence at a fresh observer coordinate after validating the OS window guard.",
  inputSchema: { point, guard, deltaY: z.number().int().min(80).max(2_400), seed: z.number().int().nonnegative().optional() }, annotations: actionAnnotations
}, async (input) => runGuarded({ type: "scroll", point: input.point, deltaY: input.deltaY, seed: input.seed }, input.guard));

async function runGuarded(action, observationGuard) {
  const before = await inputDriver.status();
  validateGuard(before, observationGuard);
  const receipt = await inputDriver.execute(action);
  return resultWithText(receipt, `Native Input Driver emitted '${receipt.action}' as action ${receipt.actionId}; use Page Observer to verify page state.`);
}

function validateGuard(status, observationGuard) {
  const now = Date.now();
  if (
    now > observationGuard.expiresAt ||
    observationGuard.expiresAt <= observationGuard.observedAt ||
    observationGuard.expiresAt - observationGuard.observedAt > 30_000
  ) {
    throw new Error("Refusing input: the Page Observer result is stale. Observe the page again.");
  }
  const allowedBundleIdentifiers = new Set([
    "com.google.Chrome",
    ...String(process.env.WEB_AUTOMATION_ALLOWED_BUNDLE_IDS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  ]);
  if (!allowedBundleIdentifiers.has(status.frontmostBundleIdentifier)) {
    throw new Error(`Refusing input: frontmost application '${status.frontmostBundleIdentifier}' is not in the allowed browser bundle list.`);
  }
  const actual = status.frontmostWindowBounds;
  if (!actual) throw new Error("Refusing input: the frontmost Chrome window has no measurable bounds.");
  const expected = observationGuard.expectedWindowBounds;
  const tolerance = observationGuard.tolerance;
  for (const key of ["x", "y", "width", "height"]) {
    if (Math.abs(Number(actual[key]) - Number(expected[key])) > tolerance) {
      throw new Error(`Refusing input: Chrome window '${key}' changed since the Page Observer result.`);
    }
  }
}

await server.connect(new StdioServerTransport());
log("info", "native_input_mcp_started", { projectRoot });
