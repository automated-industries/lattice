import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Lattice } from '../../src/lattice.js';
import {
  deriveCanonicalContexts,
  ensureRuntimeEntityContexts,
  boundedSelfContext,
} from '../../src/framework/canonical-context.js';
import type { TableDefinition } from '../../src/types.js';

/**
 * "All data renders as markdown" — files, connector tables, and imported
 * database tables get real per-record contexts, under three hard rules:
 * secrets/chat/internal NEVER derive a context (fail-closed), a file's context
 * is BOUNDED (no extracted_text dumps), and runtime registration is idempotent.
 */
describe('canonical-context hard exclusions', () => {
  it('never derives a context for secrets / chat tables / internal bookkeeping — even when fed them', () => {
    const def: TableDefinition = {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: '.schema-only/x.md',
    };
    const derived = deriveCanonicalContexts([
      { name: 'secrets', definition: def },
      { name: 'chat_threads', definition: def },
      { name: 'chat_messages', definition: def },
      { name: '_lattice_gui_audit', definition: def },
      { name: '__lattice_edges', definition: def },
      { name: 'people', definition: def },
    ]);
    expect(derived.map((d) => d.table)).toEqual(['people']);
  });
});

describe('bounded files self-render', () => {
  it('excludes heavy columns and caps the self block at the budget', () => {
    const filesDef: TableDefinition = {
      columns: {
        id: 'TEXT PRIMARY KEY',
        name: 'TEXT',
        extracted_text: 'TEXT',
        source_json: 'TEXT',
        deleted_at: 'TEXT',
      },
      render: () => '',
      outputFile: '.schema-only/files.md',
    };
    const ctx = boundedSelfContext('files', filesDef, {
      excludeColumns: new Set(['extracted_text', 'source_json']),
      budget: 300,
    });
    const selfSpec = ctx.files['FILE.md'];
    expect(selfSpec).toBeDefined();
    const out = selfSpec!.render([
      {
        id: 'f1',
        name: 'big.pdf',
        extracted_text: 'SECRET-HEAVY-TEXT '.repeat(500),
        source_json: '{"raw":true}',
      },
    ]);
    expect(out).not.toContain('SECRET-HEAVY-TEXT');
    expect(out).not.toContain('source_json');
    expect(out).toContain('big.pdf');
    expect(out.length).toBeLessThanOrEqual(310); // budget + ellipsis slack
  });
});

describe('runtime entity contexts (connector / imported-database tables)', () => {
  let tmp: string;
  let db: Lattice;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'lattice-runtime-ctx-'));
    db = new Lattice(join(tmp, 'app.db'));
    await db.init();
  });
  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('registers per-record contexts for runtime models, idempotently, and they render', async () => {
    const definition: TableDefinition = {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: '.schema-only/db_remote_widgets.md',
    };
    await db.defineLate('db_remote_widgets', definition);
    ensureRuntimeEntityContexts(db, [{ table: 'db_remote_widgets', definition }]);
    expect(db.entityContexts().has('db_remote_widgets')).toBe(true);
    const before = db.entityContexts().get('db_remote_widgets');
    ensureRuntimeEntityContexts(db, [{ table: 'db_remote_widgets', definition }]);
    expect(db.entityContexts().get('db_remote_widgets')).toBe(before); // idempotent

    await db.insert('db_remote_widgets', { id: 'w1', title: 'Anvil' });
    const ctxDir = join(tmp, 'Context');
    await db.render(ctxDir);
    // A per-record markdown tree exists for the runtime table.
    const root = join(ctxDir, 'Db_remote_widgets');
    expect(existsSync(root)).toBe(true);
    const slug = readdirSync(root).find((d) => !d.startsWith('.'));
    expect(slug).toBeTruthy();
    const files = readdirSync(join(root, String(slug)));
    expect(files.some((f) => f.endsWith('.md'))).toBe(true);
    const self = readFileSync(
      join(root, String(slug), files.find((f) => f.endsWith('.md'))!),
      'utf8',
    );
    expect(self).toContain('Anvil');
  });

  it('the files table renders a bounded per-record context out of the box', async () => {
    // registerNativeEntities runs inside the GUI open; core init registers the
    // native defs via the framework path — exercise the registered context.
    const { registerNativeEntities } = await import('../../src/framework/native-entities.js');
    const db2 = new Lattice(join(tmp, 'app2.db'), {
      encryptionKey: 'markdown-completion-test-key',
    });
    registerNativeEntities(db2);
    await db2.init();
    expect(db2.entityContexts().has('files')).toBe(true);
    await db2.insert('files', {
      id: 'f1',
      original_name: 'report.pdf',
      extracted_text: 'HEAVY '.repeat(4000),
    });
    const ctxDir = join(tmp, 'Context2');
    await db2.render(ctxDir);
    const root = join(ctxDir, 'Files');
    expect(existsSync(root)).toBe(true);
    const slug = readdirSync(root).find((d) => !d.startsWith('.'));
    const self = readFileSync(join(root, String(slug), 'FILE.md'), 'utf8');
    expect(self).toContain('report.pdf');
    expect(self).not.toContain('HEAVY HEAVY');
    expect(self.length).toBeLessThanOrEqual(8100);
    db2.close();
  });
});
