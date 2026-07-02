// Desktop build entry — the bundled ESM surface a `deno desktop` app imports.
// The CLI bundle keeps `startGuiServer` private, so this dedicated entry exposes
// exactly what the desktop shell needs: the server boot fn and the build-stamped
// version (the SAME `__LATTICE_VERSION__` define the CLI/GUI use, so the desktop
// app and its installers report the identical version as the web GUI).
export { startGuiServer } from './gui/server.js';
export type { StartGuiServerOptions, GuiServerHandle } from './gui/server.js';
// Workspace resolver — so the desktop shell opens the active workspace (and shows
// the welcome screen ONLY when there are genuinely none), exactly like the CLI's
// `lattice gui`. Without this the desktop hardcoded a virgin boot.
export { ensureRootForGui } from './framework/gui-bootstrap.js';
export type { GuiBootstrap } from './framework/gui-bootstrap.js';
// Release-manifest probe — the desktop shell feeds this into the GUI's update
// service so a long-open window can surface "update available" (read-only; the
// actual download/relaunch stays the bundled binary updater).
export { checkManifestForUpdate } from './update-check.js';

declare const __LATTICE_VERSION__: string | undefined;

/** latticesql version, injected at build — single source of truth with the web GUI. */
export const VERSION: string =
  typeof __LATTICE_VERSION__ === 'string' ? __LATTICE_VERSION__ : 'unknown';
