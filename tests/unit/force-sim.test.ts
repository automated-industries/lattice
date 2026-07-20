import { describe, it, expect } from 'vitest';
import { ForceSim, type SimNode, type SimLink } from '../../src/gui/app/graph/force-sim';

/**
 * Numeric parity tests for the dependency-free force simulation.
 *
 * Each test isolates ONE force (others disabled) and asserts the physically
 * unambiguous outcome — a spring relaxes toward its rest length, repulsion
 * pushes coincident bodies apart, collision stops disks overlapping, centering
 * pulls toward a point, alpha cools to settled, pins hold, and degree bias makes
 * the heavier-degree endpoint move less. This is the "it actually behaves like a
 * force-directed layout" proof, with no DOM and no animation frame.
 */

function node(id: string, x: number, y: number, extra: Partial<SimNode> = {}): SimNode {
  return { id, x, y, vx: 0, vy: 0, ...extra };
}

function dist(a: SimNode, b: SimNode): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

describe('ForceSim — link spring', () => {
  it('relaxes a stretched link toward its rest length', () => {
    const a = node('a', -150, 0);
    const b = node('b', 150, 0); // 300 apart
    const sim = new ForceSim({
      chargeStrength: () => 0,
      linkDistance: () => 100,
      linkStrength: () => 1,
    });
    sim.setNodes([a, b]).setLinks([{ source: 'a', target: 'b' }] as SimLink[]);
    sim.tick(600);
    // Pulled in from 300 to ~100 (cooling stops it a little short of exact).
    expect(dist(a, b)).toBeGreaterThan(85);
    expect(dist(a, b)).toBeLessThan(135);
  });

  it('pushes a compressed link back out toward its rest length', () => {
    const a = node('a', -10, 0);
    const b = node('b', 10, 0); // 20 apart, rest 100
    const sim = new ForceSim({
      chargeStrength: () => 0,
      linkDistance: () => 100,
      linkStrength: () => 1,
    });
    sim.setNodes([a, b]).setLinks([{ source: 'a', target: 'b' }] as SimLink[]);
    sim.tick(600);
    expect(dist(a, b)).toBeGreaterThan(70);
  });
});

describe('ForceSim — many-body charge', () => {
  it('repels two near-coincident nodes apart', () => {
    const a = node('a', -5, 0);
    const b = node('b', 5, 0); // 10 apart
    const before = dist(a, b);
    const sim = new ForceSim({ chargeStrength: () => -200 });
    sim.setNodes([a, b]);
    sim.tick(300);
    expect(dist(a, b)).toBeGreaterThan(before * 2);
  });

  it('barely moves a distant pair (force falls off with 1/d²)', () => {
    const a = node('a', -500, 0);
    const b = node('b', 500, 0); // 1000 apart
    const before = dist(a, b);
    const sim = new ForceSim({ chargeStrength: () => -200 });
    sim.setNodes([a, b]);
    sim.tick(300);
    const moved = dist(a, b) - before;
    expect(moved).toBeGreaterThanOrEqual(0); // still repelling, never attracting
    expect(moved).toBeLessThan(before * 0.05); // negligible relative to separation
  });
});

describe('ForceSim — collision', () => {
  it('separates overlapping disks to ~sum of radii', () => {
    const a = node('a', -5, 0, { radius: 20 });
    const b = node('b', 5, 0, { radius: 20 }); // overlapping; sum of radii = 40
    const sim = new ForceSim({
      chargeStrength: () => 0,
      collideRadius: (n) => n.radius ?? 0,
    });
    sim.setNodes([a, b]);
    sim.tick(200);
    // Overlap is fully resolved: final distance ≥ sum of radii (40). With no
    // restoring force (charge/link/centering all off) the disks pop apart and
    // coast a little past touching before velocity decays — that overshoot is
    // expected; in the real graph the other forces bound it. The invariant under
    // test is simply "no overlap remains".
    expect(dist(a, b)).toBeGreaterThanOrEqual(39);
    expect(dist(a, b)).toBeLessThan(80);
  });
});

describe('ForceSim — centering', () => {
  it('pulls a lone off-center node toward the center point', () => {
    const a = node('a', 500, 500);
    const origin = { x: 0, y: 0 };
    const before = Math.hypot(a.x - origin.x, a.y - origin.y);
    const sim = new ForceSim({
      chargeStrength: () => 0,
      center: { x: 0, y: 0, strength: 0.1 },
    });
    sim.setNodes([a]);
    sim.tick(400);
    const after = Math.hypot(a.x - origin.x, a.y - origin.y);
    expect(after).toBeLessThan(before * 0.6);
  });
});

describe('ForceSim — cooling', () => {
  it('decays alpha monotonically and settles', () => {
    const sim = new ForceSim();
    sim.setNodes([node('a', 0, 0)]);
    expect(sim.alpha).toBe(1);
    sim.tick();
    const afterOne = sim.alpha;
    expect(afterOne).toBeLessThan(1);
    expect(afterOne).toBeCloseTo(0.9772, 3); // 1 + (0 - 1) * 0.0228
    sim.tick(400);
    expect(sim.settled).toBe(true);
  });

  it('stays warm while alphaTarget > 0 (a held drag), then cools when released', () => {
    const sim = new ForceSim({ alphaTarget: 0.3 });
    sim.setNodes([node('a', 0, 0)]);
    sim.tick(500);
    expect(sim.settled).toBe(false);
    expect(sim.alpha).toBeCloseTo(0.3, 2);
    sim.setAlphaTarget(0);
    sim.tick(500);
    expect(sim.settled).toBe(true);
  });
});

describe('ForceSim — pinning', () => {
  it('holds a pinned node exactly at fx/fy despite strong repulsion', () => {
    const pinned = node('p', 0, 0, { fx: 0, fy: 0 });
    const free = node('f', 1, 0);
    const sim = new ForceSim({ chargeStrength: () => -500 });
    sim.setNodes([pinned, free]);
    sim.tick(50);
    expect(pinned.x).toBe(0);
    expect(pinned.y).toBe(0);
    expect(Math.abs(free.x)).toBeGreaterThan(1); // the free one was shoved away
  });
});

describe('ForceSim — degree bias', () => {
  it('moves the heavier-degree endpoint less under spring correction', () => {
    // A has degree 2 (links to B and C); B has degree 1. C sits exactly at rest
    // length from A so the A–C spring contributes nothing, isolating A–B.
    const a = node('a', 0, 0);
    const b = node('b', 300, 0); // stretched: rest is 100
    const c = node('c', 0, 100); // already at rest distance from A
    const ax0 = a.x;
    const bx0 = b.x;
    const sim = new ForceSim({
      chargeStrength: () => 0,
      linkDistance: () => 100,
      linkStrength: () => 1,
    });
    sim.setNodes([a, b, c]).setLinks([
      { source: 'a', target: 'b' },
      { source: 'a', target: 'c' },
    ] as SimLink[]);
    sim.tick(1);
    const movedA = Math.abs(a.x - ax0);
    const movedB = Math.abs(b.x - bx0);
    // bias = deg(A)/(deg(A)+deg(B)) = 2/3 applied to target B → B moves ~2× A.
    expect(movedB).toBeGreaterThan(movedA);
  });
});

describe('ForceSim — default configuration', () => {
  it('runs with no accessors supplied (built-in defaults move the nodes)', () => {
    const a = node('a', 0, 0, { weight: 2, radius: 5 });
    const b = node('b', 1, 0, { weight: 2, radius: 5 });
    const sim = new ForceSim(); // every force uses its default
    sim.setNodes([a, b]).setLinks([{ source: 'a', target: 'b' }] as SimLink[]);
    sim.tick(100);
    // Default charge (-30·weight) repels; default collide (radius) separates.
    expect(dist(a, b)).toBeGreaterThan(1);
  });

  it('computes the default link strength from node degree', () => {
    // Triangle: every node has degree 2, so default strength = 1/min(2,2) = 0.5.
    const a = node('a', 0, 0);
    const b = node('b', 200, 0);
    const c = node('c', 100, 200);
    const sim = new ForceSim({ chargeStrength: () => 0, linkDistance: () => 60 });
    sim.setNodes([a, b, c]).setLinks([
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'a' },
    ] as SimLink[]);
    sim.tick(400);
    // All three edges relax toward ~60.
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      expect(dist(p, q)).toBeLessThan(110);
    }
  });
});

describe('ForceSim — link resolution', () => {
  it('accepts links given by node reference, not just id', () => {
    const a = node('a', -120, 0);
    const b = node('b', 120, 0);
    const sim = new ForceSim({
      chargeStrength: () => 0,
      linkDistance: () => 80,
      linkStrength: () => 1,
    });
    sim.setNodes([a, b]).setLinks([{ source: a, target: b }] as SimLink[]);
    sim.tick(500);
    expect(dist(a, b)).toBeLessThan(120);
  });

  it('drops links that reference an unknown node id', () => {
    const a = node('a', 0, 0);
    const sim = new ForceSim();
    sim.setNodes([a]).setLinks([{ source: 'a', target: 'ghost' }] as SimLink[]);
    // No throw; the dangling link is silently ignored and the lone node is intact.
    expect(() => sim.tick(10)).not.toThrow();
    expect(sim.getNodes()).toHaveLength(1);
  });
});

describe('ForceSim — control surface', () => {
  it('reheat() resets alpha so a cooled sim moves again', () => {
    const sim = new ForceSim({ chargeStrength: () => -100 });
    sim.setNodes([node('a', -3, 0), node('b', 3, 0)]);
    sim.tick(500);
    expect(sim.settled).toBe(true);
    sim.reheat(1, 0.3);
    expect(sim.alpha).toBe(1);
    expect(sim.settled).toBe(false);
  });

  it('getNodes() exposes the live node array', () => {
    const ns = [node('a', 0, 0), node('b', 10, 0)];
    const sim = new ForceSim();
    sim.setNodes(ns);
    expect(sim.getNodes()).toHaveLength(2);
    expect(sim.getNodes()[0].id).toBe('a');
  });
});

describe('ForceSim — coincident bodies', () => {
  it('separates two exactly-overlapping nodes without producing NaN', () => {
    const a = node('a', 0, 0);
    const b = node('b', 0, 0); // identical position → jiggle must break the tie
    const sim = new ForceSim({ chargeStrength: () => -100 });
    sim.setNodes([a, b]);
    sim.tick(50);
    expect(Number.isFinite(a.x)).toBe(true);
    expect(Number.isFinite(b.x)).toBe(true);
    expect(dist(a, b)).toBeGreaterThan(0); // no longer coincident
  });
});

describe('ForceSim — determinism', () => {
  it('produces identical layouts across runs (reproducible jiggle)', () => {
    const build = () => {
      const ns = [node('a', 10, 0), node('b', -10, 5), node('c', 0, -10)];
      const sim = new ForceSim({
        chargeStrength: () => -120,
        center: { x: 0, y: 0, strength: 0.05 },
        collideRadius: () => 6,
      });
      sim.setNodes(ns).setLinks([{ source: 'a', target: 'b' }] as SimLink[]);
      sim.tick(250);
      return ns.map((n) => ({ x: n.x, y: n.y }));
    };
    expect(build()).toEqual(build());
  });
});
