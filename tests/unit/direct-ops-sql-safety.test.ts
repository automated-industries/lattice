import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIRECT_OPS_PATH = join(__dirname, '..', '..', 'src', 'teams', 'direct-ops.ts');

describe('direct-ops SQL safety', () => {
  it('contains no template-literal SQL with interpolation in .query() / .run() args', () => {
    const src = readFileSync(DIRECT_OPS_PATH, 'utf8');
    // Pattern intentionally narrow: any backtick-wrapped string that
    // contains ${ and lives inside what looks like a .query( / .run(
    // call. The lattice abstraction here uses .query/.insert/.upsert/.delete
    // with positional or row args, not raw SQL — this guards against
    // future regressions where someone hand-writes a query.
    const pattern = /\.(query|run|exec|all|get)\s*\(\s*`[^`]*\$\{/m;
    const m = pattern.exec(src);
    expect(m, m ? `template-literal SQL detected near: ${m[0]}` : '').toBeNull();
  });
});
