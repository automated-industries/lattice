/**
 * Dependency-free force-directed layout simulation.
 *
 * A faithful, self-contained reimplementation of the subset of a standard
 * force-directed layout we need: many-body (n-body) repulsion, link springs,
 * collision resolution, and weak positional centering, integrated with the
 * usual alpha-cooling / velocity-decay scheme. No external library is pulled in
 * — the math mirrors the well-known force-directed defaults so behaviour is
 * predictable, but the code is ours to own and tune.
 *
 * The simulation is split deliberately:
 *   - `tick()` advances ONE deterministic step (pure math over the node array).
 *     This is what the numeric tests exercise — no DOM, no animation frame.
 *   - A renderer drives `tick()` from an animation-frame loop and reads the
 *     node x/y after each step. That lives in the DOM layer, not here.
 *
 * Everything is generic. Nodes are addressed by `id`; a node may carry an
 * optional `weight` (used by the default charge accessor) and `radius` (used by
 * the default collide accessor), but callers can override every force with an
 * accessor, so there is no built-in vocabulary of node "kinds".
 */

export interface SimNode {
  id: string;
  /** Position. Seeded by the caller (or 0,0); mutated in place each tick. */
  x: number;
  y: number;
  /** Velocity. Accumulated by forces, decayed and applied each tick. */
  vx: number;
  vy: number;
  /**
   * Pin. When `fx`/`fy` is a number the node is held at that coordinate
   * (velocity zeroed) — used while dragging. `null`/`undefined` = free.
   */
  fx?: number | null;
  fy?: number | null;
  /** Optional hint for the default charge accessor (stronger repulsion). */
  weight?: number;
  /** Optional hint for the default collide accessor (node radius). */
  radius?: number;
}

export interface SimLink {
  /** Node id (resolved to a node reference on `setLinks`) or a node reference. */
  source: string | SimNode;
  target: string | SimNode;
}

/** A link after resolution: `source`/`target` are guaranteed node references. */
interface ResolvedLink<L extends SimLink> {
  link: L;
  source: SimNode;
  target: SimNode;
  /** Degree bias in [0,1]: share of the spring correction applied to `target`. */
  bias: number;
  /** Spring stiffness (resolved from the accessor or the degree default). */
  strength: number;
}

export interface ForceSimConfig<N extends SimNode, L extends SimLink> {
  /**
   * Per-node many-body strength. Negative = repulsion (the usual case),
   * positive = attraction. Default: a flat -30 scaled by `node.weight ?? 1`.
   */
  chargeStrength?: (node: N) => number;
  /** Rest length of a link spring. Default 30. */
  linkDistance?: (link: L) => number;
  /** Link spring stiffness in [0,1]. Default: 1 / min(deg(source), deg(target)). */
  linkStrength?: (link: L) => number;
  /** Spring relaxation passes per tick. Default 1. */
  linkIterations?: number;
  /** Collision radius per node. Default `node.radius ?? 0` (collision off). */
  collideRadius?: (node: N) => number;
  /** Collision stiffness in [0,1]. Default 1. */
  collideStrength?: number;
  /** Collision passes per tick. Default 1. */
  collideIterations?: number;
  /**
   * Weak positional centering. Pulls each node toward (x,y) with the given
   * per-axis strength. Omit to disable. (We pull toward viewport center.)
   */
  center?: { x: number; y: number; strength: number };
  /** Cooling rate per tick. Default ~0.0228 (settles in ~300 ticks). */
  alphaDecay?: number;
  /** Floor below which the renderer should stop ticking. Default 0.001. */
  alphaMin?: number;
  /** Target alpha; reheating a drag sets this >0 to keep the sim warm. Default 0. */
  alphaTarget?: number;
  /** Velocity retention in [0,1); 0.6 means 40% is shed each tick. Default 0.6. */
  velocityDecay?: number;
  /**
   * Tiny non-zero displacement used when two bodies are exactly coincident, so
   * the division by distance stays finite. Deterministic by default (seeded
   * LCG) so tests are reproducible; inject your own for noise.
   */
  jiggle?: () => number;
}

const DEFAULT_ALPHA_DECAY = 1 - Math.pow(0.001, 1 / 300); // ≈ 0.0228
const DISTANCE_MIN2 = 1; // clamp on squared distance for many-body (avoids blow-up)

export class ForceSim<N extends SimNode = SimNode, L extends SimLink = SimLink> {
  private nodes: N[] = [];
  private links: ResolvedLink<L>[] = [];
  private byId = new Map<string, N>();

  private chargeStrength: (node: N) => number;
  private linkDistance: (link: L) => number;
  private linkStrengthFn: ((link: L) => number) | undefined;
  private linkIterations: number;
  private collideRadius: (node: N) => number;
  private collideStrength: number;
  private collideIterations: number;
  private center: { x: number; y: number; strength: number } | undefined;
  private velocityDecay: number;
  private jiggle: () => number;

  alpha = 1;
  alphaDecay: number;
  alphaMin: number;
  alphaTarget: number;

  constructor(config: ForceSimConfig<N, L> = {}) {
    this.chargeStrength = config.chargeStrength ?? ((n) => -30 * (n.weight ?? 1));
    this.linkDistance = config.linkDistance ?? (() => 30);
    this.linkStrengthFn = config.linkStrength;
    this.linkIterations = config.linkIterations ?? 1;
    this.collideRadius = config.collideRadius ?? ((n) => n.radius ?? 0);
    this.collideStrength = config.collideStrength ?? 1;
    this.collideIterations = config.collideIterations ?? 1;
    this.center = config.center;
    this.velocityDecay = config.velocityDecay ?? 0.6;
    this.alphaDecay = config.alphaDecay ?? DEFAULT_ALPHA_DECAY;
    this.alphaMin = config.alphaMin ?? 0.001;
    this.alphaTarget = config.alphaTarget ?? 0;
    this.jiggle = config.jiggle ?? makeDeterministicJiggle();
  }

  /** Replace the node set. Existing node objects are reused by `setLinks`. */
  setNodes(nodes: N[]): this {
    this.nodes = nodes;
    this.byId = new Map(nodes.map((n) => [n.id, n]));
    return this;
  }

  getNodes(): readonly N[] {
    return this.nodes;
  }

  /**
   * Replace the link set. Each link's `source`/`target` (id or reference) is
   * resolved to a node reference; degree-based bias + default strength are
   * (re)computed so high-degree nodes move less under spring correction.
   */
  setLinks(links: L[]): this {
    const degree = new Map<string, number>();
    const resolved: ResolvedLink<L>[] = [];
    for (const link of links) {
      const source = this.resolve(link.source);
      const target = this.resolve(link.target);
      if (!source || !target) continue;
      resolved.push({ link, source, target, bias: 0, strength: 0 });
      degree.set(source.id, (degree.get(source.id) ?? 0) + 1);
      degree.set(target.id, (degree.get(target.id) ?? 0) + 1);
    }
    for (const r of resolved) {
      const ds = degree.get(r.source.id) ?? 1;
      const dt = degree.get(r.target.id) ?? 1;
      r.bias = ds / (ds + dt);
      r.strength = this.linkStrengthFn ? this.linkStrengthFn(r.link) : 1 / Math.min(ds, dt);
    }
    this.links = resolved;
    return this;
  }

  private resolve(ref: string | SimNode): N | undefined {
    return typeof ref === 'string' ? this.byId.get(ref) : (ref as N);
  }

  /** Set the warm-up target and reset alpha (call on drag start / data change). */
  reheat(alpha = 1, target = this.alphaTarget): this {
    this.alpha = alpha;
    this.alphaTarget = target;
    return this;
  }

  setAlphaTarget(target: number): this {
    this.alphaTarget = target;
    return this;
  }

  /** True once the simulation has cooled below `alphaMin` (renderer stops). */
  get settled(): boolean {
    return this.alpha < this.alphaMin && this.alphaTarget === 0;
  }

  /** Advance `iterations` steps. Returns the new alpha. */
  tick(iterations = 1): number {
    for (let k = 0; k < iterations; k++) {
      this.alpha += (this.alphaTarget - this.alpha) * this.alphaDecay;
      this.applyCharge(this.alpha);
      this.applyLinks(this.alpha);
      this.applyCollide();
      this.applyCenter(this.alpha);
      this.integrate();
    }
    return this.alpha;
  }

  // ── forces ────────────────────────────────────────────────────────────────

  /** Many-body repulsion/attraction (O(n²) — fine for hundreds of nodes). */
  private applyCharge(alpha: number): void {
    for (const ni of this.nodes) {
      for (const nj of this.nodes) {
        if (ni === nj) continue;
        let dx = nj.x - ni.x;
        let dy = nj.y - ni.y;
        let l = dx * dx + dy * dy;
        if (dx === 0) {
          dx = this.jiggle();
          l += dx * dx;
        }
        if (dy === 0) {
          dy = this.jiggle();
          l += dy * dy;
        }
        if (l < DISTANCE_MIN2) l = Math.sqrt(DISTANCE_MIN2 * l);
        const w = (this.chargeStrength(nj) * alpha) / l;
        ni.vx += dx * w;
        ni.vy += dy * w;
      }
    }
  }

  /** Link springs with degree bias (heavier-degree endpoint moves less). */
  private applyLinks(alpha: number): void {
    for (let iter = 0; iter < this.linkIterations; iter++) {
      for (const rl of this.links) {
        const { source: s, target: t, bias, strength } = rl;
        const distance = this.linkDistance(rl.link);
        let dx = t.x + t.vx - (s.x + s.vx);
        let dy = t.y + t.vy - (s.y + s.vy);
        if (dx === 0) dx = this.jiggle();
        if (dy === 0) dy = this.jiggle();
        let l = Math.sqrt(dx * dx + dy * dy);
        l = ((l - distance) / l) * alpha * strength;
        dx *= l;
        dy *= l;
        t.vx -= dx * bias;
        t.vy -= dy * bias;
        s.vx += dx * (1 - bias);
        s.vy += dy * (1 - bias);
      }
    }
  }

  /** Resolve overlaps so node disks (by radius) don't intersect. */
  private applyCollide(): void {
    const nodes = this.nodes;
    const n = nodes.length;
    for (let iter = 0; iter < this.collideIterations; iter++) {
      for (let i = 0; i < n; i++) {
        const ni = nodes[i];
        if (!ni) continue;
        const ri = this.collideRadius(ni);
        if (ri <= 0) continue;
        const ri2 = ri * ri;
        const xi = ni.x + ni.vx;
        const yi = ni.y + ni.vy;
        for (let j = i + 1; j < n; j++) {
          const nj = nodes[j];
          if (!nj) continue;
          const rj = this.collideRadius(nj);
          if (rj <= 0) continue;
          const r = ri + rj;
          let x = xi - (nj.x + nj.vx);
          let y = yi - (nj.y + nj.vy);
          let l = x * x + y * y;
          if (l >= r * r) continue;
          if (x === 0) {
            x = this.jiggle();
            l += x * x;
          }
          if (y === 0) {
            y = this.jiggle();
            l += y * y;
          }
          l = Math.sqrt(l);
          l = ((r - l) / l) * this.collideStrength;
          const rj2 = rj * rj;
          let frac = rj2 / (ri2 + rj2);
          ni.vx += (x *= l) * frac;
          ni.vy += (y *= l) * frac;
          frac = 1 - frac;
          nj.vx -= x * frac;
          nj.vy -= y * frac;
        }
      }
    }
  }

  /** Weak pull toward a fixed center point (keeps the graph from drifting off). */
  private applyCenter(alpha: number): void {
    if (!this.center) return;
    const { x: cx, y: cy, strength } = this.center;
    for (const node of this.nodes) {
      node.vx += (cx - node.x) * strength * alpha;
      node.vy += (cy - node.y) * strength * alpha;
    }
  }

  /** Apply velocity to position (with decay), honoring pinned fx/fy. */
  private integrate(): void {
    for (const node of this.nodes) {
      if (node.fx == null) {
        node.vx *= this.velocityDecay;
        node.x += node.vx;
      } else {
        node.x = node.fx;
        node.vx = 0;
      }
      if (node.fy == null) {
        node.vy *= this.velocityDecay;
        node.y += node.vy;
      } else {
        node.y = node.fy;
        node.vy = 0;
      }
    }
  }
}

/**
 * Deterministic sub-micro jiggle (seeded LCG) so coincident-body handling is
 * reproducible across runs. Magnitude ~1e-6, centered on zero.
 */
function makeDeterministicJiggle(): () => number {
  let seed = 0x2545f491;
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed / 2147483647 - 0.5) * 1e-6;
  };
}
