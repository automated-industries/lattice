// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { rowLabel } from '../../src/gui/mutations.js';
import { dashboardJs } from '../../src/gui/app/modules/dashboard.js';

/**
 * `rowLabel` (server) is mirrored by `fsDisplayName` in src/gui/app/script.ts
 * (client) — the client can't import server TS, the same constraint as the
 * documented `isJunction` mirror. This pins the priority contract so the two
 * can't silently drift: a card and its activity-feed bubble must name a row the
 * same way. If you change the priority order here, change `fsDisplayName` too.
 */
describe('rowLabel (mirrored by the client fsDisplayName — keep in lockstep)', () => {
  it('prefers the title-ish columns in order', () => {
    expect(rowLabel({ name: 'Acme', title: 'ignored' })).toBe('Acme');
    expect(rowLabel({ title: 'A Title', subject: 'ignored' })).toBe('A Title');
    expect(rowLabel({ label: 'A Label' })).toBe('A Label');
    expect(rowLabel({ original_name: 'invoice.pdf' })).toBe('invoice.pdf');
    expect(rowLabel({ subject: 'Re: hello' })).toBe('Re: hello');
  });

  it('falls back to a snippet of a body/description field', () => {
    expect(rowLabel({ description: 'a short description' })).toBe('a short description');
    const long = 'x'.repeat(200);
    const out = rowLabel({ body: long });
    expect(out?.length).toBeLessThanOrEqual(61); // 60 + ellipsis
  });

  it('falls back to the first meaningful cell (skipping id / *_id / *_at)', () => {
    expect(rowLabel({ id: 'r1', invoice_number: 'INV-114', vendor: 'Acme' })).toBe('INV-114');
    expect(rowLabel({ id: 'r1', created_at: 'x', status: 'open' })).toBe('open');
  });

  it('returns null when there is nothing human to show', () => {
    expect(rowLabel({ id: 'r1', deleted_at: null })).toBeNull();
    expect(rowLabel({ id: 'r1', project_id: 'fk-uuid' })).toBeNull(); // foreign keys skipped
    expect(rowLabel(null)).toBeNull();
    expect(rowLabel('not an object')).toBeNull();
  });

  it('numbers are usable labels', () => {
    expect(rowLabel({ id: 'r1', total: 6400 })).toBe('6400');
  });

  it('a whitespace-only title-ish value is not a label', () => {
    // Pins the side of the contract the client had drifted from: a blank-looking
    // title must fall through, not become a label that renders as nothing.
    expect(rowLabel({ id: 'r1', title: '   ', vendor: 'Acme' })).toBe('Acme');
  });
});

/**
 * The rows table's lead cell is the row's link text. When that one column is
 * empty the link used to read as a fixed placeholder, which named nothing and
 * could not be searched for or told apart from every other empty-lead row — so a
 * row was, in practice, unfindable. It must fall through to the SAME row label
 * every other surface uses, which is why this lives beside the mirror contract
 * above rather than in its own fallback.
 *
 * Driven through the real `paintRowsTable` in jsdom (the module string evaluated
 * as the client evaluates it), with only the wrapper-scoped helpers from the
 * display-config segment stubbed — the same harness shape as the other client
 * module tests.
 */
type Win = Record<string, unknown>;
interface Row {
  id?: string;
  [col: string]: unknown;
}
interface PaintOpts {
  breadcrumbHtml: string;
  icon: string;
  label: string;
  table: string;
  cols: string[];
  rows: Row[];
  hrefFor: (r: Row) => string;
  totalLabel: string;
}
type Paint = (content: HTMLElement, o: PaintOpts) => void;

let loaded = false;
function loadClient(): void {
  const w = globalThis as unknown as Win;
  w.escapeHtml = (v: unknown): string =>
    v == null
      ? ''
      : String(v).replace(
          /[&<>"']/g,
          (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
        );
  w.fieldLabel = (col: string): string => col;
  w.truncate = (s: unknown, n: number): string => {
    if (s == null) return '';
    const str = String(s);
    return str.length > n ? str.slice(0, n) + '…' : str;
  };
  w.isSecretColumn = (): boolean => false;
  w.looksEncrypted = (): boolean => false;
  w.SECRET_MASK = '••••••••';
  if (loaded) return;
  loaded = true;
  // Indirect eval defines the module's functions on the jsdom global scope, the
  // same single shared scope they share inside the composed client IIFE.
  (0, eval)(dashboardJs);
}

/** Render one page of rows and hand back the lead-cell link texts. */
function leadLinks(cols: string[], rows: Row[]): string[] {
  const content = document.createElement('div');
  document.body.appendChild(content);
  (globalThis as unknown as { paintRowsTable: Paint }).paintRowsTable(content, {
    breadcrumbHtml: '',
    icon: '📦',
    label: 'Invoices',
    table: 'invoices',
    cols,
    rows,
    hrefFor: (r) => '#/fs/invoices/' + String(r.id),
    totalLabel: String(rows.length),
  });
  return Array.from(content.querySelectorAll('.fs-rows-table tbody a')).map(
    (a) => a.textContent ?? '',
  );
}

describe('rows table lead cell names a row that has no lead value', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    loadClient();
  });

  it('uses the shared row label instead of a placeholder when the lead column is empty', () => {
    const links = leadLinks(
      ['name', 'status'],
      [{ id: 'aaaaaaaa-1111', name: '', status: 'open' }],
    );
    expect(links).toEqual(['open']);
    expect(links[0]).not.toBe('(untitled)');
  });

  it('whitespace-only is empty too, and a present lead value still wins', () => {
    const links = leadLinks(
      ['title', 'vendor'],
      [
        { id: 'r1', title: '   ', vendor: 'Acme' },
        { id: 'r2', title: 'Q3 renewal', vendor: 'Acme' },
      ],
    );
    expect(links).toEqual(['Acme', 'Q3 renewal']);
  });

  it('still names the row as a short id on a wide table, where no cell shows the id', () => {
    // The rendered column list sorts id LAST and caps at eight, so on a wide table
    // the id is not among the cells at all. That does not defeat the fallback: it
    // reads the ROW, not the rendered columns, and both callers build their href
    // from row.id — so the id is always there to fall back on. Driven through the
    // real column chooser rather than a hand-written list, so the cap is the real one.
    const table = {
      columns: ['id', 'name', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'],
    };
    const cols = (globalThis as unknown as { objRowCols: (t: unknown) => string[] }).objRowCols(
      table,
    );
    expect(cols).not.toContain('id');
    expect(cols[0]).toBe('name');

    const row: Row = { id: 'abcdef1234567890', name: null, project_id: 'fk', created_at: 'x' };
    for (const c of cols) if (!(c in row)) row[c] = null;
    expect(leadLinks(cols, [row])).toEqual(['#abcdef12']);
  });

  it('escapes the fallback label — it is raw row text, not pre-escaped cell HTML', () => {
    const content = document.createElement('div');
    document.body.appendChild(content);
    (globalThis as unknown as { paintRowsTable: Paint }).paintRowsTable(content, {
      breadcrumbHtml: '',
      icon: '📦',
      label: 'Invoices',
      table: 'invoices',
      cols: ['name', 'note'],
      rows: [{ id: 'r1', name: '', note: '<img src=x onerror=alert(1)>' }],
      hrefFor: () => '#/fs/invoices/r1',
      totalLabel: '1',
    });
    expect(content.querySelector('.fs-rows-table tbody img')).toBeNull();
    expect(content.querySelector('.fs-rows-table tbody a')?.textContent).toBe(
      '<img src=x onerror=alert(1)>',
    );
  });
});
