import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(projectRoot, "output", "demo");
const extensionPath = path.join(projectRoot, "dist", "demo-extension");
await mkdir(outputRoot, { recursive: true });
const fixturePort = await findAvailablePort();
const fixtureUrl = `http://127.0.0.1:${fixturePort}/`;
const runtimeAdapterPath = await writeRuntimeAdapter({ fixturePort, fixtureUrl });

const ownedProcesses = [];
const profilePath = await mkdtemp(path.join(outputRoot, "cft-acceptance-"));
try {
  const fixture = spawn("python3", [
    "-m", "http.server", String(fixturePort),
    "--bind", "127.0.0.1",
    "--directory", path.join(projectRoot, "demo", "site")
  ], { cwd: projectRoot, stdio: ["ignore", "ignore", "inherit"] });
  ownedProcesses.push(fixture);
  await waitForFixture(5_000);

  await run(process.execPath, [
    path.join(projectRoot, "scripts", "build-extension.mjs"),
    "--adapter", runtimeAdapterPath,
    "--output", extensionPath
  ]);
  await run(process.execPath, [path.join(projectRoot, "scripts", "build-mcp-server.mjs")]);
  const chromePath = await findChromeForTesting();
  await ensureNoChromeForTestingProcess();
  const acceptance = spawn(process.execPath, [path.join(projectRoot, "scripts", "run-demo-operator.mjs")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      WEB_OPERATOR_ACCEPTANCE_BRIDGE_PORT: "38494",
      WEB_OPERATOR_DEMO_URL: fixtureUrl
    },
    stdio: "inherit"
  });
  ownedProcesses.push(acceptance);
  await delay(600);

  const chrome = spawn(chromePath, [
    `--user-data-dir=${profilePath}`,
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    // Chrome for Testing ships an experimental field-trial configuration that
    // can re-enable LNA checks after --disable-features. This isolated fixture
    // has no human present to grant a loopback prompt, so suppress the testing
    // trials and all relevant Worker/WebSocket checks for this profile only.
    "--disable-field-trial-config",
    "--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets,LocalNetworkAccessForWorkers",
    "--no-first-run",
    "--new-window",
    fixtureUrl
  ], { cwd: projectRoot, stdio: ["ignore", "ignore", "inherit"] });
  ownedProcesses.push(chrome);

  const result = await waitForExit(acceptance);
  if (result.code !== 0) process.exitCode = result.code ?? 1;
} finally {
  for (const child of ownedProcesses.reverse()) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  const stopped = await Promise.all(ownedProcesses.map((child) => stopOwnedProcess(child)));
  if (stopped.every(Boolean) && profilePath.startsWith(`${outputRoot}${path.sep}`) && path.basename(profilePath).startsWith("cft-acceptance-")) {
    await rm(profilePath, { recursive: true, force: true });
  }
}

async function findChromeForTesting() {
  const configured = process.env.CHROME_FOR_TESTING_PATH;
  if (configured) {
    await access(configured);
    return configured;
  }
  const cacheRoot = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  const versions = (await readdir(cacheRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("chromium-"))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const version of versions) {
    const candidate = path.join(
      cacheRoot,
      version,
      "chrome-mac-arm64",
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing"
    );
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error("Chrome for Testing was not found. Set CHROME_FOR_TESTING_PATH to its executable.");
}

async function ensureNoChromeForTestingProcess() {
  if (process.platform !== "darwin") return;
  const result = await collectOutput("pgrep", ["-x", "Google Chrome for Testing"]);
  if (result.code === 0 && result.stdout.trim()) {
    throw new Error("Close the existing Google Chrome for Testing process before running isolated acceptance.");
  }
  if (![0, 1].includes(result.code)) throw new Error(`pgrep failed with code ${result.code}: ${result.stderr.trim()}`);
}

async function isFixtureReady() {
  try {
    const response = await fetch(fixtureUrl);
    const text = await response.text();
    return response.ok && text.includes("WEB OPERATOR KIT DEMO");
  } catch {
    return false;
  }
}

async function waitForFixture(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isFixtureReady()) return;
    await delay(100);
  }
  throw new Error(`Local acceptance fixture did not start on ${fixtureUrl}.`);
}

async function findAvailablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function writeRuntimeAdapter({ fixturePort, fixtureUrl }) {
  const runtimeRoot = path.join(outputRoot, "runtime-adapter");
  const descriptorDirectory = path.join(runtimeRoot, "descriptors");
  await mkdir(descriptorDirectory, { recursive: true });
  const sourceDescriptor = JSON.parse(await readFile(
    path.join(projectRoot, "demo", "adapter", "descriptors", "demo-page.json"),
    "utf8"
  ));
  sourceDescriptor.match.origins = [
    `http://127.0.0.1:${fixturePort}`,
    `http://localhost:${fixturePort}`
  ];
  await writeFile(
    path.join(descriptorDirectory, "demo-page.json"),
    `${JSON.stringify(sourceDescriptor, null, 2)}\n`
  );
  const adapter = {
    schemaVersion: 1,
    id: "browser-operator-kit-demo-runtime",
    displayName: "Browser Operator Kit Demo",
    version: "1.0.0",
    extension: {
      descriptors: ["descriptors/demo-page.json"],
      hostPermissions: [`http://127.0.0.1:${fixturePort}/*`],
      bridgeUrls: ["ws://127.0.0.1:38494"]
    },
    operator: {
      operationDirectories: [path.join(projectRoot, "demo", "adapter", "operations")],
      allowedOpenUrls: [fixtureUrl]
    }
  };
  const adapterPath = path.join(runtimeRoot, "automation.adapter.json");
  await writeFile(adapterPath, `${JSON.stringify(adapter, null, 2)}\n`);
  return adapterPath;
}

function run(command, args) {
  const child = spawn(command, args, { cwd: projectRoot, stdio: "inherit" });
  return waitForExit(child).then(({ code, signal }) => {
    if (code !== 0) throw new Error(signal ? `${command} terminated by ${signal}.` : `${command} exited with code ${code}.`);
  });
}

function waitForExit(child, timeoutMs = 120_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Process ${child.pid} did not exit within ${timeoutMs} ms.`)), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function stopOwnedProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  try {
    await waitForExit(child, 2_000);
    return true;
  } catch {
    child.kill("SIGKILL");
    try {
      await waitForExit(child, 2_000);
      return true;
    } catch {
      return false;
    }
  }
}

function collectOutput(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    }));
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
