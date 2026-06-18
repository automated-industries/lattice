// Auto-composed section of the GUI stylesheet. Verbatim substring of the original
// css template literal — do not hand-edit; see styles/index.ts for composition.
export const dashboardCss = `    /* ── Dashboard ────────────────────────────────────── */
    .dashboard {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px;
      max-width: 1100px;
    }
    .card {
      position: relative; overflow: hidden;
      background: var(--sheen), var(--surface); border: 1px solid var(--border);
      border-radius: 12px; padding: 22px;
      min-height: 160px;
      display: flex; flex-direction: column; gap: 8px;
      box-shadow: var(--shadow-2), var(--hl-top);
      transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
    }
    .card:hover { transform: translateY(-2px); border-color: var(--accent); box-shadow: var(--shadow-3), var(--glow-accent-soft); }
    .card-icon { font-size: 22px; }
    .card-label { font-size: 15px; font-weight: 600; }
    .card-count { font-size: 28px; font-weight: 700; color: var(--text-muted); margin-top: auto; }
    .card-fresh { font-size: 11px; color: var(--text-muted); }
    /* ── Per-card background-render progress overlay ─────
       Hidden by default; .card.is-rendering reveals the bottom-edge bar + the
       corner pill while the context tree is rendered in the background. The row
       count dims so the live value reads as not-yet-final until completion. */
    .card-render { display: none; }
    .card.is-rendering .card-render { display: block; }
    .card.is-rendering .card-count { opacity: 0.45; transition: opacity 0.2s ease; }
    .card-render-fill {
      position: absolute; left: 0; bottom: 0; height: 3px; width: 0%;
      background: linear-gradient(90deg, var(--accent-deep), var(--accent));
      transition: width 0.2s ease; pointer-events: none;
    }
    .card-render-pill {
      position: absolute; top: 10px; right: 10px;
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 8px; border-radius: 10px;
      background: var(--accent-soft); color: var(--accent);
      font-size: 11px; font-weight: 600; line-height: 1.4;
      pointer-events: none;
    }
    /* The render pill reuses the shared .spinner + @keyframes lattice-spin. */
    .card-render-pill .spinner { margin-right: 0; }
    /* A render that errors out paints a red card state instead of a stuck
       spinner (surface the failure, don't hide it). */
    .card.is-render-error { border-color: #ef4444; }
    .card.is-render-error .card-render-fill { background: #ef4444; }
    .card.is-render-error .card-render-pill { background: rgba(239, 68, 68, 0.14); color: #ef4444; }

`;
