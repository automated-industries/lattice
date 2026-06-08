import { css } from './app/css.js';
import { appJs } from './app/script.js';

export const guiAppHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Lattice Browser</title>
  <style>${css}</style>
</head>
<body>
  <header class="topbar">
    <a class="brand" href="#/" title="Go to dashboard" aria-label="Lattice — dashboard">
      <svg class="brand-logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect width="24" height="24" rx="4" fill="#0b0d10"/>
        <line x1="6" y1="6" x2="18" y2="6" stroke="#bef264" stroke-width="0.5" opacity="0.4"/>
        <line x1="6" y1="12" x2="18" y2="12" stroke="#bef264" stroke-width="0.5" opacity="0.4"/>
        <line x1="6" y1="18" x2="18" y2="18" stroke="#bef264" stroke-width="0.5" opacity="0.4"/>
        <line x1="6" y1="6" x2="6" y2="18" stroke="#bef264" stroke-width="0.5" opacity="0.4"/>
        <line x1="12" y1="6" x2="12" y2="18" stroke="#bef264" stroke-width="0.5" opacity="0.4"/>
        <line x1="18" y1="6" x2="18" y2="18" stroke="#bef264" stroke-width="0.5" opacity="0.4"/>
        <circle cx="6" cy="6" r="1.5" fill="#bef264"/>
        <circle cx="12" cy="6" r="1.5" fill="#bef264"/>
        <circle cx="18" cy="6" r="1.5" fill="#bef264"/>
        <circle cx="6" cy="12" r="1.5" fill="#bef264"/>
        <circle cx="12" cy="12" r="2" fill="#bef264"/>
        <circle cx="18" cy="12" r="1.5" fill="#bef264"/>
        <circle cx="6" cy="18" r="1.5" fill="#bef264"/>
        <circle cx="12" cy="18" r="1.5" fill="#bef264"/>
        <circle cx="18" cy="18" r="1.5" fill="#bef264"/>
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
      <input type="search" id="search-input" placeholder="Search all tables…" autocomplete="off" spellcheck="false" aria-label="Full-text search" />
      <div class="search-results" id="search-results" hidden></div>
    </div>
    <div class="history-controls">
      <button class="history-btn" id="undo-btn" title="Undo" disabled>↶</button>
      <button class="history-btn" id="redo-btn" title="Redo" disabled>↷</button>
      <a class="history-btn" id="history-link" href="#/settings/history" title="Version history">🕐</a>
    </div>
    <span class="offline-pill" id="offline-pill" title="Edits queued offline — will sync when the cloud reconnects" hidden></span>
    <button id="settings-gear" title="Settings" aria-label="Open settings">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
      </svg>
    </button>
  </header>
  <div class="layout">
    <nav class="sidebar">
      <label class="sidebar-advanced toggle" title="Advanced mode — row/table editor instead of the file workspace">
        <input type="checkbox" id="advanced-toggle">
        <span class="toggle-track"><span class="toggle-thumb"></span></span>
        <span class="toggle-label">Advanced View</span>
      </label>
      <div class="section-label">Objects</div>
      <ul id="object-nav"></ul>
      <div id="system-section" hidden>
        <div class="section-label">System</div>
        <ul id="system-nav"></ul>
      </div>
    </nav>
    <main id="content"></main>
    <aside class="assistant-rail" id="assistant-rail">
      <div class="rail-resize" id="rail-resize" role="separator" aria-orientation="vertical" title="Drag to resize"></div>
      <div class="rail-handle" id="rail-handle" title="Expand / collapse"></div>
      <div class="rail-header">
        <span class="rail-title">Assistant</span>
        <select class="rail-threads" id="rail-threads" title="Conversations"></select>
        <button class="rail-newchat" id="rail-newchat" title="New chat">＋</button>
      </div>
      <div class="rail-feed" id="rail-feed">
        <div class="rail-empty" id="rail-empty">No activity yet. Changes you make will appear here.</div>
      </div>
      <div class="rail-composer" id="rail-composer"></div>
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

  <script>${appJs}</script>
</body>
</html>`;
