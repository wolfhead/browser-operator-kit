const elements = {
  banner: document.querySelector("#automation-banner"),
  status: document.querySelector("#automation-status"),
  time: document.querySelector("#automation-time"),
  step: document.querySelector("#automation-step"),
  age: document.querySelector("#observation-age"),
  page: document.querySelector("#page-state"),
  descriptors: document.querySelector("#descriptor-state"),
  window: document.querySelector("#window-state"),
  viewport: document.querySelector("#viewport-state"),
  url: document.querySelector("#page-url"),
  targetCount: document.querySelector("#target-count"),
  targets: document.querySelector("#target-list"),
  logs: document.querySelector("#log-list"),
  bridge: document.querySelector("#bridge-state")
};
let dashboard = null;
const BRIDGE_URLS = ["ws://127.0.0.1:38492", "ws://127.0.0.1:38493"];

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "dashboard.changed") render(message.dashboard);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.webEyeDashboard?.newValue) render(changes.webEyeDashboard.newValue);
});

void initialize();
setInterval(() => dashboard && renderTime(dashboard), 1_000);

async function initialize() {
  await probeLoopbackAccess();
  await chrome.runtime.sendMessage({ type: "bridge.retry" }).catch(() => {});
  const current = await chrome.runtime.sendMessage({ type: "dashboard.get" });
  if (current?.ok) render(current.dashboard);
  const observed = await chrome.runtime.sendMessage({ type: "eye.observe" });
  if (!observed?.ok) {
    elements.url.textContent = observed?.error || "当前页面暂时无法观察。";
  }
}

async function probeLoopbackAccess() {
  const results = await Promise.all(BRIDGE_URLS.map((url) => probeBridge(url)));
  if (results.some((result) => result === "open")) {
    elements.bridge.textContent = "本地桥已授权并已连接；状态板可以接收自动化进度。";
    return;
  }
  if (results.some((result) => result === "timeout")) {
    elements.bridge.textContent = "正在等待 Chrome 的本地网络授权；请允许此扩展连接本机服务。";
    return;
  }
  elements.bridge.textContent = "本地网络访问已就绪；Eye / Operator 服务启动后会自动重连。";
}

function probeBridge(url) {
  return new Promise((resolve) => {
    let settled = false;
    let socket = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.close(); } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish("timeout"), 4_000);
    try {
      socket = new WebSocket(url);
      socket.addEventListener("open", () => finish("open"), { once: true });
      socket.addEventListener("error", () => finish("error"), { once: true });
    } catch {
      finish("error");
    }
  });
}

function render(next) {
  dashboard = next;
  renderRun(next.run || {});
  renderObservation(next.latestObservation);
  renderLogs(next.logs || []);
}

function renderRun(run) {
  const status = ["idle", "running", "waiting", "completed", "failed", "cancelled"].includes(run.status)
    ? run.status : "idle";
  elements.banner.className = `automation-banner status-${status}`;
  elements.status.textContent = {
    idle: "尚未开始",
    running: "自动化运行中 · 请勿操作 Chrome",
    waiting: "等待人工处理",
    completed: "自动化已结束 · 成功",
    failed: "自动化已结束 · 失败",
    cancelled: "自动化已结束 · 已取消"
  }[status];
  elements.step.textContent = [run.step, run.message].filter(Boolean).join("：");
  renderTime({ run });
}

function renderTime(state) {
  const run = state.run || {};
  const startedAt = Number(run.startedAt);
  if (!startedAt) {
    elements.time.textContent = "未运行";
    return;
  }
  const end = Number(run.finishedAt) || Date.now();
  const seconds = Math.floor(Math.max(end - startedAt, 0) / 1_000);
  elements.time.textContent = `${["running", "waiting"].includes(run.status) ? "已运行" : "耗时"} ${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const observedAt = Number(state.latestObservation?.observedAt || dashboard?.latestObservation?.observedAt);
  if (observedAt) elements.age.textContent = `${Math.max(Math.floor((Date.now() - observedAt) / 1_000), 0)} 秒前`;
}

function renderObservation(observation) {
  if (!observation) return;
  elements.page.textContent = observation.page || "unknown";
  elements.descriptors.textContent = observation.descriptorIds?.join(", ") || "未注册";
  elements.window.textContent = observation.window
    ? `${observation.window.width}×${observation.window.height} @ ${observation.window.left},${observation.window.top}${observation.window.focused ? " · 前台" : " · 后台"}`
    : "—";
  elements.viewport.textContent = observation.viewport
    ? `${observation.viewport.width}×${observation.viewport.height} · zoom ${observation.window?.zoomFactor ?? 1}`
    : "—";
  elements.url.textContent = observation.tab?.url || "—";
  const groups = [
    ["字段", observation.fields],
    ["控件", observation.controls],
    ["值", observation.values],
    ["集合", observation.collections],
    ["滚动", observation.scrollables]
  ];
  const targets = groups.flatMap(([group, values]) => Object.entries(values || {}).map(([name, value]) => ({ group, name, value })));
  elements.targetCount.textContent = String(targets.length);
  elements.targets.replaceChildren();
  if (targets.length === 0) {
    const empty = document.createElement("li");
    empty.className = "log-empty";
    empty.textContent = "当前没有目标信息。";
    elements.targets.append(empty);
    return;
  }
  for (const target of targets) {
    const item = document.createElement("li");
    item.className = "log-item";
    const label = document.createElement("span");
    label.className = "log-time";
    label.textContent = target.group;
    const detail = document.createElement("span");
    detail.className = "log-message";
    detail.textContent = describeTarget(target.name, target.value);
    item.append(label, detail);
    elements.targets.append(item);
  }
}

function describeTarget(name, value) {
  if (!value.found) return `${name} · 未找到`;
  if (Number.isFinite(value.count) && Array.isArray(value.items)) {
    return `${name} · ${value.count} 项 · ${value.items.filter((item) => item.visible).length} 项当前可见`;
  }
  if (Number.isFinite(value.remaining)) {
    const state = value.footerConfigured
      ? (value.footerVisible ? "footer 可见" : "footer 不可见")
      : (value.canScrollDown ? "可继续滚动" : "已到底");
    return `${name} · 剩余 ${Math.round(value.remaining)}px · ${state}`;
  }
  const read = value.read || {};
  const content = read.value ?? read.text ?? "";
  return `${name} · ${value.visible ? "可见" : "不可见"}${content ? ` · ${String(content).slice(0, 80)}` : ""}`;
}

function renderLogs(logs) {
  elements.logs.replaceChildren();
  if (logs.length === 0) {
    const empty = document.createElement("li");
    empty.className = "log-empty";
    empty.textContent = "尚无运行记录。";
    elements.logs.append(empty);
    return;
  }
  for (const entry of logs.slice(0, 20)) {
    const item = document.createElement("li");
    item.className = `log-item ${entry.level || "info"}`;
    const time = document.createElement("time");
    time.className = "log-time";
    time.textContent = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(entry.timestamp));
    const message = document.createElement("span");
    message.className = "log-message";
    message.textContent = entry.message;
    item.append(time, message);
    elements.logs.append(item);
  }
}
