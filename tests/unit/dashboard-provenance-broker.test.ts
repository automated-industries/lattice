// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { dashboardJs } from '../../src/gui/app/modules/dashboard.js';
import { provenanceJs } from '../../src/gui/app/modules/provenance.js';
import { analyticsViewJs } from '../../src/gui/app/modules/analytics-view.js';
import { appJs } from '../../src/gui/app/modules/index.js';
import { generateHtmlFile } from '../../src/gui/ai/html-author.js';
import type { LlmClient, TurnParams } from '../../src/gui/ai/chat.js';

/**
 * Click-through from a rendered dashboard to WHERE its data came from.
 *
 * A dashboard renders inside a scripts-only sandboxed iframe with no
 * allow-same-origin, so it lives in an opaque (null) origin and cannot touch the
 * host document at all. The ONLY channel is the parent-side postMessage broker,
 * which is why click-through is a broker MESSAGE rather than a direct call — and
 * why the broker's action list is a security boundary: the frame is untrusted
 * code (an authored page, possibly shaped by row data), so anything it names must
 * be validated PARENT-side before the host acts on it.
 *
 * These run in jsdom against the real client module strings, so they exercise the
 * actual listener, the actual validation, and the actual rendered panel.
 */

type Win = Record<string, unknown>;

const PROVENANCE_PAYLOAD = {
  nodes: [
    { id: 'table:orders', type: 'object', kind: 'table', label: 'orders' },
    { id: 'r1', type: 'raw', kind: 'connector', label: 'Orders export', count: 12 },
  ],
  edges: [{ source: 'r1', target: 'table:orders', relation: 'imported_from' }],
};

let fetched: string[] = [];
let toasts: string[] = [];
let loaded = false;

/** Stub the handful of IIFE globals the two modules call, then define them. */
function loadClient(): void {
  const w = globalThis as unknown as Win;
  w.escapeHtml = (s: unknown): string =>
    String(s).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
    );
  w.fetchJson = (url: string) => {
    fetched.push(url);
    return Promise.resolve(PROVENANCE_PAYLOAD);
  };
  w.showToast = (m: string) => {
    toasts.push(m);
  };
  if (loaded) return;
  loaded = true;
  // Indirect eval defines each module's functions on the jsdom global scope, the
  // same single shared scope they share inside the composed client IIFE.
  (0, eval)(dashboardJs);
  (0, eval)(provenanceJs);
  (globalThis as unknown as { installHtmlFileBroker: () => void }).installHtmlFileBroker();
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** The dashboard page shape: the sandboxed canvas plus its in-place source slot. */
function mountDashboardPage(): HTMLIFrameElement {
  document.body.innerHTML =
    '<div class="dash-page">' +
    '<h1 class="dash-title">Orders</h1>' +
    '<iframe id="dash-frame" class="html-frame dash-frame" sandbox="allow-scripts"></iframe>' +
    '<div id="dash-source" class="dash-history dash-source" hidden></div>' +
    '</div>';
  return document.querySelector('#dash-frame')!;
}

/** The Configure HTML-file preview shape: a frame with NO pre-placed slot. */
function mountFilePreview(): HTMLIFrameElement {
  document.body.innerHTML =
    '<div id="file-preview">' +
    '<iframe id="html-file-frame" class="html-frame" sandbox="allow-scripts"></iframe>' +
    '</div>';
  return document.querySelector('#html-file-frame')!;
}

/**
 * Post a broker message AS the sandboxed frame. Built by hand so `source` is the
 * frame's own window object — the unforgeable handle the broker gates on.
 */
function postFromFrame(frame: HTMLIFrameElement, data: unknown): void {
  const ev = new Event('message') as Event & { data: unknown; source: unknown };
  Object.defineProperty(ev, 'data', { value: data });
  Object.defineProperty(ev, 'source', { value: frame.contentWindow });
  window.dispatchEvent(ev);
}

function showSourceMessage(table: unknown, rowId?: unknown): unknown {
  return { __lattice: true, op: 'act', name: 'showSource', table, rowId };
}

describe('dashboard → data-source click-through (broker action, jsdom)', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetched = [];
    toasts = [];
    loadClient();
    (globalThis as unknown as Win).state = {
      entities: { tables: [{ name: 'orders' }, { name: 'people' }] },
    };
    window.location.hash = '#/w/dash/orders-overview';
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  // ── The security boundary ───────────────────────────────────────────────
  // The frame is untrusted. A table name arriving over the broker is INPUT, not
  // authority: the host must resolve it against the workspace's own table list
  // and refuse everything else — safely, but never silently.
  describe('parent-side validation (the frame can never widen what the host opens)', () => {
    it('REJECTS a table the workspace does not have — no fetch, no panel, and it is logged', () => {
      const frame = mountDashboardPage();
      expect(() => {
        postFromFrame(frame, showSourceMessage('not_a_table'));
      }).not.toThrow();
      expect(fetched).toEqual([]);
      const host = document.querySelector('#dash-source')!;
      expect(host.hidden).toBe(true);
      expect(host.innerHTML).toBe('');
      expect(warn).toHaveBeenCalled();
      // Never silent: the user who clicked is told the click went nowhere.
      expect(toasts.length).toBe(1);
    });

    it('REJECTS names that are not plain identifiers (path, quote, statement, whitespace)', () => {
      const frame = mountDashboardPage();
      const hostile = [
        'orders; DROP TABLE orders',
        "orders' OR '1'='1",
        '../secrets',
        'public.orders',
        'orders ',
        ' orders',
        '',
        '   ',
        'orders--',
        'orders/../people',
      ];
      for (const name of hostile) {
        expect(() => {
          postFromFrame(frame, showSourceMessage(name));
        }).not.toThrow();
      }
      expect(fetched).toEqual([]);
      expect(document.querySelector('#dash-source')!.hidden).toBe(true);
      expect(warn).toHaveBeenCalledTimes(hostile.length);
    });

    it('REJECTS a non-string table (number, object, array, null, missing)', () => {
      const frame = mountDashboardPage();
      const values: unknown[] = [1, { name: 'orders' }, ['orders'], null, undefined, true];
      for (const v of values) {
        expect(() => {
          postFromFrame(frame, showSourceMessage(v));
        }).not.toThrow();
      }
      expect(fetched).toEqual([]);
      expect(document.querySelector('#dash-source')!.hidden).toBe(true);
    });

    it('REJECTS credential / conversation tables even if they appear in the table list', () => {
      const frame = mountDashboardPage();
      (globalThis as unknown as Win).state = {
        entities: {
          tables: [
            { name: 'orders' },
            { name: 'secrets' },
            { name: 'chat_threads' },
            { name: 'chat_messages' },
          ],
        },
      };
      for (const name of ['secrets', 'chat_threads', 'chat_messages']) {
        postFromFrame(frame, showSourceMessage(name));
      }
      expect(fetched).toEqual([]);
      expect(document.querySelector('#dash-source')!.hidden).toBe(true);
    });

    it('REJECTS a prototype-chain name (__proto__ / constructor) rather than resolving it', () => {
      const frame = mountDashboardPage();
      for (const name of ['__proto__', 'constructor', 'hasOwnProperty', 'toString']) {
        expect(() => {
          postFromFrame(frame, showSourceMessage(name));
        }).not.toThrow();
      }
      expect(fetched).toEqual([]);
    });

    it('REJECTS everything when the workspace table list has not loaded yet', () => {
      const frame = mountDashboardPage();
      (globalThis as unknown as Win).state = {};
      expect(() => {
        postFromFrame(frame, showSourceMessage('orders'));
      }).not.toThrow();
      expect(fetched).toEqual([]);
    });

    it('ignores a showSource message that is not from a live sandboxed page frame', () => {
      mountDashboardPage();
      const ev = new Event('message') as Event & { data: unknown; source: unknown };
      Object.defineProperty(ev, 'data', { value: showSourceMessage('orders') });
      Object.defineProperty(ev, 'source', { value: window });
      window.dispatchEvent(ev);
      expect(fetched).toEqual([]);
      expect(document.querySelector('#dash-source')!.hidden).toBe(true);
    });
  });

  // ── The feature ─────────────────────────────────────────────────────────
  describe('opening the provenance panel in place', () => {
    it('a chart carrying a table binding opens the provenance panel — table-level', async () => {
      const frame = mountDashboardPage();
      postFromFrame(frame, showSourceMessage('orders'));
      await flush();
      const host = document.querySelector('#dash-source')!;
      expect(host.hidden).toBe(false);
      expect(fetched).toEqual(['/api/provenance?table=orders']);
      // The SAME provenance rendering the record page uses.
      expect(host.innerHTML).toContain('pv-table');
      expect(host.innerHTML).toContain('Orders export');
      expect(host.innerHTML).toContain('pvchip-raw');
    });

    it('keeps the dashboard on screen — opens IN PLACE, never navigates away', async () => {
      const frame = mountDashboardPage();
      postFromFrame(frame, showSourceMessage('orders'));
      await flush();
      // The canvas is still mounted and the route is untouched.
      expect(document.querySelector('#dash-frame')).toBeTruthy();
      expect(document.querySelector('.dash-title')).toBeTruthy();
      expect(window.location.hash).toBe('#/w/dash/orders-overview');
      // The navigate case is an explicit link inside the panel, not a side effect.
      const link = document.querySelector('#dash-source a')!;
      expect(link).toBeTruthy();
      expect(link.textContent).toContain('View table');
      expect(link.getAttribute('href')).toBe('#/w/table/orders');
    });

    it('a mark carrying a row id resolves ROW-level provenance', async () => {
      const frame = mountDashboardPage();
      postFromFrame(frame, showSourceMessage('orders', 'ord-42'));
      await flush();
      expect(fetched).toEqual(['/api/provenance/row?table=orders&id=ord-42']);
      const host = document.querySelector('#dash-source')!;
      expect(host.hidden).toBe(false);
      expect(host.innerHTML).toContain('ord-42');
      // Both ways out: the table, and the one record the mark resolved to.
      const hrefs = [...host.querySelectorAll('a')].map((a) => a.getAttribute('href'));
      expect(hrefs).toContain('#/w/table/orders');
      expect(hrefs).toContain('#/w/table/orders/ord-42');
    });

    it('a mark WITHOUT a row id falls back to table-level provenance', async () => {
      const frame = mountDashboardPage();
      // The delegated binder sends an empty string when no mark carried a row id.
      postFromFrame(frame, showSourceMessage('orders', ''));
      await flush();
      expect(fetched).toEqual(['/api/provenance?table=orders']);
      postFromFrame(frame, showSourceMessage('people', null));
      await flush();
      expect(fetched[1]).toBe('/api/provenance?table=people');
    });

    it('percent-encodes the row id (an id is data, never part of the URL grammar)', async () => {
      const frame = mountDashboardPage();
      postFromFrame(frame, showSourceMessage('orders', 'a b&c=d'));
      await flush();
      expect(fetched).toEqual(['/api/provenance/row?table=orders&id=a%20b%26c%3Dd']);
    });

    it('surfaces a failed provenance read instead of leaving an empty panel', async () => {
      const frame = mountDashboardPage();
      (globalThis as unknown as Win).fetchJson = () => Promise.reject(new Error('boom'));
      postFromFrame(frame, showSourceMessage('orders'));
      await flush();
      const host = document.querySelector('#dash-source')!;
      expect(host.hidden).toBe(false);
      expect(host.textContent).toContain('boom');
    });

    it('closes back to the dashboard without navigating', async () => {
      const frame = mountDashboardPage();
      postFromFrame(frame, showSourceMessage('orders'));
      await flush();
      const host = document.querySelector('#dash-source')!;
      host.querySelector('.prov-source-close')!.click();
      expect(host.hidden).toBe(true);
      expect(host.innerHTML).toBe('');
      expect(document.querySelector('#dash-frame')).toBeTruthy();
    });

    it('opens next to the posting frame when the surface has no pre-placed slot', async () => {
      const frame = mountFilePreview();
      postFromFrame(frame, showSourceMessage('orders'));
      await flush();
      // Never a silent no-op: a panel is created as the frame's next sibling.
      const host = document.querySelector('#file-preview .dash-source')!;
      expect(host).toBeTruthy();
      expect(host.previousElementSibling).toBe(frame);
      expect(host.innerHTML).toContain('pv-table');
    });
  });

  // ── The frame-side half of the contract ─────────────────────────────────
  describe('injected bridge (the only thing an authored page has to do)', () => {
    it('exposes lattice.showSource(table, rowId) over the broker, not a direct call', () => {
      expect(appJs).toContain('showSource:function(t,id)');
      expect(appJs).toContain('name:"showSource"');
    });

    it('auto-binds clicks from data-lattice-table / data-lattice-row-id markup', () => {
      expect(appJs).toContain('data-lattice-table');
      expect(appJs).toContain('data-lattice-row-id');
    });

    // The bridge is one hand-concatenated string injected into the frame's head, so
    // run it: a syntax slip would otherwise ship as a page that silently does nothing.
    // `window` is shadowed by a stand-in whose parent captures what the frame posts.
    it('RUNS: a click inside a table-bound element posts a showSource message', () => {
      const posted: Record<string, unknown>[] = [];
      const fakeWindow: Record<string, unknown> = {
        addEventListener: () => undefined,
        parent: {
          postMessage: (m: Record<string, unknown>) => {
            posted.push(m);
          },
        },
      };
      const bridge = (globalThis as unknown as Win).__LATTICE_DATA_BRIDGE as string;
      document.body.innerHTML =
        '<div data-lattice-table="orders">' +
        '<canvas id="chart"></canvas>' +
        '<button id="sort">Sort</button>' +
        '<table><tbody>' +
        '<tr data-lattice-row-id="ord-7"><td id="cell">7</td></tr>' +
        '</tbody></table>' +
        '</div>' +
        '<p id="loose">not bound</p>';
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      new Function('window', 'document', bridge)(fakeWindow, document);

      // A chart mark that aggregates many rows → table-scoped.
      document.querySelector<HTMLElement>('#chart')!.click();
      expect(posted).toEqual([
        { __lattice: true, op: 'act', name: 'showSource', table: 'orders', rowId: '' },
      ]);

      // A mark that IS one record → row-scoped, from the nearest row id on the way up.
      posted.length = 0;
      document.querySelector<HTMLElement>('#cell')!.click();
      expect(posted).toEqual([
        { __lattice: true, op: 'act', name: 'showSource', table: 'orders', rowId: 'ord-7' },
      ]);

      // The page's own controls keep working — a sort button inside a bound
      // section must not be hijacked into opening the source panel.
      posted.length = 0;
      document.querySelector<HTMLElement>('#sort')!.click();
      expect(posted).toEqual([]);

      // Unbound markup asks for nothing at all.
      posted.length = 0;
      document.querySelector<HTMLElement>('#loose')!.click();
      expect(posted).toEqual([]);
    });

    it('keeps the broker action list narrow — showSource dispatches on a fixed name', () => {
      const start = appJs.indexOf('function __latticeDashboardAction(');
      const end = appJs.indexOf('var __latticeHtmlBrokerInstalled');
      const body = appJs.slice(start, end);
      // Dispatch is on fixed string literals only — never on something derived from
      // the message, which is what would turn the frame into the one choosing.
      const names = [...body.matchAll(/name === '([a-zA-Z-]+)'/g)].map((m) => m[1]);
      expect(names).toContain('showSource');
      // Every branch is one of the known intents (navigation, plus the validated
      // source panel). A name outside this vocabulary means the boundary widened.
      // 'open-record' is the citation click-through action (navigation-only, routed
      // through openSearchHit / the side-by-side record panel) added with the clickable
      // dashboard citations — still a fixed literal, still not derived from the frame.
      const known = ['analytics', 'ask', 'configure', 'add-file', 'showSource', 'open-record'];
      expect(names.filter((n) => !known.includes(n))).toEqual([]);
      // The action path still runs no data read of its own — showSource goes
      // through the validated panel, never the frame's data bridge.
      expect(body).not.toContain('__lreq');
    });

    it('emits ES5-only client code for the new bridge surface (no arrows, no let/const)', () => {
      const start = appJs.indexOf('showSource:function(t,id)');
      const seg = appJs.slice(start, start + 900);
      expect(seg).not.toContain('=>');
      expect(seg).not.toMatch(/\b(const|let)\s/);
    });
  });

  describe('dashboard page markup', () => {
    it('reserves the in-place source slot next to the canvas', () => {
      expect(analyticsViewJs).toContain('id="dash-source"');
      // Below the frame, so opening it never covers the dashboard.
      expect(analyticsViewJs.indexOf('id="dash-frame"')).toBeLessThan(
        analyticsViewJs.indexOf('id="dash-source"'),
      );
    });
  });
});

describe('HTML authoring emits the data-source binding it already knows', () => {
  function fakeClient(capture: (p: TurnParams) => void): LlmClient {
    return {
      runTurn(params: TurnParams) {
        capture(params);
        params.onText('<!doctype html><html><body>x</body></html>');
        return Promise.resolve({ stopReason: 'end_turn', text: '', toolUses: [] });
      },
    };
  }

  it('instructs the model to mark charts with their source table (and row id per mark)', async () => {
    let seen: TurnParams | undefined;
    await generateHtmlFile({
      client: fakeClient((p) => {
        seen = p;
      }),
      schema: 'orders(id, total)',
      spec: 'chart orders by month',
    });
    const sys = seen?.system ?? '';
    expect(sys).toContain('data-lattice-table');
    expect(sys).toContain('data-lattice-row-id');
    expect(sys).toContain('lattice.showSource');
  });
});
