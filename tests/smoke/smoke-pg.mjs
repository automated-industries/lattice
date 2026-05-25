import { Lattice } from '../../dist/index.js';
import { randomBytes } from 'node:crypto';

const PG_URL = process.env.LATTICE_TEST_PG_URL;
if (!PG_URL) {
  console.error('Set LATTICE_TEST_PG_URL');
  process.exit(1);
}

const runId = randomBytes(4).toString('hex');
const tableName = `__lattice_smoke_${runId}`;

const t = Date.now();
console.log('opening lattice...');
const db = new Lattice(PG_URL);
db.define(tableName, {
  columns: {
    id: 'TEXT PRIMARY KEY',
    name: 'TEXT NOT NULL',
    score: 'INTEGER',
  },
  render: () => '',
  outputFile: '/dev/null',
});
await db.init();
console.log('init ok', Date.now() - t, 'ms');

await db.insert(tableName, { id: 'a', name: 'Alice', score: 90 });
await db.insert(tableName, { id: 'b', name: 'Bob', score: 80 });
console.log('insert ok', Date.now() - t, 'ms');

const rows = await db.query(tableName);
console.log('query ok', rows.length, 'rows', Date.now() - t, 'ms');

const adapter = db.adapter;
if (adapter.runAsync) {
  await adapter.runAsync(`DROP TABLE IF EXISTS "${tableName}"`);
  console.log('drop ok');
}
db.close();
console.log('all done', Date.now() - t, 'ms');
process.exit(0);
