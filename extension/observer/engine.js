import { buildFrameOffsets, chooseBestScrollableTarget, chooseBestTarget } from "./frame-geometry.js";
import { screenPointFromPageGeometry } from "./geometry.js";
import { inspectEvaluateDocument, inspectQueryDocument, inspectSnapshotDocument } from "./inspector-runtime.js";
import { observeDocument } from "./runtime.js";

export class PageObserver {
  constructor() {
    this.adapterSources = new Map();
  }

  async loadDescriptors() {
    const descriptors = new Map();
    for (const adapter of this.adapterSources.values()) {
      for (const descriptor of adapter.descriptors) {
        descriptors.set(`${descriptor.id}@${descriptor.version}`, descriptor);
      }
    }
    return [...descriptors.values()];
  }

  async registerAdapter(source, registration) {
    validateAdapterRegistration(registration, source);
    this.adapterSources.set(source, structuredClone(registration));
    return await this.adapterStatus(source);
  }

  unregisterAdapter(source) {
    return this.adapterSources.delete(source);
  }

  async adapterStatuses() {
    return await Promise.all([...this.adapterSources.keys()].map((source) => this.adapterStatus(source)));
  }

  async adapterStatus(source) {
    const adapter = this.adapterSources.get(source);
    if (!adapter) return null;
    const missingHostPermissions = [];
    for (const origin of adapter.hostPermissions) {
      if (!await chrome.permissions.contains({ origins: [origin] })) missingHostPermissions.push(origin);
    }
    return {
      source,
      id: adapter.id,
      displayName: adapter.displayName,
      version: adapter.version,
      descriptorCount: adapter.descriptors.length,
      hostPermissions: [...adapter.hostPermissions],
      missingHostPermissions,
      authorized: missingHostPermissions.length === 0
    };
  }

  async observeActiveTab() {
    const observedAt = Date.now();
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || !tab.url) throw new Error("No observable active Chrome tab is available.");
    const url = new URL(tab.url);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error(`Page Observer cannot inspect restricted URL protocol '${url.protocol}'.`);
    }
    const descriptors = (await this.loadDescriptors()).filter((descriptor) => matches(descriptor, url));
    if (descriptors.length === 0) {
      return this.unregisteredObservation(tab, observedAt);
    }
    const requiredHostPermission = `${url.origin}/*`;
    if (!await chrome.permissions.contains({ origins: [requiredHostPermission] })) {
      return this.permissionRequiredObservation(tab, observedAt, requiredHostPermission, descriptors);
    }
    const [windowInfo, zoomFactor] = await Promise.all([
      chrome.windows.get(tab.windowId),
      chrome.tabs.getZoom(tab.id)
    ]);
    const injections = await Promise.all(descriptors.map(async (descriptor) => ({
      descriptor,
      frames: await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: observeDocument,
        args: [descriptor]
      })
    })));
    const observations = injections.flatMap(({ descriptor, frames }) =>
      frames.filter((frame) => frame.result).map((frame) => ({
        descriptorId: descriptor.id,
        descriptorVersion: descriptor.version,
        frameId: frame.frameId,
        ...frame.result
      }))
    );
    const topFrames = observations.filter((frame) => frame.frameId === 0);
    const topFrame = topFrames[0] ?? observations[0];
    const frameOffsets = buildFrameOffsets(observations);
    const pageObservation = chooseCurrentPage(observations, descriptors, frameOffsets) ?? topFrame;
    const enrich = (target, frameId) => {
      if (!target?.found || !target.viewportPoint || !topFrame?.screen) return target;
      const offset = frameOffsets.get(frameId);
      const coordinateReady = Boolean(offset);
      const topViewportPoint = offset ? {
        x: target.viewportPoint.x + offset.x,
        y: target.viewportPoint.y + offset.y
      } : null;
      return {
        ...target,
        coordinateReady,
        topViewportPoint,
        screenPoint: coordinateReady
          ? screenPointFromPageGeometry({ viewportPoint: topViewportPoint, screen: topFrame.screen }, zoomFactor)
          : null
      };
    };
    const merge = (property) => {
      const grouped = new Map();
      for (const frame of observations) {
        for (const target of frame[property] || []) {
          if (!grouped.has(target.name)) grouped.set(target.name, []);
          grouped.get(target.name).push({
        ...enrich(target, frame.frameId),
        frameId: frame.frameId,
        descriptorId: frame.descriptorId
          });
        }
      }
      const chooser = property === "scrollables" ? chooseBestScrollableTarget : chooseBestTarget;
      return Object.fromEntries([...grouped].map(([name, targets]) => [name, chooser(targets)]));
    };
    const mergeCollections = () => {
      const grouped = new Map();
      for (const frame of observations) {
        for (const collection of frame.collections || []) {
          if (!grouped.has(collection.name)) grouped.set(collection.name, []);
          grouped.get(collection.name).push({
            ...collection,
            frameId: frame.frameId,
            descriptorId: frame.descriptorId,
            items: (collection.items || []).map((item) => ({
              ...enrich(item, frame.frameId),
              frameId: frame.frameId,
              descriptorId: frame.descriptorId
            }))
          });
        }
      }
      return Object.fromEntries([...grouped].map(([name, collections]) => [name, collections.sort((left, right) => {
        const readyDifference = right.items.filter((item) => item.coordinateReady).length - left.items.filter((item) => item.coordinateReady).length;
        return readyDifference || Number(right.count || 0) - Number(left.count || 0);
      })[0]]));
    };
    return {
      ok: true,
      observationId: crypto.randomUUID(),
      observedAt,
      expiresAt: observedAt + 15_000,
      descriptorIds: [...new Set(observations.map((frame) => frame.descriptorId))],
      page: pageObservation?.page ?? "unknown",
      tab: { id: tab.id, windowId: tab.windowId, title: tab.title ?? "", url: tab.url },
      window: {
        id: windowInfo.id,
        focused: windowInfo.focused === true,
        state: windowInfo.state,
        left: windowInfo.left ?? null,
        top: windowInfo.top ?? null,
        width: windowInfo.width ?? null,
        height: windowInfo.height ?? null,
        zoomFactor
      },
      viewport: topFrame?.viewport ?? null,
      frames: observations.map((frame) => ({
        frameId: frame.frameId,
        descriptorId: frame.descriptorId,
        page: frame.page,
        url: frame.url,
        viewport: frame.viewport,
        diagnostics: frame.diagnostics
      })),
      fields: merge("fields"),
      controls: merge("controls"),
      values: merge("values"),
      collections: mergeCollections(),
      scrollables: merge("scrollables")
    };
  }

  async inspectSnapshot(options = {}) {
    return await this.runInspector(inspectSnapshotDocument, options, {
      allFramesByDefault: true,
      world: "ISOLATED"
    });
  }

  async inspectQuery(options = {}) {
    return await this.runInspector(inspectQueryDocument, options, {
      allFramesByDefault: true,
      world: "ISOLATED"
    });
  }

  async inspectEvaluate(options = {}) {
    const source = String(options.source || "");
    if (source.length > 100_000) throw new Error("Inspector JavaScript source exceeds 100000 characters.");
    const world = options.world === "ISOLATED" ? "ISOLATED" : "MAIN";
    return await this.runInspector(inspectEvaluateDocument, { ...options, source }, {
      allFramesByDefault: false,
      world
    });
  }

  async captureVisibleTab() {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || !tab.url || !Number.isInteger(tab.windowId)) {
      throw new Error("No capturable active Chrome tab is available.");
    }
    const url = new URL(tab.url);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error(`Screenshot capture cannot access restricted URL protocol '${url.protocol}'.`);
    }
    const matchingDescriptors = (await this.loadDescriptors()).filter((descriptor) => matches(descriptor, url));
    if (matchingDescriptors.length === 0) {
      throw new Error(`Screenshot capture is not authorized for unregistered page '${url.origin}${url.pathname}'.`);
    }
    const requiredHostPermission = `${url.origin}/*`;
    if (!await chrome.permissions.contains({ origins: [requiredHostPermission] })) {
      throw new Error(`Screenshot capture requires the active adapter permission '${requiredHostPermission}'.`);
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) {
      throw new Error("Chrome returned an invalid visible-tab screenshot.");
    }
    return {
      ok: true,
      capturedAt: Date.now(),
      format: "png",
      tab: {
        id: tab.id,
        windowId: tab.windowId,
        title: tab.title ?? "",
        url: tab.url
      },
      descriptorIds: matchingDescriptors.map((descriptor) => descriptor.id),
      dataUrl
    };
  }

  async runInspector(func, options, execution) {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || !tab.url) throw new Error("No inspectable active Chrome tab is available.");
    const url = new URL(tab.url);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error(`Inspector cannot access restricted URL protocol '${url.protocol}'.`);
    }
    const target = { tabId: tab.id };
    const frameIds = Array.isArray(options.frameIds)
      ? [...new Set(options.frameIds.map(Number).filter((value) => Number.isInteger(value) && value >= 0))]
      : [];
    if (frameIds.length) target.frameIds = frameIds;
    else if (options.allFrames === true || (options.allFrames !== false && execution.allFramesByDefault)) target.allFrames = true;
    const startedAt = Date.now();
    const results = await chrome.scripting.executeScript({
      target,
      world: execution.world,
      func,
      args: [options]
    });
    return {
      ok: true,
      operation: func.name,
      world: execution.world,
      tab: { id: tab.id, windowId: tab.windowId, title: tab.title ?? "", url: tab.url },
      startedAt,
      finishedAt: Date.now(),
      frames: results.map((entry) => ({ frameId: entry.frameId, documentId: entry.documentId ?? null, result: entry.result }))
    };
  }

  unregisteredObservation(tab, observedAt) {
    return {
      ok: true,
      observationId: crypto.randomUUID(),
      observedAt,
      expiresAt: observedAt + 15_000,
      descriptorIds: [],
      page: "unregistered",
      tab: { id: tab.id, windowId: tab.windowId, title: tab.title ?? "", url: tab.url },
      fields: {}, controls: {}, values: {}, collections: {}, scrollables: {}, frames: []
    };
  }

  permissionRequiredObservation(tab, observedAt, requiredHostPermission, descriptors) {
    return {
      ok: true,
      observationId: crypto.randomUUID(),
      observedAt,
      expiresAt: observedAt + 15_000,
      descriptorIds: [...new Set(descriptors.map((descriptor) => descriptor.id))],
      page: "permission-required",
      tab: { id: tab.id, windowId: tab.windowId, title: tab.title ?? "", url: tab.url },
      requiredHostPermissions: [requiredHostPermission],
      fields: {}, controls: {}, values: {}, collections: {}, scrollables: {}, frames: []
    };
  }
}

function validateAdapterRegistration(registration, source) {
  if (
    registration?.schemaVersion !== 1 ||
    !isNonEmptyString(registration.id) ||
    !isNonEmptyString(registration.displayName) ||
    !isNonEmptyString(registration.version)
  ) {
    throw new Error(`Invalid adapter registration metadata from ${source}.`);
  }
  if (!Array.isArray(registration.hostPermissions) || registration.hostPermissions.length === 0) {
    throw new Error(`Adapter registration from ${source} has no host permissions.`);
  }
  for (const permission of registration.hostPermissions) {
    if (!isNonEmptyString(permission) || !/^https?:\/\/[^/]+\/\*$/.test(permission)) {
      throw new Error(`Adapter registration from ${source} has invalid host permission '${String(permission)}'.`);
    }
  }
  if (!Array.isArray(registration.descriptors) || registration.descriptors.length === 0) {
    throw new Error(`Adapter registration from ${source} has no descriptors.`);
  }
  for (const descriptor of registration.descriptors) {
    validateDescriptor(descriptor, source);
    for (const origin of descriptor.match.origins) {
      if (!registration.hostPermissions.includes(`${origin}/*`)) {
        throw new Error(`Adapter registration from ${source} does not authorize descriptor origin '${origin}'.`);
      }
    }
  }
}

function validateDescriptor(descriptor, path) {
  if (descriptor?.schemaVersion !== 1 || !descriptor.id || !descriptor.version) {
    throw new Error(`Invalid Page Observer descriptor metadata: ${path}`);
  }
  if (!Array.isArray(descriptor.match?.origins) || descriptor.match.origins.length === 0) {
    throw new Error(`Page Observer descriptor has no allowed origins: ${path}`);
  }
  for (const key of ["pages", "fields", "controls", "values", "collections", "scrollables"]) {
    if (!Array.isArray(descriptor[key])) throw new Error(`Page Observer descriptor '${path}' has invalid ${key}.`);
  }
}

function matches(descriptor, url) {
  return descriptor.match.origins.includes(url.origin) &&
    (descriptor.match.pathPrefixes?.length ? descriptor.match.pathPrefixes.some((prefix) => url.pathname.startsWith(prefix)) : true);
}

function pagePriority(descriptors, pageName) {
  return descriptors.flatMap((descriptor) => descriptor.pages)
    .find((page) => page.name === pageName)?.priority ?? 0;
}

export function chooseCurrentPage(
  observations,
  descriptors,
  frameOffsets = buildFrameOffsets(observations)
) {
  return observations
    .filter((frame) => frame.page !== "unknown" && frameOffsets.has(frame.frameId))
    .sort((left, right) => {
      const priorityDifference = pagePriority(descriptors, right.page) - pagePriority(descriptors, left.page);
      if (priorityDifference !== 0) return priorityDifference;
      return Number(left.frameId !== 0) - Number(right.frameId !== 0);
    })[0] ?? null;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
