/**
 * A form that was never sent must not be reported as a network failure.
 *
 * Leaving Host blank in the Migrate-to-cloud dialog produced:
 *
 *   Cloud unreachable: A host is required. Double-check host, port, user, and
 *   password.
 *
 * for a request that never opened a socket, and sent the reader to re-check four
 * fields, three of which were fine. The server half of that fix shipped — the
 * probe route answers 400 with the offending field named, and reserves credential
 * and network wording for a server that actually answered — but the dialog kept
 * wrapping EVERY answer in "Cloud unreachable", because it read the body without
 * ever looking at whether the response was an error. A 400 body has no
 * `reachable` key, so `!probe.reachable` was true and the wrapper fired.
 *
 * The test drives both halves as the product wires them: the REAL route handler
 * produces the REAL status and body, and the shipped client function — sliced out
 * of the composed application script, not a copy of it — is what turns that into
 * the sentence a person reads. Nothing about the message is asserted from either
 * side alone.
 */
import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { appJs } from '../../src/gui/app/script.js';
import { dispatchCloudState } from '../../src/gui/dbconfig/cloud-state-routes.js';
import type { DbConfigContext } from '../../src/gui/dbconfig/shared.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

/** POST a body at the real `/api/dbconfig/probe` handler and read what it answers. */
async function probeRoute(body: Record<string, unknown>): Promise<Answer> {
  const req = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
  let status = 0;
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

  // The probe branch reads the request body and the shared body parser; it never
  // reaches for the session's database, so the context only has to carry the
  // route's own coordinates.
  const ctx = { pathname: '/api/dbconfig/probe', method: 'POST' } as unknown as DbConfigContext;
  const handled = await dispatchCloudState(req, res, ctx);
  expect(handled, 'the probe route claimed the request').toBe(true);
  return { status, body: JSON.parse(raw) as Record<string, unknown> };
}

/**
 * The shipped `probeBeforeCredentialSave`, taken verbatim out of the composed
 * application script and given a fetch that replays one answer.
 *
 * Sliced rather than re-implemented on purpose: a re-implementation would prove
 * the test's copy behaves, which is not the thing that shipped.
 */
function shippedProbeCall(answer: Answer): (body: Record<string, unknown>) => Promise<unknown> {
  const from = appJs.indexOf('function detectSupabasePoolerMistakes');
  const to = appJs.indexOf('function showMigrateToCloudModal');
  expect(from, 'found the client helpers in the app script').toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  const source = appJs.slice(from, to);

  const sandbox: {
    fetch: () => Promise<unknown>;
    escapeHtml: (s: string) => string;
    exported?: (body: unknown, msgEl: unknown) => Promise<unknown>;
  } = {
    fetch: () =>
      Promise.resolve({
        ok: answer.status >= 200 && answer.status < 300,
        status: answer.status,
        json: () => Promise.resolve(answer.body),
      }),
    escapeHtml: (s: string) => s,
  };
  runInNewContext(`${source}\nexported = probeBeforeCredentialSave;`, sandbox);
  const fn = sandbox.exported!;
  // The dialog passes the inline message element; only textContent/innerHTML are used.
  const msgEl = { textContent: '', innerHTML: '' };
  return (body: Record<string, unknown>) => fn(body, msgEl);
}

/** What the user is shown when the call rejects. */
async function messageFor(answer: Answer, form: Record<string, unknown>): Promise<string> {
  try {
    await shippedProbeCall(answer)(form);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('the call was supposed to reject and did not');
}

const FORM_MISSING_HOST = {
  type: 'postgres',
  label: 'Field Notes',
  host: '',
  port: 5432,
  dbname: 'notes',
  user: 'someone',
  password: 'pw',
};

describe('the migrate dialog reports a rejected form as a rejected form', () => {
  it('does not dress a validation failure up as an unreachable cloud', async () => {
    const answer = await probeRoute(FORM_MISSING_HOST);
    expect(answer.status, 'the server rejected the form before dialing anything').toBe(400);
    expect(answer.body.field).toBe('host');

    const message = await messageFor(answer, FORM_MISSING_HOST);

    expect(message, 'it says the one thing that was wrong').toBe('A host is required.');
    expect(message, 'and never asserts a connection that was not attempted').not.toContain(
      'unreachable',
    );
    expect(message, 'nor sends the reader to re-check three fields that were fine').not.toContain(
      'Double-check host, port, user, and password',
    );
  });

  it('names the offending field for every other pre-flight refusal too', async () => {
    for (const [field, form] of [
      ['label', { ...FORM_MISSING_HOST, host: 'db.example.test', label: '  ' }],
      ['dbname', { ...FORM_MISSING_HOST, host: 'db.example.test', dbname: '' }],
      ['user', { ...FORM_MISSING_HOST, host: 'db.example.test', user: '' }],
      ['port', { ...FORM_MISSING_HOST, host: 'db.example.test', port: 'not-a-port' }],
    ] as [string, Record<string, unknown>][]) {
      const answer = await probeRoute(form);
      expect(answer.status, `${field} is refused before any connection`).toBe(400);
      expect(answer.body.field).toBe(field);
      const message = await messageFor(answer, form);
      expect(message, `${field}: reported as itself`).toBe(answer.body.error);
      expect(message).not.toContain('unreachable');
    }
  });

  it('still says "unreachable" when the cloud really is unreachable', async () => {
    // The 200 answer a genuinely-attempted probe returns. Synthesized rather than
    // produced by dialling a dead host, which would make this test a network test;
    // the shape is probeCloud's documented result and the route passes it straight
    // through. What matters here is that fixing the 400 path did not silence the
    // one message that IS about the network.
    const answer: Answer = {
      status: 200,
      body: { reachable: false, error: 'connect ECONNREFUSED 10.0.0.9:5432' },
    };
    const message = await messageFor(answer, {
      ...FORM_MISSING_HOST,
      host: 'db.example.test',
      label: 'field_notes',
    });
    expect(message).toContain('Cloud unreachable: connect ECONNREFUSED 10.0.0.9:5432');
    expect(message).toContain('Double-check host, port, user, and password');
  });
});
