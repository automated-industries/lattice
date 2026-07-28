#!/usr/bin/env node
// Assert that the release tag matches package.json's version. The auto-update
// manifest must advertise the BUILT binary's version — a mistagged release
// would publish download URLs pointing at a different version than the
// manifest claims, stranding every desktop client in an update it can never
// finish applying. Fails loudly (exit 1) on any mismatch; never a silent pass.
//
// Usage: node scripts/assert-release-version.mjs <tag>   (or TAG=v1.2.3 env)
// Reads package.json from the current working directory (the checkout root).
// Tag semantics match the workflow's ${GITHUB_REF_NAME#v}: strip at most one
// leading "v", only when present.
import { readFileSync } from 'node:fs';

const tag = process.argv[2] ?? process.env.TAG ?? '';
const tagVersion = tag.startsWith('v') ? tag.slice(1) : tag;
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
if (!tagVersion || version !== tagVersion) {
  console.error(
    `::error::package.json version (${version}) does not match tag (${tagVersion}); refusing to publish a mismatched manifest`,
  );
  process.exit(1);
}
console.log(`OK: package.json version (${version}) matches tag (${tagVersion})`);
