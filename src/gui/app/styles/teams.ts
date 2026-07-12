// Auto-composed section of the GUI stylesheet. Verbatim substring of the original
// css template literal — do not hand-edit; see styles/index.ts for composition.
export const teamsCss = `    /* ── Teams (Project Config + User Config) ───────────── */
    .teams-page { padding: 24px 28px; max-width: 1000px; }
    .teams-page h2 { margin: 0 0 4px 0; font-size: 22px; }
    .teams-page .lead { color: var(--text-muted); margin-bottom: 24px; font-size: 14px; }
    /* Workspace list (Lattice Settings): active row highlighted, others click-to-switch. */
    .teams-page tr.ws-row { cursor: pointer; }
    .teams-page tr.ws-row:hover td { background: var(--surface-2); }
    .teams-page tr.ws-active td { background: var(--accent-soft); }
    .teams-page tr.ws-active td:first-child { font-weight: 600; color: var(--accent); }
    .teams-actions { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
    .team-card {
      background: var(--sheen), var(--surface); border: 1px solid var(--border);
      border-radius: var(--r-xl); padding: 16px 18px; margin-bottom: 14px;
      box-shadow: var(--shadow-2), var(--hl-top);
    }
    .team-card h3 {
      margin: 0 0 4px 0; font-size: 16px;
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
    }
    .team-card .team-meta { color: var(--text-muted); font-size: 13px; margin-bottom: 12px; }
    .team-card .team-meta code { font-family: ui-monospace, monospace; font-size: 12px; }
    .team-card .role-tag {
      display: inline-block; padding: 2px 8px; border-radius: var(--r-xs);
      font-size: 11px; font-weight: 600; text-transform: uppercase;
      background: var(--accent-soft); color: var(--accent);
    }
    .team-card .role-tag.role-member { background: #eef0f3; color: var(--text-muted); }
    .team-stats {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px;
      margin: 10px 0 14px 0;
    }
    .team-stat {
      background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-sm);
      padding: 8px 10px; text-align: center;
    }
    .team-stat .stat-label {
      font-size: 11px; text-transform: uppercase; color: var(--text-muted);
      letter-spacing: 0.05em; margin-bottom: 2px;
    }
    .team-stat .stat-value { font-size: 18px; font-weight: 600; }
    .team-card .team-actions { display: flex; gap: 6px; margin-top: 12px; flex-wrap: wrap; }
    .team-card .shared-list, .team-card .members-list {
      margin: 12px 0; border-top: 1px solid var(--border); padding-top: 12px;
    }
    .team-card .shared-list h4, .team-card .members-list h4 {
      margin: 0 0 8px 0; font-size: 13px; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;
    }
    .shared-row, .member-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 8px; border-radius: var(--r-xs); font-size: 13px;
    }
    .shared-row:hover, .member-row:hover { background: var(--row-hover); }
    .shared-row .table-name { font-family: ui-monospace, monospace; }
    /* Role/status pills inside the settings-drawer member list, which is not
       under .team-card — so the .team-card-scoped .role-tag rules don't reach
       it. Covers creator / member / and the pending-invitee invited/expired. */
    .members-list .role-tag {
      display: inline-block; padding: 2px 8px; border-radius: var(--r-xs);
      font-size: 11px; font-weight: 600; text-transform: uppercase;
      background: var(--accent-soft); color: var(--accent);
    }
    .members-list .role-tag.role-member { background: #eef0f3; color: var(--text-muted); }
    .members-list .role-tag.role-expired { background: var(--danger-bg); color: var(--danger-ink); }
    .member-row-pending { opacity: 0.85; }
    .teams-empty {
      padding: 32px; text-align: center; color: var(--text-muted);
      border: 1px dashed var(--border-strong); border-radius: var(--r-md);
    }
    .danger-btn { background: color-mix(in srgb, var(--hue-orange) 12%, transparent); color: var(--warn); border-color: color-mix(in srgb, var(--hue-orange) 40%, transparent); }
    .danger-btn:hover { background: color-mix(in srgb, var(--hue-orange) 20%, transparent); }

    /* Modal — used by the teams flows. Self-contained so it doesn't
       collide with any modal styles the GUI agent may add later. */
    .modal-backdrop {
      position: fixed; inset: 0; background: var(--overlay-dim);
      -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);
      display: flex; align-items: center; justify-content: center;
      z-index: var(--z-modal);
    }
    .modal {
      background: rgba(255, 255, 255, 0.80);
      -webkit-backdrop-filter: var(--blur-lg); backdrop-filter: var(--blur-lg);
      border: 1px solid rgba(15, 23, 42, 0.04); border-radius: var(--r-xl);
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
      border-radius: var(--r-sm); background: var(--surface); color: var(--text);
    }
    .modal-foot .btn:hover { background: var(--row-hover); }
    .modal-foot .btn.primary {
      background: var(--accent); color: var(--btn-text); border-color: var(--accent-deep); font-weight: 600; box-shadow: none;
    }
    .modal-foot .btn.primary:hover { background: var(--accent-deep); border-color: var(--accent-glow); box-shadow: var(--shadow-2); }
    .modal .field { margin-bottom: 12px; }
    .modal .field label {
      display: block; margin-bottom: 4px; font-size: 12px;
      color: var(--text); font-weight: 500;
      text-transform: uppercase; letter-spacing: 0.05em;
    }
    .modal .field input:not([type='radio']):not([type='checkbox']), .modal .field textarea {
      width: 100%; padding: 6px 8px;
      background: var(--surface); color: var(--text);
      border: 1px solid var(--border-strong);
      border-radius: var(--r-xs); font: inherit;
    }
    .modal .field input::placeholder, .modal .field textarea::placeholder {
      color: var(--text-muted);
    }
    .modal .field textarea { min-height: 60px; font-family: ui-monospace, monospace; font-size: 12px; }
    /* New-workspace "Kind" selector — clean cards, blue-highlighted selection. */
    .wiz-kind-opts { display: flex; gap: 10px; margin-top: 6px; flex-wrap: wrap; }
    /* These cards ARE <label>s inside .modal .field, so .modal .field label {display:block}
       (0,3,0) out-specifies a bare .wiz-kind-card (0,1,0) and kills the flex layout — the
       radio jams against the text. Qualify the selector (0,3,1) so display:flex/gap win. */
    .modal .field label.wiz-kind-card {
      flex: 1 1 0; min-width: 132px; display: flex; align-items: center; gap: 10px;
      padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--r-md);
      background: var(--surface); cursor: pointer;
      transition: border-color var(--dur-1) ease, background var(--dur-1) ease;
    }
    .wiz-kind-card:hover { border-color: var(--border-strong); }
    .wiz-kind-card:has(input:checked) { border-color: var(--accent); background: var(--accent-soft); }
    .wiz-kind-card input { margin: 0; flex: 0 0 auto; }
    .wiz-kind-name { font-size: 13px; color: var(--text); text-transform: none; letter-spacing: 0; }
    .wiz-kind-sub { color: var(--text-muted); font-size: 11px; margin-left: 2px; }
    .wiz-kind-card:has(input:checked) .wiz-kind-name { color: var(--accent-deep); font-weight: 500; }
    .modal .copy-token {
      padding: 8px 10px; background: var(--surface-2); border: 1px solid var(--border);
      border-radius: var(--r-xs); font-family: ui-monospace, monospace; font-size: 12px;
      word-break: break-all; cursor: pointer;
    }
    .modal .copy-token:hover { background: var(--row-hover); }

`;
