/**
 * Viewer-signature isolation for the incremental fold cache — a PINNING suite.
 *
 * The cache keys a compiled per-viewer entity on (row, viewer). The viewer half of
 * that key is a signature derived from the viewer's reachable-source set, and that
 * signature is the only thing standing between two different viewers and each
 * other's compiled row: if two genuinely different viewer contexts produced the
 * same signature, one viewer would be served the other's fold — on a shared
 * workspace, a member seeing a value derived from a source they cannot reach.
 *
 * Analysis of the current construction:
 *
 *  • COMPLETENESS. The fold depends on the viewer through exactly one thing —
 *    `observationVisible` consults `viewer.visibleSources` and nothing else — and
 *    the viewer type carries exactly that one field. So the source set IS the whole
 *    viewer identity, and the signature covers all of it. Two viewers with equal
 *    source sets share a cache entry; that is correct, not a collision.
 *
 *  • ENCODING. The set is flattened by sorting and joining, and the row id is
 *    concatenated in front of it. Both joins use a control character as the
 *    separator, which is what makes the flattening injective: no primary key or
 *    source id can contain one, so the flattened string cannot be re-parsed two
 *    ways. That property is easy to lose by accident — the separators are
 *    invisible in an editor, so "simplifying" one to an empty or printable string
 *    reads as a no-op while immediately making different source sets collide.
 *
 * So no collision is reachable today, and this suite exists to keep it that way:
 * each case is a concrete pair of viewer contexts that stay distinct now and would
 * collide the moment a separator — or a signature input — is dropped.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FoldCache } from '../../src/cloud/fold-cache.js';
import type { Observation, Viewer } from '../../src/cloud/fold.js';

const viewer = (...sources: string[]): Viewer => ({ visibleSources: new Set(sources) });

/** A derived observation on `phone`, visible only to a viewer who can reach every
 *  one of the given source ids. */
const derived = (value: string, ...sources: string[]): Observation => ({
  attribute: 'phone',
  value,
  createdAt: '2026-01-01T00:00:00Z',
  changeKind: 'derived',
  sourceRef: sources,
});

const ground = { id: 'contact-1', phone: 'ground-truth' };

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8');

describe('fold cache — different source sets never share a cache entry', () => {
  it('keeps two source sets apart that would flatten together without a separator', () => {
    // Source ids are ordinary row keys, so they have no fixed width: a connector
    // natural key is namespaced from an external id, a file id is whatever that
    // row's primary key is. Concatenating a sorted set of variable-width strings
    // is ambiguous — {'ab','c'} and {'a','bc'} both read as "abc" — so these two
    // members would share one entry, and the one who cannot reach 'ab' would be
    // served the value derived from it.
    const seer = viewer('ab', 'c'); // can reach source 'ab'
    const blind = viewer('a', 'bc'); // cannot reach source 'ab'
    const observations = [derived('derived-from-ab', 'ab')];

    const cache = new FoldCache();
    expect(cache.get('contacts', 'contact-1', ground, observations, seer).phone).toBe(
      'derived-from-ab',
    );
    expect(cache.get('contacts', 'contact-1', ground, observations, blind).phone).toBe(
      'ground-truth',
    );
    expect(cache.size).toBe(2); // two distinct viewer contexts → two entries
  });

  it('keeps a one-source viewer apart from a two-source viewer that spells the same', () => {
    const observations = [derived('derived-from-abc', 'abc')];
    const cache = new FoldCache();
    expect(cache.get('contacts', 'contact-1', ground, observations, viewer('abc')).phone).toBe(
      'derived-from-abc',
    );
    expect(cache.get('contacts', 'contact-1', ground, observations, viewer('a', 'bc')).phone).toBe(
      'ground-truth',
    );
    expect(cache.size).toBe(2);
  });

  it('never serves one table row for another table row with the same id', () => {
    // A single-column primary key serializes to its bare VALUE, so row "1" of
    // two different tables produces the same id. Without the table in the key
    // the second lookup is a HIT on the first table's compiled row — a
    // wrong-row read across tables, silently.
    const cache = new FoldCache();
    const fromContacts = cache.get(
      'contacts',
      '1',
      { id: '1', phone: 'contact-ground' },
      [derived('contact-derived', 'x')],
      viewer('x'),
    );
    const fromInvoices = cache.get(
      'invoices',
      '1',
      { id: '1', phone: 'invoice-ground' },
      [derived('invoice-derived', 'x')],
      viewer('x'),
    );

    expect(fromContacts.phone).toBe('contact-derived');
    expect(fromInvoices.phone).toBe('invoice-derived');
    expect(cache.size).toBe(2);

    // ...and invalidating one table's row leaves the other table's intact.
    cache.invalidateRow('contacts', '1');
    expect(cache.size).toBe(1);
  });

  it('does not let a row id borrow from the viewer half of the key', () => {
    // A single-column primary key serializes to its bare value, so a row id is
    // arbitrary text and can contain a space. With a space between the two halves,
    // ('contact 1', {'x'}) and ('contact', {'1 x'}) produce the same key — a
    // different row AND a different viewer served from one entry.
    const cache = new FoldCache();
    const a = cache.get(
      'contacts',
      'contact 1',
      ground,
      [derived('derived-from-x', 'x')],
      viewer('x'),
    );
    const b = cache.get(
      'contacts',
      'contact',
      { id: 'contact', phone: 'other-ground' },
      [derived('derived-from-1x', '1 x')],
      viewer('1 x'),
    );

    expect(a.phone).toBe('derived-from-x');
    expect(b.phone).toBe('derived-from-1x');
    expect(b.id).toBe('contact'); // not row 'contact 1' served under a shared key
    expect(cache.size).toBe(2);
  });

  it('treats an equal source set as the same viewer regardless of insertion order', () => {
    // The other half of the contract: the signature must be set-exact, so the same
    // member does not miss the cache just because the set was built in another
    // order (that would quietly turn the cache off rather than leak anything).
    const cache = new FoldCache();
    const observations = [derived('derived-from-f', 'f')];
    const first = cache.get('contacts', 'contact-1', ground, observations, viewer('f', 'g'));
    const second = cache.get('contacts', 'contact-1', ground, observations, viewer('g', 'f'));
    expect(second).toBe(first);
    expect(cache.size).toBe(1);
  });

  it('invalidates every viewer version of one row, and only that row', () => {
    const cache = new FoldCache();
    const observations = [derived('v1', 'ab')];
    cache.get('contacts', 'contact-1', ground, observations, viewer('ab', 'c'));
    cache.get('contacts', 'contact-1', ground, observations, viewer('a', 'bc'));
    cache.get('contacts', 'contact-2', { id: 'contact-2', phone: 'x' }, [], viewer('ab'));
    expect(cache.size).toBe(3);

    cache.invalidateRow('contacts', 'contact-1');
    expect(cache.size).toBe(1);
    // The next read recompiles rather than serving a dropped entry.
    const updated: Observation = { ...derived('v2', 'ab'), createdAt: '2026-02-01T00:00:00Z' };
    expect(cache.get('contacts', 'contact-1', ground, [updated], viewer('ab', 'c')).phone).toBe(
      'v2',
    );
  });
});

describe('fold cache — the signature is built from every viewer discriminator', () => {
  it('pins the viewer fields the signature consumes', () => {
    // A source-level pin, because the risk here is an omission rather than a wrong
    // value: a field added to the viewer type without a matching change to the
    // signature would make two viewers that differ only in that field share one
    // cache entry. That edit has to fail here rather than in production.
    const viewerBody = /export interface Viewer \{([\s\S]*?)\n\}/.exec(
      read('../../src/cloud/fold.ts'),
    );
    expect(viewerBody).not.toBeNull();
    const fields = [...viewerBody![1].matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
    expect(fields).toEqual(['visibleSources']);

    const signature = /function viewerSignature\(viewer: Viewer\): string \{([\s\S]*?)\n\}/.exec(
      read('../../src/cloud/fold-cache.ts'),
    );
    expect(signature).not.toBeNull();
    for (const field of fields) {
      expect(signature![1]).toContain('viewer.' + field);
    }
  });

  it('pins the separators as characters a row id or source id cannot contain', () => {
    // The separators are what make the flattening injective, and they are
    // invisible in an editor — spelling them by code point here means swapping one
    // for an empty or printable string fails loudly instead of reading as a no-op.
    const src = read('../../src/cloud/fold-cache.ts');
    const betweenSources = String.fromCharCode(1);
    const betweenHalves = String.fromCharCode(0);
    expect(src).toContain("join('" + betweenSources + "')");
    expect(src).toContain('${rowId}' + betweenHalves + '${viewerSignature(viewer)}');
  });
});
