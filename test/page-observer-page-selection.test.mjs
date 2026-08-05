import assert from "node:assert/strict";
import test from "node:test";
import { chooseCurrentPage } from "../extension/observer/engine.js";

const descriptors = [{
  pages: [
    { name: "search", priority: 100 },
    { name: "resume", priority: 200 }
  ]
}];

test("page selection ignores a higher-priority page inside a hidden iframe", () => {
  const observations = [
    {
      frameId: 0,
      page: "search",
      url: "https://example.test/search",
      childFrames: [{
        src: "https://example.test/resume",
        visible: false,
        contentX: 0,
        contentY: 0
      }]
    },
    {
      frameId: 7,
      page: "resume",
      url: "https://example.test/resume",
      childFrames: []
    }
  ];

  assert.equal(chooseCurrentPage(observations, descriptors)?.page, "search");
});

test("page selection includes a higher-priority page inside a visible iframe", () => {
  const observations = [
    {
      frameId: 0,
      page: "search",
      url: "https://example.test/search",
      childFrames: [{
        src: "https://example.test/resume",
        visible: true,
        contentX: 20,
        contentY: 80
      }]
    },
    {
      frameId: 7,
      page: "resume",
      url: "https://example.test/resume",
      childFrames: []
    }
  ];

  assert.equal(chooseCurrentPage(observations, descriptors)?.page, "resume");
});
