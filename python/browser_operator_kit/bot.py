from __future__ import annotations

from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from .mcp_client import McpError, StdioMcpClient


class OperationBot:
    def __init__(self, client: StdioMcpClient) -> None:
        self.client = client

    @classmethod
    def launch(
        cls,
        project_root: str | Path,
        *,
        command: Sequence[str] | None = None,
        environment: Mapping[str, str] | None = None,
        stderr_listener: Callable[[str], None] | None = None,
    ) -> "OperationBot":
        root = Path(project_root).resolve()
        server_command = list(command or ["node", str(root / "dist" / "server" / "command-orchestrator-server.mjs")])
        client = StdioMcpClient(
            server_command,
            cwd=root,
            env=environment,
            stderr_listener=stderr_listener,
        )
        return cls(client)

    def start(self) -> "OperationBot":
        self.client.start()
        return self

    def list_operations(self) -> list[dict[str, Any]]:
        result = self.client.call_tool("web_list_operations", {})
        structured = self._structured_content(result)
        return list(structured.get("operations", []))

    def execute(self, operation_name: str, params: Mapping[str, Any] | None = None) -> dict[str, Any]:
        result = self.client.call_tool(
            "web_execute_operation",
            {"name": operation_name, "parameters": dict(params or {})},
        )
        if result.get("isError") is True:
            raise McpError(self._text_content(result) or f"Operation '{operation_name}' failed")
        structured = self._structured_content(result)
        report = structured.get("report")
        if isinstance(report, dict) and report.get("ok") is False:
            error = report.get("error")
            if isinstance(error, dict):
                code = str(error.get("code") or "OPERATION_FAILED")
                message = str(error.get("message") or f"Operation '{operation_name}' failed")
                raise McpError(f"{code}: {message}")
            raise McpError(f"Operation '{operation_name}' failed")
        return structured

    def close(self) -> None:
        self.client.close()

    def __enter__(self) -> "OperationBot":
        return self.start()

    def __exit__(self, _error_type: Any, _error: Any, _traceback: Any) -> None:
        self.close()

    @staticmethod
    def _structured_content(result: Mapping[str, Any]) -> dict[str, Any]:
        value = result.get("structuredContent")
        if not isinstance(value, dict):
            raise McpError("MCP tool did not return structuredContent")
        return value

    @staticmethod
    def _text_content(result: Mapping[str, Any]) -> str:
        return "\n".join(
            str(item.get("text", ""))
            for item in result.get("content", [])
            if isinstance(item, dict) and item.get("type") == "text"
        )
