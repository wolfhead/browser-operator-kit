import assert from "node:assert/strict";
import test from "node:test";
import { buildFrameOffsets, chooseBestScrollableTarget, chooseBestTarget } from "../extension/eye/frame-geometry.js";

test("frame offsets map a unique child-frame URL into top viewport coordinates", () => {
  const offsets = buildFrameOffsets([
    {
      frameId: 0,
      url: "https://example.test/root",
      childFrames: [{ src: "https://example.test/frame/search", visible: true, contentX: 120, contentY: 80 }]
    },
    { frameId: 42, url: "https://example.test/frame/search", childFrames: [] }
  ]);
  assert.deepEqual(offsets.get(0), { x: 0, y: 0 });
  assert.deepEqual(offsets.get(42), { x: 120, y: 80 });
});

test("target merge prefers a found actionable iframe target over later misses", () => {
  const selected = chooseBestTarget([
    { name: "search.keywords", found: false, frameId: 0 },
    { name: "search.keywords", found: true, visible: true, enabled: true, coordinateReady: true, frameId: 42 },
    { name: "search.keywords", found: false, frameId: 99 }
  ]);
  assert.equal(selected.frameId, 42);
  assert.equal(selected.coordinateReady, true);
});

test("scrollable merge prefers the frame with real scroll range over the top frame bonus", () => {
  const chosen = chooseBestScrollableTarget([
    { found: true, coordinateReady: true, frameId: 0, maximumScrollTop: 9 },
    { found: true, coordinateReady: true, frameId: 12, maximumScrollTop: 2_656 }
  ]);
  assert.equal(chosen.frameId, 12);
});
