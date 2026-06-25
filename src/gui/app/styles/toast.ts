// Auto-composed section of the GUI stylesheet. Verbatim substring of the original
// css template literal — do not hand-edit; see styles/index.ts for composition.
export const toastCss = `    /* ── Toast / undo banner ──────────────────────────── */
    .toast {
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      background: #ffffff; color: var(--text); border: 1px solid var(--border);
      padding: 10px 18px; border-radius: 999px;
      display: flex; align-items: center; gap: 14px;
      box-shadow: var(--shadow-3);
      /* Above every overlay (.modal-backdrop is z-index 1000, drawers 120-130) so
         an error thrown by an overlay screen is always visible on top. */
      z-index: 2000; font-size: 13.5px;
      animation: toast-in 0.18s ease;
    }
    @keyframes toast-in {
      from { transform: translate(-50%, 8px); opacity: 0; }
      to   { transform: translate(-50%, 0);   opacity: 1; }
    }
    /* Inline button spinner — shown by withBusy() while an action runs. */
    @keyframes lattice-spin { to { transform: rotate(360deg); } }
    .spinner {
      display: inline-block; width: 12px; height: 12px; margin-right: 6px;
      vertical-align: -1px; border: 2px solid currentColor; border-right-color: transparent;
      border-radius: 50%; animation: lattice-spin 0.6s linear infinite;
    }
    /* Global boot interstitial — paints from the static shell on frame 1, masking
       the half-rendered shell (incl. the placeholder "workspace" label) until
       init() populates the app, then fades out. z-index 1500: above all chrome
       (topbar 100, drawers 120/130, modals 1000) but below toasts (2000) so a
       boot-error toast can still surface. Boot-only — never re-shown on a switch. */
    .app-loading {
      position: fixed; inset: 0; z-index: 1500;
      background: var(--bg);
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px;
      opacity: 1; transition: opacity 0.25s ease;
    }
    .app-loading.is-hidden { opacity: 0; pointer-events: none; }
    .app-loading-text { color: var(--text-muted); font-size: 13px; letter-spacing: 0.02em; }
    .app-loading-spinner {
      width: 22px; height: 22px; border: 2px solid var(--border-strong);
      border-top-color: var(--accent); border-radius: 50%;
      animation: lattice-spin 0.7s linear infinite;
    }
    .app-loading .brand-logo { width: 40px; height: 40px; }
    /* Zero-workspace welcome (Feature B). Full-screen, opaque, above the app
       chrome (topbar 100) but below modals (1000) so the onboarding wizard sits
       on top. The onboarding modal reuses .modal-backdrop. */
    .virgin-state {
      position: fixed; inset: 0; z-index: 200;
      background: var(--bg);
      display: flex; align-items: center; justify-content: center; padding: 24px;
    }
    .virgin-state .virgin-card {
      max-width: 420px; width: 100%; text-align: center;
      display: flex; flex-direction: column; align-items: center; gap: 14px;
    }
    .virgin-state .brand-logo { width: 56px; height: 56px; }
    .virgin-state h1 { margin: 4px 0 0; font-size: 22px; }
    .virgin-state p { margin: 0; color: var(--text-muted); font-size: 14px; }
    .virgin-state .virgin-actions { display: flex; gap: 10px; margin-top: 8px; }
    .modal .ob-kind {
      flex: 1; display: flex; align-items: center; gap: 8px; cursor: pointer;
      padding: 10px 12px; border: 1px solid var(--border-strong); border-radius: 8px;
      background: var(--surface-2);
    }
    /* Connect-with-Claude: a black, centered button carrying the Claude mark. */
    .connect-claude-btn {
      display: flex; align-items: center; justify-content: center; gap: 8px;
      width: 100%; box-sizing: border-box; padding: 9px 14px; border-radius: 8px;
      background: #0b0d10; color: #fff; border: 1px solid var(--border-strong);
      font-size: 13px; font-weight: 600; text-decoration: none; cursor: pointer;
    }
    .connect-claude-btn:hover { background: #16191d; border-color: var(--accent); }
    .connect-claude-btn .claude-logo {
      width: 18px; height: 18px; flex: 0 0 auto; color: #d97757; /* Claude orange */
    }
    /* Privacy indicators: faint lock/eye in the sidebar object list + a clearer
       one on the entity detail header. */
    .nav-vis { display: inline-flex; align-items: center; margin-left: 5px; color: var(--text-muted); opacity: 0.45; }
    .nav-vis svg { width: 12px; height: 12px; }
    /* Shared lock/eye indicator (sidebar/detail/cards) — see visIndicator(). */
    .vis-indicator { display: inline-flex; align-items: center; color: var(--text-muted); }
    .vis-indicator svg { width: 14px; height: 14px; }
    .detail-vis-icon { display: inline-flex; align-items: center; color: var(--text-muted); }
    .detail-vis-icon svg { width: 14px; height: 14px; }
    button.is-busy { opacity: 0.75; cursor: progress; }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    .toast .undo-link {
      color: var(--accent); cursor: pointer; font-weight: 600;
      background: transparent; border: none; padding: 0; font: inherit;
    }
    .toast .undo-link:hover { color: var(--accent-deep); }
    .toast .toast-dismiss {
      background: transparent; border: none; color: #64748b;
      cursor: pointer; padding: 0 4px; font-size: 16px; line-height: 1;
    }
    .toast .toast-dismiss:hover { color: var(--text); }

`;
