import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Reverse-seed', () => {
  let db: Lattice;
  let outputDir: string;
  const dirs: string[] = [];

  function tempDir() {
    const d = mkdtempSync(join(tmpdir(), 'lattice-rs-'));
    dirs.push(d);
    return d;
  }

  beforeEach(() => {
    outputDir = tempDir();
  });

  afterEach(() => {
    db?.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  // -------------------------------------------------------------------------
  // Regular tables — built-in template parsers
  // -------------------------------------------------------------------------

  describe('default-table template', () => {
    it('recovers rows from rendered default-table file into empty DB', async () => {
      // Phase 1: Create DB with data and render
      db = new Lattice(':memory:');
      db.define('users', {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', role: 'TEXT' },
        render: 'default-table',
        outputFile: 'users.md',
      });
      await db.init();
      await db.insert('users', { id: 'u1', name: 'Alice', role: 'admin' });
      await db.insert('users', { id: 'u2', name: 'Bob', role: 'viewer' });
      await db.render(outputDir);
      db.close();

      // Phase 2: New empty DB, same schema — reverse-seed should recover
      db = new Lattice(':memory:');
      db.define('users', {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', role: 'TEXT' },
        render: 'default-table',
        outputFile: 'users.md',
      });
      await db.init();

      const result = await db.reverseSeed(outputDir);
      expect(result.totalRowsRecovered).toBe(2);
      expect(result.tables).toHaveLength(1);
      expect(result.tables[0]!.table).toBe('users');
      expect(result.tables[0]!.rowsRecovered).toBe(2);

      // Verify rows are in the DB
      const rows = await db.query('users', {});
      expect(rows).toHaveLength(2);
      const alice = rows.find((r) => r.id === 'u1');
      expect(alice).toBeDefined();
      expect(alice!.name).toBe('Alice');
      expect(alice!.role).toBe('admin');
    });
  });

  describe('default-list template', () => {
    it('recovers rows from rendered default-list file', async () => {
      db = new Lattice(':memory:');
      db.define('tags', {
        columns: { id: 'TEXT PRIMARY KEY', label: 'TEXT', color: 'TEXT' },
        render: 'default-list',
        outputFile: 'tags.md',
      });
      await db.init();
      await db.insert('tags', { id: 't1', label: 'bug', color: 'red' });
      await db.insert('tags', { id: 't2', label: 'feature', color: 'blue' });
      await db.render(outputDir);
      db.close();

      db = new Lattice(':memory:');
      db.define('tags', {
        columns: { id: 'TEXT PRIMARY KEY', label: 'TEXT', color: 'TEXT' },
        render: 'default-list',
        outputFile: 'tags.md',
      });
      await db.init();

      const result = await db.reverseSeed(outputDir);
      expect(result.totalRowsRecovered).toBe(2);

      const rows = await db.query('tags', {});
      expect(rows).toHaveLength(2);
    });
  });

  describe('default-detail template', () => {
    it('recovers rows from rendered default-detail file', async () => {
      db = new Lattice(':memory:');
      db.define('items', {
        columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', status: 'TEXT' },
        render: 'default-detail',
        outputFile: 'items.md',
      });
      await db.init();
      await db.insert('items', { id: 'i1', title: 'Task One', status: 'open' });
      await db.insert('items', { id: 'i2', title: 'Task Two', status: 'closed' });
      await db.render(outputDir);
      db.close();

      db = new Lattice(':memory:');
      db.define('items', {
        columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', status: 'TEXT' },
        render: 'default-detail',
        outputFile: 'items.md',
      });
      await db.init();

      const result = await db.reverseSeed(outputDir);
      expect(result.totalRowsRecovered).toBe(2);

      const rows = await db.query('items', {});
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.id === 'i1')!.title).toBe('Task One');
    });
  });

  describe('default-json template', () => {
    it('recovers rows from rendered JSON file', async () => {
      db = new Lattice(':memory:');
      db.define('config', {
        columns: { id: 'TEXT PRIMARY KEY', key: 'TEXT', value: 'TEXT' },
        render: 'default-json',
        outputFile: 'config.json',
      });
      await db.init();
      await db.insert('config', { id: 'c1', key: 'theme', value: 'dark' });
      await db.insert('config', { id: 'c2', key: 'lang', value: 'en' });
      await db.render(outputDir);
      db.close();

      db = new Lattice(':memory:');
      db.define('config', {
        columns: { id: 'TEXT PRIMARY KEY', key: 'TEXT', value: 'TEXT' },
        render: 'default-json',
        outputFile: 'config.json',
      });
      await db.init();

      const result = await db.reverseSeed(outputDir);
      expect(result.totalRowsRecovered).toBe(2);

      const rows = await db.query('config', {});
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.key === 'theme')!.value).toBe('dark');
    });
  });

  // -------------------------------------------------------------------------
  // Non-empty DB — no reverse-seed
  // -------------------------------------------------------------------------

  it('does NOT reverse-seed when DB already has data', async () => {
    db = new Lattice(':memory:');
    db.define('users', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
      render: 'default-table',
      outputFile: 'users.md',
    });
    await db.init();
    await db.insert('users', { id: 'u1', name: 'Alice' });
    await db.insert('users', { id: 'u2', name: 'Bob' });
    await db.render(outputDir);

    // DB still has data — reverse-seed should be a no-op
    const result = await db.reverseSeed(outputDir);
    expect(result.totalRowsRecovered).toBe(0);
    expect(result.tables).toHaveLength(0);

    const rows = await db.query('users', {});
    expect(rows).toHaveLength(2); // original data unchanged
  });

  // -------------------------------------------------------------------------
  // Empty DB + no files — no reverse-seed, no error
  // -------------------------------------------------------------------------

  it('does nothing when DB is empty and no rendered files exist', async () => {
    db = new Lattice(':memory:');
    db.define('users', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
      render: 'default-table',
      outputFile: 'users.md',
    });
    await db.init();

    const result = await db.reverseSeed(outputDir);
    expect(result.totalRowsRecovered).toBe(0);
    expect(result.tables).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Opt-out: reverseSeed: false
  // -------------------------------------------------------------------------

  it('skips tables with reverseSeed: false', async () => {
    // Create and render data
    db = new Lattice(':memory:');
    db.define('junctions', {
      columns: { id: 'TEXT PRIMARY KEY', a_id: 'TEXT', b_id: 'TEXT' },
      render: 'default-table',
      outputFile: 'junctions.md',
      reverseSeed: false,
    });
    await db.init();
    await db.insert('junctions', { id: 'j1', a_id: 'a1', b_id: 'b1' });
    await db.render(outputDir);
    db.close();

    // New empty DB
    db = new Lattice(':memory:');
    db.define('junctions', {
      columns: { id: 'TEXT PRIMARY KEY', a_id: 'TEXT', b_id: 'TEXT' },
      render: 'default-table',
      outputFile: 'junctions.md',
      reverseSeed: false,
    });
    await db.init();

    const result = await db.reverseSeed(outputDir);
    expect(result.totalRowsRecovered).toBe(0);

    const rows = await db.query('junctions', {});
    expect(rows).toHaveLength(0); // nothing recovered
  });

  // -------------------------------------------------------------------------
  // Custom parser
  // -------------------------------------------------------------------------

  it('uses custom parser when provided', async () => {
    // Write a custom-format file
    const customContent = 'ITEM:alpha:10\nITEM:beta:20\n';
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, 'items.md'), customContent);

    db = new Lattice(':memory:');
    db.define('items', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', score: 'INTEGER' },
      render: (rows) => rows.map((r) => `ITEM:${r.name}:${r.score}`).join('\n'),
      outputFile: 'items.md',
      reverseSeed: {
        parser: (content: string) => {
          return content
            .split('\n')
            .filter((l) => l.startsWith('ITEM:'))
            .map((l) => {
              const [, name, score] = l.split(':');
              return { name, score: Number(score) };
            });
        },
      },
    });
    await db.init();

    const result = await db.reverseSeed(outputDir);
    expect(result.totalRowsRecovered).toBe(2);

    const rows = await db.query('items', {});
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.name === 'alpha')!.score).toBe(10);
  });

  // -------------------------------------------------------------------------
  // Partial recovery — some files parseable, some not
  // -------------------------------------------------------------------------

  it('recovers what it can and logs warnings for failures', async () => {
    // Write a valid file for one table
    db = new Lattice(':memory:');
    db.define('good', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
      render: 'default-table',
      outputFile: 'good.md',
    });
    db.define('bad', {
      columns: { id: 'TEXT PRIMARY KEY', val: 'TEXT' },
      render: 'default-table',
      outputFile: 'bad.md',
    });
    await db.init();
    await db.insert('good', { id: 'g1', name: 'OK' });
    await db.insert('bad', { id: 'b1', val: 'data' });
    await db.render(outputDir);
    db.close();

    // Corrupt the bad file
    writeFileSync(join(outputDir, 'bad.md'), 'not a valid markdown table');

    // New empty DB
    db = new Lattice(':memory:');
    db.define('good', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
      render: 'default-table',
      outputFile: 'good.md',
    });
    db.define('bad', {
      columns: { id: 'TEXT PRIMARY KEY', val: 'TEXT' },
      render: 'default-table',
      outputFile: 'bad.md',
    });
    await db.init();

    const result = await db.reverseSeed(outputDir);
    expect(result.totalRowsRecovered).toBe(1);
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]!.table).toBe('good');
  });

  // -------------------------------------------------------------------------
  // Idempotent — running twice doesn't create duplicates
  // -------------------------------------------------------------------------

  it('is idempotent — running twice does not create duplicates', async () => {
    db = new Lattice(':memory:');
    db.define('users', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
      render: 'default-table',
      outputFile: 'users.md',
    });
    await db.init();
    await db.insert('users', { id: 'u1', name: 'Alice' });
    await db.render(outputDir);
    db.close();

    db = new Lattice(':memory:');
    db.define('users', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
      render: 'default-table',
      outputFile: 'users.md',
    });
    await db.init();

    // First run
    await db.reverseSeed(outputDir);
    expect((await db.query('users', {})).length).toBe(1);

    // Verify second run doesn't add duplicates (table is non-empty now)
    const result2 = await db.reverseSeed(outputDir);
    expect(result2.totalRowsRecovered).toBe(0);
    expect((await db.query('users', {})).length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Entity context directories
  // -------------------------------------------------------------------------

  describe('entity context directories', () => {
    it('recovers entity rows from subdirectories', async () => {
      // Phase 1: Create DB with entity context and render
      db = new Lattice(':memory:');
      db.define('agents', {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', status: 'TEXT' },
        render: 'default-table',
        outputFile: 'agents.md',
        reverseSeed: {
          parser: (content: string) => {
            // Parse the entity-profile-style content
            const row: Record<string, unknown> = {};
            for (const line of content.split('\n')) {
              const trimmed = line.trim();
              if (
                !trimmed ||
                trimmed.startsWith('#') ||
                trimmed === '---' ||
                trimmed.startsWith('<!--')
              )
                continue;
              const colonIdx = trimmed.indexOf(': ');
              if (colonIdx > 0) {
                const key = trimmed.slice(0, colonIdx);
                const val = trimmed.slice(colonIdx + 2);
                row[key] = val === '' ? null : val;
              }
            }
            return Object.keys(row).length > 0 ? [row] : [];
          },
        },
      });
      db.defineEntityContext('agents', {
        slug: (row) => row.name as string,
        directoryRoot: 'agents',
        files: {
          'AGENT.md': {
            source: { type: 'self' },
            render: (rows) => {
              const r = rows[0]!;
              return `# ${r.name}\n\nid: ${r.id}\nname: ${r.name}\nstatus: ${r.status}`;
            },
          },
        },
      });
      await db.init();
      await db.insert('agents', { id: 'a1', name: 'Alpha', status: 'active' });
      await db.insert('agents', { id: 'a2', name: 'Beta', status: 'idle' });
      await db.render(outputDir);
      db.close();

      // Phase 2: Empty DB — reverse-seed from entity directories
      db = new Lattice(':memory:');
      db.define('agents', {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', status: 'TEXT' },
        render: 'default-table',
        outputFile: 'agents.md',
        reverseSeed: {
          parser: (content: string) => {
            const row: Record<string, unknown> = {};
            for (const line of content.split('\n')) {
              const trimmed = line.trim();
              if (
                !trimmed ||
                trimmed.startsWith('#') ||
                trimmed === '---' ||
                trimmed.startsWith('<!--')
              )
                continue;
              const colonIdx = trimmed.indexOf(': ');
              if (colonIdx > 0) {
                const key = trimmed.slice(0, colonIdx);
                const val = trimmed.slice(colonIdx + 2);
                row[key] = val === '' ? null : val;
              }
            }
            return Object.keys(row).length > 0 ? [row] : [];
          },
        },
      });
      db.defineEntityContext('agents', {
        slug: (row) => row.name as string,
        directoryRoot: 'agents',
        files: {
          'AGENT.md': {
            source: { type: 'self' },
            render: (rows) => {
              const r = rows[0]!;
              return `# ${r.name}\n\nid: ${r.id}\nname: ${r.name}\nstatus: ${r.status}`;
            },
          },
        },
      });
      await db.init();

      const result = await db.reverseSeed(outputDir);
      // Should recover from entity directories (2 agents)
      // May also recover from regular table file — total should include both paths
      expect(result.totalRowsRecovered).toBeGreaterThanOrEqual(2);

      const rows = await db.query('agents', {});
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.name === 'Alpha')).toBeDefined();
      expect(rows.find((r) => r.name === 'Beta')).toBeDefined();
    });

    it('detects individual missing entities (not just empty tables)', async () => {
      const entityParser = (content: string) => {
        const row: Record<string, unknown> = {};
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (
            !trimmed ||
            trimmed.startsWith('#') ||
            trimmed === '---' ||
            trimmed.startsWith('<!--')
          )
            continue;
          const colonIdx = trimmed.indexOf(': ');
          if (colonIdx > 0) {
            row[trimmed.slice(0, colonIdx)] = trimmed.slice(colonIdx + 2);
          }
        }
        return Object.keys(row).length > 0 ? [row] : [];
      };

      const agentRender = (rows: Record<string, unknown>[]) => {
        const r = rows[0]!;
        return `# ${r.name}\n\nid: ${r.id}\nname: ${r.name}\nstatus: ${r.status}`;
      };

      // Phase 1: Render 3 agents
      db = new Lattice(':memory:');
      db.define('agents', {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', status: 'TEXT' },
        render: 'default-table',
        outputFile: 'agents.md',
        reverseSeed: { parser: entityParser },
      });
      db.defineEntityContext('agents', {
        slug: (row) => row.name as string,
        directoryRoot: 'agents',
        files: { 'AGENT.md': { source: { type: 'self' }, render: agentRender } },
      });
      await db.init();
      await db.insert('agents', { id: 'a1', name: 'Alpha', status: 'active' });
      await db.insert('agents', { id: 'a2', name: 'Beta', status: 'idle' });
      await db.insert('agents', { id: 'a3', name: 'Gamma', status: 'active' });
      await db.render(outputDir);
      db.close();

      // Phase 2: New DB with only 1 agent — 2 are "missing"
      db = new Lattice(':memory:');
      db.define('agents', {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', status: 'TEXT' },
        render: 'default-table',
        outputFile: 'agents.md',
        reverseSeed: { parser: entityParser },
      });
      db.defineEntityContext('agents', {
        slug: (row) => row.name as string,
        directoryRoot: 'agents',
        files: { 'AGENT.md': { source: { type: 'self' }, render: agentRender } },
      });
      await db.init();
      await db.insert('agents', { id: 'a1', name: 'Alpha', status: 'active' });

      // Detect: should find Beta and Gamma as missing (not Alpha)
      const result = await db.reconcile(outputDir);
      expect(result.reverseSeedRequired).toHaveLength(2);
      const entities = result.reverseSeedRequired.map((d) => d.entity).sort();
      expect(entities).toEqual(['Beta', 'Gamma']);
      expect(result.reverseSeedRequired[0]!.table).toBe('agents');

      // Alpha still in DB, Beta and Gamma not recovered (detect-only)
      expect((await db.query('agents', {})).length).toBe(1);
    });

    it('recovers individual missing entities via explicit reverseSeed()', async () => {
      const entityParser = (content: string) => {
        const row: Record<string, unknown> = {};
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (
            !trimmed ||
            trimmed.startsWith('#') ||
            trimmed === '---' ||
            trimmed.startsWith('<!--')
          )
            continue;
          const colonIdx = trimmed.indexOf(': ');
          if (colonIdx > 0) {
            row[trimmed.slice(0, colonIdx)] = trimmed.slice(colonIdx + 2);
          }
        }
        return Object.keys(row).length > 0 ? [row] : [];
      };

      const agentRender = (rows: Record<string, unknown>[]) => {
        const r = rows[0]!;
        return `# ${r.name}\n\nid: ${r.id}\nname: ${r.name}\nstatus: ${r.status}`;
      };

      // Render 3 agents
      db = new Lattice(':memory:');
      db.define('agents', {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', status: 'TEXT' },
        render: 'default-table',
        outputFile: 'agents.md',
        reverseSeed: { parser: entityParser },
      });
      db.defineEntityContext('agents', {
        slug: (row) => row.name as string,
        directoryRoot: 'agents',
        files: { 'AGENT.md': { source: { type: 'self' }, render: agentRender } },
      });
      await db.init();
      await db.insert('agents', { id: 'a1', name: 'Alpha', status: 'active' });
      await db.insert('agents', { id: 'a2', name: 'Beta', status: 'idle' });
      await db.insert('agents', { id: 'a3', name: 'Gamma', status: 'active' });
      await db.render(outputDir);
      db.close();

      // New DB with only Alpha — Beta and Gamma missing
      db = new Lattice(':memory:');
      db.define('agents', {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', status: 'TEXT' },
        render: 'default-table',
        outputFile: 'agents.md',
        reverseSeed: { parser: entityParser },
      });
      db.defineEntityContext('agents', {
        slug: (row) => row.name as string,
        directoryRoot: 'agents',
        files: { 'AGENT.md': { source: { type: 'self' }, render: agentRender } },
      });
      await db.init();
      await db.insert('agents', { id: 'a1', name: 'Alpha', status: 'active' });

      // Explicit recovery: should recover Beta and Gamma
      const result = await db.reverseSeed(outputDir);
      expect(result.totalRowsRecovered).toBe(2);

      const rows = await db.query('agents', {});
      expect(rows).toHaveLength(3);
      expect(rows.find((r) => r.name === 'Beta')).toBeDefined();
      expect(rows.find((r) => r.name === 'Gamma')).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Integration with reconcile()
  // -------------------------------------------------------------------------

  describe('reconcile integration', () => {
    it('detects empty tables with files by default (no auto-recovery)', async () => {
      // Phase 1: Render with data
      db = new Lattice(':memory:');
      db.define('items', {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
        render: 'default-table',
        outputFile: 'items.md',
      });
      await db.init();
      await db.insert('items', { id: 'i1', name: 'First' });
      await db.render(outputDir);
      db.close();

      // Phase 2: Empty DB — reconcile should DETECT but NOT auto-recover
      db = new Lattice(':memory:');
      db.define('items', {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
        render: 'default-table',
        outputFile: 'items.md',
      });
      await db.init();

      const result = await db.reconcile(outputDir);
      // No auto-recovery
      expect(result.reverseSeed).toBeNull();
      // Detection reported
      expect(result.reverseSeedRequired).toHaveLength(1);
      expect(result.reverseSeedRequired[0]!.table).toBe('items');

      // DB is still empty — human must call reverseSeed() explicitly
      const rows = await db.query('items', {});
      expect(rows).toHaveLength(0);
    });

    it('auto-recovers during reconcile with reverseSeed: "auto"', async () => {
      // Phase 1: Render with data
      db = new Lattice(':memory:');
      db.define('items', {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
        render: 'default-table',
        outputFile: 'items.md',
      });
      await db.init();
      await db.insert('items', { id: 'i1', name: 'First' });
      await db.render(outputDir);
      db.close();

      // Phase 2: Empty DB — reconcile with auto should recover
      db = new Lattice(':memory:');
      db.define('items', {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
        render: 'default-table',
        outputFile: 'items.md',
      });
      await db.init();

      const result = await db.reconcile(outputDir, { reverseSeed: 'auto' });
      expect(result.reverseSeed).not.toBeNull();
      expect(result.reverseSeed!.totalRowsRecovered).toBe(1);
      expect(result.reverseSeedRequired).toHaveLength(0);

      // Rows recovered
      const rows = await db.query('items', {});
      expect(rows).toHaveLength(1);
      expect(rows[0]!.name).toBe('First');
    });

    it('returns empty reverseSeedRequired when all tables have data', async () => {
      db = new Lattice(':memory:');
      db.define('items', {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
        render: 'default-table',
        outputFile: 'items.md',
      });
      await db.init();
      await db.insert('items', { id: 'i1', name: 'First' });

      const result = await db.reconcile(outputDir);
      expect(result.reverseSeed).toBeNull();
      expect(result.reverseSeedRequired).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  describe('events', () => {
    it('emits reverseSeed event for each recovered table', async () => {
      db = new Lattice(':memory:');
      db.define('items', {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
        render: 'default-table',
        outputFile: 'items.md',
      });
      await db.init();
      await db.insert('items', { id: 'i1', name: 'Alpha' });
      await db.render(outputDir);
      db.close();

      db = new Lattice(':memory:');
      db.define('items', {
        columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
        render: 'default-table',
        outputFile: 'items.md',
      });
      await db.init();

      const events: { table: string; rowCount: number; source: string }[] = [];
      db.on('reverseSeed', (data) => events.push(data));

      await db.reverseSeed(outputDir);
      expect(events).toHaveLength(1);
      expect(events[0]!.table).toBe('items');
      expect(events[0]!.rowCount).toBe(1);
      expect(events[0]!.source).toBe('files');
    });
  });

  // -------------------------------------------------------------------------
  // Preserves timestamps from parsed content
  // -------------------------------------------------------------------------

  it('preserves created_at and updated_at from parsed content', async () => {
    const ts = '2024-01-15T12:00:00.000Z';
    db = new Lattice(':memory:');
    db.define('logs', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        message: 'TEXT',
        created_at: 'TEXT',
        updated_at: 'TEXT',
      },
      render: 'default-json',
      outputFile: 'logs.json',
    });
    await db.init();
    await db.insert('logs', { id: 'l1', message: 'hello', created_at: ts, updated_at: ts });
    await db.render(outputDir);
    db.close();

    db = new Lattice(':memory:');
    db.define('logs', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        message: 'TEXT',
        created_at: 'TEXT',
        updated_at: 'TEXT',
      },
      render: 'default-json',
      outputFile: 'logs.json',
    });
    await db.init();

    await db.reverseSeed(outputDir);
    const rows = await db.query('logs', {});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.created_at).toBe(ts);
    expect(rows[0]!.updated_at).toBe(ts);
  });

  // -------------------------------------------------------------------------
  // TemplateRenderSpec (object form with hooks)
  // -------------------------------------------------------------------------

  it('recovers from TemplateRenderSpec (object form)', async () => {
    db = new Lattice(':memory:');
    db.define('tasks', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', priority: 'INTEGER' },
      render: { template: 'default-table' },
      outputFile: 'tasks.md',
    });
    await db.init();
    await db.insert('tasks', { id: 't1', title: 'Deploy', priority: 1 });
    await db.render(outputDir);
    db.close();

    db = new Lattice(':memory:');
    db.define('tasks', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', priority: 'INTEGER' },
      render: { template: 'default-table' },
      outputFile: 'tasks.md',
    });
    await db.init();

    const result = await db.reverseSeed(outputDir);
    expect(result.totalRowsRecovered).toBe(1);
  });
});
