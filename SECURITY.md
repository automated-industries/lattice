# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 1.11.x  | ✓         |
| < 1.11  | ✗         |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

To report a vulnerability, email **contact@automatedindustries.ai** with:

- A description of the vulnerability and its potential impact
- Steps to reproduce or proof-of-concept code
- Any suggested mitigations (optional)

You should receive an acknowledgment within 48 hours. We will work with you to understand and address the issue, and will coordinate public disclosure once a fix is available.

## Scope

`latticesql` is a local-first library that runs against SQLite or Postgres and includes an optional local-only browser GUI. At runtime it makes no outbound network requests of its own with one narrow exception: explicit `checkForUpdate()` / `autoUpdate()` calls to `registry.npmjs.org`, which only fire when the caller invokes them. There is no postinstall telemetry. See the [Telemetry](./README.md#telemetry) section of the README for the (passive, README-only) signals used for project analytics. The primary security surface is:

- **SQL injection** via crafted row object keys or values — mitigated by parameterized queries and schema-column validation
- **Path traversal** via YAML config file paths — applicable only when the developer controls config files
- **Sanitization bypass** — the `sanitize.ts` module is on by default; disabling it (`sanitize: false`) removes input filtering
- **`lattice gui` HTTP surface** — the GUI server binds only to `127.0.0.1` and has no authentication. It is intended for local development against a config you trust. Do not expose it on a non-loopback interface or proxy it to a public host.

Out of scope: vulnerabilities in `better-sqlite3`, `pg`, `uuid`, or `yaml` dependencies should be reported to those projects directly.
