// Auto-composed section of the GUI stylesheet. Verbatim substring of the original
// css template literal — do not hand-edit; see styles/index.ts for composition.
export const layoutCss = `    /* ── Layout ────────────────────────────────────────── */
    /* minmax(0, 1fr) on the content track lets a wide child (a table with
       chip-heavy cells) shrink instead of forcing the page wider than the
       viewport. Without the explicit 0 lower bound, the implicit auto
       minimum keeps the track at content-width and the whole page scrolls
       horizontally. */
    .layout {
      display: grid; grid-template-columns: var(--nav-width) minmax(0, 1fr) var(--outputs-width);
      height: calc(100vh - 56px);
    }
    @media (max-width: 720px) {
      #content { padding-bottom: 24px; }
    }
    nav.sidebar {
      background: var(--surface); border-right: 1px solid var(--border);
      /* No TOP padding: the Inputs column header must sit flush at the top, aligned
         with the Model + Outputs headers. Horizontal/bottom padding stays for the
         group content; the header breaks out to full width below. */
      padding: 0 10px 18px; overflow-y: auto;
    }
    /* The Inputs header spans the full column width (cancel the sidebar's side
       padding) and pins flush to the top, level with the other column headers. */
    nav.sidebar > .col-header { margin: 0 -10px 10px; }
    .section-label {
      font-size: 11px; font-weight: 600; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.06em;
      padding: 0 12px; margin: 12px 0 6px;
    }
    .section-label:first-child { margin-top: 0; }
    /* Extra breathing room above the "SYSTEM" heading so it isn't cramped
       against the object list above it. */
    #system-section .section-label { margin-top: 20px; }
    /* The section labels are collapse toggles (a <button> reusing the
       .section-label type styling). Strip native button chrome; lay the caret +
       label out in a row; the whole header is clickable. */
    button.section-label.section-toggle {
      display: flex; align-items: center; gap: 6px; width: 100%;
      background: none; border: 0; cursor: pointer; text-align: left; font: inherit;
      color: var(--text-muted);
      /* Caret at the gutter so the GROUP HEADER (caret + label) is the outermost
         element; its child rows are indented under it via .section-body below.
         Without this the caret + gap inset the header label past its own children,
         inverting the tree hierarchy. */
      padding-left: 0;
    }
    .section-toggle .section-caret {
      font-size: 9px; line-height: 1; color: var(--text-muted); width: 10px; flex: none;
    }
    .section-toggle:hover .section-label-text { color: var(--text); }
    /* Indent each group's body so its rows sit inset under the group header
       (must clear the header's caret + gap so the header label stays leftmost). */
    .section-body { padding-left: 20px; }
    .section-body[hidden] { display: none; }
    nav ul { list-style: none; padding: 0; margin: 0; }
    nav li a {
      display: flex; align-items: center; gap: 10px;
      padding: 7px 12px; border-radius: 6px;
      color: var(--text); font-size: 13.5px;
    }
    nav li a .nav-icon { width: 18px; text-align: center; font-size: 14px; }
    nav li a:hover { background: var(--row-hover); }
    nav li a.active { background: var(--accent-soft); color: var(--accent); font-weight: 500; box-shadow: none; }

    /* The middle grid cell is now a flex column: the tab strip + the scrollable
       content pane (#content padding/scroll moved to styles/tabs.ts). */
    .content-wrap { display: flex; flex-direction: column; min-width: 0; overflow: hidden; }

`;
