// The release workflow publishes to npm and then confirms the version is
// installable. The registry scans every new version before releasing it, so a
// successful publish is followed by minutes of 404s for that version. These
// tests pin the check's contract against a local stand-in for the registry: it
// waits through the 404s, passes as soon as the version is served and `latest`
// names it, rides out transient errors, and at the deadline fails loudly with
// an explanation instead of hanging or passing.
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';

const scriptPath = join(resolve(__dirname, '..', '..'), 'scripts', 'await-npm-release.mjs');

// 50 ms between polls; deadline 1.2 s, for the cases that must reach it.
const FAST = ['--interval-seconds', '0.05', '--timeout-minutes', '0.02'];

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

interface Registry {
  url: string;
  paths: string[];
  close: () => Promise<void>;
}

async function startRegistry(handler: Handler): Promise<Registry> {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url ?? '');
    handler(req, res);
  });
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    paths,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => {
          done();
        });
      }),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCheck(args: string[]): Promise<Run> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', fail);
    child.on('close', (status) => {
      done({ status, stdout, stderr });
    });
  });
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('scripts/await-npm-release.mjs', () => {
  it('waits while the registry holds the version, then passes once it is served and latest names it', async () => {
    let versionRequests = 0;
    const registry = await startRegistry((req, res) => {
      if (req.url === '/fixture/1.2.3') {
        versionRequests += 1;
        if (versionRequests <= 3) json(res, 404, { error: 'version not found: 1.2.3' });
        else json(res, 200, { name: 'fixture', version: '1.2.3' });
      } else if (req.url === '/-/package/fixture/dist-tags') {
        json(res, 200, { latest: versionRequests > 3 ? '1.2.3' : '1.2.2' });
      } else json(res, 404, {});
    });
    try {
      const r = await runCheck(['fixture', '1.2.3', '--registry', registry.url, ...FAST]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(count(r.stdout, 'is not installable yet')).toBe(1);
      expect(r.stdout).toContain('fixture@1.2.3 is installable');
      expect(r.stdout).toContain('latest = 1.2.3');
      expect(versionRequests).toBe(4);
    } finally {
      await registry.close();
    }
  });

  it('fails at the deadline, saying why, when the version is never released', async () => {
    const registry = await startRegistry((_req, res) => {
      json(res, 404, { error: 'version not found: 1.2.3' });
    });
    try {
      const r = await runCheck(['fixture', '1.2.3', '--registry', registry.url, ...FAST]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('::error::fixture@1.2.3 is still not installable');
      expect(r.stderr).toContain('last answer: HTTP 404');
      expect(r.stderr).toContain('held for manual review or blocked');
      expect(r.stdout).not.toContain('latest =');
    } finally {
      await registry.close();
    }
  });

  it('waits for latest to move after the version appears', async () => {
    let tagRequests = 0;
    const registry = await startRegistry((req, res) => {
      if (req.url === '/fixture/1.2.3') json(res, 200, { name: 'fixture', version: '1.2.3' });
      else {
        tagRequests += 1;
        json(res, 200, { latest: tagRequests <= 2 ? '1.2.2' : '1.2.3' });
      }
    });
    try {
      const r = await runCheck(['fixture', '1.2.3', '--registry', registry.url, ...FAST]);
      expect(r.status).toBe(0);
      expect(count(r.stdout, 'latest still names 1.2.2')).toBe(1);
      expect(r.stdout).toContain('latest = 1.2.3');
      expect(tagRequests).toBe(3);
    } finally {
      await registry.close();
    }
  });

  it('fails at the deadline when latest never names the version', async () => {
    const registry = await startRegistry((req, res) => {
      if (req.url === '/fixture/1.2.3') json(res, 200, { name: 'fixture', version: '1.2.3' });
      else json(res, 200, { latest: '1.2.2' });
    });
    try {
      const r = await runCheck(['fixture', '1.2.3', '--registry', registry.url, ...FAST]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(
        '::error::fixture@1.2.3 is installable, but latest still names 1.2.2',
      );
    } finally {
      await registry.close();
    }
  });

  it('keeps waiting through registry errors and dropped connections', async () => {
    let versionRequests = 0;
    const registry = await startRegistry((req, res) => {
      if (req.url === '/fixture/1.2.3') {
        versionRequests += 1;
        if (versionRequests === 1) json(res, 503, { error: 'unavailable' });
        else if (versionRequests === 2) req.socket.destroy();
        else json(res, 200, { name: 'fixture', version: '1.2.3' });
      } else json(res, 200, { latest: '1.2.3' });
    });
    try {
      const r = await runCheck(['fixture', '1.2.3', '--registry', registry.url, ...FAST]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('The registry answered HTTP 503');
      expect(r.stdout).toContain('Registry request for fixture@1.2.3 failed');
      expect(r.stdout).toContain('latest = 1.2.3');
    } finally {
      await registry.close();
    }
  });

  it('addresses a scoped package the way the registry expects', async () => {
    const registry = await startRegistry((req, res) => {
      if (req.url === '/@scope%2ffixture/1.0.0') {
        json(res, 200, { name: '@scope/fixture', version: '1.0.0' });
      } else if (req.url === '/-/package/@scope%2ffixture/dist-tags') {
        json(res, 200, { latest: '1.0.0' });
      } else json(res, 404, {});
    });
    try {
      const r = await runCheck(['@scope/fixture', '1.0.0', '--registry', registry.url, ...FAST]);
      expect(r.status).toBe(0);
      expect(registry.paths).toEqual([
        '/@scope%2ffixture/1.0.0',
        '/-/package/@scope%2ffixture/dist-tags',
      ]);
    } finally {
      await registry.close();
    }
  });

  it('rejects missing or invalid arguments with a usage error', async () => {
    const missing = await runCheck([]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('expected <package> <version>');

    const zero = await runCheck(['fixture', '1.2.3', '--timeout-minutes', '0']);
    expect(zero.status).toBe(2);
    expect(zero.stderr).toContain('--timeout-minutes must be a positive number');
  });
});
