#!/usr/bin/env node
// Keep deno.json's version in lockstep with package.json — package.json is the
// single source of truth (same version the web GUI reports). Run before every
// `deno desktop` build so the desktop app + installers carry the identical
// version. Idempotent; in --check mode it fails instead of writing (for CI).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const denoPath = join(root, 'deno.json');
const deno = JSON.parse(readFileSync(denoPath, 'utf8'));

const checkOnly = process.argv.includes('--check');

if (deno.version === pkg.version) {
  console.log(`deno.json version already in sync (${pkg.version}).`);
  process.exit(0);
}

if (checkOnly) {
  console.error(
    `deno.json version (${deno.version}) != package.json version (${pkg.version}). ` +
      `Run \`node scripts/sync-desktop-version.mjs\` and commit.`,
  );
  process.exit(1);
}

deno.version = pkg.version;
writeFileSync(denoPath, JSON.stringify(deno, null, 2) + '\n');
console.log(`Synced deno.json version -> ${pkg.version}.`);
