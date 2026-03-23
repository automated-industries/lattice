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
    expect(() => parseConfigString('entities: {}', configDir)).toThrow(
      /config\.db must be a string/,
    );
  });

  it('throws when entities key is missing', () => {
    expect(() => parseConfigString('db: ./app.db', configDir)).toThrow(
      /config\.entities must be an object/,
    );
  });

  it('throws on malformed YAML', () => {
    expect(() => parseConfigString('db: [\nbad yaml{{{', configDir)).toThrow(/YAML parse error/);
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
    expect(def.columns.id).toBe('TEXT PRIMARY KEY');
    expect(def.columns.name).toBe('TEXT');
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
    expect(tables[0]!.definition.columns.title).toBe('TEXT NOT NULL');
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
    expect(tables[0]!.definition.columns.status).toBe("TEXT DEFAULT 'open'");
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
    expect(tables[0]!.definition.columns.score).toBe('INTEGER DEFAULT 0');
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
    expect(cols.a).toMatch(/^TEXT/);
    expect(cols.b).toMatch(/^TEXT/);
    expect(cols.c).toMatch(/^INTEGER/);
    expect(cols.d).toMatch(/^INTEGER/);
    expect(cols.e).toMatch(/^REAL/);
    expect(cols.f).toMatch(/^REAL/);
    expect(cols.g).toMatch(/^INTEGER/);
    expect(cols.h).toMatch(/^INTEGER/);
    expect(cols.i).toMatch(/^TEXT/);
    expect(cols.j).toMatch(/^TEXT/);
    expect(cols.k).toMatch(/^BLOB/);
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
    expect(def.relations?.assignee).toMatchObject({
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
    expect(tables[0]!.definition.relations?.post).toMatchObject({ table: 'posts' });
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
// entityContexts parsing — unit tests
// ---------------------------------------------------------------------------

describe('parseConfigString() — entityContexts', () => {
  const configDir = '/fake/project';

  const baseYaml = `
db: ./app.db
entities:
  agent:
    fields:
      id: { type: uuid, primaryKey: true }
      slug: { type: text }
      name: { type: text }
    render: default-list
    outputFile: agents.md
`;

  it('returns empty array when entityContexts key is absent', () => {
    const result = parseConfigString(baseYaml, configDir);
    expect(result.entityContexts).toEqual([]);
  });

  it('parses a single entity context with self source', () => {
    const yaml =
      baseYaml +
      `
entityContexts:
  agent:
    slug: "{{slug}}"
    files:
      AGENT.md:
        source: self
        template: default-detail
`;
    const result = parseConfigString(yaml, configDir);
    expect(result.entityContexts).toHaveLength(1);
    expect(result.entityContexts[0]?.table).toBe('agent');
    const def = result.entityContexts[0]!.definition;
    expect(def.files['AGENT.md']).toBeDefined();
    expect(def.files['AGENT.md']!.source).toEqual({ type: 'self' });
    expect(def.files['AGENT.md']!.render).toBeTypeOf('function');
  });

  it('extracts slug field from {{field}} template', () => {
    const yaml =
      baseYaml +
      `
entityContexts:
  agent:
    slug: "{{slug}}"
    files:
      AGENT.md:
        source: self
        template: default-list
`;
    const result = parseConfigString(yaml, configDir);
    const slugFn = result.entityContexts[0]!.definition.slug;
    expect(slugFn({ slug: 'alpha', name: 'Alpha' })).toBe('alpha');
  });

  it('parses hasMany source', () => {
    const yaml =
      baseYaml +
      `
entityContexts:
  agent:
    slug: "{{slug}}"
    files:
      TASKS.md:
        source:
          type: hasMany
          table: tasks
          foreignKey: agent_id
        template: default-list
`;
    const result = parseConfigString(yaml, configDir);
    const source = result.entityContexts[0]!.definition.files['TASKS.md']!.source;
    expect(source).toMatchObject({ type: 'hasMany', table: 'tasks', foreignKey: 'agent_id' });
  });

  it('parses hasMany source with references', () => {
    const yaml =
      baseYaml +
      `
entityContexts:
  agent:
    slug: "{{slug}}"
    files:
      TASKS.md:
        source:
          type: hasMany
          table: tasks
          foreignKey: agent_id
          references: agent_slug
        template: default-list
`;
    const result = parseConfigString(yaml, configDir);
    const source = result.entityContexts[0]!.definition.files['TASKS.md']!.source;
    expect(source).toMatchObject({
      type: 'hasMany',
      table: 'tasks',
      foreignKey: 'agent_id',
      references: 'agent_slug',
    });
  });

  it('parses manyToMany source', () => {
    const yaml =
      baseYaml +
      `
entityContexts:
  agent:
    slug: "{{slug}}"
    files:
      SKILLS.md:
        source:
          type: manyToMany
          junctionTable: agent_skills
          localKey: agent_id
          remoteKey: skill_id
          remoteTable: skills
        template: default-list
        omitIfEmpty: true
`;
    const result = parseConfigString(yaml, configDir);
    const spec = result.entityContexts[0]!.definition.files['SKILLS.md']!;
    expect(spec.source).toMatchObject({
      type: 'manyToMany',
      junctionTable: 'agent_skills',
      localKey: 'agent_id',
      remoteKey: 'skill_id',
      remoteTable: 'skills',
    });
    expect(spec.omitIfEmpty).toBe(true);
  });

  it('parses belongsTo source', () => {
    const yaml =
      baseYaml +
      `
entityContexts:
  agent:
    slug: "{{slug}}"
    files:
      ORG.md:
        source:
          type: belongsTo
          table: orgs
          foreignKey: org_id
        template: default-detail
`;
    const result = parseConfigString(yaml, configDir);
    const source = result.entityContexts[0]!.definition.files['ORG.md']!.source;
    expect(source).toMatchObject({ type: 'belongsTo', table: 'orgs', foreignKey: 'org_id' });
  });

  it('passes through budget', () => {
    const yaml =
      baseYaml +
      `
entityContexts:
  agent:
    slug: "{{slug}}"
    files:
      AGENT.md:
        source: self
        template: default-detail
        budget: 4000
`;
    const result = parseConfigString(yaml, configDir);
    expect(result.entityContexts[0]!.definition.files['AGENT.md']!.budget).toBe(4000);
  });

  it('passes through omitIfEmpty', () => {
    const yaml =
      baseYaml +
      `
entityContexts:
  agent:
    slug: "{{slug}}"
    files:
      EVENTS.md:
        source:
          type: hasMany
          table: events
          foreignKey: agent_id
        template: default-list
        omitIfEmpty: true
`;
    const result = parseConfigString(yaml, configDir);
    expect(result.entityContexts[0]!.definition.files['EVENTS.md']!.omitIfEmpty).toBe(true);
  });

  it('parses directoryRoot and protectedFiles', () => {
    const yaml =
      baseYaml +
      `
entityContexts:
  agent:
    slug: "{{slug}}"
    directoryRoot: agents
    protectedFiles:
      - SESSION.md
      - NOTES.md
    files:
      AGENT.md:
        source: self
        template: default-list
`;
    const result = parseConfigString(yaml, configDir);
    const def = result.entityContexts[0]!.definition;
    expect(def.directoryRoot).toBe('agents');
    expect(def.protectedFiles).toEqual(['SESSION.md', 'NOTES.md']);
  });

  it('parses index spec', () => {
    const yaml =
      baseYaml +
      `
entityContexts:
  agent:
    slug: "{{slug}}"
    index:
      outputFile: agents/AGENTS.md
      render: default-table
    files:
      AGENT.md:
        source: self
        template: default-list
`;
    const result = parseConfigString(yaml, configDir);
    const def = result.entityContexts[0]!.definition;
    expect(def.index).toBeDefined();
    expect(def.index!.outputFile).toBe('agents/AGENTS.md');
    expect(def.index!.render).toBeTypeOf('function');
  });

  it('parses combined spec', () => {
    const yaml =
      baseYaml +
      `
entityContexts:
  agent:
    slug: "{{slug}}"
    files:
      AGENT.md:
        source: self
        template: default-list
    combined:
      outputFile: CONTEXT.md
      exclude:
        - CONTEXT.md
`;
    const result = parseConfigString(yaml, configDir);
    const def = result.entityContexts[0]!.definition;
    expect(def.combined).toBeDefined();
    expect(def.combined!.outputFile).toBe('CONTEXT.md');
    expect(def.combined!.exclude).toEqual(['CONTEXT.md']);
  });

  it('render function for default-list produces bullet list', () => {
    const yaml =
      baseYaml +
      `
entityContexts:
  agent:
    slug: "{{slug}}"
    files:
      AGENT.md:
        source: self
        template: default-list
`;
    const result = parseConfigString(yaml, configDir);
    const renderFn = result.entityContexts[0]!.definition.files['AGENT.md']!.render;
    const output = renderFn([{ name: 'Alpha', slug: 'alpha' }]);
    expect(output).toContain('- ');
    expect(output).toContain('name: Alpha');
  });

  it('render function for default-table produces markdown table', () => {
    const yaml =
      baseYaml +
      `
entityContexts:
  agent:
    slug: "{{slug}}"
    files:
      AGENT.md:
        source: self
        template: default-table
`;
    const result = parseConfigString(yaml, configDir);
    const renderFn = result.entityContexts[0]!.definition.files['AGENT.md']!.render;
    const output = renderFn([{ name: 'Alpha', slug: 'alpha' }]);
    expect(output).toContain('| name | slug |');
    expect(output).toContain('| Alpha | alpha |');
  });

  it('render function for default-json produces JSON', () => {
    const yaml =
      baseYaml +
      `
entityContexts:
  agent:
    slug: "{{slug}}"
    files:
      AGENT.md:
        source: self
        template: default-json
`;
    const result = parseConfigString(yaml, configDir);
    const renderFn = result.entityContexts[0]!.definition.files['AGENT.md']!.render;
    const output = renderFn([{ name: 'Alpha' }]);
    expect(JSON.parse(output)).toEqual([{ name: 'Alpha' }]);
  });

  it('parses multiple entity contexts', () => {
    const yaml =
      baseYaml +
      `
entityContexts:
  agent:
    slug: "{{slug}}"
    files:
      AGENT.md:
        source: self
        template: default-list
  project:
    slug: "{{name}}"
    files:
      PROJECT.md:
        source: self
        template: default-detail
`;
    const result = parseConfigString(yaml, configDir);
    expect(result.entityContexts).toHaveLength(2);
    expect(result.entityContexts.map((ec) => ec.table)).toEqual(['agent', 'project']);
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
    expect(ticket.definition.relations?.assignee).toMatchObject({
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
