import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin") {
  console.log("Skipped macOS native helper build on this platform; set WEB_AUTOMATION_INPUT_HELPER_PATH to a compatible helper.");
  process.exit(0);
}

const outputDirectory = path.join(packageRoot, "native-helper", "macos", ".build");
await mkdir(outputDirectory, { recursive: true });
await run("swiftc", [
  path.join(packageRoot, "native-helper", "macos", "WebInputHelper.swift"),
  "-o",
  path.join(outputDirectory, "web-input-helper")
]);
console.log("Built generic macOS native input helper.");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: packageRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0
      ? resolve()
      : reject(new Error(signal ? `${command} terminated by ${signal}.` : `${command} exited with code ${code}.`)));
  });
}
