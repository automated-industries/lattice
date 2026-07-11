// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { connectorsSettingsJs } from '../../src/gui/app/modules/connectors-settings.js';
import { appJs } from '../../src/gui/app/script.js';

/**
 * 4.3 — the data-driven Connectors panel (client), rendered into the left-sliding
 * "Add a Connector" dialog. Executed in a jsdom window with stubbed fetchJson/fetch
 * so we assert the REAL rendered DOM (cards built from each toolkit's declared
 * fields) + that the buttons call the right endpoints — the part that can't be
 * checked server-side.
 */

interface FetchCall {
  url: string;
  method: string;
  body?: string;
}

// A toolkit descriptor as GET /api/connectors now returns it (presentation + fields).
const JIRA_TK = {
  toolkit: 'jira',
  label: 'Jira',
  icon: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
  credentialFields: [
    { key: 'site', label: 'Site URL', type: 'text', placeholder: 'https://your.atlassian.net' },
    { key: 'email', label: 'Email', type: 'text' },
    { key: 'token', label: 'API token', type: 'password' },
  ],
  helpUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
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

describe('connectors panel (jsdom)', () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  it('renders a data-driven credential form from the toolkit fields when not connected', async () => {
    const render = loadPanel({ toolkits: [JIRA_TK], connectors: [] }, []);
    render(host);
    await flush();
    expect(host.innerHTML).toContain('Jira');
    // One input per declared credential field, id'd as cred-<toolkit>-<key>.
    expect(host.querySelector('#cred-jira-site')).toBeTruthy();
    expect(host.querySelector('#cred-jira-email')).toBeTruthy();
    expect(host.querySelector('#cred-jira-token')).toBeTruthy();
    // The logo renders from the toolkit's icon.
    expect(host.querySelector('img.connector-icon')).toBeTruthy();
    const connect = host.querySelector<HTMLButtonElement>('button[data-act="connect"]')!;
    expect(connect).toBeTruthy();
    expect(connect.disabled).toBe(false);
  });

  it('shows Refresh + Disconnect + status for a connected toolkit', async () => {
    const render = loadPanel(
      {
        toolkits: [JIRA_TK],
        connectors: [
          { id: 'c1', toolkit: 'jira', status: 'connected', lastSyncAt: '2026-06-23T00:00:00Z' },
        ],
      },
      [],
    );
    render(host);
    await flush();
    expect(host.innerHTML).toContain('connected');
    expect(host.innerHTML).toContain('last synced');
    expect(host.querySelector('button[data-act="refresh"]')).toBeTruthy();
    expect(host.querySelector('button[data-act="disconnect"]')).toBeTruthy();
    // No credential form once connected.
    expect(host.querySelector('#cred-jira-token')).toBeNull();
  });

  it('Connect posts the entered credentials to the connect endpoint', async () => {
    const calls: FetchCall[] = [];
    const render = loadPanel({ toolkits: [JIRA_TK], connectors: [] }, calls);
    render(host);
    await flush();

    host.querySelector<HTMLInputElement>('#cred-jira-site')!.value = 'https://x.atlassian.net';
    host.querySelector<HTMLInputElement>('#cred-jira-email')!.value = 'a@x.com';
    host.querySelector<HTMLInputElement>('#cred-jira-token')!.value = 'sk-test';
    host.querySelector<HTMLButtonElement>('button[data-act="connect"]')!.click();
    await flush();

    const post = calls.find((c) => c.url === '/api/connectors/jira/connect' && c.method === 'POST');
    expect(post).toBeTruthy();
    expect(post!.body).toContain('x.atlassian.net');
    expect(post!.body).toContain('sk-test');
  });

  it('Refresh hits the refresh endpoint', async () => {
    const calls: FetchCall[] = [];
    const render = loadPanel(
      { toolkits: [JIRA_TK], connectors: [{ id: 'c1', toolkit: 'jira', status: 'connected' }] },
      calls,
    );
    render(host);
    await flush();
    host.querySelector<HTMLButtonElement>('button[data-act="refresh"]')!.click();
    await flush();
    expect(calls.some((c) => c.url === '/api/connectors/jira/refresh' && c.method === 'POST')).toBe(
      true,
    );
  });

  it('Disconnect hits the DELETE endpoint', async () => {
    const calls: FetchCall[] = [];
    const render = loadPanel(
      { toolkits: [JIRA_TK], connectors: [{ id: 'c1', toolkit: 'jira', status: 'connected' }] },
      calls,
    );
    render(host);
    await flush();
    host.querySelector<HTMLButtonElement>('button[data-act="disconnect"]')!.click();
    await flush();
    expect(calls.some((c) => c.url === '/api/connectors/jira' && c.method === 'DELETE')).toBe(true);
  });
});

describe('connectors panel wiring (structural + parse-safety)', () => {
  it('the connect FORM is the left-sliding dialog; the Connectors tab only hosts the list + entry', () => {
    expect(appJs).toContain('function renderConnectorsPanel(host)');
    expect(appJs).toContain('function openConnectorsDialog()');
    // There IS now a Connectors Configure tab, but it renders the connectors LIST
    // (renderConnectorsTab → renderSourcesConnectors) + the "Add a Connector" entry —
    // the connect FORM (renderConnectorsPanel) still lives only in the left-sliding
    // dialog, never embedded in the drawer body.
    expect(appJs).toContain("tab === 'connectors'");
    expect(appJs).toContain('renderConnectorsTab');
    // The "Add a Connector" button opens that dialog.
    expect(appJs).toContain('openConnectorsDialog()');
  });

  it('the composed client script is syntactically valid (no broken template)', () => {
    // Constructing a Function PARSES the body without executing it — a syntax
    // error anywhere in the composed script (e.g. a malformed module) throws here.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    expect(() => new Function(appJs)).not.toThrow();
  });
});
