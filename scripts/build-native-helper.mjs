import { spawn } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin") {
  console.log("Skipped macOS native helper build on this platform; set WEB_AUTOMATION_INPUT_HELPER_PATH to a compatible helper.");
  process.exit(0);
}

const outputDirectory = path.join(packageRoot, "native-helper", "macos", ".build");
const outputPath = path.join(outputDirectory, "web-input-helper");
const appName = "Browser Operator Input Service.app";
const appPath = path.join(outputDirectory, appName);
const appContentsPath = path.join(appPath, "Contents");
const appExecutableDirectory = path.join(appContentsPath, "MacOS");
const appExecutablePath = path.join(appExecutableDirectory, "web-input-helper");
const bundleIdentifier = "com.github.wolfhead.browser-operator-kit.input-service";
const codesignIdentity = process.env.WEB_AUTOMATION_CODESIGN_IDENTITY?.trim() || "-";
await mkdir(outputDirectory, { recursive: true });
await run("swiftc", [
  path.join(packageRoot, "native-helper", "macos", "WebInputHelper.swift"),
  "-o",
  outputPath
]);
await run("codesign", [
  "--force",
  "--sign", "-",
  "--identifier", "com.github.wolfhead.browser-operator-kit.web-input-helper",
  outputPath
]);
await rm(appPath, { recursive: true, force: true });
await mkdir(appExecutableDirectory, { recursive: true });
await copyFile(outputPath, appExecutablePath);
await writeFile(path.join(appContentsPath, "Info.plist"), infoPlist({
  bundleIdentifier,
  executableName: path.basename(appExecutablePath)
}));
await run("codesign", [
  "--force",
  "--sign", codesignIdentity,
  "--identifier", bundleIdentifier,
  appPath
]);
await run("codesign", ["--verify", "--deep", "--strict", appPath]);
console.log(`Built generic macOS native input helper and '${appName}'.`);

function infoPlist({ bundleIdentifier, executableName }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>Browser Operator Input Service</string>
  <key>CFBundleExecutable</key>
  <string>${executableName}</string>
  <key>CFBundleIdentifier</key>
  <string>${bundleIdentifier}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Browser Operator Input Service</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSAccessibilityUsageDescription</key>
  <string>Browser Operator Kit uses authorized native input only for guarded browser actions.</string>
</dict>
</plist>
`;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: packageRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0
      ? resolve()
      : reject(new Error(signal ? `${command} terminated by ${signal}.` : `${command} exited with code ${code}.`)));
  });
}
