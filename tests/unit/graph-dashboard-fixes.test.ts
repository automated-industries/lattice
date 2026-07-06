import { describe, it, expect } from 'vitest';
import { appJs } from '../../src/gui/app/script.js';

/**
 * Regression guards for the graph + dashboard runtime bugs found in the 5.0
 * adversarial review. These live in template-literal client modules, so they are
 * pinned by asserting on the composed client bundle (the repo's idiom for
 * client-JS behavior it can't unit-execute).
 */

describe('sql-driven dashboards are not rejected as "forbidden table"', () => {
  it('handles the table-less sql (and search) ops BEFORE the empty-table guard', () => {
    const src = appJs;
    const guard = "if (!table || table.charAt(0) === '_' || DENY[table])";
    const sqlOp = "if (op === 'sql')";
    const searchOp = "if (op === 'search')";
    // Both table-less ops must be positioned before the empty-table guard, or
    // their (absent) table trips the guard → "forbidden table".
    expect(src.indexOf(searchOp)).toBeGreaterThan(-1);
    expect(src.indexOf(sqlOp)).toBeGreaterThan(-1);
    expect(src.indexOf(sqlOp)).toBeLessThan(src.indexOf(guard));
    expect(src.indexOf(searchOp)).toBeLessThan(src.indexOf(guard));
  });
});

describe('dashboards sidebar/home refresh live when a dashboard is created', () => {
  it('defines refreshDashboardsLive that busts the anDashRows cache', () => {
    expect(appJs).toContain('function refreshDashboardsLive()');
  });
  it('is hooked from BOTH the realtime-change and feed dispatch branches', () => {
    const hook = "data.table === 'dashboards' && typeof refreshDashboardsLive === 'function'";
    const count = appJs.split(hook).length - 1;
    expect(count).toBe(2);
  });
});

describe('dashboard opens on cloud/team workspaces (no appendChild-of-string throw)', () => {
  it('sets the visibility line via innerHTML, never appendChild of the HTML string', () => {
    // detailVisLineEl returns an HTML STRING; appendChild(string) threw a
    // TypeError whenever row._access was populated (cloud/team), which the outer
    // .catch swallowed by closing the tab and bouncing home.
    expect(appJs).toContain('slot.innerHTML = visHtml');
    expect(appJs).not.toContain('slot.appendChild(visEl)');
  });
});

describe('dashboard live-data search bridge hits the real endpoint', () => {
  it('search reads GET /api/search?q= (there is no POST /api/search)', () => {
    expect(appJs).toContain("'/api/search?q=' + encodeURIComponent");
    // The broker's search op must not POST to /api/search (the route is GET-only,
    // so a POST 404'd and search-driven dashboard sections rendered empty).
    expect(appJs).not.toContain("fetch('/api/search', {");
  });
});

describe('live ingest animation is scoped to the top-level schema graph', () => {
  it('gates on the exact #/graph hash so a drill-down graph is never clobbered', () => {
    expect(appJs).toContain('function graphIngestAnimApplies()');
    expect(appJs).toContain("location.hash === '#/graph'");
    // Both the scheduler and the fired handler must consult the gate.
    expect(appJs).toContain('if (!graphIngestAnimApplies()) return;');
  });

  it('cancels an in-flight opening wave-reveal before painting the full ingest set', () => {
    // Otherwise a stale later reveal wave removes a node ingested mid-reveal.
    expect(appJs).toContain("if (typeof graphRevealGen !== 'undefined') graphRevealGen++;");
  });
});
