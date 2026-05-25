export const guiAppHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Lattice Browser</title>
  <style>
    :root {
      --bg: #f4f5f7;
      --surface: #ffffff;
      --border: #e2e5ea;
      --border-strong: #c9cdd4;
      --text: #1f2328;
      --text-muted: #6b7280;
      --accent: #2f6feb;
      --accent-soft: #e7efff;
      --row-hover: #f6f7fa;
      --shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: var(--text);
      background: var(--bg);
      font-size: 14px;
    }
    a { color: inherit; text-decoration: none; }
    button { font: inherit; cursor: pointer; }

    /* ── Top bar ───────────────────────────────────────── */
    header.topbar {
      display: flex; align-items: center; gap: 12px;
      min-height: 56px; padding: 8px 20px;
      background: #0b0d10; border-bottom: 1px solid #1f2328;
      color: #e6e8eb;
      flex-wrap: wrap;
    }
    .brand {
      display: inline-flex; align-items: center;
      flex-shrink: 0; border-radius: 6px;
      padding: 2px; cursor: pointer;
    }
    .brand:hover { background: rgba(255, 255, 255, 0.06); }
    .brand-logo { width: 32px; height: 32px; display: block; }

    /* History controls — dark variant */
    .history-controls { display: inline-flex; gap: 4px; }
    .history-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 32px; height: 32px;
      background: transparent; border: 1px solid #2a2f36;
      border-radius: 6px; cursor: pointer;
      color: #e6e8eb; font-size: 16px; text-decoration: none;
    }
    .history-btn:hover:not([disabled]) { background: rgba(255, 255, 255, 0.06); }
    .history-btn[disabled] { opacity: 0.35; cursor: not-allowed; }

    /* History page */
    .history-list {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 10px; overflow: hidden; max-width: 980px;
    }
    .history-entry { display: flex; gap: 16px; padding: 14px 18px; border-bottom: 1px solid var(--border); }
    .history-entry:last-child { border-bottom: none; }
    .history-entry.is-undone { background: #fafbfc; }
    .history-entry.is-undone .history-summary { color: var(--text-muted); text-decoration: line-through; }
    .history-meta { min-width: 200px; font-size: 12px; color: var(--text-muted); }
    .history-meta .history-op {
      display: inline-block; padding: 1px 8px;
      background: var(--accent-soft); color: var(--accent);
      border-radius: 8px; font-size: 11px; text-transform: uppercase;
      letter-spacing: 0.04em; font-weight: 600;
    }
    .history-op.op-delete { background: #fef3f2; color: #b42318; }
    .history-op.op-link, .history-op.op-unlink { background: #f3f0fe; color: #6941c6; }
    .history-summary { flex: 1; font-size: 13.5px; }
    .history-summary .history-table { font-weight: 600; }
    .history-diff {
      margin-top: 8px; font-family: ui-monospace, monospace; font-size: 12px;
      background: #fafbfc; border: 1px solid var(--border); border-radius: 6px;
      padding: 8px 10px; white-space: pre-wrap;
    }
    .history-diff .diff-add { color: #027a48; }
    .history-diff .diff-rem { color: #b42318; }
    .history-actions { display: flex; flex-direction: column; gap: 4px; }
    .history-actions .btn { font-size: 12px; height: 26px; padding: 0 10px; }
    #history-filter {
      height: 30px; padding: 0 10px; font: inherit; font-size: 13px;
      border: 1px solid var(--border-strong); border-radius: 6px; background: white;
    }

    /* DB switcher in the top bar */
    .db-switcher { position: relative; }
    .db-button {
      display: inline-flex; align-items: center; gap: 6px;
      height: 32px; padding: 0 10px;
      background: #1a1d22; color: #e6e8eb;
      border: 1px solid #2a2f36; border-radius: 6px;
      font-size: 13px; cursor: pointer;
    }
    .db-button:hover { background: rgba(255, 255, 255, 0.08); }
    .db-button .db-caret { color: #9aa1ad; font-size: 10px; }
    .db-menu {
      position: absolute; top: 38px; left: 0;
      min-width: 260px; background: var(--surface);
      border: 1px solid var(--border); border-radius: 8px;
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.12);
      z-index: 60; padding: 6px;
    }
    .db-menu .db-section { font-size: 11px; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.06em;
      padding: 8px 10px 4px; }
    .db-menu button.db-item {
      width: 100%; display: flex; align-items: center; gap: 8px;
      padding: 7px 10px; border: none; background: transparent; text-align: left;
      cursor: pointer; border-radius: 6px; font-size: 13.5px; color: var(--text);
    }
    .db-menu button.db-item:hover { background: var(--row-hover); }
    .db-menu button.db-item.active { background: var(--accent-soft); color: var(--accent); font-weight: 500; }
    .db-menu button.db-item .db-item-file { color: var(--text-muted); font-size: 12px; margin-left: auto; }
    .db-menu .db-create { padding: 6px 10px; border-top: 1px solid var(--border); margin-top: 4px; }
    .db-menu .db-create input {
      width: 100%; height: 30px; padding: 0 10px; font: inherit;
      border: 1px solid var(--border-strong); border-radius: 6px;
      background: white; margin-bottom: 6px;
    }

    /* ── Layout ────────────────────────────────────────── */
    .layout {
      display: grid; grid-template-columns: 220px 1fr;
      height: calc(100vh - 56px);
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
    nav ul { list-style: none; padding: 0; margin: 0; }
    nav li a {
      display: flex; align-items: center; gap: 10px;
      padding: 7px 12px; border-radius: 6px;
      color: var(--text); font-size: 13.5px;
    }
    nav li a .nav-icon { width: 18px; text-align: center; font-size: 14px; }
    nav li a:hover { background: var(--row-hover); }
    nav li a.active { background: var(--accent-soft); color: var(--accent); font-weight: 500; }

    main#content { padding: 24px; overflow: auto; }

    /* ── Dashboard ────────────────────────────────────── */
    .dashboard {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px;
      max-width: 1100px;
    }
    .card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 10px; padding: 22px;
      min-height: 160px;
      display: flex; flex-direction: column; gap: 8px;
      box-shadow: var(--shadow);
      transition: transform 0.05s ease, box-shadow 0.15s ease, border-color 0.15s ease;
    }
    .card:hover { border-color: var(--accent); box-shadow: 0 2px 6px rgba(47, 111, 235, 0.12); }
    .card-icon { font-size: 22px; }
    .card-label { font-size: 15px; font-weight: 600; }
    .card-count { font-size: 28px; font-weight: 700; color: var(--text-muted); margin-top: auto; }

    /* ── Table view ───────────────────────────────────── */
    .view-header {
      display: flex; align-items: center; gap: 10px;
      margin-bottom: 18px;
    }
    .view-header .entity-icon { font-size: 22px; line-height: 1; padding: 2px 0; }
    .view-header h1 { font-size: 22px; font-weight: 600; margin: 0; }
    .view-header .count { color: var(--text-muted); font-size: 13px; margin-left: 4px; }

    table {
      width: 100%; border-collapse: separate; border-spacing: 0;
      background: var(--surface);
      border: 1px solid var(--border); border-radius: 8px; overflow: hidden;
      box-shadow: var(--shadow);
    }
    thead th {
      text-align: left; font-weight: 600; font-size: 12.5px;
      color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em;
      padding: 12px 14px; background: #fafbfc;
      border-bottom: 1px solid var(--border);
    }
    tbody td {
      padding: 12px 14px; border-bottom: 1px solid var(--border);
      vertical-align: top; font-size: 13.5px;
    }
    tbody tr:last-child td { border-bottom: none; }
    tbody tr { cursor: pointer; }
    tbody tr:hover td { background: var(--row-hover); }
    td.muted { color: var(--text-muted); }
    .chip {
      display: inline-block; padding: 2px 8px; margin: 1px 3px 1px 0;
      background: var(--accent-soft); color: var(--accent);
      border-radius: 10px; font-size: 12px;
    }
    a.chip-link { cursor: pointer; }
    a.chip-link:hover { background: var(--accent); color: white; }
    .empty-row td {
      color: var(--text-muted); font-style: italic; text-align: center;
      padding: 24px;
    }

    /* ── Detail view ──────────────────────────────────── */
    .breadcrumb {
      font-size: 13px; color: var(--accent);
      margin-bottom: 14px; display: inline-block;
    }
    .breadcrumb:hover { text-decoration: underline; }
    .detail dl {
      display: grid; grid-template-columns: 180px 1fr;
      gap: 10px 24px;
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 8px; padding: 20px; box-shadow: var(--shadow);
      max-width: 900px;
    }
    .detail dt {
      font-size: 12.5px; color: var(--text-muted); text-transform: uppercase;
      letter-spacing: 0.04em; padding-top: 2px;
    }
    .detail dd { margin: 0; font-size: 14px; }

    /* ── Placeholder / data-model stub ─────────────────── */
    .placeholder {
      background: var(--surface); border: 1px dashed var(--border-strong);
      border-radius: 10px; padding: 40px;
      max-width: 600px; text-align: center;
      color: var(--text-muted);
    }
    .placeholder h2 { margin: 0 0 8px; color: var(--text); }

    /* Data Model: graph on top, edit panel below when an entity is selected. */
    .dm-layout {
      display: flex; flex-direction: column; gap: 20px;
    }
    #graph-mount { background: var(--surface);
      border: 1px solid var(--border); border-radius: 10px; padding: 16px;
      min-height: 60vh; overflow: hidden;
    }
    #graph-mount svg { width: 100%; height: 60vh; display: block; }
    #graph-mount g.gnode { cursor: pointer; }
    #graph-mount g.gnode circle { transition: fill 0.1s ease, stroke 0.1s ease; }
    #graph-mount g.gnode.active circle { fill: var(--accent); stroke: var(--accent); }
    #graph-mount g.gnode.active text { fill: var(--accent); font-weight: 600; }
    #dm-panel {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 10px; padding: 20px;
    }
    #dm-panel h3 { margin: 0 0 12px; font-size: 16px; }
    #dm-panel h4 { margin: 12px 0 6px; font-size: 12.5px;
      color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
    #dm-panel .breadcrumb { cursor: pointer; }
    ul.dm-rows { list-style: none; padding: 0; margin: 0; }
    ul.dm-rows li {
      padding: 8px 10px; border-radius: 6px; cursor: pointer;
      font-size: 13.5px; border: 1px solid transparent;
    }
    ul.dm-rows li:hover { background: var(--row-hover); border-color: var(--border); }
    .dm-junction { margin-bottom: 14px; }
    .dm-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
    .chip-removable {
      display: inline-flex; align-items: center; gap: 4px;
      background: var(--accent-soft); color: var(--accent);
      border-radius: 10px; padding: 2px 4px 2px 8px; font-size: 12px;
    }
    .chip-removable button {
      background: transparent; border: none; color: var(--accent);
      cursor: pointer; padding: 0 4px; font-size: 14px; line-height: 1;
      border-radius: 50%;
    }
    .chip-removable button:hover { background: rgba(47, 111, 235, 0.15); }
    select.dm-add { width: 100%; padding: 6px 10px; font: inherit;
      border: 1px solid var(--border-strong); border-radius: 6px; background: white; }

    /* Data Model entity-edit panel */
    .dm-section { margin: 10px 0; }
    .dm-section summary { cursor: pointer; font-size: 13px; padding: 6px 0;
      color: var(--text); list-style: none; }
    .dm-section summary::before {
      content: '▸'; display: inline-block; margin-right: 6px; color: var(--text-muted);
      transition: transform 0.1s;
    }
    .dm-section[open] summary::before { transform: rotate(90deg); }
    .dm-edit-grid {
      display: grid; grid-template-columns: 110px minmax(0, 1fr);
      gap: 10px 14px; align-items: center; font-size: 13px;
    }
    .dm-edit-grid > label {
      color: var(--text-muted); text-transform: uppercase;
      letter-spacing: 0.04em; font-size: 11px;
      align-self: start; padding-top: 9px;
    }
    .dm-edit-grid input, .dm-edit-grid select {
      padding: 7px 10px; font: inherit; border: 1px solid var(--border-strong);
      border-radius: 6px; background: white; font-size: 13.5px;
      min-width: 0;
    }
    .dm-row-inline { display: flex; gap: 8px; align-items: center; min-width: 0; }
    .dm-row-inline input { flex: 1 1 auto; min-width: 0; }
    .dm-row-inline select { flex: 0 0 110px; }
    .dm-row-inline .btn { height: 32px; font-size: 12.5px; padding: 0 12px; flex-shrink: 0; }
    .dm-cols { display: flex; flex-direction: column; gap: 6px; }
    .dm-col-row {
      display: grid; grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 8px; align-items: center;
    }
    .dm-col-row input {
      padding: 7px 10px; font: inherit; border: 1px solid var(--border);
      border-radius: 6px; background: white; font-size: 13.5px; min-width: 0;
    }
    .dm-col-row .dm-locked {
      padding: 7px 10px; font: inherit; font-size: 13.5px;
      color: var(--text-muted); background: #fafbfc;
      border: 1px dashed var(--border); border-radius: 6px;
      display: flex; align-items: center; gap: 8px;
    }
    .dm-col-row .dm-locked-label { font-size: 11px; text-transform: uppercase;
      letter-spacing: 0.04em; color: var(--text-muted); margin-left: auto; }
    .dm-col-rename { height: 32px; padding: 0 12px; font-size: 12.5px; }
    .dm-secret-toggle {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 11px; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.04em;
      white-space: nowrap; cursor: pointer;
    }
    .dm-secret-toggle input[type="checkbox"] { margin: 0; }

    /* Emoji picker (collapsed by default; click to drop down) */
    .emoji-picker { position: relative; display: inline-block; }
    .emoji-trigger {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 4px 8px 4px 10px; background: white;
      border: 1px solid var(--border-strong); border-radius: 6px;
      cursor: pointer; min-width: 70px;
    }
    .emoji-trigger:hover { background: var(--row-hover); }
    .emoji-trigger .emoji-preview { font-size: 22px; line-height: 1; }
    .emoji-trigger .emoji-caret { color: var(--text-muted); font-size: 10px; }
    .emoji-grid {
      position: absolute; top: 42px; left: 0; z-index: 70;
      display: grid; grid-template-columns: repeat(8, 36px); gap: 4px;
      background: var(--surface); padding: 8px; border-radius: 8px;
      border: 1px solid var(--border-strong);
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.12);
    }
    .emoji-grid[hidden] { display: none; }
    .emoji-tile {
      width: 36px; height: 36px;
      background: transparent; border: 1px solid transparent;
      border-radius: 6px; cursor: pointer;
      font-size: 18px; line-height: 1; padding: 0;
      display: flex; align-items: center; justify-content: center;
    }
    .emoji-tile:hover { background: var(--row-hover); border-color: var(--border); }
    .emoji-tile.active { background: var(--accent-soft); border-color: var(--accent); }

    /* ── Toast / undo banner ──────────────────────────── */
    .toast {
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      background: #1f2328; color: white;
      padding: 10px 18px; border-radius: 999px;
      display: flex; align-items: center; gap: 14px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
      z-index: 200; font-size: 13.5px;
      animation: toast-in 0.18s ease;
    }
    @keyframes toast-in {
      from { transform: translate(-50%, 8px); opacity: 0; }
      to   { transform: translate(-50%, 0);   opacity: 1; }
    }
    .toast .undo-link {
      color: #87b3ff; cursor: pointer; font-weight: 600;
      background: transparent; border: none; padding: 0; font: inherit;
    }
    .toast .undo-link:hover { color: white; }
    .toast .toast-dismiss {
      background: transparent; border: none; color: #9aa1ad;
      cursor: pointer; padding: 0 4px; font-size: 16px; line-height: 1;
    }
    .toast .toast-dismiss:hover { color: white; }

    /* ── Buttons ──────────────────────────────────────── */
    .btn {
      display: inline-flex; align-items: center; gap: 6px;
      height: 30px; padding: 0 12px;
      background: var(--surface); color: var(--text);
      border: 1px solid var(--border-strong); border-radius: 6px;
      font-size: 13px;
    }
    .btn:hover { background: var(--row-hover); }
    .btn.primary { background: var(--accent); color: white; border-color: var(--accent); }
    .btn.primary:hover { background: #1f5dd1; }
    .btn.danger { color: #b42318; border-color: #f2c4c0; }
    .btn.danger:hover { background: #fef3f2; }
    .btn.ghost { background: transparent; border-color: transparent; color: var(--text-muted); }
    .btn.ghost:hover { background: var(--row-hover); color: var(--text); }
    .view-header .actions { margin-left: auto; display: flex; gap: 8px; }

    /* Row delete / restore controls */
    .row-actions { width: 64px; text-align: center; white-space: nowrap; }
    .row-delete, .row-restore {
      background: transparent; border: none; color: var(--text-muted);
      font-size: 16px; cursor: pointer; padding: 4px 6px;
      border-radius: 4px;
    }
    tr:hover .row-delete { color: #b42318; }
    .row-delete:hover { background: #fef3f2; }
    .row-restore:hover { background: var(--accent-soft); color: var(--accent); }
    tr.row-deleted td { background: #fefbf3; color: var(--text-muted); }
    tr.row-deleted:hover td { background: #fcf5e3; }

    /* Inline create-row at the bottom of every table */
    tr.create-row td { background: #fafbfc; }
    tr.create-row input, tr.create-row textarea, tr.create-row select {
      width: 100%; padding: 6px 8px; font: inherit;
      border: 1px solid var(--border); border-radius: 4px; background: white;
    }
    tr.create-row textarea { min-height: 32px; resize: vertical; }
    tr.create-row #inline-create {
      height: 30px; width: 30px; padding: 0;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 18px;
    }

    /* Detail inputs (inline editing) */
    .detail dl.editing input,
    .detail dl.editing textarea {
      width: 100%; padding: 6px 9px; font: inherit;
      border: 1px solid var(--border-strong); border-radius: 6px; background: white;
    }
    .detail dl.editing textarea { min-height: 60px; resize: vertical; }

    /* ── Rendered context (per-row .md from Lattice) ──── */
    .context-block {
      margin-top: 24px; background: var(--surface);
      border: 1px solid var(--border); border-radius: 8px;
      max-width: 900px; box-shadow: var(--shadow);
    }
    .context-file { padding: 12px 18px; border-bottom: 1px solid var(--border); }
    .context-file:last-child { border-bottom: none; }
    .context-file-head {
      display: flex; align-items: baseline; gap: 8px;
      font-size: 12.5px; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.04em;
      margin-bottom: 6px;
    }
    .context-file-head .context-file-name { color: var(--text); font-weight: 600; text-transform: none; letter-spacing: 0; }
    .context-file pre {
      margin: 0; padding: 12px; background: #fafbfc;
      border: 1px solid var(--border); border-radius: 6px;
      font-family: ui-monospace, 'SF Mono', 'Menlo', Consolas, monospace;
      font-size: 12.5px; line-height: 1.55;
      white-space: pre-wrap; word-break: break-word;
    }
    .context-empty { padding: 16px 18px; color: var(--text-muted); font-style: italic; }

    /* ── Teams (Project Config + User Config) ───────────── */
    .teams-page { padding: 24px 28px; max-width: 1000px; }
    .teams-page h2 { margin: 0 0 4px 0; font-size: 22px; }
    .teams-page .lead { color: var(--text-muted); margin-bottom: 24px; font-size: 13.5px; }
    .teams-actions { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
    .team-card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 8px; padding: 16px 18px; margin-bottom: 14px;
      box-shadow: var(--shadow);
    }
    .team-card h3 {
      margin: 0 0 4px 0; font-size: 16px;
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
    }
    .team-card .team-meta { color: var(--text-muted); font-size: 12.5px; margin-bottom: 12px; }
    .team-card .team-meta code { font-family: ui-monospace, monospace; font-size: 12px; }
    .team-card .role-tag {
      display: inline-block; padding: 2px 8px; border-radius: 4px;
      font-size: 11px; font-weight: 600; text-transform: uppercase;
      background: var(--accent-soft); color: var(--accent);
    }
    .team-card .role-tag.role-member { background: #eef0f3; color: var(--text-muted); }
    .team-stats {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px;
      margin: 10px 0 14px 0;
    }
    .team-stat {
      background: #fafbfc; border: 1px solid var(--border); border-radius: 6px;
      padding: 8px 10px; text-align: center;
    }
    .team-stat .stat-label {
      font-size: 11px; text-transform: uppercase; color: var(--text-muted);
      letter-spacing: 0.04em; margin-bottom: 2px;
    }
    .team-stat .stat-value { font-size: 18px; font-weight: 600; }
    .team-card .team-actions { display: flex; gap: 6px; margin-top: 12px; flex-wrap: wrap; }
    .team-card .shared-list, .team-card .members-list {
      margin: 12px 0; border-top: 1px solid var(--border); padding-top: 12px;
    }
    .team-card .shared-list h4, .team-card .members-list h4 {
      margin: 0 0 8px 0; font-size: 13px; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600;
    }
    .shared-row, .member-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 8px; border-radius: 4px; font-size: 13px;
    }
    .shared-row:hover, .member-row:hover { background: var(--row-hover); }
    .shared-row .table-name { font-family: ui-monospace, monospace; }
    .teams-empty {
      padding: 32px; text-align: center; color: var(--text-muted);
      border: 1px dashed var(--border-strong); border-radius: 8px;
    }
    .danger-btn { background: #fff4f4; color: #b3231f; border-color: #f5c2c0; }
    .danger-btn:hover { background: #ffe4e4; }

    /* Modal — used by the teams flows. Self-contained so it doesn't
       collide with any modal styles the GUI agent may add later. */
    .modal-backdrop {
      position: fixed; inset: 0; background: rgba(15, 23, 42, 0.32);
      display: flex; align-items: center; justify-content: center;
      z-index: 1000;
    }
    .modal {
      background: var(--surface); border-radius: 10px;
      box-shadow: 0 10px 30px rgba(15, 23, 42, 0.18);
      min-width: 420px; max-width: 560px; max-height: 80vh;
      display: flex; flex-direction: column; overflow: hidden;
    }
    .modal-head {
      padding: 14px 18px; border-bottom: 1px solid var(--border);
      font-size: 15px; font-weight: 600;
    }
    .modal-body {
      padding: 16px 18px; overflow-y: auto; flex: 1;
    }
    .modal-foot {
      padding: 12px 18px; border-top: 1px solid var(--border);
      display: flex; gap: 8px; justify-content: flex-end;
    }
    .modal-foot .btn {
      padding: 6px 14px; border: 1px solid var(--border-strong);
      border-radius: 6px; background: var(--surface); color: var(--text);
    }
    .modal-foot .btn:hover { background: var(--row-hover); }
    .modal-foot .btn.primary {
      background: var(--accent); color: white; border-color: var(--accent);
    }
    .modal-foot .btn.primary:hover { background: #1f56c2; }
    .modal .field { margin-bottom: 12px; }
    .modal .field label {
      display: block; margin-bottom: 4px; font-size: 12px;
      color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em;
    }
    .modal .field input, .modal .field textarea {
      width: 100%; padding: 6px 8px; border: 1px solid var(--border-strong);
      border-radius: 4px; font: inherit;
    }
    .modal .field textarea { min-height: 60px; font-family: ui-monospace, monospace; font-size: 12px; }
    .modal .copy-token {
      padding: 8px 10px; background: #fafbfc; border: 1px solid var(--border);
      border-radius: 4px; font-family: ui-monospace, monospace; font-size: 12px;
      word-break: break-all; cursor: pointer;
    }
    .modal .copy-token:hover { background: var(--row-hover); }
  </style>
</head>
<body>
  <header class="topbar">
    <a class="brand" href="#/" title="Go to dashboard" aria-label="Lattice — dashboard">
      <svg class="brand-logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect width="24" height="24" rx="4" fill="#0b0d10"/>
        <line x1="6" y1="6" x2="18" y2="6" stroke="#bef264" stroke-width="0.5" opacity="0.4"/>
        <line x1="6" y1="12" x2="18" y2="12" stroke="#bef264" stroke-width="0.5" opacity="0.4"/>
        <line x1="6" y1="18" x2="18" y2="18" stroke="#bef264" stroke-width="0.5" opacity="0.4"/>
        <line x1="6" y1="6" x2="6" y2="18" stroke="#bef264" stroke-width="0.5" opacity="0.4"/>
        <line x1="12" y1="6" x2="12" y2="18" stroke="#bef264" stroke-width="0.5" opacity="0.4"/>
        <line x1="18" y1="6" x2="18" y2="18" stroke="#bef264" stroke-width="0.5" opacity="0.4"/>
        <circle cx="6" cy="6" r="1.5" fill="#bef264"/>
        <circle cx="12" cy="6" r="1.5" fill="#bef264"/>
        <circle cx="18" cy="6" r="1.5" fill="#bef264"/>
        <circle cx="6" cy="12" r="1.5" fill="#bef264"/>
        <circle cx="12" cy="12" r="2" fill="#bef264"/>
        <circle cx="18" cy="12" r="1.5" fill="#bef264"/>
        <circle cx="6" cy="18" r="1.5" fill="#bef264"/>
        <circle cx="12" cy="18" r="1.5" fill="#bef264"/>
        <circle cx="18" cy="18" r="1.5" fill="#bef264"/>
      </svg>
    </a>
    <div class="history-controls">
      <button class="history-btn" id="undo-btn" title="Undo" disabled>↶</button>
      <button class="history-btn" id="redo-btn" title="Redo" disabled>↷</button>
      <a class="history-btn" id="history-link" href="#/settings/history" title="Version history">📜</a>
    </div>
    <div class="db-switcher">
      <button class="db-button" id="db-button" title="Switch database">
        <span class="db-icon">💾</span>
        <span class="db-name" id="db-name">loading…</span>
        <span class="db-caret">▾</span>
      </button>
      <div class="db-menu" id="db-menu" hidden></div>
    </div>
  </header>
  <div class="layout">
    <nav class="sidebar">
      <div class="section-label">Objects</div>
      <ul id="object-nav"></ul>
      <div class="section-label">System</div>
      <ul id="system-nav"></ul>
      <div class="section-label">Settings</div>
      <ul id="settings-nav">
        <li><a href="#/settings/data-model"><span class="nav-icon">⚙</span> Data Model</a></li>
        <li><a href="#/settings/project-config"><span class="nav-icon">⚙</span> Project Config</a></li>
        <li><a href="#/settings/user-config"><span class="nav-icon">👤</span> User Config</a></li>
      </ul>
    </nav>
    <main id="content"></main>
  </div>

  <script>
  (function () {
    // ────────────────────────────────────────────────────────────
    // Display config — labels + icons. Anything missing falls back
    // to title-case of the table name and a generic dot.
    // ────────────────────────────────────────────────────────────
    var DISPLAY = {
      meetings:     { label: 'Meetings',     icon: '📅' },
      people:       { label: 'People',       icon: '👥' },
      messages:     { label: 'Messages',     icon: '✉️' },
      projects:     { label: 'Projects',     icon: '📦' },
      repositories: { label: 'Repositories', icon: '💿' },
      files:        { label: 'Files',        icon: '📄' },
      secrets:      { label: 'Secrets',      icon: '🔐' },
    };
    // Cards shown on the dashboard (Secrets is sidebar-only by design).
    var DASHBOARD_ORDER = ['meetings', 'people', 'messages', 'projects', 'repositories', 'files'];

    var FIELD_DISPLAY = {
      starts_at: 'Date+Time',
      sent_at:   'Sent',
      role:      'Role',
      url:       'URL',
      path:      'Path',
      kind:      'Kind',
    };

    // Generic fallback icon when the user hasn't set one and the entity
    // name isn't in the built-in DISPLAY map.
    var DEFAULT_ICON = '📋';

    var state = { entities: null, rowCache: {}, iconOverrides: {}, columnMeta: {}, systemTables: [] };

    function isSecretColumn(tableName, colName) {
      var t = state.columnMeta[tableName];
      return !!(t && t[colName] && t[colName].secret);
    }
    var SECRET_MASK = '••••••••'; // ••••••••

    function displayFor(name) {
      var override = state.iconOverrides[name];
      var base = DISPLAY[name];
      var icon = (override && override.icon) || (base && base.icon) || DEFAULT_ICON;
      var label = (base && base.label) || titleCase(name);
      return { label: label, icon: icon };
    }
    function titleCase(s) {
      return s.replace(/_/g, ' ').replace(/\\b\\w/g, function (c) { return c.toUpperCase(); });
    }
    function fieldLabel(col) {
      return FIELD_DISPLAY[col] || titleCase(col);
    }

    function escapeHtml(v) {
      if (v == null) return '';
      return String(v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function truncate(s, n) {
      if (s == null) return '';
      s = String(s);
      return s.length > n ? s.slice(0, n) + '…' : s;
    }

    function isJunction(table) {
      var rels = Object.values(table.relations || {});
      return rels.length === 2 && rels.every(function (r) { return r.type === 'belongsTo'; });
    }

    function tableByName(name) {
      return state.entities.tables.find(function (t) { return t.name === name; });
    }

    function fetchJson(url, opts) {
      return fetch(url, opts).then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || r.statusText); });
        return r.json();
      });
    }

    // ────────────────────────────────────────────────────────────
    // Boot
    // ────────────────────────────────────────────────────────────
    function init() {
      Promise.all([
        fetchJson('/api/entities'),
        fetchJson('/api/gui-meta').catch(function () { return {}; }),
        fetchJson('/api/databases').catch(function () { return null; }),
        fetchJson('/api/gui-meta/columns').catch(function () { return {}; }),
        fetchJson('/api/system-tables').catch(function () { return { tables: [] }; }),
      ]).then(function (results) {
        state.entities = results[0];
        state.iconOverrides = results[1] || {};
        state.columnMeta = results[3] || {};
        state.systemTables = (results[4] && results[4].tables) || [];
        renderDbSwitcher(results[2]);
        renderSidebar();
        wireHistoryControls();
        refreshHistoryState();
        renderRoute();
      }).catch(function (err) {
        document.getElementById('content').innerHTML =
          '<div class="placeholder"><h2>Failed to load</h2>' + escapeHtml(err.message) + '</div>';
      });
    }

    /** Reload column meta after a secret-flag change. */
    function refreshColumnMeta() {
      return fetchJson('/api/gui-meta/columns').then(function (d) {
        state.columnMeta = d || {};
      });
    }

    // ────────────────────────────────────────────────────────────
    // Toast banner (with optional one-click undo)
    // ────────────────────────────────────────────────────────────
    var activeToast = null;
    var toastDismissTimer = null;
    function showToast(message, opts) {
      opts = opts || {};
      if (activeToast) activeToast.remove();
      if (toastDismissTimer) clearTimeout(toastDismissTimer);
      var toast = document.createElement('div');
      toast.className = 'toast';
      var undoBtn = opts.undo ? '<button class="undo-link" type="button">Undo</button>' : '';
      toast.innerHTML =
        '<span>' + escapeHtml(message) + '</span>' +
        undoBtn +
        '<button class="toast-dismiss" type="button" title="Dismiss">×</button>';
      document.body.appendChild(toast);
      activeToast = toast;

      function close() {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
        if (activeToast === toast) activeToast = null;
      }
      toast.querySelector('.toast-dismiss').addEventListener('click', close);
      if (opts.undo) {
        toast.querySelector('.undo-link').addEventListener('click', function () {
          close();
          if (toastDismissTimer) clearTimeout(toastDismissTimer);
          opts.undo();
        });
      }
      toastDismissTimer = setTimeout(close, opts.duration || 6000);
    }

    /** Standard undo: hit /api/history/undo and refresh views. */
    function undoLast() {
      return fetchJson('/api/history/undo', { method: 'POST' })
        .then(afterMutation)
        .catch(function (err) { showToast('Undo failed: ' + err.message, {}); });
    }

    // ────────────────────────────────────────────────────────────
    // Version history (undo / redo / log)
    // ────────────────────────────────────────────────────────────
    function wireHistoryControls() {
      document.getElementById('undo-btn').addEventListener('click', function () {
        fetchJson('/api/history/undo', { method: 'POST' })
          .then(function () { return afterMutation(); })
          .then(function () { showToast('Last change undone', {}); })
          .catch(function (err) { showToast('Undo failed: ' + err.message, {}); });
      });
      document.getElementById('redo-btn').addEventListener('click', function () {
        fetchJson('/api/history/redo', { method: 'POST' })
          .then(function () { return afterMutation(); })
          .then(function () { showToast('Redone', {}); })
          .catch(function (err) { showToast('Redo failed: ' + err.message, {}); });
      });
    }

    /**
     * Re-fetch everything that might have changed and re-render. Used after
     * any mutation that goes through the audit log: row CRUD, link/unlink,
     * undo, redo, revert.
     */
    function afterMutation() {
      loadedTables = {};
      return Promise.all([
        fetchJson('/api/entities'),
        refreshHistoryState(),
      ]).then(function (r) {
        state.entities = r[0];
        renderSidebar();
        renderRoute();
      });
    }

    function refreshHistoryState() {
      return fetchJson('/api/history?limit=1').then(function (h) {
        document.getElementById('undo-btn').disabled = !h.canUndo;
        document.getElementById('redo-btn').disabled = !h.canRedo;
        return h;
      }).catch(function () { /* swallow */ });
    }

    /** Refetch everything after a DB switch and rerender. */
    function reloadEverything() {
      return Promise.all([
        fetchJson('/api/entities'),
        fetchJson('/api/gui-meta').catch(function () { return {}; }),
        fetchJson('/api/databases').catch(function () { return null; }),
        fetchJson('/api/gui-meta/columns').catch(function () { return {}; }),
        fetchJson('/api/system-tables').catch(function () { return { tables: [] }; }),
      ]).then(function (results) {
        state.entities = results[0];
        state.iconOverrides = results[1] || {};
        state.columnMeta = results[3] || {};
        state.systemTables = (results[4] && results[4].tables) || [];
        renderDbSwitcher(results[2]);
        renderSidebar();
        if (location.hash !== '#/') location.hash = '#/';
        else renderRoute();
        loadedTables = {};
      });
    }

    function renderDbSwitcher(data) {
      var btn = document.getElementById('db-button');
      var menu = document.getElementById('db-menu');
      var nameEl = document.getElementById('db-name');
      if (!data) {
        nameEl.textContent = '(no databases endpoint)';
        return;
      }
      nameEl.textContent = data.current.dbFile;

      function buildMenu() {
        var items = data.configs.map(function (c) {
          return '<button class="db-item' + (c.active ? ' active' : '') +
            '" data-path="' + escapeHtml(c.path) + '">' +
            '<span>' + escapeHtml(c.name) + '</span>' +
            '<span class="db-item-file">' + escapeHtml(c.dbFile) + '</span>' +
            '</button>';
        }).join('');
        menu.innerHTML =
          '<div class="db-section">Available databases</div>' +
          items +
          '<div class="db-section">Create new</div>' +
          '<div class="db-create">' +
            '<input id="db-create-name" type="text" placeholder="e.g. scratch, demo-2" maxlength="48" />' +
            '<button class="btn primary" id="db-create-btn" style="width:100%;">Create blank database</button>' +
          '</div>';
        menu.querySelectorAll('button.db-item').forEach(function (b) {
          b.addEventListener('click', function () {
            var path = b.getAttribute('data-path');
            if (path === data.current.path) { menu.hidden = true; return; }
            fetchJson('/api/databases/switch', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ path: path }),
            }).then(function () {
              menu.hidden = true;
              return reloadEverything();
            }).then(function () {
              showToast('Switched database', {});
            }).catch(function (err) { showToast('Switch failed: ' + err.message, {}); });
          });
        });
        document.getElementById('db-create-btn').addEventListener('click', function () {
          var nameInput = document.getElementById('db-create-name');
          var name = nameInput.value.trim();
          if (!name) { nameInput.focus(); return; }
          fetchJson('/api/databases/create', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: name }),
          }).then(function () {
            menu.hidden = true;
            return reloadEverything();
          }).then(function () {
            showToast('Database "' + name + '" created', {});
          }).catch(function (err) { showToast('Create failed: ' + err.message, {}); });
        });
      }

      btn.onclick = function (e) {
        e.stopPropagation();
        if (menu.hidden) buildMenu();
        menu.hidden = !menu.hidden;
      };
      document.addEventListener('click', function (e) {
        if (menu.hidden) return;
        if (!menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
          menu.hidden = true;
        }
      });
    }

    /** Reload icon overrides after a save, then re-render the current view. */
    function refreshIcons() {
      return fetchJson('/api/gui-meta').then(function (data) {
        state.iconOverrides = data || {};
        renderSidebar();
        renderRoute();
      });
    }

    window.addEventListener('hashchange', renderRoute);

    // ────────────────────────────────────────────────────────────
    // Sidebar
    // ────────────────────────────────────────────────────────────
    function renderSidebar() {
      var ul = document.getElementById('object-nav');
      var firstClass = state.entities.tables.filter(function (t) { return !isJunction(t); });
      ul.innerHTML = firstClass.map(function (t) {
        var d = displayFor(t.name);
        return '<li><a data-route="#/objects/' + t.name + '" href="#/objects/' + t.name +
          '"><span class="nav-icon">' + d.icon + '</span> ' + escapeHtml(d.label) + '</a></li>';
      }).join('');

      var sys = document.getElementById('system-nav');
      sys.innerHTML = (state.systemTables || []).map(function (t) {
        return '<li><a data-route="#/system/' + t.name + '" href="#/system/' + t.name +
          '"><span class="nav-icon">⚙</span> ' + escapeHtml(t.name) + '</a></li>';
      }).join('');

      highlightActive();
    }

    function highlightActive() {
      var hash = location.hash || '#/';
      document.querySelectorAll('nav a').forEach(function (a) {
        var route = a.getAttribute('data-route') || a.getAttribute('href');
        a.classList.toggle('active', route && hash.indexOf(route) === 0);
      });
    }

    // ────────────────────────────────────────────────────────────
    // Routing
    // ────────────────────────────────────────────────────────────
    function renderRoute() {
      if (!state.entities) return;
      highlightActive();
      var content = document.getElementById('content');
      var hash = location.hash || '#/';

      if (hash === '#/' || hash === '') { renderDashboard(content); return; }

      var m = /^#\\/objects\\/([^/]+)(?:\\/(.+))?$/.exec(hash);
      if (m) {
        if (m[2]) renderDetail(content, m[1], m[2]);
        else      renderTable(content, m[1]);
        return;
      }

      var sm = /^#\\/system\\/([^/]+)$/.exec(hash);
      if (sm) { renderSystemTable(content, sm[1]); return; }

      if (hash === '#/settings/data-model') { renderDataModel(content); return; }
      if (hash === '#/settings/history') { renderHistory(content); return; }
      if (hash === '#/settings/project-config') { renderProjectConfig(content); return; }
      if (hash === '#/settings/user-config') { renderUserConfig(content); return; }
      content.innerHTML = '<div class="placeholder"><h2>Unknown route</h2></div>';
    }

    // ────────────────────────────────────────────────────────────
    // Dashboard
    // ────────────────────────────────────────────────────────────
    function renderDashboard(content) {
      var cards = DASHBOARD_ORDER.map(function (name) {
        var t = tableByName(name);
        if (!t) return '';
        var d = displayFor(name);
        var count = (t.rowCount != null) ? t.rowCount : 0;
        return '<a class="card" href="#/objects/' + name + '">' +
          '<div class="card-icon">' + d.icon + '</div>' +
          '<div class="card-label">' + escapeHtml(d.label) + '</div>' +
          '<div class="card-count">' + count + '</div>' +
          '</a>';
      }).join('');
      content.innerHTML = '<div class="dashboard">' + cards + '</div>';
    }

    // ────────────────────────────────────────────────────────────
    // Table view
    // ────────────────────────────────────────────────────────────
    function intrinsicColumns(table) {
      // Drop id + foreign-key columns (rendered as belongsTo relations instead).
      var fkCols = new Set();
      Object.values(table.relations || {}).forEach(function (r) {
        if (r.type === 'belongsTo') fkCols.add(r.foreignKey);
      });
      return table.columns.filter(function (c) { return c !== 'id' && !fkCols.has(c); });
    }

    function belongsToColumns(table) {
      return Object.entries(table.relations || {})
        .filter(function (kv) { return kv[1].type === 'belongsTo'; })
        .map(function (kv) { return { relName: kv[0], rel: kv[1] }; });
    }

    function junctionsFor(tableName) {
      // Junctions where the LEFT side is this table.
      var out = [];
      state.entities.tables.forEach(function (t) {
        if (!isJunction(t)) return;
        var rels = Object.values(t.relations);
        var here = rels.find(function (r) { return r.table === tableName; });
        var other = rels.find(function (r) { return r.table !== tableName; });
        if (here && other) out.push({ junction: t.name, localFk: here.foreignKey, remoteRel: other });
      });
      return out;
    }

    function displayNameFor(row) {
      if (!row) return '';
      return row.name || row.title || row.url || row.path || row.id || '';
    }

    /**
     * Render a clickable chip linking to the detail page of a row in another
     * table. Used for belongsTo cells and junction-derived cells so the user
     * can navigate to the related object with one click.
     */
    function chipLink(table, row) {
      if (!row) return '<span class="muted">—</span>';
      return '<a class="chip chip-link" href="#/objects/' + encodeURIComponent(table) +
        '/' + encodeURIComponent(row.id) + '">' + escapeHtml(displayNameFor(row)) + '</a>';
    }

    var loadedTables = {};
    function loadAllRows(tableName) {
      if (loadedTables[tableName]) return Promise.resolve(loadedTables[tableName]);
      return fetchJson('/api/tables/' + encodeURIComponent(tableName) + '/rows').then(function (d) {
        loadedTables[tableName] = d.rows;
        return d.rows;
      });
    }

    /** Force a fresh fetch — used for views that need to opt in/out of soft-delete filtering. */
    function fetchRows(tableName, deletedMode) {
      var url = '/api/tables/' + encodeURIComponent(tableName) + '/rows';
      if (deletedMode) url += '?deleted=' + encodeURIComponent(deletedMode);
      return fetchJson(url).then(function (d) { return d.rows; });
    }

    /**
     * Invalidate cached rows for one or more tables. Call after any mutation
     * so the next renderTable / renderDetail re-fetches from the server.
     */
    function invalidate(tableNames) {
      (Array.isArray(tableNames) ? tableNames : [tableNames]).forEach(function (n) {
        delete loadedTables[n];
      });
    }

    /**
     * Refresh /api/entities (dashboard row counts) AND the undo/redo button
     * state after a mutation. Called by every CRUD handler.
     */
    function refreshEntities() {
      return Promise.all([
        fetchJson('/api/entities').then(function (d) { state.entities = d; }),
        refreshHistoryState(),
      ]);
    }

    function fieldFor(col, value, table) {
      // Render an input element for a column. belongsTo FK columns become a
      // <select> over the referenced table's rows (must already be cached).
      var belongsTo = belongsToColumns(table).find(function (b) { return b.rel.foreignKey === col; });
      if (belongsTo) {
        var rows = loadedTables[belongsTo.rel.table] || [];
        var options = '<option value="">(none)</option>' + rows.map(function (r) {
          var sel = (r.id === value) ? ' selected' : '';
          return '<option value="' + escapeHtml(r.id) + '"' + sel + '>' + escapeHtml(displayNameFor(r)) + '</option>';
        }).join('');
        return '<select name="' + escapeHtml(col) + '">' + options + '</select>';
      }
      // Secret columns: use a password input so the value is masked while editing.
      if (isSecretColumn(table.name, col)) {
        return '<input type="password" name="' + escapeHtml(col) + '" value="' +
          escapeHtml(value || '') + '" autocomplete="off" />';
      }
      // Multiline for known long-form fields.
      if (col === 'transcript' || col === 'summary' || col === 'body') {
        return '<textarea name="' + escapeHtml(col) + '">' + escapeHtml(value || '') + '</textarea>';
      }
      return '<input type="text" name="' + escapeHtml(col) + '" value="' + escapeHtml(value || '') + '" />';
    }

    function collectFormValues(scope) {
      var out = {};
      scope.querySelectorAll('[name]').forEach(function (el) {
        var v = el.value;
        out[el.getAttribute('name')] = v === '' ? null : v;
      });
      return out;
    }

    // Per-table view state: 'live' (default) or 'trash' (soft-deleted rows).
    var tableViewMode = {};

    function renderTable(content, tableName) {
      var t = tableByName(tableName);
      if (!t) {
        content.innerHTML = '<div class="placeholder">Unknown entity: ' + escapeHtml(tableName) + '</div>';
        return;
      }
      var d = displayFor(tableName);
      var intrinsic = intrinsicColumns(t);
      var belongsTo = belongsToColumns(t);
      var junctions = junctionsFor(tableName);
      var supportsSoftDelete = (t.columns || []).indexOf('deleted_at') !== -1;
      var viewMode = tableViewMode[tableName] || 'live';
      // Fetch this entity's rows fresh (mode-aware), plus relation tables (live only) for chips.
      var fetches = [fetchRows(tableName, viewMode === 'trash' ? 'only' : '')];
      belongsTo.forEach(function (b) { fetches.push(loadAllRows(b.rel.table)); });
      junctions.forEach(function (j) {
        fetches.push(loadAllRows(j.junction));
        fetches.push(loadAllRows(j.remoteRel.table));
      });

      Promise.all(fetches).then(function (results) {
        var rows = results[0];
        var headers = intrinsic.map(fieldLabel)
          .concat(belongsTo.map(function (b) { return titleCase(b.relName); }))
          .concat(junctions.map(function (j) { return titleCase(j.remoteRel.table); }))
          .map(function (h) { return '<th>' + escapeHtml(h) + '</th>'; }).join('');
        headers += '<th class="row-actions"></th>';

        var bodyRows;
        if (rows.length === 0) {
          bodyRows = '';
        } else {
          bodyRows = rows.map(function (r) {
            var tds = intrinsic.map(function (c) {
              if (isSecretColumn(tableName, c) && r[c] != null && r[c] !== '') {
                return '<td class="muted">' + SECRET_MASK + '</td>';
              }
              return '<td>' + escapeHtml(truncate(r[c], 120)) + '</td>';
            });
            belongsTo.forEach(function (b) {
              var ref = (loadedTables[b.rel.table] || []).find(function (x) { return x.id === r[b.rel.foreignKey]; });
              tds.push('<td>' + chipLink(b.rel.table, ref) + '</td>');
            });
            junctions.forEach(function (j) {
              var matches = (loadedTables[j.junction] || []).filter(function (jr) { return jr[j.localFk] === r.id; });
              var remoteFkCol = j.remoteRel.foreignKey;
              var chips = matches.map(function (jr) {
                var ref = (loadedTables[j.remoteRel.table] || []).find(function (x) { return x.id === jr[remoteFkCol]; });
                return ref ? chipLink(j.remoteRel.table, ref) : '';
              }).join('');
              tds.push('<td>' + (chips || '<span class="muted">—</span>') + '</td>');
            });
            if (viewMode === 'trash') {
              tds.push('<td class="row-actions">' +
                '<button class="row-restore" title="Restore" data-restore="' + escapeHtml(r.id) + '">↺</button>' +
                '<button class="row-delete" title="Delete permanently" data-hard-del="' + escapeHtml(r.id) + '">✕</button>' +
                '</td>');
            } else {
              tds.push('<td class="row-actions"><button class="row-delete" title="Delete" data-del="' + escapeHtml(r.id) + '">✕</button></td>');
            }
            return '<tr data-id="' + escapeHtml(r.id) + '"' + (viewMode === 'trash' ? ' class="row-deleted"' : '') + '>' + tds.join('') + '</tr>';
          }).join('');
        }

        // Inline "+ new" row at the bottom of the table. Intrinsic + belongsTo
        // columns become inputs; junctions show a dim placeholder (links happen
        // via the Data Model page); the last cell is the create control.
        var createCells = intrinsic.map(function (c) {
          return '<td>' + fieldFor(c, '', t) + '</td>';
        });
        belongsTo.forEach(function (b) {
          createCells.push('<td>' + fieldFor(b.rel.foreignKey, '', t) + '</td>');
        });
        junctions.forEach(function () {
          createCells.push('<td><span class="muted">add after create</span></td>');
        });
        createCells.push('<td class="row-actions"><button class="btn primary" id="inline-create" title="Create">+</button></td>');
        var createRow = '<tr class="create-row">' + createCells.join('') + '</tr>';

        var trashToggle = supportsSoftDelete
          ? '<div class="actions"><button class="btn ghost" id="toggle-trash">' +
              (viewMode === 'trash' ? '← Back to live' : 'Show trash') +
            '</button></div>'
          : '';

        content.innerHTML =
          '<div class="view-header">' +
            '<span class="entity-icon">' + d.icon + '</span>' +
            '<h1>' + escapeHtml(d.label) + (viewMode === 'trash' ? ' · Trash' : '') + '</h1>' +
            '<span class="count">' + rows.length + ' row' + (rows.length === 1 ? '' : 's') + '</span>' +
            trashToggle +
          '</div>' +
          '<table>' +
            '<thead><tr>' + headers + '</tr></thead>' +
            '<tbody>' + bodyRows + (viewMode === 'trash' ? '' : createRow) + '</tbody>' +
          '</table>';

        if (supportsSoftDelete) {
          document.getElementById('toggle-trash').addEventListener('click', function () {
            tableViewMode[tableName] = viewMode === 'trash' ? 'live' : 'trash';
            renderTable(content, tableName);
          });
        }

        if (viewMode === 'live') document.getElementById('inline-create').addEventListener('click', function () {
          var values = collectFormValues(content.querySelector('tr.create-row'));
          // Strip empty optional fields so they're left to DB defaults.
          Object.keys(values).forEach(function (k) {
            if (values[k] === null || values[k] === '') delete values[k];
          });
          fetchJson('/api/tables/' + encodeURIComponent(tableName) + '/rows', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(values),
          }).then(function () {
            invalidate(tableName);
            return refreshEntities();
          }).then(function () {
            renderTable(content, tableName);
            showToast(d.label.replace(/s$/, '') + ' created', { undo: undoLast });
          }).catch(function (err) {
            showToast('Create failed: ' + err.message, {});
          });
        });

        content.querySelectorAll('button.row-delete').forEach(function (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var softId = btn.getAttribute('data-del');
            var hardId = btn.getAttribute('data-hard-del');
            var id = softId || hardId;
            var hard = !!hardId;
            var url = '/api/tables/' + encodeURIComponent(tableName) + '/rows/' + encodeURIComponent(id);
            if (hard) url += '?hard=true';
            fetchJson(url, { method: 'DELETE' }).then(function () {
              invalidate(tableName);
              return refreshEntities();
            }).then(function () {
              renderTable(content, tableName);
              var msg = hard
                ? d.label.replace(/s$/, '') + ' permanently deleted'
                : d.label.replace(/s$/, '') + ' deleted';
              showToast(msg, { undo: undoLast });
            }).catch(function (err) {
              showToast('Delete failed: ' + err.message, {});
            });
          });
        });

        content.querySelectorAll('button.row-restore').forEach(function (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var id = btn.getAttribute('data-restore');
            fetchJson('/api/tables/' + encodeURIComponent(tableName) + '/rows/' + encodeURIComponent(id), {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ deleted_at: null }),
            }).then(function () {
              invalidate(tableName);
              return refreshEntities();
            }).then(function () {
              renderTable(content, tableName);
              showToast(d.label.replace(/s$/, '') + ' restored', { undo: undoLast });
            }).catch(function (err) {
              showToast('Restore failed: ' + err.message, {});
            });
          });
        });

        content.querySelectorAll('tr[data-id]').forEach(function (tr) {
          tr.addEventListener('click', function (e) {
            // Let chip-link anchors and the delete button handle their own click.
            if (e.target && e.target.closest('a, button')) return;
            location.hash = '#/objects/' + tableName + '/' + tr.getAttribute('data-id');
          });
        });
      }).catch(function (err) {
        content.innerHTML = '<div class="placeholder"><h2>Failed</h2>' + escapeHtml(err.message) + '</div>';
      });
    }

    // ────────────────────────────────────────────────────────────
    // Detail view (with edit / delete)
    // ────────────────────────────────────────────────────────────
    function renderDetail(content, tableName, id) {
      var t = tableByName(tableName);
      if (!t) {
        content.innerHTML = '<div class="placeholder">Unknown entity: ' + escapeHtml(tableName) + '</div>';
        return;
      }
      var d = displayFor(tableName);
      var intrinsic = intrinsicColumns(t);
      var belongsTo = belongsToColumns(t);
      var junctions = junctionsFor(tableName);

      var fetches = [
        fetchJson('/api/tables/' + encodeURIComponent(tableName) + '/rows/' + encodeURIComponent(id)),
      ];
      belongsTo.forEach(function (b) { fetches.push(loadAllRows(b.rel.table)); });
      junctions.forEach(function (j) {
        fetches.push(loadAllRows(j.junction));
        fetches.push(loadAllRows(j.remoteRel.table));
      });

      Promise.all(fetches).then(function (results) {
        var row = results[0];

        function paint(editing) {
          var rows = [];
          intrinsic.forEach(function (c) {
            var secret = isSecretColumn(tableName, c);
            var dd;
            if (editing) {
              dd = fieldFor(c, row[c], t);
            } else if (row[c] == null || row[c] === '') {
              dd = '<span class="muted">—</span>';
            } else if (secret) {
              dd = '<span class="muted">' + SECRET_MASK + '</span>';
            } else {
              dd = escapeHtml(row[c]);
            }
            rows.push('<dt>' + escapeHtml(fieldLabel(c)) + '</dt><dd>' + dd + '</dd>');
          });
          belongsTo.forEach(function (b) {
            var dd;
            if (editing) {
              dd = fieldFor(b.rel.foreignKey, row[b.rel.foreignKey], t);
            } else {
              var ref = (loadedTables[b.rel.table] || []).find(function (x) { return x.id === row[b.rel.foreignKey]; });
              dd = chipLink(b.rel.table, ref);
            }
            rows.push('<dt>' + escapeHtml(titleCase(b.relName)) + '</dt><dd>' + dd + '</dd>');
          });
          // Junctions: always editable inline. Click × on a chip to unlink,
          // pick from the dropdown to link. Mutations are atomic — no Save.
          junctions.forEach(function (j) {
            var matches = (loadedTables[j.junction] || []).filter(function (jr) { return jr[j.localFk] === row.id; });
            var linkedIds = new Set(matches.map(function (m) { return m[j.remoteRel.foreignKey]; }));
            var available = (loadedTables[j.remoteRel.table] || []).filter(function (o) { return !linkedIds.has(o.id); });
            var chips = matches.map(function (jr) {
              var remoteId = jr[j.remoteRel.foreignKey];
              var ref = (loadedTables[j.remoteRel.table] || []).find(function (x) { return x.id === remoteId; });
              if (!ref) return '';
              return '<span class="chip-removable"' +
                ' data-junction="' + escapeHtml(j.junction) + '"' +
                ' data-localfk="' + escapeHtml(j.localFk) + '"' +
                ' data-remotefk="' + escapeHtml(j.remoteRel.foreignKey) + '"' +
                ' data-local="' + escapeHtml(row.id) + '"' +
                ' data-remote="' + escapeHtml(remoteId) + '">' +
                '<a class="chip-link" href="#/objects/' + encodeURIComponent(j.remoteRel.table) +
                  '/' + encodeURIComponent(remoteId) + '">' + escapeHtml(displayNameFor(ref)) + '</a>' +
                ' <button class="remove-link" title="Unlink">×</button></span>';
            }).join(' ');
            var picker = available.length
              ? '<select class="dm-add"' +
                  ' data-junction="' + escapeHtml(j.junction) + '"' +
                  ' data-localfk="' + escapeHtml(j.localFk) + '"' +
                  ' data-remotefk="' + escapeHtml(j.remoteRel.foreignKey) + '"' +
                  ' data-local="' + escapeHtml(row.id) + '">' +
                '<option value="">+ Add link…</option>' +
                available.map(function (o) {
                  return '<option value="' + escapeHtml(o.id) + '">' + escapeHtml(displayNameFor(o)) + '</option>';
                }).join('') +
                '</select>'
              : '';
            rows.push('<dt>' + escapeHtml(titleCase(j.remoteRel.table)) + '</dt>' +
                      '<dd>' + (chips || '<span class="muted">None yet</span>') + ' ' + picker + '</dd>');
          });

          var actions = editing
            ? '<button class="btn primary" id="save-row">Save</button>' +
              '<button class="btn" id="cancel-edit">Cancel</button>'
            : '<button class="btn" id="edit-row">Edit</button>' +
              '<button class="btn danger" id="del-row">Delete</button>';

          content.innerHTML =
            '<a class="breadcrumb" href="#/objects/' + tableName + '">← ' + escapeHtml(d.label) + '</a>' +
            '<div class="view-header">' +
              '<span class="entity-icon">' + d.icon + '</span>' +
              '<h1>' + escapeHtml(displayNameFor(row) || d.label) + '</h1>' +
              '<div class="actions">' + actions + '</div>' +
            '</div>' +
            '<div class="detail"><dl class="' + (editing ? 'editing' : '') + '">' + rows.join('') + '</dl></div>' +
            '<div id="row-context"></div>';

          // Skip the context fetch while editing — the just-PATCHed row may
          // not have re-rendered yet, so we'd flash stale content.
          if (!editing) loadRowContext(tableName, id);

          // Junction link/unlink handlers (active in both read and edit modes).
          content.querySelectorAll('.remove-link').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
              e.preventDefault();
              e.stopPropagation();
              var chip = btn.closest('[data-junction]');
              var body = {};
              body[chip.getAttribute('data-localfk')] = chip.getAttribute('data-local');
              body[chip.getAttribute('data-remotefk')] = chip.getAttribute('data-remote');
              fetchJson('/api/tables/' + encodeURIComponent(chip.getAttribute('data-junction')) + '/unlink', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
              }).then(function () {
                invalidate(chip.getAttribute('data-junction'));
                return refreshEntities();
              }).then(function () {
                renderDetail(content, tableName, id);
                showToast('Link removed', { undo: undoLast });
              }).catch(function (err) { showToast('Unlink failed: ' + err.message, {}); });
            });
          });
          content.querySelectorAll('select.dm-add').forEach(function (sel) {
            sel.addEventListener('change', function () {
              if (!sel.value) return;
              var body = {};
              body[sel.getAttribute('data-localfk')] = sel.getAttribute('data-local');
              body[sel.getAttribute('data-remotefk')] = sel.value;
              fetchJson('/api/tables/' + encodeURIComponent(sel.getAttribute('data-junction')) + '/link', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
              }).then(function () {
                invalidate(sel.getAttribute('data-junction'));
                return refreshEntities();
              }).then(function () {
                renderDetail(content, tableName, id);
                showToast('Linked', { undo: undoLast });
              }).catch(function (err) { showToast('Link failed: ' + err.message, {}); });
            });
          });

          if (editing) {
            document.getElementById('cancel-edit').addEventListener('click', function () { paint(false); });
            document.getElementById('save-row').addEventListener('click', function () {
              var values = collectFormValues(content.querySelector('.detail dl'));
              fetchJson('/api/tables/' + encodeURIComponent(tableName) + '/rows/' + encodeURIComponent(id), {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(values),
              }).then(function () {
                invalidate(tableName);
                return refreshEntities();
              }).then(function () {
                renderDetail(content, tableName, id);
                showToast(d.label.replace(/s$/, '') + ' modified', { undo: undoLast });
              }).catch(function (err) {
                showToast('Save failed: ' + err.message, {});
              });
            });
          } else {
            document.getElementById('edit-row').addEventListener('click', function () { paint(true); });
            document.getElementById('del-row').addEventListener('click', function () {
              fetchJson('/api/tables/' + encodeURIComponent(tableName) + '/rows/' + encodeURIComponent(id), {
                method: 'DELETE',
              }).then(function () {
                invalidate(tableName);
                return refreshEntities();
              }).then(function () {
                location.hash = '#/objects/' + tableName;
                showToast(d.label.replace(/s$/, '') + ' deleted', { undo: undoLast });
              }).catch(function (err) {
                showToast('Delete failed: ' + err.message, {});
              });
            });
          }
        }

        paint(false);
      }).catch(function (err) {
        content.innerHTML = '<div class="placeholder"><h2>Failed</h2>' + escapeHtml(err.message) + '</div>';
      });
    }

    // ────────────────────────────────────────────────────────────
    // System tables (Lattice-internal — read-only browse view)
    // ────────────────────────────────────────────────────────────
    function renderSystemTable(content, tableName) {
      var entry = (state.systemTables || []).find(function (t) { return t.name === tableName; });
      if (!entry) {
        content.innerHTML = '<div class="placeholder">Unknown system table: ' + escapeHtml(tableName) + '</div>';
        return;
      }
      content.innerHTML =
        '<div class="view-header">' +
          '<span class="entity-icon">⚙</span>' +
          '<h1>' + escapeHtml(tableName) + '</h1>' +
          '<span class="count">' + entry.rowCount + ' row' + (entry.rowCount === 1 ? '' : 's') +
            ' · read-only</span>' +
        '</div>' +
        '<div class="muted" style="margin-bottom:12px;font-size:13px;">' +
          'Lattice-internal table — shown here for inspection only. The GUI does not allow editing.' +
        '</div>' +
        '<table id="system-table"><thead><tr></tr></thead><tbody></tbody></table>';

      fetchJson('/api/system-tables/' + encodeURIComponent(tableName) + '/rows').then(function (data) {
        var rows = data.rows || [];
        var cols = entry.columns;
        var thead = content.querySelector('#system-table thead tr');
        thead.innerHTML = cols.map(function (c) { return '<th>' + escapeHtml(c) + '</th>'; }).join('');
        var tbody = content.querySelector('#system-table tbody');
        if (rows.length === 0) {
          tbody.innerHTML = '<tr><td colspan="' + cols.length + '" class="muted" style="padding:24px;text-align:center;">Empty</td></tr>';
          return;
        }
        tbody.innerHTML = rows.map(function (r) {
          var tds = cols.map(function (c) {
            var v = r[c];
            if (v == null) return '<td class="muted">—</td>';
            var s = String(v);
            return '<td>' + escapeHtml(s.length > 200 ? s.slice(0, 200) + '…' : s) + '</td>';
          }).join('');
          return '<tr>' + tds + '</tr>';
        }).join('');
      }).catch(function (err) {
        content.querySelector('#system-table tbody').innerHTML =
          '<tr><td colspan="' + entry.columns.length + '" class="muted" style="padding:24px;">' +
          'Failed to load: ' + escapeHtml(err.message) + '</td></tr>';
      });
    }

    // ────────────────────────────────────────────────────────────
    // Version history page (#/settings/history)
    // ────────────────────────────────────────────────────────────
    var historyFilterTable = '';

    function renderHistory(content) {
      var firstClass = state.entities.tables
        .filter(function (t) { return !isJunction(t); })
        .map(function (t) { return t.name; });
      var options = '<option value="">All entities</option>' +
        firstClass.map(function (n) {
          var sel = n === historyFilterTable ? ' selected' : '';
          return '<option value="' + escapeHtml(n) + '"' + sel + '>' + escapeHtml(displayFor(n).label) + '</option>';
        }).join('');

      content.innerHTML =
        '<div class="view-header">' +
          '<span class="entity-icon">📜</span>' +
          '<h1>Version history</h1>' +
          '<div class="actions">' +
            '<select id="history-filter">' + options + '</select>' +
            '<button class="btn danger" id="history-revert-all" disabled>Revert all (filtered)</button>' +
          '</div>' +
        '</div>' +
        '<div class="history-list" id="history-list"><div class="muted" style="padding:20px;">Loading…</div></div>';

      var filterEl = document.getElementById('history-filter');
      filterEl.addEventListener('change', function () {
        historyFilterTable = filterEl.value;
        renderHistory(content);
      });

      var url = '/api/history?limit=500' +
        (historyFilterTable ? '&table=' + encodeURIComponent(historyFilterTable) : '');
      fetchJson(url).then(function (data) {
        var mount = document.getElementById('history-list');
        if (!data.entries || data.entries.length === 0) {
          mount.innerHTML = '<div class="muted" style="padding:24px;">' +
            (historyFilterTable
              ? 'No history yet for ' + escapeHtml(displayFor(historyFilterTable).label) + '.'
              : 'No history yet — make a change to see it here.') +
            '</div>';
          return;
        }
        mount.innerHTML = data.entries.map(historyEntryHtml).join('');

        // 'Revert all (filtered)' — only when a filter is active and at least
        // one live entry is showing.
        var liveFiltered = data.entries.filter(function (e) { return e.undone === 0; });
        var revertAllBtn = document.getElementById('history-revert-all');
        revertAllBtn.disabled = !(historyFilterTable && liveFiltered.length > 0);
        revertAllBtn.addEventListener('click', function () {
          // Walk newest → oldest so each revert undoes against the most-recent
          // version of the row.
          var queue = liveFiltered.slice();
          function next() {
            var e = queue.shift();
            if (!e) {
              afterMutation().then(function () {
                renderHistory(document.getElementById('content'));
                showToast('Reverted ' + liveFiltered.length + ' change' +
                  (liveFiltered.length === 1 ? '' : 's'), {});
              });
              return;
            }
            fetchJson('/api/history/revert/' + encodeURIComponent(e.id), { method: 'POST' })
              .then(next)
              .catch(function (err) { showToast('Bulk revert failed: ' + err.message, {}); });
          }
          next();
        });

        mount.querySelectorAll('button.history-revert').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-id');
            fetchJson('/api/history/revert/' + encodeURIComponent(id), { method: 'POST' })
              .then(afterMutation)
              .then(function () {
                renderHistory(document.getElementById('content'));
                showToast('Change reverted', {});
              })
              .catch(function (err) { showToast('Revert failed: ' + err.message, {}); });
          });
        });
      }).catch(function (err) {
        document.getElementById('history-list').innerHTML =
          '<div class="muted" style="padding:24px;">Failed to load: ' + escapeHtml(err.message) + '</div>';
      });
    }

    function historyEntryHtml(e) {
      var before = e.before_json ? safeParse(e.before_json) : null;
      var after = e.after_json ? safeParse(e.after_json) : null;
      var summary;
      var iconName = displayFor(e.table_name).label;
      switch (e.operation) {
        case 'insert': summary = 'Created in <span class="history-table">' + escapeHtml(iconName) + '</span>'; break;
        case 'update': summary = 'Updated <span class="history-table">' + escapeHtml(iconName) + '</span> row'; break;
        case 'delete': summary = 'Deleted from <span class="history-table">' + escapeHtml(iconName) + '</span>'; break;
        case 'link':   summary = 'Linked via <span class="history-table">' + escapeHtml(e.table_name) + '</span>'; break;
        case 'unlink': summary = 'Unlinked from <span class="history-table">' + escapeHtml(e.table_name) + '</span>'; break;
        default:       summary = escapeHtml(e.operation) + ' on ' + escapeHtml(e.table_name);
      }
      var diff = renderDiff(before, after);
      var actions = e.undone
        ? '<span class="muted" style="font-size:11px;">undone</span>'
        : '<button class="btn danger history-revert" data-id="' + escapeHtml(e.id) + '">Revert</button>';
      return '<div class="history-entry' + (e.undone ? ' is-undone' : '') + '">' +
        '<div class="history-meta">' +
          '<div><span class="history-op op-' + escapeHtml(e.operation) + '">' + escapeHtml(e.operation) + '</span></div>' +
          '<div style="margin-top:6px;">' + escapeHtml(formatTs(e.ts)) + '</div>' +
        '</div>' +
        '<div class="history-summary">' +
          summary +
          (diff ? '<div class="history-diff">' + diff + '</div>' : '') +
        '</div>' +
        '<div class="history-actions">' + actions + '</div>' +
      '</div>';
    }

    function safeParse(s) {
      try { return JSON.parse(s); } catch (_e) { return null; }
    }

    function formatTs(s) {
      if (!s) return '';
      try {
        var d = new Date(s);
        return d.toLocaleString();
      } catch (_e) { return s; }
    }

    /** Side-by-side-ish text diff. Shows changed columns only for updates. */
    function renderDiff(before, after) {
      if (!before && !after) return '';
      if (!before && after) {
        return Object.keys(after).map(function (k) {
          if (k === 'deleted_at' || after[k] == null) return '';
          return '<div class="diff-add">+ ' + escapeHtml(k) + ': ' + escapeHtml(String(after[k])) + '</div>';
        }).filter(Boolean).join('');
      }
      if (before && !after) {
        return Object.keys(before).map(function (k) {
          if (before[k] == null) return '';
          return '<div class="diff-rem">- ' + escapeHtml(k) + ': ' + escapeHtml(String(before[k])) + '</div>';
        }).filter(Boolean).join('');
      }
      var keys = new Set([].concat(Object.keys(before), Object.keys(after)));
      var lines = [];
      keys.forEach(function (k) {
        var b = before[k];
        var a = after[k];
        if (b === a || (b == null && a == null)) return;
        if (b == null) lines.push('<div class="diff-add">+ ' + escapeHtml(k) + ': ' + escapeHtml(String(a)) + '</div>');
        else if (a == null) lines.push('<div class="diff-rem">- ' + escapeHtml(k) + ': ' + escapeHtml(String(b)) + '</div>');
        else {
          lines.push('<div class="diff-rem">- ' + escapeHtml(k) + ': ' + escapeHtml(String(b)) + '</div>');
          lines.push('<div class="diff-add">+ ' + escapeHtml(k) + ': ' + escapeHtml(String(a)) + '</div>');
        }
      });
      return lines.join('');
    }

    // ────────────────────────────────────────────────────────────
    // Row context (Lattice-rendered markdown files)
    // ────────────────────────────────────────────────────────────
    function loadRowContext(tableName, id) {
      var mount = document.getElementById('row-context');
      if (!mount) return;
      fetchJson('/api/tables/' + encodeURIComponent(tableName) + '/rows/' +
                encodeURIComponent(id) + '/context').then(function (data) {
        if (!data.files || data.files.length === 0) {
          mount.innerHTML = '<div class="context-block"><div class="context-empty">' +
            'No rendered context for this row — define an entityContext for "' +
            escapeHtml(tableName) + '" in lattice.config.yml or run \`lattice render\`.' +
            '</div></div>';
          return;
        }
        var blocks = data.files.map(function (f) {
          var body = f.content
            ? '<pre>' + escapeHtml(f.content) + '</pre>'
            : '<div class="context-empty">File not rendered yet (run \`lattice render\`).</div>';
          return '<div class="context-file">' +
            '<div class="context-file-head">' +
              '<span class="context-file-name">' + escapeHtml(f.name) + '</span>' +
              '<span>· ' + escapeHtml(f.path) + '</span>' +
            '</div>' + body + '</div>';
        }).join('');
        mount.innerHTML = '<div class="context-block">' + blocks + '</div>';
      }).catch(function (err) {
        mount.innerHTML = '<div class="context-block"><div class="context-empty">' +
          'Failed to load rendered context: ' + escapeHtml(err.message) + '</div></div>';
      });
    }

    // ────────────────────────────────────────────────────────────
    // Data Model — entity graph + entity editor
    // (row-level link/unlink lives on the row detail page now)
    // ────────────────────────────────────────────────────────────
    var dmActiveTable = null;

    /** Columns that are structurally part of every entity and shouldn't be
     * renamed or removed from the GUI. id is the primary key; deleted_at is
     * the soft-delete column whose semantics undo/redo depends on. */
    var LOCKED_COLUMNS = ['id', 'deleted_at'];

    /** Curated emoji set for entity icons. Click one to select. */
    var EMOJI_PALETTE = [
      '📋', '📅', '👥', '✉️', '📦', '💿', '📄', '🔐',
      '🗂️', '📁', '📓', '📕', '📗', '📘', '📙', '📒',
      '📊', '📈', '📌', '📍', '🧾', '🧰', '🧪', '🧬',
      '🛒', '💼', '💳', '💰', '🏢', '🏬', '🏛️', '🚀',
      '🎯', '🎨', '🛠️', '🔧', '⚙️', '⚡', '🌟', '🔔',
      '🔖', '🔍', '❤️', '🌐', '🌎', '🐙', '🦄', '👤',
    ];

    function renderDataModel(content) {
      content.innerHTML =
        '<div class="view-header">' +
          '<span class="entity-icon">⚙</span>' +
          '<h1>Data Model</h1>' +
          '<div class="actions">' +
            '<button class="btn primary" id="new-entity-btn">+ New entity</button>' +
          '</div>' +
        '</div>' +
        '<div class="dm-layout">' +
          '<div id="graph-mount"><div class="muted">Loading graph…</div></div>' +
          '<aside id="dm-panel" hidden></aside>' +
        '</div>';

      document.getElementById('new-entity-btn').addEventListener('click', function () {
        dmShowEntityEditor(null);
      });

      fetchJson('/api/graph').then(function (graph) {
        document.getElementById('graph-mount').innerHTML = renderGraphSvg(graph);
        document.querySelectorAll('#graph-mount g.gnode').forEach(function (g) {
          g.addEventListener('click', function () {
            var name = g.getAttribute('data-table');
            dmShowEntityEditor(name);
            highlightGraphNode(name);
          });
        });
        if (dmActiveTable) {
          dmShowEntityEditor(dmActiveTable);
          highlightGraphNode(dmActiveTable);
        }
      }).catch(function (err) {
        document.getElementById('graph-mount').innerHTML =
          '<div class="muted">Failed to load graph: ' + escapeHtml(err.message) + '</div>';
      });
    }

    function highlightGraphNode(tableName) {
      document.querySelectorAll('#graph-mount g.gnode').forEach(function (g) {
        g.classList.toggle('active', g.getAttribute('data-table') === tableName);
      });
    }

    /**
     * Show the editor for a selected entity. Pass null to render the
     * 'create new entity' form (same controls, different submit endpoint).
     * Until the user clicks a graph node or '+ New entity', the side panel
     * stays hidden.
     */
    function dmShowEntityEditor(tableName) {
      dmActiveTable = tableName;
      var panel = document.getElementById('dm-panel');
      panel.hidden = false;
      var creating = !tableName;
      if (creating) {
        panel.innerHTML =
          '<h3>+ New entity</h3>' +
          '<div class="dm-edit-grid">' +
            '<label>Name</label>' +
            '<div class="dm-row-inline">' +
              '<input id="dm-create-name" placeholder="e.g. invoices" autofocus />' +
            '</div>' +
            '<label>Icon</label>' +
            '<div>' +
              emojiPickerHtml('dm-create-icon', '📋') +
            '</div>' +
            '<label></label>' +
            '<div class="dm-row-inline">' +
              '<button class="btn primary" id="dm-create-btn">Create entity</button>' +
            '</div>' +
          '</div>' +
          '<div class="muted" style="margin-top:14px;font-size:12px;">' +
            'New entities get id (uuid PK), name, and deleted_at columns. ' +
            'Add more columns once the entity exists.' +
          '</div>';
        wireEmojiPicker(panel, 'dm-create-icon');
        panel.querySelector('#dm-create-btn').addEventListener('click', function () {
          var name = panel.querySelector('#dm-create-name').value.trim();
          var icon = panel.querySelector('#dm-create-icon').value.trim();
          if (!name) { panel.querySelector('#dm-create-name').focus(); return; }
          fetchJson('/api/schema/entities', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: name, icon: icon || undefined }),
          }).then(function () {
            return reloadEverything();
          }).then(function () {
            location.hash = '#/settings/data-model';
            dmActiveTable = name;
            renderRoute();
            showToast('Entity "' + name + '" created', {});
          }).catch(function (err) { showToast('Create failed: ' + err.message, {}); });
        });
        return;
      }

      var t = tableByName(tableName);
      if (!t) {
        panel.innerHTML = '<div class="muted">Unknown entity.</div>';
        return;
      }
      var d = displayFor(tableName);
      // Pre-fill the picker with the effective icon (override > built-in
      // default > generic fallback) so the dropdown reflects what's actually
      // rendered elsewhere in the GUI.
      var overrideIcon = d.icon;
      // Render every column, but render locked ones (id, deleted_at) as
      // read-only labels — they're structural and renaming would break
      // soft-delete / version-history semantics.
      var allCols = (t.columns || []);
      var columnsHtml = allCols.map(function (c) {
        var locked = LOCKED_COLUMNS.indexOf(c) !== -1;
        if (locked) {
          return '<div class="dm-col-row">' +
            '<div class="dm-locked">' + escapeHtml(c) +
              '<span class="dm-locked-label">system</span>' +
            '</div>' +
            '<span></span><span></span>' +
            '</div>';
        }
        var secret = isSecretColumn(tableName, c);
        return '<div class="dm-col-row">' +
          '<input class="dm-col-name" data-col="' + escapeHtml(c) + '" value="' + escapeHtml(c) + '" />' +
          '<label class="dm-secret-toggle" title="Mask values in the GUI">' +
            '<input type="checkbox" class="dm-col-secret" data-col="' + escapeHtml(c) + '"' +
              (secret ? ' checked' : '') + ' />' +
            ' secret' +
          '</label>' +
          '<button class="btn dm-col-rename" data-col="' + escapeHtml(c) + '" title="Rename">↻</button>' +
          '</div>';
      }).join('');
      panel.innerHTML =
        '<h3>' + d.icon + ' ' + escapeHtml(d.label) + '</h3>' +
        '<div class="dm-edit-grid">' +
          '<label>Name</label>' +
          '<div class="dm-row-inline">' +
            '<input id="dm-rename-input" value="' + escapeHtml(tableName) + '" />' +
            '<button class="btn" id="dm-rename-btn">Save</button>' +
          '</div>' +
          '<label>Icon</label>' +
          '<div>' +
            emojiPickerHtml('dm-icon-input', overrideIcon) +
            '<button class="btn" id="dm-icon-btn" style="margin-top:6px;">Save</button>' +
          '</div>' +
          '<label>Columns</label>' +
          '<div class="dm-cols">' + (columnsHtml || '<span class="muted">No columns</span>') + '</div>' +
          '<label>Add column</label>' +
          '<div class="dm-row-inline">' +
            '<input id="dm-newcol-name" placeholder="column_name" />' +
            '<select id="dm-newcol-type">' +
              '<option value="text">text</option>' +
              '<option value="integer">integer</option>' +
              '<option value="real">real</option>' +
              '<option value="boolean">boolean</option>' +
              '<option value="uuid">uuid</option>' +
            '</select>' +
            '<label class="dm-secret-toggle">' +
              '<input type="checkbox" id="dm-newcol-secret" /> secret' +
            '</label>' +
            '<button class="btn primary" id="dm-newcol-btn">Add</button>' +
          '</div>' +
        '</div>';
      wireEmojiPicker(panel, 'dm-icon-input');
      wireEntityEditPanel(panel, tableName);
    }

    /**
     * Render a collapsed emoji-picker: a button showing the currently selected
     * emoji (with a ▾ caret) and a hidden grid that drops down when clicked.
     * Selecting a tile updates the hidden input and the button, then closes
     * the dropdown.
     *
     * currentValue is the emoji to pre-fill (saved override OR the inherited
     * default — callers pass displayFor(table).icon so the dropdown reflects
     * what the user actually sees on the rest of the page).
     */
    function emojiPickerHtml(inputId, currentValue) {
      var current = currentValue || '📋';
      var tiles = EMOJI_PALETTE.map(function (e) {
        var active = e === current ? ' active' : '';
        return '<button type="button" class="emoji-tile' + active +
          '" data-emoji="' + escapeHtml(e) + '" aria-label="' + escapeHtml(e) + '">' + e + '</button>';
      }).join('');
      return '<div class="emoji-picker" data-input-id="' + escapeHtml(inputId) + '">' +
        '<button type="button" class="emoji-trigger" aria-haspopup="grid" aria-expanded="false">' +
          '<span class="emoji-preview">' + escapeHtml(current) + '</span>' +
          '<span class="emoji-caret">▾</span>' +
        '</button>' +
        '<div class="emoji-grid" hidden>' + tiles + '</div>' +
        '<input type="hidden" id="' + escapeHtml(inputId) + '" value="' + escapeHtml(current) + '" />' +
      '</div>';
    }

    function wireEmojiPicker(panel, inputId) {
      var picker = panel.querySelector('.emoji-picker[data-input-id="' + inputId + '"]');
      if (!picker) return;
      var input = picker.querySelector('input[type="hidden"]');
      var trigger = picker.querySelector('.emoji-trigger');
      var preview = picker.querySelector('.emoji-preview');
      var grid = picker.querySelector('.emoji-grid');

      function open() {
        grid.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
      }
      function close() {
        grid.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
      }

      trigger.addEventListener('click', function (e) {
        e.stopPropagation();
        if (grid.hidden) open(); else close();
      });

      // Click anywhere outside the picker closes it.
      document.addEventListener('click', function (e) {
        if (grid.hidden) return;
        if (!picker.contains(e.target)) close();
      });

      picker.querySelectorAll('.emoji-tile').forEach(function (tile) {
        tile.addEventListener('click', function () {
          var v = tile.getAttribute('data-emoji');
          input.value = v;
          preview.textContent = v;
          picker.querySelectorAll('.emoji-tile').forEach(function (t) {
            t.classList.toggle('active', t === tile);
          });
          close();
        });
      });
    }

    /** Wire up the edit-entity controls in the Data Model side panel. */
    function wireEntityEditPanel(panel, tableName) {
      // Rename entity — schema change, not in the audit log, so we keep
      // a confirm (the only kind of warning left in the app).
      panel.querySelector('#dm-rename-btn').addEventListener('click', function () {
        var to = panel.querySelector('#dm-rename-input').value.trim();
        if (!to || to === tableName) return;
        if (!confirm('Rename entity "' + tableName + '" to "' + to + '"? This is irreversible from the GUI.')) return;
        fetchJson('/api/schema/entities/' + encodeURIComponent(tableName) + '/rename', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ to: to }),
        }).then(function () {
          return reloadEverything();
        }).then(function () {
          location.hash = '#/settings/data-model';
          showToast('Entity renamed to "' + to + '"', {});
        }).catch(function (err) { showToast('Rename failed: ' + err.message, {}); });
      });
      // Edit icon
      panel.querySelector('#dm-icon-btn').addEventListener('click', function () {
        var icon = panel.querySelector('#dm-icon-input').value.trim();
        fetchJson('/api/gui-meta/' + encodeURIComponent(tableName), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ icon: icon }),
        }).then(refreshIcons).then(function () {
          dmShowTableRows(tableName);
          showToast('Icon saved', {});
        }).catch(function (err) { showToast('Icon save failed: ' + err.message, {}); });
      });
      // Add column — additive but not in the audit log, so no undo.
      panel.querySelector('#dm-newcol-btn').addEventListener('click', function () {
        var name = panel.querySelector('#dm-newcol-name').value.trim();
        var type = panel.querySelector('#dm-newcol-type').value;
        var secret = !!panel.querySelector('#dm-newcol-secret').checked;
        if (!name) return;
        fetchJson('/api/schema/entities/' + encodeURIComponent(tableName) + '/columns', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: name, type: type }),
        }).then(function () {
          if (!secret) return;
          // Persist the secret flag for the new column.
          return fetchJson(
            '/api/gui-meta/columns/' + encodeURIComponent(tableName) + '/' + encodeURIComponent(name),
            {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ secret: true }),
            },
          );
        }).then(function () {
          return reloadEverything();
        }).then(function () {
          location.hash = '#/settings/data-model';
          showToast('Column "' + name + '" added', {});
        }).catch(function (err) { showToast('Add column failed: ' + err.message, {}); });
      });
      // Toggle 'secret' on an existing column.
      panel.querySelectorAll('input.dm-col-secret').forEach(function (cb) {
        cb.addEventListener('change', function () {
          var col = cb.getAttribute('data-col');
          fetchJson(
            '/api/gui-meta/columns/' + encodeURIComponent(tableName) + '/' + encodeURIComponent(col),
            {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ secret: !!cb.checked }),
            },
          ).then(refreshColumnMeta).then(function () {
            showToast(cb.checked ? 'Column "' + col + '" marked secret' : 'Column "' + col + '" no longer secret', {});
          }).catch(function (err) {
            cb.checked = !cb.checked; // revert
            showToast('Failed: ' + err.message, {});
          });
        });
      });
      // Rename column — schema change, irreversible.
      panel.querySelectorAll('.dm-col-rename').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var col = btn.getAttribute('data-col');
          var input = panel.querySelector('input.dm-col-name[data-col="' + col + '"]');
          var to = input.value.trim();
          if (!to || to === col) return;
          if (!confirm('Rename column "' + col + '" to "' + to + '"? This is irreversible from the GUI.')) return;
          fetchJson(
            '/api/schema/entities/' + encodeURIComponent(tableName) +
              '/columns/' + encodeURIComponent(col) + '/rename',
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ to: to }),
            },
          ).then(function () {
            return reloadEverything();
          }).then(function () {
            location.hash = '#/settings/data-model';
            showToast('Column renamed to "' + to + '"', {});
          }).catch(function (err) { showToast('Rename column failed: ' + err.message, {}); });
        });
      });
    }

    function renderGraphSvg(graph) {
      // Circular layout. Junctions become edges (not nodes).
      var allTableNodes = graph.nodes.filter(function (n) { return n.type === 'table'; });
      var junctionNames = new Set(state.entities.tables.filter(isJunction).map(function (t) { return t.name; }));
      var tableNodes = allTableNodes.filter(function (n) { return !junctionNames.has(n.table || n.label); });

      // Build edges between first-class entities, each tagged with relationship type.
      var entityEdges = [];
      state.entities.tables.forEach(function (t) {
        if (!isJunction(t)) return;
        var rels = Object.values(t.relations);
        if (rels.length === 2) {
          entityEdges.push({
            source: 'table:' + rels[0].table,
            target: 'table:' + rels[1].table,
            type: 'many-to-many',
            via: t.name,
          });
        }
      });
      state.entities.tables.forEach(function (t) {
        if (isJunction(t)) return;
        Object.values(t.relations || {}).forEach(function (r) {
          if (r.type === 'belongsTo') {
            entityEdges.push({
              source: 'table:' + t.name,
              target: 'table:' + r.table,
              type: 'belongs-to',
              via: r.foreignKey,
            });
          }
        });
      });

      var cx = 500, cy = 360, r = 250;
      var nodeRadius = 30;
      var pos = {};
      tableNodes.forEach(function (n, i) {
        var a = (i / tableNodes.length) * Math.PI * 2 - Math.PI / 2;
        pos[n.id] = { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
      });

      var BELONGS_COLOR = '#2f6feb';
      var M2M_COLOR = '#a16207';

      // Trim edge endpoints back from the node centre so the arrow heads
      // sit outside the circle. Markers are 7px tall; pad a little more.
      function trim(from, to, pad) {
        var dx = to.x - from.x, dy = to.y - from.y;
        var len = Math.sqrt(dx * dx + dy * dy);
        if (len === 0) return to;
        var k = (len - pad) / len;
        return { x: from.x + dx * k, y: from.y + dy * k };
      }

      var edgeSvg = entityEdges.map(function (e) {
        var a = pos[e.source], b = pos[e.target];
        if (!a || !b) return '';
        var color = e.type === 'belongs-to' ? BELONGS_COLOR : M2M_COLOR;
        var dash = e.type === 'belongs-to' ? '' : ' stroke-dasharray="6 4"';
        // One arrowhead at the target for belongs-to (child→parent);
        // arrowheads at both ends for many-to-many.
        var endTrimmed = trim(a, b, nodeRadius + 4);
        var startTrimmed = trim(b, a, nodeRadius + 4);
        var markerEnd = ' marker-end="url(#arrow-' + (e.type === 'belongs-to' ? 'b' : 'm') + ')"';
        var markerStart = e.type === 'many-to-many'
          ? ' marker-start="url(#arrow-m)"' : '';
        return '<line x1="' + startTrimmed.x + '" y1="' + startTrimmed.y +
          '" x2="' + endTrimmed.x + '" y2="' + endTrimmed.y +
          '" stroke="' + color + '" stroke-width="1.8"' + dash + markerEnd + markerStart +
          ' data-edge-type="' + e.type + '" data-via="' + escapeHtml(e.via || '') + '"></line>';
      }).join('');

      var nodeSvg = tableNodes.map(function (n) {
        var p = pos[n.id];
        var tableName = n.table || n.label;
        var d = displayFor(tableName);
        return '<g class="gnode" data-table="' + escapeHtml(tableName) + '">' +
          '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + nodeRadius +
            '" fill="#e7efff" stroke="' + BELONGS_COLOR + '" stroke-width="1.5" />' +
          '<text x="' + p.x + '" y="' + (p.y + 7) + '" text-anchor="middle" font-size="20">' + d.icon + '</text>' +
          '<text x="' + p.x + '" y="' + (p.y + nodeRadius + 18) + '" text-anchor="middle" font-size="12" fill="#1f2328">' +
          escapeHtml(d.label) + '</text></g>';
      }).join('');

      // Arrow-head markers: "b" = belongs-to (blue), "m" = many-to-many (amber).
      var defs =
        '<defs>' +
          '<marker id="arrow-b" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
            '<path d="M0,0 L10,5 L0,10 z" fill="' + BELONGS_COLOR + '" />' +
          '</marker>' +
          '<marker id="arrow-m" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
            '<path d="M0,0 L10,5 L0,10 z" fill="' + M2M_COLOR + '" />' +
          '</marker>' +
        '</defs>';

      // Legend in the corner.
      var legend =
        '<g class="dm-legend" transform="translate(20, 20)">' +
          '<line x1="0" y1="6" x2="36" y2="6" stroke="' + BELONGS_COLOR + '" stroke-width="1.8" marker-end="url(#arrow-b)" />' +
          '<text x="44" y="10" font-size="11" fill="#1f2328">belongs-to (child → parent)</text>' +
          '<line x1="0" y1="28" x2="36" y2="28" stroke="' + M2M_COLOR + '" stroke-width="1.8" stroke-dasharray="6 4" marker-start="url(#arrow-m)" marker-end="url(#arrow-m)" />' +
          '<text x="44" y="32" font-size="11" fill="#1f2328">many-to-many</text>' +
        '</g>';

      return '<svg viewBox="0 0 1000 720" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">' +
        defs + legend + edgeSvg + nodeSvg + '</svg>';
    }

    // ────────────────────────────────────────────────────────────
    // Lattice Teams (Project Config + User Config)
    // ────────────────────────────────────────────────────────────
    function fetchConnections() {
      return fetchJson('/api/teams-gui/connections').then(function (d) { return d.connections; });
    }

    /**
     * Minimal modal helper for the teams flows. Returns { close } so
     * callers can dismiss imperatively (used by the invite-token modal
     * after copy). opts.onSubmit may return a Promise — the OK button
     * stays disabled until it resolves, then the modal closes.
     */
    function showModal(title, bodyHtml, opts) {
      opts = opts || {};
      var primaryLabel = opts.primaryLabel || 'Save';
      var backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML =
        '<div class="modal">' +
          '<div class="modal-head">' + escapeHtml(title) + '</div>' +
          '<div class="modal-body">' + bodyHtml + '</div>' +
          '<div class="modal-foot">' +
            '<button class="btn" data-act="cancel">Cancel</button>' +
            '<button class="btn primary" data-act="ok">' + escapeHtml(primaryLabel) + '</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(backdrop);
      function close() { if (backdrop.parentNode) document.body.removeChild(backdrop); }
      backdrop.addEventListener('click', function (e) { if (e.target === backdrop) close(); });
      backdrop.querySelector('[data-act="cancel"]').addEventListener('click', close);
      backdrop.querySelector('[data-act="ok"]').addEventListener('click', function () {
        var btn = backdrop.querySelector('[data-act="ok"]');
        try {
          var result = opts.onSubmit ? opts.onSubmit(backdrop) : null;
          if (result && typeof result.then === 'function') {
            btn.setAttribute('disabled', 'disabled');
            result.then(function () { close(); }).catch(function (err) {
              btn.removeAttribute('disabled');
              alert('Failed: ' + (err && err.message ? err.message : String(err)));
            });
          } else {
            close();
          }
        } catch (err) {
          alert('Failed: ' + (err && err.message ? err.message : String(err)));
        }
      });
      return { close: close };
    }

    function renderTeamsEmpty(content, kind) {
      var msg = kind === 'user'
        ? 'You aren\\'t signed in to any clouds yet. Add a cloud below.'
        : 'No team memberships yet. Start a team or join one below.';
      content.innerHTML =
        '<div class="teams-page">' +
          '<h2>' + (kind === 'user' ? 'User Config' : 'Project Config') + '</h2>' +
          '<p class="lead">' + (kind === 'user'
            ? 'Cloud accounts your local lattice is signed in to.'
            : 'Teams this project\\'s lattice is joined to. Share tables, link rows, and sync.') + '</p>' +
          '<div class="teams-actions">' +
            (kind === 'user'
              ? '<button class="btn primary" id="action-add-cloud">Add cloud (join via invite)</button>'
              : '<button class="btn primary" id="action-create-team">Create team</button>' +
                '<button class="btn" id="action-join-team">Join via invite</button>') +
          '</div>' +
          '<div class="teams-empty">' + escapeHtml(msg) + '</div>' +
        '</div>';
      wireTopActions(kind);
    }

    function wireTopActions(kind) {
      var addBtn = document.getElementById('action-add-cloud');
      if (addBtn) addBtn.addEventListener('click', function () { showJoinTeamModal(kind); });
      var createBtn = document.getElementById('action-create-team');
      if (createBtn) createBtn.addEventListener('click', showCreateTeamModal);
      var joinBtn = document.getElementById('action-join-team');
      if (joinBtn) joinBtn.addEventListener('click', function () { showJoinTeamModal(kind); });
    }

    function refreshSettingsRoute() {
      if (location.hash === '#/settings/project-config') renderProjectConfig(document.getElementById('content'));
      else if (location.hash === '#/settings/user-config') renderUserConfig(document.getElementById('content'));
    }

    function showCreateTeamModal() {
      var bodyHtml =
        '<div class="field"><label>Cloud URL</label><input name="cloud_url" placeholder="http://localhost:4317" /></div>' +
        '<div class="field"><label>Your email</label><input name="email" /></div>' +
        '<div class="field"><label>Your display name</label><input name="user_name" /></div>' +
        '<div class="field"><label>Team name</label><input name="team_name" /></div>' +
        '<p style="font-size:12px;color:var(--text-muted);margin:0">' +
        'This registers you on the cloud (bootstrap-only — must be a fresh cloud) and creates the team in one step.' +
        '</p>';
      showModal('Create team', bodyHtml, {
        primaryLabel: 'Create',
        onSubmit: function (scope) {
          var data = collectFormValues(scope);
          return fetchJson('/api/teams-gui/connections/register-and-create', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(data),
          }).then(function () { refreshSettingsRoute(); });
        },
      });
    }

    function showJoinTeamModal(kind) {
      var bodyHtml =
        '<div class="field"><label>Cloud URL</label><input name="cloud_url" placeholder="http://localhost:4317" /></div>' +
        '<div class="field"><label>Invite token</label><textarea name="invite_token" placeholder="latinv_..."></textarea></div>' +
        '<div class="field"><label>Your email</label><input name="email" /></div>' +
        '<div class="field"><label>Your display name</label><input name="name" /></div>';
      showModal('Join team', bodyHtml, {
        primaryLabel: 'Join',
        onSubmit: function (scope) {
          var data = collectFormValues(scope);
          return fetchJson('/api/teams-gui/connections/join', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(data),
          }).then(function () { refreshSettingsRoute(kind); });
        },
      });
    }

    function renderUserConfig(content) {
      fetchConnections().then(function (conns) {
        if (conns.length === 0) { renderTeamsEmpty(content, 'user'); return; }
        var rows = conns.map(function (c) {
          return '<div class="team-card" data-team-id="' + escapeHtml(c.team_id) + '">' +
            '<h3>' + escapeHtml(c.team_name) +
              '<button class="btn danger-btn" data-act="signout">Sign out</button>' +
            '</h3>' +
            '<div class="team-meta">' +
              'Cloud: <code>' + escapeHtml(c.cloud_url) + '</code> · ' +
              'User id: <code>' + escapeHtml(c.my_user_id) + '</code> · ' +
              'Joined ' + escapeHtml(c.joined_at) +
            '</div>' +
          '</div>';
        }).join('');
        content.innerHTML =
          '<div class="teams-page">' +
            '<h2>User Config</h2>' +
            '<p class="lead">Cloud accounts your local lattice is signed in to. Each team membership keeps its own bearer token locally.</p>' +
            '<div class="teams-actions">' +
              '<button class="btn primary" id="action-add-cloud">Add cloud (join via invite)</button>' +
            '</div>' +
            rows +
          '</div>';
        wireTopActions('user');
        document.querySelectorAll('.team-card').forEach(function (card) {
          var teamId = card.getAttribute('data-team-id');
          card.querySelector('[data-act="signout"]').addEventListener('click', function () {
            if (!confirm('Sign out of this team? Your local link tracking will be removed.')) return;
            fetchJson('/api/teams-gui/connections/' + teamId, { method: 'DELETE' })
              .then(function () { refreshSettingsRoute(); })
              .catch(function (err) { alert('Sign out failed: ' + err.message); });
          });
        });
      }).catch(function (err) {
        content.innerHTML = '<div class="placeholder"><h2>Failed to load</h2>' + escapeHtml(err.message) + '</div>';
      });
    }

    function renderProjectConfig(content) {
      // Frame the page; Database + Teams panels populate themselves
      // asynchronously so a slow cloud probe doesn't block the page.
      content.innerHTML =
        '<div class="teams-page">' +
          '<h2>Project Config</h2>' +
          '<div id="dbconfig-host"><div class="placeholder" style="padding:18px">Loading database configuration…</div></div>' +
          '<div id="teams-host"></div>' +
        '</div>';
      renderDatabasePanel(document.getElementById('dbconfig-host'));
      renderTeamsForProjectConfig(document.getElementById('teams-host'));
    }

    function renderTeamsForProjectConfig(host) {
      fetchConnections().then(function (conns) {
        if (conns.length === 0) {
          host.innerHTML =
            '<div style="margin-top:18px">' +
              '<h3 style="margin:0 0 8px">Teams</h3>' +
              '<p class="lead">No team memberships yet. Start a team or join one below.</p>' +
              '<div class="teams-actions">' +
                '<button class="btn primary" id="action-create-team">Create team</button>' +
                '<button class="btn" id="action-join-team">Join via invite</button>' +
              '</div>' +
            '</div>';
          wireTopActions('project');
          return;
        }
        host.innerHTML =
          '<div style="margin-top:18px">' +
            '<h3 style="margin:0 0 8px">Teams</h3>' +
            '<p class="lead">Teams this project\\'s lattice is joined to. Click a team to expand sync details, shared tables, and member admin.</p>' +
            '<div class="teams-actions">' +
              '<button class="btn primary" id="action-create-team">Create team</button>' +
              '<button class="btn" id="action-join-team">Join via invite</button>' +
            '</div>' +
            '<div id="team-cards-host"></div>' +
          '</div>';
        wireTopActions('project');
        var cards = document.getElementById('team-cards-host');
        conns.forEach(function (c) {
          var card = document.createElement('div');
          card.className = 'team-card';
          card.setAttribute('data-team-id', c.team_id);
          cards.appendChild(card);
          renderTeamCard(card, c);
        });
      }).catch(function (err) {
        host.innerHTML = '<div class="placeholder">Failed to load teams: ' + escapeHtml(err.message) + '</div>';
      });
    }

    /** GET /api/dbconfig + render the Database panel. */
    function renderDatabasePanel(host) {
      fetchJson('/api/dbconfig').then(function (info) {
        var isPg = info.type === 'postgres';
        host.innerHTML =
          '<div class="dbconfig-panel" style="margin-bottom:18px;padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--surface)">' +
            '<h3 style="margin:0 0 10px">Database</h3>' +
            '<div style="margin-bottom:10px">' +
              '<label style="margin-right:14px"><input type="radio" name="dbtype" value="sqlite"' + (isPg ? '' : ' checked') + '> Local SQLite</label>' +
              '<label><input type="radio" name="dbtype" value="postgres"' + (isPg ? ' checked' : '') + '> Cloud Postgres</label>' +
            '</div>' +
            '<div id="db-form"></div>' +
            '<div class="team-actions" style="margin-top:10px">' +
              '<button class="btn" data-act="db-test">Test connection</button>' +
              '<button class="btn primary" data-act="db-save">Save</button>' +
              '<button class="btn" data-act="db-connect" title="Reconnect using the saved configuration">Connect</button>' +
            '</div>' +
            '<div id="db-msg" style="margin-top:8px;font-size:12px;color:var(--text-muted)"></div>' +
          '</div>';
        function paintForm(kind, prefill) {
          var form = document.getElementById('db-form');
          if (kind === 'sqlite') {
            form.innerHTML =
              '<label class="field-label">Database file path</label>' +
              '<input type="text" id="db-sqlite-path" placeholder="./data/project.db" value="' + escapeHtml(prefill || ('./data/' + (info.dbFile || 'project.db'))) + '" style="width:100%">';
          } else {
            form.innerHTML =
              '<div class="grid" style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px">' +
                '<div><label class="field-label">Label</label><input type="text" id="db-label" placeholder="atlas" value="' + escapeHtml(info.label || '') + '" style="width:100%"></div>' +
                '<div><label class="field-label">Host</label><input type="text" id="db-host" placeholder="db.example.com" value="' + escapeHtml(info.host || '') + '" style="width:100%"></div>' +
                '<div><label class="field-label">Port</label><input type="number" id="db-port" placeholder="5432" value="' + escapeHtml(String(info.port || 5432)) + '" style="width:100%"></div>' +
                '<div><label class="field-label">Database name</label><input type="text" id="db-dbname" placeholder="app" value="' + escapeHtml(info.dbname || '') + '" style="width:100%"></div>' +
                '<div><label class="field-label">User</label><input type="text" id="db-user" placeholder="lattice_user" value="' + escapeHtml(info.user || '') + '" style="width:100%"></div>' +
                '<div><label class="field-label">Password</label><input type="password" id="db-password" placeholder="••••••••" style="width:100%"></div>' +
              '</div>';
          }
        }
        paintForm(info.type, undefined);
        Array.prototype.forEach.call(host.querySelectorAll('input[name="dbtype"]'), function (r) {
          r.addEventListener('change', function () { paintForm(r.value, undefined); });
        });
        function readBody() {
          var kind = (host.querySelector('input[name="dbtype"]:checked') || { value: 'sqlite' }).value;
          if (kind === 'sqlite') {
            return { type: 'sqlite', path: (document.getElementById('db-sqlite-path').value || '').trim() };
          }
          return {
            type: 'postgres',
            label: (document.getElementById('db-label').value || '').trim(),
            host: (document.getElementById('db-host').value || '').trim(),
            port: Number(document.getElementById('db-port').value || 5432),
            dbname: (document.getElementById('db-dbname').value || '').trim(),
            user: document.getElementById('db-user').value || '',
            password: document.getElementById('db-password').value || '',
          };
        }
        function setMsg(text, ok) {
          var el = document.getElementById('db-msg');
          el.textContent = text;
          el.style.color = ok ? 'var(--accent, #1f56c2)' : 'var(--text-muted)';
        }
        host.querySelector('[data-act="db-test"]').addEventListener('click', function () {
          setMsg('Testing…');
          fetch('/api/dbconfig/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(readBody()) })
            .then(function (r) { return r.json(); })
            .then(function (d) { setMsg(d.ok ? 'Connection ok.' : 'Failed: ' + (d.error || 'unknown'), !!d.ok); })
            .catch(function (e) { setMsg('Failed: ' + e.message, false); });
        });
        host.querySelector('[data-act="db-save"]').addEventListener('click', function () {
          setMsg('Saving…');
          fetch('/api/dbconfig/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(readBody()) })
            .then(function (r) { return r.json(); })
            .then(function (d) {
              if (d.error) { setMsg('Failed: ' + d.error, false); return; }
              setMsg('Saved. Click Connect to apply.', true);
            })
            .catch(function (e) { setMsg('Failed: ' + e.message, false); });
        });
        host.querySelector('[data-act="db-connect"]').addEventListener('click', function () {
          setMsg('Reconnecting…');
          fetch('/api/dbconfig/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) })
            .then(function (r) { return r.json(); })
            .then(function (d) {
              if (d.error) { setMsg('Failed: ' + d.error, false); return; }
              setMsg('Reconnected.', true);
              // Re-render the panel to reflect the (possibly new) DB shape.
              renderDatabasePanel(document.getElementById('dbconfig-host'));
            })
            .catch(function (e) { setMsg('Failed: ' + e.message, false); });
        });
      }).catch(function (err) {
        host.innerHTML = '<div class="placeholder">Failed to load database config: ' + escapeHtml(err.message) + '</div>';
      });
    }

    function renderTeamCard(card, conn) {
      // Fetch status + shared + members in parallel; members may 403 for
      // non-creators (only members can list, but we still try and ignore).
      var teamId = conn.team_id;
      Promise.all([
        fetchJson('/api/teams-gui/teams/' + teamId + '/status'),
        fetchJson('/api/teams-gui/teams/' + teamId + '/shared').catch(function () { return { objects: [] }; }),
        fetchJson('/api/teams-gui/teams/' + teamId + '/members').catch(function () { return { members: [] }; }),
      ]).then(function (results) {
        var status = results[0];
        var shared = results[1].objects;
        var members = results[2].members;
        var myMembership = members.find(function (m) { return m.user_id === conn.my_user_id; });
        var isCreator = myMembership && myMembership.role === 'creator';
        var rolePill = '<span class="role-tag' + (isCreator ? '' : ' role-member') + '">' + (myMembership ? myMembership.role : 'unknown') + '</span>';

        var lastSeq = status.last_change_seq == null ? '(never)' : status.last_change_seq;
        card.innerHTML =
          '<h3>' + escapeHtml(conn.team_name) + ' ' + rolePill +
            '<span style="font-size:11px;color:var(--text-muted);font-weight:normal">' + escapeHtml(conn.cloud_url) + '</span>' +
          '</h3>' +
          '<div class="team-meta">team-id: <code>' + escapeHtml(teamId) + '</code></div>' +
          '<div class="team-stats">' +
            '<div class="team-stat"><div class="stat-label">Last seq</div><div class="stat-value">' + lastSeq + '</div></div>' +
            '<div class="team-stat"><div class="stat-label">Outbox</div><div class="stat-value">' + status.outbox_depth + '</div></div>' +
            '<div class="team-stat"><div class="stat-label">DLQ</div><div class="stat-value">' + status.dlq_depth + '</div></div>' +
            '<div class="team-stat"><div class="stat-label">Local links</div><div class="stat-value">' + status.local_links + '</div></div>' +
          '</div>' +
          '<div class="team-actions">' +
            '<button class="btn primary" data-act="sync">Sync now</button>' +
            (isCreator
              ? '<button class="btn" data-act="invite">Generate invite token</button>'
              : '') +
            '<button class="btn" data-act="leave">' + (isCreator ? 'Destroy team' : 'Leave team') + '</button>' +
          '</div>' +
          renderSharedList(shared, isCreator) +
          (isCreator ? renderMembersList(members, conn.my_user_id) : '');
        wireTeamCardActions(card, conn, isCreator);
      }).catch(function (err) {
        card.innerHTML = '<div class="team-meta">Failed to load team status: ' + escapeHtml(err.message) + '</div>';
      });
    }

    function renderSharedList(shared, isCreator) {
      if (shared.length === 0) {
        return '<div class="shared-list"><h4>Shared tables</h4>' +
          '<div style="font-size:13px;color:var(--text-muted)">No tables shared yet.</div>' +
          (isCreator || true ? '<div style="margin-top:8px"><button class="btn" data-act="share-table">Share a table</button></div>' : '') +
        '</div>';
      }
      var rows = shared.map(function (o) {
        return '<div class="shared-row" data-table="' + escapeHtml(o.table) + '">' +
          '<span class="table-name">' + escapeHtml(o.table) +
          ' <span style="color:var(--text-muted);font-size:11px">v' + o.schema_version + '</span></span>' +
          '<button class="btn danger-btn" data-act="unshare">Unshare</button>' +
        '</div>';
      }).join('');
      return '<div class="shared-list"><h4>Shared tables</h4>' + rows +
        '<div style="margin-top:8px"><button class="btn" data-act="share-table">Share another table</button></div>' +
      '</div>';
    }

    function renderMembersList(members, myUserId) {
      var rows = members.map(function (m) {
        var label = m.name || m.email || '(unknown)';
        var canKick = m.user_id !== myUserId;
        return '<div class="member-row" data-user-id="' + escapeHtml(m.user_id) + '">' +
          '<span>' + escapeHtml(label) +
            ' <span style="color:var(--text-muted);font-size:11px">' + escapeHtml(m.email || '') + '</span>' +
            ' <span class="role-tag' + (m.role === 'creator' ? '' : ' role-member') + '">' + m.role + '</span>' +
          '</span>' +
          (canKick ? '<button class="btn danger-btn" data-act="kick">Kick</button>' : '') +
        '</div>';
      }).join('');
      return '<div class="members-list"><h4>Members</h4>' + rows + '</div>';
    }

    function wireTeamCardActions(card, conn, isCreator) {
      var teamId = conn.team_id;
      card.querySelector('[data-act="sync"]').addEventListener('click', function () {
        fetchJson('/api/teams-gui/teams/' + teamId + '/sync', { method: 'POST' })
          .then(function () { renderTeamCard(card, conn); })
          .catch(function (err) { alert('Sync failed: ' + err.message); });
      });
      var inviteBtn = card.querySelector('[data-act="invite"]');
      if (inviteBtn) inviteBtn.addEventListener('click', function () {
        fetchJson('/api/teams-gui/teams/' + teamId + '/invitations', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
        }).then(function (inv) { showInviteTokenModal(inv); })
          .catch(function (err) { alert('Invite failed: ' + err.message); });
      });
      card.querySelector('[data-act="leave"]').addEventListener('click', function () {
        if (isCreator) {
          if (!confirm('Destroy team "' + conn.team_name + '"? This soft-deletes the team on the cloud.')) return;
          fetchJson('/api/teams-gui/teams/' + teamId, { method: 'DELETE' })
            .then(function () { refreshSettingsRoute(); })
            .catch(function (err) { alert('Destroy failed: ' + err.message); });
        } else {
          if (!confirm('Leave team "' + conn.team_name + '"?')) return;
          fetchJson('/api/teams-gui/connections/' + teamId, { method: 'DELETE' })
            .then(function () { refreshSettingsRoute(); })
            .catch(function (err) { alert('Leave failed: ' + err.message); });
        }
      });
      var shareBtn = card.querySelector('[data-act="share-table"]');
      if (shareBtn) shareBtn.addEventListener('click', function () { showShareTableModal(teamId, card, conn); });
      card.querySelectorAll('[data-act="unshare"]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var tableName = btn.closest('.shared-row').getAttribute('data-table');
          if (!confirm('Unshare "' + tableName + '"? Linked rows will be unlinked everywhere.')) return;
          fetchJson('/api/teams-gui/teams/' + teamId + '/shared/' + encodeURIComponent(tableName), { method: 'DELETE' })
            .then(function () { renderTeamCard(card, conn); })
            .catch(function (err) { alert('Unshare failed: ' + err.message); });
        });
      });
      card.querySelectorAll('[data-act="kick"]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var userId = btn.closest('.member-row').getAttribute('data-user-id');
          if (!confirm('Kick this member? All rows they own will be unlinked.')) return;
          fetchJson('/api/teams-gui/teams/' + teamId + '/members/' + userId, { method: 'DELETE' })
            .then(function () { renderTeamCard(card, conn); })
            .catch(function (err) { alert('Kick failed: ' + err.message); });
        });
      });
    }

    function showShareTableModal(teamId, card, conn) {
      var tableOptions = state.entities.tables
        .filter(function (t) { return !isJunction(t); })
        .map(function (t) { return '<option value="' + escapeHtml(t.name) + '">' + escapeHtml(t.name) + '</option>'; })
        .join('');
      var bodyHtml =
        '<div class="field"><label>Local table to share</label>' +
        '<select name="table">' + tableOptions + '</select></div>' +
        '<p style="font-size:12px;color:var(--text-muted)">The current local schema will be serialized and stored on the cloud. Re-sharing later bumps the version.</p>';
      showModal('Share a table', bodyHtml, {
        primaryLabel: 'Share',
        onSubmit: function (scope) {
          var data = collectFormValues(scope);
          return fetchJson('/api/teams-gui/teams/' + teamId + '/shared', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ table: data.table }),
          }).then(function () { renderTeamCard(card, conn); });
        },
      });
    }

    function showInviteTokenModal(inv) {
      var bodyHtml =
        '<p style="margin-top:0">Share this token with the invitee (one-time use). It expires at <code>' +
        escapeHtml(inv.expires_at || '(no expiry)') + '</code>.</p>' +
        '<div class="copy-token" id="copy-token">' + escapeHtml(inv.raw_token) + '</div>' +
        '<p style="font-size:12px;color:var(--text-muted);margin-bottom:0">Click the token to copy.</p>';
      var handle = showModal('Invitation token', bodyHtml, { primaryLabel: 'Done', onSubmit: function () {} });
      var tokenEl = document.getElementById('copy-token');
      if (tokenEl) {
        tokenEl.addEventListener('click', function () {
          navigator.clipboard.writeText(inv.raw_token).then(function () {
            tokenEl.textContent = 'Copied!';
            setTimeout(function () { tokenEl.textContent = inv.raw_token; }, 1200);
          });
        });
      }
      // Suppress unused-var on handle
      void handle;
    }

    init();
  })();
  </script>
</body>
</html>`;
