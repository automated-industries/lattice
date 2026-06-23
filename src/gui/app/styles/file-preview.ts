// Auto-composed section of the GUI stylesheet. Verbatim substring of the original
// css template literal — do not hand-edit; see styles/index.ts for composition.
export const filePreviewCss = `    /* ── File preview (files detail page) ──────────────── */
    .file-preview { margin: 4px 0 16px; }
    .file-preview .file-desc {
      margin: 0 0 10px; padding: 10px 12px; font-size: 13.5px; color: var(--text);
      background: var(--accent-soft); border-radius: 8px; border: 1px solid var(--border);
    }
    .file-preview .artifact-badge {
      display: inline-block; margin: 0 0 10px; padding: 2px 9px; font-size: 11.5px; font-weight: 600;
      letter-spacing: 0.02em; color: var(--accent); background: var(--accent-soft);
      border: 1px solid var(--border); border-radius: 999px;
    }
    .file-preview img { max-width: 100%; max-height: 60vh; border: 1px solid var(--border); border-radius: 8px; display: block; }
    .file-preview iframe { width: 100%; height: 60vh; border: 1px solid var(--border); border-radius: 8px; background: #fff; }
    .file-preview pre {
      max-height: 50vh; overflow: auto; background: var(--surface-2); border: 1px solid var(--border);
      border-radius: 8px; padding: 12px; font-size: 12.5px; white-space: pre-wrap; word-break: break-word;
    }
    .file-preview .file-unsupported { color: var(--text-muted); font-size: 13px; padding: 10px 0; }
    .file-preview .md-body { font-size: 13.5px; line-height: 1.55; color: var(--text); max-height: 60vh; overflow: auto; padding: 4px 2px; }
    .file-preview .md-body h1, .file-preview .md-body h2, .file-preview .md-body h3,
    .file-preview .md-body h4 { margin: 12px 0 6px; line-height: 1.3; }
    .file-preview .md-body ul { margin: 6px 0; padding-left: 20px; }
    .file-preview .md-body code { background: var(--surface-2); padding: 1px 4px; border-radius: 4px; font-size: 12.5px; }
    .file-preview .md-body pre { background: var(--surface-2); padding: 10px; border-radius: 8px; overflow: auto; }
    .file-preview .md-body pre code { background: none; padding: 0; }
    .file-preview .md-body a { color: var(--accent); }
    .file-preview .md-body ol { margin: 6px 0; padding-left: 22px; }
    .file-preview .md-body blockquote { margin: 8px 0; padding: 2px 12px; border-left: 3px solid var(--border); color: var(--text-muted); }
    .file-preview .md-body hr { border: none; border-top: 1px solid var(--border); margin: 14px 0; }
    .file-preview .md-body table { border-collapse: collapse; margin: 8px 0; font-size: 12.5px; }
    .file-preview .md-body th, .file-preview .md-body td { border: 1px solid var(--border); padding: 4px 8px; text-align: left; }
    .file-preview .md-body th { background: var(--surface-2); font-weight: 600; }
    .file-preview .file-actions { margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap; }
    /* A live HTML file renders in a taller frame than the generic file/PDF iframe. */
    .file-preview .html-frame { width: 100%; height: 78vh; min-height: 420px; border: 1px solid var(--border); border-radius: 8px; background: #fff; display: block; }
    .file-preview .artifact-badge.html-badge { color: var(--text); background: var(--surface-2); }

`;
