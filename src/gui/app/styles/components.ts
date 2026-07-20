// Auto-composed section of the GUI stylesheet (see styles/index.ts). Shared
// component layer (design pass M3): the canonical modal plus alias groups that
// lift declarations shared VERBATIM by existing named components — backdrop
// geometry, icon-button chrome, card surface DNA, pill radius, empty-state
// text treatment, kicker microlabels, toolbar rows, and the input focus
// ring — and the new base classes (.panel, .pill, .empty-state, .kicker,
// .toolbar). Alias-first: every existing name keeps its per-file deltas where
// they live today; this layer sits right after the tokens, so later per-file
// rules still win ties.
export const componentsCss = `    /* ── Shared components (alias-first consolidation) ─── */
    /* Dim-backdrop box geometry + scrim shared by the three overlay backdrops.
       Display/open-close machinery, blur and z-index stay with each owner;
       .drawer-backdrop keeps its lighter scrim (--overlay-dim-soft) locally. */
    .modal-backdrop, .drawer-backdrop {
      position: fixed; inset: 0; background: var(--overlay-dim);
    }

    /* Canonical modal (moved from the teams section; names frozen — consumed
       via classList by row-context, version-history, data-model + onboarding.
       The .modal .field styles stay with the teams section, where their
       selector shapes are pinned by tests). */
    .modal-backdrop {
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

    /* Icon-button chrome shared verbatim by the header icon buttons; each name
       keeps its size, background and hover deltas per-file. */
    .history-btn, .db-button, .dash-new-btn {
      display: inline-flex; align-items: center;
      border: 1px solid var(--border); border-radius: var(--r-sm);
      cursor: pointer;
    }

    /* Card surface DNA. .panel is the new generic card (used by later passes);
       the existing named cards alias the shared declarations and keep their own
       radius/background deltas per-file. (.mt-card intentionally not aliased.) */
    .panel, .card, .conn-card, .grants-panel, .cb-field, .wiz-kind-card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: var(--r-lg);
    }
    .panel { padding: 14px; }
    .panel-gap { margin-top: 14px; }

    /* Pill: shared fully-rounded chip shape. Existing chips alias only the
       radius; their colors/typography stay per-file. */
    .pill {
      display: inline-flex; align-items: center; gap: 6px;
      border-radius: var(--r-pill); padding: 2px 10px; font-size: 12px;
    }
    .app-status, .ask-lattice-trigger, .configure-trigger, .q-opt, .feed-source,
    .nav-badge, .mt-tier-count, .offline-pill, .fs-computed-badge,
    .file-preview .artifact-badge, .toast, .activity-count, .cb-chip, .cb-chip-n {
      border-radius: var(--r-pill);
    }

    /* Empty states: shared muted/centered treatment; per-file padding,
       font-size and dashed-border deltas stay where they are. */
    .empty-state { color: var(--text-muted); text-align: center; padding: 24px; font-size: 13px; }
    .empty-state-sm { color: var(--text-muted); text-align: center; padding: 12px; font-size: 13px; }
    .teams-empty, .dq-empty, .placeholder, .nav-empty, .dash-list-empty,
    .activity-empty, .src-empty, .fs-empty, .mt-tier-empty, .rail-empty {
      color: var(--text-muted); text-align: center;
    }

    /* Kicker: the uppercase micro-label recipe. Only the names whose
       declarations matched this recipe verbatim are aliased here. */
    .kicker, .cb-label, .cb-fields-head, .cb-preview-head, .mt-bar-label,
    .activity-popover-head, .section-label {
      font-size: 11px; font-weight: 600; letter-spacing: 0.05em;
      text-transform: uppercase; color: var(--text-muted);
    }

    /* Toolbar: horizontal control row. */
    .toolbar, .grants-panel .grants-actions {
      display: flex; align-items: center; gap: 8px;
    }

    /* Input focus ring — grouped from per-file dupes (byte-equivalent in
       effect); the tokens-layer :focus-visible base stays authoritative. */
    .analytics-home-prompt textarea:focus, .conn-field input:focus,
    .conn-field select:focus, .sql-editor:focus, .rail-composer textarea:focus {
      outline: none; border-color: var(--accent); box-shadow: var(--glow-focus);
    }

`;
