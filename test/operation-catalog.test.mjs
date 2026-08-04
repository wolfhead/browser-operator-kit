import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OperationCatalog } from "../src/operation-catalog.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const operationDirectory = path.join(projectRoot, "demo", "adapter", "operations");
const createCatalog = () => new OperationCatalog({ directories: [operationDirectory] });

test("named operation expands parameters into a guarded command", async () => {
  const expanded = await createCatalog().expand("demo.search.setKeywords", { keywords: "alpha beta" });
  assert.equal(expanded.browserBundleIdentifier, "com.google.chrome.for.testing");
  assert.equal(expanded.command.expectedPage, "demo.page");
  assert.equal(expanded.command.action.text, "alpha beta");
  assert.equal(expanded.command.postconditions[0].equals, "alpha beta");
  assert.equal(expanded.kind, "atomic");
});

test("composite operation recursively expands registered operations", async () => {
  const expanded = await createCatalog().expand("demo.search.run", {
    request: { keywords: "alpha beta", resultText: "已应用：alpha beta" }
  });
  assert.equal(expanded.kind, "composite");
  assert.deepEqual(expanded.commands.map((command) => command.action.type), ["paste", "click"]);
  assert.deepEqual(expanded.trace.map((entry) => entry.operation), [
    "demo.search.setKeywords",
    "demo.search.submit"
  ]);
});

test("composite operation expands arrays and object entries through registered leaves", async () => {
  const catalog = createCatalog();
  const arrayExpansion = await catalog.expand("demo.search.setKeywordList", {
    keywords: ["alpha", "beta"]
  });
  assert.deepEqual(arrayExpansion.commands.map((command) => command.action.text), ["alpha", "beta"]);

  const objectExpansion = await catalog.expand("demo.search.setKeywordMap", {
    keywords: { primary: "alpha", secondary: "beta" }
  });
  assert.deepEqual(objectExpansion.commands.map((command) => command.action.text), ["alpha", "beta"]);
});

test("operation catalog expands registered readers and mixed command-reader composites", async () => {
  const catalog = createCatalog();
  const reader = await catalog.expand("demo.state.observe", {});
  assert.deepEqual(reader.nodes, [{
    type: "reader",
    operation: "demo.state.observe",
    handler: "eye.observe",
    input: {}
  }]);

  const mixed = await catalog.expand("demo.search.runAndObserve", {
    request: { keywords: "alpha", resultText: "已应用：alpha" }
  });
  assert.deepEqual(mixed.nodes.map((node) => node.type), ["command", "command", "reader"]);
  assert.deepEqual(mixed.trace.map((entry) => entry.operation), [
    "demo.search.setKeywords",
    "demo.search.submit",
    "demo.state.observe"
  ]);
});

test("named operation rejects missing and unexpected parameters", async () => {
  const catalog = createCatalog();
  await assert.rejects(() => catalog.expand("demo.search.setKeywords", {}), /Missing required parameter 'keywords'/);
  await assert.rejects(
    () => catalog.expand("demo.search.setKeywords", { keywords: "alpha", extra: "unsafe" }),
    /Unexpected parameter/
  );
});

test("operation catalog loads and merges explicit directories", async () => {
  const catalog = createCatalog();
  const names = (await catalog.list()).map((operation) => operation.name);
  assert.ok(names.includes("demo.search.run"));
  assert.ok(names.includes("demo.details.scrollToEnd"));
  assert.ok(names.includes("demo.state.observe"));
});

test("operation catalog rejects recursive composition cycles", async () => {
  const directory = path.join(projectRoot, "test", "fixtures", "operation-catalog-cycle", "operations");
  const catalog = new OperationCatalog({ directories: [directory] });
  await assert.rejects(() => catalog.expand("cycle.a", {}), /cycle\.a -> cycle\.b -> cycle\.a/);
});
