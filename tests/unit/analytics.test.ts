import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readAnalyticsConfig,
  writeAnalyticsConfig,
} from '../../src/framework/analytics.js';

describe('analytics config', () => {
  let dir: string;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lattice-analytics-'));
    prevConfigDir = process.env.LATTICE_CONFIG_DIR;
    process.env.LATTICE_CONFIG_DIR = dir;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.LATTICE_CONFIG_DIR;
    else process.env.LATTICE_CONFIG_DIR = prevConfigDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns default-on with a fresh anonymous_id when file missing', () => {
    const cfg = readAnalyticsConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.anonymous_id).toMatch(/^anon_[0-9a-f]{32}$/);
  });

  it('persists writeAnalyticsConfig({enabled:false}) and reads it back', () => {
    const before = readAnalyticsConfig();
    writeAnalyticsConfig({ enabled: false });
    // The cache TTL is 60s; writeAnalyticsConfig updates the cache so a
    // same-process re-read returns the new value.
    const after = readAnalyticsConfig();
    expect(after.enabled).toBe(false);
    expect(after.anonymous_id).toBe(before.anonymous_id);
  });

  it('anonymous_id is stable across reads', () => {
    const a = readAnalyticsConfig();
    const b = readAnalyticsConfig();
    expect(a.anonymous_id).toBe(b.anonymous_id);
  });
});
