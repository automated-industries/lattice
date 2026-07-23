/**
 * Live force-directed graph renderer — the interactive SVG layer over the
 * dependency-free {@link ForceSim} engine.
 *
 * This is a browser module: it is bundled SEPARATELY from the main server build
 * (see `scripts/build-gui-assets.mjs`) into `dist/gui-assets/force-graph.mjs`
 * and loaded out-of-band by the tiny host script via a dynamic
 * `import('/gui-assets/force-graph.mjs')`. The same pattern the on-device voice
 * worker uses — keeping the byte-locked inline `appJs` free of DOM-heavy code.
 *
 * Unlike a one-shot settle-then-draw layout, this drives a continuous
 * animation-frame loop: nodes stream in and fly out from the center, the
 * simulation reheats on drag and on new data, and the SVG is mutated in place
 * each tick (never re-rendered as a string), so 60fps motion is cheap.
 *
 * Type note: lattice's TypeScript targets `lib: ["ES2022"]` with no DOM lib (the
 * client is otherwise authored as browser-JS strings). Rather than pull the DOM
 * lib into the whole program, this module declares the exact, minimal DOM surface
 * it uses — module-scoped, so it neither pollutes global types nor needs a
 * separate tsconfig. esbuild erases the declarations and the real browser globals
 * are used at runtime.
 */

import { ForceSim, type SimNode } from './force-sim.js';

// ── minimal module-scoped DOM surface (no DOM lib; see header) ───────────────
interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}
interface El {
  setAttribute(name: string, value: string | number): void;
  appendChild(child: El): El;
  insertBefore(child: El, ref: El | null): El;
  remove(): void;
  querySelector(selector: string): El | null;
  closest(selector: string): El | null;
  addEventListener(
    type: string,
    handler: (e: DomEvent) => void,
    opts?: { passive?: boolean },
  ): void;
  getBoundingClientRect(): Rect;
  setPointerCapture(pointerId: number): void;
  releasePointerCapture(pointerId: number): void;
  readonly firstChild: El | null;
  readonly style: Record<string, string> & {
    setProperty(prop: string, value: string): void;
  };
  textContent: string;
  clientWidth: number;
  clientHeight: number;
}
interface DomEvent {
  clientX: number;
  clientY: number;
  pointerId: number;
  deltaY: number;
  target: El;
  preventDefault(): void;
  stopPropagation(): void;
}
declare const document: {
  getElementById(id: string): El | null;
  createElementNS(ns: string, qualifiedName: string): El;
  createElement(tag: string): El;
};
declare function requestAnimationFrame(cb: () => void): number;
declare function cancelAnimationFrame(handle: number): void;
declare const ResizeObserver:
  | (new (cb: () => void) => { observe(el: El): void; disconnect(): void })
  | undefined;

const SVGNS = 'http://www.w3.org/2000/svg';

/** A node to render. `id` is required and unique; everything else is cosmetic. */
export interface GraphNode {
  id: string;
  label?: string;
  /** Glyph drawn centered in the node (an emoji or single char). */
  icon?: string;
  /** Node radius in graph units. Drives size, charge, and collision. */
  radius?: number;
  /** Extra class(es) on the node `<g>` (e.g. a cloud share-status class). */
  cls?: string;
  /** Native tooltip text. */
  title?: string;
}

/** An edge to render. `source`/`target` are node ids. */
export interface GraphEdge {
  source: string;
  target: string;
  /** Extra class(es) on the `<line>`. */
  cls?: string;
  /** Arrow style: a `<marker>` id suffix registered in defs (`fk` | `m2m`). */
  marker?: 'fk' | 'm2m';
  /** Stroke dash pattern (e.g. `'5 3'`). */
  dash?: string;
  /** Native tooltip text. */
  title?: string;
}

export interface ForceGraphOptions {
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  /** Fired on a node click (a press with no drag). */
  onNode?: (node: GraphNode) => void;
  /** Fired on an edge click. */
  onEdge?: (edge: GraphEdge) => void;
  /**
   * Start the animation loop immediately. Default true. Tests pass `false` and
   * drive the simulation deterministically via the handle's `step()`.
   */
  autostart?: boolean;
  /**
   * Skip the animation: settle the layout synchronously and paint once. Honors a
   * user's reduced-motion preference (and is the fallback when no animation-frame
   * scheduler exists, e.g. SSR / tests).
   */
  reducedMotion?: boolean;
  /**
   * Seed node coordinates from a prior layout (keyed by node id). A new node with
   * a seed spawns at its cached position instead of the cold spiral, so a revisit
   * to a graph you've already settled reappears in place with no re-settle. Unknown
   * nodes still spiral-in and animate.
   */
  initialPositions?: Record<string, { x: number; y: number }>;
  /**
   * Fired once each time the layout first settles, with the final node positions.
   * Callers cache these to seed a later mount (see {@link initialPositions}).
   */
  onSettle?: (positions: Record<string, { x: number; y: number }>) => void;
}

export interface ForceGraphHandle {
  /** Replace / grow the graph; new nodes fly in from the center. */
  setData(nodes: GraphNode[], edges: GraphEdge[]): void;
  /** Pulse the given node ids, dim the rest, and frame the matches. Null clears. */
  setHighlight(ids: string[] | null): void;
  /** Outline a single node (or clear with null). */
  setSelected(id: string | null): void;
  /** Reheat the simulation (e.g. after an external change). */
  reheat(): void;
  /** Advance the simulation N steps and repaint — for tests / manual control. */
  step(n?: number): void;
  /** Current node coordinates keyed by id — cache these to seed a later mount. */
  positions(): Record<string, { x: number; y: number }>;
  /** Stop the animation loop (call on unmount, before discarding the DOM). */
  stop(): void;
}

interface FNode extends SimNode {
  source: GraphNode;
  radius: number;
  g: El;
  circle: El;
}

interface FEdge {
  edge: GraphEdge;
  source: FNode;
  target: FNode;
  line: El;
  hit: El | null;
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 4;

// Cool a cold/first-visit layout to rest in ~120 ticks (~2s at 60fps) instead of
// the sim's ~300-tick (~5s) default — a first visit converges quickly while it
// animates in, and the 400-tick safety net in frame() still bounds a pathological
// never-settle. Scoped to the initial + data-change layout only; a drag restores
// the default decay (below) so pinning/reheating still feels normal.
const FAST_ALPHA_DECAY = 1 - Math.pow(0.001, 1 / 120); // ≈ 0.056

/**
 * Clamp one axis of the stage translation so the graph's bounding box can never be
 * panned/zoomed fully out of the viewport. `lo`/`hi` are the world-space min/max of
 * the node bounding box on this axis, `k` the zoom, `pane` the viewport size, `m` a
 * margin kept on-screen. When the box is smaller than the pane it stays fully inside
 * [m, pane-m]; when it's larger than the pane it stays covering the pane (you can't
 * scroll past an edge into empty space). Exported so the math is unit-tested without
 * a DOM. Screen position of a world point x is `x*k + v`.
 */
export function clampAxis(
  v: number,
  lo: number,
  hi: number,
  k: number,
  pane: number,
  m: number,
): number {
  const a = m - lo * k; // near edge at +m
  const b = pane - m - hi * k; // far edge at pane-m
  return Math.min(Math.max(v, Math.min(a, b)), Math.max(a, b));
}

/**
 * Create a live force-directed graph inside `mount`. Returns a handle to feed it
 * data, drive highlight/selection, and tear it down. The renderer owns the SVG
 * subtree; on unmount, `stop()` the loop then discard `mount.innerHTML`.
 */
export function createForceGraph(mount: El, options: ForceGraphOptions = {}): ForceGraphHandle {
  const radiusOf = (n: GraphNode): number => n.radius ?? 12;

  const sim = new ForceSim<FNode>({
    chargeStrength: (n) => -30 * (n.radius / 6),
    linkDistance: () => 140,
    linkStrength: () => 0.5,
    // Collision must clear the node's LABEL, not just the dot. The label is drawn
    // centred below the dot and is FAR wider than it — a 24-char name renders
    // ~165px wide vs an ~11px radius. Reserving only the dot radius (the old
    // `+22`) let neighbours' labels overlap badly. We reserve roughly HALF the
    // label's on-screen width (in graph units) so the layout spreads enough that,
    // after the fit scales it to the pane, the constant-~13px labels stay clear.
    // Spreading also pushes the bounding box past the fit's zoom-IN cap, so the
    // fit zooms to FILL the pane (screen gap ≈ pane / √nodes) instead of clustering
    // tight. Three passes resolve dense clusters before the alpha cools.
    collideRadius: (n) => {
      const chars = n.source.label ? n.source.label.length : 0;
      const halfLabel = chars * 4.2 + 14; // ≈ 8.4px/char at 13px → half-width + margin
      return Math.max(n.radius + 14, halfLabel);
    },
    collideIterations: 3,
    center: { x: 0, y: 0, strength: 0.05 },
  });
  // The sim's standard cooling rate (settles in ~300 ticks). A cold layout swaps in
  // FAST_ALPHA_DECAY for a quicker converge; a drag restores this so reheat feels
  // normal. Captured (not hard-coded) so it tracks the sim's default.
  const DEFAULT_ALPHA_DECAY = sim.alphaDecay;

  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'dm-graph');
  svg.style.width = '100%';
  svg.style.height = '100%';
  svg.style.display = 'block';
  svg.style.cursor = 'grab';
  svg.style.touchAction = 'none';
  svg.appendChild(buildDefs());
  const stage = document.createElementNS(SVGNS, 'g');
  stage.setAttribute('class', 'dm-stage');
  const edgeLayer = document.createElementNS(SVGNS, 'g');
  const nodeLayer = document.createElementNS(SVGNS, 'g');
  stage.appendChild(edgeLayer);
  stage.appendChild(nodeLayer);
  svg.appendChild(stage);
  mount.appendChild(svg);
  // Keep the stage hidden ONLY until the first real fit lands (mount has a size and
  // nodes are placed) — then reveal immediately and let the layout animate into
  // place, rather than blocking behind a spinner until the physics fully settles
  // (~5s on every open). The one-frame hide still prevents a top-left corner flash
  // before the first centring fit; a not-yet-sized mount defers the fit and stays
  // hidden until it has a box. (Later live-ingest updates animate normally.)
  stage.style.visibility = 'hidden';
  let revealed = false;
  let settledOnce = false;
  let settleReported = false;
  const loadingEl = document.createElement('div');
  loadingEl.setAttribute('class', 'graph-loading');
  const spinnerEl = document.createElement('div');
  spinnerEl.setAttribute('class', 'graph-spinner');
  loadingEl.appendChild(spinnerEl);
  mount.appendChild(loadingEl);
  function reveal(): void {
    if (revealed) return;
    revealed = true;
    stage.style.visibility = 'visible';
    loadingEl.remove();
  }

  // Frame the graph once the mount first gets a real size — it reliably reveals
  // the stage the moment the pane is measurable (the settle path alone is
  // timing-dependent and can leave the stage hidden under a slow first layout),
  // and `fitTo` always CENTERS, so this early fit is centred, never a corner. It
  // ALSO re-frames on later pane/window resizes (sidebar collapse, assistant-rail
  // toggle) — but only while the user is still at the auto-fit view, so a manually
  // zoomed/panned user isn't yanked back.
  // Held so stop() can disconnect it: the GUI reuses ONE #graph-mount element and
  // creates a fresh graph on every open/refresh, so an un-disconnected observer
  // would stack up on the same element — each retaining a stale graph's closure —
  // and keep firing on every resize. stop() is the teardown callers use.
  let resizeObs: { observe(el: El): void; disconnect(): void } | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    let firstFit = false;
    resizeObs = new ResizeObserver(() => {
      if (!mount.clientWidth || !mount.clientHeight) return;
      if (!firstFit) {
        firstFit = true;
        fitAll();
      } else if (Math.abs(view.k - fitK) < 1e-3) {
        fitAll();
      }
    });
    resizeObs.observe(mount);
  }

  const nodeMap = new Map<string, FNode>();
  const edges: FEdge[] = [];
  const view = { k: 1, x: 0, y: 0 };
  // Lowest allowed zoom = the fit-to-all k (everything + padding visible). Set on
  // every fitAll so you can't zoom out past the whole graph.
  let fitK = MIN_SCALE;
  let raf = 0;
  let fitRaf = 0; // the deferred-fit retry handle, so stop() can cancel it
  let running = false;
  let framed = false;
  let graphTicks = 0; // ticks since start — drives the settle/reveal safety net
  let selectedId: string | null = null;

  const W = (): number => mount.clientWidth || 900;
  const H = (): number => mount.clientHeight || 600;
  const fmt = (v: number): string => v.toFixed(2);

  function applyView(): void {
    stage.setAttribute(
      'transform',
      `translate(${fmt(view.x)},${fmt(view.y)}) scale(${fmt(view.k)})`,
    );
    // Counter-scale node labels so they stay a constant ~13px on-screen (matching
    // the sidebar/tab text) regardless of the stage zoom — the transform's scale()
    // would otherwise magnify the glyphs back to the old oversized look.
    svg.style.setProperty('--gnode-label-size', `${(13 / view.k).toFixed(2)}px`);
  }

  // Keep the graph within the viewport on manual pan/zoom: clamp the translation so
  // the node bounding box can never be moved fully off-screen. Layout/fit set the
  // view directly (centred), so only the hand-rolled pan + zoom call this.
  function clampView(): void {
    if (!nodeMap.size) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodeMap.values()) {
      minX = Math.min(minX, n.x - n.radius);
      minY = Math.min(minY, n.y - n.radius);
      maxX = Math.max(maxX, n.x + n.radius);
      maxY = Math.max(maxY, n.y + n.radius);
    }
    const m = 60;
    view.x = clampAxis(view.x, minX, maxX, view.k, W(), m);
    view.y = clampAxis(view.y, minY, maxY, view.k, H(), m);
  }

  function paint(): void {
    for (const e of edges) {
      e.line.setAttribute('x1', e.source.x);
      e.line.setAttribute('y1', e.source.y);
      e.line.setAttribute('x2', e.target.x);
      e.line.setAttribute('y2', e.target.y);
      if (e.hit) {
        e.hit.setAttribute('x1', e.source.x);
        e.hit.setAttribute('y1', e.source.y);
        e.hit.setAttribute('x2', e.target.x);
        e.hit.setAttribute('y2', e.target.y);
      }
    }
    for (const n of nodeMap.values()) {
      n.g.setAttribute('transform', `translate(${fmt(n.x)},${fmt(n.y)})`);
    }
  }

  function frame(): void {
    sim.tick(1);
    paint();
    graphTicks++;
    // settledOnce still gates the safety-net reveal, but reveal no longer WAITS for
    // it — the first fit below reveals immediately (see fitTo). Kept as the "layout
    // is done" signal + the never-settle backstop.
    if (!settledOnce && (sim.settled || graphTicks > 400)) settledOnce = true;
    if (!framed) {
      // Frame + REVEAL on the first real fit — don't wait for the sim to settle. The
      // user sees the graph at once and watches it glide into place instead of ~5s of
      // blank spinner. (fitTo defers at 0×0 and retries, so a not-yet-sized mount
      // stays hidden — no corner flash.)
      framed = true;
      fitAll();
    } else if (!sim.settled && Math.abs(view.k - fitK) < 1e-3) {
      // Track the camera with the expanding layout while the user is still at the
      // auto-fit zoom (hasn't manually panned/zoomed) — the growing graph stays
      // centred + framed each tick instead of nodes flying past the viewport edge.
      fitAll();
    }
    if (sim.settled) {
      running = false;
      reportSettle();
      return;
    }
    raf = requestAnimationFrame(frame);
  }

  /** Fire onSettle once per cold layout with the final positions (for caching). */
  function reportSettle(): void {
    if (settleReported) return;
    settleReported = true;
    options.onSettle?.(readPositions());
  }
  function readPositions(): Record<string, { x: number; y: number }> {
    const out: Record<string, { x: number; y: number }> = {};
    for (const n of nodeMap.values()) out[n.id] = { x: n.x, y: n.y };
    return out;
  }

  function start(): void {
    if (running) return;
    // Reduced-motion (or no scheduler): settle synchronously, paint once, no loop.
    if (options.reducedMotion || typeof requestAnimationFrame !== 'function') {
      settleNow();
      return;
    }
    running = true;
    raf = requestAnimationFrame(frame);
  }

  function settleNow(): void {
    let i = 0;
    while (!sim.settled && i < 600) {
      sim.tick(1);
      i++;
    }
    paint();
    settledOnce = true; // synchronous settle → safe to fit + reveal at once
    if (!framed) {
      framed = true;
      fitAll();
    }
    reveal();
    reportSettle();
  }

  // ── data ──────────────────────────────────────────────────────────────────
  function setData(nodes: GraphNode[], newEdges: GraphEdge[]): void {
    let changed = false;
    let spawnedUnseeded = false; // a new node with no cached position (needs layout)
    let removedAny = false;
    let spawnIndex = nodeMap.size;
    for (const node of nodes) {
      if (nodeMap.has(node.id)) continue;
      changed = true;
      // Seed from a cached position when we have one (a revisit) so the node
      // reappears in place; otherwise cold-spawn on the spiral and animate in.
      const seed = options.initialPositions?.[node.id];
      if (!seed) spawnedUnseeded = true;
      const angle = spawnIndex++;
      const fnode: FNode = {
        id: node.id,
        source: node,
        radius: radiusOf(node),
        x: seed ? seed.x : Math.cos(angle) * 40,
        y: seed ? seed.y : Math.sin(angle) * 40,
        vx: 0,
        vy: 0,
        g: document.createElementNS(SVGNS, 'g'),
        circle: document.createElementNS(SVGNS, 'circle'),
      };
      drawNode(fnode);
      nodeMap.set(node.id, fnode);
    }

    // Remove nodes no longer present (e.g. a merged-away table) so a link/merge
    // reflects in realtime through setData rather than a full graph rebuild. New
    // sets that only GROW (the wave-reveal + live ingest) never hit this.
    const wantNodes = new Set(nodes.map((n) => n.id));
    for (const [id, fnode] of nodeMap) {
      if (!wantNodes.has(id)) {
        fnode.g.remove();
        nodeMap.delete(id);
        changed = true;
        removedAny = true;
      }
    }

    const wantEdges = new Set(newEdges.map((e) => `${e.source}->${e.target}`));
    for (let i = edges.length - 1; i >= 0; i--) {
      const existing = edges[i];
      if (existing && !wantEdges.has(`${existing.edge.source}->${existing.edge.target}`)) {
        existing.line.remove();
        existing.hit?.remove();
        edges.splice(i, 1);
        changed = true;
      }
    }
    const haveEdges = new Set(edges.map((e) => `${e.edge.source}->${e.edge.target}`));
    for (const edge of newEdges) {
      const key = `${edge.source}->${edge.target}`;
      if (haveEdges.has(key)) continue;
      const source = nodeMap.get(edge.source);
      const target = nodeMap.get(edge.target);
      if (!source || !target) continue;
      changed = true;
      drawEdge(edge, source, target);
    }

    if (!changed) return;
    sim.setNodes([...nodeMap.values()]);
    sim.setLinks(edges.map((e) => ({ source: e.source.id, target: e.target.id })));
    // Re-frame once the grown/shrunk graph settles: the settle path re-runs fitAll,
    // which both centres the new node set and refreshes the zoom-out floor (fitK)
    // so you can always zoom out to see everything that was just ingested.
    framed = false;
    // Warm revisit: every node added this update came from the position cache and
    // nothing was removed → the layout is already in its final arrangement, so start
    // ALREADY-SETTLED (alpha 0). The first fit frames it and it appears instantly
    // with no motion. Otherwise cold-reheat with the faster decay so genuinely new
    // nodes spring in and the layout re-converges quickly.
    if (nodeMap.size > 0 && !spawnedUnseeded && !removedAny) {
      sim.reheat(0); // alpha 0, target 0 → settled: framed by the first fit, no motion
    } else {
      settleReported = false; // a fresh cold layout will re-report its settle
      sim.alphaDecay = FAST_ALPHA_DECAY;
      sim.reheat(0.9);
    }
    start();
  }

  function drawNode(n: FNode): void {
    const node = n.source;
    n.g.setAttribute('class', `gnode${node.cls ? ' ' + node.cls : ''}`);
    n.g.setAttribute('data-id', node.id);
    n.g.style.cursor = 'pointer';
    const glow = document.createElementNS(SVGNS, 'circle');
    glow.setAttribute('class', 'gnode-glow');
    glow.setAttribute('r', n.radius + 8);
    n.g.appendChild(glow);
    n.circle.setAttribute('class', 'gnode-dot');
    n.circle.setAttribute('r', n.radius);
    n.g.appendChild(n.circle);
    if (node.icon) {
      const icon = document.createElementNS(SVGNS, 'text');
      icon.setAttribute('class', 'gnode-icon');
      icon.setAttribute('y', n.radius * 0.34);
      icon.setAttribute('text-anchor', 'middle');
      icon.setAttribute('font-size', n.radius * 0.95);
      icon.textContent = node.icon;
      n.g.appendChild(icon);
    }
    if (node.label) {
      const label = document.createElementNS(SVGNS, 'text');
      label.setAttribute('class', 'gnode-label');
      label.setAttribute('y', n.radius + 15);
      label.setAttribute('text-anchor', 'middle');
      label.textContent = node.label;
      n.g.appendChild(label);
    }
    const tip = document.createElementNS(SVGNS, 'title');
    tip.textContent = node.title ?? node.label ?? node.id;
    n.g.appendChild(tip);
    wireNodeDrag(n);
    nodeLayer.appendChild(n.g);
  }

  function drawEdge(edge: GraphEdge, source: FNode, target: FNode): void {
    const line = document.createElementNS(SVGNS, 'line');
    line.setAttribute('class', `dm-edge${edge.cls ? ' ' + edge.cls : ''}`);
    line.setAttribute('stroke-width', 1.6);
    line.setAttribute('opacity', 0.7);
    if (edge.dash) line.setAttribute('stroke-dasharray', edge.dash);
    if (edge.marker) line.setAttribute('marker-end', `url(#dm-arrow-${edge.marker})`);
    if (edge.title) {
      const tip = document.createElementNS(SVGNS, 'title');
      tip.textContent = edge.title;
      line.appendChild(tip);
    }
    edgeLayer.insertBefore(line, edgeLayer.firstChild);

    let hit: El | null = null;
    if (options.onEdge) {
      hit = document.createElementNS(SVGNS, 'line');
      hit.setAttribute('class', 'dm-edge-hit');
      hit.setAttribute('stroke', 'transparent');
      hit.setAttribute('stroke-width', 12);
      hit.style.cursor = 'pointer';
      hit.style.pointerEvents = 'stroke';
      hit.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
      });
      hit.addEventListener('click', (ev) => {
        ev.stopPropagation();
        options.onEdge?.(edge);
      });
      edgeLayer.appendChild(hit);
    }
    edges.push({ edge, source, target, line, hit });
  }

  // ── node drag / click ───────────────────────────────────────────────────--
  function wireNodeDrag(n: FNode): void {
    let dragging = false;
    let moved = false;
    let downX = 0;
    let downY = 0;
    n.g.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      dragging = true;
      moved = false;
      downX = e.clientX;
      downY = e.clientY;
      n.fx = n.x;
      n.fy = n.y;
      // Restore the standard cooling rate for interaction so a drag/pin reheat
      // settles at its normal pace (the fast decay is only for the cold layout).
      sim.alphaDecay = DEFAULT_ALPHA_DECAY;
      sim.reheat(Math.max(sim.alpha, 0.3), 0.3);
      start();
      tryCapture(n.g, e.pointerId);
    });
    n.g.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      if (!moved && Math.hypot(e.clientX - downX, e.clientY - downY) < 4) return;
      moved = true;
      const p = toGraph(e);
      // Keep the dragged node inside the visible viewport so it can't be pulled out
      // of the window (world coords of the on-screen edges, inset by the radius).
      const x0 = (8 - view.x) / view.k + n.radius;
      const x1 = (W() - 8 - view.x) / view.k - n.radius;
      const y0 = (8 - view.y) / view.k + n.radius;
      const y1 = (H() - 8 - view.y) / view.k - n.radius;
      n.fx = Math.min(Math.max(p.x, Math.min(x0, x1)), Math.max(x0, x1));
      n.fy = Math.min(Math.max(p.y, Math.min(y0, y1)), Math.max(y0, y1));
    });
    n.g.addEventListener('pointerup', (e) => {
      dragging = false;
      n.fx = null;
      n.fy = null;
      sim.setAlphaTarget(0);
      tryRelease(n.g, e.pointerId);
      if (!moved) options.onNode?.(n.source);
    });
  }

  // ── pan / zoom (hand-rolled pointer + wheel) ────────────────────────────────
  const pointers = new Map<number, { x: number; y: number }>();
  let panning = false;
  let panX = 0;
  let panY = 0;
  let pinchDist = 0;

  svg.addEventListener('pointerdown', (e) => {
    if (e.target.closest('[data-id]')) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    tryCapture(svg, e.pointerId);
    if (pointers.size === 1) {
      panning = true;
      panX = e.clientX;
      panY = e.clientY;
      svg.style.cursor = 'grabbing';
    } else if (pointers.size === 2) {
      panning = false;
      pinchDist = pinchDistance();
    }
  });
  svg.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size >= 2 && pinchDist) {
      const d = pinchDistance();
      const mid = pinchMid();
      const rect = svg.getBoundingClientRect();
      const mx = mid.x - rect.left;
      const my = mid.y - rect.top;
      zoomAt(mx, my, view.k * (d / pinchDist));
      pinchDist = d;
    } else if (panning) {
      view.x += e.clientX - panX;
      view.y += e.clientY - panY;
      panX = e.clientX;
      panY = e.clientY;
      clampView();
      applyView();
    }
  });
  const endPointer = (e: DomEvent): void => {
    pointers.delete(e.pointerId);
    tryRelease(svg, e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (pointers.size === 0) {
      panning = false;
      svg.style.cursor = 'grab';
    }
  };
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', endPointer);
  svg.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, view.k * factor);
    },
    { passive: false },
  );

  function zoomAt(px: number, py: number, nextK: number): void {
    // Floor zoom-out at the fit-to-all k so you can't shrink the graph past the
    // point where everything + padding is visible (a fixed MIN_SCALE floor let it
    // zoom out to a speck).
    const k = Math.max(fitK, Math.min(MAX_SCALE, nextK));
    view.x = px - ((px - view.x) * k) / view.k;
    view.y = py - ((py - view.y) * k) / view.k;
    view.k = k;
    clampView();
    applyView();
  }

  function pinchDistance(): number {
    const pts = [...pointers.values()];
    const a = pts[0];
    const b = pts[1];
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y) || 1;
  }
  function pinchMid(): { x: number; y: number } {
    const pts = [...pointers.values()];
    const a = pts[0];
    const b = pts[1];
    if (!a || !b) return { x: 0, y: 0 };
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function toGraph(e: DomEvent): { x: number; y: number } {
    const rect = svg.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - view.x) / view.k,
      y: (e.clientY - rect.top - view.y) / view.k,
    };
  }

  // ── framing / highlight / selection ─────────────────────────────────────────
  function fitAll(): void {
    fitTo([...nodeMap.values()]);
    fitK = view.k; // the all-nodes fit becomes the zoom-out floor
  }
  function fitTo(ns: FNode[]): void {
    if (!ns.length) {
      // Nothing to frame (e.g. setHighlight matched no nodes). Keep the current
      // view, but never leave the stage hidden when the graph has content.
      if (nodeMap.size) reveal();
      return;
    }
    // Defer the fit until the mount actually has a layout box. A freshly-cleared
    // mount (or a synchronous reduced-motion settle) can run here at 0×0, where
    // W()/H() fall back to 900/600 and translate the cluster into a corner. Retry
    // next frame (tracked in fitRaf so stop() cancels it — no forever-rescheduling
    // rAF on a detached mount); the ResizeObserver also re-fits once the pane sizes.
    if (!mount.clientWidth || !mount.clientHeight) {
      framed = false;
      if (typeof requestAnimationFrame === 'function') {
        fitRaf = requestAnimationFrame(() => {
          fitRaf = 0;
          if (!framed) {
            framed = true;
            fitTo(ns);
          }
        });
      }
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of ns) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x);
      maxY = Math.max(maxY, n.y);
    }
    const pad = 90;
    const bw = Math.max(1, maxX - minX) + pad * 2;
    const bh = Math.max(1, maxY - minY) + pad * 2;
    // Cap zoom-IN at 1.4× (was 2.2×, which blew up compact graphs to fill the
    // pane). The MIN_SCALE floor lets a large graph fit fully.
    const k = Math.max(MIN_SCALE, Math.min(1.4, Math.min(W() / bw, H() / bh)));
    view.k = k;
    view.x = W() / 2 - ((minX + maxX) / 2) * k;
    view.y = H() / 2 - ((minY + maxY) / 2) * k;
    applyView();
    // Reveal as soon as a real fit lands (we're past the 0×0 defer, so the mount is
    // sized and the nodes are placed + centred). Don't wait for the sim to settle —
    // the graph shows immediately and animates into its final layout.
    reveal();
  }

  function setHighlight(ids: string[] | null): void {
    const hi = ids?.length ? new Set(ids) : null;
    for (const n of nodeMap.values()) {
      const match = hi?.has(n.id) ?? false;
      const lit = hi === null || match;
      n.g.style.opacity = lit ? '1' : '0.1';
      n.circle.setAttribute('class', match ? 'gnode-dot gnode-hot' : 'gnode-dot');
    }
    for (const e of edges) {
      const lit = hi === null || hi.has(e.source.id) || hi.has(e.target.id);
      e.line.setAttribute('opacity', lit ? 0.7 : 0.06);
    }
    if (hi !== null) {
      const matches = [...nodeMap.values()].filter((n) => hi.has(n.id));
      fitTo(matches);
    }
  }

  function setSelected(id: string | null): void {
    if (selectedId) {
      const prev = nodeMap.get(selectedId);
      prev?.g.setAttribute('class', `gnode${prev.source.cls ? ' ' + prev.source.cls : ''}`);
    }
    selectedId = id;
    if (id) {
      const next = nodeMap.get(id);
      // `.gnode.active` is the existing selection style (accent ring + glow).
      next?.g.setAttribute('class', `gnode active${next.source.cls ? ' ' + next.source.cls : ''}`);
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────--
  function stop(): void {
    running = false;
    if (typeof cancelAnimationFrame === 'function') {
      if (raf) cancelAnimationFrame(raf);
      if (fitRaf) cancelAnimationFrame(fitRaf);
    }
    raf = 0;
    fitRaf = 0;
    // Release the resize observer — callers stop() a graph to discard it (the
    // next open builds a fresh one), so leaving the observer attached to the
    // shared mount would accumulate stale observers across the session.
    if (resizeObs) {
      resizeObs.disconnect();
      resizeObs = null;
    }
  }
  function step(n = 1): void {
    sim.tick(n);
    paint();
  }
  function reheat(): void {
    sim.alphaDecay = DEFAULT_ALPHA_DECAY; // an explicit reheat cools at the normal pace
    sim.reheat(0.7);
    start();
  }

  applyView();
  if (options.nodes?.length) {
    setData(options.nodes, options.edges ?? []);
  }
  if (options.autostart === false) stop();

  return { setData, setHighlight, setSelected, reheat, step, positions: readPositions, stop };
}

function buildDefs(): El {
  const defs = document.createElementNS(SVGNS, 'defs');
  for (const id of ['fk', 'm2m']) {
    const marker = document.createElementNS(SVGNS, 'marker');
    marker.setAttribute('id', `dm-arrow-${id}`);
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '9');
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '7');
    marker.setAttribute('markerHeight', '7');
    marker.setAttribute('orient', 'auto-start-reverse');
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', 'M0,0 L10,5 L0,10 z');
    path.setAttribute('class', `dm-arrow-${id}`);
    marker.appendChild(path);
    defs.appendChild(marker);
  }
  return defs;
}

function tryCapture(el: El, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // not all environments support pointer capture; harmless to skip
  }
}
function tryRelease(el: El, pointerId: number): void {
  try {
    el.releasePointerCapture(pointerId);
  } catch {
    // see tryCapture
  }
}
