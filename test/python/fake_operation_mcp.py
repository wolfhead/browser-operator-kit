import json
import sys


def send(message):
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    message = json.loads(line)
    if "id" not in message:
        continue
    request_id = message["id"]
    method = message.get("method")
    if method == "initialize":
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": message["params"]["protocolVersion"],
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "fake-operation-server", "version": "0.1.0"},
            },
        })
    elif method == "tools/list":
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "tools": [{"name": "web_execute_operation"}, {"name": "web_list_operations"}]
            },
        })
    elif method == "tools/call":
        sys.stderr.write(json.dumps({"event": "fake_operation_called"}) + "\n")
        sys.stderr.flush()
        params = message["params"]
        if params["name"] == "web_list_operations":
            structured = {"operations": [{"name": "demo_search", "kind": "composite"}]}
        else:
            arguments = params["arguments"]
            structured = {
                "operation": arguments["name"],
                "kind": "composite",
                "parameters": arguments["parameters"],
                "report": {
                    "ok": arguments["name"] != "failing_operation",
                    "error": None if arguments["name"] != "failing_operation" else {
                        "code": "POSTCONDITION_FAILED",
                        "stage": "postcondition",
                        "message": "expected result did not load",
                    },
                },
            }
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "structuredContent": structured,
                "content": [{"type": "text", "text": "ok"}],
            },
        })
    else:
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": -32601, "message": f"Unknown method {method}"},
        })
