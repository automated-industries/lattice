// Auto-composed section of the GUI stylesheet. Verbatim substring of the original
// css template literal — do not hand-edit; see styles/index.ts for composition.
export const teamsCss = `    /* ── Teams (Project Config + User Config) ───────────── */
    .teams-page { padding: 24px 28px; max-width: 1000px; }
    .teams-page h2 { margin: 0 0 4px 0; font-size: 22px; }
    .teams-page .lead { color: var(--text-muted); margin-bottom: 24px; font-size: 13.5px; }
    /* Workspace list (Lattice Settings): active row highlighted, others click-to-switch. */
    .teams-page tr.ws-row { cursor: pointer; }
    .teams-page tr.ws-row:hover td { background: var(--surface-2); }
    .teams-page tr.ws-active td { background: var(--accent-soft); }
    .teams-page tr.ws-active td:first-child { font-weight: 600; color: var(--accent); }
    .teams-actions { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
    .team-card {
      background: var(--sheen), var(--surface); border: 1px solid var(--border);
      border-radius: 12px; padding: 16px 18px; margin-bottom: 14px;
      box-shadow: var(--shadow-2), var(--hl-top);
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
      background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px;
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
    /* Role/status pills inside the settings-drawer member list, which is not
       under .team-card — so the .team-card-scoped .role-tag rules don't reach
       it. Covers creator / member / and the pending-invitee invited/expired. */
    .members-list .role-tag {
      display: inline-block; padding: 2px 8px; border-radius: 4px;
      font-size: 11px; font-weight: 600; text-transform: uppercase;
      background: var(--accent-soft); color: var(--accent);
    }
    .members-list .role-tag.role-member { background: #eef0f3; color: var(--text-muted); }
    .members-list .role-tag.role-expired { background: #fde2e1; color: #b91c1c; }
    .member-row-pending { opacity: 0.85; }
    .teams-empty {
      padding: 32px; text-align: center; color: var(--text-muted);
      border: 1px dashed var(--border-strong); border-radius: 8px;
    }
    .danger-btn { background: rgba(251, 146, 60, 0.12); color: var(--warn); border-color: rgba(251, 146, 60, 0.4); }
    .danger-btn:hover { background: rgba(251, 146, 60, 0.2); }

    /* Modal — used by the teams flows. Self-contained so it doesn't
       collide with any modal styles the GUI agent may add later. */
    .modal-backdrop {
      position: fixed; inset: 0; background: rgba(7, 9, 11, 0.55);
      -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);
      display: flex; align-items: center; justify-content: center;
      z-index: 1000;
    }
    .modal {
      background: rgba(19, 23, 27, 0.80);
      -webkit-backdrop-filter: var(--blur-lg); backdrop-filter: var(--blur-lg);
      border: 1px solid rgba(255, 255, 255, 0.06); border-radius: 12px;
      box-shadow: var(--shadow-4), var(--hl-top);
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
      background: linear-gradient(135deg, var(--accent-glow), var(--accent-deep)); color: #0b0d10; border-color: var(--accent-deep); font-weight: 600; box-shadow: var(--glow-accent-soft);
    }
    .modal-foot .btn.primary:hover { background: linear-gradient(135deg, var(--accent-glow), var(--accent)); border-color: var(--accent-glow); box-shadow: var(--glow-accent); }
    .modal .field { margin-bottom: 12px; }
    .modal .field label {
      display: block; margin-bottom: 4px; font-size: 12px;
      color: var(--text); font-weight: 500;
      text-transform: uppercase; letter-spacing: 0.04em;
    }
    .modal .field input, .modal .field textarea {
      width: 100%; padding: 6px 8px;
      background: var(--surface); color: var(--text);
      border: 1px solid var(--border-strong);
      border-radius: 4px; font: inherit;
    }
    .modal .field input::placeholder, .modal .field textarea::placeholder {
      color: var(--text-muted);
    }
    .modal .field textarea { min-height: 60px; font-family: ui-monospace, monospace; font-size: 12px; }
    .modal .copy-token {
      padding: 8px 10px; background: var(--surface-2); border: 1px solid var(--border);
      border-radius: 4px; font-family: ui-monospace, monospace; font-size: 12px;
      word-break: break-all; cursor: pointer;
    }
    .modal .copy-token:hover { background: var(--row-hover); }

`;
