// Comprehensive end-to-end smoke against a real Postgres for the PR 2
// async-flip. Mirrors the scenarios that the four new vitest integration
// test files cover. Run before publishing.
//
//   LATTICE_TEST_PG_URL=postgres://... node tests/smoke/smoke-pg-full.mjs
//
// Why standalone: vitest 2.1.x + Node 24 + better-sqlite3 has a worker-exit
// flake on Windows that hangs the entire vitest run including the existing
// apply-migrations-async-postgres test. The CI environment (Ubuntu + Node
// 20) is unaffected. Use this script to validate the code paths locally.

import { Lattice } from '../../dist/index.js';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
if (!PG_URL) {
  console.error('Set LATTICE_TEST_PG_URL');
  process.exit(1);
}

const runId = randomBytes(4).toString('hex');
let pass = 0;
let fail = 0;

function check(label, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
  }
}

function expect(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(label, a === e, `expected ${e}, got ${a}`);
}

async function dropAll(db, ...tables) {
  const adapter = db.adapter;
  for (const t of tables) {
    try {
      if (adapter.runAsync) await adapter.runAsync(`DROP TABLE IF EXISTS "${t}"`);
      else adapter.run(`DROP TABLE IF EXISTS "${t}"`);
    } catch {}
  }
}

// =============================================================================
// 1. query-async-postgres
// =============================================================================
console.log('\n=== query-async-postgres scenarios ===');
{
  const tableName = `__smoke_${runId}_query`;
  const db = new Lattice(PG_URL);
  db.define(tableName, {
    columns: {
      id: 'TEXT PRIMARY KEY',
      name: 'TEXT NOT NULL',
      score: 'INTEGER',
      team: 'TEXT',
      deleted_at: 'TEXT',
    },
    render: () => '',
    outputFile: '/dev/null',
  });
  await db.init();

  await db.insert(tableName, { id: 'a', name: 'Alice', score: 90, team: 'red' });
  await db.insert(tableName, { id: 'b', name: 'Bob', score: 80, team: 'red' });
  await db.insert(tableName, { id: 'c', name: 'Charlie', score: 70, team: 'blue' });
  await db.insert(tableName, { id: 'd', name: 'Diana', score: null, team: 'blue' });
  await db.insert(tableName, {
    id: 'e',
    name: 'Eve',
    score: 60,
    team: 'red',
    deleted_at: '2026-01-01T00:00:00Z',
  });

  const all = await db.query(tableName);
  expect(all.length, 5, 'returns all rows when no filter');

  const eqRed = (await db.query(tableName, { where: { team: 'red' } })).map((r) => r.id).sort();
  expect(eqRed, ['a', 'b', 'e'], 'where shorthand');

  const eqBlue = (await db.query(tableName, { filters: [{ col: 'team', op: 'eq', val: 'blue' }] }))
    .map((r) => r.id)
    .sort();
  expect(eqBlue, ['c', 'd'], 'eq filter');

  const inIds = (
    await db.query(tableName, { filters: [{ col: 'id', op: 'in', val: ['a', 'c'] }] })
  )
    .map((r) => r.id)
    .sort();
  expect(inIds, ['a', 'c'], 'in filter');

  const likeNames = (await db.query(tableName, { filters: [{ col: 'name', op: 'like', val: '%li%' }] }))
    .map((r) => r.id)
    .sort();
  expect(likeNames, ['a', 'c'], 'like filter');

  const isNullRows = (await db.query(tableName, { filters: [{ col: 'score', op: 'isNull' }] })).map(
    (r) => r.id,
  );
  expect(isNullRows, ['d'], 'isNull filter');

  const isNotNullRows = (
    await db.query(tableName, { filters: [{ col: 'score', op: 'isNotNull' }] })
  )
    .map((r) => r.id)
    .sort();
  expect(isNotNullRows, ['a', 'b', 'c', 'e'], 'isNotNull filter');

  const gteRows = (
    await db.query(tableName, { filters: [{ col: 'score', op: 'gte', val: 80 }] })
  )
    .map((r) => r.id)
    .sort();
  expect(gteRows, ['a', 'b'], 'gte filter');

  const orderLimit = (
    await db.query(tableName, {
      filters: [{ col: 'score', op: 'isNotNull' }],
      orderBy: 'score',
      orderDir: 'desc',
      limit: 2,
    })
  ).map((r) => r.id);
  expect(orderLimit, ['a', 'b'], 'orderBy + limit');

  let rejected = false;
  try {
    await db.query(tableName, { where: { not_a_column: 'x' } });
  } catch (e) {
    rejected = e.message.includes('unknown column');
  }
  check('rejects unknown WHERE column', rejected);

  await dropAll(db, tableName);
  db.close();
}

// =============================================================================
// 2. insert-update-async-postgres
// =============================================================================
console.log('\n=== insert-update-async-postgres scenarios ===');
{
  const itemTable = `__smoke_${runId}_items`;
  const tagTable = `__smoke_${runId}_tags`;
  const itemTagTable = `__smoke_${runId}_item_tags`;
  const db = new Lattice(PG_URL);
  db.define(itemTable, {
    columns: {
      id: 'TEXT PRIMARY KEY',
      name: 'TEXT NOT NULL',
      qty: 'INTEGER',
      source_file: 'TEXT',
      deleted_at: 'TEXT',
      updated_at: 'TEXT',
    },
    render: () => '',
    outputFile: '/dev/null',
  });
  db.define(tagTable, {
    columns: { id: 'TEXT PRIMARY KEY', slug: 'TEXT NOT NULL', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: '/dev/null',
  });
  db.define(itemTagTable, {
    columns: { item_id: 'TEXT NOT NULL', tag_id: 'TEXT NOT NULL' },
    tableConstraints: ['PRIMARY KEY (item_id, tag_id)'],
    primaryKey: ['item_id', 'tag_id'],
    render: () => '',
    outputFile: '/dev/null',
  });
  await db.init();

  const id1 = await db.insert(itemTable, { name: 'Widget', qty: 5 });
  check('insert returns string id', typeof id1 === 'string' && id1.length > 0);
  const got1 = await db.get(itemTable, id1);
  expect(got1?.name, 'Widget', 'insert persists row');
  expect(Number(got1?.qty), 5, 'insert persists qty');

  const explicitId = `${runId}-explicit`;
  await db.insert(itemTable, { id: explicitId, name: 'Explicit' });
  const got2 = await db.get(itemTable, explicitId);
  expect(got2?.id, explicitId, 'insert respects caller id');

  const upsertId = `${runId}-upsert`;
  await db.upsert(itemTable, { id: upsertId, name: 'V1', qty: 1 });
  await db.upsert(itemTable, { id: upsertId, name: 'V2', qty: 2 });
  const got3 = await db.get(itemTable, upsertId);
  expect(got3?.name, 'V2', 'upsert overwrites');
  expect(Number(got3?.qty), 2, 'upsert overwrites qty');

  const upsertByTarget = `${runId}-upsertby`;
  await db.insert(itemTable, { id: upsertByTarget, name: 'unique-name', qty: 10 });
  const returnedId = await db.upsertBy(itemTable, 'name', 'unique-name', { qty: 99 });
  expect(returnedId, upsertByTarget, 'upsertBy returns existing id');
  const got4 = await db.get(itemTable, upsertByTarget);
  expect(Number(got4?.qty), 99, 'upsertBy updates field');

  const updateId = await db.insert(itemTable, { name: 'orig', qty: 1 });
  await db.update(itemTable, updateId, { qty: 42 });
  const got5 = await db.get(itemTable, updateId);
  expect(got5?.name, 'orig', 'update preserves untouched field');
  expect(Number(got5?.qty), 42, 'update mutates target field');

  const returnId = await db.insert(itemTable, { name: 'returning', qty: 1 });
  const returned = await db.updateReturning(itemTable, returnId, { qty: 7 });
  expect(returned.id, returnId, 'updateReturning returns id');
  expect(Number(returned.qty), 7, 'updateReturning returns updated qty');

  const delId = await db.insert(itemTable, { name: 'doomed' });
  await db.delete(itemTable, delId);
  const got6 = await db.get(itemTable, delId);
  expect(got6, null, 'delete removes row');

  const sf = `${runId}-source.yaml`;
  await db.insert(itemTable, { id: `${runId}-sd-1`, name: 'keep-1', source_file: sf });
  await db.insert(itemTable, { id: `${runId}-sd-2`, name: 'keep-2', source_file: sf });
  await db.insert(itemTable, { id: `${runId}-sd-3`, name: 'gone', source_file: sf });
  const softCount = await db.softDeleteMissing(itemTable, 'name', sf, ['keep-1', 'keep-2']);
  expect(softCount, 1, 'softDeleteMissing count');
  const goneRow = await db.get(itemTable, `${runId}-sd-3`);
  check('softDeleteMissing sets deleted_at', goneRow?.deleted_at != null);

  const itemId = await db.insert(itemTable, { name: 'tagged' });
  const tagId = await db.insert(tagTable, { slug: `${runId}-t1` });
  await db.link(itemTagTable, { item_id: itemId, tag_id: tagId });
  await db.link(itemTagTable, { item_id: itemId, tag_id: tagId }); // idempotent
  const linkCount = await db.count(itemTagTable, {
    filters: [{ col: 'item_id', op: 'eq', val: itemId }],
  });
  expect(linkCount, 1, 'link is idempotent');

  await db.unlink(itemTagTable, { item_id: itemId, tag_id: tagId });
  const linkCountAfter = await db.count(itemTagTable, {
    filters: [{ col: 'item_id', op: 'eq', val: itemId }],
  });
  expect(linkCountAfter, 0, 'unlink removes row');

  await dropAll(db, itemTagTable, itemTable, tagTable);
  db.close();
}

// =============================================================================
// 3. render-async-postgres
// =============================================================================
console.log('\n=== render-async-postgres scenarios ===');
{
  const teamTable = `__smoke_${runId}_team`;
  const memberTable = `__smoke_${runId}_member`;
  const db = new Lattice(PG_URL);
  db.define(teamTable, {
    columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL', slug: 'TEXT NOT NULL' },
    render: (rows) => `# Teams\n\n${rows.map((r) => `- ${String(r.name)}`).join('\n')}\n`,
    outputFile: `${runId}-teams.md`,
  });
  db.define(memberTable, {
    columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL', team_id: 'TEXT' },
    render: () => '',
    outputFile: `.schema-only/${runId}-members.md`,
  });
  db.defineEntityContext(teamTable, {
    slug: (row) => String(row.slug),
    directoryRoot: `${runId}-teams`,
    files: {
      'TEAM.md': {
        source: { type: 'self' },
        render: (rows) => `# Team: ${String(rows[0]?.name ?? '')}\n`,
      },
      'MEMBERS.md': {
        source: { type: 'hasMany', table: memberTable, foreignKey: 'team_id' },
        render: (rows) =>
          rows.length === 0
            ? 'No members.'
            : rows.map((r) => `- ${String(r.name)}`).join('\n') + '\n',
      },
    },
  });
  await db.init();
  const t1 = await db.insert(teamTable, { name: 'Alpha Squad', slug: `${runId}-alpha` });
  const t2 = await db.insert(teamTable, { name: 'Beta Squad', slug: `${runId}-beta` });
  await db.insert(memberTable, { name: 'Alice', team_id: t1 });
  await db.insert(memberTable, { name: 'Bob', team_id: t1 });
  await db.insert(memberTable, { name: 'Charlie', team_id: t2 });

  const outputDir = mkdtempSync(join(tmpdir(), `lattice-smoke-${runId}-`));

  const result = await db.render(outputDir);
  check('render returns filesWritten', result.filesWritten.length > 0);

  const teamsFile = join(outputDir, `${runId}-teams.md`);
  check('table-level file exists', existsSync(teamsFile));
  if (existsSync(teamsFile)) {
    const content = readFileSync(teamsFile, 'utf8');
    check('table-level file contains team names',
      content.includes('Alpha Squad') && content.includes('Beta Squad'));
  }

  const alphaTeam = join(outputDir, `${runId}-teams`, `${runId}-alpha`, 'TEAM.md');
  const alphaMembers = join(outputDir, `${runId}-teams`, `${runId}-alpha`, 'MEMBERS.md');
  check('per-entity TEAM.md exists', existsSync(alphaTeam));
  check('per-entity MEMBERS.md exists', existsSync(alphaMembers));
  if (existsSync(alphaMembers)) {
    const m = readFileSync(alphaMembers, 'utf8');
    check('MEMBERS.md scoped to alpha team',
      m.includes('Alice') && m.includes('Bob') && !m.includes('Charlie'));
  }

  const manifestPath = join(outputDir, '.lattice', 'manifest.json');
  check('manifest written', existsSync(manifestPath));
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const slugs = Object.keys(manifest.entityContexts[teamTable]?.entities ?? {}).sort();
    expect(slugs, [`${runId}-alpha`, `${runId}-beta`], 'manifest covers both entities');
  }

  rmSync(outputDir, { recursive: true, force: true });
  await dropAll(db, memberTable, teamTable);
  db.close();
}

// =============================================================================
// 4. parallel-pool-query-postgres
// =============================================================================
console.log('\n=== parallel-pool-query-postgres scenarios ===');
{
  const tableName = `__smoke_${runId}_parallel`;
  const db = new Lattice(PG_URL);
  db.define(tableName, {
    columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL' },
    render: () => '',
    outputFile: '/dev/null',
  });
  await db.init();
  for (let i = 0; i < 25; i++) {
    await db.insert(tableName, { id: `${runId}-${String(i)}`, name: `row-${String(i)}` });
  }

  await db.count(tableName); // warm up

  const tStart1 = Date.now();
  await db.count(tableName);
  const single = Date.now() - tStart1;

  const N = 10;
  const tStartN = Date.now();
  await Promise.all(Array.from({ length: N }, () => db.count(tableName)));
  const parallel = Date.now() - tStartN;

  const ratio = parallel / Math.max(single, 1);
  console.log(
    `  single=${single}ms, parallel(${N})=${parallel}ms, ratio=${ratio.toFixed(2)}x (vs ${N}x serial)`,
  );
  // The regression we want to catch is "everything serialized via synckit",
  // which would push parallel ≈ N × single. We assert parallel < (N-2) × single
  // — generous enough to absorb pool/network jitter but tight enough that a
  // serialized regression (where parallel ≈ N × single) fails the assertion.
  // Also clamp to a 50ms floor so very fast loopback connections (single < 5ms)
  // aren't dominated by sub-millisecond noise.
  const threshold = Math.max((N - 2) * single, 50);
  check(
    `parallel batch is sub-linear in N (got ${parallel}ms < ${threshold}ms threshold; ${N}x serial would be ${N * single}ms)`,
    parallel < threshold,
  );

  const results = await Promise.all(Array.from({ length: N }, () => db.count(tableName)));
  check('all concurrent calls return correct count', results.every((r) => r === 25));

  await dropAll(db, tableName);
  db.close();
}

console.log(`\n=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
