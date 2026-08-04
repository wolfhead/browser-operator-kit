# Architecture

## Responsibility boundaries

| Layer | Owns | Must not own |
| --- | --- | --- |
| Eye | Page recognition, registered values, target geometry, scroll metrics, visible status | Native input or success claims |
| Hand | Foreground leases, mouse paths, click/paste/wheel events, OS receipts | DOM selectors or page semantics |
| Runner | Preconditions, target readiness, waits, action dispatch, postconditions | Site-specific locators |
| Operation catalog | Named primitives, composition, parameter validation | Native implementation |
| Adapter | Hosts, descriptors, exact bootstrap URLs, site operations, custom Readers | Generic runtime forks |
| Orchestrator | Task sequence, scoring, model calls, human decisions | Unregistered low-level guesses |

## Guarded command lifecycle

1. Observe the page in the background.
2. Require the expected page and preconditions.
3. Resolve a registered target and fresh screen point.
4. Acquire a foreground lease only if needed.
5. Observe again after focus changes.
6. Re-resolve the target and validate observation freshness/window bounds.
7. Execute one native action.
8. Poll fresh Eye observations using the command's verification policy.
9. Require the result page and postconditions.
10. Restore the previous application unless another person or app took over.

An `openUrl` bootstrap is targetless but still requires an exact runtime allowlist entry, a declared result page, a foreground lease, and final Eye verification.

## Adapter boundary

The extension builder copies the generic extension template, copies only declared descriptors, generates the descriptor registry, adds adapter host permissions, and injects adapter bridge URLs. The Operator receives operation directories, exact allowed URLs, and optional Reader handlers separately. This keeps site code out of the public core and lets multiple private adapters consume the same package.
