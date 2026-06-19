// Auto-composed section of the GUI stylesheet. Verbatim substring of the original
// css template literal — do not hand-edit; see styles/index.ts for composition.
export const tokensCss = `
    /* Design tokens copied from lattice-website's tailwind.config.ts
       (tailwind.config theme.extend.colors). The local GUI ships these
       inline so it doesn't need a build step or a network fetch — keep
       in sync manually when the website's palette changes. Last sync:
       tailwind.config.ts as of feat/teams branch. */
    :root {
      --bg: #0b0d10;
      --surface: #13171b;
      --surface-2: #1a1f25;
      --border: #262d36;
      --border-strong: #2f3742;
      --text: #e7ecf0;
      --text-muted: #8b96a3;
      --accent: #bef264;
      --accent-deep: #84cc16;
      --accent-glow: #d9f99d;
      --accent-soft: rgba(190, 242, 100, 0.12);
      --row-hover: #1a1f25;
      --signal: #22d3ee;
      --warn: #fb923c;
      --danger: #ef4444;
      --danger-deep: #dc2626;

      /* Elevation — layered, dark-tuned (the flat --shadow becomes an alias) */
      --shadow-1: 0 1px 2px rgba(0, 0, 0, 0.4);
      --shadow-2: 0 2px 8px -2px rgba(0, 0, 0, 0.5);
      --shadow-3: 0 10px 30px -8px rgba(0, 0, 0, 0.55);
      --shadow-4: 0 24px 60px -16px rgba(0, 0, 0, 0.65), 0 2px 8px rgba(0, 0, 0, 0.4);
      --shadow: var(--shadow-1);            /* back-compat alias for existing uses */
      --hl-top: inset 0 1px 0 rgba(255, 255, 255, 0.06); /* top highlight for elevated/glass surfaces */

      /* Glass (frosted chrome) */
      --glass: rgba(19, 23, 27, 0.72);
      --glass-strong: rgba(19, 23, 27, 0.85);
      --blur: saturate(140%) blur(14px);
      --blur-lg: saturate(140%) blur(20px);

      /* Single-hue sheen + lime glow */
      --sheen: linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0) 64px);
      --glow-accent: 0 0 0 1px rgba(190, 242, 100, 0.35), 0 0 18px -2px rgba(190, 242, 100, 0.45);
      --glow-accent-soft: 0 0 14px -4px rgba(190, 242, 100, 0.35);
      --glow-focus: 0 0 0 2px #0b0d10, 0 0 0 4px rgba(190, 242, 100, 0.55);

      --nav-width: 220px;
      --sidebar-width: 320px;
    }
    /* Keep frosted surfaces opaque where backdrop-filter is unsupported */
    @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
      header.topbar, .assistant-rail, .modal, .settings-drawer,
      .db-menu, .search-results, .emoji-grid { background: var(--surface); }
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: var(--text);
      background: var(--bg);
      font-size: 14px;
    }
    code, kbd, samp, pre {
      font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    /* Form controls inherit the body text color so they're readable
       on the dark surface. Browsers default inputs to the OS color
       (typically black), which disappears on var(--surface)=#13171b.
       Placeholders default ~black too — bump them to --text-muted.
       Affects every input/select/textarea across the GUI (Data Model
       editor, Database wizard, User Config Identity, all modals). */
    input, select, textarea {
      color: var(--text);
      /* Without an explicit background, bare inputs (Database Settings
         name field, Lattice Settings, invite token box) render the
         browser-default white background while the global color above
         is the light dark-theme text — i.e. light-on-white, unreadable.
         Default to the dark surface; contexts that want a different
         background (modals, wizard) override via more specific rules. */
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
    }
    input::placeholder, textarea::placeholder {
      color: var(--text-muted);
      opacity: 1;
    }
    a { color: inherit; text-decoration: none; }
    button { font: inherit; cursor: pointer; }

    /* Lime focus ring for keyboard nav (mouse focus unaffected) */
    :where(button, a, [tabindex]):focus-visible {
      outline: none; box-shadow: var(--glow-focus); border-radius: 6px;
    }
    input:focus-visible, select:focus-visible, textarea:focus-visible {
      outline: none; border-color: var(--accent-deep); box-shadow: 0 0 0 3px var(--accent-soft);
    }

`;
