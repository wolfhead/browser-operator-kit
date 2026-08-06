import assert from "node:assert/strict";
import test from "node:test";
import { PageObserver } from "../extension/observer/engine.js";

const registration = {
  schemaVersion: 1,
  id: "example-adapter",
  displayName: "Example Adapter",
  version: "1.0.0",
  hostPermissions: ["https://example.com/*"],
  descriptors: [{
    schemaVersion: 1,
    id: "example-page",
    version: "1.0.0",
    match: { origins: ["https://example.com"], pathPrefixes: ["/app"] },
    pages: [], fields: [], controls: [], values: [], collections: [], scrollables: []
  }]
};

test("Page Observer registers runtime adapters and reports missing optional permission", async (context) => {
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    permissions: { contains: async () => false },
    tabs: {
      query: async () => [{
        id: 7,
        windowId: 3,
        title: "Example",
        url: "https://example.com/app"
      }]
    }
  };
  context.after(() => { globalThis.chrome = previousChrome; });

  const observer = new PageObserver();
  const adapterStatus = await observer.registerAdapter("ws://127.0.0.1:38493", registration);
  assert.equal(adapterStatus.authorized, false);
  assert.deepEqual(adapterStatus.missingHostPermissions, ["https://example.com/*"]);
  assert.equal((await observer.loadDescriptors()).length, 1);

  const observation = await observer.observeActiveTab();
  assert.equal(observation.page, "permission-required");
  assert.deepEqual(observation.descriptorIds, ["example-page"]);
  assert.deepEqual(observation.requiredHostPermissions, ["https://example.com/*"]);

  assert.equal(observer.unregisterAdapter("ws://127.0.0.1:38493"), true);
  assert.equal((await observer.loadDescriptors()).length, 0);
});

test("Page Observer captures only a registered page with granted host permission", async (context) => {
  const previousChrome = globalThis.chrome;
  const captures = [];
  globalThis.chrome = {
    permissions: { contains: async ({ origins }) => origins[0] === "https://example.com/*" },
    tabs: {
      query: async () => [{
        id: 7,
        windowId: 3,
        title: "Example",
        url: "https://example.com/app/candidate"
      }],
      captureVisibleTab: async (...argumentsList) => {
        captures.push(argumentsList);
        return "data:image/png;base64,dGVzdA==";
      }
    }
  };
  context.after(() => { globalThis.chrome = previousChrome; });

  const observer = new PageObserver();
  await observer.registerAdapter("ws://127.0.0.1:38493", registration);
  const result = await observer.captureVisibleTab();

  assert.equal(result.ok, true);
  assert.equal(result.tab.url, "https://example.com/app/candidate");
  assert.deepEqual(result.descriptorIds, ["example-page"]);
  assert.deepEqual(captures, [[3, { format: "png" }]]);
});

test("Page Observer refuses screenshot capture outside registered descriptor paths", async (context) => {
  const previousChrome = globalThis.chrome;
  let captured = false;
  globalThis.chrome = {
    permissions: { contains: async () => true },
    tabs: {
      query: async () => [{
        id: 7,
        windowId: 3,
        title: "Other",
        url: "https://example.com/private"
      }],
      captureVisibleTab: async () => {
        captured = true;
        return "data:image/png;base64,dGVzdA==";
      }
    }
  };
  context.after(() => { globalThis.chrome = previousChrome; });

  const observer = new PageObserver();
  await observer.registerAdapter("ws://127.0.0.1:38493", registration);

  await assert.rejects(() => observer.captureVisibleTab(), /not authorized for unregistered page/);
  assert.equal(captured, false);
});
