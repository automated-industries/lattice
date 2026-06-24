// Desktop build entry — the bundled ESM surface a `deno desktop` app imports.
// The CLI bundle keeps `startGuiServer` private, so this dedicated entry exposes
// exactly what the desktop shell needs: the server boot fn and the build-stamped
// version (the SAME `__LATTICE_VERSION__` define the CLI/GUI use, so the desktop
// app and its installers report the identical version as the web GUI).
export { startGuiServer } from './gui/server.js';
export type { StartGuiServerOptions, GuiServerHandle } from './gui/server.js';

declare const __LATTICE_VERSION__: string | undefined;

/** latticesql version, injected at build — single source of truth with the web GUI. */
export const VERSION: string =
  typeof __LATTICE_VERSION__ === 'string' ? __LATTICE_VERSION__ : 'unknown';
