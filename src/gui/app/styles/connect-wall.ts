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
    .connect-wall-card.cw-wide { max-width: 560px; }
    .connect-wall-mark { line-height: 1; margin-bottom: 10px; }
    .connect-wall-mark svg { width: 44px; height: 44px; display: inline-block; }
    .connect-wall-card h1 { margin: 0 0 6px; font-size: 22px; font-weight: 700; color: var(--text); }
    .connect-wall-card p { margin: 0 auto 18px; max-width: 46ch; color: var(--text-muted); font-size: 14px; line-height: 1.5; }
    .connect-wall-card .cw-tagline { margin: 0 auto 18px; font-size: 13px; color: var(--text-muted); }
    .connect-wall-card .cw-lead { margin: 0 auto 16px; }
    .connect-wall-card .cw-security { margin: 18px auto 0; max-width: 52ch; font-size: 12px; line-height: 1.5; }

    /* The wall's Claude CTA is the shared black Claude-logo button, sized up a touch. */
    .connect-wall .connect-claude-btn { padding: 12px 16px; border-radius: 10px; font-size: 15px; margin: 0 auto 6px; }
    .connect-wall .connect-claude-btn .claude-logo { width: 20px; height: 20px; }

    /* Step 1 — the two backend choices (Claude account vs any OpenAI-compatible endpoint). */
    .cw-choices { display: flex; gap: 12px; margin: 6px 0 4px; }
    .cw-choice {
      flex: 1 1 0; min-width: 0; text-align: center; cursor: pointer;
      padding: 18px 14px; border: 1px solid var(--border-strong); border-radius: 12px;
      background: var(--surface); color: var(--text); display: flex; flex-direction: column; gap: 3px;
      transition: border-color .12s, box-shadow .12s, background .12s;
    }
    .cw-choice:hover { border-color: var(--accent); box-shadow: var(--glow-focus); }
    .cw-choice strong { font-size: 15px; font-weight: 700; }
    .cw-choice span { font-size: 12px; color: var(--text-muted); }

    /* Wall inputs use the shared bubble field style (.lattice-input, below), stacked. */
    .connect-wall-card .cw-input { display: block; width: 100%; margin: 0 auto 10px; box-sizing: border-box; text-align: left; }

    .connect-wall-status { margin-top: 4px; min-height: 18px; font-size: 12.5px; color: var(--text-muted); text-align: center; }
    .connect-wall-status.cw-error { color: var(--danger, #c0392b); }

    /* Back / Connect actions. Connect fades until required fields are filled (disabled). */
    .cw-actions { display: flex; align-items: center; justify-content: space-between; margin-top: 18px; gap: 10px; }
    .cw-back {
      background: none; border: none; padding: 8px 4px; cursor: pointer;
      font: inherit; font-size: 14px; color: var(--text-muted);
    }
    .cw-back:hover { color: var(--text); }
    .cw-connect {
      padding: 9px 18px; border: none; border-radius: 8px; cursor: pointer;
      font: inherit; font-size: 14px; font-weight: 600; color: #fff; background: var(--accent);
    }
    .cw-connect:hover:not(:disabled) { filter: brightness(1.05); }
    .cw-connect:disabled { opacity: .45; cursor: not-allowed; }

    .cw-spinner {
      width: 34px; height: 34px; margin: 4px auto 14px; border-radius: 50%;
      border: 3px solid var(--border); border-top-color: var(--accent);
      animation: cw-spin .8s linear infinite;
    }
    @keyframes cw-spin { to { transform: rotate(360deg); } }

    /* ── Usage-limit banner (app-wide) ──────────────────── */
    .limit-banner {
      position: fixed; top: 0; left: 0; right: 0; z-index: 2100;
      padding: 8px 16px; text-align: center;
      background: #fef3c7; color: #92400e;
      border-bottom: 1px solid #fcd34d;
      font-size: 13px; font-weight: 600;
    }
`;
