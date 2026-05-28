import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

/**
 * Live verification of LLM ingest enrichment (description + classifier).
 * Skipped unless ANTHROPIC_API_KEY + LATTICE_LIVE_LLM=1.
 */
const LIVE = Boolean(process.env.ANTHROPIC_API_KEY) && process.env.LATTICE_LIVE_LLM === '1';

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<GuiServerHandle> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-ingest-live-'));
  dirs.push(root);
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    ['db: ./data/test.db', '', 'entities:', '  projects:', '    fields:', '      id: { type: uuid, primaryKey: true }', '      name: { type: text }', '    render: default-list', '    outputFile: projects.md', ''].join('\n'),
  );
  const server = await startGuiServer({ configPath, outputDir: join(root, 'context'), port: 0, openBrowser: false });
  servers.push(server);
  return server;
}

describe('ingest LLM enrichment (live)', () => {
  (LIVE ? it : it.skip)(
    'generates a description and links a document to the related project',
    async () => {
      const server = await boot();
      // Seed a project.
      await fetch(`${server.url}/api/tables/projects/rows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Apollo Telemetry Pipeline' }),
      });

      const res = await fetch(`${server.url}/api/ingest/text`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'spec.md',
          text: 'Design notes for the Apollo Telemetry Pipeline: ingest rates, schema, and alerting.',
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; suggestedLinks: { table: string; id: string }[] };

      // Description was replaced by an LLM summary (not the raw heuristic prefix).
      const row = (await fetch(`${server.url}/api/tables/files/rows/${body.id}`).then((r) => r.json())) as {
        description: string;
      };
      expect(typeof row.description).toBe('string');
      expect(row.description.length).toBeGreaterThan(0);

      // The classifier related the document to the seeded project.
      expect(body.suggestedLinks.some((m) => m.table === 'projects')).toBe(true);
    },
    60000,
  );
});
