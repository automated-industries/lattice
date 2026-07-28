import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { appJs } from '../../src/gui/app/script.js';
import { css } from '../../src/gui/app/css.js';

/**
 * 5.3 realtime-feedback unification — wiring guards. The goal is fewer disparate
 * feedback elements: the workspace switch reuses the boot loading figure (A2),
 * both create wizards share the onboarding phase-narrated create-progress (A3),
 * and build/load animations draw from one shared motion vocabulary (A5).
 */
describe('5.3 realtime-feedback unification', () => {
  describe('A2 — workspace switch reuses the boot loading figure', () => {
    it('the switch overlay renders the shared brand logo + boot spinner + a Switching label', () => {
      expect(appJs).toContain('BRAND_SVG +');
      expect(appJs).toContain('app-loading-spinner');
      expect(appJs).toContain('app-loading-text">Switching');
    });
    it('the switch overlay is sized like the boot figure', () => {
      expect(css).toContain('.ws-switch-overlay .brand-logo');
    });
  });

  describe('A3 — create wizard shares the onboarding create-progress', () => {
    it('has a phase status line and narrates the (previously silent) cloud migrate step', () => {
      expect(appJs).toContain('id="wiz-msg"');
      expect(appJs).toContain('function setWizMsg');
      expect(appJs).toContain('Migrating to cloud');
    });
    it('spins the Create button via the shared withBusy helper', () => {
      expect(appJs).toContain('withBusy(nextBtn, function ()');
    });
  });

  describe('A5 — one shared realtime-motion vocabulary', () => {
    it('defines the motion tokens', () => {
      expect(css).toContain('--dur-spin:');
      expect(css).toContain('--dur-reveal:');
      expect(css).toContain('--ease-reveal:');
    });
    it('defines the shared primitives', () => {
      expect(css).toContain('.lat-spinner');
      expect(css).toContain('.lat-skeleton');
      expect(css).toContain('.lat-pulse');
    });
    it('the boot spinner uses the shared duration token', () => {
      expect(css).toContain('animation: lattice-spin var(--dur-spin) linear infinite');
    });
  });

  // Adoption pass: the foundation above shipped in 5.3, but four surfaces kept
  // bespoke ring keyframes (each a byte-for-byte clone of lattice-spin) and two
  // spinners hardcoded their duration. Every ring now draws from the ONE shared
  // keyframe + the --dur-spin token; sizes and colors are unchanged per surface.
  describe('A5 adoption — bespoke ring keyframes retired', () => {
    it('the four bespoke ring keyframes are gone', () => {
      expect(css).not.toContain('@keyframes feedSpin');
      expect(css).not.toContain('@keyframes graphSpin');
      expect(css).not.toContain('@keyframes imp-spin-kf');
      expect(css).not.toContain('@keyframes cw-spin');
    });
    it('no rule references a retired keyframe name', () => {
      expect(css).not.toContain('feedSpin');
      expect(css).not.toContain('graphSpin');
      expect(css).not.toContain('imp-spin-kf');
      expect(css).not.toContain('cw-spin ');
    });
    it('every ring spin animation uses the shared keyframe + duration token (no hardcoded spin durations)', () => {
      // Any `... linear infinite` animation that is NOT the canonical shared
      // form is a bespoke ring that slipped back in.
      const spins = css.match(/animation:[^;]*linear infinite/g) ?? [];
      expect(spins.length).toBeGreaterThan(0);
      for (const spin of spins) {
        expect(spin).toBe('animation: lattice-spin var(--dur-spin) linear infinite');
      }
    });
    it('the shared lattice-spin keyframe remains the single ring source', () => {
      expect(css.match(/@keyframes lattice-spin /g)).toHaveLength(1);
    });
    it('the graph loading indicator adopts .lat-spinner (markup call sites)', () => {
      // Composed client modules render the graph loading placeholder directly.
      expect(appJs).toContain('lat-spinner graph-spinner');
      expect(appJs).not.toContain('"graph-spinner"');
    });
    it('the graph loading indicator adopts .lat-spinner (force-graph browser module)', () => {
      // force-graph is bundled out-of-band (dist/gui-assets/force-graph.mjs),
      // so pin its source rather than the inline appJs.
      const src = readFileSync(
        new URL('../../src/gui/app/graph/force-graph.ts', import.meta.url),
        'utf8',
      );
      expect(src).toContain("'lat-spinner graph-spinner'");
      expect(src).not.toContain("'graph-spinner'");
    });
    it('.graph-spinner keeps its size/color duty (visuals unchanged)', () => {
      expect(css).toContain('.graph-spinner');
      expect(css).toContain('width: 28px; height: 28px;');
      expect(css).toContain('border: 3px solid var(--border); border-top-color: var(--accent);');
    });
    it('the graph spinner still honors reduced motion', () => {
      expect(css).toContain(
        '@media (prefers-reduced-motion: reduce) { .graph-spinner { animation: none; } }',
      );
    });
  });
});
