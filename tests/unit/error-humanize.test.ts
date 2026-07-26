import { describe, it, expect } from 'vitest';
import {
  humanizeAssistantError,
  isAuthError,
  isInsufficientCredit,
  errorStatus,
} from '../../src/gui/ai/error-humanize.js';

/**
 * A model/provider failure must NEVER reach the chat as a raw JSON body — the user
 * should see a short human sentence. The one deliberate pass-through is an
 * insufficient-credit error, whose structured message the GUI renders as a top-up card.
 */
describe('humanizeAssistantError', () => {
  // A realistic Anthropic-SDK 401: the message embeds the raw JSON error body.
  const raw401 = Object.assign(
    new Error(
      '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    ),
    {
      status: 401,
    },
  );

  it('never leaks the raw JSON body — a 401 becomes a reconnect sentence', () => {
    const msg = humanizeAssistantError(raw401, 'anthropic');
    expect(msg).not.toContain('{'); // no JSON
    expect(msg).not.toContain('authentication_error');
    expect(msg).toMatch(/reconnect/i);
    expect(msg).toMatch(/settings/i);
  });

  it('classifies by status: 429 busy, 5xx server error, other 4xx rejected', () => {
    expect(humanizeAssistantError(Object.assign(new Error('x'), { status: 429 }))).toMatch(/busy/i);
    expect(humanizeAssistantError(Object.assign(new Error('x'), { status: 503 }))).toMatch(
      /server error/i,
    );
    expect(humanizeAssistantError(Object.assign(new Error('x'), { status: 400 }))).toMatch(
      /rejected/i,
    );
  });

  it('names the OpenAI-compatible endpoint distinctly', () => {
    const msg = humanizeAssistantError(
      Object.assign(new Error('x'), { status: 401 }),
      'openai_compat',
    );
    expect(msg).toMatch(/your AI endpoint/i);
  });

  it('detects a network failure with no status', () => {
    expect(humanizeAssistantError(new Error('fetch failed: ECONNREFUSED'))).toMatch(/reach/i);
  });

  it('falls back to a blameless generic message for an unclassifiable error', () => {
    const msg = humanizeAssistantError(new Error('something weird'));
    expect(msg).toMatch(/something went wrong/i);
    expect(msg).not.toContain('something weird'); // raw text not echoed
  });

  it('passes an insufficient-credit error through UNCHANGED (the GUI renders a top-up card)', () => {
    const body =
      'insufficient_credit: Out of Lattice tokens. Add credit at https://pay.example/topup.';
    const err = Object.assign(new Error(body), { status: 402 });
    expect(humanizeAssistantError(err, 'lattice_cloud')).toBe(body); // link + marker preserved
    // Also matched purely by the type marker even without a 402 status.
    expect(humanizeAssistantError(new Error(body))).toBe(body);
  });
});

describe('error classifiers', () => {
  it('errorStatus reads .status or .statusCode, else null', () => {
    expect(errorStatus({ status: 401 })).toBe(401);
    expect(errorStatus({ statusCode: 500 })).toBe(500);
    expect(errorStatus(new Error('x'))).toBeNull();
    expect(errorStatus(null)).toBeNull();
  });

  it('isAuthError is true only for 401/403', () => {
    expect(isAuthError({ status: 401 })).toBe(true);
    expect(isAuthError({ status: 403 })).toBe(true);
    expect(isAuthError({ status: 429 })).toBe(false);
    expect(isAuthError({ status: 500 })).toBe(false);
    expect(isAuthError(new Error('x'))).toBe(false);
  });

  it('isInsufficientCredit matches a 402 or the insufficient_credit marker', () => {
    expect(isInsufficientCredit({ status: 402 })).toBe(true);
    expect(isInsufficientCredit(new Error('insufficient_credit ...'))).toBe(true);
    expect(isInsufficientCredit({ status: 401 })).toBe(false);
  });
});
