// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createForceGraph, type GraphNode } from '../../src/gui/app/graph/force-graph.js';

/**
 * DOM smoke test for the live force-graph renderer, run in a jsdom window. The
 * physics is unit-tested separately (force-sim.test.ts); here we assert the
 * renderer builds the expected SVG, writes node positions on each step, routes a
 * node click, dims on highlight, marks selection, and tears down cleanly — the
 * DOM wiring that can't be checked at the engine level. (Full interaction is
 * additionally exercised by the Playwright e2e in a real browser.)
 */

type Mount = Parameters<typeof createForceGraph>[0];

function fire(el: Element, type: string): void {
  const e = new Event(type, { bubbles: true });
  Object.assign(e, { clientX: 5, clientY: 5, pointerId: 1 });
  el.dispatchEvent(e);
}

const NODES: GraphNode[] = [
  { id: 'a', label: 'Alpha', radius: 20, icon: '◆' },
  { id: 'b', label: 'Beta', radius: 12 },
  { id: 'c', label: 'Gamma', radius: 12 },
];
const EDGES = [
  { source: 'a', target: 'b', marker: 'fk' as const },
  { source: 'a', target: 'c', marker: 'm2m' as const, cls: 'is-join' },
];

function mountGraph(onNode?: (n: GraphNode) => void) {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const handle = createForceGraph(mount as unknown as Mount, {
    nodes: NODES,
    edges: EDGES,
    autostart: false,
    onNode,
  });
  return { mount, handle };
}

describe('createForceGraph — DOM construction', () => {
  it('builds an SVG with one node group per node and one line per edge', () => {
    const { mount } = mountGraph();
    expect(mount.querySelector('svg.dm-graph')).not.toBeNull();
    expect(mount.querySelectorAll('.gnode')).toHaveLength(3);
    expect(mount.querySelectorAll('line.dm-edge')).toHaveLength(2);
    // node chrome: glow + dot + icon + label for node 'a'
    const a = mount.querySelector('[data-id="a"]');
    expect(a?.querySelector('.gnode-dot')).not.toBeNull();
    expect(a?.querySelector('.gnode-glow')).not.toBeNull();
    expect(a?.querySelector('.gnode-label')?.textContent).toBe('Alpha');
    // edge styling carried through
    expect(mount.querySelector('line.is-join')).not.toBeNull();
  });

  it('writes node transforms after stepping the simulation', () => {
    const { mount, handle } = mountGraph();
    handle.step(60);
    const a = mount.querySelector('[data-id="a"]');
    expect(a?.getAttribute('transform')).toMatch(/^translate\(/);
  });
});

describe('createForceGraph — interaction', () => {
  it('fires onNode for a click (press with no drag)', () => {
    let clicked: GraphNode | null = null;
    const { mount } = mountGraph((n) => {
      clicked = n;
    });
    const a = mount.querySelector('[data-id="a"]');
    expect(a).not.toBeNull();
    fire(a!, 'pointerdown');
    fire(a!, 'pointerup');
    expect(clicked).not.toBeNull();
    expect((clicked as unknown as GraphNode).id).toBe('a');
  });

  it('dims non-matches on setHighlight and clears on null', () => {
    const { mount, handle } = mountGraph();
    handle.setHighlight(['a']);
    const b = mount.querySelector<HTMLElement>('[data-id="b"]')!;
    expect(b.style.opacity).toBe('0.1');
    handle.setHighlight(null);
    expect(b.style.opacity).toBe('1');
  });

  it('marks and clears selection', () => {
    const { mount, handle } = mountGraph();
    handle.setSelected('a');
    expect(mount.querySelector('[data-id="a"]')?.getAttribute('class')).toContain('active');
    handle.setSelected(null);
    expect(mount.querySelector('[data-id="a"]')?.getAttribute('class')).not.toContain('active');
  });
});

describe('createForceGraph — data + lifecycle', () => {
  it('grows the graph incrementally on setData', () => {
    const { mount, handle } = mountGraph();
    handle.setData(
      [...NODES, { id: 'd', label: 'Delta', radius: 12 }],
      [...EDGES, { source: 'a', target: 'd' }],
    );
    expect(mount.querySelectorAll('.gnode')).toHaveLength(4);
    expect(mount.querySelectorAll('line.dm-edge')).toHaveLength(3);
  });

  it('stop() is idempotent and does not throw', () => {
    const { handle } = mountGraph();
    expect(() => {
      handle.stop();
      handle.stop();
    }).not.toThrow();
  });
});

describe('createForceGraph — framing + label sizing (regressions)', () => {
  // BUG 3: the renderer zooms via a CSS transform scale(); without counter-scaling
  // the labels they magnify back to the old oversized font. It must pin them to a
  // constant on-screen size via --gnode-label-size on every applyView().
  it('counter-scales node labels to a constant on-screen size (--gnode-label-size)', () => {
    const { mount } = mountGraph();
    const svg = mount.querySelector('svg.dm-graph') as unknown as HTMLElement;
    const size = svg.style.getPropertyValue('--gnode-label-size');
    expect(size).not.toBe(''); // regression: the new renderer once never set it
    // At the default zoom (k=1) the var equals the ~13px on-screen target that
    // matches the sidebar/tab text.
    expect(size).toBe('13.00px');
  });

  // BUG 1: the one-shot fit ran against a 0×0 mount (fallback 900/600), framing the
  // graph into a corner. The renderer must observe the mount and re-fit once it has
  // a real size.
  it('observes the mount so it can re-fit once the pane has a real size', () => {
    let observed: unknown = null;
    const orig = (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      constructor(public cb: () => void) {}
      observe(el: unknown): void {
        observed = el;
      }
      disconnect(): void {}
    };
    try {
      const { mount } = mountGraph();
      expect(observed).toBe(mount);
    } finally {
      (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = orig;
    }
  });
});
