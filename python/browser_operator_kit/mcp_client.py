from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
from collections import deque
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence


class McpError(RuntimeError):
    pass


class StdioMcpClient:
    def __init__(
        self,
        command: Sequence[str],
        *,
        cwd: str | os.PathLike[str] | None = None,
        env: Mapping[str, str] | None = None,
        request_timeout: float = 90.0,
        protocol_version: str = "2025-11-25",
        stderr_listener: Callable[[str], None] | None = None,
    ) -> None:
        if not command:
            raise ValueError("command must not be empty")
        self.command = [str(item) for item in command]
        self.cwd = str(Path(cwd).resolve()) if cwd is not None else None
        self.env = dict(env) if env is not None else None
        self.request_timeout = request_timeout
        self.protocol_version = protocol_version
        self.stderr_listener = stderr_listener
        self._process: subprocess.Popen[str] | None = None
        self._messages: queue.Queue[dict[str, Any] | None] = queue.Queue()
        self._pending: dict[int, dict[str, Any]] = {}
        self._stderr = deque(maxlen=200)
        self._next_id = 1
        self._write_lock = threading.Lock()

    def start(self) -> "StdioMcpClient":
        if self._process is not None:
            return self
        environment = os.environ.copy()
        if self.env:
            environment.update(self.env)
        self._process = subprocess.Popen(
            self.command,
            cwd=self.cwd,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
            shell=False,
        )
        threading.Thread(target=self._read_stdout, name="mcp-stdout", daemon=True).start()
        threading.Thread(target=self._read_stderr, name="mcp-stderr", daemon=True).start()
        self.request(
            "initialize",
            {
                "protocolVersion": self.protocol_version,
                "capabilities": {},
                "clientInfo": {"name": "python-operation-bot", "version": "0.1.0"},
            },
        )
        self.notify("notifications/initialized", {})
        return self

    def list_tools(self) -> list[dict[str, Any]]:
        result = self.request("tools/list", {})
        return list(result.get("tools", []))

    def call_tool(self, name: str, arguments: Mapping[str, Any] | None = None) -> dict[str, Any]:
        if not name:
            raise ValueError("tool name must not be empty")
        return self.request("tools/call", {"name": name, "arguments": dict(arguments or {})})

    def request(self, method: str, params: Mapping[str, Any]) -> dict[str, Any]:
        self._require_process()
        request_id = self._next_id
        self._next_id += 1
        self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": dict(params)})
        message = self._wait_for_response(request_id)
        if "error" in message:
            error = message["error"]
            raise McpError(f"MCP {method} failed ({error.get('code')}): {error.get('message')}")
        result = message.get("result")
        if not isinstance(result, dict):
            raise McpError(f"MCP {method} returned a non-object result")
        return result

    def notify(self, method: str, params: Mapping[str, Any]) -> None:
        self._require_process()
        self._send({"jsonrpc": "2.0", "method": method, "params": dict(params)})

    @property
    def stderr_tail(self) -> list[str]:
        return list(self._stderr)

    def close(self) -> None:
        process = self._process
        self._process = None
        if process is None:
            return
        if process.stdin:
            process.stdin.close()
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
        if process.stdout:
            process.stdout.close()
        if process.stderr:
            process.stderr.close()

    def __enter__(self) -> "StdioMcpClient":
        return self.start()

    def __exit__(self, _error_type: Any, _error: Any, _traceback: Any) -> None:
        self.close()

    def _send(self, message: Mapping[str, Any]) -> None:
        process = self._require_process()
        if not process.stdin:
            raise McpError("MCP stdin is unavailable")
        line = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
        with self._write_lock:
            process.stdin.write(line + "\n")
            process.stdin.flush()

    def _wait_for_response(self, request_id: int) -> dict[str, Any]:
        if request_id in self._pending:
            return self._pending.pop(request_id)
        while True:
            try:
                message = self._messages.get(timeout=self.request_timeout)
            except queue.Empty as error:
                raise McpError(f"MCP request {request_id} timed out; stderr: {self.stderr_tail[-5:]}") from error
            if message is None:
                process = self._process
                code = process.poll() if process else None
                raise McpError(f"MCP process exited with code {code}; stderr: {self.stderr_tail[-5:]}")
            response_id = message.get("id")
            if isinstance(response_id, int):
                if response_id == request_id:
                    return message
                self._pending[response_id] = message

    def _read_stdout(self) -> None:
        process = self._process
        if not process or not process.stdout:
            self._messages.put(None)
            return
        for raw_line in process.stdout:
            line = raw_line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError as error:
                self._stderr.append(f"invalid MCP stdout: {error}: {line[:300]}")
                continue
            if isinstance(message, dict):
                self._messages.put(message)
        self._messages.put(None)

    def _read_stderr(self) -> None:
        process = self._process
        if not process or not process.stderr:
            return
        for raw_line in process.stderr:
            line = raw_line.rstrip()
            self._stderr.append(line)
            if self.stderr_listener is not None:
                try:
                    self.stderr_listener(line)
                except Exception as error:
                    self._stderr.append(
                        f"stderr listener failed: {type(error).__name__}: {error}"
                    )

    def _require_process(self) -> subprocess.Popen[str]:
        if self._process is None:
            raise McpError("MCP client has not been started")
        if self._process.poll() is not None:
            raise McpError(f"MCP process has exited with code {self._process.returncode}; stderr: {self.stderr_tail[-5:]}")
        return self._process
