/**
 * Retrieval declared in the config file.
 *
 * Full-text and semantic search are table capabilities, but until now they
 * could only be turned on from code (`define()`); the YAML config had no way to
 * express either. That gap made the whole retrieval stack inert for anyone
 * driving Lattice from a config file:
 *
 *   - no table ever carried `fts` / `embeddings`, so the doctor derived an
 *     EMPTY expectation list and reported a healthy database it had not in fact
 *     diagnosed,
 *   - `hybridSearch` never received an embeddings config, so the vector arm was
 *     skipped and search silently degraded to keyword-only,
 *   - `buildVectorIndex` (`lattice reindex`) could never succeed, because it
 *     requires the table's embeddings config to exist.
 *
 * These tests pin the config surface (parse + validate), the embedding function
 * it builds, and the end-to-end consequence: a config-declared table engages the
 * vector arm.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfigString } from '../../src/config/parser.js';
import { Lattice } from '../../src/lattice.js';

const configDir = '/fake/project';

function entityYaml(body: string): string {
  return [
    'db: ./app.db',
    'entities:',
    '  note:',
    '    fields:',
    '      id: { type: uuid, primaryKey: true }',
    '      title: { type: text }',
    '      body: { type: text }',
    '    render: default-list',
    '    outputFile: notes.md',
    body,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// fts:
// ---------------------------------------------------------------------------

describe('config — fts', () => {
  it('parses `fts: true` into an auto-detect fts config', () => {
    const parsed = parseConfigString(entityYaml('    fts: true'), configDir);
    const def = parsed.tables[0]?.definition;
    expect(def?.fts).toEqual({});
  });

  it('parses an explicit field list', () => {
    const parsed = parseConfigString(
      entityYaml('    fts:\n      fields: [title, body]'),
      configDir,
    );
    expect(parsed.tables[0]?.definition.fts).toEqual({ fields: ['title', 'body'] });
  });

  it('`fts: false` leaves the table without an fts config', () => {
    const parsed = parseConfigString(entityYaml('    fts: false'), configDir);
    expect(parsed.tables[0]?.definition.fts).toBeUndefined();
  });

  it('rejects a field that is not a declared column', () => {
    expect(() =>
      parseConfigString(entityYaml('    fts:\n      fields: [title, nope]'), configDir),
    ).toThrow(/note.*"nope".*"fts\.fields"/s);
  });

  it('rejects a non-object, non-boolean value', () => {
    expect(() => parseConfigString(entityYaml('    fts: yes-please'), configDir)).toThrow(
      /note.*"fts"/s,
    );
  });

  // This key is read while the config is being read, and every command reads the
  // config — so an entity that will not parse is an entity nothing can open until
  // the file is edited by hand. The message therefore has to be enough to make
  // that edit from, which means naming the fields that ARE available.
  it('names the fields that are available when one is not', () => {
    let message = '';
    try {
      parseConfigString(entityYaml('    fts:\n      fields: [title, nope]'), configDir);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/"nope"/);
    expect(message).toMatch(/"title"/);
    expect(message).toMatch(/"body"/);
  });

  // A relation sits next to the fields in the same entity and reads like one, so
  // naming it here is the mistake to expect. "not one of its fields" is true and
  // useless; say which it is and what to use instead.
  it('says so specifically when the name is a relation rather than a field', () => {
    const yaml = [
      'db: ./app.db',
      'entities:',
      '  note:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      title: { type: text }',
      '      author_id: { type: text }',
      '    relations:',
      '      author: { type: belongsTo, table: people, foreignKey: author_id }',
      '    fts:',
      '      fields: [title, author]',
      '    outputFile: notes.md',
      '',
    ].join('\n');
    expect(() => parseConfigString(yaml, configDir)).toThrow(
      /"author" is one of its relations, not one of its fields/,
    );
  });

  it('rejects an empty field list', () => {
    expect(() => parseConfigString(entityYaml('    fts:\n      fields: []'), configDir)).toThrow(
      /note.*fts.*at least one/s,
    );
  });
});

// ---------------------------------------------------------------------------
// embeddings:
// ---------------------------------------------------------------------------

const EMBEDDINGS_YAML = [
  '    embeddings:',
  '      fields: [title, body]',
  '      url: https://vectors.example/v1/embeddings',
  '      model: demo-embed',
].join('\n');

describe('config — embeddings', () => {
  it('round-trips into an embeddings config with fields, model id, and an embed function', () => {
    const parsed = parseConfigString(entityYaml(EMBEDDINGS_YAML), configDir);
    const emb = parsed.tables[0]?.definition.embeddings;
    expect(emb?.fields).toEqual(['title', 'body']);
    expect(emb?.modelId).toBe('demo-embed');
    expect(typeof emb?.embed).toBe('function');
  });

  it('carries scan cap, index tuning, and chunking through', () => {
    const parsed = parseConfigString(
      entityYaml(
        [
          EMBEDDINGS_YAML,
          '      maxScanChunks: 50000',
          '      index: { m: 24, efConstruction: 100, quantization: halfvec }',
          '      chunk: { maxChars: 400, overlap: 40 }',
        ].join('\n'),
      ),
      configDir,
    );
    const emb = parsed.tables[0]?.definition.embeddings;
    expect(emb?.maxScanChunks).toBe(50000);
    expect(emb?.index).toEqual({ m: 24, efConstruction: 100, quantization: 'halfvec' });
    expect(typeof emb?.chunker).toBe('function');
    expect(emb?.chunker?.('x'.repeat(900)).length).toBeGreaterThan(1);
  });

  it('omits the chunker when no chunk block is declared', () => {
    const parsed = parseConfigString(entityYaml(EMBEDDINGS_YAML), configDir);
    expect(parsed.tables[0]?.definition.embeddings?.chunker).toBeUndefined();
  });

  it('rejects a missing url — the destination text is sent to must be explicit', () => {
    expect(() =>
      parseConfigString(
        entityYaml('    embeddings:\n      fields: [title]\n      model: demo-embed'),
        configDir,
      ),
    ).toThrow(/note.*embeddings.*"url"/s);
  });

  it('rejects a non-http url', () => {
    expect(() =>
      parseConfigString(
        entityYaml(
          '    embeddings:\n      fields: [title]\n      model: m\n      url: ftp://host/embed',
        ),
        configDir,
      ),
    ).toThrow(/note.*embeddings.*http/s);
  });

  it('rejects a missing model', () => {
    expect(() =>
      parseConfigString(
        entityYaml('    embeddings:\n      fields: [title]\n      url: https://vectors.example/v1'),
        configDir,
      ),
    ).toThrow(/note.*embeddings.*"model"/s);
  });

  it('rejects a field that is not a declared column', () => {
    expect(() =>
      parseConfigString(
        entityYaml(
          '    embeddings:\n      fields: [title, nope]\n      url: https://vectors.example/v1\n      model: m',
        ),
        configDir,
      ),
    ).toThrow(/note.*"nope".*"embeddings\.fields"/s);
  });

  it('rejects an empty field list', () => {
    expect(() =>
      parseConfigString(
        entityYaml(
          '    embeddings:\n      fields: []\n      url: https://vectors.example/v1\n      model: m',
        ),
        configDir,
      ),
    ).toThrow(/note.*embeddings.*at least one/s);
  });

  it('rejects an api key spelled out in the config instead of named as an env var', () => {
    expect(() =>
      parseConfigString(
        entityYaml([EMBEDDINGS_YAML, '      apiKey: sk-secret'].join('\n')),
        configDir,
      ),
    ).toThrow(/note.*apiKeyEnv/s);
  });
});

// ---------------------------------------------------------------------------
// The embed function the config builds
// ---------------------------------------------------------------------------

describe('config — the embed function it builds', () => {
  let server: Server;
  let base: string;
  let seen: { auth?: string; body: unknown }[] = [];
  let respond: (body: unknown) => { status: number; payload: unknown } = () => ({
    status: 200,
    payload: { data: [{ embedding: [0.1, 0.2, 0.3] }] },
  });

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += String(c)));
      req.on('end', () => {
        const body: unknown = raw ? JSON.parse(raw) : null;
        seen.push({ auth: req.headers.authorization, body });
        const { status, payload } = respond(body);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no test server address');
    base = `http://127.0.0.1:${String(addr.port)}/v1/embeddings`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => {
      server.close(() => {
        r();
      });
    });
  });

  afterEach(() => {
    seen = [];
    respond = () => ({ status: 200, payload: { data: [{ embedding: [0.1, 0.2, 0.3] }] } });
    delete process.env.LATTICE_TEST_EMBED_KEY;
  });

  function embedderFor(extra = ''): (text: string) => Promise<number[]> {
    const parsed = parseConfigString(
      entityYaml(
        [
          '    embeddings:',
          '      fields: [title]',
          `      url: ${base}`,
          '      model: demo-embed',
          extra,
        ]
          .filter(Boolean)
          .join('\n'),
      ),
      configDir,
    );
    const embed = parsed.tables[0]?.definition.embeddings?.embed;
    if (!embed) throw new Error('config produced no embed function');
    return embed;
  }

  it('posts the model and text and returns the vector', async () => {
    const vec = await embedderFor()('hello world');
    expect(vec).toEqual([0.1, 0.2, 0.3]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body).toMatchObject({ model: 'demo-embed', input: 'hello world' });
    expect(seen[0]?.auth).toBeUndefined();
  });

  it('reads the key from the named environment variable at call time', async () => {
    process.env.LATTICE_TEST_EMBED_KEY = 'k-123';
    await embedderFor('      apiKeyEnv: LATTICE_TEST_EMBED_KEY')('hi');
    expect(seen[0]?.auth).toBe('Bearer k-123');
  });

  it('throws when the named key variable is unset — never sends an unauthenticated request', async () => {
    await expect(embedderFor('      apiKeyEnv: LATTICE_TEST_EMBED_KEY')('hi')).rejects.toThrow(
      /LATTICE_TEST_EMBED_KEY/,
    );
    expect(seen).toHaveLength(0);
  });

  it('accepts the bare-embedding response shape', async () => {
    respond = () => ({ status: 200, payload: { embedding: [1, 2] } });
    await expect(embedderFor()('hi')).resolves.toEqual([1, 2]);
  });

  it('accepts the embeddings-array response shape', async () => {
    respond = () => ({ status: 200, payload: { embeddings: [[3, 4]] } });
    await expect(embedderFor()('hi')).resolves.toEqual([3, 4]);
  });

  it('throws on a non-2xx response', async () => {
    respond = () => ({ status: 500, payload: { error: 'boom' } });
    await expect(embedderFor()('hi')).rejects.toThrow(/500/);
  });

  it('throws on a response with no usable vector — never returns an empty one', async () => {
    respond = () => ({ status: 200, payload: { data: [] } });
    await expect(embedderFor()('hi')).rejects.toThrow(/embedding/i);
  });

  it('throws when the vector contains a non-finite number', async () => {
    respond = () => ({ status: 200, payload: { data: [{ embedding: [1, null, 3] }] } });
    await expect(embedderFor()('hi')).rejects.toThrow(/embedding/i);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: a config-declared table engages the vector arm
// ---------------------------------------------------------------------------

/** Wait for the background embedding writes to land, or fail saying they never did. */
async function waitForEmbeddings(db: Lattice, table: string, expected: number): Promise<void> {
  const { getAsyncOrSync } = await import('../../src/db/adapter.js');
  const deadline = Date.now() + 5000;
  for (;;) {
    const row = await getAsyncOrSync(
      db.adapter,
      `SELECT COUNT(*) AS n FROM "_lattice_embeddings" WHERE "table_name" = ?`,
      [table],
    );
    if (Number(row?.n ?? 0) >= expected) return;
    if (Date.now() > deadline) {
      throw new Error(
        `only ${String(row?.n ?? 0)} of ${String(expected)} embeddings were stored for "${table}"`,
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('config-declared retrieval, end to end', () => {
  let scratch: string;
  let server: Server;
  let embedCalls = 0;
  let prevConfigDir: string | undefined;
  let db: Lattice | undefined;

  // A deterministic 3-dim "embedding": presence of three marker words. Rows and
  // queries that share a marker land close together, so the vector arm has a
  // real ordering to contribute.
  function vectorFor(text: string): number[] {
    const t = text.toLowerCase();
    return [
      t.includes('budget') ? 1 : 0,
      t.includes('grocery') ? 1 : 0,
      t.length % 3 === 0 ? 1 : 0,
    ];
  }

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'lattice-config-retrieval-'));
    prevConfigDir = process.env.LATTICE_CONFIG_DIR;
    process.env.LATTICE_CONFIG_DIR = join(scratch, 'config');
    mkdirSync(process.env.LATTICE_CONFIG_DIR, { recursive: true });

    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += String(c)));
      req.on('end', () => {
        embedCalls++;
        const body = JSON.parse(raw || '{}') as { input?: string };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: vectorFor(body.input ?? '') }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });

  afterAll(async () => {
    db?.close();
    await new Promise<void>((r) => {
      server.close(() => {
        r();
      });
    });
    if (prevConfigDir === undefined) delete process.env.LATTICE_CONFIG_DIR;
    else process.env.LATTICE_CONFIG_DIR = prevConfigDir;
    rmSync(scratch, { recursive: true, force: true });
  });

  function configPath(): string {
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no test server address');
    const p = join(scratch, 'lattice.config.yml');
    writeFileSync(
      p,
      [
        'db: ":memory:"',
        'entities:',
        '  note:',
        '    fields:',
        '      id: { type: text, primaryKey: true }',
        '      title: { type: text }',
        '      body: { type: text }',
        '      deleted_at: { type: datetime }',
        '    fts:',
        '      fields: [title, body]',
        '    embeddings:',
        '      fields: [title, body]',
        `      url: http://127.0.0.1:${String(addr.port)}/v1/embeddings`,
        '      model: demo-embed',
        '    render: default-list',
        '    outputFile: notes.md',
        '',
      ].join('\n'),
      'utf8',
    );
    return p;
  }

  it('engages the vector arm of hybrid search and is diagnosable by the doctor', async () => {
    db = new Lattice({ config: configPath() });
    await db.init();
    await db.insert('note', { id: 'n1', title: 'budget review', body: 'quarterly numbers' });
    await db.insert('note', { id: 'n2', title: 'grocery list', body: 'apples and pears' });
    // Embedding a written row does not block the write, so wait for both to land.
    await waitForEmbeddings(db, 'note', 2);
    expect(embedCalls).toBeGreaterThan(0);

    const results = await db.hybridSearch('note', 'budget');
    expect(results.length).toBeGreaterThan(0);
    // The whole point: the vector arm ran and ranked something. Keyword-only
    // fusion leaves every vectorRank null.
    expect(results.some((r) => r.explain.vectorRank !== null)).toBe(true);

    // And the same declaration is what the doctor derives its expectations from.
    const report = await db.diagnoseRetrieval();
    const note = report.tables.find((t) => t.table === 'note');
    expect(note).toBeDefined();
    expect(note?.ftsCoverage).toBe(1);
    expect(note?.embeddingCoverage).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// A failing endpoint must not look like a successful write
// ---------------------------------------------------------------------------

describe('an embeddings endpoint that cannot be reached', () => {
  let scratch: string;
  let prevConfigDir: string | undefined;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'lattice-embed-fail-'));
    prevConfigDir = process.env.LATTICE_CONFIG_DIR;
    process.env.LATTICE_CONFIG_DIR = join(scratch, 'config');
    mkdirSync(process.env.LATTICE_CONFIG_DIR, { recursive: true });
  });

  afterAll(() => {
    if (prevConfigDir === undefined) delete process.env.LATTICE_CONFIG_DIR;
    else process.env.LATTICE_CONFIG_DIR = prevConfigDir;
    rmSync(scratch, { recursive: true, force: true });
  });

  /** A workspace whose declared embeddings endpoint is a port nothing listens on. */
  function deadEndpointConfig(name: string): string {
    const p = join(scratch, `${name}.yml`);
    writeFileSync(
      p,
      [
        'db: ":memory:"',
        'entities:',
        '  note:',
        '    fields:',
        '      id: { type: text, primaryKey: true }',
        '      body: { type: text }',
        '    embeddings:',
        '      fields: [body]',
        '      url: http://127.0.0.1:9/embeddings',
        '      model: demo-embed',
        '      timeoutMs: 500',
        '    render: default-list',
        '    outputFile: notes.md',
        '',
      ].join('\n'),
      'utf8',
    );
    return p;
  }

  /** Wait until `predicate` holds, or give up. Background work is not awaited. */
  async function until(predicate: () => boolean, ms = 4000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return predicate();
  }

  // Embedding happens after the write returns, so it cannot throw at the caller
  // — it is reported instead. Reported only to listeners, and with nothing
  // registering one by default, that meant reported to nobody: a wrong endpoint
  // stored no vectors, printed nothing, exited zero, and left every later search
  // quietly missing its semantic half. Somebody has to hear about it.
  it('says so, rather than storing nothing and reporting success', async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map((a) => String(a)).join(' '));
    };
    const db = new Lattice({ config: deadEndpointConfig('no-listener') });
    try {
      await db.init();
      await db.insert('note', { id: 'n1', body: 'quarterly budget notes' });
      const surfaced = await until(() => errors.some((e) => /embeddings request/i.test(e)));
      expect(surfaced).toBe(true);
    } finally {
      console.error = original;
      db.close();
    }
  });

  it('goes to a registered listener instead when the host wants to route it', async () => {
    const seen: Error[] = [];
    const db = new Lattice({ config: deadEndpointConfig('with-listener') });
    db.on('error', (e) => seen.push(e));
    try {
      await db.init();
      await db.insert('note', { id: 'n1', body: 'quarterly budget notes' });
      const surfaced = await until(() => seen.some((e) => /embeddings request/i.test(e.message)));
      expect(surfaced).toBe(true);
    } finally {
      db.close();
    }
  });
});
