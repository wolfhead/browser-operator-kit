export class WebCommandRunner {
  constructor({
    bridge,
    hand,
    logger = () => {},
    allowedOpenUrls = [],
    initialBridgeConnectionWaitMs = 8_000,
    postconditionAttempts = 8,
    postconditionDelayMs = 150,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  }) {
    this.bridge = bridge;
    this.hand = hand;
    this.logger = logger;
    this.allowedOpenUrls = new Set(allowedOpenUrls.map(normalizeAllowedUrl));
    this.initialBridgeConnectionWaitMs = boundedInteger(initialBridgeConnectionWaitMs, 1_000, 30_000, 8_000);
    this.postconditionAttempts = boundedInteger(postconditionAttempts, 1, 20, 8);
    this.postconditionDelayMs = boundedInteger(postconditionDelayMs, 0, 2_000, 150);
    this.sleep = sleep;
  }

  async executeWorkflow(workflow) {
    validateWorkflow(workflow);
    const startedAt = new Date().toISOString();
    const results = [];
    await this.ensureBridgeConnection(workflow.browserBundleIdentifier);
    await this.bridge.request("dashboard.begin", {
      label: workflow.label,
      message: "工作流正在运行；浏览器仅会在原子操作期间切到前台。"
    }, 5_000);
    try {
      for (const command of workflow.commands) {
        results.push(await this.executeCommand(command, workflow.browserBundleIdentifier));
      }
      await this.bridge.request("dashboard.end", {
        status: "completed",
        message: `工作流已完成：${results.length} 个原子命令全部通过。`
      }, 5_000);
      return { ok: true, workflowId: workflow.id, startedAt, finishedAt: new Date().toISOString(), commands: results };
    } catch (error) {
      await this.bridge.request("dashboard.end", {
        status: "failed",
        message: `${error.code || "WORKFLOW_FAILED"}：${error.message}`
      }, 5_000).catch(() => {});
      return {
        ok: false,
        workflowId: workflow.id,
        startedAt,
        finishedAt: new Date().toISOString(),
        commands: results,
        error: serializeError(error)
      };
    }
  }

  async ensureBridgeConnection(browserBundleIdentifier) {
    if (typeof this.bridge.waitForConnection !== "function") return;
    try {
      await this.bridge.waitForConnection(this.initialBridgeConnectionWaitMs);
      return;
    } catch (initialError) {
      this.logger("info", "extension_bridge_wake_started", {
        browserBundleIdentifier,
        initialError: initialError instanceof Error ? initialError.message : String(initialError)
      });
    }

    let wakeLease = null;
    try {
      wakeLease = await this.hand.beginForegroundLease({
        bundleIdentifier: browserBundleIdentifier,
        activateIfNeeded: true
      });
      if (typeof this.hand.activateBrowser === "function") {
        await this.hand.activateBrowser(browserBundleIdentifier);
      }
      await this.bridge.waitForConnection(20_000);
    } finally {
      if (wakeLease) {
        const release = await this.hand.endForegroundLease(wakeLease.leaseId);
        this.logger("info", "extension_bridge_wake_finished", {
          browserBundleIdentifier,
          restored: release.restored,
          reason: release.reason
        });
        if (release.reason === "restore_failed") {
          throw new WebCommandError(
            "FOREGROUND_RESTORE_FAILED",
            "foreground_restore",
            release.error || "The previous application could not be restored after waking the extension."
          );
        }
      }
    }
  }

  async executeCommand(command, browserBundleIdentifier) {
    const startedAt = new Date().toISOString();
    let lease = null;
    let commandResult = null;
    const isBootstrap = command.action.type === "openUrl";
    await this.dashboardUpdate(
      command,
      isBootstrap ? "准备打开页面" : "检查前置状态",
      isBootstrap ? "正在准备浏览器前台租约。" : "正在读取页面状态并定位目标。 "
    );
    try {
      const backgroundObservation = await this.observe();
      if (isBootstrap && backgroundObservation.page === command.expectedResultPage) {
        commandResult = {
          ok: true,
          commandId: command.id,
          startedAt,
          finishedAt: new Date().toISOString(),
          page: backgroundObservation.page,
          action: command.action.type,
          actionSkipped: true,
          actionReceipts: [],
          verificationPolicy: normalizeVerificationPolicy(command.verificationPolicy, {
            attempts: this.postconditionAttempts,
            pollIntervalMs: this.postconditionDelayMs
          }),
          postconditions: []
        };
        await this.bridge.request("dashboard.action", {
          actionId: command.id,
          action: command.action.type,
          status: "completed",
          message: `${command.id} 的目标页面已经打开，未重复导航。`
        }, 5_000);
        return commandResult;
      }
      const readyBackgroundObservation = isBootstrap
        ? backgroundObservation
        : await this.waitForTargetReady(command, backgroundObservation, "PRECONDITION");
      if (
        !isBootstrap &&
        command.executionPolicy?.skipActionWhenPostconditionsPass === true &&
        (command.postconditions || []).length > 0 &&
        (command.postconditions || []).every((assertion) => assertionMatches(readyBackgroundObservation, assertion, readyBackgroundObservation))
      ) {
        commandResult = {
          ok: true,
          commandId: command.id,
          startedAt,
          finishedAt: new Date().toISOString(),
          page: readyBackgroundObservation.page,
          action: command.action.type,
          actionSkipped: true,
          actionReceipts: [],
          verificationPolicy: normalizeVerificationPolicy(command.verificationPolicy, {
            attempts: this.postconditionAttempts,
            pollIntervalMs: this.postconditionDelayMs
          }),
          postconditions: summarizeAssertions(command.postconditions || [])
        };
        await this.bridge.request("dashboard.action", {
          actionId: command.id,
          action: command.action.type,
          status: "completed",
          message: `${command.id} 的后置条件已满足，未重复执行动作。`
        }, 5_000);
        return commandResult;
      }
      if (!isBootstrap) assertAll(readyBackgroundObservation, command.preconditions || [], "PRECONDITION_FAILED");

      await this.dashboardUpdate(command, "临时切换到浏览器", "正在获取前台租约。 ");
      const foregroundPolicy = normalizeForegroundPolicy(command.foregroundPolicy);
      lease = await this.hand.beginForegroundLease({
        bundleIdentifier: browserBundleIdentifier,
        activateIfNeeded: foregroundPolicy.activate === "ifNeeded"
      });

      const actionableObservation = isBootstrap
        ? null
        : await this.waitForTargetReady(command, await this.observe(), "ACTION");
      if (!isBootstrap) {
        assertAll(actionableObservation, command.preconditions || [], "PRECONDITION_FAILED");
        this.assertFreshFocusedObservation(actionableObservation, lease);
      }

      await this.dashboardUpdate(command, "执行操作", describeAction(command.action));
      const actionReceipts = await this.performAction(command, actionableObservation, lease);

      await this.dashboardUpdate(command, "验证结果", "正在通过 Eye 读取操作后的页面状态。 ");
      const finalObservation = await this.waitForPostconditions(command, actionableObservation);

      commandResult = {
        ok: true,
        commandId: command.id,
        startedAt,
        finishedAt: new Date().toISOString(),
        page: finalObservation.page,
        action: command.action.type,
        actionSkipped: false,
        actionReceipts: actionReceipts.map(summarizeReceipt),
        verificationPolicy: normalizeVerificationPolicy(command.verificationPolicy, {
          attempts: this.postconditionAttempts,
          pollIntervalMs: this.postconditionDelayMs
        }),
        postconditions: summarizeAssertions(command.postconditions || [])
      };
      await this.bridge.request("dashboard.action", {
        actionId: actionReceipts.at(-1)?.actionId || command.id,
        action: command.action.type,
        status: "completed",
        message: `${command.id} 已执行且后置条件通过。`
      }, 5_000);
      return commandResult;
    } catch (error) {
      if (!(error instanceof WebCommandError)) {
        error = new WebCommandError("ACTION_FAILED", "action", error instanceof Error ? error.message : String(error));
      }
      await this.bridge.request("dashboard.action", {
        actionId: command.id,
        action: command.action.type,
        status: "failed",
        message: `${error.code}：${error.message}`
      }, 5_000).catch(() => {});
      throw error;
    } finally {
      if (lease) {
        const release = await this.hand.endForegroundLease(lease.leaseId);
        this.logger("info", "web_command_foreground_released", {
          commandId: command.id,
          restored: release.restored,
          reason: release.reason
        });
        if (commandResult) {
          commandResult.foreground = {
            switched: lease.switched,
            targetBundleIdentifier: lease.targetBundleIdentifier,
            previousBundleIdentifier: lease.previousApplication?.bundleIdentifier ?? null,
            released: release.released,
            restored: release.restored,
            reason: release.reason,
            finalFrontmostBundleIdentifier: release.after?.frontmostBundleIdentifier ?? release.current?.frontmostBundleIdentifier ?? null
          };
        }
        if (release.reason === "restore_failed") {
          throw new WebCommandError(
            "FOREGROUND_RESTORE_FAILED",
            "foreground_restore",
            release.error || "The previous application could not be restored."
          );
        }
      }
    }
  }

  async performAction(command, observation, lease) {
    if (command.action.type === "openUrl") {
      const url = normalizeAllowedUrl(command.action.url);
      if (!this.allowedOpenUrls.has(url)) {
        throw new WebCommandError("ACTION_FAILED", "action", `URL '${url}' is not in the exact bootstrap allowlist.`);
      }
      return [await this.hand.openUrl(url, lease.targetBundleIdentifier)];
    }
    const target = getRegisteredTarget(observation, command.target);
    if (command.action.type === "click") {
      return [await this.executeHandAction({ type: "moveClick", point: target.screenPoint }, observation, lease)];
    }
    if (command.action.type === "paste") {
      return [await this.executeHandAction({ type: "typeText", point: target.screenPoint, text: command.action.text }, observation, lease)];
    }
    if (command.action.type === "scrollUntil") {
      const receipts = [];
      let current = observation;
      const maximumAttempts = boundedInteger(command.action.maxAttempts, 1, 20, 8);
      const direction = command.action.direction || "down";
      for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
        if (assertionMatches(current, command.action.until)) return receipts;
        const scrollTarget = getRegisteredTarget(current, command.target);
        const canContinue = direction === "up" ? scrollTarget.canScrollUp : scrollTarget.canScrollDown;
        if (!canContinue) {
          throw new WebCommandError("POSTCONDITION_FAILED", "postcondition", "Scrollable target stopped before the required state was reached.");
        }
        const magnitude = command.action.deltaY === "recommended"
          ? scrollTarget.recommendedDeltaY
          : boundedInteger(command.action.deltaY, 80, 2_400, scrollTarget.recommendedDeltaY);
        const deltaY = direction === "up" ? -magnitude : magnitude;
        receipts.push(await this.executeHandAction({ type: "scroll", point: scrollTarget.screenPoint, deltaY }, current, lease));
        current = await this.observe();
        this.assertFreshFocusedObservation(current, lease);
      }
      if (!assertionMatches(current, command.action.until)) {
        throw new WebCommandError("POSTCONDITION_FAILED", "postcondition", `scrollUntil exceeded ${maximumAttempts} attempts.`);
      }
      return receipts;
    }
    throw new WebCommandError("ACTION_FAILED", "action", `Unsupported action type '${command.action.type}'.`);
  }

  async waitForTargetReady(command, firstObservation, stage) {
    const policy = normalizeReadinessPolicy(command.readinessPolicy);
    let observation = firstObservation;
    let lastError = null;
    if (policy.initialDelayMs > 0) {
      await this.sleep(policy.initialDelayMs);
      observation = await this.observe();
    }
    for (let attempt = 0; attempt < policy.maximumAttempts; attempt += 1) {
      try {
        this.assertPageAndTargets(observation, command, stage);
        return observation;
      } catch (error) {
        if (!(error instanceof WebCommandError) || error.code !== "TARGET_NOT_FOUND") throw error;
        lastError = error;
      }
      if (attempt + 1 < policy.maximumAttempts) {
        if (policy.pollIntervalMs > 0) await this.sleep(policy.pollIntervalMs);
        observation = await this.observe();
      }
    }
    throw lastError || new WebCommandError("TARGET_NOT_FOUND", stage.toLowerCase(), "Target did not become ready.");
  }

  async waitForPostconditions(command, baselineObservation) {
    const expectedResultPage = command.expectedResultPage || command.expectedPage;
    const policy = normalizeVerificationPolicy(command.verificationPolicy, {
      attempts: this.postconditionAttempts,
      pollIntervalMs: this.postconditionDelayMs
    });
    let lastObservation = null;
    let lastError = null;
    let stablePasses = 0;
    if (policy.initialDelayMs > 0) await this.sleep(policy.initialDelayMs);
    for (let attempt = 0; attempt < policy.maximumAttempts; attempt += 1) {
      if (attempt > 0 && policy.pollIntervalMs > 0) {
        await this.sleep(policy.pollIntervalMs);
      }
      lastObservation = await this.observe();
      if (lastObservation.page !== expectedResultPage) {
        if (expectedResultPage !== command.expectedPage && lastObservation.page === command.expectedPage) {
          stablePasses = 0;
          lastError = new WebCommandError(
            "POSTCONDITION_FAILED",
            "postcondition",
            `Result page '${expectedResultPage}' is still pending; current page remains '${command.expectedPage}'.`
          );
          continue;
        }
        throw new WebCommandError(
          "POSTCONDITION_FAILED",
          "postcondition",
          `Expected result page '${expectedResultPage}', observed '${lastObservation.page}'.`
        );
      }
      try {
        assertAll(lastObservation, command.postconditions || [], "POSTCONDITION_FAILED", baselineObservation);
        stablePasses += 1;
        if (stablePasses >= policy.stablePasses) return lastObservation;
      } catch (error) {
        stablePasses = 0;
        lastError = error;
      }
    }
    throw lastError || new WebCommandError("POSTCONDITION_FAILED", "postcondition", "Postconditions were not satisfied.");
  }

  async executeHandAction(action, observation, lease) {
    this.assertFreshFocusedObservation(observation, lease);
    return await this.hand.execute({ ...action, seed: Math.floor(Math.random() * 1_000_000_000) });
  }

  assertPageAndTargets(observation, command, stage) {
    if (observation.page !== command.expectedPage) {
      throw new WebCommandError("PRECONDITION_FAILED", stage.toLowerCase(), `Expected page '${command.expectedPage}', observed '${observation.page}'.`);
    }
    const target = getRegisteredTarget(observation, command.target, false);
    if (
      !target?.found ||
      target.visible === false ||
      target.enabled === false ||
      target.occluded === true ||
      !target.coordinateReady ||
      !target.screenPoint
    ) {
      throw new WebCommandError("TARGET_NOT_FOUND", stage.toLowerCase(), `Target '${command.target.scope}.${command.target.name}' is unavailable or has no safe screen coordinate.`);
    }
  }

  assertFreshFocusedObservation(observation, lease) {
    if (Date.now() > observation.expiresAt) {
      throw new WebCommandError("OBSERVATION_STALE", "action", "Eye observation expired before Hand execution.");
    }
    if (observation.window?.focused !== true) {
      throw new WebCommandError("FOREGROUND_FAILED", "foreground", "The observed browser window is not focused.");
    }
    if (lease.after.frontmostBundleIdentifier !== lease.targetBundleIdentifier) {
      throw new WebCommandError("FOREGROUND_FAILED", "foreground", "Foreground lease no longer targets the expected browser.");
    }
  }

  async observe() {
    return await this.bridge.request("eye.observe", {}, 10_000);
  }

  async dashboardUpdate(command, step, message) {
    await this.bridge.request("dashboard.update", {
      status: "running",
      step: `${command.id} · ${step}`,
      message
    }, 5_000);
  }
}

export class WebCommandError extends Error {
  constructor(code, stage, message, details = null) {
    super(message);
    this.name = "WebCommandError";
    this.code = code;
    this.stage = stage;
    this.details = details;
  }
}

function validateWorkflow(workflow) {
  if (!workflow?.id || !workflow.label || !workflow.browserBundleIdentifier || !Array.isArray(workflow.commands) || workflow.commands.length === 0) {
    throw new Error("Workflow requires id, label, browserBundleIdentifier, and at least one command.");
  }
  for (const command of workflow.commands) {
    if (!command.id || !command.action?.type) {
      throw new Error("Every web command requires id and action.");
    }
    if (command.action.type === "openUrl") {
      if (!command.expectedResultPage || command.expectedPage || command.target || (command.preconditions || []).length > 0) {
        throw new Error("openUrl requires only expectedResultPage and cannot declare expectedPage, target, or preconditions.");
      }
      continue;
    }
    if (!command.expectedPage || !command.target?.scope || !command.target?.name) {
      throw new Error("Interactive web commands require expectedPage and target.");
    }
  }
}

function getRegisteredTarget(observation, target, throwWhenMissing = true) {
  const registration = observation?.[target.scope]?.[target.name] ?? null;
  const value = target.scope === "collections" ? resolveCollectionItem(registration, target) : registration;
  if (!value && throwWhenMissing) {
    throw new WebCommandError("TARGET_NOT_FOUND", "target", `Registered target '${target.scope}.${target.name}' was not returned by Eye.`);
  }
  return value;
}

function assertAll(observation, assertions, code, baselineObservation = null) {
  for (const assertion of assertions) {
    if (!assertionMatches(observation, assertion, baselineObservation)) {
      const actual = assertionValue(observation, assertion);
      throw new WebCommandError(code, code === "PRECONDITION_FAILED" ? "precondition" : "postcondition", `Assertion failed for '${assertion.scope}.${assertion.name}.${assertion.path}': expected ${assertionExpectation(assertion)}, received ${JSON.stringify(actual)}.`);
    }
  }
}

function assertionMatches(observation, assertion, baselineObservation = null) {
  const actual = assertionValue(observation, assertion);
  if (Object.hasOwn(assertion, "equals")) return Object.is(actual, assertion.equals);
  if (Object.hasOwn(assertion, "notEquals")) return !Object.is(actual, assertion.notEquals);
  if (Object.hasOwn(assertion, "atLeast")) return typeof actual === "number" && actual >= assertion.atLeast;
  if (Object.hasOwn(assertion, "atMost")) return typeof actual === "number" && actual <= assertion.atMost;
  if (Object.hasOwn(assertion, "includes")) {
    return typeof actual === "string"
      ? actual.includes(String(assertion.includes))
      : Array.isArray(actual) && actual.some((item) => Object.is(item, assertion.includes));
  }
  if (Object.hasOwn(assertion, "changed")) {
    if (assertion.changed !== true || !baselineObservation) return false;
    const baseline = assertionValue(baselineObservation, assertion);
    return baseline !== undefined && actual !== undefined && !Object.is(actual, baseline);
  }
  return false;
}

function assertionValue(observation, assertion) {
  let value = observation?.[assertion.scope]?.[assertion.name];
  if (assertion.scope === "collections" && (Number.isInteger(assertion.index) || typeof assertion.identityKey === "string")) {
    value = resolveCollectionItem(value, assertion);
  }
  for (const segment of String(assertion.path || "").split(".").filter(Boolean)) value = value?.[segment];
  return value;
}

function summarizeAssertions(assertions) {
  return assertions.map((assertion) => ({
    scope: assertion.scope,
    name: assertion.name,
    ...(assertion.index === undefined ? {} : { index: assertion.index }),
    ...(assertion.identityKey === undefined ? {} : { identityKey: assertion.identityKey }),
    path: assertion.path,
    ...Object.fromEntries(["equals", "notEquals", "atLeast", "atMost", "includes", "changed"]
      .filter((operator) => Object.hasOwn(assertion, operator))
      .map((operator) => [operator, assertion[operator]]))
  }));
}

function resolveCollectionItem(registration, reference) {
  if (Number.isInteger(reference.index)) return registration?.items?.[reference.index] ?? null;
  if (typeof reference.identityKey === "string") {
    return registration?.items?.find((item) => item.identityKey === reference.identityKey) ?? null;
  }
  return null;
}

function assertionExpectation(assertion) {
  for (const operator of ["equals", "notEquals", "atLeast", "atMost", "includes", "changed"]) {
    if (Object.hasOwn(assertion, operator)) return `${operator} ${JSON.stringify(assertion[operator])}`;
  }
  return "a configured assertion";
}

function summarizeReceipt(receipt) {
  return {
    actionId: receipt.actionId,
    action: receipt.action,
    requestedPoint: receipt.requestedPoint,
    requestedDeltaY: receipt.requestedDeltaY,
    requestedTextLength: receipt.requestedTextLength,
    helper: receipt.helper
  };
}

function serializeError(error) {
  return {
    name: error.name || "Error",
    code: error.code || "WORKFLOW_FAILED",
    stage: error.stage || "workflow",
    message: error.message || String(error),
    details: error.details ?? null
  };
}

function describeAction(action) {
  if (action.type === "openUrl") return "正在打开配置中精确允许的页面。";
  if (action.type === "paste") return `正在粘贴 ${String(action.text || "").length} 个字符。`;
  if (action.type === "scrollUntil") return "正在滚动，直到声明的页面状态成立。";
  return "正在执行原生点击。";
}

function normalizeAllowedUrl(value) {
  const url = new URL(String(value || ""));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Bootstrap URLs must use HTTP(S) and cannot contain credentials.");
  }
  url.hash = "";
  return url.href;
}

function boundedInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function normalizeForegroundPolicy(value) {
  const policy = value || {};
  const activate = policy.activate || "ifNeeded";
  const restore = policy.restore || "previousUnlessHumanTakeover";
  if (!["ifNeeded", "never"].includes(activate) || restore !== "previousUnlessHumanTakeover") {
    throw new WebCommandError("FOREGROUND_FAILED", "foreground", "Unsupported foreground policy.");
  }
  return { activate, restore };
}

function normalizeVerificationPolicy(value, defaults) {
  const configured = value && typeof value === "object";
  const policy = configured ? value : {};
  const initialDelayMs = boundedInteger(policy.initialDelayMs, 0, 2_000, 0);
  const pollIntervalMs = boundedInteger(policy.pollIntervalMs, 0, 2_000, defaults.pollIntervalMs);
  const timeoutMs = boundedInteger(
    policy.timeoutMs,
    0,
    15_000,
    Math.max(0, (defaults.attempts - 1) * defaults.pollIntervalMs)
  );
  const stablePasses = boundedInteger(policy.stablePasses, 1, 3, 1);
  const intervalForAttempts = Math.max(pollIntervalMs, 1);
  const maximumAttempts = configured
    ? Math.min(100, Math.max(stablePasses, Math.floor(timeoutMs / intervalForAttempts) + 1))
    : Math.max(stablePasses, defaults.attempts);
  return { initialDelayMs, pollIntervalMs, timeoutMs, stablePasses, maximumAttempts };
}

function normalizeReadinessPolicy(value) {
  const policy = value && typeof value === "object" ? value : {};
  const initialDelayMs = boundedInteger(policy.initialDelayMs, 0, 2_000, 0);
  const pollIntervalMs = boundedInteger(policy.pollIntervalMs, 20, 1_000, 100);
  const timeoutMs = boundedInteger(policy.timeoutMs, 0, 5_000, 1_500);
  const maximumAttempts = Math.max(1, Math.floor(timeoutMs / pollIntervalMs) + 1);
  return { initialDelayMs, pollIntervalMs, timeoutMs, maximumAttempts };
}
