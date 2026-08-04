export function inspectSnapshotDocument(options = {}) {
  const round = (value) => Math.round(Number(value || 0) * 100) / 100;
  const maxDepth = Math.max(0, Math.min(Number(options.maxDepth ?? 8), 40));
  const maxNodes = Math.max(1, Math.min(Number(options.maxNodes ?? 4_000), 20_000));
  const includeText = options.includeText === true;
  const includeHidden = options.includeHidden !== false;
  const includeGeometry = options.includeGeometry !== false;
  const textLimit = Math.max(0, Math.min(Number(options.textLimit ?? 500), 10_000));
  const rootSelector = String(options.rootSelector || "html");
  const root = document.querySelector(rootSelector);
  if (!root) {
    return { ok: false, error: `Snapshot root not found: ${rootSelector}` };
  }

  const nodes = [];
  let truncated = false;
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0 && rect.width > 1 && rect.height > 1;
  };
  const geometry = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height),
      scrollTop: round(element.scrollTop), scrollLeft: round(element.scrollLeft),
      scrollWidth: round(element.scrollWidth), scrollHeight: round(element.scrollHeight),
      clientWidth: round(element.clientWidth), clientHeight: round(element.clientHeight)
    };
  };
  const ownText = (element) => Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent || "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, textLimit);

  const visit = (element, parentNodeId, depth, tree) => {
    if (!(element instanceof Element) || nodes.length >= maxNodes) {
      if (nodes.length >= maxNodes) truncated = true;
      return;
    }
    const isVisible = visible(element);
    if (!includeHidden && !isVisible) return;
    const nodeId = nodes.length + 1;
    const record = {
      nodeId,
      parentNodeId,
      depth,
      tree,
      tag: element.tagName.toLowerCase(),
      attributes: Object.fromEntries(Array.from(element.attributes).map((attribute) => [attribute.name, attribute.value])),
      visible: isVisible,
      childElementCount: element.children.length,
      hasOpenShadowRoot: Boolean(element.shadowRoot)
    };
    if (includeGeometry) record.geometry = geometry(element);
    if (includeText) record.ownText = ownText(element);
    nodes.push(record);
    if (depth >= maxDepth) {
      if (element.children.length || element.shadowRoot?.children.length) truncated = true;
      return;
    }
    for (const child of element.children) visit(child, nodeId, depth + 1, tree);
    if (element.shadowRoot) {
      for (const child of element.shadowRoot.children) visit(child, nodeId, depth + 1, "open-shadow-root");
    }
  };

  visit(root, null, 0, "document");
  return {
    ok: true,
    url: location.href,
    title: document.title,
    rootSelector,
    nodeCount: nodes.length,
    truncated,
    nodes
  };
}

export function inspectQueryDocument(options = {}) {
  const round = (value) => Math.round(Number(value || 0) * 100) / 100;
  const selector = String(options.selector || "");
  const selectorType = String(options.selectorType || "css");
  const limit = Math.max(1, Math.min(Number(options.limit ?? 100), 2_000));
  const ancestorDepth = Math.max(0, Math.min(Number(options.ancestorDepth ?? 0), 20));
  const textLimit = Math.max(0, Math.min(Number(options.textLimit ?? 2_000), 20_000));
  const htmlLimit = Math.max(0, Math.min(Number(options.htmlLimit ?? 5_000), 50_000));
  const computedStyles = Array.isArray(options.computedStyles) ? options.computedStyles.slice(0, 50).map(String) : [];
  if (!selector) return { ok: false, error: "Inspector query requires a selector." };

  const roots = [document];
  if (options.pierceShadow === true) {
    for (let index = 0; index < roots.length; index += 1) {
      for (const element of roots[index].querySelectorAll("*")) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }
  }
  const candidates = [];
  try {
    if (selectorType === "css") {
      for (const root of roots) candidates.push(...root.querySelectorAll(selector));
    } else if (selectorType === "xpath") {
      const result = document.evaluate(selector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let index = 0; index < result.snapshotLength; index += 1) candidates.push(result.snapshotItem(index));
    } else if (selectorType === "text") {
      for (const root of roots) {
        for (const element of root.querySelectorAll("body *, *")) {
          const text = String(element.innerText ?? element.textContent ?? "").replace(/\s+/g, " ").trim();
          if (options.exactText === true ? text === selector : text.includes(selector)) candidates.push(element);
        }
      }
    } else {
      return { ok: false, error: `Unsupported selector type: ${selectorType}` };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const unique = [...new Set(candidates)].filter((node) => node instanceof Element);
  const describe = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const record = {
      tag: element.tagName.toLowerCase(),
      attributes: Object.fromEntries(Array.from(element.attributes).map((attribute) => [attribute.name, attribute.value])),
      visible: style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0 && rect.width > 1 && rect.height > 1,
      geometry: {
        x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height),
        scrollTop: round(element.scrollTop), scrollLeft: round(element.scrollLeft),
        scrollWidth: round(element.scrollWidth), scrollHeight: round(element.scrollHeight),
        clientWidth: round(element.clientWidth), clientHeight: round(element.clientHeight)
      }
    };
    if (options.includeText === true) record.text = String(element.innerText ?? element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, textLimit);
    if (options.includeValue === true) record.value = String(element.value ?? "").slice(0, textLimit);
    if (options.includeHtml === true) record.outerHtml = String(element.outerHTML ?? "").slice(0, htmlLimit);
    if (computedStyles.length) record.computedStyle = Object.fromEntries(computedStyles.map((property) => [property, style.getPropertyValue(property)]));
    if (ancestorDepth) {
      record.ancestors = [];
      let ancestor = element.parentElement;
      for (let depth = 0; ancestor && depth < ancestorDepth; depth += 1, ancestor = ancestor.parentElement) {
        record.ancestors.push({
          tag: ancestor.tagName.toLowerCase(),
          attributes: Object.fromEntries(Array.from(ancestor.attributes).map((attribute) => [attribute.name, attribute.value])),
          geometry: (() => {
            const ancestorRect = ancestor.getBoundingClientRect();
            return { x: round(ancestorRect.x), y: round(ancestorRect.y), width: round(ancestorRect.width), height: round(ancestorRect.height) };
          })()
        });
      }
    }
    return record;
  };

  return {
    ok: true,
    url: location.href,
    selector,
    selectorType,
    matchCount: unique.length,
    truncated: unique.length > limit,
    matches: unique.slice(0, limit).map(describe)
  };
}

export async function inspectEvaluateDocument(options = {}) {
  const source = String(options.source || "");
  const maxDepth = Math.max(1, Math.min(Number(options.maxDepth ?? 8), 30));
  const maxEntries = Math.max(1, Math.min(Number(options.maxEntries ?? 2_000), 20_000));
  const maxStringLength = Math.max(1, Math.min(Number(options.maxStringLength ?? 20_000), 200_000));
  const seen = new WeakMap();
  let entries = 0;
  let referenceSequence = 0;

  const serialize = (value, depth = 0) => {
    if (value === undefined) return { type: "undefined" };
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") return value.slice(0, maxStringLength);
    if (typeof value === "bigint") return { type: "bigint", value: String(value) };
    if (typeof value === "symbol") return { type: "symbol", value: String(value) };
    if (typeof value === "function") return { type: "function", name: value.name || "", source: String(value).slice(0, maxStringLength) };
    if (depth >= maxDepth) return { type: "truncated", reason: "maxDepth" };
    if (entries >= maxEntries) return { type: "truncated", reason: "maxEntries" };
    if (seen.has(value)) return { type: "circular", ref: seen.get(value) };
    referenceSequence += 1;
    const ref = `ref-${referenceSequence}`;
    seen.set(value, ref);
    entries += 1;
    if (value instanceof Element) {
      const rect = value.getBoundingClientRect();
      return {
        type: "element",
        ref,
        tag: value.tagName.toLowerCase(),
        attributes: Object.fromEntries(Array.from(value.attributes).map((attribute) => [attribute.name, attribute.value])),
        geometry: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      };
    }
    if (value instanceof Error) return { type: "error", ref, name: value.name, message: value.message, stack: String(value.stack || "").slice(0, maxStringLength) };
    if (value instanceof Date) return { type: "date", ref, value: value.toISOString() };
    if (value instanceof Map) return { type: "map", ref, entries: Array.from(value.entries()).slice(0, maxEntries).map(([key, item]) => [serialize(key, depth + 1), serialize(item, depth + 1)]) };
    if (value instanceof Set) return { type: "set", ref, values: Array.from(value.values()).slice(0, maxEntries).map((item) => serialize(item, depth + 1)) };
    if (Array.isArray(value)) return value.slice(0, maxEntries).map((item) => serialize(item, depth + 1));
    const output = { type: value.constructor?.name || "object", ref, properties: {} };
    for (const key of Object.keys(value).slice(0, maxEntries)) {
      try { output.properties[key] = serialize(value[key], depth + 1); }
      catch (error) { output.properties[key] = { type: "unreadable", error: error instanceof Error ? error.message : String(error) }; }
    }
    return output;
  };

  if (!source) return { ok: false, error: { name: "InspectorError", message: "Inspector evaluate requires JavaScript source." } };
  try {
    const value = await (0, eval)(source);
    return { ok: true, url: location.href, value: serialize(value) };
  } catch (error) {
    return {
      ok: false,
      url: location.href,
      error: {
        name: String(error?.name || "Error"),
        message: String(error?.message || error),
        stack: String(error?.stack || "").slice(0, maxStringLength)
      }
    };
  }
}
