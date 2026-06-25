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
    /* Form controls take the theme tokens so they're consistent across every
       surface (a bare input on a modal, the Database wizard, User Config, etc.):
       dark text on a white field with a light border. Placeholders use the
       muted token. Affects every input/select/textarea across the GUI. */
    input, select, textarea {
      color: var(--text);
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

    /* Light-blue focus ring for keyboard nav (mouse focus unaffected) */
    :where(button, a, [tabindex]):focus-visible {
      outline: none; box-shadow: var(--glow-focus); border-radius: 6px;
    }
    input:focus-visible, select:focus-visible, textarea:focus-visible {
      outline: none; border-color: var(--accent-deep); box-shadow: 0 0 0 3px var(--accent-soft);
    }

`;
