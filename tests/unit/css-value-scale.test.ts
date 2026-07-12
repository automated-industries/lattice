import { describe, it, expect } from 'vitest';
import { css } from '../../src/gui/app/styles/index.js';

/**
 * Design-system drift guard. Spacing and font-size are deliberately literal values
 * (no build step means a var is as unenforceable as a literal) — this test IS the
 * enforcement: every literal must sit on the documented scale. Colors, radius,
 * z-index, motion, and fonts are tokens; new literals of those kinds belong in
 * styles/tokens.ts, not scattered in rule files.
 */
const SPACING = new Set([0, 1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 56]);
const TYPE = new Set([10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 28]);
// Emoji-glyph sizes (icon-scale text) are exempt from the type scale.
const TYPE_EXEMPT = (px: number): boolean => px >= 34 && px <= 46;

const body = css.replace(/\/\*[\s\S]*?\*\//g, '');

function values(prop: string): { value: string; px: number[] }[] {
  const re = new RegExp(`${prop}\\s*:\\s*([^;{}]+);`, 'g');
  const out: { value: string; px: number[] }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const v = (m[1] ?? '').trim();
    const px = [...v.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((n) => Math.abs(Number(n[1])));
    out.push({ value: v, px });
  }
  return out;
}

describe('css value scales', () => {
  it('padding/margin/gap literals sit on the spacing scale', () => {
    const offenders: string[] = [];
    for (const prop of [
      'padding',
      'margin',
      'gap',
      'padding-top',
      'padding-right',
      'padding-bottom',
      'padding-left',
      'margin-top',
      'margin-right',
      'margin-bottom',
      'margin-left',
      'row-gap',
      'column-gap',
    ]) {
      for (const { value, px } of values(prop)) {
        for (const n of px) {
          if (!SPACING.has(n)) offenders.push(`${prop}: ${value}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('font-size literals sit on the type scale (emoji glyphs exempt)', () => {
    const offenders: string[] = [];
    for (const { value, px } of values('font-size')) {
      for (const n of px) {
        if (!TYPE.has(n) && !TYPE_EXEMPT(n)) offenders.push(`font-size: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('z-index literals are intra-component (≤ 10) — tiers use var(--z-*)', () => {
    const offenders: string[] = [];
    for (const { value } of values('z-index')) {
      if (value.startsWith('var(--z-')) continue;
      const n = Number(value);
      if (!Number.isFinite(n) || n > 10) offenders.push(`z-index: ${value}`);
    }
    expect(offenders).toEqual([]);
  });

  it('border-radius uses the radius tokens (50% circles and sub-token 0/1/2/3px allowed)', () => {
    const offenders: string[] = [];
    for (const { value, px } of values('border-radius')) {
      if (value.includes('var(--r-')) continue;
      if (value === '50%') continue;
      for (const n of px) {
        if (n > 3) offenders.push(`border-radius: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
