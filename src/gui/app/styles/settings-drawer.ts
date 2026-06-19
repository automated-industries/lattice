// Auto-composed section of the GUI stylesheet. Verbatim substring of the original
// css template literal — do not hand-edit; see styles/index.ts for composition.
export const settingsDrawerCss = `    /* ── Settings drawer (slide-over) ───────────────────── */
    .drawer-backdrop {
      position: fixed; inset: 0; background: rgba(7, 9, 11, 0.55);
      -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);
      z-index: 120; opacity: 0; transition: opacity 0.2s ease;
    }
    .drawer-backdrop.open { opacity: 1; }
    .settings-drawer {
      position: fixed; top: 0; right: 0; height: 100vh;
      width: min(620px, 94vw); background: rgba(19, 23, 27, 0.82);
      -webkit-backdrop-filter: var(--blur-lg); backdrop-filter: var(--blur-lg);
      border-left: 1px solid rgba(255, 255, 255, 0.06);
      box-shadow: -12px 0 32px rgba(0, 0, 0, 0.4), var(--shadow-4);
      z-index: 130; display: flex; flex-direction: column;
      transform: translateX(100%); transition: transform 0.22s ease;
    }
    .settings-drawer.open { transform: translateX(0); }
    .drawer-head {
      flex: 0 0 auto; display: flex; align-items: center; gap: 10px;
      padding: 14px 18px; border-bottom: 1px solid var(--border);
    }
    .drawer-title { font-size: 16px; font-weight: 600; }
    .drawer-close {
      margin-left: auto; width: 30px; height: 30px; border: 1px solid var(--border);
      border-radius: 6px; background: transparent; color: var(--text-muted);
      cursor: pointer; font-size: 16px; line-height: 1;
    }
    .drawer-close:hover { background: var(--row-hover); color: var(--text); }
    .drawer-tabs {
      flex: 0 0 auto; display: flex; gap: 4px; padding: 10px 14px 0;
    }
    .drawer-tab {
      padding: 7px 14px; border: 1px solid var(--border); border-bottom: none;
      border-radius: 6px 6px 0 0; background: var(--surface-2); color: var(--text-muted);
      font-size: 13px; cursor: pointer;
    }
    .drawer-tab.active { background: var(--surface); color: var(--text); font-weight: 600; border-color: var(--border-strong); }
    .drawer-body { flex: 1 1 auto; overflow-y: auto; padding: 4px 4px 20px; }
    .drawer-body .teams-page { padding: 16px 18px; }

    /* Toggle switch (advanced mode) */
    .toggle { display: flex; align-items: center; gap: 10px; cursor: pointer; }
    .toggle input { position: absolute; opacity: 0; width: 0; height: 0; }
    .toggle-track {
      position: relative; flex: 0 0 auto; width: 38px; height: 22px;
      background: var(--border-strong); border-radius: 999px; transition: background 0.15s ease;
    }
    .toggle-thumb {
      position: absolute; top: 2px; left: 2px; width: 18px; height: 18px;
      background: #fff; border-radius: 50%; transition: transform 0.15s ease;
    }
    .toggle input:checked + .toggle-track { background: var(--accent); }
    .toggle input:checked + .toggle-track .toggle-thumb { transform: translateX(16px); }
    .toggle-label { font-size: 13.5px; color: var(--text); }
    .toggle-label small { display: block; font-size: 11px; color: var(--text-muted); }


`;
