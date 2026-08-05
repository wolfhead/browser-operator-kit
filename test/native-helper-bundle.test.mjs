import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const appPath = path.resolve(
  "native-helper/macos/.build/Browser Operator Input Service.app"
);

test("macOS build emits a background native input service App", {
  skip: process.platform !== "darwin"
}, async () => {
  const executablePath = path.join(appPath, "Contents/MacOS/web-input-helper");
  const plistPath = path.join(appPath, "Contents/Info.plist");
  await access(executablePath);
  const plist = await readFile(plistPath, "utf8");

  assert.match(
    plist,
    /<string>com\.github\.wolfhead\.browser-operator-kit\.input-service<\/string>/
  );
  assert.match(plist, /<key>LSUIElement<\/key>\s*<true\/>/);
});
