// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { inputsJs } from '../../src/gui/app/modules/inputs.js';

/**
 * The Databases tab renders its table and its add/edit form into SEPARATE mounts
 * so a background refresh (renderSources fires on every realtime sidebar tick)
 * only rebuilds the table — a half-typed connection in the inline form is never
 * wiped. Executed in jsdom with stubbed fetchJson/escapeHtml/showToast; asserts
 * the real rendered DOM and the preserve-form behavior.
 */

interface Src {
  id: string;
  displayName: string;
  status: string;
  host?: string;
  database?: string;
  tableCount?: number;
  lastSyncAt?: string | null;
  lastError?: string | null;
}

let sources: Src[] = [];

function loadInputs(): void {
  const w = globalThis as unknown as Record<string, unknown>;
  w.escapeHtml = (s: unknown): string =>
    String(s).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
    );
  w.fetchJson = () => Promise.resolve({ sources });
  w.showToast = () => undefined;
  w.renderSources = () => undefined;
  // Indirect eval defines the module's functions on the jsdom global scope.
  (0, eval)(inputsJs);
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function mountTab(): void {
  document.body.innerHTML =
    '<div class="db-panel"><div id="src-databases-list"></div>' +
    '<div id="db-form-host" class="db-form-host"></div></div>';
}

describe('databases inline panel (jsdom)', () => {
  beforeEach(() => {
    loadInputs();
    mountTab();
    sources = [
      {
        id: 'd1',
        displayName: 'Prod RDS',
        status: 'connected',
        host: 'prod.example.com',
        database: 'app',
        tableCount: 42,
        lastSyncAt: null,
      },
    ];
  });

  it('renders a multi-column table (host, database, tables) and the add form', async () => {
    (globalThis as unknown as { renderDatabasesPanel: () => void }).renderDatabasesPanel();
    await flush();
    const table = document.querySelector('#src-databases-list table.db-table')!;
    expect(table).toBeTruthy();
    expect(table.querySelectorAll('thead th').length).toBe(7);
    expect(document.querySelector('#src-databases-list')!.innerHTML).toContain('prod.example.com');
    expect(document.querySelector('#src-databases-list')!.innerHTML).toContain('42 tables');
    // The form is in its OWN mount, not inside the table container.
    expect(document.querySelector('#db-form-host #db-host')).toBeTruthy();
    expect(document.querySelector('#src-databases-list #db-host')).toBeNull();
  });

  it('a background table refresh (realtime tick) does NOT wipe a half-typed form', async () => {
    (globalThis as unknown as { renderDatabasesPanel: () => void }).renderDatabasesPanel();
    await flush();
    // Simulate the user typing a connection into the inline form.
    const hostInput = document.querySelector<HTMLInputElement>('#db-host')!;
    hostInput.value = 'typing.example.com';
    // A realtime sidebar tick refreshes the table via renderInputsDatabases().
    sources = [...sources, { id: 'd2', displayName: 'New DB', status: 'connected', tableCount: 3 }];
    (globalThis as unknown as { renderInputsDatabases: () => void }).renderInputsDatabases();
    await flush();
    // The table updated (new row present) …
    expect(document.querySelector('#src-databases-list')!.innerHTML).toContain('New DB');
    // … but the half-typed form value survived (the form mount was untouched).
    expect(document.querySelector<HTMLInputElement>('#db-host')!.value).toBe('typing.example.com');
  });

  it('an unparseable lastSyncAt is escaped exactly once (no double-escape)', async () => {
    sources = [
      { id: 'd1', displayName: 'X', status: 'connected', lastSyncAt: 'a&b', tableCount: 0 },
    ];
    (globalThis as unknown as { renderInputsDatabases: () => void }).renderInputsDatabases();
    await flush();
    // The cell text is the literal "a&b"; the serialized HTML shows a single
    // &amp; entity (double-escaping would produce &amp;amp;).
    const html = document.querySelector('#src-databases-list')!.innerHTML;
    expect(html).toContain('a&amp;b');
    expect(html).not.toContain('a&amp;amp;b');
  });
});
