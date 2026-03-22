import { describe, it, expect } from 'vitest';
import { resolve, join } from 'node:path';
import { parseConfigFile, parseConfigString } from '../../src/config/parser.js';

const FIXTURES_DIR = resolve(import.meta.dirname, '../fixtures');
const FIXTURE_CONFIG = join(FIXTURES_DIR, 'lattice.config.yml');

// ---------------------------------------------------------------------------
// parseConfigString — unit tests (no filesystem required)
// ---------------------------------------------------------------------------

describe('parseConfigString()', () => {
  const configDir = '/fake/project';

  it('parses minimal valid config', () => {
    const yaml = `
db: ./data/app.db
entities:
  note:
    fields:
      id: { type: uuid, primaryKey: true }
      body: { type: text }
    render: default-list
    outputFile: notes.md
`;
    const result = parseConfigString(yaml, configDir);
    expect(result.dbPath).toBe(resolve(configDir, './data/app.db'));
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]?.name).toBe('note');
  });

  it('throws when db key is missing', () => {
    expect(() =>
      parseConfigString('entities: {}', configDir),
    ).toThrow(/config\.db must be a string/);
  });

  it('throws when entities key is missing', () => {
    expect(() =>
      parseConfigString('db: ./app.db', configDir),
    ).toThrow(/config\.entities must be an object/);
  });

  it('throws on malformed YAML', () => {
    expect(() =>
      parseConfigString('db: [\nbad yaml{{{', configDir),
    ).toThrow(/YAML parse error/);
  });

  it('throws when entity has no fields', () => {
    const yaml = `
db: ./app.db
entities:
  broken:
    render: default-list
    outputFile: out.md
`;
    expect(() => parseConfigString(yaml, configDir)).toThrow(/must have a "fields" object/);
  });

  // -------------------------------------------------------------------------
  // Column spec generation
  // -------------------------------------------------------------------------

  it('maps uuid type to TEXT PRIMARY KEY', () => {
    const yaml = `
db: ./app.db
entities:
  item:
    fields:
      id: { type: uuid, primaryKey: true }
      name: { type: text }
    render: default-list
    outputFile: items.md
`;
    const { tables } = parseConfigString(yaml, configDir);
    const def = tables[0]!.definition;
    expect(def.columns['id']).toBe('TEXT PRIMARY KEY');
    expect(def.columns['name']).toBe('TEXT');
  });

  it('maps required to NOT NULL', () => {
    const yaml = `
db: ./app.db
entities:
  item:
    fields:
      id: { type: uuid, primaryKey: true }
      title: { type: text, required: true }
    render: default-list
    outputFile: items.md
`;
    const { tables } = parseConfigString(yaml, configDir);
    expect(tables[0]!.definition.columns['title']).toBe('TEXT NOT NULL');
  });

  it('maps string default correctly', () => {
    const yaml = `
db: ./app.db
entities:
  item:
    fields:
      id: { type: uuid, primaryKey: true }
      status: { type: text, default: open }
    render: default-list
    outputFile: items.md
`;
    const { tables } = parseConfigString(yaml, configDir);
    expect(tables[0]!.definition.columns['status']).toBe("TEXT DEFAULT 'open'");
  });

  it('maps numeric default correctly', () => {
    const yaml = `
db: ./app.db
entities:
  item:
    fields:
      id: { type: uuid, primaryKey: true }
      score: { type: integer, default: 0 }
    render: default-list
    outputFile: items.md
`;
    const { tables } = parseConfigString(yaml, configDir);
    expect(tables[0]!.definition.columns['score']).toBe('INTEGER DEFAULT 0');
  });

  it('maps all scalar types to correct SQLite types', () => {
    const yaml = `
db: ./app.db
entities:
  item:
    fields:
      a: { type: uuid }
      b: { type: text }
      c: { type: integer }
      d: { type: int }
      e: { type: real }
      f: { type: float }
      g: { type: boolean }
      h: { type: bool }
      i: { type: datetime }
      j: { type: date }
      k: { type: blob }
    render: default-list
    outputFile: items.md
`;
    const { tables } = parseConfigString(yaml, configDir);
    const cols = tables[0]!.definition.columns;
    expect(cols['a']).toMatch(/^TEXT/);
    expect(cols['b']).toMatch(/^TEXT/);
    expect(cols['c']).toMatch(/^INTEGER/);
    expect(cols['d']).toMatch(/^INTEGER/);
    expect(cols['e']).toMatch(/^REAL/);
    expect(cols['f']).toMatch(/^REAL/);
    expect(cols['g']).toMatch(/^INTEGER/);
    expect(cols['h']).toMatch(/^INTEGER/);
    expect(cols['i']).toMatch(/^TEXT/);
    expect(cols['j']).toMatch(/^TEXT/);
    expect(cols['k']).toMatch(/^BLOB/);
  });

  // -------------------------------------------------------------------------
  // Primary key
  // -------------------------------------------------------------------------

  it('extracts primaryKey from field with primaryKey: true', () => {
    const yaml = `
db: ./app.db
entities:
  item:
    fields:
      slug: { type: text, primaryKey: true }
      body: { type: text }
    render: default-list
    outputFile: items.md
`;
    const { tables } = parseConfigString(yaml, configDir);
    expect(tables[0]!.definition.primaryKey).toBe('slug');
  });

  it('entity-level primaryKey overrides field-level', () => {
    const yaml = `
db: ./app.db
entities:
  item:
    fields:
      a: { type: text }
      b: { type: text }
    primaryKey: [a, b]
    render: default-list
    outputFile: items.md
`;
    const { tables } = parseConfigString(yaml, configDir);
    expect(tables[0]!.definition.primaryKey).toEqual(['a', 'b']);
  });

  // -------------------------------------------------------------------------
  // Relations from ref
  // -------------------------------------------------------------------------

  it('creates belongsTo relation from ref field, stripping _id suffix', () => {
    const yaml = `
db: ./app.db
entities:
  ticket:
    fields:
      id: { type: uuid, primaryKey: true }
      assignee_id: { type: uuid, ref: user }
    render: default-list
    outputFile: tickets.md
`;
    const { tables } = parseConfigString(yaml, configDir);
    const def = tables[0]!.definition;
    expect(def.relations?.['assignee']).toMatchObject({
      type: 'belongsTo',
      table: 'user',
      foreignKey: 'assignee_id',
    });
  });

  it('keeps full field name as relation name when no _id suffix', () => {
    const yaml = `
db: ./app.db
entities:
  comment:
    fields:
      id: { type: uuid, primaryKey: true }
      post: { type: text, ref: posts }
    render: default-list
    outputFile: comments.md
`;
    const { tables } = parseConfigString(yaml, configDir);
    expect(tables[0]!.definition.relations?.['post']).toMatchObject({ table: 'posts' });
  });

  // -------------------------------------------------------------------------
  // Render spec forms
  // -------------------------------------------------------------------------

  it('accepts plain BuiltinTemplateName string', () => {
    const yaml = `
db: ./app.db
entities:
  item:
    fields:
      id: { type: uuid, primaryKey: true }
    render: default-table
    outputFile: items.md
`;
    const { tables } = parseConfigString(yaml, configDir);
    expect(tables[0]!.definition.render).toBe('default-table');
  });

  it('accepts { template, formatRow } object and wraps in TemplateRenderSpec', () => {
    const yaml = `
db: ./app.db
entities:
  item:
    fields:
      id: { type: uuid, primaryKey: true }
      title: { type: text }
    render:
      template: default-list
      formatRow: "{{title}}"
    outputFile: items.md
`;
    const { tables } = parseConfigString(yaml, configDir);
    const render = tables[0]!.definition.render;
    expect(render).toMatchObject({
      template: 'default-list',
      hooks: { formatRow: '{{title}}' },
    });
  });

  it('defaults render to default-list when omitted', () => {
    const yaml = `
db: ./app.db
entities:
  item:
    fields:
      id: { type: uuid, primaryKey: true }
    outputFile: items.md
`;
    const { tables } = parseConfigString(yaml, configDir);
    expect(tables[0]!.definition.render).toBe('default-list');
  });

  // -------------------------------------------------------------------------
  // outputFile resolution
  // -------------------------------------------------------------------------

  it('resolves outputFile relative to configDir', () => {
    const yaml = `
db: ./app.db
entities:
  item:
    fields:
      id: { type: uuid, primaryKey: true }
    render: default-list
    outputFile: context/items.md
`;
    const { tables } = parseConfigString(yaml, '/project');
    expect(tables[0]!.definition.outputFile).toBe('/project/context/items.md');
  });

  // -------------------------------------------------------------------------
  // Multiple entities
  // -------------------------------------------------------------------------

  it('parses multiple entities preserving order', () => {
    const yaml = `
db: ./app.db
entities:
  alpha:
    fields:
      id: { type: uuid, primaryKey: true }
    render: default-list
    outputFile: alpha.md
  beta:
    fields:
      id: { type: uuid, primaryKey: true }
    render: default-list
    outputFile: beta.md
  gamma:
    fields:
      id: { type: uuid, primaryKey: true }
    render: default-list
    outputFile: gamma.md
`;
    const { tables } = parseConfigString(yaml, configDir);
    expect(tables).toHaveLength(3);
    expect(tables.map((t) => t.name)).toEqual(['alpha', 'beta', 'gamma']);
  });
});

// ---------------------------------------------------------------------------
// parseConfigFile — filesystem tests
// ---------------------------------------------------------------------------

describe('parseConfigFile()', () => {
  it('reads and parses fixture config', () => {
    const result = parseConfigFile(FIXTURE_CONFIG);
    expect(result.tables).toHaveLength(2);
    expect(result.tables.map((t) => t.name)).toEqual(['user', 'ticket']);
  });

  it('resolves db path relative to config file directory', () => {
    const result = parseConfigFile(FIXTURE_CONFIG);
    expect(result.dbPath).toBe(join(FIXTURES_DIR, 'data/test.db'));
  });

  it('throws on a non-existent file', () => {
    expect(() => parseConfigFile('/no/such/file.yml')).toThrow(/cannot read config file/);
  });

  it('fixture ticket entity has assignee belongsTo relation', () => {
    const result = parseConfigFile(FIXTURE_CONFIG);
    const ticket = result.tables.find((t) => t.name === 'ticket')!;
    expect(ticket.definition.relations?.['assignee']).toMatchObject({
      type: 'belongsTo',
      table: 'user',
      foreignKey: 'assignee_id',
    });
  });

  it('fixture ticket render spec has formatRow hook', () => {
    const result = parseConfigFile(FIXTURE_CONFIG);
    const ticket = result.tables.find((t) => t.name === 'ticket')!;
    expect(ticket.definition.render).toMatchObject({
      template: 'default-list',
      hooks: { formatRow: '{{title}} ({{status}})' },
    });
  });
});
