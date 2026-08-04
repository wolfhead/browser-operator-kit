import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

export const BRIDGE_PROTOCOL_VERSION = 1;
export const DEFAULT_BRIDGE_HOST = "127.0.0.1";
export const DEFAULT_BRIDGE_PORT = 38492;

export class BridgeServer {
  constructor({
    host = DEFAULT_BRIDGE_HOST,
    port = DEFAULT_BRIDGE_PORT,
    requestTimeoutMs = 45_000,
    extensionRequestHandler = null,
    logger = () => {}
  } = {}) {
    if (host !== DEFAULT_BRIDGE_HOST) {
      throw new Error("The automation bridge must bind only to 127.0.0.1.");
    }

    this.host = host;
    this.port = port;
    this.requestTimeoutMs = requestTimeoutMs;
    this.extensionRequestHandler = extensionRequestHandler;
    this.logger = logger;
    this.server = null;
    this.socket = null;
    this.extensionOrigin = null;
    this.connectedAt = null;
    this.pending = new Map();
    this.connectionWaiters = new Set();
    this.heartbeat = null;
  }

  async start() {
    if (this.server) {
      return this.address();
    }

    this.server = new WebSocketServer({
      host: this.host,
      port: this.port,
      verifyClient: ({ origin }, accept) => {
        const accepted = origin === undefined || origin.startsWith("chrome-extension://");
        accept(accepted, 403, "Only local extension bridge clients are allowed");
      }
    });

    this.server.on("connection", (socket, request) => {
      this.attachSocket(socket, request.headers.origin ?? "local-client-without-origin");
    });
    this.server.on("error", (error) => {
      this.logger("error", "bridge_server_error", { message: error.message });
    });

    await new Promise((resolve, reject) => {
      const onListening = () => {
        this.server.off("error", onStartupError);
        resolve();
      };
      const onStartupError = (error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      this.server.once("listening", onListening);
      this.server.once("error", onStartupError);
    });

    this.heartbeat = setInterval(() => this.runHeartbeat(), 20_000);
    this.heartbeat.unref?.();
    this.logger("info", "bridge_listening", this.address());
    return this.address();
  }

  address() {
    const address = this.server?.address();
    return {
      host: this.host,
      port: typeof address === "object" && address ? address.port : this.port
    };
  }

  status() {
    return {
      connected: this.socket?.readyState === WebSocket.OPEN,
      extensionOrigin: this.extensionOrigin,
      connectedAt: this.connectedAt,
      ...this.address()
    };
  }

  async request(command, params = {}, timeoutMs = this.requestTimeoutMs) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Chrome extension is not connected to the local automation bridge.");
    }

    const id = randomUUID();
    const payload = {
      type: "request",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      id,
      command,
      params
    };

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Extension command timed out: ${command}`));
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(id, { command, resolve, reject, timer });
      this.socket.send(JSON.stringify(payload), (error) => {
        if (!error) {
          this.logger("debug", "bridge_request_sent", { command, requestId: id });
          return;
        }
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async waitForConnection(timeoutMs = 15_000) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return this.status();
    }
    return await new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(waiter.timer);
          this.connectionWaiters.delete(waiter);
          resolve(this.status());
        },
        reject: (error) => {
          clearTimeout(waiter.timer);
          this.connectionWaiters.delete(waiter);
          reject(error);
        },
        timer: null
      };
      waiter.timer = setTimeout(() => {
        waiter.reject(new Error("Chrome extension did not connect to the local automation bridge in time."));
      }, timeoutMs);
      waiter.timer.unref?.();
      this.connectionWaiters.add(waiter);
    });
  }

  async stop() {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.rejectPending(new Error("Automation bridge stopped."));
    this.rejectConnectionWaiters(new Error("Automation bridge stopped."));
    this.socket?.close(1001, "Bridge stopped");
    this.socket = null;

    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
  }

  attachSocket(socket, origin) {
    if (this.socket && this.socket !== socket) {
      this.socket.close(1012, "A newer extension connection replaced this one.");
    }

    this.rejectPending(new Error("Chrome extension reconnected before the command completed."));
    this.socket = socket;
    this.extensionOrigin = origin;
    this.connectedAt = new Date().toISOString();
    for (const waiter of this.connectionWaiters) {
      waiter.resolve();
    }
    socket.isAlive = true;
    socket.on("pong", () => {
      socket.isAlive = true;
    });
    socket.on("message", (raw) => {
      void this.handleMessage(raw).catch((error) => {
        this.logger("error", "bridge_message_handler_error", {
          message: error instanceof Error ? error.message : String(error)
        });
      });
    });
    socket.on("close", () => this.detachSocket(socket));
    socket.on("error", (error) => {
      this.logger("warn", "bridge_socket_error", { message: error.message });
    });
    socket.send(JSON.stringify({
      type: "bridge.hello",
      protocolVersion: BRIDGE_PROTOCOL_VERSION
    }));
    this.logger("info", "extension_connected", { origin });
  }

  detachSocket(socket) {
    if (this.socket !== socket) {
      return;
    }
    this.socket = null;
    this.extensionOrigin = null;
    this.connectedAt = null;
    this.rejectPending(new Error("Chrome extension disconnected."));
    this.logger("info", "extension_disconnected", {});
  }

  async handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      this.logger("warn", "bridge_invalid_json", {});
      return;
    }

    if (
      message?.type === "native.request" &&
      message.protocolVersion === BRIDGE_PROTOCOL_VERSION &&
      typeof message.id === "string"
    ) {
      await this.handleExtensionRequest(message);
      return;
    }

    if (
      message?.type === "bridge.pong" &&
      message.protocolVersion === BRIDGE_PROTOCOL_VERSION
    ) {
      if (this.socket) {
        this.socket.isAlive = true;
      }
      return;
    }

    if (
      message?.type !== "response" ||
      message.protocolVersion !== BRIDGE_PROTOCOL_VERSION ||
      typeof message.id !== "string"
    ) {
      this.logger("warn", "bridge_invalid_message", { type: message?.type ?? "unknown" });
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.ok) {
      this.logger("debug", "bridge_response_received", {
        command: pending.command,
        requestId: message.id
      });
      pending.resolve(message.result);
      return;
    }

    pending.reject(new Error(message.error || `Extension command failed: ${pending.command}`));
  }

  async handleExtensionRequest(message) {
    if (!this.socket || typeof this.extensionRequestHandler !== "function") {
      this.sendExtensionResponse(message.id, false, null, "Native input is unavailable.");
      return;
    }
    try {
      const result = await this.extensionRequestHandler(message.action);
      this.sendExtensionResponse(message.id, true, result, null);
    } catch (error) {
      this.sendExtensionResponse(
        message.id,
        false,
        null,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  sendExtensionResponse(id, ok, result, error) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify({
      type: "native.response",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      id,
      ok,
      result,
      error
    }));
  }

  runHeartbeat() {
    if (!this.socket) {
      return;
    }
    if (!this.socket.isAlive) {
      this.socket.terminate();
      return;
    }
    this.socket.isAlive = false;
    this.socket.send(JSON.stringify({
      type: "bridge.ping",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      timestamp: Date.now()
    }));
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }


  rejectConnectionWaiters(error) {
    for (const waiter of this.connectionWaiters) {
      waiter.reject(error);
    }
    this.connectionWaiters.clear();
  }
}
