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
      .lat-spinner, .lat-skeleton, .lat-pulse { animation: none; }
      *, *::before, *::after { transition-duration: 0.01ms !important; }
    }
    /* ── Shared realtime-motion primitives ─────────────────
       One vocabulary for every "working…" cue — spinner, skeleton shimmer, and
       pulse — so build-graph, table-load, and file/table creation feedback all
       read as one system. Durations + easing come from the Motion tokens
       (styles/tokens.ts); the spinner reuses the shared lattice-spin keyframe. */
    .lat-spinner {
      display: inline-block; width: 14px; height: 14px; flex: none;
      border: 2px solid var(--border-strong); border-top-color: var(--accent);
      border-radius: 50%; animation: lattice-spin var(--dur-spin) linear infinite;
    }
    @keyframes lat-shimmer { 100% { background-position: -200% 0; } }
    .lat-skeleton {
      border-radius: var(--r-sm);
      background: linear-gradient(90deg, var(--surface-2) 25%, var(--row-hover) 37%, var(--surface-2) 63%);
      background-size: 200% 100%;
      animation: lat-shimmer var(--dur-pulse) ease-in-out infinite;
    }
    @keyframes lat-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
    .lat-pulse { animation: lat-pulse var(--dur-pulse) ease-in-out infinite; }
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
    /* When the update pill is VISIBLE it takes over the header's flexible gap
       so it sits at the far right, immediately left of Configure — whose own
       auto margin (analytics-view.ts) would otherwise absorb the free space
       BETWEEN the pill and Configure, stranding the pill mid-header. The
       adjacent-sibling rule neutralizes Configure's auto margin only for that
       case; when the pill is hidden, Configure keeps the auto gap as before. */
    #app-update-link:not([hidden]) { margin-left: auto; }
    #app-update-link:not([hidden]) + .configure-trigger { margin-left: 8px; }
    /* Unseen-change count next to a sidebar entity. */
    .nav-badge {
      display: inline-block; min-width: 16px; text-align: center;
      margin-left: 4px; padding: 0 6px;
      background: var(--accent-soft); color: var(--accent);
      font-size: 10px; font-weight: 600; line-height: 16px; vertical-align: middle;
    }

`;
