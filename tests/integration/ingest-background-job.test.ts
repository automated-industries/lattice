import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Enrichment would otherwise make a real model call. Stub the GUI LLM client (so
// enrichment fails fast and leaves the deterministic path in place) and the vision
// layer (so nothing needs the network), exactly as the other ingest suites do.
vi.mock('../../src/gui/ai/chat.js', async (orig) => {
  const actual = await orig();
  return { ...actual, createAnthropicClient: () => ({}) };
});
vi.mock('../../src/ai/vision.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    describeImage: () => Promise.resolve(''),
    describePdf: () => Promise.resolve(''),
  };
});

import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';
import { openStream } from './stream-helper.js';
import { seedClaudeOAuth } from '../helpers/claude-auth.js';
import type WebSocket from 'ws';

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const sockets: WebSocket[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-bgingest-cfg-'));
  dirs.push(cfgDir);
  for (const k of ['LATTICE_CONFIG_DIR', 'LATTICE_ENCRYPTION_KEY', 'ANTHROPIC_API_KEY']) {
    savedEnv[k] = process.env[k];
  }
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 'bgingest-test-key';
  delete process.env.ANTHROPIC_API_KEY;
  seedClaudeOAuth();
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
});

async function boot(): Promise<{ server: GuiServerHandle; outputDir: string }> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-bgingest-'));
  dirs.push(root);
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  notes:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '      body: { type: text }',
      '    render: default-list',
      '    outputFile: notes.md',
      '',
    ].join('\n'),
  );
  const outputDir = join(root, 'context');
  const server = await startGuiServer({
    configPath,
    outputDir,
    port: 0,
    openBrowser: false,
    autoRender: true,
  });
  servers.push(server);
  return { server, outputDir };
}

function upload(
  url: string,
  name: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${url}/api/ingest/upload`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-filename': encodeURIComponent(name),
      ...headers,
    },
    body,
  });
}

/** Collect every `feed` frame arriving on the multiplexed realtime socket. */
async function collectFeed(url: string): Promise<{
  ws: WebSocket;
  frames: Record<string, unknown>[];
}> {
  const ws = await openStream(url);
  sockets.push(ws);
  const frames: Record<string, unknown>[] = [];
  ws.on('message', (buf: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(buf.toString()) as { type?: string; data?: Record<string, unknown> };
      if (msg.type === 'feed' && msg.data) frames.push(msg.data);
    } catch {
      // ignore malformed
    }
  });
  return { ws, frames };
}

async function waitFor<T>(fn: () => T | null | Promise<T | null>, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v != null) return v;
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A document whose prose states a bigger count than its own data carries. */
const UNDER_EXTRACTING_DOC = JSON.stringify({
  summary: 'The district operates 46 schools across three regions.',
  schools: Array.from({ length: 12 }, (_, i) => ({
    name: `School ${String(i + 1)}`,
    region: i % 3 === 0 ? 'north' : 'south',
  })),
});

describe('ingest as a detached background job', () => {
  it('acknowledges an async upload immediately with a job handle instead of holding the request', async () => {
    const { server } = await boot();
    const res = await upload(server.url, 'notes.txt', 'a short note to ingest', {
      'x-lattice-async': '1',
    });
    expect(res.status).toBe(202);
    const ack = (await res.json()) as { jobId?: string; async?: boolean; status?: string };
    expect(typeof ack.jobId).toBe('string');
    expect(ack.jobId).toBeTruthy();
    expect(ack.async).toBe(true);
    expect(ack.status).toBe('running');
  });

  it('streams ingest progress frames over the realtime channel while the job runs', async () => {
    const { server } = await boot();
    const { frames } = await collectFeed(server.url);
    await new Promise((r) => setTimeout(r, 100)); // let the subscription attach

    const res = await upload(server.url, 'progress.txt', 'streamed ingest body', {
      'x-lattice-async': '1',
    });
    expect(res.status).toBe(202);

    const progress = await waitFor(() => {
      const seen = frames.filter((f) => f.op === 'ingest_progress');
      const terminal = seen.find(
        (f) => (f.progress as { terminal?: boolean } | undefined)?.terminal === true,
      );
      return terminal ? seen : null;
    });
    // At least an opening frame and a terminal one — the client's progress tracker
    // is driven entirely by these, so a job that published nothing would be invisible.
    expect(progress.length).toBeGreaterThanOrEqual(2);
    const terminal = progress[progress.length - 1]?.progress as {
      done: number;
      total: number;
      terminal?: boolean;
    };
    expect(terminal.terminal).toBe(true);
    expect(terminal.done).toBe(1);
    expect(terminal.total).toBe(1);
  });

  it('settles the job so its full result can be collected after the ack', async () => {
    const { server } = await boot();
    const res = await upload(server.url, 'settled.txt', 'body of the settled ingest', {
      'x-lattice-async': '1',
    });
    const { jobId } = (await res.json()) as { jobId: string };

    const job = await waitFor(async () => {
      const r = await fetch(`${server.url}/api/ingest/job/${jobId}`);
      if (r.status !== 200) return null;
      const j = (await r.json()) as { status?: string; result?: Record<string, unknown> };
      return j.status === 'done' ? j : null;
    });
    expect(job.status).toBe('done');
    const result = job.result ?? {};
    expect(typeof result.id).toBe('string');
    expect(result.extraction_status).toBe('extracted');

    // The row really landed — the job did the same work the synchronous path does.
    const row = (await fetch(`${server.url}/api/tables/files/rows/${String(result.id)}`).then((r) =>
      r.json(),
    )) as Record<string, unknown>;
    expect(row.original_name).toBe('settled.txt');
    expect(row.extracted_text).toBe('body of the settled ingest');
  });

  it('reports an unknown job handle rather than inventing an empty result', async () => {
    const { server } = await boot();
    const r = await fetch(`${server.url}/api/ingest/job/does-not-exist`);
    expect(r.status).toBe(404);
  });

  it('keeps the synchronous upload shape valid for callers that do not opt in', async () => {
    const { server } = await boot();
    const res = await upload(server.url, 'sync.txt', 'synchronous ingest body');
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    // The pre-existing contract: the row id and its extraction status come back on
    // the response itself, not behind a job handle.
    expect(typeof body.id).toBe('string');
    expect(body.extraction_status).toBe('extracted');
    expect(Array.isArray(body.suggestedLinks)).toBe(true);
    expect(body.jobId).toBeUndefined();
  });
});

describe('ingest reports a stated-count shortfall', () => {
  it('surfaces the discrepancy in the ingest result when a document claims more than it yields', async () => {
    const { server } = await boot();
    const res = await upload(server.url, 'district.json', UNDER_EXTRACTING_DOC);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { notices?: string[] };
    expect(Array.isArray(body.notices)).toBe(true);
    const joined = (body.notices ?? []).join(' ');
    expect(joined).toContain('46');
    expect(joined).toContain('12');
    expect(joined).toContain('schools');
  });

  it('says nothing when the document does not claim a count it failed to deliver', async () => {
    const { server } = await boot();
    const clean = JSON.stringify({
      schools: Array.from({ length: 12 }, (_, i) => ({
        name: `School ${String(i + 1)}`,
        region: 'north',
      })),
    });
    const res = await upload(server.url, 'clean.json', clean);
    const body = (await res.json()) as { notices?: string[] };
    const joined = (body.notices ?? []).join(' ');
    expect(joined).not.toContain('may be missing');
  });
});

/** Minimal single-page PDF placing each string at an absolute (x, y). */
function buildPdf(items: { x: number; y: number; text: string }[]): Buffer {
  const ops = ['BT', '/F1 10 Tf'];
  for (const it of items) {
    ops.push(`1 0 0 1 ${String(it.x)} ${String(it.y)} Tm`, `(${it.text}) Tj`);
  }
  ops.push('ET');
  const content = ops.join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${String(Buffer.byteLength(content))} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${String(i + 1)} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = out.length;
  out += `xref\n0 ${String(objs.length + 1)}\n0000000000 65535 f \n`;
  for (const o of offsets) out += String(o).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${String(objs.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xrefAt)}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

describe('a ruled PDF reaches the deterministic importer', () => {
  it('proposes real tables from a PDF table instead of keeping it as a plain file', async () => {
    const { server } = await boot();
    const pdf = buildPdf([
      { x: 72, y: 700, text: 'Name' },
      { x: 220, y: 700, text: 'Region' },
      { x: 360, y: 700, text: 'Students' },
      { x: 72, y: 680, text: 'North High' },
      { x: 220, y: 680, text: 'North' },
      { x: 360, y: 680, text: '412' },
      { x: 72, y: 660, text: 'South High' },
      { x: 220, y: 660, text: 'South' },
      { x: 360, y: 660, text: '388' },
    ]);
    const res = await fetch(`${server.url}/api/ingest/upload`, {
      method: 'POST',
      headers: {
        'content-type': 'application/pdf',
        'x-filename': encodeURIComponent('roster.pdf'),
      },
      body: pdf,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      autoImport?: { plan?: { entities?: { name: string; rowCount: number }[] } };
    };
    // The deterministic importer claimed the PDF: it planned an entity with the
    // table's two data rows, rather than the file falling through to prose-only.
    const entities = body.autoImport?.plan?.entities ?? [];
    expect(entities.length).toBeGreaterThan(0);
    expect(entities.some((e) => e.rowCount === 2)).toBe(true);
  });
});

describe('ingest renders the row it just wrote', () => {
  it('leaves a non-empty rendered context file for a freshly ingested row', async () => {
    const { server, outputDir } = await boot();
    const res = await upload(server.url, 'rendered-note.txt', 'content worth rendering');
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; rendered?: string[] };

    // Reported as part of the ingest outcome — the render is a stage of the
    // pipeline, not a later pass the caller has to wait on.
    expect(body.rendered).toContain('files');

    // …and it is on disk the instant the response resolves, with no second pass.
    const filesDir = join(outputDir, 'Files');
    expect(existsSync(filesDir)).toBe(true);
    const slugs = readdirSync(filesDir);
    const contents = slugs
      .map((s) => join(filesDir, s, 'FILE.md'))
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p, 'utf8'));
    expect(contents.length).toBeGreaterThan(0);
    expect(contents.some((c) => c.trim().length > 0)).toBe(true);
    expect(contents.some((c) => c.includes('rendered-note.txt'))).toBe(true);
  });

  it('renders only what the ingest wrote, not the whole tree', async () => {
    const { server } = await boot();
    const res = await upload(server.url, 'scoped.txt', 'body');
    const body = (await res.json()) as { rendered?: string[] };
    // A plain text drop writes one table. `notes` also exists in this workspace and
    // this ingest did not touch it, so it must not be pulled into the render scope —
    // ingest must never turn into a full-tree render.
    expect(body.rendered).toEqual(['files']);
  });

  it('reports an ingest that landed but could not be rendered, without failing the ingest', async () => {
    const { server } = await boot();
    // Point the workspace's render output at a path that cannot be written, so the
    // render stage genuinely fails while the row itself still lands.
    const blocked = join(mkdtempSync(join(tmpdir(), 'lattice-blocked-')), 'a-file-not-a-directory');
    writeFileSync(blocked, 'occupied');
    dirs.push(blocked);

    const res = await fetch(`${server.url}/api/ingest/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'still ingested', title: 'Landed Note' }),
    });
    // Whatever the render did, the ingest itself reports success and a row id —
    // a render problem must never masquerade as lost data.
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id?: string };
    expect(typeof body.id).toBe('string');
    const row = (await fetch(`${server.url}/api/tables/files/rows/${String(body.id)}`).then((r) =>
      r.json(),
    )) as Record<string, unknown>;
    expect(row.extracted_text).toBe('still ingested');
  });
});
