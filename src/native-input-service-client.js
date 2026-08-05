import { randomUUID } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const DEFAULT_NATIVE_INPUT_SERVICE_MAX_MESSAGE_BYTES = 65_536;

export function defaultNativeInputServiceSocketPath(homeDirectory = os.homedir()) {
  return path.join(
    homeDirectory,
    "Library",
    "Application Support",
    "Browser Operator Kit",
    "input-helper.sock"
  );
}

export class NativeInputServiceClient {
  constructor({
    socketPath = defaultNativeInputServiceSocketPath(),
    requestTimeoutMs = 20_000,
    maxMessageBytes = DEFAULT_NATIVE_INPUT_SERVICE_MAX_MESSAGE_BYTES
  } = {}) {
    if (!path.isAbsolute(socketPath)) {
      throw new Error("Native input service socketPath must be absolute.");
    }
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
      throw new Error("Native input service requestTimeoutMs must be a positive integer.");
    }
    if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1_024) {
      throw new Error("Native input service maxMessageBytes must be at least 1024.");
    }
    this.socketPath = socketPath;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxMessageBytes = maxMessageBytes;
  }

  async invoke(argumentsList, { timeout = this.requestTimeoutMs } = {}) {
    validateArguments(argumentsList);
    if (!Number.isSafeInteger(timeout) || timeout < 1) {
      throw new Error("Native input service timeout must be a positive integer.");
    }

    const id = randomUUID();
    const encodedRequest = Buffer.from(`${JSON.stringify({
      version: 1,
      id,
      arguments: argumentsList
    })}\n`, "utf8");
    if (encodedRequest.byteLength > this.maxMessageBytes) {
      throw new Error(`Native input service request exceeds ${this.maxMessageBytes} bytes.`);
    }

    const response = await exchange({
      socketPath: this.socketPath,
      encodedRequest,
      timeout,
      maxMessageBytes: this.maxMessageBytes
    });
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new Error("Native input service returned an invalid response object.");
    }
    if (response.version !== 1) {
      throw new Error("Native input service returned an unsupported protocol version.");
    }
    if (response.id !== id) {
      throw new Error("Native input service response id did not match the request.");
    }
    if (response.ok !== true) {
      throw new Error(
        typeof response.error === "string" && response.error.trim()
          ? response.error.trim()
          : "Native input service rejected the request."
      );
    }
    if (typeof response.output !== "string") {
      throw new Error("Native input service response output must be a string.");
    }
    return { stdout: response.output, stderr: "" };
  }
}

function validateArguments(argumentsList) {
  if (!Array.isArray(argumentsList) || argumentsList.length < 1 || argumentsList.length > 32) {
    throw new Error("Native input service arguments must contain 1 to 32 entries.");
  }
  for (const argument of argumentsList) {
    if (typeof argument !== "string") {
      throw new Error("Native input service arguments must be strings.");
    }
    if (argument.includes("\u0000")) {
      throw new Error("Native input service arguments cannot contain NUL bytes.");
    }
  }
}

function exchange({ socketPath, encodedRequest, timeout, maxMessageBytes }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    let buffered = Buffer.alloc(0);

    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(response);
    };

    socket.setTimeout(timeout);
    socket.on("connect", () => socket.write(encodedRequest));
    socket.on("timeout", () => {
      finish(new Error(`Native input service timed out after ${timeout}ms.`));
    });
    socket.on("error", (error) => {
      finish(new Error(`Native input service connection failed: ${error.message}`));
    });
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.byteLength > maxMessageBytes) {
        finish(new Error(`Native input service response exceeds ${maxMessageBytes} bytes.`));
        return;
      }
      const newlineIndex = buffered.indexOf(0x0a);
      if (newlineIndex < 0) return;
      if (buffered.subarray(newlineIndex + 1).some((byte) => ![0x0a, 0x0d, 0x20, 0x09].includes(byte))) {
        finish(new Error("Native input service returned trailing response data."));
        return;
      }
      try {
        finish(null, JSON.parse(buffered.subarray(0, newlineIndex).toString("utf8")));
      } catch (error) {
        finish(new Error(`Native input service returned invalid JSON: ${error.message}`));
      }
    });
    socket.on("end", () => {
      if (!settled) finish(new Error("Native input service closed before returning a complete response."));
    });
  });
}
