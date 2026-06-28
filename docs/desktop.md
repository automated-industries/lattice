# Lattice Desktop app

A downloadable, double-click desktop build of the Lattice GUI — no terminal, no
`npm install`. It runs the **exact same** GUI server as `lattice gui`, served into
a native window, so there is only one GUI to maintain.

## Install

Download the installer for your OS from **[latticesql.com/install](https://latticesql.com/install)**:

- **macOS** — `Lattice.dmg` (Apple silicon + Intel)
- **Windows** — `Lattice.msi`

The CLI path keeps working unchanged: `npm i -g latticesql && lattice gui`.

> **Unsigned builds (current):** the v1 installers are not yet code-signed, so the
> first launch shows an "unidentified developer" (macOS Gatekeeper) or "unknown
> publisher" (Windows SmartScreen) prompt. Choose **Open anyway** / **Run anyway**.
> Signed builds remove this step.

## How it works

The desktop app is built with [`deno desktop`](https://docs.deno.com/runtime/desktop/).
It boots the standard `startGuiServer()` on a local port and points a native
webview window at it — the webview talks to the local server exactly like a
browser tab.

- **Same version as the web GUI.** The app and its installer report the same
  `latticesql` version the web GUI shows (one build constant; `deno.json`'s
  version is kept in lockstep with `package.json` by `scripts/sync-desktop-version.mjs`).
- **SQLite without native addons.** `better-sqlite3` is a native N-API addon that
  cannot load under Deno, so the desktop build uses [`DenoSqliteAdapter`](../src/db/sqlite-deno.ts),
  a drop-in adapter over the runtime's built-in `node:sqlite` `DatabaseSync`. The
  npm/Node distribution is unchanged and still uses `better-sqlite3`.
- **External links open in your browser.** A webview has no tabs/popups, so the
  desktop shell routes `target="_blank"` links and `window.open()` to the system
  default browser. "Connect with Claude" opens the provider page in your browser
  while keeping the auth session local to the app.
- **Upgrade-on-run.** On launch the app checks the release channel via
  `Deno.autoUpdate()` and the `latest.json` manifest published with each release.
- **Update-available hint while running.** A window left open for a long time would
  otherwise miss releases that ship after launch, so the GUI also polls the same
  `latest.json` (read-only — no download or relaunch) and shows an **"Update
  available — Restart to update"** link next to the version chip when a newer
  release is published. Clicking it runs the bundled updater (download + relaunch).
- **Disable auto-update.** Set `LATTICE_NO_AUTO_UPDATE=1` to pin the app to its
  current version — no manifest probe, no `Deno.autoUpdate()`, no relaunch (the
  desktop equivalent of the CLI's `lattice gui --no-auto-update`). Useful for
  testing, air-gapped, or reproducible-demo runs.
- **Upgrade-on-install.** The download page always links the latest release, so a
  fresh install is always current.

## Build from source

Requires a Deno **canary** build (`deno desktop` is canary-only for now):

```bash
deno upgrade canary
npm ci

# macOS .dmg → dist-desktop/Lattice.dmg
npm run desktop:build:mac

# Windows .msi → dist-desktop/Lattice.msi
npm run desktop:build:win

# Run the windowed app directly during development
npm run desktop:dev
```

The app identity (name, bundle id, per-platform icons, update base URL) lives in
[`deno.json`](../deno.json) under the `desktop` key.

Releases are cut by the `Desktop Release` workflow on a `v*` tag: it builds both
OSes, generates `latest.json`, and uploads the installers + manifest to the
GitHub Release.

## Limitations

- **Image processing (`sharp`) and `sqlite-vec` acceleration are unavailable** in
  the desktop build — both are native addons that do not load under Deno. Vector
  search falls back to an in-process scan; image-dependent features are disabled.
  Use the npm/Node build if you need them.
- The build is large (it embeds its runtime + dependencies) and currently unsigned.
