#!/usr/bin/env node
// Generate latest.json — the desktop auto-update manifest published to GitHub
// Releases. The desktop app fetches it (upgrade-on-run) to learn whether a newer
// version exists and where to download the OS installer.
//
// Usage:
//   node scripts/gen-desktop-manifest.mjs <version> <downloadBase> os=path [os=path ...] > latest.json
//   e.g. ... 4.2.3 https://github.com/automated-industries/lattice/releases/download/v4.2.3 \
//            darwin=dist-desktop/Lattice.dmg windows=dist-desktop/Lattice.msi
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';

const [, , version, downloadBase, ...assetArgs] = process.argv;
if (!version || !downloadBase || assetArgs.length === 0) {
  console.error('usage: gen-desktop-manifest.mjs <version> <downloadBase> os=path [os=path ...]');
  process.exit(1);
}

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const manifest = { version, publishedAt: new Date().toISOString(), assets: {} };
for (const arg of assetArgs) {
  const idx = arg.indexOf('=');
  const os = arg.slice(0, idx);
  const path = arg.slice(idx + 1);
  const name = basename(path);
  manifest.assets[os] = {
    name,
    url: `${downloadBase.replace(/\/$/, '')}/${name}`,
    sha256: sha256(path),
    sizeBytes: readFileSync(path).length,
  };
}

process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
