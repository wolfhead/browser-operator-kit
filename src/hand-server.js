import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { log, resultWithText } from "./mcp-utils.js";
import { NativeInputController } from "./native-input-controller.js";
import { findProjectRoot } from "./project-root.js";

const projectRoot = await findProjectRoot();
const hand = new NativeInputController({ projectRoot, logger: log });
const server = new McpServer(
  { name: "native-hand", version: "1.0.0" },
  { instructions: "Perform allowlisted native input only after receiving a fresh Eye observation. Validate the frontmost Chrome window and observation guard before every action. Return an OS action receipt; never claim page-level success." }
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

server.registerTool("hand_status", {
  title: "Check native Hand status", description: "Return Accessibility access, the frontmost app, and frontmost window bounds.",
  inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async () => {
  const status = await hand.status();
  return resultWithText(status, status.available ? `Native Hand is available; frontmost app is ${status.frontmostBundleIdentifier}.` : "Native Hand is unavailable.");
});

server.registerTool("hand_activate_chrome", {
  title: "Activate Chrome", description: "Bring the existing Google Chrome app to the foreground without opening a URL.",
  inputSchema: {}, annotations: actionAnnotations
}, async () => resultWithText(await hand.activateChrome(), "Requested Chrome activation."));

server.registerTool("hand_activate_browser", {
  title: "Activate an allowed browser",
  description: "Bring an explicitly allowlisted browser bundle to the foreground without opening a URL.",
  inputSchema: { bundleIdentifier: z.string().min(1).max(120) }, annotations: actionAnnotations
}, async ({ bundleIdentifier }) => {
  const allowed = new Set([
    "com.google.Chrome",
    ...String(process.env.WEB_AUTOMATION_ALLOWED_BUNDLE_IDS || "").split(",").map((value) => value.trim()).filter(Boolean)
  ]);
  if (!allowed.has(bundleIdentifier)) throw new Error("The requested browser bundle is not allowlisted.");
  return resultWithText(await hand.activateBrowser(bundleIdentifier), `Requested activation of allowed browser '${bundleIdentifier}'.`);
});

server.registerTool("hand_click", {
  title: "Click a named Eye target", description: "Move along a human-like path and click a fresh Eye coordinate after validating the OS window guard.",
  inputSchema: { point, guard, seed: z.number().int().nonnegative().optional() }, annotations: actionAnnotations
}, async (input) => runGuarded({ type: "moveClick", point: input.point, seed: input.seed }, input.guard));

server.registerTool("hand_paste_text", {
  title: "Paste text into a named Eye field", description: "Click and paste through the clipboard into a fresh Eye coordinate after validating the OS window guard.",
  inputSchema: { point, guard, text: z.string().min(1).max(240), seed: z.number().int().nonnegative().optional() }, annotations: actionAnnotations
}, async (input) => runGuarded({ type: "typeText", point: input.point, text: input.text, seed: input.seed }, input.guard));

server.registerTool("hand_scroll", {
  title: "Scroll a named Eye viewport", description: "Send a human-shaped native wheel sequence at a fresh Eye coordinate after validating the OS window guard.",
  inputSchema: { point, guard, deltaY: z.number().int().min(80).max(2_400), seed: z.number().int().nonnegative().optional() }, annotations: actionAnnotations
}, async (input) => runGuarded({ type: "scroll", point: input.point, deltaY: input.deltaY, seed: input.seed }, input.guard));

async function runGuarded(action, observationGuard) {
  const before = await hand.status();
  validateGuard(before, observationGuard);
  const receipt = await hand.execute(action);
  return resultWithText(receipt, `Native Hand emitted '${receipt.action}' as action ${receipt.actionId}; use Eye to verify page state.`);
}

function validateGuard(status, observationGuard) {
  const now = Date.now();
  if (
    now > observationGuard.expiresAt ||
    observationGuard.expiresAt <= observationGuard.observedAt ||
    observationGuard.expiresAt - observationGuard.observedAt > 30_000
  ) {
    throw new Error("Refusing input: the Eye observation is stale. Observe the page again.");
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
      throw new Error(`Refusing input: Chrome window '${key}' changed since Eye observation.`);
    }
  }
}

await server.connect(new StdioServerTransport());
log("info", "native_hand_mcp_started", { projectRoot });
