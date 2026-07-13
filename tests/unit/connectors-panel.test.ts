// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { connectorsSettingsJs } from '../../src/gui/app/modules/connectors-settings.js';
import { appJs } from '../../src/gui/app/script.js';

/**
 * The MCP Connectors panel (client), rendered INSIDE the Configure drawer's
 * "MCP Connectors" tab as a full-width multi-column TABLE (name, server, items,
 * status, last synced, actions) with the add-by-URL form in its OWN mount below,
 * so a table refresh never wipes a half-typed URL. Executed in jsdom with
 * stubbed fetchJson/escapeHtml; asserts the real rendered DOM + endpoints.
 */

interface FetchCall {
  url: string;
  method: string;
  body?: string;
}

interface Conn {
  id: string;
  toolkit?: string;
  displayName: string;
  status: string;
  serverUrl?: string | null;
  lastSyncAt?: string | null;
  lastError?: string | null;
  itemCount?: number;
}

let connectors: Conn[] = [];

function loadPanel(calls: FetchCall[]): void {
  const w = globalThis as unknown as Record<string, unknown>;
  w.escapeHtml = (s: unknown): string =>
    String(s).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
    );
  w.fetchJson = () =>
    Promise.resolve({ toolkits: [{ toolkit: 'mcp', label: 'MCP server' }], connectors });
  w.fetch = (url: string, opts?: { method?: string; body?: string }) => {
    calls.push({ url, method: opts?.method ?? 'GET', body: opts?.body });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
  };
  w.refreshEntities = () => Promise.resolve();
  w.renderSidebar = () => undefined;
  (0, eval)(connectorsSettingsJs);
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function mountTab(): void {
  document.body.innerHTML =
    '<div class="db-panel"><div id="mcp-connectors-list"></div>' +
    '<div id="mcp-connectors-form" class="db-form-host"></div></div>';
}

describe('MCP connectors panel (jsdom)', () => {
  beforeEach(() => {
    mountTab();
    connectors = [];
  });

  it('renders the add-by-URL form in its own mount when nothing is connected', () => {
    const calls: FetchCall[] = [];
    loadPanel(calls);
    (globalThis as unknown as { renderConnectorsPanel: () => void }).renderConnectorsPanel();
    // Form renders synchronously (no fetch); table fills after the fetch.
    const form = document.querySelector('#mcp-connectors-form')!;
    expect(form.querySelector('#mcp-add-url')).toBeTruthy();
    const clientFields = form.querySelector<HTMLElement>('#mcp-client-fields')!;
    expect(clientFields.hidden).toBe(true);
    expect(document.querySelector('#mcp-connectors-form #mcp-add-url')).toBeTruthy();
  });

  it('lists connected servers as a multi-column table with name, server, items', async () => {
    connectors = [
      {
        id: 'c1',
        toolkit: 'mcp',
        displayName: 'Payroll MCP',
        status: 'connected',
        serverUrl: 'https://mcp.example.com',
        itemCount: 20,
        lastSyncAt: null,
      },
      {
        id: 'c2',
        toolkit: 'mcp',
        displayName: 'Notes MCP',
        status: 'connected',
        serverUrl: 'https://two.example',
        itemCount: 1,
      },
    ];
    const calls: FetchCall[] = [];
    loadPanel(calls);
    (globalThis as unknown as { renderConnectorsPanel: () => void }).renderConnectorsPanel();
    await flush();
    const table = document.querySelector('#mcp-connectors-list table.db-table')!;
    expect(table).toBeTruthy();
    expect(table.querySelectorAll('thead th').length).toBe(6);
    const html = document.querySelector('#mcp-connectors-list')!.innerHTML;
    expect(html).toContain('Payroll MCP');
    expect(html).toContain('https://mcp.example.com');
    expect(html).toContain('20 items');
    expect(html).toContain('1 item'); // singular
    expect(document.querySelectorAll('button[data-conn-act="refresh"]').length).toBe(2);
    expect(document.querySelectorAll('button[data-conn-act="disconnect"]').length).toBe(2);
  });

  it('Connect posts the entered URL to the connect endpoint', async () => {
    const calls: FetchCall[] = [];
    loadPanel(calls);
    (globalThis as unknown as { renderConnectorsPanel: () => void }).renderConnectorsPanel();
    await flush();
    document.querySelector<HTMLInputElement>('#mcp-add-url')!.value = 'https://mcp.justco.example';
    document.querySelector<HTMLButtonElement>('button[data-conn-act="connect"]')!.click();
    await flush();
    const post = calls.find((c) => c.url === '/api/connectors/mcp/connect' && c.method === 'POST');
    expect(post).toBeTruthy();
    expect(post!.body).toContain('mcp.justco.example');
  });

  it('reveals the pre-registered client fields on client_registration_unsupported', async () => {
    const calls: FetchCall[] = [];
    const w = globalThis as unknown as Record<string, unknown>;
    loadPanel(calls);
    let first = true;
    w.fetch = (url: string, opts?: { method?: string; body?: string }) => {
      calls.push({ url, method: opts?.method ?? 'GET', body: opts?.body });
      const body = first
        ? { error: 'needs a pre-registered client', code: 'client_registration_unsupported' }
        : { redirectUrl: 'https://auth.example/authorize' };
      first = false;
      return Promise.resolve({ ok: true, status: 422, json: () => Promise.resolve(body) });
    };
    (globalThis as unknown as { renderConnectorsPanel: () => void }).renderConnectorsPanel();
    await flush();
    document.querySelector<HTMLInputElement>('#mcp-add-url')!.value = 'https://strict.example';
    document.querySelector<HTMLButtonElement>('button[data-conn-act="connect"]')!.click();
    await flush();
    expect(document.querySelector<HTMLElement>('#mcp-client-fields')!.hidden).toBe(false);
    document.querySelector<HTMLInputElement>('#mcp-add-client-id')!.value = 'preregistered-id';
    document.querySelector<HTMLButtonElement>('button[data-conn-act="connect"]')!.click();
    await flush();
    const posts = calls.filter(
      (c) => c.url === '/api/connectors/mcp/connect' && c.method === 'POST',
    );
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toContain('preregistered-id');
  });

  it('Refresh + Disconnect target the row by connectorId', async () => {
    connectors = [
      {
        id: 'c1',
        toolkit: 'mcp',
        displayName: 'X',
        status: 'connected',
        serverUrl: 'https://x',
        itemCount: 3,
      },
    ];
    const calls: FetchCall[] = [];
    loadPanel(calls);
    (globalThis as unknown as { renderConnectorsPanel: () => void }).renderConnectorsPanel();
    await flush();
    document.querySelector<HTMLButtonElement>('button[data-conn-act="refresh"]')!.click();
    await flush();
    expect(calls.find((c) => c.url === '/api/connectors/mcp/refresh')?.body).toContain('c1');
    document.querySelector<HTMLButtonElement>('button[data-conn-act="disconnect"]')!.click();
    await flush();
    expect(
      calls.find((c) => c.url === '/api/connectors/mcp' && c.method === 'DELETE')?.body,
    ).toContain('c1');
  });

  it('a disconnected server offers Reconnect, reusing its stored row', async () => {
    connectors = [
      {
        id: 'c1',
        toolkit: 'mcp',
        displayName: 'X',
        status: 'disconnected',
        serverUrl: 'https://x',
        itemCount: 0,
      },
    ];
    const calls: FetchCall[] = [];
    loadPanel(calls);
    (globalThis as unknown as { renderConnectorsPanel: () => void }).renderConnectorsPanel();
    await flush();
    expect(document.querySelector('button[data-conn-act="refresh"]')).toBeNull();
    const reconnect = document.querySelector<HTMLButtonElement>(
      'button[data-conn-act="reconnect"]',
    )!;
    expect(reconnect).toBeTruthy();
    reconnect.click();
    await flush();
    const post = calls.find((c) => c.url === '/api/connectors/mcp/connect' && c.method === 'POST');
    expect(post?.body).toContain('c1');
    expect(post!.body).not.toContain('serverUrl');
  });

  it('a background table refresh does NOT wipe a half-typed URL', async () => {
    const calls: FetchCall[] = [];
    loadPanel(calls);
    (globalThis as unknown as { renderConnectorsPanel: () => void }).renderConnectorsPanel();
    await flush();
    document.querySelector<HTMLInputElement>('#mcp-add-url')!.value = 'typing.example.com';
    connectors = [
      {
        id: 'c9',
        toolkit: 'mcp',
        displayName: 'New',
        status: 'connected',
        serverUrl: 'https://n',
        itemCount: 2,
      },
    ];
    (globalThis as unknown as { renderConnectorsTable: () => void }).renderConnectorsTable();
    await flush();
    expect(document.querySelector('#mcp-connectors-list')!.innerHTML).toContain('New');
    expect(document.querySelector<HTMLInputElement>('#mcp-add-url')!.value).toBe(
      'typing.example.com',
    );
  });
});

describe('connectors panel wiring (structural + parse-safety)', () => {
  it('the panel lives in the Configure tab as a full-width table; no dialog', () => {
    expect(appJs).toContain('function renderConnectorsPanel()');
    expect(appJs).toContain("tab === 'connectors'");
    expect(appJs).toContain('renderConnectorsTab');
    expect(appJs).toContain('mcp-connectors-list');
    expect(appJs).toContain('mcp-connectors-form');
    expect(appJs).not.toContain('openConnectorsDialog');
    expect(appJs).not.toContain('connectors-dialog-body');
  });

  it('the composed client script is syntactically valid (no broken template)', () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    expect(() => new Function(appJs)).not.toThrow();
  });
});
