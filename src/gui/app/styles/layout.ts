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
    /* ── Column collapse (Inputs / Model / Outputs → thin rails) ─────── */
    .col-collapse {
      margin-left: auto; flex: none; width: 22px; height: 22px; padding: 0;
      display: inline-flex; align-items: center; justify-content: center;
      background: none; border: 0; border-radius: 6px; cursor: pointer;
      color: var(--text-muted); font-size: 13px; line-height: 1;
    }
    .col-collapse:hover { background: var(--surface-2); color: var(--text); }
    .col-collapse-center { margin-left: 8px; }
    /* Collapsed: hide the body, keep a thin header with just the re-expand button. */
    body.collapse-inputs nav.sidebar { overflow: hidden; }
    body.collapse-inputs nav.sidebar > *:not(.col-header) { display: none; }
    body.collapse-inputs .col-inputs { justify-content: center; }
    body.collapse-inputs .col-inputs .col-header-text { display: none; }
    body.collapse-inputs .col-inputs .col-collapse { margin: 0; transform: scaleX(-1); }
    body.collapse-outputs .outputs-body { display: none; }
    body.collapse-outputs .outputs-resize { display: none; }
    body.collapse-outputs .col-outputs { justify-content: center; }
    body.collapse-outputs .col-outputs .col-header-text { display: none; }
    body.collapse-outputs .col-outputs .col-collapse { margin: 0; transform: scaleX(-1); }
    body.collapse-model #content { display: none; }
    body.collapse-model .col-model .tabstrip-tabs,
    body.collapse-model .col-model .tabstrip-status { display: none; }
    body.collapse-model .col-model .col-header-text { display: none; }
    /* ── Global Wire / Merge (buttons above the tab line + drag feedback) ─── */
    .wm-actions { display: flex; align-items: center; gap: 6px; flex: none; margin: 0 8px; }
    .wm-btn {
      font-size: 12px; font-weight: 600; color: var(--text-muted);
      background: var(--surface-2); border: 1px solid var(--border);
      border-radius: 7px; padding: 4px 10px; cursor: pointer; white-space: nowrap;
    }
    .wm-btn:hover { color: var(--text); border-color: var(--accent); }
    .wm-btn.on { color: #fff; background: var(--accent); border-color: var(--accent); }
    .wm-picked { outline: 2px solid var(--accent); outline-offset: 1px; }
    .wm-drop-target { outline: 2px dashed var(--accent); outline-offset: 1px; }
    body.wm-drag-merge .wm-drop-target { outline-style: solid; outline-color: #f59e0b; }
    body.wm-dragging { cursor: grabbing; }
    body.wm-dragging .wm-drag-active { opacity: 0.6; }
    body.wm-active [data-table]:not([data-kind="file"]) { cursor: crosshair; }
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
