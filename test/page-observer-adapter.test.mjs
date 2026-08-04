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
