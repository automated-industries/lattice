import { describe, it, expect } from 'vitest';
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
});
