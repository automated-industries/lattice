import { test, expect } from '@playwright/test';
import { bootGui, createRow, type BootedGui } from './helpers.js';

/**
 * Brain-graph LAYOUT regression — measured against real rendered geometry, not
 * code presence. Unit tests run in jsdom (no layout engine), so they can never
 * catch the three bugs that kept shipping:
 *
 *   1. Labels overlapping  — physics collision sized to the dot (~33px) while
 *      labels render ~150-220px wide, so neighbouring labels collide.
 *   2. Oversized label font — labels much larger than the app's ~13px UI text.
 *   3. Corner load          — the node cluster framed against the wrong box,
 *      landing in the top-left instead of centred.
 *
 * This spec seeds a faithful multi-table schema (long names + FK edges, like a
 * real workspace) and asserts the rendered SVG geometry. It must FAIL on the
 * buggy build and pass once the layout is actually fixed.
 */

// Seven long-named, FK-connected entities — mirrors the density that triggers
// the overlap (an insurance data model, same shape as the reported screenshot).
const YAML = [
  'db: ./data/app.db',
  'name: graph-layout-e2e',
  '',
  'entities:',
  '  states:',
  '    fields:',
  '      id: { type: uuid, primaryKey: true }',
  '      name: { type: text }',
  '      deleted_at: { type: text }',
  '    outputFile: states.md',
  '  insurance_policies:',
  '    fields:',
  '      id: { type: uuid, primaryKey: true }',
  '      name: { type: text }',
  '      state_id: { type: text }',
  '      deleted_at: { type: text }',
  '    relations:',
  '      state: { type: belongsTo, table: states, foreignKey: state_id }',
  '    outputFile: insurance_policies.md',
  '  flood_insurance_policies:',
  '    fields:',
  '      id: { type: uuid, primaryKey: true }',
  '      name: { type: text }',
  '      policy_id: { type: text }',
  '      deleted_at: { type: text }',
  '    relations:',
  '      policy: { type: belongsTo, table: insurance_policies, foreignKey: policy_id }',
  '    outputFile: flood_insurance_policies.md',
  '  insured_properties:',
  '    fields:',
  '      id: { type: uuid, primaryKey: true }',
  '      name: { type: text }',
  '      state_id: { type: text }',
  '      deleted_at: { type: text }',
  '    relations:',
  '      state: { type: belongsTo, table: states, foreignKey: state_id }',
  '    outputFile: insured_properties.md',
  '  condominium_associations:',
  '    fields:',
  '      id: { type: uuid, primaryKey: true }',
  '      name: { type: text }',
  '      property_id: { type: text }',
  '      deleted_at: { type: text }',
  '    relations:',
  '      property: { type: belongsTo, table: insured_properties, foreignKey: property_id }',
  '    outputFile: condominium_associations.md',
  '  certificate_holders:',
  '    fields:',
  '      id: { type: uuid, primaryKey: true }',
  '      name: { type: text }',
  '      policy_id: { type: text }',
  '      deleted_at: { type: text }',
  '    relations:',
  '      policy: { type: belongsTo, table: insurance_policies, foreignKey: policy_id }',
  '    outputFile: certificate_holders.md',
  '  notes:',
  '    fields:',
  '      id: { type: uuid, primaryKey: true }',
  '      name: { type: text }',
  '      property_id: { type: text }',
  '      deleted_at: { type: text }',
  '    relations:',
  '      property: { type: belongsTo, table: insured_properties, foreignKey: property_id }',
  '    outputFile: notes.md',
  '',
].join('\n');

const TABLES = [
  'states',
  'insurance_policies',
  'flood_insurance_policies',
  'insured_properties',
  'condominium_associations',
  'certificate_holders',
  'notes',
];

let gui: BootedGui;
test.beforeEach(async () => {
  gui = await bootGui({ yaml: YAML });
  // One row per table so each appears as a schema-graph node (rowCount > 0).
  for (const t of TABLES) await createRow(gui.url, t, { name: t.replace(/_/g, ' ') });
});
test.afterEach(async () => {
  await gui.close();
});

/** Read the rendered geometry of every node label + the cluster, in screen px. */
async function measure(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const mount = document.getElementById('graph-mount')!;
    const pane = mount.getBoundingClientRect();
    const labelEls = Array.from(mount.querySelectorAll('.gnode-label'));
    const labels = labelEls.map((el) => {
      const r = el.getBoundingClientRect();
      const fs = parseFloat(getComputedStyle(el as HTMLElement).fontSize) || 0;
      return {
        text: (el.textContent || '').trim(),
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
        computedFontPx: fs,
      };
    });
    const nodeEls = Array.from(mount.querySelectorAll('g.gnode'));
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const el of nodeEls) {
      const r = el.getBoundingClientRect();
      minX = Math.min(minX, r.left);
      minY = Math.min(minY, r.top);
      maxX = Math.max(maxX, r.right);
      maxY = Math.max(maxY, r.bottom);
    }
    return {
      pane: { left: pane.left, top: pane.top, width: pane.width, height: pane.height },
      labels,
      cluster: { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 },
      nodeCount: nodeEls.length,
    };
  });
}

/** Overlap area (px²) of two axis-aligned label rects. */
function overlapArea(a: { left: number; top: number; right: number; bottom: number }, b: typeof a) {
  const ix = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const iy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return ix * iy;
}

test('schema graph: labels do not overlap, font ~app size, cluster centred', async ({ page }) => {
  // Deterministic layout: reduced-motion settles the sim synchronously then fits
  // once (the same forces as the animated path — same overlap, no flake).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(gui.url + '#/graph');

  // All seven tables render as nodes, and the stage is revealed (post-fit).
  await expect(page.locator('#graph-mount g.gnode')).toHaveCount(TABLES.length, { timeout: 8000 });
  await expect(page.locator('#graph-mount .dm-stage')).toBeVisible();
  // Let the synchronous settle + fit + a paint flush land.
  await page.waitForTimeout(400);

  const m = await measure(page);

  console.log(
    'GRAPH-LAYOUT measured:',
    JSON.stringify(
      {
        pane: m.pane,
        nodeCount: m.nodeCount,
        labelFontPx: m.labels.map((l) => Math.round(l.computedFontPx)),
        labelRenderedH: m.labels.map((l) => Math.round(l.height)),
        labelW: m.labels.map((l) => Math.round(l.width)),
      },
      null,
      0,
    ),
  );

  expect(m.labels.length).toBe(TABLES.length);

  // ── 1. FONT: rendered label height ≈ app UI text (13px → ~10-20px box). A
  //    regressed counter-scale balloons this to 25px+.
  for (const l of m.labels) {
    expect(l.height, `label "${l.text}" rendered height (px)`).toBeLessThan(22);
    expect(l.height, `label "${l.text}" rendered height (px)`).toBeGreaterThan(6);
  }

  // ── 2. OVERLAP: no two labels may meaningfully overlap. The buggy build
  //    collides on the dot radius (~33px) while labels are 150-220px wide.
  const overlaps: string[] = [];
  for (let i = 0; i < m.labels.length; i++) {
    for (let j = i + 1; j < m.labels.length; j++) {
      const a = m.labels[i]!;
      const b = m.labels[j]!;
      const area = overlapArea(a, b);
      // Tolerate a few px² of anti-aliased touching; flag real overlap.
      const minArea = Math.min(a.width * a.height, b.width * b.height);
      if (area > Math.max(12, minArea * 0.06)) {
        overlaps.push(`"${a.text}" ∩ "${b.text}" = ${Math.round(area)}px²`);
      }
    }
  }
  expect(overlaps, `overlapping label pairs:\n  ${overlaps.join('\n  ')}`).toHaveLength(0);

  // ── 3. CENTRED: the node cluster's centre sits near the pane centre, not in a
  //    corner. Allow 30% of each pane dimension of drift.
  const paneCx = m.pane.left + m.pane.width / 2;
  const paneCy = m.pane.top + m.pane.height / 2;
  expect(
    Math.abs(m.cluster.cx - paneCx),
    'cluster horizontal offset from pane centre',
  ).toBeLessThan(m.pane.width * 0.3);
  expect(Math.abs(m.cluster.cy - paneCy), 'cluster vertical offset from pane centre').toBeLessThan(
    m.pane.height * 0.3,
  );
});

test('schema graph: first reveal is already centred (no corner / double-load flash)', async ({
  page,
}) => {
  // ANIMATED path (no reduced-motion) — this is where the "loads in the corner,
  // then jumps to centre" flash lived: a fit fired on the half-settled cluster
  // (nodes at the spawn origin, stage at scale 1 = top-left) and revealed it
  // before the settle re-centred. Capture the cluster centroid at the EXACT
  // frame the stage is first made visible, and assert it is already centred.
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__firstReveal = null;
    const tick = () => {
      const mount = document.getElementById('graph-mount');
      const stage = mount ? mount.querySelector('.dm-stage') : null;
      const nodes = mount ? Array.from(mount.querySelectorAll('g.gnode')) : [];
      if (
        stage &&
        getComputedStyle(stage).visibility === 'visible' &&
        nodes.length &&
        !w.__firstReveal
      ) {
        const pane = mount!.getBoundingClientRect();
        let minX = Infinity,
          minY = Infinity,
          maxX = -Infinity,
          maxY = -Infinity;
        for (const el of nodes) {
          const r = (el as HTMLElement).getBoundingClientRect();
          minX = Math.min(minX, r.left);
          minY = Math.min(minY, r.top);
          maxX = Math.max(maxX, r.right);
          maxY = Math.max(maxY, r.bottom);
        }
        w.__firstReveal = {
          cx: (minX + maxX) / 2,
          cy: (minY + maxY) / 2,
          paneCx: pane.left + pane.width / 2,
          paneCy: pane.top + pane.height / 2,
          paneW: pane.width,
          paneH: pane.height,
        };
        return; // captured the first-reveal frame
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await page.goto(gui.url + '#/graph');
  await expect(page.locator('#graph-mount g.gnode')).toHaveCount(TABLES.length, { timeout: 8000 });

  const reveal = await page.waitForFunction(
    () => (window as unknown as Record<string, unknown>).__firstReveal,
    { timeout: 8000 },
  );
  const r = (await reveal.jsonValue()) as {
    cx: number;
    cy: number;
    paneCx: number;
    paneCy: number;
    paneW: number;
    paneH: number;
  };

  console.log('FIRST-REVEAL:', JSON.stringify(r));

  // At first reveal the cluster must already be near the pane centre — never in a
  // corner. (The bug revealed it ~the top-left, offset by well over half the pane.)
  expect(Math.abs(r.cx - r.paneCx), 'first-reveal horizontal offset from pane centre').toBeLessThan(
    r.paneW * 0.3,
  );
  expect(Math.abs(r.cy - r.paneCy), 'first-reveal vertical offset from pane centre').toBeLessThan(
    r.paneH * 0.3,
  );
});
