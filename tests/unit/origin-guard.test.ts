import { describe, it, expect } from 'vitest';
import {
  computeBoundAuthorities,
  isSameOriginRequest,
  isLoopbackHost,
} from '../../src/gui/origin-guard.js';

/**
 * The local GUI server is unauthenticated and trusts the loopback, so a browser on
 * that loopback is the cross-site attacker's vehicle. The guard must let legitimate
 * same-origin GUI traffic through while rejecting cross-site requests and rebound
 * Host headers (DNS rebinding). These tests pin that policy.
 */
describe('origin-guard: CSRF / DNS-rebinding policy', () => {
  const PORT = 4317;
  const loopback = computeBoundAuthorities('127.0.0.1', PORT, true);

  it('accepts the exact bound loopback authorities', () => {
    expect(loopback.has('127.0.0.1:4317')).toBe(true);
    expect(loopback.has('localhost:4317')).toBe(true);
    expect(loopback.has('[::1]:4317')).toBe(true);
    // A non-loopback host is NOT added for a loopback bind.
    expect(loopback.has('0.0.0.0:4317')).toBe(false);
  });

  it('adds the operator host:port only for a non-loopback bind', () => {
    const remote = computeBoundAuthorities('192.168.1.9', PORT, false);
    expect(remote.has('192.168.1.9:4317')).toBe(true);
    expect(remote.has('127.0.0.1:4317')).toBe(true); // loopback aliases stay
  });

  // ── same-origin (legitimate GUI) ──────────────────────────────────────────
  it('PASSES a browser same-origin fetch (Sec-Fetch-Site: same-origin)', () => {
    expect(
      isSameOriginRequest(
        {
          host: '127.0.0.1:4317',
          origin: 'http://127.0.0.1:4317',
          'sec-fetch-site': 'same-origin',
        },
        loopback,
      ),
    ).toBe(true);
  });

  it('PASSES a direct user navigation (Sec-Fetch-Site: none)', () => {
    expect(
      isSameOriginRequest({ host: 'localhost:4317', 'sec-fetch-site': 'none' }, loopback),
    ).toBe(true);
  });

  it('PASSES a non-browser client with neither Sec-Fetch-Site nor Origin (curl / Node fetch)', () => {
    expect(isSameOriginRequest({ host: '127.0.0.1:4317' }, loopback)).toBe(true);
  });

  it('PASSES an Origin-only client whose Origin matches the bound authority', () => {
    expect(
      isSameOriginRequest({ host: 'localhost:4317', origin: 'http://localhost:4317' }, loopback),
    ).toBe(true);
  });

  it('wildcard bind (allowAnyHost): accepts a LAN Host that is not a bound authority', () => {
    // Regression (round-4): a --host 0.0.0.0 --allow-remote bind can't enumerate every Host a
    // network client uses; the Host-authority check is skipped so a legit same-origin request from
    // http://192.168.1.50:4317 is served (was 403 → GUI fully broken on a wildcard bind).
    const lan = { host: '192.168.1.50:4317', 'sec-fetch-site': 'same-origin' as const };
    expect(isSameOriginRequest(lan, loopback)).toBe(false); // without allowAnyHost → blocked
    expect(isSameOriginRequest(lan, loopback, true)).toBe(true); // wildcard bind → allowed
  });

  it('wildcard bind still blocks a CROSS-SITE fetch (Sec-Fetch-Site checks remain)', () => {
    expect(
      isSameOriginRequest(
        { host: '192.168.1.50:4317', 'sec-fetch-site': 'cross-site' },
        loopback,
        true,
      ),
    ).toBe(false);
  });

  // ── cross-site (attacker) ─────────────────────────────────────────────────
  it('BLOCKS a cross-site fetch (Sec-Fetch-Site: cross-site) even with a valid Host', () => {
    expect(
      isSameOriginRequest(
        { host: '127.0.0.1:4317', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
        loopback,
      ),
    ).toBe(false);
  });

  it('BLOCKS same-site (a sibling localhost port is still a different origin)', () => {
    expect(
      isSameOriginRequest({ host: '127.0.0.1:4317', 'sec-fetch-site': 'same-site' }, loopback),
    ).toBe(false);
  });

  it('BLOCKS an Origin-only client whose Origin is foreign', () => {
    expect(
      isSameOriginRequest({ host: '127.0.0.1:4317', origin: 'https://evil.example' }, loopback),
    ).toBe(false);
  });

  // ── DNS rebinding ─────────────────────────────────────────────────────────
  it('BLOCKS a rebound Host header (attacker hostname resolved to 127.0.0.1)', () => {
    // The browser thinks it is talking to attacker.example (rebound to 127.0.0.1),
    // so it sends that hostname in Host and Sec-Fetch-Site: same-origin.
    expect(
      isSameOriginRequest(
        {
          host: 'attacker.example:4317',
          origin: 'http://attacker.example:4317',
          'sec-fetch-site': 'same-origin',
        },
        loopback,
      ),
    ).toBe(false);
  });

  it('BLOCKS a valid loopback host on the WRONG port', () => {
    expect(
      isSameOriginRequest({ host: '127.0.0.1:9999', 'sec-fetch-site': 'same-origin' }, loopback),
    ).toBe(false);
  });

  it('BLOCKS a missing Host header', () => {
    expect(isSameOriginRequest({ 'sec-fetch-site': 'same-origin' }, loopback)).toBe(false);
  });

  it('normalizes array-valued headers (takes the first)', () => {
    expect(
      isSameOriginRequest(
        { host: ['127.0.0.1:4317'], 'sec-fetch-site': ['same-origin'] },
        loopback,
      ),
    ).toBe(true);
  });

  // ── loopback classification (drives the CLI --allow-remote gate) ──────────
  it('classifies loopback vs non-loopback bind hosts', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.5.6.7')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.9')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
  });
});
