export function chooseUniqueIdentityAttribute(elements, attributes) {
  const candidates = Array.isArray(attributes) ? attributes.map(String) : [];
  return candidates.find((attribute) => {
    const values = elements.map((element) => String(element?.getAttribute?.(attribute) || "").trim());
    return values.length > 0 && values.every(Boolean) && new Set(values).size === values.length;
  }) ?? null;
}

export function observeDocument(descriptor) {
  const textOf = (element) => String(element?.innerText ?? element?.textContent ?? "")
    .replace(/\s+/g, " ")
    .trim();

  const isVisible = (element) => {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" &&
      Number(style.opacity) > 0 && rect.width > 1 && rect.height > 1 &&
      rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
  };

  const isSelected = (element) => {
    for (let current = element, depth = 0; current && depth < 4; current = current.parentElement, depth += 1) {
      const marker = String(current.className ?? "");
      if (
        /(^|[\s_-])(active|selected|checked|current|on)([\s_-]|$)/i.test(marker) ||
        current.getAttribute("aria-selected") === "true" ||
        current.getAttribute("aria-checked") === "true" ||
        current.getAttribute("aria-pressed") === "true" ||
        current.matches?.("input:checked") ||
        current.querySelector?.("input:checked")
      ) return true;
    }
    return false;
  };

  const smallestVisibleExactText = (text, root = document) => Array.from(
    root.querySelectorAll("button,a,label,li,span,p,div")
  )
    .filter((element) => isVisible(element) && textOf(element) === String(text))
    .map((element) => ({ element, area: element.getBoundingClientRect().width * element.getBoundingClientRect().height }))
    .sort((left, right) => left.area - right.area)[0]?.element ?? null;

  const viewportPoint = (element) => {
    const rect = element.getBoundingClientRect();
    const left = Math.max(rect.left, 0);
    const right = Math.min(rect.right, innerWidth);
    const top = Math.max(rect.top, 0);
    const bottom = Math.min(rect.bottom, innerHeight);
    return { x: (left + right) / 2, y: (top + bottom) / 2 };
  };

  const resolve = (locator) => {
    if (!locator || typeof locator !== "object") return null;
    if (locator.kind === "document") {
      if (locator.urlIncludes && !location.href.includes(String(locator.urlIncludes))) return null;
      return document.documentElement;
    }
    if (locator.kind === "css") return document.querySelector(locator.selector);
    if (locator.kind === "text") {
      const candidates = Array.from(document.querySelectorAll(locator.selector || "body *"));
      const expected = locator.text ? [locator.text] : (locator.textAny || []);
      const matches = candidates.filter((element) => {
        const text = textOf(element);
        return expected.some((value) => locator.exact === true
          ? text === String(value)
          : text.includes(String(value)));
      });
      if (locator.unique === true && matches.length !== 1) return null;
      return matches[0] ?? null;
    }
    if (locator.kind === "sectionOption") {
      const heading = smallestVisibleExactText(locator.sectionText);
      if (!heading) return null;
      const headingRect = heading.getBoundingClientRect();
      const exactOptions = Array.from(document.querySelectorAll("button,a,label,li,span,p,div"))
        .filter((element) => isVisible(element) && textOf(element) === String(locator.optionText));
      const sameRow = exactOptions.filter((element) => {
        const rect = element.getBoundingClientRect();
        return Math.abs((rect.top + rect.height / 2) - (headingRect.top + headingRect.height / 2)) <=
          Math.max(20, headingRect.height * 1.5);
      });
      if (sameRow.length > 0) {
        return sameRow.map((element) => ({ element, area: element.getBoundingClientRect().width * element.getBoundingClientRect().height }))
          .sort((left, right) => left.area - right.area)[0].element;
      }
      for (let section = heading.parentElement, depth = 0; section && depth < 6; section = section.parentElement, depth += 1) {
        const option = smallestVisibleExactText(locator.optionText, section);
        if (option) return option;
      }
      return null;
    }
    if (locator.kind === "firstEditable") {
      const candidates = Array.from(document.querySelectorAll("input, textarea, [contenteditable='true']"));
      const hints = locator.placeholderIncludes || [];
      return candidates.find((element) => {
        const placeholder = String(element.getAttribute("placeholder") ?? "");
        const rect = element.getBoundingClientRect();
        const minimumWidth = Number(locator.minWidth || 0);
        const maximumWidth = Number(locator.maxWidth || Number.POSITIVE_INFINITY);
        return isVisible(element) && rect.width >= minimumWidth && rect.width <= maximumWidth &&
          (hints.length === 0 || hints.some((hint) => placeholder.includes(hint)));
      }) ?? null;
    }
    if (locator.kind === "largestScrollable") {
      const candidates = [document.scrollingElement, ...document.querySelectorAll("body *")]
        .filter(Boolean)
        .filter((element) => element.scrollHeight > element.clientHeight + 8 && isVisible(element));
      return candidates.sort((left, right) =>
        (right.clientWidth * right.clientHeight) - (left.clientWidth * left.clientHeight)
      )[0] ?? null;
    }
    return null;
  };

  const viewportRect = (element) => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x * 100) / 100,
      y: Math.round(rect.y * 100) / 100,
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100
    };
  };

  const canvasSignature = (element) => {
    if (!(element instanceof HTMLCanvasElement) || element.width < 1 || element.height < 1) return "";
    try {
      const context = element.getContext("2d", { willReadFrequently: true });
      if (!context) return "";
      const pixels = context.getImageData(0, 0, element.width, element.height).data;
      const stride = Math.max(4, Math.floor(pixels.length / 4_096 / 4) * 4);
      let first = 2_166_136_261;
      let second = 3_335_555_777;
      let meaningful = 0;
      for (let index = 0; index < pixels.length; index += stride) {
        const red = pixels[index] || 0;
        const green = pixels[index + 1] || 0;
        const blue = pixels[index + 2] || 0;
        const alpha = pixels[index + 3] || 0;
        if (alpha > 0 && (red < 248 || green < 248 || blue < 248)) meaningful += 1;
        for (const component of [red, green, blue, alpha]) {
          first = Math.imul(first ^ component, 16_777_619);
          second = Math.imul(second + component + (second << 6) + (second << 16) - second, 1);
        }
      }
      if (meaningful < 8) return "";
      return `${element.width}x${element.height}:${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
    } catch {
      return "";
    }
  };

  const inspect = (definition, kind) => {
    const element = resolve(definition.locator);
    if (!element) {
      return { name: definition.name, found: false, kind };
    }
    const rect = viewportRect(element);
    const { x, y } = viewportPoint(element);
    const hit = document.elementFromPoint(x, y);
    const visible = isVisible(element);
    const disabled = Boolean(element.disabled || element.getAttribute("aria-disabled") === "true");
    const selected = isSelected(element);
    const result = {
      name: definition.name,
      kind,
      found: true,
      visible,
      enabled: !disabled,
      selected,
      occluded: visible && Boolean(hit && hit !== element && !element.contains(hit)),
      viewportRect: rect,
      viewportPoint: { x, y },
      read: {}
    };
    for (const property of definition.read || []) {
      if (property === "value") result.read.value = String(element.value ?? textOf(element));
      if (property === "text") result.read.text = textOf(element).slice(0, 2_000);
      if (property === "placeholder") result.read.placeholder = String(element.getAttribute("placeholder") ?? "");
      if (property === "disabled") result.read.disabled = disabled;
      if (property === "selected") result.read.selected = selected;
      if (property === "url") result.read.url = location.href.slice(0, 4_000);
      if (property === "canvasSignature") result.read.canvasSignature = canvasSignature(element);
    }
    return result;
  };

  const inspectCollection = (definition) => {
    if (definition.locator?.kind !== "cssAll") {
      return { name: definition.name, found: false, count: 0, items: [], error: "Collection locator must use cssAll." };
    }
    let elements;
    try { elements = Array.from(document.querySelectorAll(definition.locator.selector)); }
    catch (error) {
      return { name: definition.name, found: false, count: 0, items: [], error: error instanceof Error ? error.message : String(error) };
    }
    const limit = Math.max(1, Math.min(Number(definition.limit ?? 100), 500));
    const identityAttribute = (definition.identityAttributes || []).map(String).find((attribute) => {
      const values = elements.map((element) => String(element.getAttribute(attribute) || "").trim());
      return values.length > 0 && values.every(Boolean) && new Set(values).size === values.length;
    }) ?? null;
    const items = elements.slice(0, limit).map((element, index) => {
      const rect = viewportRect(element);
      const { x, y } = viewportPoint(element);
      const hit = document.elementFromPoint(x, y);
      const visible = isVisible(element);
      const disabled = Boolean(element.disabled || element.getAttribute("aria-disabled") === "true");
      const read = {};
      for (const property of definition.read || []) {
        if (property === "text") read.text = textOf(element).slice(0, 4_000);
        if (property === "value") read.value = String(element.value ?? textOf(element)).slice(0, 4_000);
      }
      const identityValue = identityAttribute
        ? String(element.getAttribute(identityAttribute) || "").trim().slice(0, 900)
        : null;
      return {
        index,
        identityKey: identityAttribute ? `${identityAttribute}:${identityValue}` : null,
        identity: identityAttribute ? { attribute: identityAttribute, value: identityValue } : null,
        found: true,
        visible,
        enabled: !disabled,
        occluded: visible && Boolean(hit && hit !== element && !element.contains(hit)),
        viewportRect: rect,
        viewportPoint: { x, y },
        read
      };
    });
    return {
      name: definition.name,
      found: elements.length > 0,
      count: elements.length,
      truncated: elements.length > limit,
      identityAttribute,
      identityUnique: Boolean(identityAttribute),
      items
    };
  };

  const evaluateSignal = (signal) => {
    if (signal.kind === "exists") return Boolean(document.querySelector(signal.selector));
    if (signal.kind === "urlIncludes") return location.href.includes(String(signal.value));
    if (signal.kind === "textIncludes") return textOf(document.body).includes(String(signal.value));
    return false;
  };

  const pageMatches = (descriptor.pages || [])
    .filter((page) => {
      const all = page.all || [];
      const any = page.any || [];
      return all.every(evaluateSignal) && (any.length === 0 || any.some(evaluateSignal));
    })
    .sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0));
  const descriptorActive = pageMatches.length > 0;
  const editableDiagnostics = Array.from(document.querySelectorAll("input, textarea, [contenteditable='true']"))
    .filter(isVisible)
    .slice(0, 30)
    .map((element, index) => ({
      index,
      tag: element.tagName.toLowerCase(),
      type: String(element.getAttribute("type") || ""),
      id: String(element.id || ""),
      name: String(element.getAttribute("name") || ""),
      placeholder: String(element.getAttribute("placeholder") || ""),
      ariaLabel: String(element.getAttribute("aria-label") || ""),
      title: String(element.getAttribute("title") || ""),
      className: String(element.className || "").slice(0, 240),
      viewportRect: viewportRect(element),
      nearbyElements: Array.from(element.parentElement?.parentElement?.children || [])
        .slice(0, 20)
        .map((nearby) => ({
          tag: nearby.tagName.toLowerCase(),
          id: String(nearby.id || ""),
          className: String(nearby.className || "").slice(0, 240),
          role: String(nearby.getAttribute("role") || ""),
          ariaLabel: String(nearby.getAttribute("aria-label") || ""),
          title: String(nearby.getAttribute("title") || ""),
          viewportRect: viewportRect(nearby)
        }))
    }));
  const safeActionTexts = new Set(["搜索", "确定", "取消", "筛选", "收藏", "已收藏", "下一页", "查看更多"]);
  const actionDiagnostics = Array.from(document.querySelectorAll("button, [role='button'], a, span, div"))
    .filter(isVisible)
    .map((element) => ({ element, text: textOf(element) }))
    .filter(({ text }) => safeActionTexts.has(text))
    .slice(0, 30)
    .map(({ element, text }) => ({
      text,
      tag: element.tagName.toLowerCase(),
      id: String(element.id || ""),
      ariaLabel: String(element.getAttribute("aria-label") || ""),
      title: String(element.getAttribute("title") || ""),
      viewportRect: viewportRect(element),
      ancestors: Array.from({ length: 6 }, (_, index) => {
        let ancestor = element;
        for (let depth = 0; depth <= index; depth += 1) ancestor = ancestor?.parentElement;
        return ancestor ? {
          tag: ancestor.tagName.toLowerCase(),
          id: String(ancestor.id || ""),
          className: String(ancestor.className || "").slice(0, 240),
          viewportRect: viewportRect(ancestor)
        } : null;
      }).filter(Boolean)
    }));
  const scrollableDiagnostics = [document.scrollingElement, ...document.querySelectorAll("body *")]
    .filter(Boolean)
    .filter((element) => isVisible(element) && element.scrollHeight > element.clientHeight + 8)
    .slice(0, 40)
    .map((element) => ({
      tag: element.tagName.toLowerCase(),
      id: String(element.id || ""),
      className: String(element.className || "").slice(0, 240),
      viewportRect: viewportRect(element),
      scrollTop: Number(element.scrollTop || 0),
      scrollHeight: Number(element.scrollHeight || 0),
      clientHeight: Number(element.clientHeight || 0)
    }));

  const scrollables = (descriptorActive ? descriptor.scrollables : []).map((definition) => {
    const element = resolve(definition.locator);
    if (!element) return { name: definition.name, found: false };
    const footer = definition.footer ? resolve(definition.footer) : null;
    const scrollTop = Number(element.scrollTop || 0);
    const scrollHeight = Number(element.scrollHeight || 0);
    const clientHeight = Number(element.clientHeight || 0);
    const maximumScrollTop = Math.max(scrollHeight - clientHeight, 0);
    const remaining = Math.max(maximumScrollTop - scrollTop, 0);
    const overlap = Math.min(Math.max(Number(definition.overlapRatio ?? 0.18), 0), 0.8);
    return {
      name: definition.name,
      found: true,
      viewportRect: viewportRect(element),
      viewportPoint: viewportPoint(element),
      scrollTop,
      scrollHeight,
      clientHeight,
      maximumScrollTop,
      remaining,
      canScrollUp: scrollTop > 1,
      canScrollDown: remaining > 2,
      recommendedDeltaY: Math.min(Math.max(Math.round(clientHeight * (1 - overlap)), 80), 2_400),
      footerConfigured: Boolean(definition.footer),
      footerFound: Boolean(footer),
      footerVisible: Boolean(footer && isVisible(footer) && (() => {
        const rect = footer.getBoundingClientRect();
        const container = element.getBoundingClientRect();
        return rect.bottom > container.top && rect.top < container.bottom;
      })())
    };
  });

  return {
    url: location.href,
    title: document.title,
    page: pageMatches[0]?.name ?? "unknown",
    matchedPages: pageMatches.map((page) => page.name),
    viewport: {
      width: innerWidth,
      height: innerHeight,
      devicePixelRatio,
      scrollX,
      scrollY
    },
    screen: {
      x: window.screenX,
      y: window.screenY,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      innerWidth,
      innerHeight
    },
    childFrames: Array.from(document.querySelectorAll("iframe")).slice(0, 40).map((frame) => {
      const rect = frame.getBoundingClientRect();
      return {
        src: String(frame.src || frame.getAttribute("src") || ""),
        name: String(frame.name || ""),
        visible: isVisible(frame),
        contentX: rect.left + Number(frame.clientLeft || 0),
        contentY: rect.top + Number(frame.clientTop || 0),
        width: Number(frame.clientWidth || rect.width || 0),
        height: Number(frame.clientHeight || rect.height || 0)
      };
    }),
    diagnostics: {
      editables: editableDiagnostics,
      safeActions: actionDiagnostics,
      scrollables: scrollableDiagnostics
    },
    fields: (descriptorActive ? descriptor.fields : []).map((definition) => inspect(definition, "field")),
    controls: (descriptorActive ? descriptor.controls : []).map((definition) => inspect(definition, "control")),
    values: (descriptorActive ? descriptor.values : []).map((definition) => inspect(definition, "value")),
    collections: (descriptorActive ? descriptor.collections : []).map(inspectCollection),
    scrollables
  };
}
