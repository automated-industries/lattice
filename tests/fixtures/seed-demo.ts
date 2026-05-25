/**
 * Dev-only seed for the `lattice gui` demo database.
 *
 * Reads `./lattice.config.yml` (this directory), wipes `./data/lattice-demo.db`
 * if present, recreates it, and inserts a small set of dummy rows + junctions
 * so the GUI has something non-empty to render against.
 *
 * Run from this directory:
 *     npx tsx seed-demo.ts
 *
 * Then:
 *     cd ../../ && node dist/cli.js gui --config tests/fixtures/lattice.config.yml
 */
import { mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lattice } from '../../src/lattice.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, 'lattice.config.yml');
const DB_PATH = resolve(__dirname, 'data/lattice-demo.db');
const CONTEXT_DIR = resolve(__dirname, 'context');

async function main(): Promise<void> {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  rmSync(DB_PATH, { force: true });
  rmSync(`${DB_PATH}-shm`, { force: true });
  rmSync(`${DB_PATH}-wal`, { force: true });
  rmSync(CONTEXT_DIR, { recursive: true, force: true });

  const db = new Lattice({ config: CONFIG_PATH });
  // Mirror the dynamic GUI tables so the seed can pre-populate column-meta
  // flags. Keep these in sync with src/gui/server.ts → openConfig.
  db.define('_lattice_gui_column_meta', {
    columns: {
      id: 'TEXT PRIMARY KEY',
      table_name: 'TEXT NOT NULL',
      column_name: 'TEXT NOT NULL',
      secret: 'INTEGER NOT NULL DEFAULT 0',
      updated_at: "TEXT DEFAULT (datetime('now'))",
    },
    render: () => '',
    outputFile: '.lattice-gui/column-meta.md',
  });
  await db.init();

  // ── Core rows ────────────────────────────────────────────────────────
  const people = [
    { name: 'Alice Adams', email: 'alice@example.com', role: 'Engineer' },
    { name: 'Bob Brown', email: 'bob@example.com', role: 'Designer' },
    { name: 'Charlie Chen', email: 'charlie@example.com', role: 'PM' },
    { name: 'Dana Diaz', email: 'dana@example.com', role: 'Engineer' },
    { name: 'Evan Eriksson', email: 'evan@example.com', role: 'QA' },
  ];
  const peopleIds: string[] = [];
  for (const p of people) peopleIds.push(await db.insert('people', p));

  const meetings = [
    {
      title: 'Kickoff',
      starts_at: '2026-01-08T10:00:00Z',
      transcript: 'Discussed scope, timelines, and team responsibilities.',
      summary: 'Project Helios kickoff. Owners assigned.',
    },
    {
      title: 'Architecture Review',
      starts_at: '2026-01-15T14:00:00Z',
      transcript: 'Reviewed the service split and data-flow diagram.',
      summary: 'Approved the two-service split; deferred queue choice.',
    },
    {
      title: 'Demo Day',
      starts_at: '2026-02-01T11:00:00Z',
      transcript: 'Demoed the prototype to stakeholders.',
      summary: 'Positive feedback; follow-ups on auth UX.',
    },
    {
      title: 'Retrospective',
      starts_at: '2026-02-12T16:00:00Z',
      transcript: 'Went around the room — what went well, what to change.',
      summary: 'Action items: faster local test loop, clearer handoffs.',
    },
  ];
  const meetingIds: string[] = [];
  for (const m of meetings) meetingIds.push(await db.insert('meetings', m));

  const projects = [
    { name: 'Helios', status: 'active' },
    { name: 'Bluebird', status: 'active' },
    { name: 'Acme Migration', status: 'paused' },
    { name: 'Quantum', status: 'planning' },
  ];
  const projectIds: string[] = [];
  for (const p of projects) projectIds.push(await db.insert('projects', p));

  const messages = [
    {
      channel: '#helios',
      body: 'Pushed the v2 schema migration to staging.',
      sent_at: '2026-01-09T09:12:00Z',
    },
    {
      channel: '#bluebird',
      body: 'Wireframes for the onboarding flow are up — feedback welcome.',
      sent_at: '2026-01-11T15:30:00Z',
    },
    {
      channel: '#helios',
      body: 'Demo prep notes attached.',
      sent_at: '2026-01-31T18:45:00Z',
    },
    {
      channel: '#general',
      body: 'Office closed Monday for the holiday.',
      sent_at: '2026-02-09T08:00:00Z',
    },
  ];
  const messageIds: string[] = [];
  for (const m of messages) messageIds.push(await db.insert('messages', m));

  const repositories = [
    { url: 'https://github.com/example/helios-api', project_id: projectIds[0] },
    { url: 'https://github.com/example/helios-web', project_id: projectIds[0] },
    { url: 'https://github.com/example/bluebird', project_id: projectIds[1] },
    { url: 'https://github.com/example/acme-legacy', project_id: projectIds[2] },
  ];
  for (const r of repositories) await db.insert('repositories', r);

  const files = [
    { path: '/docs/helios/spec.md', kind: 'markdown' },
    { path: '/design/bluebird-onboarding.fig', kind: 'figma' },
    { path: '/docs/acme/runbook.md', kind: 'markdown' },
    { path: '/contracts/quantum-sow.pdf', kind: 'pdf' },
  ];
  const fileIds: string[] = [];
  for (const f of files) fileIds.push(await db.insert('files', f));

  const secrets = [
    { name: 'PAYMENT_API_KEY', kind: 'api-key', value: 'demo-placeholder-not-a-real-key' },
    { name: 'POSTGRES_PASSWORD', kind: 'db-password', value: 'demo-placeholder-password' },
    { name: 'OAUTH_CLIENT_SECRET', kind: 'oauth', value: 'demo-placeholder-oauth-secret' },
  ];
  for (const s of secrets) await db.insert('secrets', s);

  // Mark secrets.value as a secret column so the GUI masks the cell.
  await db.insert('_lattice_gui_column_meta', {
    id: crypto.randomUUID(),
    table_name: 'secrets',
    column_name: 'value',
    secret: 1,
    updated_at: new Date().toISOString(),
  });

  // ── Junctions ────────────────────────────────────────────────────────
  // Meetings ↔ people: kickoff has 3 attendees, others vary.
  const attendance: [number, number][] = [
    [0, 0],
    [0, 1],
    [0, 2],
    [1, 0],
    [1, 2],
    [1, 3],
    [2, 0],
    [2, 1],
    [2, 2],
    [2, 4],
    [3, 0],
    [3, 1],
    [3, 2],
    [3, 3],
    [3, 4],
  ];
  for (const [m, p] of attendance) {
    await db.link('meeting_people', { meeting_id: meetingIds[m], person_id: peopleIds[p] });
  }

  // Meetings ↔ projects: kickoff is for Helios, others span.
  const meetingProj: [number, number][] = [
    [0, 0],
    [1, 0],
    [2, 0],
    [2, 1],
    [3, 0],
  ];
  for (const [m, p] of meetingProj) {
    await db.link('meeting_projects', { meeting_id: meetingIds[m], project_id: projectIds[p] });
  }

  // People ↔ projects.
  const personProj: [number, number][] = [
    [0, 0],
    [1, 0],
    [2, 0],
    [4, 0],
    [0, 1],
    [1, 1],
    [3, 2],
    [2, 3],
  ];
  for (const [p, pr] of personProj) {
    await db.link('project_people', { project_id: projectIds[pr], person_id: peopleIds[p] });
  }

  // Messages ↔ people (authors / recipients — simplified).
  const messagePeople: [number, number][] = [
    [0, 0],
    [1, 1],
    [1, 2],
    [2, 0],
    [3, 2],
  ];
  for (const [m, p] of messagePeople) {
    await db.link('message_people', { message_id: messageIds[m], person_id: peopleIds[p] });
  }

  // Projects ↔ files.
  const projFile: [number, number][] = [
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 3],
  ];
  for (const [pr, f] of projFile) {
    await db.link('project_files', { project_id: projectIds[pr], file_id: fileIds[f] });
  }

  // Render per-row context markdown so the GUI detail page has something to show.
  const result = await db.render(CONTEXT_DIR);
  db.close();
  console.log(`Seeded ${DB_PATH}`);
  console.log(`Rendered ${String(result.filesWritten.length)} context files under ${CONTEXT_DIR}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
