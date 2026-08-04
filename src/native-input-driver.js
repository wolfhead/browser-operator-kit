import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ALLOWED_ACTION_TYPES = new Set(["moveClick", "scroll", "typeText"]);

export class NativeInputDriver {
  constructor({
    projectRoot,
    platform = process.platform,
    environment = process.env,
    runner = execFileAsync,
    logger = () => {},
    minimumIntervalMs = 1_000,
    maximumIntervalMs = 1_600,
    random = Math.random
  } = {}) {
    if (!projectRoot) {
      throw new Error("projectRoot is required for native input.");
    }
    this.projectRoot = projectRoot;
    this.platform = platform;
    this.environment = environment;
    this.runner = runner;
    this.logger = logger;
    this.minimumIntervalMs = minimumIntervalMs;
    this.maximumIntervalMs = Math.max(maximumIntervalMs, minimumIntervalMs);
    this.random = random;
    this.lastExecutionAt = 0;
    this.executionQueue = Promise.resolve();
    this.foregroundLeases = new Map();
  }

  helperPath() {
    if (this.environment.WEB_AUTOMATION_INPUT_HELPER_PATH) {
      return path.resolve(this.environment.WEB_AUTOMATION_INPUT_HELPER_PATH);
    }
    if (this.platform === "darwin") {
      return path.join(
        this.projectRoot,
        "native-helper",
        "macos",
        ".build",
        "web-input-helper"
      );
    }
    throw new Error(
      `Native input is not bundled for platform '${this.platform}'. Set WEB_AUTOMATION_INPUT_HELPER_PATH to a compatible helper.`
    );
  }

  async status() {
    let helperPath;
    try {
      helperPath = this.helperPath();
      await access(helperPath, constants.X_OK);
      const { stdout } = await this.runner(helperPath, ["status"], {
        timeout: 5_000,
        maxBuffer: 256_000,
        windowsHide: true
      });
      return {
        available: true,
        platform: this.platform,
        helperPath,
        ...JSON.parse(String(stdout).trim())
      };
    } catch (error) {
      return {
        available: false,
        platform: this.platform,
        helperPath: helperPath ?? null,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async activateChrome() {
    return await this.activateBrowser("com.google.Chrome");
  }

  async openUrl(url, bundleIdentifier = "com.google.Chrome") {
    const normalizedUrl = normalizeOpenUrl(url);
    const normalizedBundleIdentifier = normalizeBundleIdentifier(bundleIdentifier);
    const startedAt = new Date().toISOString();
    const before = await this.status();
    const helperPath = this.helperPath();
    await access(helperPath, constants.X_OK);
    const { stdout } = await this.runner(helperPath, [
      "open-url",
      "--bundle-id",
      normalizedBundleIdentifier,
      "--url-base64",
      Buffer.from(normalizedUrl, "utf8").toString("base64")
    ], { timeout: 20_000, maxBuffer: 256_000, windowsHide: true });
    const helper = JSON.parse(String(stdout).trim());
    const after = await this.status();
    return {
      actionId: randomUUID(),
      action: "openUrl",
      requestedPoint: null,
      requestedDeltaY: null,
      requestedTextLength: null,
      requestedUrl: normalizedUrl,
      startedAt,
      before,
      helper,
      after
    };
  }

  async activateBrowser(bundleIdentifier) {
    const helperPath = this.helperPath();
    await access(helperPath, constants.X_OK);
    const normalizedBundleIdentifier = normalizeBundleIdentifier(bundleIdentifier);
    const { stdout } = await this.runner(
      helperPath,
      ["activate-browser", "--bundle-id", normalizedBundleIdentifier],
      { timeout: 20_000, maxBuffer: 256_000, windowsHide: true }
    );
    return JSON.parse(String(stdout).trim());
  }

  async restoreApplication(processIdentifier) {
    const helperPath = this.helperPath();
    await access(helperPath, constants.X_OK);
    const parsedProcessIdentifier = Number(processIdentifier);
    if (!Number.isSafeInteger(parsedProcessIdentifier) || parsedProcessIdentifier <= 0) {
      throw new Error("processIdentifier must be a positive integer.");
    }
    const { stdout } = await this.runner(
      helperPath,
      ["restore-application", "--process-id", String(parsedProcessIdentifier)],
      { timeout: 10_000, maxBuffer: 256_000, windowsHide: true }
    );
    return JSON.parse(String(stdout).trim());
  }

  async beginForegroundLease({ bundleIdentifier, activateIfNeeded = true }) {
    const before = await this.status();
    if (!before.available || before.accessibilityPostEventAccess !== true) {
      throw new Error("Native Input Driver cannot acquire a foreground lease without Accessibility access.");
    }
    const targetBundleIdentifier = String(bundleIdentifier ?? "").trim();
    const alreadyFrontmost = before.frontmostBundleIdentifier === targetBundleIdentifier;
    if (!alreadyFrontmost && !activateIfNeeded) {
      throw new Error(`Foreground policy requires '${targetBundleIdentifier}' to already be frontmost.`);
    }
    const activation = alreadyFrontmost
      ? null
      : await this.activateBrowser(targetBundleIdentifier);
    const after = await this.status();
    if (after.frontmostBundleIdentifier !== targetBundleIdentifier) {
      throw new Error(`Foreground lease activation failed for '${targetBundleIdentifier}'.`);
    }
    const lease = {
      leaseId: randomUUID(),
      targetBundleIdentifier,
      acquiredAt: new Date().toISOString(),
      switched: !alreadyFrontmost,
      previousApplication: alreadyFrontmost ? null : {
        bundleIdentifier: before.frontmostBundleIdentifier,
        processIdentifier: before.frontmostProcessIdentifier ?? null
      },
      before,
      activation,
      after
    };
    this.foregroundLeases.set(lease.leaseId, lease);
    this.logger("info", "foreground_lease_acquired", {
      leaseId: lease.leaseId,
      targetBundleIdentifier,
      switched: lease.switched,
      previousBundleIdentifier: lease.previousApplication?.bundleIdentifier ?? null
    });
    return lease;
  }

  async endForegroundLease(leaseId) {
    const lease = this.foregroundLeases.get(leaseId);
    if (!lease) throw new Error("Foreground lease is unknown or already released.");
    this.foregroundLeases.delete(leaseId);
    const current = await this.status();
    if (!lease.switched || !lease.previousApplication?.processIdentifier) {
      return { leaseId, released: true, restored: false, reason: "no_switch_required", current };
    }
    if (current.frontmostBundleIdentifier !== lease.targetBundleIdentifier) {
      this.logger("warn", "foreground_lease_human_takeover", {
        leaseId,
        expectedBundleIdentifier: lease.targetBundleIdentifier,
        actualBundleIdentifier: current.frontmostBundleIdentifier
      });
      return { leaseId, released: true, restored: false, reason: "human_takeover", current };
    }
    try {
      const restoration = await this.restoreApplication(lease.previousApplication.processIdentifier);
      const after = await this.status();
      return { leaseId, released: true, restored: true, reason: "restored", restoration, after };
    } catch (error) {
      this.logger("warn", "foreground_lease_restore_failed", {
        leaseId,
        message: error instanceof Error ? error.message : String(error)
      });
      return {
        leaseId,
        released: true,
        restored: false,
        reason: "restore_failed",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  execute(action) {
    const normalized = normalizeNativeAction(action);
    const scheduled = this.executionQueue.then(async () => {
      await this.waitForInteractionSlot();
      return await this.executeNow(normalized);
    });
    this.executionQueue = scheduled.catch(() => {});
    return scheduled;
  }

  async waitForInteractionSlot() {
    const intervalRange = this.maximumIntervalMs - this.minimumIntervalMs;
    const requiredInterval = this.minimumIntervalMs + Math.round(this.random() * intervalRange);
    const remaining = requiredInterval - (Date.now() - this.lastExecutionAt);
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
    this.lastExecutionAt = Date.now();
  }

  async executeNow(action) {
    const helperPath = this.helperPath();
    await access(helperPath, constants.X_OK);
    const argumentsList = [
      action.type === "moveClick"
        ? "move-click"
        : action.type === "scroll"
        ? "scroll"
        : "type-text",
      "--x",
      String(action.point.x),
      "--y",
      String(action.point.y),
      "--seed",
      String(action.seed)
    ];
    if (action.type === "scroll") {
      argumentsList.push("--delta-y", String(action.deltaY));
    }
    if (action.type === "typeText") {
      argumentsList.push(
        "--text-base64",
        Buffer.from(action.text, "utf8").toString("base64")
      );
    }
    argumentsList.push("--execute");

    const before = await this.status();
    this.logger("info", "native_input_started", {
      action: action.type,
      seed: action.seed
    });
    try {
      const { stdout, stderr } = await this.runner(helperPath, argumentsList, {
        timeout: 15_000,
        maxBuffer: 256_000,
        windowsHide: true
      });
      const result = JSON.parse(String(stdout).trim());
      this.logger("info", "native_input_completed", {
        action: action.type,
        seed: action.seed,
        steps: result.steps ?? null,
        arrived: result.arrived ?? null,
        finalDistancePx: result.finalDistancePx ?? null,
        replanAttempts: result.replanAttempts ?? null,
        clickEmitted: result.clickEmitted ?? null
      });
      const after = await this.status();
      return {
        actionId: randomUUID(),
        action: action.type,
        requestedPoint: action.point,
        requestedDeltaY: action.deltaY ?? null,
        requestedTextLength: action.text?.length ?? null,
        startedAt: new Date().toISOString(),
        before,
        helper: result,
        after
      };
    } catch (error) {
      const stderr = String(error?.stderr ?? "").trim();
      const message = stderr || (error instanceof Error ? error.message : String(error));
      this.logger("error", "native_input_failed", {
        action: action.type,
        seed: action.seed,
        message
      });
      throw new Error(message);
    }
  }
}

function normalizeBundleIdentifier(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 120 || !/^[A-Za-z0-9.-]+$/.test(normalized)) {
    throw new Error("bundleIdentifier must contain 1 to 120 bundle identifier characters.");
  }
  return normalized;
}

function normalizeOpenUrl(value) {
  const url = new URL(String(value || ""));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("openUrl accepts only HTTP(S) URLs without credentials.");
  }
  url.hash = "";
  return url.href;
}

export function normalizeNativeAction(action) {
  if (!action || typeof action !== "object" || !ALLOWED_ACTION_TYPES.has(action.type)) {
    throw new Error("Native input action must be moveClick, scroll, or typeText.");
  }
  const x = boundedNumber(action.point?.x, "point.x", -20_000, 20_000);
  const y = boundedNumber(action.point?.y, "point.y", -20_000, 20_000);
  const seed = boundedInteger(
    action.seed ?? Date.now(),
    "seed",
    0,
    Number.MAX_SAFE_INTEGER
  );
  if (action.type === "moveClick") {
    return { type: action.type, point: { x, y }, seed };
  }
  if (action.type === "typeText") {
    const text = String(action.text ?? "");
    if (!text || text.length > 240 || /[\u0000-\u001f\u007f]/.test(text)) {
      throw new Error("text must contain 1 to 240 printable characters.");
    }
    return { type: action.type, point: { x, y }, text, seed };
  }
  const deltaY = boundedSignedInteger(action.deltaY, "deltaY", 80, 2_400);
  return { type: action.type, point: { x, y }, deltaY, seed };
}

function boundedSignedInteger(value, name, minimumMagnitude, maximumMagnitude) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || Math.abs(parsed) < minimumMagnitude || Math.abs(parsed) > maximumMagnitude) {
    throw new Error(`${name} must be a non-zero integer with magnitude between ${minimumMagnitude} and ${maximumMagnitude}.`);
  }
  return parsed;
}

function boundedNumber(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be a finite number between ${minimum} and ${maximum}.`);
  }
  return Math.round(parsed * 100) / 100;
}

function boundedInteger(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}
