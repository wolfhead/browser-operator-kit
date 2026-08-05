import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NativeInputServiceClient } from "../src/native-input-service-client.js";

test("native input service client exchanges one bounded JSON request", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "browser-operator-kit-service-"));
  const socketPath = path.join(directory, "input.sock");
  const requests = [];
  const server = net.createServer((socket) => {
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffered += chunk;
      const newlineIndex = buffered.indexOf("\n");
      if (newlineIndex < 0) return;
      const request = JSON.parse(buffered.slice(0, newlineIndex));
      requests.push(request);
      socket.end(`${JSON.stringify({
        version: 1,
        id: request.id,
        ok: true,
        output: JSON.stringify({ accessibilityPostEventAccess: true })
      })}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const client = new NativeInputServiceClient({ socketPath, requestTimeoutMs: 1_000 });
  const response = await client.invoke(["status"]);

  assert.deepEqual(JSON.parse(response.stdout), { accessibilityPostEventAccess: true });
  assert.equal(response.stderr, "");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].version, 1);
  assert.deepEqual(requests[0].arguments, ["status"]);
  assert.match(requests[0].id, /^[0-9a-f-]{36}$/);
});

test("native input service client rejects a mismatched response id", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "browser-operator-kit-service-"));
  const socketPath = path.join(directory, "input.sock");
  const server = net.createServer((socket) => {
    socket.once("data", () => socket.end(`${JSON.stringify({
      version: 1,
      id: "00000000-0000-0000-0000-000000000000",
      ok: true,
      output: "{}"
    })}\n`));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const client = new NativeInputServiceClient({ socketPath, requestTimeoutMs: 1_000 });
  await assert.rejects(() => client.invoke(["status"]), /response id did not match/);
});

test("native input service client enforces argument and response bounds", async () => {
  const client = new NativeInputServiceClient({ socketPath: "/tmp/unused.sock" });
  await assert.rejects(
    () => client.invoke(["type-text", "x".repeat(70_000)]),
    /request exceeds/
  );
  await assert.rejects(
    () => client.invoke(["status\u0000"]),
    /NUL/
  );
});
