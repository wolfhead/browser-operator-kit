import assert from "node:assert/strict";
import test from "node:test";
import { screenPointFromPageGeometry } from "../extension/eye/geometry.js";

test("page geometry maps to a native screen point at the current Chrome zoom", () => {
  assert.deepEqual(screenPointFromPageGeometry({
    viewportPoint: { x: 500, y: 300 },
    screen: { x: 50, y: 40, outerWidth: 1_200, outerHeight: 900, innerWidth: 1_100, innerHeight: 760 }
  }, 1), { x: 566, y: 480 });
  assert.deepEqual(screenPointFromPageGeometry({
    viewportPoint: { x: 400, y: 250 },
    screen: { x: 20, y: 30, outerWidth: 1_400, outerHeight: 900, innerWidth: 1_080, innerHeight: 650 }
  }, 1.25), { x: 536, y: 430 });
});

test("page geometry does not mistake a right-side Chrome panel for a symmetric inset", () => {
  assert.deepEqual(screenPointFromPageGeometry({
    viewportPoint: { x: 700, y: 400 },
    screen: { x: 0, y: 24, outerWidth: 1_440, outerHeight: 900, innerWidth: 1_020, innerHeight: 760 }
  }, 1), { x: 716, y: 564 });
});
