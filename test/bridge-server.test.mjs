import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeServer
} from "../src/bridge-server.js";

test("bridge accepts an extension origin and routes a request", async (context) => {
  const bridge = new BridgeServer({ port: 0, requestTimeoutMs: 2_000 });
  await bridge.start();
  context.after(() => bridge.stop());

  const socket = new WebSocket(`ws://127.0.0.1:${bridge.address().port}`, {
    origin: "chrome-extension://test-extension"
  });
  context.after(() => socket.close());
  await once(socket, "open");

  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type !== "request") {
      return;
    }
    socket.send(JSON.stringify({
      type: "response",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      id: message.id,
      ok: true,
      result: { echoed: message.params.value }
    }));
  });

  assert.equal(bridge.status().connected, true);
  assert.deepEqual(await bridge.request("test.echo", { value: 42 }), { echoed: 42 });
});

test("bridge waitForConnection resolves when the extension connects", async (context) => {
  const bridge = new BridgeServer({ port: 0, requestTimeoutMs: 500 });
  await bridge.start();
  context.after(() => bridge.stop());

  const waiting = bridge.waitForConnection(1_000);
  const socket = new WebSocket(`ws://127.0.0.1:${bridge.address().port}`, {
    origin: "chrome-extension://connection-wait-test"
  });
  context.after(() => socket.close());

  const status = await waiting;
  assert.equal(status.connected, true);
  assert.equal(status.extensionOrigin, "chrome-extension://connection-wait-test");
});

test("bridge waitForConnection rejects after its bounded timeout", async (context) => {
  const bridge = new BridgeServer({ port: 0, requestTimeoutMs: 500 });
  await bridge.start();
  context.after(() => bridge.stop());

  await assert.rejects(
    bridge.waitForConnection(20),
    /did not connect/
  );
});

test("bridge rejects non-extension origins", async (context) => {
  const bridge = new BridgeServer({ port: 0, requestTimeoutMs: 500 });
  await bridge.start();
  context.after(() => bridge.stop());

  const socket = new WebSocket(`ws://127.0.0.1:${bridge.address().port}`, {
    origin: "https://example.com"
  });
  const response = await new Promise((resolve) => {
    socket.once("unexpected-response", (_request, incoming) => resolve(incoming.statusCode));
    socket.once("error", () => resolve(null));
  });
  assert.equal(response, 403);
});

test("bridge accepts Chrome 151 extension clients that omit Origin", async (context) => {
  const bridge = new BridgeServer({ port: 0, requestTimeoutMs: 500 });
  await bridge.start();
  context.after(() => bridge.stop());

  const socket = new WebSocket(`ws://127.0.0.1:${bridge.address().port}`);
  context.after(() => socket.close());
  await once(socket, "open");

  assert.equal(bridge.status().connected, true);
  assert.equal(bridge.status().extensionOrigin, "local-client-without-origin");
});

test("bridge handles a whitelisted native request from the extension", async (context) => {
  const received = [];
  const bridge = new BridgeServer({
    port: 0,
    requestTimeoutMs: 500,
    extensionRequestHandler: async (action) => {
      received.push(action);
      return { command: "move-click", steps: 31 };
    }
  });
  await bridge.start();
  context.after(() => bridge.stop());

  const socket = new WebSocket(`ws://127.0.0.1:${bridge.address().port}`, {
    origin: "chrome-extension://native-input-test"
  });
  context.after(() => socket.close());
  await once(socket, "open");

  const response = new Promise((resolve) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "native.response") {
        resolve(message);
      }
    });
  });
  socket.send(JSON.stringify({
    type: "native.request",
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    id: "native-1",
    action: { type: "moveClick", point: { x: 300, y: 400 }, seed: 42 }
  }));

  const nativeResponse = await response;
  assert.deepEqual(received, [
    { type: "moveClick", point: { x: 300, y: 400 }, seed: 42 }
  ]);
  assert.deepEqual(nativeResponse, {
    type: "native.response",
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    id: "native-1",
    ok: true,
    result: { command: "move-click", steps: 31 },
    error: null
  });
});

test("application heartbeat keeps an extension bridge alive", async (context) => {
  const bridge = new BridgeServer({ port: 0, requestTimeoutMs: 500 });
  await bridge.start();
  context.after(() => bridge.stop());

  const socket = new WebSocket(`ws://127.0.0.1:${bridge.address().port}`, {
    origin: "chrome-extension://heartbeat-test"
  });
  context.after(() => socket.close());
  await once(socket, "open");

  const heartbeat = new Promise((resolve) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== "bridge.ping") {
        return;
      }
      socket.send(JSON.stringify({
        type: "bridge.pong",
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        timestamp: message.timestamp
      }));
      resolve();
    });
  });
  bridge.runHeartbeat();
  await heartbeat;
  for (let attempt = 0; attempt < 20 && !bridge.socket.isAlive; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(bridge.socket.isAlive, true);
});

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    emitter.once(event, resolve);
    emitter.once("error", reject);
  });
}
