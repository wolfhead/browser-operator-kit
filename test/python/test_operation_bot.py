import sys
import threading
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT / "python"))

from browser_operator_kit import McpError, OperationBot, StdioMcpClient  # noqa: E402


class OperationBotTest(unittest.TestCase):
    def make_bot(self):
        fake_server = PROJECT_ROOT / "test" / "python" / "fake_operation_mcp.py"
        client = StdioMcpClient([sys.executable, str(fake_server)], cwd=PROJECT_ROOT, request_timeout=3)
        return OperationBot(client)

    def test_execute_passes_nested_kwargs_to_one_named_operation(self):
        with self.make_bot() as bot:
            result = bot.execute("demo_search", {
                "keywords": "alpha beta",
                "filters": {
                    "mode": "thorough",
                    "tags": ["alpha", "beta"],
                },
            })
        self.assertEqual(result["operation"], "demo_search")
        self.assertEqual(result["parameters"]["filters"]["tags"], ["alpha", "beta"])
        self.assertTrue(result["report"]["ok"])

    def test_list_operations_returns_registered_business_primitives(self):
        with self.make_bot() as bot:
            operations = bot.list_operations()
        self.assertEqual(operations, [{"name": "demo_search", "kind": "composite"}])

    def test_execute_raises_when_operation_report_fails(self):
        with self.make_bot() as bot:
            with self.assertRaisesRegex(McpError, "POSTCONDITION_FAILED.*expected result did not load"):
                bot.execute("failing_operation")

    def test_stderr_listener_receives_structured_server_progress(self):
        fake_server = PROJECT_ROOT / "test" / "python" / "fake_operation_mcp.py"
        lines = []
        received = threading.Event()

        def listener(line):
            lines.append(line)
            received.set()

        client = StdioMcpClient(
            [sys.executable, str(fake_server)],
            cwd=PROJECT_ROOT,
            request_timeout=3,
            stderr_listener=listener,
        )
        with OperationBot(client) as bot:
            bot.execute("demo_search", {"keywords": "alpha", "filters": {}})
            self.assertTrue(received.wait(timeout=1))
        self.assertTrue(any("fake_operation_called" in line for line in lines))


if __name__ == "__main__":
    unittest.main()
