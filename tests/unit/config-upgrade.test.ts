import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upgradeConfigShape } from '../../src/config/config-upgrade.js';
import { parseConfigString, parseConfigFile } from '../../src/config/parser.js';

// ---------------------------------------------------------------------------
// upgradeConfigShape — silent on-disk migration of the 3.x per-field `ref:`
// shorthand to an explicit entity-level `relations:` belongsTo. The rewrite
// preserves comments/formatting and must mirror exactly what the parser
// derives in-memory from the un-upgraded `ref:` (see config/parser.ts).
// ---------------------------------------------------------------------------

describe('upgradeConfigShape()', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lattice-config-upgrade-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, contents: string): string {
    const path = join(dir, name);
    writeFileSync(path, contents, 'utf8');
    return path;
  }

  it('rewrites a `ref:` field to an explicit relations belongsTo and returns true', () => {
    const path = write(
      'lattice.config.yml',
      `db: ./app.db
entities:
  ticket:
    fields:
      id: { type: uuid, primaryKey: true }
      assignee_id: { type: uuid, ref: users }
    outputFile: tickets.md
`,
    );

    const changed = upgradeConfigShape(path);
    expect(changed).toBe(true);

    // The on-disk YAML re-parses cleanly and the field no longer carries `ref:`.
    const { tables } = parseConfigFile(path);
    const def = tables[0]!.definition;
    // Relation name = field name minus trailing `_id`, foreignKey = field name.
    expect(def.relations?.assignee).toEqual({
      type: 'belongsTo',
      table: 'users',
      foreignKey: 'assignee_id',
    });

    // The raw file must no longer mention the `ref:` key.
    const rewritten = readFileSync(path, 'utf8');
    expect(rewritten).not.toMatch(/\bref:/);
    expect(rewritten).toMatch(/relations:/);
  });

  it('produces the same belongsTo on disk that the parser derives in-memory from `ref:`', () => {
    const yamlWithRef = `db: ./app.db
entities:
  ticket:
    fields:
      id: { type: uuid, primaryKey: true }
      assignee_id: { type: uuid, ref: users }
    outputFile: tickets.md
`;
    // In-memory tolerance: the parser derives the belongsTo straight from `ref:`.
    const fromRef = parseConfigString(yamlWithRef, dir).tables[0]!.definition.relations?.assignee;

    // On-disk rewrite: upgrade the file, then re-parse the rewritten YAML.
    const path = write('lattice.config.yml', yamlWithRef);
    expect(upgradeConfigShape(path)).toBe(true);
    const fromDisk = parseConfigFile(path).tables[0]!.definition.relations?.assignee;

    // The on-disk rewrite must equal the in-memory tolerance.
    expect(fromDisk).toEqual(fromRef);
    expect(fromDisk).toEqual({ type: 'belongsTo', table: 'users', foreignKey: 'assignee_id' });
  });

  it('is idempotent — a second run returns false and leaves the file byte-identical', () => {
    const path = write(
      'lattice.config.yml',
      `db: ./app.db
entities:
  ticket:
    fields:
      id: { type: uuid, primaryKey: true }
      assignee_id: { type: uuid, ref: users }
    outputFile: tickets.md
`,
    );

    expect(upgradeConfigShape(path)).toBe(true);
    const afterFirst = readFileSync(path, 'utf8');

    expect(upgradeConfigShape(path)).toBe(false);
    const afterSecond = readFileSync(path, 'utf8');

    expect(afterSecond).toBe(afterFirst);
  });

  it('does not rewrite a config that already uses `relations:` (returns false, byte-identical)', () => {
    const original = `db: ./app.db
entities:
  ticket:
    fields:
      id: { type: uuid, primaryKey: true }
      assignee_id: { type: uuid }
    relations:
      assignee: { type: belongsTo, table: users, foreignKey: assignee_id }
    outputFile: tickets.md
`;
    const path = write('lattice.config.yml', original);

    expect(upgradeConfigShape(path)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('does not rewrite a config with no relations at all (returns false, byte-identical)', () => {
    const original = `db: ./app.db
entities:
  note:
    fields:
      id: { type: uuid, primaryKey: true }
      body: { type: text }
    outputFile: notes.md
`;
    const path = write('lattice.config.yml', original);

    expect(upgradeConfigShape(path)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('does not strip when the field name has no `_id` suffix (relation name = field name)', () => {
    const path = write(
      'lattice.config.yml',
      `db: ./app.db
entities:
  ticket:
    fields:
      id: { type: uuid, primaryKey: true }
      owner: { type: uuid, ref: people }
    outputFile: tickets.md
`,
    );

    expect(upgradeConfigShape(path)).toBe(true);

    const def = parseConfigFile(path).tables[0]!.definition;
    expect(def.relations?.owner).toEqual({
      type: 'belongsTo',
      table: 'people',
      foreignKey: 'owner',
    });
    // No `_id` strip → there is no `peopl`-style truncated relation name.
    expect(def.relations?.owne).toBeUndefined();
  });

  it('preserves comments and other entities across the rewrite', () => {
    const path = write(
      'lattice.config.yml',
      `# top-level config comment
db: ./app.db
entities:
  ticket:
    # ticket entity comment
    fields:
      id: { type: uuid, primaryKey: true }
      assignee_id: { type: uuid, ref: users } # field comment
    outputFile: tickets.md
  note:
    fields:
      id: { type: uuid, primaryKey: true }
      body: { type: text }
    outputFile: notes.md
`,
    );

    expect(upgradeConfigShape(path)).toBe(true);

    const rewritten = readFileSync(path, 'utf8');
    // Comments survive.
    expect(rewritten).toContain('# top-level config comment');
    expect(rewritten).toContain('# ticket entity comment');
    // The untouched second entity survives intact.
    expect(rewritten).toContain('note:');
    expect(rewritten).toContain('body: { type: text }');

    // Both entities still parse; the upgraded relation is present.
    const { tables } = parseConfigFile(path);
    const ticket = tables.find((t) => t.name === 'ticket')!.definition;
    const note = tables.find((t) => t.name === 'note')!.definition;
    expect(ticket.relations?.assignee).toEqual({
      type: 'belongsTo',
      table: 'users',
      foreignKey: 'assignee_id',
    });
    expect(note.relations).toBeUndefined();
  });

  it('does not overwrite an explicit `relations:` entry of the same derived name', () => {
    const path = write(
      'lattice.config.yml',
      `db: ./app.db
entities:
  ticket:
    fields:
      id: { type: uuid, primaryKey: true }
      assignee_id: { type: uuid, ref: users }
    relations:
      assignee: { type: belongsTo, table: people, foreignKey: assignee_id }
    outputFile: tickets.md
`,
    );

    // The `ref:` key is still stripped (it's a no-longer-supported shape), but the
    // pre-existing explicit relation wins and is NOT clobbered by the shorthand.
    expect(upgradeConfigShape(path)).toBe(true);

    const def = parseConfigFile(path).tables[0]!.definition;
    expect(def.relations?.assignee).toEqual({
      type: 'belongsTo',
      table: 'people',
      foreignKey: 'assignee_id',
    });
  });
});
