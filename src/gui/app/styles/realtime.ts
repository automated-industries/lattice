// Auto-composed section of the GUI stylesheet. Verbatim substring of the original
// css template literal — do not hand-edit; see styles/index.ts for composition.
export const realtimeCss = `    /* ── Realtime collaboration cues ───────────────────── */
    /* Flash a row when another editor changes it. */
    @keyframes lattice-flash-kf {
      0%   { background: var(--accent-soft); }
      100% { background: transparent; }
    }
    tr.lattice-flash > td { animation: lattice-flash-kf 1.2s ease-out; }
    @media (prefers-reduced-motion: reduce) {
      tr.lattice-flash > td { animation: none; }
      .feed-item, .chat-msg { animation: none; }
      .ask-lattice-panel-title { animation: none !important; }
      .app-loading-spinner { animation: none; }
      *, *::before, *::after { transition-duration: 0.01ms !important; }
    }
    /* Pending offline-edit indicator in the top bar. */
    .offline-pill {
      flex: 0 0 auto; padding: 4px 10px;
      background: color-mix(in srgb, var(--hue-orange) 16%, transparent); color: var(--warn);
      font-size: 11px; font-weight: 600; white-space: nowrap;
    }
    .app-version { flex: 0 0 auto; color: var(--text-muted); font-size: 12px; white-space: nowrap; }
    .app-version:empty { display: none; }
    .app-update { flex: 0 0 auto; color: var(--accent); font-size: 12px; white-space: nowrap; }
    .app-update[hidden] { display: none; }
    #app-update-link { flex: 0 0 auto; margin-left: 8px; color: var(--accent); font-size: 12px; cursor: pointer; white-space: nowrap; }
    #app-update-link[hidden] { display: none; }
    /* Unseen-change count next to a sidebar entity. */
    .nav-badge {
      display: inline-block; min-width: 16px; text-align: center;
      margin-left: 4px; padding: 0 6px;
      background: var(--accent-soft); color: var(--accent);
      font-size: 10px; font-weight: 600; line-height: 16px; vertical-align: middle;
    }

`;
