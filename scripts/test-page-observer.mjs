import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { BridgeServer } from "../src/bridge-server.js";
import { findProjectRoot } from "../src/project-root.js";

const projectRoot = await findProjectRoot();
const reportPath = path.join(projectRoot, "output", "inspector", "acceptance.json");
const bridge = new BridgeServer({ port: 38492 });
await bridge.start();

try {
  await bridge.waitForConnection(75_000);
  const status = await bridge.request("observer.status", {}, 5_000);
  const activeUrl = String(status.activeTab?.url || "");
  if (!/^https?:\/\//.test(activeUrl)) throw new Error(`Inspector acceptance requires an HTTP(S) page, received '${activeUrl}'.`);

  const snapshot = await bridge.request("observer.inspect.snapshot", {
    rootSelector: "html",
    maxDepth: 2,
    maxNodes: 300,
    includeText: false,
    includeGeometry: true,
    allFrames: true
  }, 30_000);
  const query = await bridge.request("observer.inspect.query", {
    selector: "html",
    selectorType: "css",
    includeText: false,
    ancestorDepth: 0,
    allFrames: true
  }, 30_000);
  const mutationEvaluation = await bridge.request("observer.inspect.evaluate", {
    world: "MAIN",
    source: "(() => { const root = document.documentElement; root.dataset.observerInspectorAcceptance = 'ok'; const observed = root.dataset.observerInspectorAcceptance; delete root.dataset.observerInspectorAcceptance; return { observed, cleaned: !root.hasAttribute('data-observer-inspector-acceptance') }; })()"
  }, 30_000);
  const mainEvaluation = await bridge.request("observer.inspect.evaluate", {
    world: "MAIN",
    source: "({ origin: location.origin, hasDocumentElement: Boolean(document.documentElement) })"
  }, 30_000);

  const mutationValue = mutationEvaluation.frames[0]?.result?.value;
  const mutationProperties = mutationValue?.properties || {};
  const mainValue = mainEvaluation.frames[0]?.result?.value;
  const mainProperties = mainValue?.properties || {};
  const report = {
    ok: snapshot.frames.length > 0 &&
      snapshot.frames.some((frame) => Number(frame.result?.nodeCount || 0) > 0) &&
      query.frames.some((frame) => Number(frame.result?.matchCount || 0) > 0) &&
      mutationEvaluation.frames[0]?.result?.ok === true &&
      mutationProperties.observed === "ok" && mutationProperties.cleaned === true &&
      mainEvaluation.frames[0]?.result?.ok === true && mainProperties.hasDocumentElement === true,
    testedAt: Date.now(),
    activeOrigin: new URL(activeUrl).origin,
    snapshot: {
      frameCount: snapshot.frames.length,
      nodeCounts: snapshot.frames.map((frame) => ({ frameId: frame.frameId, count: Number(frame.result?.nodeCount || 0), truncated: frame.result?.truncated === true }))
    },
    query: {
      frameCount: query.frames.length,
      matchCounts: query.frames.map((frame) => ({ frameId: frame.frameId, count: Number(frame.result?.matchCount || 0) }))
    },
    evaluate: {
      mainWorldMutationObserved: mutationProperties.observed === "ok",
      mainWorldMutationCleaned: mutationProperties.cleaned === true,
      mainWorldSucceeded: mainEvaluation.frames[0]?.result?.ok === true,
      mainWorldHasDocumentElement: mainProperties.hasDocumentElement === true,
      mutationDiagnostic: mutationEvaluation.frames[0]?.result?.ok === true ? mutationValue : mutationEvaluation.frames[0]?.result?.error
    }
  };
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (!report.ok) throw new Error(`Inspector acceptance failed. See ${reportPath}`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await bridge.stop();
}
