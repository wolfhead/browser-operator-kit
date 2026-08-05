# Architecture

## Responsibility boundaries

| Layer | Owns | Must not own |
| --- | --- | --- |
| Page Observer | Page recognition, registered values, target geometry, scroll metrics, visible status | Native input or success claims |
| Native Input Driver | Foreground leases, mouse paths, click/paste/wheel events, OS receipts | DOM selectors or page semantics |
| Command Orchestrator | Preconditions, target readiness, waits, action dispatch, postconditions | Site-specific locators |
| Operation catalog | Named primitives, composition, parameter validation | Native implementation |
| Adapter | Hosts, descriptors, exact bootstrap URLs, site operations, custom Readers | Generic runtime forks |
| Task controller | Task sequence, scoring, model calls, human decisions | Unregistered low-level guesses |

## Native input transports

`NativeInputDriver` supports two explicit transports with the same helper command contract:

- `direct` (default) executes the helper as a child process for interactive development.
- `service` connects to a resident helper over a user-private Unix socket. The resident process owns macOS Accessibility and serializes requests; the Worker never spawns it.

The service accepts one bounded, versioned JSON request per connection and returns a correlated response. It permits only existing helper commands, rejects recursive service startup and self-tests, and applies the same frontmost-browser, window-bound, movement, and rate safeguards as direct mode. `request-access` calls macOS `CGRequestPostEventAccess()` without creating or posting input events; service deployments invoke it through the user-private socket so authorization is requested by the resident process that owns input delivery. There is no automatic fallback between transports.

## Guarded command lifecycle

1. Observe the page in the background.
2. Require the expected page and preconditions.
3. Resolve a registered target and fresh screen point.
4. Acquire a foreground lease only if needed.
5. Ask the Native Input Driver to raise the unique Chrome window matching the title and bounds from that observation; ambiguous matches fail closed.
6. Observe again after focus changes.
7. Re-resolve the target and validate observation freshness/window bounds.
8. Execute one native action.
9. Poll fresh Page Observer results using the command's verification policy.
10. Require the result page and postconditions.
11. Restore the previous application unless another person or app took over.

An `openUrl` bootstrap is targetless but still requires an exact runtime allowlist entry, a declared result page, a foreground lease, and final Page Observer verification.

## Adapter boundary

The installed extension is a single generic runtime with no bundled site descriptors and no persistent site permissions. A local Page Observer or Command Orchestrator loads an Adapter, validates its JSON descriptors, and sends a registration package in the loopback bridge handshake. The extension keeps registrations scoped to active bridge connections and asks the user to grant only the Adapter's declared origins from the Side Panel.

The Command Orchestrator receives operation directories, exact allowed URLs, and optional Reader handlers separately. Site descriptors and operations therefore stay in the Adapter repository without forking, rebuilding, or renaming the public extension.
