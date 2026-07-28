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

`latticesql` is a local-first library that runs against SQLite or Postgres and includes an optional local-only browser GUI. At runtime it makes no outbound network requests of its own, with two narrow exceptions: explicit `checkForUpdate()` / `autoUpdate()` calls to `registry.npmjs.org` (opt-in — only fires if the caller invokes them), and a one-time anonymous install ping to Scarf via the `@scarf/scarf` postinstall hook (on by default, opt-out — at install via `SCARF_ANALYTICS=false`/`DO_NOT_TRACK=1`, or in-app via the GUI's **Settings → User → "Anonymous install analytics"** consent toggle / the `analytics` preference; see the [Telemetry](./README.md#telemetry) section of the README for what is sent). The primary security surface is:

- **SQL injection** via crafted row object keys or values — mitigated by parameterized queries and schema-column validation
- **Path traversal** via YAML config file paths — applicable only when the developer controls config files
- **Sanitization bypass** — the `sanitize.ts` module is on by default; disabling it (`sanitize: false`) removes input filtering
- **`lattice gui` HTTP surface** — the GUI server has **no authentication**. That is the invariant; binding to `127.0.0.1` is the default that makes it acceptable. Anyone who can reach the port has full access to the workspace it serves, so treat reachability as the access control. Binding to a non-loopback address is possible but deliberately hard to do by accident: it requires `--allow-remote`, an explicitly named `--root`, and a typed confirmation of a disclosure naming the root, the workspace, the address, and the fact that there is no login. None of that is authentication — it only ensures the exposure is intentional and that you know which data you are exposing. If you need it reachable beyond your machine, put authentication in front of it.
- **Workspace root resolution** — a session opens the root it was **given** (`--root`, else `LATTICE_ROOT`, else `~/.lattice`), never one found by searching upward from the working directory. A `.lattice` directory left inside a project could otherwise be adopted by an unrelated later run, along with its registry, its cloud workspaces, and the key material needed to reach them.

Out of scope: vulnerabilities in `better-sqlite3`, `pg`, `uuid`, or `yaml` dependencies should be reported to those projects directly.
