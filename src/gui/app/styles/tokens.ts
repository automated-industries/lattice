// Auto-composed section of the GUI stylesheet. Verbatim substring of the original
// css template literal — do not hand-edit; see styles/index.ts for composition.
export const tokensCss = `
    /* Design tokens — kept in sync with lattice-website's tailwind.config.ts
       (theme.extend.colors). The GUI ships these inline so it needs no build
       step or network fetch — keep in sync manually when the website palette
       changes. Enterprise light theme: white background, light-blue accent,
       light borders, flat surfaces with only subtle elevation. */
    :root {
      --bg: #ffffff;
      --surface: #ffffff;
      --surface-2: #f1f5f9;
      --border: #e6eaf0;
      --border-strong: #cbd5e1;
      --text: #0f172a;
      --text-muted: #64748b;
      --accent: #3b82f6;
      --accent-deep: #2563eb;
      --accent-glow: #60a5fa;
      --accent-soft: rgba(59, 130, 246, 0.12);
      --btn-text: #ffffff;                  /* text/icon sitting on the accent fill */
      --row-hover: #f4f7fb;
      --signal: #2563eb;
      --warn: #f59e0b;
      --danger: #ef4444;
      --danger-deep: #dc2626;

      /* Elevation — light + subtle (flat with only a hint of depth) */
      --shadow-1: 0 1px 2px rgba(15, 23, 42, 0.06);
      --shadow-2: 0 2px 8px -2px rgba(15, 23, 42, 0.08);
      --shadow-3: 0 10px 30px -8px rgba(15, 23, 42, 0.10);
      --shadow-4: 0 24px 60px -16px rgba(15, 23, 42, 0.12), 0 2px 8px rgba(15, 23, 42, 0.06);
      --shadow: var(--shadow-1);            /* back-compat alias for existing uses */
      --hl-top: inset 0 1px 0 rgba(255, 255, 255, 0.6); /* subtle top highlight on white surfaces */

      /* Glass (frosted chrome) — light */
      --glass: rgba(255, 255, 255, 0.72);
      --glass-strong: rgba(255, 255, 255, 0.85);
      --blur: saturate(120%) blur(14px);
      --blur-lg: saturate(120%) blur(20px);

      /* Subtle sheen + light-blue glow */
      --sheen: linear-gradient(180deg, rgba(255, 255, 255, 0.6), rgba(255, 255, 255, 0) 64px);
      --glow-accent: 0 0 0 1px rgba(59, 130, 246, 0.30), 0 0 18px -2px rgba(59, 130, 246, 0.35);
      --glow-accent-soft: 0 0 14px -4px rgba(59, 130, 246, 0.30);
      --glow-focus: 0 0 0 2px #ffffff, 0 0 0 4px rgba(59, 130, 246, 0.55);

      --nav-width: 220px;
      --outputs-width: 416px;
    }
    /* ── Design-system scales ─────────────────────────────────────────────────
       Fallback policy: root tokens load first in this same <style>, so
       var(--x, fallback) fallbacks on root tokens only ever fire on typos —
       silently wrong. Rules below the token layer reference root tokens WITHOUT
       fallbacks. Keep fallbacks only for JS/state-scoped custom props set at
       runtime (--col-accent, --gnode-label-size, --ask-dock-width, --gtc-*).

       Spacing + font-size stay literal values on these scales (enforced by the
       css-value-scale unit test):
         spacing {2,4,6,8,10,12,14,16,18,20,24,28,32,40,48,56}  (1px = borders only)
         type    {10,11,12,13,14,15,16,18,20,22,28}  (13 = UI control, 14 = body;
                  emoji glyphs 34–46 exempt)
       z-index values ≤ 10 (intra-component layering) stay literal. */
    :root {
      /* Hue mini-palette — field tints / chips / column accents */
      --hue-slate: #94a3b8;
      --hue-violet: #a78bfa;
      --hue-violet-deep: #7c3aed;
      --hue-cyan: #22d3ee;
      --hue-cyan-deep: #0891b2;
      --hue-teal-deep: #0d9488;
      --hue-emerald: #34d399;
      --hue-emerald-deep: #059669;
      --hue-amber: #fbbf24;
      --hue-amber-deep: #d97706;
      --hue-amber-ink: #b45309;
      --hue-orange: #fb923c;
      --hue-red: #f87171; /* border tint only */

      /* Claude brand isolate — intentional, exempt from the palette rules */
      --brand-claude: #d97757;
      --brand-claude-btn: #0b0d10;
      --brand-claude-btn-hover: #16191d;

      /* Accent / danger / warn alpha steps (--accent-soft above stays the 12% step) */
      --accent-wash: color-mix(in srgb, var(--accent) 8%, transparent);
      --accent-tint: color-mix(in srgb, var(--accent) 18%, transparent);
      --accent-border-soft: color-mix(in srgb, var(--accent) 25%, transparent);
      --accent-border: color-mix(in srgb, var(--accent) 40%, transparent);
      --danger-wash: color-mix(in srgb, var(--danger) 8%, transparent);
      --danger-soft: color-mix(in srgb, var(--danger) 12%, transparent);
      --danger-border: color-mix(in srgb, var(--danger) 40%, transparent);
      --warn-wash: color-mix(in srgb, var(--warn) 8%, transparent);
      --warn-soft: color-mix(in srgb, var(--warn) 12%, transparent);
      --warn-border: color-mix(in srgb, var(--warn) 40%, transparent);
      --glow-warn: 0 0 0 1px color-mix(in srgb, var(--warn) 30%, transparent),
        0 0 18px -2px color-mix(in srgb, var(--warn) 35%, transparent);
      /* Opaque status pairs (badges/banners that must not blend) */
      --warn-bg: #fef3c7;
      --warn-edge: #fcd34d;
      --warn-ink: #92400e;
      --danger-bg: #fee2e2;
      --danger-ink: #b91c1c;
      /* Ink alphas — same value, distinct roles (kept separate on purpose) */
      --edge-faint: rgba(15, 23, 42, 0.05); /* hairline edges */
      --hover-veil: rgba(15, 23, 42, 0.05); /* hover washes */

      /* Radius scale — snaps: 7→sm, 9→md; literal 50% only for fixed circles */
      --r-xs: 4px;
      --r-sm: 6px;
      --r-md: 8px;
      --r-lg: 10px;
      --r-xl: 12px;
      --r-2xl: 16px;
      --r-pill: 999px;

      /* Z tiers — exact current values (find-replace only; in-content dropdowns
         merge at --z-menu, each the sole floater in its own stacking context) */
      --z-menu: 60;
      --z-takeover-scrim: 90;
      --z-takeover: 95;
      --z-topbar: 100;
      --z-popover: 110;
      --z-drawer-scrim: 120;
      --z-drawer: 130;
      --z-gate: 200;
      --z-modal: 1000;
      --z-boot: 1500;
      --z-toast: 2000;
      --z-banner: 2100;
      --z-ghost: 3000;
      --z-wall: 5000;
      --z-veil: 8000;
      --z-dropzone: 9000;

      /* Motion — easing stays literal ease; spinner/pulse durations stay bespoke */
      --dur-1: 0.12s;
      --dur-2: 0.18s;
      --dur-3: 0.25s;

      /* Fonts — system stacks (no webfont is ever loaded) */
      --font-ui: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

      /* Overlay / selection */
      --overlay-dim: rgba(15, 23, 42, 0.45);
      --overlay-dim-soft: rgba(15, 23, 42, 0.15);
      --overlay-blur: blur(3px);
      --ring-select: 0 0 0 2px var(--accent-soft);
    }
    /* Keep frosted surfaces opaque where backdrop-filter is unsupported */
    @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
      header.topbar, .outputs, .ask-dock, .modal, .settings-drawer,
      .db-menu, .search-results, .emoji-grid { background: var(--surface); }
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      font-family: var(--font-ui);
      color: var(--text);
      background: var(--bg);
      font-size: 14px;
    }
    code, kbd, samp, pre {
      font-family: var(--font-mono);
    }
    /* Form controls take the theme tokens so they're consistent across every
       surface (a bare input on a modal, the Database wizard, User Config, etc.):
       dark text on a white field with a light border. Placeholders use the
       muted token. Affects every input/select/textarea across the GUI. */
    /* Text-like fields only — radios/checkboxes keep their native rendering
       (the box/border treatment mangles them). The accent color tints the native
       controls so checked radios/checkboxes are on-brand blue. */
    /* Shared "bubble" field style — one base for EVERY form field in the app
       (onboarding, settings, New workspace, Identity, invite, migrate-to-cloud, …) so
       fields look consistent everywhere. Rounder corners, a defined border, and real
       padding. Component-specific inputs (chat composer, table-cell editors) override
       this with their own higher-specificity rules; per-form INLINE styles must be
       removed to inherit it. */
    input:not([type='radio']):not([type='checkbox']):not([type='range']), select, textarea {
      color: var(--text);
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: var(--r-md);
      padding: 10px 12px;
      box-sizing: border-box;
    }
    input[type='radio'], input[type='checkbox'] { accent-color: var(--accent); }
    input::placeholder, textarea::placeholder {
      color: var(--text-muted);
      opacity: 1;
    }
    a { color: inherit; text-decoration: none; }
    button { font: inherit; cursor: pointer; }

    /* Light-blue focus ring for keyboard nav (mouse focus unaffected) */
    :where(button, a, [tabindex]):focus-visible {
      outline: none; box-shadow: var(--glow-focus); border-radius: var(--r-sm);
    }
    input:focus-visible, select:focus-visible, textarea:focus-visible {
      outline: none; border-color: var(--accent-deep); box-shadow: 0 0 0 3px var(--accent-soft);
    }

`;
