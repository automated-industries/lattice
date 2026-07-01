import { css } from './app/css.js';
import { appJs } from './app/script.js';
import { analyticsJs } from './app/analytics.js';

export const guiAppHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Lattice Browser</title>
  <style>${css}</style>
</head>
<body>
  <div id="app-loading" class="app-loading" role="status" aria-live="polite" aria-busy="true" aria-label="Loading Lattice">
    <svg class="brand-logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="0.5" y="0.5" width="23" height="23" rx="5" fill="#eff6ff" stroke="#dbeafe"/>
      <line x1="6" y1="6" x2="18" y2="6" stroke="#3b82f6" stroke-width="1.25" stroke-linecap="round"/>
      <line x1="6" y1="12" x2="18" y2="12" stroke="#3b82f6" stroke-width="1.25" stroke-linecap="round"/>
      <line x1="6" y1="18" x2="18" y2="18" stroke="#3b82f6" stroke-width="1.25" stroke-linecap="round"/>
      <line x1="6" y1="6" x2="6" y2="18" stroke="#3b82f6" stroke-width="1.25" stroke-linecap="round"/>
      <line x1="12" y1="6" x2="12" y2="18" stroke="#3b82f6" stroke-width="1.25" stroke-linecap="round"/>
      <line x1="18" y1="6" x2="18" y2="18" stroke="#3b82f6" stroke-width="1.25" stroke-linecap="round"/>
      <circle cx="6" cy="6" r="1.7" fill="#3b82f6"/>
      <circle cx="12" cy="6" r="1.7" fill="#3b82f6"/>
      <circle cx="18" cy="6" r="1.7" fill="#3b82f6"/>
      <circle cx="6" cy="12" r="1.7" fill="#3b82f6"/>
      <circle cx="12" cy="12" r="2.4" fill="#3b82f6"/>
      <circle cx="18" cy="12" r="1.7" fill="#3b82f6"/>
      <circle cx="6" cy="18" r="1.7" fill="#3b82f6"/>
      <circle cx="12" cy="18" r="1.7" fill="#3b82f6"/>
      <circle cx="18" cy="18" r="1.7" fill="#3b82f6"/>
    </svg>
    <span class="app-loading-spinner" aria-hidden="true"></span>
    <div class="app-loading-text">Loading…</div>
  </div>
  <header class="topbar">
    <a class="brand" href="#/" title="Go to dashboard" aria-label="Lattice — dashboard">
      <svg class="brand-logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="0.5" y="0.5" width="23" height="23" rx="5" fill="#eff6ff" stroke="#dbeafe"/>
        <line x1="6" y1="6" x2="18" y2="6" stroke="#3b82f6" stroke-width="1.25" stroke-linecap="round"/>
        <line x1="6" y1="12" x2="18" y2="12" stroke="#3b82f6" stroke-width="1.25" stroke-linecap="round"/>
        <line x1="6" y1="18" x2="18" y2="18" stroke="#3b82f6" stroke-width="1.25" stroke-linecap="round"/>
        <line x1="6" y1="6" x2="6" y2="18" stroke="#3b82f6" stroke-width="1.25" stroke-linecap="round"/>
        <line x1="12" y1="6" x2="12" y2="18" stroke="#3b82f6" stroke-width="1.25" stroke-linecap="round"/>
        <line x1="18" y1="6" x2="18" y2="18" stroke="#3b82f6" stroke-width="1.25" stroke-linecap="round"/>
        <circle cx="6" cy="6" r="1.7" fill="#3b82f6"/>
        <circle cx="12" cy="6" r="1.7" fill="#3b82f6"/>
        <circle cx="18" cy="6" r="1.7" fill="#3b82f6"/>
        <circle cx="6" cy="12" r="1.7" fill="#3b82f6"/>
        <circle cx="12" cy="12" r="2.4" fill="#3b82f6"/>
        <circle cx="18" cy="12" r="1.7" fill="#3b82f6"/>
        <circle cx="6" cy="18" r="1.7" fill="#3b82f6"/>
        <circle cx="12" cy="18" r="1.7" fill="#3b82f6"/>
        <circle cx="18" cy="18" r="1.7" fill="#3b82f6"/>
      </svg>
    </a>
    <div class="db-switcher" id="ws-switcher">
      <button class="db-button" id="ws-button" title="Switch workspace">
        <span class="db-status" id="ws-status" title="Workspace"></span>
        <span class="db-icon">📂</span>
        <span class="db-name" id="ws-name">workspace</span>
        <span class="db-caret">▾</span>
      </button>
      <div class="db-menu" id="ws-menu" hidden></div>
    </div>
    <div class="topsearch" id="topsearch">
      <span class="topsearch-icon" aria-hidden="true">🔍</span>
      <input type="search" id="search-input" placeholder="Ask the assistant…" autocomplete="off" spellcheck="false" aria-label="Ask the assistant" />
      <div class="search-results" id="search-results" hidden></div>
    </div>
    <div class="history-controls">
      <button class="history-btn" id="undo-btn" title="Undo" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg></button>
      <button class="history-btn" id="redo-btn" title="Redo" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg></button>
      <a class="history-btn" id="history-link" href="#/settings/history" title="Version history">🕐</a>
    </div>
    <div class="activity" id="activity">
      <button class="history-btn activity-pill" id="activity-pill" title="Recent activity" aria-haspopup="true" aria-expanded="false">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>
        <span class="activity-count" id="activity-count" hidden>0</span>
      </button>
      <div class="activity-popover" id="activity-popover" hidden>
        <div class="activity-popover-head">Recent activity</div>
        <div class="activity-feed" id="activity-feed">
          <div class="activity-empty" id="activity-empty">No activity yet. Changes you make appear here.</div>
        </div>
      </div>
    </div>
    <span class="app-version" id="app-version" title="Lattice version"><!--LATTICE_VERSION--></span>
    <a id="app-update-link" href="#" hidden>Update available — Upgrade</a>
    <button id="settings-gear" title="Settings" aria-label="Open settings">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
      </svg>
    </button>
    <div class="ask-lattice" id="ask-lattice">
      <button class="ask-lattice-trigger" id="ask-lattice-trigger" title="Ask Lattice" aria-haspopup="dialog" aria-expanded="false">
        <span class="ask-lattice-mark" aria-hidden="true">✦</span><span class="ask-lattice-label">Ask Lattice</span>
      </button>
    </div>
  </header>
  <div class="layout">
    <nav class="sidebar">
      <div class="col-header col-inputs"><span class="col-header-text">Inputs</span><button class="col-collapse" data-col="inputs" type="button" title="Collapse Inputs" aria-label="Collapse Inputs">‹</button></div>
      <div id="sources-nav">
        <div class="src-group">
          <button class="section-label section-toggle" data-group="files" type="button" aria-expanded="true">
            <span class="section-caret">▾</span><span class="section-label-text">Files</span>
          </button>
          <div class="section-body" data-group-body="files">
            <div id="src-files-tree"></div>
            <div class="src-add-row">
              <button class="src-add" id="src-add-folder" type="button">＋ Folder</button>
              <button class="src-add" id="src-add-file" type="button">＋ File</button>
            </div>
            <div class="src-note"><span class="src-note-ic">🔒</span>Secured: files never leave your computer.</div>
          </div>
        </div>
        <div class="src-group">
          <button class="section-label section-toggle" data-group="connectors" type="button" aria-expanded="true">
            <span class="section-caret">▾</span><span class="section-label-text">Connectors</span>
          </button>
          <div class="section-body" data-group-body="connectors">
            <div id="src-connectors-list"></div>
            <button class="src-add" id="src-add-connector" type="button">＋ Add a Connector</button>
          </div>
        </div>
        <div class="src-group">
          <button class="section-label section-toggle" data-group="databases" type="button" aria-expanded="true">
            <span class="section-caret">▾</span><span class="section-label-text">Databases</span>
          </button>
          <div class="section-body" data-group-body="databases">
            <div id="src-databases-list"></div>
            <button class="src-add" id="src-add-database" type="button">＋ Connect a Database</button>
          </div>
        </div>
      </div>
      <div id="objects-section" hidden>
        <button class="section-label section-toggle" data-group="objects" type="button" aria-expanded="true">
          <span class="section-caret">▾</span><span class="section-label-text">Objects</span>
        </button>
        <div class="section-body" data-group-body="objects">
          <ul id="object-nav"></ul>
        </div>
      </div>
      <div id="system-section" hidden>
        <button class="section-label section-toggle" data-group="system" type="button" aria-expanded="true">
          <span class="section-caret">▾</span><span class="section-label-text">System</span>
        </button>
        <div class="section-body" data-group-body="system">
          <ul id="system-nav"></ul>
        </div>
      </div>
    </nav>
    <main class="content-wrap">
      <div class="tabstrip col-header col-model" id="tabstrip">
        <span class="col-header-text">Model</span>
        <div class="tabstrip-tabs" id="tabstrip-tabs"></div>
        <div class="wm-actions">
          <button class="wm-btn" id="wm-wire-btn" type="button" title="Link two objects (many-to-many) — click a source then a target, or drag one object onto another">+ Wire</button>
          <button class="wm-btn" id="wm-merge-btn" type="button" title="Merge one object into another — moves its rows in, then removes it (reversible). Shift-drag one object onto another to merge.">Merge</button>
        </div>
        <div class="tabstrip-status" id="tabstrip-status"></div>
        <button class="col-collapse col-collapse-center" data-col="model" type="button" title="Collapse Model" aria-label="Collapse Model">‹›</button>
      </div>
      <div id="content"></div>
    </main>
    <aside class="outputs" id="outputs-rail" aria-label="Outputs">
      <div class="outputs-resize" id="outputs-resize" role="separator" aria-orientation="vertical" title="Drag to resize"></div>
      <div class="outputs-head col-header col-outputs"><span class="col-header-text">Outputs</span><button class="col-collapse" data-col="outputs" type="button" title="Collapse Outputs" aria-label="Collapse Outputs">›</button></div>
      <div class="outputs-body" id="outputs-body">
        <section class="out-group">
          <button class="section-label section-toggle" data-group="out-artifacts" type="button" aria-expanded="true">
            <span class="section-caret">▾</span><span class="section-label-text">Artifacts</span>
          </button>
          <div class="section-body" data-group-body="out-artifacts"><div id="out-artifacts-tree"></div></div>
        </section>
        <section class="out-group">
          <button class="section-label section-toggle" data-group="out-markdown" type="button" aria-expanded="true">
            <span class="section-caret">▾</span><span class="section-label-text">Markdown</span>
          </button>
          <div class="section-body" data-group-body="out-markdown"><div id="out-markdown-tree"></div></div>
        </section>
        <section class="out-group">
          <button class="section-label section-toggle" data-group="out-tables" type="button" aria-expanded="true">
            <span class="section-caret">▾</span><span class="section-label-text">Tables</span>
          </button>
          <div class="section-body" data-group-body="out-tables"><div id="out-tables-mount"></div></div>
        </section>
        <section class="out-group">
          <button class="section-label section-toggle" data-group="out-serverdocs" type="button" aria-expanded="true">
            <span class="section-caret">▾</span><span class="section-label-text">Server Docs</span>
          </button>
          <div class="section-body" data-group-body="out-serverdocs"><div id="out-serverdocs"><div class="out-placeholder">Coming soon.</div></div></div>
        </section>
        <section class="out-group">
          <button class="section-label section-toggle" data-group="out-apidocs" type="button" aria-expanded="true">
            <span class="section-caret">▾</span><span class="section-label-text">API Docs</span>
          </button>
          <div class="section-body" data-group-body="out-apidocs">
            <a class="out-link" id="out-apidocs-link" href="https://latticesql.com/docs" target="_blank" rel="noopener">Open the docs ↗</a>
          </div>
        </section>
        <section class="out-group">
          <button class="section-label section-toggle" data-group="out-mcp" type="button" aria-expanded="true">
            <span class="section-caret">▾</span><span class="section-label-text">MCP</span>
          </button>
          <div class="section-body" data-group-body="out-mcp"><div class="out-placeholder">Coming soon.</div></div>
        </section>
      </div>
    </aside>
  </div>

  <div class="drawer-backdrop" id="drawer-backdrop" hidden></div>
  <aside class="settings-drawer" id="settings-drawer" hidden aria-label="Settings">
    <div class="drawer-head">
      <span class="drawer-title">Settings</span>
      <button class="drawer-close" id="drawer-close" title="Close" aria-label="Close settings">✕</button>
    </div>
    <div class="drawer-tabs" id="drawer-tabs">
      <button class="drawer-tab" data-tab="database">Workspace</button>
      <button class="drawer-tab" data-tab="lattice">Lattice</button>
      <button class="drawer-tab" data-tab="user">User</button>
    </div>
    <div class="drawer-body" id="drawer-body"></div>
  </aside>

  <div class="connectors-backdrop" id="connectors-backdrop" hidden></div>
  <aside class="connectors-dialog" id="connectors-dialog" hidden aria-label="Connectors">
    <div class="drawer-head">
      <span class="drawer-title">Add a Connector</span>
      <button class="drawer-close" id="connectors-dialog-close" title="Close" aria-label="Close connectors">✕</button>
    </div>
    <div class="drawer-body" id="connectors-dialog-body"></div>
  </aside>

  <!-- Connect-a-database: the SAME side-drawer chrome as Add a Connector. -->
  <div class="connectors-backdrop" id="db-connect-backdrop" hidden></div>
  <aside class="connectors-dialog" id="db-connect-dialog" hidden aria-label="Connect a database">
    <div class="drawer-head">
      <span class="drawer-title">Connect a database</span>
      <button class="drawer-close" id="db-connect-close" title="Close" aria-label="Close">✕</button>
    </div>
    <div class="drawer-body" id="db-connect-body"></div>
  </aside>

  <!-- Floating assistant. The chat composer/feed/thread controls reuse the same
       element IDs the docked rail used (#rail-feed/#rail-composer/#rail-threads/
       #rail-newchat/#rail-empty), so the chat client code is unchanged — only its
       housing moved to this upper-right floating panel. -->
  <div class="ask-lattice-panel" id="ask-lattice-panel" role="dialog" aria-label="Ask Lattice">
    <div class="ask-lattice-panel-head">
      <span class="ask-lattice-panel-title"><span class="ask-lattice-mark" aria-hidden="true">✦</span> Ask Lattice</span>
      <select class="rail-threads" id="rail-threads" title="Conversations"></select>
      <button class="rail-newchat" id="rail-newchat" title="New chat">＋</button>
      <button class="ask-lattice-close" id="ask-lattice-close" title="Close" aria-label="Close">✕</button>
    </div>
    <div class="rail-feed" id="rail-feed">
      <div class="rail-empty" id="rail-empty">Ask anything about your workspace.</div>
    </div>
    <div class="rail-composer" id="rail-composer"></div>
  </div>

  <script>${analyticsJs}</script>
  <script>${appJs}</script>
</body>
</html>`;
