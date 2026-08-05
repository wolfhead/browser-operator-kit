import assert from "node:assert/strict";
import test from "node:test";
import {
  NativeInputDriver,
  normalizeNativeAction
} from "../src/native-input-driver.js";

test("native input actions are bounded and normalized", () => {
  assert.deepEqual(
    normalizeNativeAction({
      type: "scroll",
      point: { x: 100.123, y: 200.456 },
      deltaY: 640,
      seed: 42
    }),
    {
      type: "scroll",
      point: { x: 100.12, y: 200.46 },
      deltaY: 640,
      seed: 42
    }
  );
  assert.throws(
    () => normalizeNativeAction({ type: "command", point: { x: 1, y: 2 }, seed: 1 }),
    /moveClick, scroll, or typeText/
  );
  assert.throws(
    () => normalizeNativeAction({ type: "scroll", point: { x: 1, y: 2 }, deltaY: 20, seed: 1 }),
    /deltaY/
  );
  assert.equal(normalizeNativeAction({ type: "scroll", point: { x: 1, y: 2 }, deltaY: -640, seed: 1 }).deltaY, -640);
  assert.equal(
    normalizeNativeAction({
      type: "typeText",
      point: { x: 1, y: 2 },
      text: "岗位：后端工程师\n评价：建议沟通\t已复核",
      seed: 1
    }).text,
    "岗位：后端工程师\n评价：建议沟通\t已复核"
  );
  assert.throws(
    () => normalizeNativeAction({
      type: "typeText",
      point: { x: 1, y: 2 },
      text: "unsafe\u0000text",
      seed: 1
    }),
    /unsupported control characters/
  );
  assert.throws(
    () => normalizeNativeAction({
      type: "typeText",
      point: { x: 1, y: 2 },
      text: "unsafe\u001btext",
      seed: 1
    }),
    /unsupported control characters/
  );
});

test("native text input is encoded without shell interpolation", async () => {
  const calls = [];
  const controller = new NativeInputDriver({
    projectRoot: "/tmp/browser-operator-kit-native-test",
    environment: { WEB_AUTOMATION_INPUT_HELPER_PATH: "/bin/echo" },
    minimumIntervalMs: 0,
    maximumIntervalMs: 0,
    runner: async (file, argumentsList) => {
      calls.push({ file, argumentsList });
      if (argumentsList[0] === "status") {
        return { stdout: '{"frontmostBundleIdentifier":"com.google.Chrome","frontmostWindowBounds":{"x":10,"y":20,"width":1200,"height":800}}', stderr: "" };
      }
      return { stdout: '{"command":"type-text","steps":24}', stderr: "" };
    }
  });
  await controller.execute({
    type: "typeText",
    point: { x: 120, y: 240 },
    text: "Golang 广告",
    seed: 11
  });
  const inputCall = calls.find((call) => call.argumentsList[0] === "type-text");
  assert.equal(inputCall.argumentsList[0], "type-text");
  const encodedIndex = inputCall.argumentsList.indexOf("--text-base64") + 1;
  assert.equal(
    Buffer.from(inputCall.argumentsList[encodedIndex], "base64").toString("utf8"),
    "Golang 广告"
  );
});

test("native input driver invokes the helper without a shell", async () => {
  const calls = [];
  const controller = new NativeInputDriver({
    projectRoot: "/tmp/browser-operator-kit-native-test",
    environment: { WEB_AUTOMATION_INPUT_HELPER_PATH: "/bin/echo" },
    minimumIntervalMs: 0,
    maximumIntervalMs: 0,
    runner: async (file, argumentsList, options) => {
      calls.push({ file, argumentsList, options });
      if (argumentsList[0] === "status") {
        return { stdout: '{"frontmostBundleIdentifier":"com.google.Chrome","frontmostWindowBounds":{"x":10,"y":20,"width":1200,"height":800}}', stderr: "" };
      }
      return { stdout: '{"command":"scroll","steps":25}', stderr: "" };
    }
  });

  const result = await controller.execute({
    type: "scroll",
    point: { x: 300, y: 500 },
    deltaY: 720,
    seed: 9
  });
  assert.equal(result.action, "scroll");
  assert.deepEqual(result.helper, { command: "scroll", steps: 25 });
  assert.equal(result.before.frontmostBundleIdentifier, "com.google.Chrome");
  assert.equal(result.after.frontmostBundleIdentifier, "com.google.Chrome");
  const inputCall = calls.find((call) => call.argumentsList[0] === "scroll");
  assert.equal(inputCall.file, "/bin/echo");
  assert.deepEqual(inputCall.argumentsList, [
    "scroll",
    "--x", "300",
    "--y", "500",
    "--seed", "9",
    "--delta-y", "720",
    "--execute"
  ]);
  assert.equal(inputCall.options.windowsHide, true);
});

test("service transport never spawns the helper subprocess", async () => {
  const calls = [];
  const serviceClient = {
    invoke: async (argumentsList) => {
      calls.push(argumentsList);
      if (argumentsList[0] === "status") {
        return {
          stdout: JSON.stringify({
            accessibilityPostEventAccess: true,
            frontmostBundleIdentifier: "com.google.Chrome"
          }),
          stderr: ""
        };
      }
      return { stdout: JSON.stringify({ command: argumentsList[0], steps: 24 }), stderr: "" };
    }
  };
  const controller = new NativeInputDriver({
    projectRoot: "/tmp/browser-operator-kit-native-test",
    environment: { WEB_AUTOMATION_INPUT_TRANSPORT: "service" },
    serviceClient,
    minimumIntervalMs: 0,
    maximumIntervalMs: 0,
    runner: async () => assert.fail("service transport must not spawn a subprocess")
  });

  const result = await controller.execute({
    type: "scroll",
    point: { x: 300, y: 500 },
    deltaY: 720,
    seed: 9
  });

  assert.equal(result.action, "scroll");
  assert.equal(result.before.transport, "service");
  assert.deepEqual(calls.map((argumentsList) => argumentsList[0]), ["status", "scroll", "status"]);
});

test("browser bootstrap uses explicit bundle identifiers and encoded URLs", async () => {
  const calls = [];
  const controller = new NativeInputDriver({
    projectRoot: "/tmp/browser-operator-kit-native-test",
    environment: { WEB_AUTOMATION_INPUT_HELPER_PATH: "/bin/echo" },
    runner: async (file, argumentsList, options) => {
      calls.push({ file, argumentsList, options });
      return {
        stdout: JSON.stringify({
          command: argumentsList[0],
          bundleIdentifier: "com.google.Chrome",
          activated: true,
          openedUrl: argumentsList[0] === "open-url"
        }),
        stderr: ""
      };
    }
  });

  await controller.activateChrome();
  await controller.openUrl("https://example.test/start", "com.google.Chrome");
  const activationCall = calls.find((call) => call.argumentsList[0] === "activate-browser");
  const openCall = calls.find((call) => call.argumentsList[0] === "open-url");
  assert.deepEqual(activationCall.argumentsList, ["activate-browser", "--bundle-id", "com.google.Chrome"]);
  assert.deepEqual(openCall.argumentsList.slice(0, 4), [
    "open-url", "--bundle-id", "com.google.Chrome", "--url-base64"
  ]);
  assert.equal(Buffer.from(openCall.argumentsList[4], "base64").toString("utf8"), "https://example.test/start");
  assert.ok(calls.every((call) => call.options.windowsHide === true));
});

test("browser window focus passes only normalized observed bounds to the helper", async () => {
  const calls = [];
  const controller = new NativeInputDriver({
    projectRoot: "/tmp/browser-operator-kit-native-test",
    environment: { WEB_AUTOMATION_INPUT_HELPER_PATH: "/bin/echo" },
    runner: async (file, argumentsList, options) => {
      calls.push({ file, argumentsList, options });
      return {
        stdout: JSON.stringify({ command: argumentsList[0], focused: true }),
        stderr: ""
      };
    }
  });

  const result = await controller.focusBrowserWindow(
    "com.google.Chrome",
    { left: 10.123, top: 20.456, width: 1200, height: 800 },
    "Customer Portal"
  );

  assert.equal(result.focused, true);
  assert.deepEqual(calls[0].argumentsList, [
    "activate-browser-window",
    "--bundle-id", "com.google.Chrome",
    "--x", "10.12",
    "--y", "20.46",
    "--width", "1200",
    "--height", "800",
    "--title-base64", Buffer.from("Customer Portal", "utf8").toString("base64")
  ]);
  assert.equal(calls[0].options.windowsHide, true);
});

test("foreground lease does not steal focus back after human takeover", async () => {
  const controller = new NativeInputDriver({ projectRoot: "/tmp/browser-operator-kit-native-test" });
  controller.foregroundLeases.set("lease-1", {
    leaseId: "lease-1",
    switched: true,
    targetBundleIdentifier: "com.google.Chrome",
    previousApplication: { processIdentifier: 101, bundleIdentifier: "com.openai.codex" }
  });
  controller.status = async () => ({ frontmostBundleIdentifier: "com.apple.TextEdit" });
  controller.restoreApplication = async () => assert.fail("restore must not run after human takeover");

  const result = await controller.endForegroundLease("lease-1");
  assert.equal(result.restored, false);
  assert.equal(result.reason, "human_takeover");
  assert.equal(result.current.frontmostBundleIdentifier, "com.apple.TextEdit");
});

test("foreground lease restores the previously frontmost process", async () => {
  const controller = new NativeInputDriver({ projectRoot: "/tmp/browser-operator-kit-native-test" });
  controller.foregroundLeases.set("lease-1", {
    leaseId: "lease-1",
    switched: true,
    targetBundleIdentifier: "com.google.Chrome",
    previousApplication: { processIdentifier: 101, bundleIdentifier: "com.openai.codex" }
  });
  const statuses = [
    { frontmostBundleIdentifier: "com.google.Chrome" },
    { frontmostBundleIdentifier: "com.openai.codex" }
  ];
  controller.status = async () => statuses.shift();
  let restoredProcessIdentifier = null;
  controller.restoreApplication = async (processIdentifier) => {
    restoredProcessIdentifier = processIdentifier;
    return { activated: true };
  };

  const result = await controller.endForegroundLease("lease-1");
  assert.equal(restoredProcessIdentifier, 101);
  assert.equal(result.restored, true);
  assert.equal(result.reason, "restored");
});

test("foreground policy can forbid activating a background browser", async () => {
  const controller = new NativeInputDriver({ projectRoot: "/tmp/browser-operator-kit-native-test" });
  controller.status = async () => ({
    available: true,
    accessibilityPostEventAccess: true,
    frontmostBundleIdentifier: "com.openai.codex"
  });
  controller.activateBrowser = async () => assert.fail("activation must be forbidden by policy");
  await assert.rejects(
    () => controller.beginForegroundLease({ bundleIdentifier: "com.google.Chrome", activateIfNeeded: false }),
    /requires 'com.google.Chrome' to already be frontmost/
  );
});
