# Browser Operator Kit

Browser Operator Kit is a descriptor-driven browser automation foundation for Chrome on macOS. It separates observation, native input, and orchestration into three explicit roles:

```text
Page Observer (Chrome extension, read-only state)
  ↓ named targets and fresh geometry
Command Orchestrator (MCP, Python, or another controller)
  ↓ guarded command
Native Input Driver (native macOS input)
  ↓ real mouse, paste, or wheel event
Page Observer (postcondition verification)
```

The extension also acts as a visible status board. It shows the detected page, registered fields and controls, bridge health, run state, current step, and reverse-chronological logs.

## Why the split matters

Page Observer never clicks, types, scrolls, changes focus, or claims that an action succeeded. Native Input Driver knows nothing about the page DOM. Command Orchestrator joins them through an Observe → Act → Verify command with an expected page, preconditions, a registered target, a foreground policy, one action, and postconditions. The browser is foregrounded only for the native action and verification window, then the previous application is restored unless another person or application has taken over.

## Requirements

- macOS 13 or newer
- Node.js 20 or newer
- Swift toolchain
- Google Chrome
- Accessibility permission for `native-helper/macos/.build/web-input-helper`

Windows is not implemented yet. The operation and Page Observer layers are platform-independent; a Windows Native Input Driver can implement the same native helper contract later.

## Quick start

```bash
npm install
npm run check
```

This builds:

- `dist/extension`: the single generic Chrome extension used by every adapter
- `dist/demo-extension`: a generic test build pinned to the isolated demo bridge
- `dist/server`: bundled Page Observer, Native Input Driver, and Command Orchestrator MCP servers
- `native-helper/macos/.build/web-input-helper`: the native input helper

For normal use, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the absolute `browser-operator-kit/dist/extension` directory. The extension contains no site descriptors or site permissions. A connected local Adapter service registers descriptors at runtime, and the Side Panel asks the user to grant only the declared sites.

The isolated demo acceptance loads `dist/demo-extension` automatically. Start the neutral fixture with:

```bash
python3 -m http.server 8765 --bind 127.0.0.1 --directory demo/site
```

Open `http://127.0.0.1:8765/`, open the extension Side Panel, and run:

```bash
npm run accept:demo
```

The isolated acceptance uses Chrome for Testing, a temporary profile, bridge port `38494`, real native paste/click/wheel events, and Page Observer postcondition checks. It briefly changes foreground focus while each Native Input Driver action runs.

## Adapter configuration

An adapter supplies site knowledge without modifying the generic runtime. See [`demo/adapter/automation.adapter.json`](demo/adapter/automation.adapter.json):

```json
{
  "schemaVersion": 1,
  "id": "example-adapter",
  "displayName": "Example Adapter",
  "version": "1.0.0",
  "extension": {
    "descriptors": ["descriptors/example.json"],
    "hostPermissions": ["https://example.com/*"]
  },
  "orchestrator": {
    "operationDirectories": ["operations"],
    "allowedOpenUrls": ["https://example.com/start"]
  }
}
```

Launch the Page Observer or Command Orchestrator with the Adapter path:

```bash
WEB_AUTOMATION_ADAPTER_PATH=/absolute/path/to/automation.adapter.json \
  node dist/server/page-observer-server.mjs
```

The bridge sends validated JSON descriptors to the generic extension during its connection handshake. Host permissions remain optional until the user grants the Adapter's declared origins in the Side Panel. `openUrl` accepts HTTP(S), rejects credentials, and requires an exact match in the Command Orchestrator's runtime allowlist.

## Page Observer descriptors

Descriptors declare:

- how to recognize a page state;
- fields, controls, and values to locate and read;
- collections whose items can be addressed by index or stable identity;
- scrollable regions, footer locators, overlap ratios, and remaining distance.

Page Observer results include the Chrome window and viewport geometry needed to convert page coordinates into native screen points. Inspector tools can also return bounded DOM snapshots, query CSS/XPath/text selectors, and explicitly execute JavaScript for adapter development. JavaScript execution is intentionally powerful and is exposed as a mutating, open-world Inspector action.

## Named operations

Operation catalogs turn business-neutral semantic names into reusable guarded commands. An operation may be:

- atomic: one `executeWebCommand` block;
- composite: nested registered operations, including bounded array/object expansion;
- reader: a named read handler such as the built-in `observer.observe` or a private injected handler.

Example:

```json
{
  "example.search.run": {
    "parameters": {
      "keywords": { "type": "string", "minLength": 1, "maxLength": 240 }
    },
    "steps": [
      { "operation": "example.search.setKeywords", "parameters": { "keywords": "{{keywords}}" } },
      { "operation": "example.search.submit", "parameters": { "keywords": "{{keywords}}" } }
    ]
  }
}
```

`OperationCatalog` validates parameters, rejects unexpected values, detects composition cycles, and expands only registered operations.

## JavaScript API

```js
import {
  BridgeServer,
  NativeInputDriver,
  OperationCatalog,
  CommandOrchestrator,
  createOrchestratorServer,
  startOrchestratorServer
} from "browser-operator-kit";
```

Private adapters can inject reader handlers when starting the Command Orchestrator:

```js
await startOrchestratorServer({
  projectRoot,
  catalog,
  allowedOpenUrls,
  readerHandlers: {
    "example.readDetails": async (input, context) => {
      return await readDetails(input, context);
    }
  }
});
```

## Python client

Add the repository's `python` directory to `PYTHONPATH`, configure the adapter directories, then call only named operations:

```python
import json
from pathlib import Path
from browser_operator_kit import OperationBot

root = Path("/absolute/path/to/browser-operator-kit")
with OperationBot.launch(root, environment={
    "WEB_AUTOMATION_OPERATION_DIRS": str(root / "demo" / "adapter" / "operations"),
    "WEB_AUTOMATION_ALLOWED_OPEN_URLS": json.dumps(["http://127.0.0.1:8765/"]),
}) as bot:
    print(bot.list_operations())
    result = bot.execute("demo.search.run", {
        "request": {"keywords": "alpha beta", "resultText": "已应用：alpha beta"}
    })
```

Configure `WEB_AUTOMATION_OPERATION_DIRS` and `WEB_AUTOMATION_ALLOWED_OPEN_URLS` when launching the generic Command Orchestrator for a custom adapter.

## Security model

- No Chrome `debugger`, `nativeMessaging`, `offscreen`, or persistent content-script permission.
- No persistent site permission in the installable generic extension; Adapter origins are optional and user-granted.
- Page Observer runtime is checked for page interaction primitives.
- Native Input Driver validates Accessibility access, the frontmost bundle, window bounds, observation freshness, and action bounds.
- Native text is passed as Base64 argv data without shell interpolation.
- Input is serialized, rate-limited, and uses non-linear mouse paths with final-position correction.
- Page changes are accepted only after fresh Page Observer postconditions pass.
- Login, CAPTCHA, and site-specific verification policy belongs in the adapter and orchestrator.

The local bridge trusts other processes on the same single-user workstation. It binds only to
`127.0.0.1`, but it is not designed for untrusted multi-user hosts. See [`SECURITY.md`](SECURITY.md)
for the supported trust boundary and vulnerability reporting guidance.

## Repository map

- `extension/`: generic Page Observer runtime and Side Panel template
- `native-helper/macos/`: generic Native Input Driver implementation
- `src/`: bridges, operation catalog, Command Orchestrator, and MCP servers
- `python/browser_operator_kit/`: Python MCP client and named-operation facade
- `demo/`: neutral adapter, operations, workflows, and local test page
- `scripts/`: builders, validators, acceptance, and diagnostics
- `test/`: generic unit and contract tests

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
