/**
 * A sync that brought nothing in must not report success, and must say why —
 * on the channel the caller is reading.
 *
 * Both sync verbs are the ones most likely to run where nobody is watching: a
 * nightly job, a container being prepared, a machine that was just signed in. So
 * the two things that matter to their caller are the exit code and the reasons,
 * and both used to be lost:
 *
 *  - `connector sync` collected a reason per source, summed them to a count,
 *    threw the reasons away, and returned normally. A pass in which EVERY source
 *    failed authorization printed "Synced 0 sources; 3 failed." and exited zero.
 *    Asked for machine-readable output it emitted two numbers and no reason at
 *    all, so a job could neither notice the failure nor report it.
 *
 *  - `account sync` did check for memberships that did not arrive, and did leave
 *    as a failure carrying the whole report — but only on the path a PERSON
 *    reads. Asked for machine-readable output it returned before reaching its own
 *    check, so the one caller that cannot read the printed report was also the
 *    one that got told everything was fine.
 *
 * Every case runs the REAL command as its own process and reads the exit code an
 * operator's script would branch on. A test that called the command function and
 * inspected its return value would have passed throughout: the guard existed, it
 * just was not on the path being tested.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lattice } from '../../src/lattice.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import { createConnector } from '../../src/connectors/registry.js';
import { homeOfItsOwn } from './helpers/home-of-its-own.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli.ts');
/** Runs the command's own source as a real process — no build step required. */
const RUNNER = join(REPO_ROOT, 'node_modules', 'vite-node', 'vite-node.mjs');

const ENCRYPTION_KEY = Buffer.alloc(32, 53).toString('base64');
/** Who this machine syncs as, fixed so the registry rows and the command agree. */
const IDENTITY = 'nightly@example.test';
/** The one-time code the approval page hands a person, in this file. */
const APPROVED_CODE = 'code-1';

let scratch: string;
/** The home every command below is given, in place of the one running the tests. */
let home: { HOME: string; USERPROFILE: string };
const stubs: Server[] = [];

beforeAll(() => {
  expect(existsSync(RUNNER), `command runner missing at ${RUNNER}`).toBe(true);
  scratch = mkdtempSync(join(tmpdir(), 'lattice-sync-exit-'));
  home = homeOfItsOwn(join(scratch, 'home'));
});

afterAll(async () => {
  for (const s of stubs.splice(0)) await new Promise((r) => s.close(r));
  rmSync(scratch, { recursive: true, force: true });
});

interface CliRun {
  status: number | null;
  /** Standard output alone — what a script that pipes the command captures. */
  stdout: string;
  /** Everything, for reading a failure. */
  output: string;
}

/**
 * Run the real command as its own process, and wait for it WITHOUT blocking
 * this one.
 *
 * Not the synchronous form: the account cases answer the command from a stub
 * service running in this process, and a blocking wait would stop it from ever
 * replying — the command would time out against a server that is right there.
 *
 * `stdout` is kept separate from `stderr` on purpose: the claim under test
 * includes WHICH stream the machine-readable report arrives on, and joining them
 * would make a report that only ever reached the terminal look like one a script
 * could parse. Key material, the machine configuration, the root and the HOME the
 * command resolves anything else from all live in the scratch directory — nothing
 * here touches the machine's own.
 */
function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<CliRun> {
  return new Promise((settle, fail) => {
    const child = spawn(process.execPath, [RUNNER, '--root', REPO_ROOT, CLI_ENTRY, '--', ...args], {
      cwd: REPO_ROOT,
      timeout: 120_000,
      env: {
        ...process.env,
        ...home,
        LATTICE_CONFIG_DIR: join(scratch, 'machine-config'),
        LATTICE_ROOT: join(scratch, 'lattice-root'),
        LATTICE_ENCRYPTION_KEY: ENCRYPTION_KEY,
        LATTICE_USER_EMAIL: IDENTITY,
        // Discovery must never fall through to a real manifest fetch.
        LATTICE_IDENTITY_MANIFEST: 'http://127.0.0.1:1/nowhere',
        ...extraEnv,
      },
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (out += c));
    child.stderr.on('data', (c: string) => (err += c));
    child.on('error', fail);
    child.on('close', (status) => {
      settle({ status, stdout: out, output: `${out}${err}` });
    });
  });
}

// ── `lattice connector sync` ───────────────────────────────────────────────

const WORKSPACE_CONFIG = [
  'db: ./lattice.db',
  'entities:',
  '  agent:',
  '    fields:',
  '      id: { type: text, primaryKey: true }',
  '      name: { type: text }',
  '    render: default-list',
  '    outputFile: agents.md',
  '',
].join('\n');

/**
 * A workspace whose connected sources cannot be synced.
 *
 * Each connection is registered but has no authorization behind it — the state a
 * machine is in after its stored credentials are revoked or cleared, and the one
 * a nightly job actually hits. Nothing here reaches a network.
 */
async function workspaceWithFailingSources(name: string, count: number): Promise<string> {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, 'lattice.config.yml');
  writeFileSync(configPath, WORKSPACE_CONFIG, 'utf8');

  const db = new Lattice({ config: configPath }, { encryptionKey: ENCRYPTION_KEY });
  registerNativeEntities(db);
  await db.init();
  try {
    for (let i = 0; i < count; i++) {
      await createConnector(db, {
        connector: 'mcp',
        toolkit: `mcp:nightly-${String(i)}`,
        displayName: `nightly-source-${String(i)}`,
        connectedBy: IDENTITY,
      });
    }
  } finally {
    db.close();
  }
  return configPath;
}

interface SyncReport {
  synced: number;
  failed: number;
  failures: { connectorId: string; displayName: string | null; error: string }[];
}

describe('a connector sync in which every source failed', () => {
  it('reports failure to the script that ran it, instead of exiting zero', async () => {
    const configPath = await workspaceWithFailingSources('connector-all-failed', 3);

    const run = await runCli(['connector', 'sync', '--config', configPath]);

    // What it says is right already; what it RETURNS was not.
    expect(run.output).toContain('3 failed');
    expect(run.status, run.output).not.toBe(0);
  });

  it('says which source and why, rather than only how many', async () => {
    const configPath = await workspaceWithFailingSources('connector-named-reasons', 2);

    const run = await runCli(['connector', 'sync', '--config', configPath]);

    expect(run.output).toContain('nightly-source-0');
    expect(run.output).toContain('nightly-source-1');
    // The reason each one refused, not a bare tally.
    expect(run.output).toMatch(/no connection/);
    expect(run.status, run.output).not.toBe(0);
  });

  it('carries every reason into the machine-readable report, on standard output', async () => {
    const configPath = await workspaceWithFailingSources('connector-json', 3);

    const run = await runCli(['connector', 'sync', '--config', configPath, '--json']);

    // Parsed from stdout alone: a report a script cannot capture is not a report.
    const report = JSON.parse(run.stdout) as SyncReport;
    expect(report.synced).toBe(0);
    expect(report.failed).toBe(3);
    expect(report.failures).toHaveLength(3);
    expect(report.failures.map((f) => f.displayName).sort()).toEqual([
      'nightly-source-0',
      'nightly-source-1',
      'nightly-source-2',
    ]);
    for (const f of report.failures) {
      expect(f.error, JSON.stringify(f)).toBeTruthy();
      expect(f.connectorId, JSON.stringify(f)).toBeTruthy();
    }
    expect(run.status, run.output).not.toBe(0);
  });

  it('still exits zero, quietly, when there was nothing to bring up to date', async () => {
    // The pass a healthy nightly job makes most nights. A check that failed an
    // empty sync would be no better than one that passed a broken one.
    const dir = join(scratch, 'connector-nothing-to-do');
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, 'lattice.config.yml');
    writeFileSync(configPath, WORKSPACE_CONFIG, 'utf8');

    const run = await runCli(['connector', 'sync', '--config', configPath, '--json']);

    const report = JSON.parse(run.stdout) as SyncReport;
    expect(report).toEqual({ synced: 0, failed: 0, failures: [] });
    expect(run.status, run.output).toBe(0);
  });
});

// ── `lattice account sync` ─────────────────────────────────────────────────

/** A stub account service: start / exchange / workspaces / credential. */
function startAccountStub(workspaces: unknown[]): Promise<string> {
  return new Promise((resolveBase) => {
    const srv = createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const send = (code: number, body: unknown): void => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (path === '/api/device/start') {
          send(200, {
            requestId: 'req-1',
            requestSecret: 'secret-1',
            verifyUrl: 'https://accounts.example/device/approve?rid=req-1',
            expiresInSeconds: 900,
          });
          return;
        }
        if (path === '/api/device/exchange') {
          const body = JSON.parse(raw || '{}') as Record<string, string>;
          if (body.code === APPROVED_CODE) {
            send(200, { token: 'test_bearer', email: 'ops@example.com', name: 'Ops' });
          } else {
            send(400, { error: 'invalid code' });
          }
          return;
        }
        if (path === '/api/me/workspaces') {
          send(200, { workspaces });
          return;
        }
        if (/^\/api\/me\/workspaces\/[^/]+\/credential$/.test(path)) {
          // A credential pointing at a port nothing listens on, so the real
          // probe refuses it — one membership that cannot arrive.
          send(200, {
            connUrl: 'postgres://member:pw@127.0.0.1:1/tenant',
            role: 'member',
            workspaceName: 'Team Alpha',
          });
          return;
        }
        send(404, { error: 'not found' });
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      stubs.push(srv);
      resolveBase(`http://127.0.0.1:${String(port)}`);
    });
  });
}

const UNARRIVABLE_MEMBERSHIP = [
  {
    id: 'acct-1',
    name: 'Team Alpha',
    status: 'active',
    membershipId: 'mem-1',
    role: 'member',
    membershipStatus: 'active',
  },
];

describe('an account sync in which a membership did not arrive', () => {
  let base: string;

  beforeAll(async () => {
    base = await startAccountStub(UNARRIVABLE_MEMBERSHIP);
    mkdirSync(join(scratch, 'machine-config'), { recursive: true });
    // Sign this machine in for real, in two runs, the way a person does.
    const started = await runCli(['account', 'signin'], { LATTICE_IDENTITY_URL: base });
    expect(started.status, started.output).toBe(0);
    const finished = await runCli(['account', 'code', APPROVED_CODE], {
      LATTICE_IDENTITY_URL: base,
    });
    expect(finished.status, finished.output).toBe(0);
  });

  it('leaves as a failure for a person, carrying the report', async () => {
    const run = await runCli(['account', 'sync'], { LATTICE_IDENTITY_URL: base });

    expect(run.output).toContain('Some memberships did not arrive');
    expect(run.output).toContain('Team Alpha');
    expect(run.status, run.output).not.toBe(0);
  });

  it('leaves as a failure for a machine too, and says which membership', async () => {
    // The same pass, asked for the machine-readable form. It used to return
    // before its own check ever ran: same failure, same lost workspace, exit
    // zero — the caller least able to read a printed report was the one told
    // nothing was wrong.
    const run = await runCli(['account', 'sync', '--json'], { LATTICE_IDENTITY_URL: base });

    expect(run.output).toContain('Team Alpha');
    const payload = /\{[\s\S]*\}/.exec(run.output)?.[0] ?? '';
    const parsed = JSON.parse(payload) as { linked: boolean; errors: string[] };
    expect(parsed.linked).toBe(true);
    expect(parsed.errors.join('\n')).toContain('Team Alpha');
    expect(run.status, run.output).not.toBe(0);
  });
});
