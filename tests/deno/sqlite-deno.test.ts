// Deno-runtime parity tests for DenoSqliteAdapter (node:sqlite backend).
//
// These run under `deno test` (CI's Node is too old for node:sqlite). They import
// the BUILT library — run `npm run build` first — because the TypeScript sources
// use NodeNext `.js` import specifiers that Deno doesn't resolve to `.ts`.
//
//   deno test --allow-read --allow-write --allow-env tests/deno/
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { Lattice, DenoSqliteAdapter, attachBlob } from '../../dist/index.js';

Deno.test('DenoSqliteAdapter — CRUD, pragmas, introspection', () => {
  const dir = Deno.makeTempDirSync();
  const a = new DenoSqliteAdapter(`${dir}/a.db`);
  a.open();
  assertEquals(a.dialect, 'sqlite');

  a.run('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, blob BLOB)');
  assertEquals(a.introspectColumns('t'), ['id', 'name', 'blob']);

  const info = a.prepare('INSERT INTO t (name) VALUES (?)').run('alpha');
  assertEquals(info.changes, 1);
  assert(info.lastInsertRowid !== undefined);

  assertEquals(a.get('SELECT name FROM t WHERE id = ?', [1])?.name, 'alpha');
  assertEquals(a.all('SELECT * FROM t').length, 1);

  // ALTER with a non-constant default → strip + backfill
  a.addColumn('t', 'created_at', 'TEXT DEFAULT CURRENT_TIMESTAMP');
  assert(a.introspectColumns('t').includes('created_at'));
  assert((a.get('SELECT created_at FROM t WHERE id = ?', [1])?.created_at as string)?.length > 0);

  a.close();
});

Deno.test('DenoSqliteAdapter — changeProbe stable when idle, changes on write', () => {
  const dir = Deno.makeTempDirSync();
  const a = new DenoSqliteAdapter(`${dir}/p.db`);
  a.open();
  a.run('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  const p1 = a.changeProbe();
  assertEquals(a.changeProbe(), p1); // idle → identical
  a.run('INSERT INTO t DEFAULT VALUES');
  assert(a.changeProbe() !== p1); // write → changes
  a.close();
});

Deno.test('DenoSqliteAdapter — BLOB byte round-trip', () => {
  const dir = Deno.makeTempDirSync();
  const a = new DenoSqliteAdapter(`${dir}/b.db`);
  a.open();
  a.run('CREATE TABLE t (id INTEGER PRIMARY KEY, blob BLOB)');
  const bytes = new Uint8Array([1, 2, 3, 250, 0, 128]);
  a.run('INSERT INTO t (blob) VALUES (?)', [bytes]);
  const got = a.get('SELECT blob FROM t WHERE id = 1')?.blob as Uint8Array;
  assertEquals(Array.from(got), Array.from(bytes));
  a.close();
});

Deno.test('DenoSqliteAdapter — withClient commits, rolls back on throw', async () => {
  const dir = Deno.makeTempDirSync();
  const a = new DenoSqliteAdapter(`${dir}/tx.db`);
  a.open();
  a.run('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');

  await a.withClient(async (tx) => {
    await tx.run("INSERT INTO t (name) VALUES ('committed')");
  });
  assertEquals(a.get("SELECT COUNT(*) AS n FROM t WHERE name = 'committed'")?.n, 1);

  const before = (a.get('SELECT COUNT(*) AS n FROM t') as { n: number }).n;
  let threw = false;
  try {
    await a.withClient(async (tx) => {
      await tx.run("INSERT INTO t (name) VALUES ('rollme')");
      throw new Error('boom');
    });
  } catch {
    threw = true;
  }
  assert(threw);
  assertEquals((a.get('SELECT COUNT(*) AS n FROM t') as { n: number }).n, before);
  a.close();
});

Deno.test('Lattice end-to-end under Deno auto-selects DenoSqliteAdapter + persists', async () => {
  const dir = Deno.makeTempDirSync();
  const dbPath = `${dir}/lattice.db`;

  const db = new Lattice(dbPath);
  assertEquals(
    (db as unknown as { _adapter: { constructor: { name: string } } })._adapter.constructor.name,
    'DenoSqliteAdapter',
  );
  db.define('items', {
    columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', score: 'INTEGER DEFAULT 0' },
    render: () => '',
    outputFile: 'items.md',
  });
  await db.init();
  await db.insert('items', { id: 'a', name: 'Alpha', score: 10 });
  await db.insert('items', { id: 'b', name: 'Beta', score: 90 });
  assertEquals(
    (await db.query('items', { filters: [{ col: 'score', op: 'gt', val: 50 }] })).length,
    1,
  );
  db.close();

  // Persistence across reopen
  const db2 = new Lattice(dbPath);
  db2.define('items', {
    columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', score: 'INTEGER DEFAULT 0' },
    render: () => '',
    outputFile: 'items.md',
  });
  await db2.init();
  assertEquals((await db2.query('items', {})).length, 2);
  db2.close();

  // Disk-based blob store round-trip (the real Lattice file path)
  const src = `${Deno.makeTempDirSync()}/hello.bin`;
  const payload = new Uint8Array([72, 105, 0, 255]);
  Deno.writeFileSync(src, payload);
  const meta = await attachBlob(src, dir);
  assertEquals(Array.from(Deno.readFileSync(`${dir}/${meta.blob_path}`)), Array.from(payload));
});
