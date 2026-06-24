// Auto-composed section of the GUI stylesheet. Verbatim substring of the original
// css template literal — do not hand-edit; see styles/index.ts for composition.
export const layoutCss = `    /* ── Layout ────────────────────────────────────────── */
    /* minmax(0, 1fr) on the content track lets a wide child (a table with
       chip-heavy cells) shrink instead of forcing the page wider than the
       viewport. Without the explicit 0 lower bound, the implicit auto
       minimum keeps the track at content-width and the whole page scrolls
       horizontally. */
    .layout {
      display: grid; grid-template-columns: var(--nav-width) minmax(0, 1fr) var(--sidebar-width);
      height: calc(100vh - 56px);
    }
    @media (max-width: 720px) {
      #content { padding-bottom: 24px; }
    }
    nav.sidebar {
      background: var(--surface); border-right: 1px solid var(--border);
      padding: 18px 10px; overflow-y: auto;
    }
    .section-label {
      font-size: 11px; font-weight: 600; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.06em;
      padding: 0 12px; margin: 12px 0 6px;
    }
    .section-label:first-child { margin-top: 0; }
    /* Extra breathing room above the "SYSTEM" heading so it isn't cramped
       against the object list above it. */
    #system-section .section-label { margin-top: 20px; }
    nav ul { list-style: none; padding: 0; margin: 0; }
    nav li a {
      display: flex; align-items: center; gap: 10px;
      padding: 7px 12px; border-radius: 6px;
      color: var(--text); font-size: 13.5px;
    }
    nav li a .nav-icon { width: 18px; text-align: center; font-size: 14px; }
    nav li a:hover { background: var(--row-hover); }
    nav li a.active { background: var(--accent-soft); color: var(--accent); font-weight: 500; box-shadow: var(--glow-accent-soft); }

    /* The middle grid cell is now a flex column: the tab strip + the scrollable
       content pane (#content padding/scroll moved to styles/tabs.ts). */
    .content-wrap { display: flex; flex-direction: column; min-width: 0; overflow: hidden; }

`;
