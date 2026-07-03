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
    .card:hover { transform: translateY(-2px); border-color: var(--accent); box-shadow: var(--shadow-3); }
    .card-icon { font-size: 22px; }
    .card-label { font-size: 15px; font-weight: 600; }
    .card-count { font-size: 28px; font-weight: 700; color: var(--text-muted); margin-top: auto; }
    .card-fresh { font-size: 11px; color: var(--text-muted); }
    /* (The per-table render display moved into the Markdown column tree.) */

`;
