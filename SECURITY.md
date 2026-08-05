# Security Policy

## Supported versions

Security fixes are applied to the latest release on the `main` branch.

## Trust boundary

Browser Operator Kit is designed for a trusted, single-user macOS workstation. Its WebSocket
bridges bind exclusively to `127.0.0.1`, but other local processes are inside the trust boundary.
Do not run the Native Input Driver or Command Orchestrator on an untrusted multi-user host.

The optional resident native input service uses a Unix socket owned by the current user, mode
`0600`, inside a user-owned mode `0700` directory. Requests and responses are size-bounded and
correlated by protocol version and request ID. Any process running as that same macOS user can
still request native actions and is therefore inside the supported trust boundary. Configure
service transport explicitly; it does not fall back to spawning a helper subprocess.

Adapters are responsible for restricting host permissions, allowed navigation URLs, login and
verification pages, and any site-specific data handling policy. The generic toolkit does not
attempt to bypass authentication, CAPTCHAs, or security verification.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub Security Advisories for this repository.
Do not include credentials, private browsing data, or personal information in a report.
