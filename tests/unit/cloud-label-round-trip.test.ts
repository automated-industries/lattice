import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { dispatchCloudState } from '../../src/gui/dbconfig/cloud-state-routes.js';
import type { DbConfigContext } from '../../src/gui/dbconfig/shared.js';
import { parseSaveBodyResult } from '../../src/gui/dbconfig/shared.js';
import {
  credentialRef,
  normalizeLabel,
  readDbLine,
  rewriteDbLine,
} from '../../src/framework/db-pointer.js';
import { getDbCredential, saveDbCredential } from '../../src/framework/user-config.js';
import { resolveDbPath } from '../../src/config/parser.js';

/**
 * A workspace Label with a space in it — "Strategy Team" — used to come back as
 * "Invalid Postgres credentials", before anything was dialled. Two things were
 * wrong and they need separate proof:
 *
 *   1. The rejection was reported as the wrong KIND of failure, on every cloud
 *      route that takes connection details, not just the one that was noticed.
 *   2. The label was rejected at all, when normalizing it is what the credential
 *      key charset actually needs.
 *
 * The first half is checked against the REAL route handlers — each one is POSTed
 * a body and the status and JSON it answers with are read back. The second half
 * follows a normalized label all the way through the machinery that stores and
 * re-reads it: save the credential, write the reference into a config, then
 * resolve that config the way opening a workspace does. Asserting the normalizer
 * in isolation would prove the string is hyphenated; it would not prove the
 * hyphenated string comes back as a working database URL, which is the part that
 * was broken.
 */

/** Every cloud route that parses connection details. All three must agree. */
const ROUTES = [
  '/api/dbconfig/probe',
  '/api/dbconfig/migrate-to-cloud',
  '/api/dbconfig/connect-existing',
] as const;

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

/** POST `body` at a real route handler and read what it answers. */
async function post(pathname: string, body: Record<string, unknown>): Promise<Answer> {
  const req = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
  let status = 200;
  let raw = '';
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(chunk?: string) {
      raw = chunk ?? '';
    },
  } as unknown as ServerResponse;
  // All three branches validate the body before they reach for the session's
  // database or the network, so the context only carries the route coordinates.
  // A validation refusal that needed a live database would not be a pre-flight
  // refusal at all.
  const ctx = { pathname, method: 'POST' } as unknown as DbConfigContext;
  const handled = await dispatchCloudState(req, res, ctx);
  expect(handled, `${pathname} claimed the request`).toBe(true);
  return { status, body: JSON.parse(raw) as Record<string, unknown> };
}

const form = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'postgres',
  label: 'Strategy Team',
  host: 'db.example.test',
  port: 5432,
  dbname: 'strategy',
  user: 'owner',
  password: 'pw',
  ...over,
});

describe('every cloud route reports a rejected field as that field', () => {
  it('names the offending field and never blames the credentials', async () => {
    // A label of only symbols normalizes to nothing — the one label the parser
    // still refuses, and the case that used to surface as a credentials error.
    const cases: [string, Record<string, unknown>][] = [
      ['label', form({ label: '###' })],
      ['label', form({ label: '   ' })],
      ['host', form({ host: '' })],
      ['dbname', form({ dbname: '' })],
      ['user', form({ user: '' })],
      ['port', form({ port: 'not-a-port' })],
    ];
    for (const route of ROUTES) {
      for (const [field, body] of cases) {
        const answer = await post(route, body);
        expect(answer.status, `${route} refused ${field} before dialling anything`).toBe(400);
        expect(answer.body.field, `${route} named ${field}`).toBe(field);
        const error = String(answer.body.error ?? '');
        expect(error, `${route}/${field} says something specific`).not.toBe('');
        expect(
          error.toLowerCase(),
          `${route}/${field} must not blame the credentials for a form error`,
        ).not.toContain('credential');
        expect(
          error.toLowerCase(),
          `${route}/${field} must not claim a connection was attempted`,
        ).not.toContain('unreachable');
      }
    }
  });

  it('a spaced label is not a refusal on any of them — it is normalized and accepted', () => {
    // The routes carry a normalized label straight into the work they do, so the
    // check that it survived parsing belongs on the parsed value the three of
    // them share. Anything past this point in those handlers connects out.
    const parsed = parseSaveBodyResult(form({ label: 'Strategy Team' }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.type === 'postgres') {
      expect(parsed.value.label).toBe('Strategy-Team');
    }
  });
});

describe('a normalized label survives being saved and read back', () => {
  let cfgDir: string;
  let wsDir: string;
  let configPath: string;
  const savedEnv: Record<string, string | undefined> = {};

  const URL_A = 'postgres://owner:pw@db.example.test:5432/strategy';

  beforeEach(() => {
    cfgDir = mkdtempSync(join(tmpdir(), 'lattice-label-rt-cfg-'));
    wsDir = mkdtempSync(join(tmpdir(), 'lattice-label-rt-ws-'));
    savedEnv.LATTICE_CONFIG_DIR = process.env.LATTICE_CONFIG_DIR;
    savedEnv.LATTICE_ENCRYPTION_KEY = process.env.LATTICE_ENCRYPTION_KEY;
    process.env.LATTICE_CONFIG_DIR = cfgDir;
    delete process.env.LATTICE_ENCRYPTION_KEY;
    configPath = join(wsDir, 'lattice.config.yaml');
    writeFileSync(
      configPath,
      ['# a workspace', 'db: ./local.db', 'tables:', '  notes:', '    columns:', ''].join('\n'),
      'utf8',
    );
  });

  afterEach(() => {
    if (savedEnv.LATTICE_CONFIG_DIR === undefined) delete process.env.LATTICE_CONFIG_DIR;
    else process.env.LATTICE_CONFIG_DIR = savedEnv.LATTICE_CONFIG_DIR;
    if (savedEnv.LATTICE_ENCRYPTION_KEY === undefined) delete process.env.LATTICE_ENCRYPTION_KEY;
    else process.env.LATTICE_ENCRYPTION_KEY = savedEnv.LATTICE_ENCRYPTION_KEY;
    rmSync(cfgDir, { recursive: true, force: true });
    rmSync(wsDir, { recursive: true, force: true });
  });

  it('save the credential, point the config at it, and opening it finds the database', () => {
    const label = normalizeLabel('Strategy Team');
    expect(label).toBe('Strategy-Team');

    saveDbCredential(label, URL_A);
    rewriteDbLine(configPath, credentialRef(label));

    // What a config file now says, byte for byte.
    const line = readDbLine(configPath);
    expect(line).toBe('${LATTICE_DB:Strategy-Team}');

    // And the read side: this is the call that opening a workspace makes.
    expect(resolveDbPath(line!, dirname(configPath))).toBe(URL_A);
    expect(getDbCredential(label)).toBe(URL_A);

    // The rewrite edited the one line and left the rest of the file alone.
    const yaml = readFileSync(configPath, 'utf8');
    expect(yaml).toContain('# a workspace');
    expect(yaml).toContain('notes:');
  });

  it('the un-normalized label is what normalizing prevents: the config becomes unopenable', () => {
    // Written the way it was typed. Nothing complains at write time — the config
    // looks fine and the credential is really there under that key.
    saveDbCredential('Strategy Team', URL_A);
    rewriteDbLine(configPath, credentialRef('Strategy Team'));
    expect(readDbLine(configPath)).toBe('${LATTICE_DB:Strategy Team}');

    // It fails at OPEN time, which is the next time anyone looks. Loudly, not by
    // quietly resolving to a path and handing back an empty local database.
    expect(() => resolveDbPath(readDbLine(configPath)!, dirname(configPath))).toThrow(
      /malformed .*reference/,
    );
  });

  it('a label the user typed goes from the request body to a resolvable database', () => {
    // The whole chain, in the order the product runs it: what the form sent, what
    // the parser made of it, what got stored, what the config says, what opening
    // it resolves to.
    const parsed = parseSaveBodyResult(form({ label: 'Q1 2026 / Revenue!!' }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.type !== 'postgres') throw new Error('unreachable');

    const label = parsed.value.label;
    expect(label).toBe('Q1-2026-Revenue');

    saveDbCredential(label, URL_A);
    rewriteDbLine(configPath, credentialRef(label));
    expect(resolveDbPath(readDbLine(configPath)!, dirname(configPath))).toBe(URL_A);
  });
});
