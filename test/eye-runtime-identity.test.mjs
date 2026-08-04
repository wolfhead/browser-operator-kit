import assert from "node:assert/strict";
import test from "node:test";
import { chooseUniqueIdentityAttribute } from "../extension/eye/runtime.js";

const element = (attributes) => ({
  getAttribute(name) { return attributes[name] ?? null; }
});

test("collection identity chooses the first attribute that is non-empty and globally unique", () => {
  const elements = [
    element({ href: "/same", "data-lid": "a" }),
    element({ href: "/same", "data-lid": "b" }),
    element({ href: "/same", "data-lid": "c" })
  ];
  assert.equal(chooseUniqueIdentityAttribute(elements, ["missing", "href", "data-lid"]), "data-lid");
});

test("collection identity refuses partial or duplicated attributes", () => {
  const elements = [
    element({ "data-id": "same", "data-lid": "a" }),
    element({ "data-id": "same" })
  ];
  assert.equal(chooseUniqueIdentityAttribute(elements, ["data-id", "data-lid"]), null);
});
