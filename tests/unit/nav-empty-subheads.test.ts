// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { navSectionsJs } from '../../src/gui/app/modules/nav-sections.js';

/**
 * The DATA sidebar's three fixed subheads — TABLES / CONNECTORS / DATABASES —
 * render even when their buckets are empty. A fresh workspace used to collapse
 * the whole section to a bare "No tables yet." line; the decided behavior is
 * that every empty bucket keeps its subhead group and shows an empty state plus
 * an add affordance (files menu for TABLES, the matching Configure tab for
 * CONNECTORS / DATABASES). Executed in jsdom with stubbed sidebar helpers;
 * asserts the real rendered DOM + wiring.
 */

type AnyFn = (...args: unknown[]) => unknown;

interface NavTable {
  name: string;
  schemaKey?: string;
  schemaLabel?: string;
  rowCount?: number | null;
  linkTable?: boolean;
  sqlDenied?: boolean;
  navHidden?: boolean;
}

interface Recorder {
  collapsedCalls: [string, boolean][];
  applyCalls: string[];
  configureCalls: string[];
  toggleCalls: string[];
  addFilesClicks: number;
}

function loadModule(tables: NavTable[], opts?: { navFilesCollapsed?: boolean }): Recorder {
  const rec: Recorder = {
    collapsedCalls: [],
    applyCalls: [],
    configureCalls: [],
    toggleCalls: [],
    addFilesClicks: 0,
  };
  const w = globalThis as unknown as Record<string, unknown>;
  w.state = { entities: { tables } };
  w.escapeHtml = (s: unknown): string =>
    String(s).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
    );
  w.displayFor = (name: string) => ({ icon: 'T', label: name });
  w.sidebarGroupKey = (k: string): string => 'test-sb:' + k;
  w.setSidebarGroupCollapsed = ((k: string, collapsed: boolean) => {
    rec.collapsedCalls.push([k, collapsed]);
  }) as AnyFn;
  w.applySidebarGroupState = ((k: string) => {
    rec.applyCalls.push(k);
  }) as AnyFn;
  w.wireSidebarGroupToggles = (() => undefined) as AnyFn;
  w.openConfigureDrawer = ((tab: string) => {
    rec.configureCalls.push(tab);
  }) as AnyFn;
  w.sidebarGroupCollapsed = ((k: string): boolean =>
    k === 'nav-files' ? (opts?.navFilesCollapsed ?? false) : false) as AnyFn;
  w.toggleSidebarGroup = ((k: string) => {
    rec.toggleCalls.push(k);
  }) as AnyFn;
  (0, eval)(navSectionsJs);
  const addFiles = document.getElementById('src-add-files');
  if (addFiles) addFiles.addEventListener('click', () => (rec.addFilesClicks += 1));
  return rec;
}

function render(): void {
  (globalThis as unknown as { renderNavTables: () => void }).renderNavTables();
}

function host(): HTMLElement {
  return document.getElementById('nav-tables-list')!;
}

beforeEach(() => {
  document.body.innerHTML =
    '<div id="nav-tables-list"></div><button id="src-add-files" type="button"></button>';
  window.localStorage.clear();
  location.hash = '';
});

describe('DATA nav — empty buckets keep their subheads (jsdom)', () => {
  it('a fresh workspace renders all three subheads, not a bare fallback line', () => {
    loadModule([]);
    render();
    const heads = Array.from(host().querySelectorAll('.nav-schema-head .nav-schema-label')).map(
      (el) => el.textContent,
    );
    expect(heads).toEqual(['TABLES', 'CONNECTORS', 'DATABASES']);
    // Group keys are stable: lattice keeps its historical key.
    const keys = Array.from(host().querySelectorAll('.nav-schema-head')).map((el) =>
      el.getAttribute('data-group'),
    );
    expect(keys).toEqual(['nav-schema-lattice', 'nav-schema-connectors', 'nav-schema-databases']);
    // Every group body carries an empty state + its add affordance…
    const bodies = Array.from(host().querySelectorAll('[data-group-body]'));
    expect(bodies).toHaveLength(3);
    for (const body of bodies) expect(body.querySelector('.nav-empty')).toBeTruthy();
    expect(host().querySelector('[data-nav-add="files"]')).toBeTruthy();
    expect(host().querySelector('[data-nav-add="connectors"]')).toBeTruthy();
    expect(host().querySelector('[data-nav-add="databases"]')).toBeTruthy();
    // …and the OLD behavior — a single loose empty line replacing the groups —
    // is gone: no .nav-empty sits directly under the host.
    expect(host().querySelectorAll(':scope > .nav-empty')).toHaveLength(0);
  });

  it('routes each add affordance to the right add surface, without navigating', () => {
    const rec = loadModule([], { navFilesCollapsed: true });
    render();
    host().querySelector<HTMLElement>('[data-nav-add="connectors"]')!.click();
    expect(rec.configureCalls).toEqual(['connectors']);
    host().querySelector<HTMLElement>('[data-nav-add="databases"]')!.click();
    expect(rec.configureCalls).toEqual(['connectors', 'databases']);
    // The files affordance expands the collapsed FILES section, then opens its
    // add menu in place — no Configure drawer involved.
    host().querySelector<HTMLElement>('[data-nav-add="files"]')!.click();
    expect(rec.toggleCalls).toEqual(['nav-files']);
    expect(rec.addFilesClicks).toBe(1);
    expect(rec.configureCalls).toEqual(['connectors', 'databases']);
    // Add affordances are not table items: nothing navigated.
    expect(location.hash).toBe('');
  });

  it('does not toggle the FILES section when it is already expanded', () => {
    const rec = loadModule([], { navFilesCollapsed: false });
    render();
    host().querySelector<HTMLElement>('[data-nav-add="files"]')!.click();
    expect(rec.toggleCalls).toEqual([]);
    expect(rec.addFilesClicks).toBe(1);
  });

  it('an empty bucket keeps its subhead + affordance when another bucket has tables', () => {
    loadModule([
      { name: 'teams', schemaKey: 'lattice' },
      { name: 'crm_deals', schemaKey: 'conn:hubspot', schemaLabel: 'HubSpot', rowCount: 3 },
    ]);
    render();
    const heads = Array.from(host().querySelectorAll('.nav-schema-head .nav-schema-label')).map(
      (el) => el.textContent,
    );
    expect(heads).toEqual(['TABLES', 'CONNECTORS', 'DATABASES']);
    // Populated buckets list their tables and drop the empty state…
    const latticeBody = host().querySelector('[data-group-body="nav-schema-lattice"]')!;
    expect(latticeBody.querySelector('.nav-table-item[data-table="teams"]')).toBeTruthy();
    expect(latticeBody.querySelector('.nav-empty')).toBeNull();
    const connBody = host().querySelector('[data-group-body="nav-schema-connectors"]')!;
    expect(connBody.querySelector('.nav-table-item[data-table="crm_deals"]')).toBeTruthy();
    expect(connBody.querySelector('.nav-empty')).toBeNull();
    // …while the still-empty DATABASES bucket keeps its empty state + affordance.
    const dbBody = host().querySelector('[data-group-body="nav-schema-databases"]')!;
    expect(dbBody.querySelector('.nav-empty')).toBeTruthy();
    expect(dbBody.querySelector('[data-nav-add="databases"]')).toBeTruthy();
    // Table items still navigate (the add-affordance wiring must not eat them).
    latticeBody.querySelector<HTMLElement>('.nav-table-item[data-table="teams"]')!.click();
    expect(location.hash).toBe('#/w/table/teams');
  });

  it('still seeds only CONNECTORS / DATABASES collapsed on first sight', () => {
    const rec = loadModule([]);
    render();
    expect(rec.collapsedCalls).toEqual([
      ['nav-schema-connectors', true],
      ['nav-schema-databases', true],
    ]);
    expect(rec.applyCalls).toEqual([
      'nav-schema-lattice',
      'nav-schema-connectors',
      'nav-schema-databases',
    ]);
  });
});
