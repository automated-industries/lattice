# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.4.x   | ✓         |
| < 0.4   | ✗         |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

To report a vulnerability, email **security@mflat.io** with:

- A description of the vulnerability and its potential impact
- Steps to reproduce or proof-of-concept code
- Any suggested mitigations (optional)

You should receive an acknowledgment within 48 hours. We will work with you to understand and address the issue, and will coordinate public disclosure once a fix is available.

## Scope

`latticesql` is a local-only SQLite library. It makes no network requests and handles no authentication. The primary security surface is:

- **SQL injection** via crafted row object keys or values — mitigated by parameterized queries and schema-column validation
- **Path traversal** via YAML config file paths — applicable only when the developer controls config files
- **Sanitization bypass** — the `sanitize.ts` module is on by default; disabling it (`sanitize: false`) removes input filtering

Out of scope: vulnerabilities in `better-sqlite3`, `uuid`, or `yaml` dependencies should be reported to those projects directly.
