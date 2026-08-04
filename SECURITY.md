# Security Policy

## Supported versions

Security fixes are applied to the latest release on the `main` branch.

## Trust boundary

Browser Operator Kit is designed for a trusted, single-user macOS workstation. Its WebSocket
bridges bind exclusively to `127.0.0.1`, but other local processes are inside the trust boundary.
Do not run the native Hand or Operator on an untrusted multi-user host.

Adapters are responsible for restricting host permissions, allowed navigation URLs, login and
verification pages, and any site-specific data handling policy. The generic toolkit does not
attempt to bypass authentication, CAPTCHAs, or security verification.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub Security Advisories for this repository.
Do not include credentials, private browsing data, or personal information in a report.
