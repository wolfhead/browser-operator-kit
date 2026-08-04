import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadAdapterRegistration, validateAdapterRegistration } from "../src/adapter-loader.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("adapter loader creates a runtime registration with inline descriptors", async () => {
  const registration = await loadAdapterRegistration(
    path.join(projectRoot, "demo", "adapter", "automation.adapter.json")
  );

  assert.equal(registration.id, "browser-operator-kit-demo");
  assert.equal(registration.displayName, "Browser Operator Kit Demo");
  assert.deepEqual(registration.hostPermissions, [
    "http://127.0.0.1:8765/*",
    "http://localhost:8765/*"
  ]);
  assert.equal(registration.descriptors.length, 1);
  assert.equal(registration.descriptors[0].id, "browser-operator-demo");
});

test("adapter registration rejects descriptor origins without matching permission", () => {
  assert.throws(() => validateAdapterRegistration({
    schemaVersion: 1,
    id: "test",
    displayName: "Test",
    version: "1.0.0",
    hostPermissions: ["https://allowed.example/*"],
    descriptors: [{
      schemaVersion: 1,
      id: "test-page",
      version: "1.0.0",
      match: { origins: ["https://blocked.example"] },
      pages: [], fields: [], controls: [], values: [], collections: [], scrollables: []
    }]
  }), /not declared/);
});
