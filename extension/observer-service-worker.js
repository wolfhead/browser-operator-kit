import { PageObserver } from "./observer/engine.js";

const BRIDGE_URLS = [
  "ws://127.0.0.1:38492",
  "ws://127.0.0.1:38493"
];
const BRIDGE_PROTOCOL_VERSION = 1;
const DASHBOARD_STORAGE_KEY = "pageObserverDashboard";
const MAX_LOGS = 100;
const BRIDGE_WAKE_ALARM = "page-observer-bridge-wake";
const observer = new PageObserver();
const bridgeConnections = new Map();

chrome.runtime.onInstalled.addListener(() => {
  void configureSidePanel();
  void configureBridgeWakeAlarm();
  ensureBridgeConnections();
});
chrome.runtime.onStartup.addListener(() => {
  void configureSidePanel();
  void configureBridgeWakeAlarm();
  ensureBridgeConnections();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BRIDGE_WAKE_ALARM) ensureBridgeConnections();
});
chrome.windows.onFocusChanged.addListener(() => ensureBridgeConnections());
chrome.tabs.onActivated.addListener(() => ensureBridgeConnections());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status || changeInfo.url) ensureBridgeConnections();
});
chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId) void chrome.sidePanel.open({ windowId: tab.windowId });
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handleCommand(message?.type, message ?? {})
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

void configureSidePanel();
void configureBridgeWakeAlarm();
ensureBridgeConnections();

async function configureSidePanel() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

async function configureBridgeWakeAlarm() {
  await chrome.alarms.create(BRIDGE_WAKE_ALARM, { periodInMinutes: 1 });
}

async function handleCommand(command, params) {
  switch (command) {
    case "observer.status":
      return await getStatus();
    case "observer.observe":
      return await observeAndPublish();
    case "observer.permissions.refresh":
      await notifyAdapterChanged();
      return await getStatus();
    case "observer.inspect.snapshot":
      return await observer.inspectSnapshot(params);
    case "observer.inspect.query":
      return await observer.inspectQuery(params);
    case "observer.inspect.evaluate":
      return await observer.inspectEvaluate(params);
    case "observer.reload":
      setTimeout(() => chrome.runtime.reload(), 100);
      return { ok: true, scheduled: true };
    case "bridge.retry":
      ensureBridgeConnections();
      return { ok: true };
    case "dashboard.get":
      return await getDashboard();
    case "dashboard.begin":
      return await updateRun("running", params.label, params.message || "自动化已开始，请勿操作 Chrome。", true);
    case "dashboard.update":
      return await updateRun(params.status, params.step, params.message, false);
    case "dashboard.end":
      return await endRun(params.status, params.message);
    case "dashboard.action":
      return await reportAction(params);
    case "dashboard.log":
      return await appendLog(params.message, params.level);
    default:
      throw new Error(`Unsupported Page Observer command: ${String(command)}`);
  }
}

async function observeAndPublish() {
  const observation = await observer.observeActiveTab();
  const dashboard = await readDashboard();
  dashboard.latestObservation = observation;
  dashboard.updatedAt = Date.now();
  await writeDashboard(dashboard);
  return observation;
}

async function getStatus() {
  const [tab, descriptors, adapters] = await Promise.all([
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs) => tabs[0]),
    observer.loadDescriptors(),
    observer.adapterStatuses()
  ]);
  return {
    ok: true,
    bridges: BRIDGE_URLS.map((url) => ({
      url,
      connected: bridgeConnections.get(url)?.socket?.readyState === WebSocket.OPEN
    })),
    activeTab: tab ? { id: tab.id, windowId: tab.windowId, title: tab.title ?? "", url: tab.url ?? "" } : null,
    descriptorCount: descriptors.length,
    adapters,
    role: "descriptor-observer-dashboard-and-explicit-inspector"
  };
}

async function getDashboard() {
  return { ok: true, dashboard: await readDashboard() };
}

async function updateRun(status, step, message, begin) {
  const dashboard = await readDashboard();
  const now = Date.now();
  dashboard.run = {
    runId: begin ? crypto.randomUUID() : (dashboard.run.runId || crypto.randomUUID()),
    status: ["running", "waiting"].includes(status) ? status : "running",
    step: String(step || (begin ? "准备" : "处理中")).slice(0, 120),
    message: String(message || "").slice(0, 300),
    startedAt: begin ? now : (dashboard.run.startedAt || now),
    updatedAt: now,
    finishedAt: null
  };
  await appendLogToDashboard(dashboard, `${dashboard.run.step}：${dashboard.run.message}`, "info");
  await writeDashboard(dashboard);
  return { ok: true, run: dashboard.run };
}

async function endRun(status, message) {
  const dashboard = await readDashboard();
  const now = Date.now();
  dashboard.run = {
    ...dashboard.run,
    status: ["completed", "failed", "cancelled"].includes(status) ? status : "completed",
    step: status === "completed" ? "全部完成" : "任务结束",
    message: String(message || "").slice(0, 300),
    updatedAt: now,
    finishedAt: now
  };
  await appendLogToDashboard(dashboard, dashboard.run.message || dashboard.run.step, status === "completed" ? "success" : "error");
  await writeDashboard(dashboard);
  return { ok: true, run: dashboard.run };
}

async function reportAction(params) {
  const dashboard = await readDashboard();
  dashboard.latestAction = {
    actionId: String(params.actionId || ""),
    action: String(params.action || "unknown"),
    status: String(params.status || "reported"),
    message: String(params.message || "").slice(0, 300),
    timestamp: Date.now()
  };
  await appendLogToDashboard(
    dashboard,
    `${dashboard.latestAction.action}：${dashboard.latestAction.message || dashboard.latestAction.status}`,
    dashboard.latestAction.status === "failed" ? "error" : "info"
  );
  await writeDashboard(dashboard);
  return { ok: true, action: dashboard.latestAction };
}

async function appendLog(message, level = "info") {
  const dashboard = await readDashboard();
  await appendLogToDashboard(dashboard, message, level);
  await writeDashboard(dashboard);
  return { ok: true };
}

async function appendLogToDashboard(dashboard, message, level) {
  dashboard.logs.unshift({
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    level: ["debug", "info", "success", "warn", "error"].includes(level) ? level : "info",
    message: String(message || "").slice(0, 500)
  });
  dashboard.logs = dashboard.logs.slice(0, MAX_LOGS);
}

async function readDashboard() {
  const stored = await chrome.storage.session.get(DASHBOARD_STORAGE_KEY);
  return stored[DASHBOARD_STORAGE_KEY] ?? {
    run: { runId: null, status: "idle", step: "尚未开始", message: "当前没有自动化任务。", startedAt: null, updatedAt: null, finishedAt: null },
    latestObservation: null,
    latestAction: null,
    logs: [],
    updatedAt: Date.now()
  };
}

async function writeDashboard(dashboard) {
  dashboard.updatedAt = Date.now();
  await chrome.storage.session.set({ [DASHBOARD_STORAGE_KEY]: dashboard });
  await chrome.runtime.sendMessage({ type: "dashboard.changed", dashboard }).catch(() => {});
}

function ensureBridgeConnections() {
  for (const url of BRIDGE_URLS) connectBridge(url);
}

function connectBridge(url) {
  const existing = bridgeConnections.get(url) ?? { socket: null, timer: null, delayMs: 1_000 };
  if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(existing.socket?.readyState)) return;
  if (existing.timer) clearTimeout(existing.timer);
  let socket;
  try {
    console.debug(JSON.stringify({ level: "debug", event: "bridge_connecting", url }));
    socket = new WebSocket(url);
  } catch (error) {
    console.warn(JSON.stringify({
      level: "warn",
      event: "bridge_connect_failed",
      url,
      message: error instanceof Error ? error.message : String(error)
    }));
    existing.socket = null;
    existing.timer = setTimeout(() => connectBridge(url), existing.delayMs);
    existing.delayMs = Math.min(existing.delayMs * 2, 10_000);
    bridgeConnections.set(url, existing);
    return;
  }
  existing.socket = socket;
  existing.timer = null;
  bridgeConnections.set(url, existing);
  socket.addEventListener("open", () => {
    existing.delayMs = 1_000;
    console.debug(JSON.stringify({ level: "debug", event: "bridge_connected", url }));
  });
  socket.addEventListener("message", (event) => { void handleBridgeMessage(url, socket, event.data); });
  socket.addEventListener("close", (event) => {
    console.debug(JSON.stringify({
      level: "debug",
      event: "bridge_disconnected",
      url,
      code: event.code,
      reason: event.reason || ""
    }));
    if (existing.socket === socket) existing.socket = null;
    observer.unregisterAdapter(url);
    void notifyAdapterChanged();
    existing.timer = setTimeout(() => connectBridge(url), existing.delayMs);
    existing.delayMs = Math.min(existing.delayMs * 2, 10_000);
  });
  socket.addEventListener("error", () => {
    console.warn(JSON.stringify({ level: "warn", event: "bridge_socket_error", url }));
    socket.close();
  });
}

async function handleBridgeMessage(url, socket, raw) {
  let message;
  try { message = JSON.parse(String(raw)); } catch { return; }
  if (message?.type === "bridge.hello") {
    try {
      const adapterStatus = message.adapter
        ? await observer.registerAdapter(url, message.adapter)
        : null;
      if (!message.adapter) observer.unregisterAdapter(url);
      socket.send(JSON.stringify({
        type: "bridge.ready",
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        ok: true,
        adapterStatus
      }));
      await notifyAdapterChanged();
    } catch (error) {
      socket.send(JSON.stringify({
        type: "bridge.ready",
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }));
    }
    return;
  }
  if (message?.type === "bridge.ping") {
    socket.send(JSON.stringify({ type: "bridge.pong", protocolVersion: BRIDGE_PROTOCOL_VERSION, timestamp: message.timestamp }));
    return;
  }
  if (message?.type !== "request" || message.protocolVersion !== BRIDGE_PROTOCOL_VERSION || typeof message.id !== "string") return;
  try {
    const result = await handleCommand(message.command, message.params ?? {});
    socket.send(JSON.stringify({ type: "response", protocolVersion: BRIDGE_PROTOCOL_VERSION, id: message.id, ok: true, result }));
  } catch (error) {
    socket.send(JSON.stringify({
      type: "response",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }));
  }
}

async function notifyAdapterChanged() {
  const status = await getStatus();
  await chrome.runtime.sendMessage({ type: "observer.adapters.changed", status }).catch(() => {});
}
