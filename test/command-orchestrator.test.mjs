import assert from "node:assert/strict";
import test from "node:test";
import { CommandOrchestrator } from "../src/command-orchestrator.js";

test("web command runs page check, target lookup, foreground lease, action, verification, and release", async () => {
  const observations = [
    observation(""),
    observation("", true),
    observation("expected", true)
  ];
  const calls = [];
  const bridge = fakeBridge(observations, calls);
  const inputDriver = fakeInputDriver(calls);
  const orchestrator = new CommandOrchestrator({ bridge, inputDriver });
  const report = await orchestrator.executeWorkflow({
    id: "test-workflow",
    label: "Test workflow",
    browserBundleIdentifier: "com.google.Chrome",
    commands: [{
      id: "paste",
      expectedPage: "fixture",
      target: { scope: "fields", name: "query" },
      preconditions: [{ scope: "fields", name: "query", path: "read.value", equals: "" }],
      action: { type: "paste", text: "expected" },
      postconditions: [{ scope: "fields", name: "query", path: "read.value", equals: "expected" }]
    }]
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.commands[0].foreground, {
    switched: true,
    targetBundleIdentifier: "com.google.Chrome",
    previousBundleIdentifier: "com.openai.codex",
    released: true,
    restored: true,
    reason: "restored",
    finalFrontmostBundleIdentifier: "com.openai.codex"
  });
  assert.deepEqual(calls.filter((call) => call.type === "lease").map((call) => call.event), ["begin", "end"]);
  assert.equal(calls.find((call) => call.type === "action").action.type, "typeText");
});

test("web command releases foreground lease when postcondition fails", async () => {
  const calls = [];
  const orchestrator = new CommandOrchestrator({
    bridge: fakeBridge([observation(""), observation("", true), observation("wrong", true)], calls),
    inputDriver: fakeInputDriver(calls),
    postconditionAttempts: 1
  });
  const report = await orchestrator.executeWorkflow({
    id: "failure-workflow",
    label: "Failure workflow",
    browserBundleIdentifier: "com.google.Chrome",
    commands: [{
      id: "paste",
      expectedPage: "fixture",
      target: { scope: "fields", name: "query" },
      action: { type: "paste", text: "expected" },
      postconditions: [{ scope: "fields", name: "query", path: "read.value", equals: "expected" }]
    }]
  });
  assert.equal(report.ok, false);
  assert.equal(report.error.code, "POSTCONDITION_FAILED");
  assert.equal(calls.some((call) => call.type === "lease" && call.event === "end"), true);
});

test("web command focuses the exact observed browser window before native input", async () => {
  const background = observation("");
  background.observationId = "observation-1";
  background.window = { id: 17, focused: false, left: 10, top: 20, width: 1200, height: 800 };
  background.tab = { title: "Fixture" };
  const calls = [];
  const orchestrator = new CommandOrchestrator({
    bridge: fakeBridge([background, observation("", true), observation("expected", true)], calls),
    inputDriver: fakeInputDriver(calls)
  });
  const report = await orchestrator.executeWorkflow({
    id: "focus-observed-window",
    label: "Focus observed window",
    browserBundleIdentifier: "com.google.Chrome",
    commands: [{
      id: "paste",
      expectedPage: "fixture",
      target: { scope: "fields", name: "query" },
      action: { type: "paste", text: "expected" },
      postconditions: [{ scope: "fields", name: "query", path: "read.value", equals: "expected" }]
    }]
  });
  assert.equal(report.ok, true);
  assert.deepEqual(calls.find((call) => call.type === "focusWindow"), {
    type: "focusWindow",
    bundleIdentifier: "com.google.Chrome",
    window: background.window,
    title: "Fixture"
  });
  assert.equal(
    calls.findIndex((call) => call.type === "focusWindow") <
      calls.findIndex((call) => call.type === "action"),
    true
  );
});

test("web command waits for an asynchronous postcondition before reporting success", async () => {
  const calls = [];
  const orchestrator = new CommandOrchestrator({
    bridge: fakeBridge([
      observation(""),
      observation("", true),
      observation("pending", true),
      observation("expected", true)
    ], calls),
    inputDriver: fakeInputDriver(calls),
    postconditionAttempts: 2,
    postconditionDelayMs: 0
  });
  const report = await orchestrator.executeWorkflow({
    id: "delayed-postcondition",
    label: "Delayed postcondition",
    browserBundleIdentifier: "com.google.Chrome",
    commands: [{
      id: "paste",
      expectedPage: "fixture",
      target: { scope: "fields", name: "query" },
      action: { type: "paste", text: "expected" },
      postconditions: [{ scope: "fields", name: "query", path: "read.value", equals: "expected" }]
    }]
  });
  assert.equal(report.ok, true);
  assert.equal(calls.filter((call) => call.type === "bridge" && call.command === "observer.observe").length, 4);
});

test("web command treats the previous page as transient while navigation completes", async () => {
  const calls = [];
  const previousPage = observation("", true);
  const resultPage = observation("", true);
  resultPage.page = "detail";
  const orchestrator = new CommandOrchestrator({
    bridge: fakeBridge([observation(""), observation("", true), previousPage, resultPage], calls),
    inputDriver: fakeInputDriver(calls),
    postconditionDelayMs: 0
  });
  const report = await orchestrator.executeWorkflow({
    id: "delayed-navigation",
    label: "Delayed navigation",
    browserBundleIdentifier: "com.google.Chrome",
    commands: [{
      id: "open",
      expectedPage: "fixture",
      expectedResultPage: "detail",
      target: { scope: "fields", name: "query" },
      action: { type: "click" },
      verificationPolicy: { initialDelayMs: 0, pollIntervalMs: 0, timeoutMs: 1_000, stablePasses: 1 }
    }]
  });
  assert.equal(report.ok, true);
});

test("web command applies per-command initial and polling delays", async () => {
  const calls = [];
  const delays = [];
  const orchestrator = new CommandOrchestrator({
    bridge: fakeBridge([
      observation(""),
      observation("", true),
      observation("pending", true),
      observation("expected", true)
    ], calls),
    inputDriver: fakeInputDriver(calls),
    sleep: async (milliseconds) => delays.push(milliseconds)
  });
  const report = await orchestrator.executeWorkflow({
    id: "verification-policy",
    label: "Verification policy",
    browserBundleIdentifier: "com.google.Chrome",
    commands: [{
      id: "paste",
      expectedPage: "fixture",
      target: { scope: "fields", name: "query" },
      action: { type: "paste", text: "expected" },
      verificationPolicy: { initialDelayMs: 240, pollIntervalMs: 90, timeoutMs: 1_000, stablePasses: 1 },
      postconditions: [{ scope: "fields", name: "query", path: "read.value", equals: "expected" }]
    }]
  });
  assert.equal(report.ok, true);
  assert.deepEqual(delays, [240, 90]);
});

test("web command rejects an unexpected result page", async () => {
  const calls = [];
  const final = observation("expected", true);
  final.page = "verification";
  const orchestrator = new CommandOrchestrator({
    bridge: fakeBridge([observation(""), observation("", true), final], calls),
    inputDriver: fakeInputDriver(calls)
  });
  const report = await orchestrator.executeWorkflow({
    id: "result-page-failure",
    label: "Result page failure",
    browserBundleIdentifier: "com.google.Chrome",
    commands: [{
      id: "paste",
      expectedPage: "fixture",
      target: { scope: "fields", name: "query" },
      action: { type: "paste", text: "expected" },
      postconditions: [{ scope: "fields", name: "query", path: "read.value", equals: "expected" }]
    }]
  });
  assert.equal(report.ok, false);
  assert.equal(report.error.code, "POSTCONDITION_FAILED");
  assert.match(report.error.message, /Expected result page/);
});

test("web command refuses an occluded target", async () => {
  const calls = [];
  const blocked = observation("");
  blocked.fields.query.occluded = true;
  const orchestrator = new CommandOrchestrator({ bridge: fakeBridge([blocked], calls), inputDriver: fakeInputDriver(calls) });
  const report = await orchestrator.executeWorkflow({
    id: "occluded-target",
    label: "Occluded target",
    browserBundleIdentifier: "com.google.Chrome",
    commands: [{
      id: "paste",
      expectedPage: "fixture",
      target: { scope: "fields", name: "query" },
      readinessPolicy: { pollIntervalMs: 20, timeoutMs: 0 },
      action: { type: "paste", text: "expected" }
    }]
  });
  assert.equal(report.ok, false);
  assert.equal(report.error.code, "TARGET_NOT_FOUND");
  assert.equal(calls.some((call) => call.type === "action"), false);
});

test("web command resolves a registered collection item by index", async () => {
  const calls = [];
  const before = observation("");
  before.collections.items = { items: [collectionItem(10), collectionItem(20)] };
  const actionable = observation("", true);
  actionable.collections.items = { items: [collectionItem(10), collectionItem(20)] };
  const after = observation("", true);
  after.page = "detail";
  const orchestrator = new CommandOrchestrator({ bridge: fakeBridge([before, actionable, after], calls), inputDriver: fakeInputDriver(calls) });
  const report = await orchestrator.executeWorkflow({
    id: "collection-target",
    label: "Collection target",
    browserBundleIdentifier: "com.google.Chrome",
    commands: [{
      id: "open-second",
      expectedPage: "fixture",
      expectedResultPage: "detail",
      target: { scope: "collections", name: "items", index: 1 },
      action: { type: "click" }
    }]
  });
  assert.equal(report.ok, true);
  assert.deepEqual(calls.find((call) => call.type === "action").action.point, { x: 20, y: 220 });
});

test("web command resolves a registered collection item by stable identity", async () => {
  const calls = [];
  const before = observation("");
  before.collections.items = { items: [
    { ...collectionItem(10), identityKey: "href:/item/a" },
    { ...collectionItem(20), identityKey: "href:/item/b" }
  ] };
  const actionable = observation("", true);
  actionable.collections.items = structuredClone(before.collections.items);
  const after = observation("", true);
  after.page = "detail";
  const orchestrator = new CommandOrchestrator({ bridge: fakeBridge([before, actionable, after], calls), inputDriver: fakeInputDriver(calls) });
  const report = await orchestrator.executeWorkflow({
    id: "collection-identity",
    label: "Collection identity",
    browserBundleIdentifier: "com.google.Chrome",
    commands: [{
      id: "open-stable-item",
      expectedPage: "fixture",
      expectedResultPage: "detail",
      target: { scope: "collections", name: "items", identityKey: "href:/item/b" },
      action: { type: "click" }
    }]
  });
  assert.equal(report.ok, true);
  assert.deepEqual(calls.find((call) => call.type === "action").action.point, { x: 20, y: 220 });
});

test("web command resolves collection indices in postconditions", async () => {
  const calls = [];
  const before = observation("");
  const actionable = observation("", true);
  const after = observation("", true);
  after.collections.items = { items: [{ visible: false }, { visible: true }] };
  const orchestrator = new CommandOrchestrator({ bridge: fakeBridge([before, actionable, after], calls), inputDriver: fakeInputDriver(calls) });
  const report = await orchestrator.executeWorkflow({
    id: "collection-postcondition",
    label: "Collection postcondition",
    browserBundleIdentifier: "com.google.Chrome",
    commands: [{
      id: "verify-second",
      expectedPage: "fixture",
      target: { scope: "fields", name: "query" },
      action: { type: "click" },
      postconditions: [{ scope: "collections", name: "items", index: 1, path: "visible", equals: true }]
    }]
  });
  assert.equal(report.ok, true);
});

test("web command supports threshold assertions for loaded collections", async () => {
  const calls = [];
  const before = observation("");
  const actionable = observation("", true);
  const after = observation("", true);
  after.collections.items = { count: 3, items: [] };
  const orchestrator = new CommandOrchestrator({ bridge: fakeBridge([before, actionable, after], calls), inputDriver: fakeInputDriver(calls) });
  const report = await orchestrator.executeWorkflow({
    id: "collection-threshold",
    label: "Collection threshold",
    browserBundleIdentifier: "com.google.Chrome",
    commands: [{
      id: "submit",
      expectedPage: "fixture",
      target: { scope: "fields", name: "query" },
      action: { type: "click" },
      postconditions: [{ scope: "collections", name: "items", path: "count", atLeast: 1 }]
    }]
  });
  assert.equal(report.ok, true);
});

test("idempotent web command skips native input when postconditions already pass", async () => {
  const calls = [];
  const alreadyDone = observation("");
  alreadyDone.controls.favorite = {
    found: true,
    visible: true,
    enabled: true,
    occluded: false,
    coordinateReady: true,
    screenPoint: { x: 300, y: 220 },
    read: { text: "已收藏" }
  };
  const orchestrator = new CommandOrchestrator({ bridge: fakeBridge([alreadyDone], calls), inputDriver: fakeInputDriver(calls) });
  const report = await orchestrator.executeWorkflow({
    id: "ensure-favorite",
    label: "Ensure favorite",
    browserBundleIdentifier: "com.google.Chrome",
    commands: [{
      id: "ensure-favorite",
      expectedPage: "fixture",
      target: { scope: "controls", name: "favorite" },
      preconditions: [{ scope: "controls", name: "favorite", path: "read.text", equals: "收藏" }],
      action: { type: "click" },
      executionPolicy: { skipActionWhenPostconditionsPass: true },
      postconditions: [{ scope: "controls", name: "favorite", path: "read.text", equals: "已收藏" }]
    }]
  });
  assert.equal(report.ok, true);
  assert.equal(report.commands[0].actionSkipped, true);
  assert.equal(calls.some((call) => call.type === "lease"), false);
  assert.equal(calls.some((call) => call.type === "action"), false);
});

test("web command verifies that a registered value changed from its pre-action baseline", async () => {
  const calls = [];
  const before = observation("");
  before.values.identity = { found: true, read: { url: "https://example.test/detail/a" } };
  const actionable = observation("", true);
  actionable.values.identity = { found: true, read: { url: "https://example.test/detail/a" } };
  const after = observation("", true);
  after.values.identity = { found: true, read: { url: "https://example.test/detail/b" } };
  const orchestrator = new CommandOrchestrator({ bridge: fakeBridge([before, actionable, after], calls), inputDriver: fakeInputDriver(calls) });
  const report = await orchestrator.executeWorkflow({
    id: "changed-identity",
    label: "Changed identity",
    browserBundleIdentifier: "com.google.Chrome",
    commands: [{
      id: "next",
      expectedPage: "fixture",
      target: { scope: "fields", name: "query" },
      action: { type: "click" },
      postconditions: [{ scope: "values", name: "identity", path: "read.url", changed: true }]
    }]
  });
  assert.equal(report.ok, true);
});

test("web command rejects a changed assertion when the value stays the same", async () => {
  const calls = [];
  const before = observation("");
  before.values.identity = { found: true, read: { url: "https://example.test/detail/a" } };
  const actionable = observation("", true);
  actionable.values.identity = structuredClone(before.values.identity);
  const after = observation("", true);
  after.values.identity = structuredClone(before.values.identity);
  const orchestrator = new CommandOrchestrator({
    bridge: fakeBridge([before, actionable, after], calls),
    inputDriver: fakeInputDriver(calls),
    postconditionAttempts: 1
  });
  const report = await orchestrator.executeWorkflow({
    id: "unchanged-identity",
    label: "Unchanged identity",
    browserBundleIdentifier: "com.google.Chrome",
    commands: [{
      id: "next",
      expectedPage: "fixture",
      target: { scope: "fields", name: "query" },
      action: { type: "click" },
      postconditions: [{ scope: "values", name: "identity", path: "read.url", changed: true }]
    }]
  });
  assert.equal(report.ok, false);
  assert.equal(report.error.code, "POSTCONDITION_FAILED");
});

test("bootstrap web command opens an exactly allowed URL and verifies it with Page Observer", async () => {
  const calls = [];
  const unrelatedPage = observation("", false);
  unrelatedPage.page = "unregistered";
  const searchPage = observation("", true);
  searchPage.page = "demo.page";
  const orchestrator = new CommandOrchestrator({
    bridge: fakeBridge([unrelatedPage, searchPage], calls),
    inputDriver: fakeInputDriver(calls),
    allowedOpenUrls: ["https://example.test/start"]
  });
  const report = await orchestrator.executeWorkflow({
    id: "open-demo-page",
    label: "Open demo page",
    browserBundleIdentifier: "com.google.Chrome",
    commands: [{
      id: "open-demo-page",
      expectedResultPage: "demo.page",
      foregroundPolicy: { activate: "ifNeeded", restore: "previousUnlessHumanTakeover" },
      action: { type: "openUrl", url: "https://example.test/start" },
      verificationPolicy: { initialDelayMs: 0, pollIntervalMs: 0, timeoutMs: 1_000, stablePasses: 1 },
      postconditions: []
    }]
  });
  assert.equal(report.ok, true);
  assert.equal(report.commands[0].page, "demo.page");
  assert.equal(calls.filter((call) => call.type === "openUrl").length, 1);
  assert.deepEqual(calls.filter((call) => call.type === "lease").map((call) => call.event), ["begin", "end"]);
  assert.equal(calls.some((call) => call.type === "action"), false);
});

test("bootstrap web command is idempotent when Page Observer already reports the expected page", async () => {
  const calls = [];
  const searchPage = observation("", false);
  searchPage.page = "demo.page";
  const orchestrator = new CommandOrchestrator({ bridge: fakeBridge([searchPage], calls), inputDriver: fakeInputDriver(calls) });
  const report = await orchestrator.executeWorkflow({
    id: "ensure-demo-page",
    label: "Ensure demo page",
    browserBundleIdentifier: "com.google.Chrome",
    commands: [{
      id: "ensure-demo-page",
      expectedResultPage: "demo.page",
      action: { type: "openUrl", url: "https://example.test/start" }
    }]
  });
  assert.equal(report.ok, true);
  assert.equal(report.commands[0].actionSkipped, true);
  assert.equal(calls.some((call) => call.type === "openUrl"), false);
  assert.equal(calls.some((call) => call.type === "lease"), false);
});

test("bootstrap web command opens an allowed URL from a restricted Chrome page", async () => {
  const calls = [];
  const searchPage = observation("", true);
  searchPage.page = "demo.page";
  let observeCount = 0;
  const bridge = {
    async request(command, params) {
      calls.push({ type: "bridge", command, params });
      if (command !== "observer.observe") return { ok: true };
      observeCount += 1;
      if (observeCount === 1) {
        throw new Error("Page Observer cannot inspect restricted URL protocol 'chrome:'.");
      }
      return searchPage;
    }
  };
  const orchestrator = new CommandOrchestrator({
    bridge,
    inputDriver: fakeInputDriver(calls),
    allowedOpenUrls: ["https://example.test/start"]
  });

  const report = await orchestrator.executeWorkflow({
    id: "open-from-internal-page",
    label: "Open from internal page",
    browserBundleIdentifier: "com.google.Chrome",
    commands: [{
      id: "open-demo-page",
      expectedResultPage: "demo.page",
      foregroundPolicy: { activate: "ifNeeded", restore: "previousUnlessHumanTakeover" },
      action: { type: "openUrl", url: "https://example.test/start" },
      verificationPolicy: { initialDelayMs: 0, pollIntervalMs: 0, timeoutMs: 1_000, stablePasses: 1 },
      postconditions: []
    }]
  });

  assert.equal(report.ok, true);
  assert.equal(report.commands[0].page, "demo.page");
  assert.equal(calls.filter((call) => call.type === "openUrl").length, 1);
});

test("scrollUntil can emit upward wheel input and verify the top state", async () => {
  const calls = [];
  const before = scrollObservation({ scrollTop: 600, focused: false });
  const actionable = scrollObservation({ scrollTop: 600, focused: true });
  const afterScroll = scrollObservation({ scrollTop: 0, focused: true });
  const final = scrollObservation({ scrollTop: 0, focused: true });
  const orchestrator = new CommandOrchestrator({
    bridge: fakeBridge([before, actionable, afterScroll, final], calls),
    inputDriver: fakeInputDriver(calls)
  });
  const report = await orchestrator.executeWorkflow({
    id: "scroll-up",
    label: "Scroll up",
    browserBundleIdentifier: "com.google.Chrome",
    commands: [{
      id: "scroll-to-start",
      expectedPage: "fixture",
      target: { scope: "scrollables", name: "results" },
      action: {
        type: "scrollUntil",
        direction: "up",
        deltaY: "recommended",
        maxAttempts: 2,
        until: { scope: "scrollables", name: "results", path: "canScrollUp", equals: false }
      },
      postconditions: [{ scope: "scrollables", name: "results", path: "canScrollUp", equals: false }]
    }]
  });
  assert.equal(report.ok, true);
  assert.equal(calls.find((call) => call.type === "action").action.deltaY, -500);
});

test("workflow briefly leases browser focus to wake a cold extension bridge", async () => {
  const calls = [];
  let connectionAttempt = 0;
  const bridge = fakeBridge([observation(""), observation("", true), observation("", true)], calls);
  bridge.waitForConnection = async (timeoutMs) => {
    connectionAttempt += 1;
    calls.push({ type: "connection", attempt: connectionAttempt, timeoutMs });
    if (connectionAttempt === 1) throw new Error("cold bridge");
    return { connected: true };
  };
  const inputDriver = fakeInputDriver(calls);
  inputDriver.activateBrowser = async (bundleIdentifier) => {
    calls.push({ type: "activateBrowser", bundleIdentifier });
    return { activated: true };
  };
  const orchestrator = new CommandOrchestrator({ bridge, inputDriver, initialBridgeConnectionWaitMs: 3_456 });
  const report = await orchestrator.executeWorkflow({
    id: "cold-start",
    label: "Cold start",
    browserBundleIdentifier: "com.google.Chrome",
    commands: [{
      id: "click",
      expectedPage: "fixture",
      target: { scope: "fields", name: "query" },
      action: { type: "click" }
    }]
  });
  assert.equal(report.ok, true);
  assert.equal(connectionAttempt, 2);
  assert.equal(calls.find((call) => call.type === "connection").timeoutMs, 3_456);
  assert.equal(calls.some((call) => call.type === "activateBrowser"), true);
  assert.deepEqual(calls.filter((call) => call.type === "lease").map((call) => call.event), ["begin", "end", "begin", "end"]);
});

test("web command polls a temporarily unavailable target before acquiring foreground", async () => {
  const calls = [];
  const delays = [];
  const loading = observation("");
  loading.fields.query.found = false;
  loading.fields.query.coordinateReady = false;
  loading.fields.query.screenPoint = null;
  const orchestrator = new CommandOrchestrator({
    bridge: fakeBridge([loading, observation(""), observation("", true), observation("", true)], calls),
    inputDriver: fakeInputDriver(calls),
    sleep: async (milliseconds) => delays.push(milliseconds)
  });
  const report = await orchestrator.executeWorkflow({
    id: "target-readiness",
    label: "Target readiness",
    browserBundleIdentifier: "com.google.Chrome",
    commands: [{
      id: "wait-and-click",
      expectedPage: "fixture",
      target: { scope: "fields", name: "query" },
      readinessPolicy: { pollIntervalMs: 80, timeoutMs: 500 },
      action: { type: "click" }
    }]
  });
  assert.equal(report.ok, true);
  assert.deepEqual(delays, [80]);
  assert.equal(calls.findIndex((call) => call.type === "lease"), 5);
});

function observation(value, focused = false) {
  const now = Date.now();
  return {
    page: "fixture",
    observedAt: now,
    expiresAt: now + 15_000,
    window: { focused },
    fields: {
      query: {
        found: true,
        visible: true,
        coordinateReady: true,
        screenPoint: { x: 100, y: 200 },
        read: { value }
      }
    },
    controls: {}, values: {}, collections: {}, scrollables: {}
  };
}

function collectionItem(x) {
  return {
    found: true,
    visible: true,
    enabled: true,
    occluded: false,
    coordinateReady: true,
    screenPoint: { x, y: 220 }
  };
}

function scrollObservation({ scrollTop, focused }) {
  const value = observation("", focused);
  value.scrollables.results = {
    found: true,
    visible: true,
    enabled: true,
    occluded: false,
    coordinateReady: true,
    screenPoint: { x: 400, y: 500 },
    scrollTop,
    canScrollUp: scrollTop > 1,
    canScrollDown: scrollTop < 1_000,
    recommendedDeltaY: 500
  };
  return value;
}

function fakeBridge(observations, calls) {
  return {
    async request(command, params) {
      calls.push({ type: "bridge", command, params });
      if (command === "observer.observe") return observations.shift();
      return { ok: true };
    }
  };
}

function fakeInputDriver(calls) {
  return {
    async beginForegroundLease({ bundleIdentifier }) {
      calls.push({ type: "lease", event: "begin" });
      return {
        leaseId: "lease-1",
        targetBundleIdentifier: bundleIdentifier,
        switched: true,
        previousApplication: { bundleIdentifier: "com.openai.codex" },
        after: { frontmostBundleIdentifier: bundleIdentifier }
      };
    },
    async endForegroundLease() {
      calls.push({ type: "lease", event: "end" });
      return {
        released: true,
        restored: true,
        reason: "restored",
        after: { frontmostBundleIdentifier: "com.openai.codex" }
      };
    },
    async execute(action) {
      calls.push({ type: "action", action });
      return {
        actionId: "action-1",
        action: action.type,
        requestedPoint: action.point,
        requestedDeltaY: action.deltaY ?? null,
        requestedTextLength: action.text?.length ?? null,
        helper: { command: action.type }
      };
    },
    async focusBrowserWindow(bundleIdentifier, window, title) {
      calls.push({ type: "focusWindow", bundleIdentifier, window, title });
      return { focused: true };
    },
    async openUrl(url, bundleIdentifier) {
      calls.push({ type: "openUrl", url, bundleIdentifier });
      return {
        actionId: "open-action-1",
        action: "openUrl",
        requestedPoint: null,
        requestedDeltaY: null,
        requestedTextLength: null,
        requestedUrl: url,
        helper: { command: "open-url" }
      };
    }
  };
}
