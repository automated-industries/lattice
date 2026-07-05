// Auto-composed section of the GUI stylesheet (see styles/index.ts). The
// first-run connect wall — a full-viewport, un-skippable overlay shown until a
// Claude subscription is connected. It sits above EVERYTHING (topbar, drawers,
// modals, toasts) so nothing behind it is reachable.
export const connectWallCss = `    /* ── First-run connect wall ─────────────────────────── */
    .connect-wall {
      position: fixed; inset: 0; z-index: 5000;
      display: flex; align-items: center; justify-content: center;
      padding: 24px;
      background: var(--surface);
      /* A subtle wash so it reads as a deliberate gate, not a blank page. */
      background-image: radial-gradient(120% 90% at 50% 0%, var(--accent-soft) 0%, transparent 60%);
    }
    .connect-wall-card {
      width: 100%; max-width: 440px; text-align: center;
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 16px; box-shadow: var(--shadow-3, 0 20px 60px rgba(15, 23, 42, 0.18));
      padding: 32px 28px;
    }
    .connect-wall-mark { font-size: 44px; line-height: 1; margin-bottom: 8px; }
    .connect-wall-card h1 { margin: 0 0 8px; font-size: 22px; font-weight: 700; color: var(--text); }
    .connect-wall-card p { margin: 0 auto 20px; max-width: 40ch; color: var(--text-muted); font-size: 14px; line-height: 1.5; }
    .connect-wall-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 100%; height: 44px; border-radius: 10px; font-size: 15px; font-weight: 600;
      text-decoration: none;
    }
    .connect-wall-paste { margin-top: 22px; text-align: left; }
    .connect-wall-paste label { display: block; font-size: 12.5px; font-weight: 600; color: var(--text-muted); margin-bottom: 6px; }
    .connect-wall-row { display: flex; gap: 8px; }
    .connect-wall-row input {
      flex: 1 1 auto; min-width: 0; height: 40px; padding: 0 12px;
      background: var(--surface-2); color: var(--text);
      border: 1px solid var(--border-strong); border-radius: 8px; font: inherit; font-size: 14px;
    }
    .connect-wall-row input:focus { outline: none; border-color: var(--accent); box-shadow: var(--glow-focus); }
    .connect-wall-row .btn { flex: 0 0 auto; height: 40px; }
    .connect-wall-status { margin-top: 8px; min-height: 18px; font-size: 12.5px; color: var(--text-muted); }

    /* ── Usage-limit banner (app-wide) ──────────────────── */
    .limit-banner {
      position: fixed; top: 0; left: 0; right: 0; z-index: 2100;
      padding: 8px 16px; text-align: center;
      background: #fef3c7; color: #92400e;
      border-bottom: 1px solid #fcd34d;
      font-size: 13px; font-weight: 600;
    }
`;
