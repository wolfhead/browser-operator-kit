import assert from "node:assert/strict";
import test from "node:test";
import { observeDocument } from "../extension/observer/runtime.js";

class FakeElement {
  constructor({ tagName = "DIV", rect = { x: 0, y: 0, width: 800, height: 600 } } = {}) {
    this.tagName = tagName;
    this.rect = rect;
    this.id = "";
    this.className = "";
    this.innerText = "";
    this.textContent = "";
    this.parentElement = null;
    this.clientWidth = rect.width;
    this.clientHeight = rect.height;
    this.scrollWidth = rect.width;
    this.scrollHeight = rect.height;
    this.scrollTop = 0;
  }

  getBoundingClientRect() {
    return {
      ...this.rect,
      top: this.rect.y,
      left: this.rect.x,
      right: this.rect.x + this.rect.width,
      bottom: this.rect.y + this.rect.height,
    };
  }

  getAttribute() { return null; }
  matches() { return false; }
  querySelector() { return null; }
  contains(other) { return other === this; }
}

class FakeCanvas extends FakeElement {
  constructor({ width, height, context }) {
    super({ tagName: "CANVAS", rect: { x: 0, y: 0, width: 773, height: 659 } });
    this.width = width;
    this.height = height;
    this.context = context;
  }

  getContext() { return this.context; }
}

test("Canvas signature remains available for sparse rendered text", (context) => {
  const previousGlobals = Object.fromEntries([
    "Element", "HTMLCanvasElement", "document", "getComputedStyle", "innerWidth",
    "innerHeight", "devicePixelRatio", "location", "screenX", "screenY",
    "outerWidth", "outerHeight", "scrollX", "scrollY", "window",
  ].map((name) => [name, globalThis[name]]));
  context.after(() => {
    for (const [name, value] of Object.entries(previousGlobals)) globalThis[name] = value;
  });

  const width = 1_546;
  const height = 1_318;
  const sourcePixels = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let pixel = 100; pixel < 124; pixel += 1) {
    const offset = pixel * 4;
    sourcePixels[offset] = 20;
    sourcePixels[offset + 1] = 20;
    sourcePixels[offset + 2] = 20;
  }
  const source = new FakeCanvas({
    width,
    height,
    context: { getImageData: () => ({ data: sourcePixels }) },
  });
  source.id = "resume";

  const root = new FakeElement();
  const sampleContext = {
    drawImage() {},
    clearRect() {},
    getImageData(_x, _y, sampleWidth, sampleHeight) {
      const pixels = new Uint8ClampedArray(sampleWidth * sampleHeight * 4).fill(255);
      for (let pixel = 10; pixel < 34; pixel += 1) {
        const offset = pixel * 4;
        pixels[offset] = 180;
        pixels[offset + 1] = 180;
        pixels[offset + 2] = 180;
      }
      return { data: pixels };
    },
  };

  globalThis.Element = FakeElement;
  globalThis.HTMLCanvasElement = FakeCanvas;
  globalThis.innerWidth = 800;
  globalThis.innerHeight = 600;
  globalThis.devicePixelRatio = 1;
  globalThis.location = { href: "https://example.test/resume" };
  globalThis.screenX = 0;
  globalThis.screenY = 0;
  globalThis.outerWidth = 800;
  globalThis.outerHeight = 700;
  globalThis.scrollX = 0;
  globalThis.scrollY = 0;
  globalThis.window = globalThis;
  globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1" });
  globalThis.document = {
    body: root,
    documentElement: root,
    scrollingElement: root,
    elementFromPoint: () => source,
    querySelector: (selector) => selector === "canvas" ? source : null,
    querySelectorAll: () => [],
    createElement: (tagName) => {
      assert.equal(tagName, "canvas");
      return new FakeCanvas({ width: 1, height: 1, context: sampleContext });
    },
  };

  const observation = observeDocument({
    pages: [{ name: "resume", any: [{ kind: "exists", selector: "canvas" }] }],
    fields: [],
    controls: [],
    values: [{ name: "resume.identity", locator: { kind: "css", selector: "canvas" }, read: ["canvasSignature"] }],
    collections: [],
    scrollables: [],
  });

  assert.match(observation.values[0].read.canvasSignature, /^1546x1318:[0-9a-f]{16}$/);
});
