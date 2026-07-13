// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { connectorsSettingsJs } from '../../src/gui/app/modules/connectors-settings.js';
import { appJs } from '../../src/gui/app/script.js';

/**
 * The MCP Connectors panel (client), rendered INSIDE the Configure drawer's
 * "MCP Connectors" tab — the left-sliding connectors dialog is gone. Executed
 * in a jsdom window with stubbed fetchJson/fetch so we assert the REAL rendered
 * DOM (server cards + the inline add-by-URL form) and that every action calls
 * the right endpoint with the CONNECTOR ID (multi-instance — several servers
 * share one toolkit).
 */

interface FetchCall {
  url: string;
  method: string;
  body?: string;
}

// The single generic toolkit descriptor GET /api/connectors returns now.
const MCP_TK = {
  toolkit: 'mcp',
  label: 'MCP server',
  icon: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
  connectVia: 'mcp',
  needsServerUrl: true,
};

const CONNECTED = {
  id: 'c1',
  toolkit: 'mcp',
  displayName: 'Payroll MCP',
  status: 'connected',
  lastSyncAt: '2026-07-13T00:00:00Z',
  lastError: null,
  serverUrl: 'https://mcp.example.com',
};

function loadPanel(data: unknown, calls: FetchCall[]): (host: HTMLElement) => void {
  const w = globalThis as unknown as Record<string, unknown>;
  w.escapeHtml = (s: unknown): string =>
    String(s).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
    );
  w.fetchJson = () => Promise.resolve(data);
  w.fetch = (url: string, opts?: { method?: string; body?: string }) => {
    calls.push({ url, method: opts?.method ?? 'GET', body: opts?.body });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
  };
  // Indirect eval defines renderConnectorsPanel on the (jsdom) global scope.
  (0, eval)(connectorsSettingsJs);
  return w.renderConnectorsPanel as (host: HTMLElement) => void;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('MCP connectors panel (jsdom)', () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  it('renders the inline add-by-URL form when nothing is connected', async () => {
    const render = loadPanel({ toolkits: [MCP_TK], connectors: [] }, []);
    render(host);
    await flush();
    expect(host.innerHTML).toContain('Add an MCP connector');
    expect(host.innerHTML).toContain('No MCP servers connected');
    expect(host.querySelector('#mcp-add-url')).toBeTruthy();
    // The pre-registered-client fields exist but stay hidden until a server needs them.
    const clientFields = host.querySelector<HTMLElement>('#mcp-client-fields')!;
    expect(clientFields).toBeTruthy();
    expect(clientFields.hidden).toBe(true);
  });

  it('lists every connected server with its name, URL, status, and per-row actions', async () => {
    const render = loadPanel(
      {
        toolkits: [MCP_TK],
        connectors: [
          CONNECTED,
          { ...CONNECTED, id: 'c2', displayName: 'Notes MCP', serverUrl: 'https://two.example' },
        ],
      },
      [],
    );
    render(host);
    await flush();
    expect(host.innerHTML).toContain('Payroll MCP');
    expect(host.innerHTML).toContain('Notes MCP');
    expect(host.innerHTML).toContain('https://mcp.example.com');
    expect(host.innerHTML).toContain('https://two.example');
    expect(host.innerHTML).toContain('last synced');
    expect(host.querySelectorAll('button[data-act="refresh"]')).toHaveLength(2);
    expect(host.querySelectorAll('button[data-act="disconnect"]')).toHaveLength(2);
  });

  it('Connect posts the entered URL to the connect endpoint', async () => {
    const calls: FetchCall[] = [];
    const render = loadPanel({ toolkits: [MCP_TK], connectors: [] }, calls);
    render(host);
    await flush();
    host.querySelector<HTMLInputElement>('#mcp-add-url')!.value = 'https://mcp.justco.example';
    host.querySelector<HTMLButtonElement>('button[data-act="connect"]')!.click();
    await flush();
    const post = calls.find((c) => c.url === '/api/connectors/mcp/connect' && c.method === 'POST');
    expect(post).toBeTruthy();
    expect(post!.body).toContain('mcp.justco.example');
  });

  it('reveals the pre-registered client fields on client_registration_unsupported and resubmits with them', async () => {
    const calls: FetchCall[] = [];
    const w = globalThis as unknown as Record<string, unknown>;
    const render = loadPanel({ toolkits: [MCP_TK], connectors: [] }, calls);
    // First connect answers with the distinct error code.
    let first = true;
    w.fetch = (url: string, opts?: { method?: string; body?: string }) => {
      calls.push({ url, method: opts?.method ?? 'GET', body: opts?.body });
      const body = first
        ? { error: 'needs a pre-registered client', code: 'client_registration_unsupported' }
        : { redirectUrl: 'https://auth.example/authorize' };
      first = false;
      return Promise.resolve({ ok: true, status: 422, json: () => Promise.resolve(body) });
    };
    render(host);
    await flush();
    host.querySelector<HTMLInputElement>('#mcp-add-url')!.value = 'https://strict.example';
    host.querySelector<HTMLButtonElement>('button[data-act="connect"]')!.click();
    await flush();
    const clientFields = host.querySelector<HTMLElement>('#mcp-client-fields')!;
    expect(clientFields.hidden).toBe(false);
    // Resubmit with the client id — the POST body must carry it.
    host.querySelector<HTMLInputElement>('#mcp-add-client-id')!.value = 'preregistered-id';
    host.querySelector<HTMLButtonElement>('button[data-act="connect"]')!.click();
    await flush();
    const posts = calls.filter(
      (c) => c.url === '/api/connectors/mcp/connect' && c.method === 'POST',
    );
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toContain('preregistered-id');
  });

  it('Refresh + Disconnect target the row by connectorId', async () => {
    const calls: FetchCall[] = [];
    const render = loadPanel({ toolkits: [MCP_TK], connectors: [CONNECTED] }, calls);
    render(host);
    await flush();
    host.querySelector<HTMLButtonElement>('button[data-act="refresh"]')!.click();
    await flush();
    const refresh = calls.find(
      (c) => c.url === '/api/connectors/mcp/refresh' && c.method === 'POST',
    );
    expect(refresh?.body).toContain('c1');
    host.querySelector<HTMLButtonElement>('button[data-act="disconnect"]')!.click();
    await flush();
    const del = calls.find((c) => c.url === '/api/connectors/mcp' && c.method === 'DELETE');
    expect(del?.body).toContain('c1');
  });

  it('a disconnected server offers Reconnect, which reuses its stored row', async () => {
    const calls: FetchCall[] = [];
    const render = loadPanel(
      { toolkits: [MCP_TK], connectors: [{ ...CONNECTED, status: 'disconnected' }] },
      calls,
    );
    render(host);
    await flush();
    expect(host.querySelector('button[data-act="refresh"]')).toBeNull();
    const reconnect = host.querySelector<HTMLButtonElement>('button[data-act="reconnect"]')!;
    expect(reconnect).toBeTruthy();
    reconnect.click();
    await flush();
    const post = calls.find((c) => c.url === '/api/connectors/mcp/connect' && c.method === 'POST');
    expect(post).toBeTruthy();
    expect(post!.body).toContain('c1');
    // No serverUrl resent — the stored one is authoritative.
    expect(post!.body).not.toContain('mcp.example.com');
  });
});

describe('connectors panel wiring (structural + parse-safety)', () => {
  it('the panel lives in the Configure tab; the left-sliding connectors dialog is gone', () => {
    expect(appJs).toContain('function renderConnectorsPanel(host)');
    // The tab dispatch renders the panel directly…
    expect(appJs).toContain("tab === 'connectors'");
    expect(appJs).toContain('renderConnectorsTab');
    expect(appJs).toContain('mcp-connectors-panel');
    // …and the old dialog plumbing no longer exists anywhere in the bundle.
    expect(appJs).not.toContain('openConnectorsDialog');
    expect(appJs).not.toContain('connectors-dialog-body');
  });

  it('the composed client script is syntactically valid (no broken template)', () => {
    // Constructing a Function PARSES the body without executing it — a syntax
    // error anywhere in the composed script (e.g. a malformed module) throws here.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    expect(() => new Function(appJs)).not.toThrow();
  });
});
