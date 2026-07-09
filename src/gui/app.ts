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
    <div class="history-controls">
      <button class="history-btn" id="nav-back-btn" title="Back" aria-label="Back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg></button>
      <button class="history-btn" id="nav-fwd-btn" title="Forward" aria-label="Forward"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg></button>
      <span class="history-sep" aria-hidden="true"></span>
      <button class="history-btn" id="undo-btn" title="Undo" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg></button>
      <button class="history-btn" id="redo-btn" title="Redo" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg></button>
      <button class="history-btn" id="history-link" type="button" title="Version history" aria-label="Version history"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg></button>
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
    <span class="header-status-slot" id="header-status-slot"></span>
    <a id="app-update-link" href="#" hidden>Update available — Upgrade</a>
    <!-- Account menu: one status line + one action, set by JS (account-menu.ts)
         from the config. Normal install: "Connected with Claude" + Disconnect
         (connect happens at the first-run wall, never here). Managed/hosted
         deployment: the signed-in identity + "Account settings" (→ the operator's
         account page, where balance / billing / sign-out live). -->
    <div class="account" id="account" hidden>
      <button class="history-btn" id="account-btn" title="Account" aria-label="Account" aria-haspopup="true" aria-expanded="false">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
      </button>
      <div class="account-menu" id="account-menu" hidden>
        <div class="account-menu-head" id="account-menu-head">Connected with Claude</div>
        <button type="button" class="account-menu-item danger" id="account-action">Disconnect Claude</button>
      </div>
    </div>
    <!-- Single-layout: one Configure button (wrench) toggles the Configure drawer
         (Data Model / Inputs / Workspace / Lattice / User). There is no view flip —
         the Workspace + Ask Gladys dock are always visible. -->
    <button class="configure-trigger" id="configure-trigger" title="Configure this workspace" aria-label="Open Configure">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg><span class="ask-lattice-label">Configure</span>
    </button>
  </header>
  <!-- The single 3-column workspace layout: left sidebar (Dashboards + the Tables/
       Files/Markdown nav sections, added by nav-sections.ts) │ center Workspace tabs
       │ the persistent Ask Gladys dock. The former Inputs sidebar, Model tab strip,
       and Markdown rail moved into the left sidebar + the Configure drawer. -->
  <div class="layout" id="layout">
    <nav class="dash-sidebar">
      <section class="dash-section" data-section="dashboards">
        <div class="col-header col-dashboards">
          <span class="col-header-text">Dashboards</span>
          <button type="button" class="dash-new-btn" id="dash-new-btn" title="New dashboard" aria-label="New dashboard">＋</button>
        </div>
        <div id="dash-list"></div>
      </section>
    </nav>
    <main class="content-wrap">
      <div class="col-header col-model an-workspace-head"><span class="col-header-text">Workspace</span></div>
      <div class="antabstrip" id="antabstrip"><div class="antabstrip-tabs" id="antabstrip-tabs"></div></div>
      <div id="content"></div>
    </main>
    <aside class="ask-dock" id="ask-dock" aria-label="Ask Gladys">
      <div class="ask-dock-resize" id="ask-dock-resize" role="separator" aria-orientation="vertical" title="Drag to resize"></div>
      <div class="ask-dock-head col-header col-outputs">
        <span class="ask-lattice-panel-title col-header-text"><span class="ask-lattice-mark" aria-hidden="true">👵🏻</span> Ask Gladys</span>
        <select class="rail-threads" id="rail-threads" title="Conversations"></select>
        <button class="dash-new-btn rail-newchat" id="rail-newchat" title="New chat" aria-label="New chat">＋</button>
      </div>
      <div class="rail-feed" id="rail-feed">
        <div class="rail-empty" id="rail-empty">Ask your company anything.</div>
      </div>
      <div class="ask-status" id="ask-status" role="status" aria-live="polite" hidden></div>
      <!-- Pending clarification questions (questions client segment): interactive
           cards the user answers or dismisses — above the composer, visually
           distinct from the conversation bubbles. -->
      <div class="question-cards" id="question-cards"></div>
      <!-- Staged files "to add" — sits directly above the composer, each chip
           removable; the composer Send ingests them. -->
      <div class="staging-tray-host" id="staging-tray-host"></div>
      <div class="rail-composer" id="rail-composer"></div>
    </aside>
  </div>

  <div class="drawer-backdrop" id="drawer-backdrop" hidden></div>
  <aside class="settings-drawer" id="settings-drawer" hidden aria-label="Configure">
    <div class="drawer-head">
      <span class="drawer-title">Configure</span>
      <button class="drawer-close" id="drawer-close" title="Close" aria-label="Close settings">✕</button>
    </div>
    <!-- Version history is NOT a tab here — it's its own takeover opened via the
         header clock (🕐). These tabs are the Settings takeover only. -->
    <div class="drawer-tabs" id="drawer-tabs">
      <button class="drawer-tab" data-tab="database">Workspace</button>
      <button class="drawer-tab" data-tab="lattice">Lattice</button>
      <button class="drawer-tab" data-tab="user">User</button>
    </div>
    <div class="drawer-body" id="drawer-body"></div>
    <div class="drawer-version" title="Lattice version">Lattice <span class="app-version" id="app-version"><!--LATTICE_VERSION--></span></div>
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

  <script>${analyticsJs}</script>
  <script>${appJs}</script>
</body>
</html>`;
