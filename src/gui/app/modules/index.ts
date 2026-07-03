// Composes the GUI client script from its per-subsystem segments, in exact original
// order, joined with the empty string (pinned by tests/unit/app-js-composition.test.ts).
// NOTE: `chartLibJs` (the ~275 KB vendored Chart.js, ~31% of the bundle) is
// deliberately NOT composed here — it is served on demand at `/gui-assets/chart-lib.js`
// and fetched only when an HTML-file artifact preview needs it (see dashboard.ts
// ensureChartLib), so it no longer weighs on every startup's parse.
import { displayConfigJs } from './display-config.js';
import { bootJs } from './boot.js';
import { bootInterstitialJs } from './boot-interstitial.js';
import { realtimeFeedJs } from './realtime-feed.js';
import { statusIndicatorJs } from './status-indicator.js';
import { offlineEditQueueJs } from './offline-edit-queue.js';
import { eventStreamJs } from './event-stream.js';
import { renderProgressJs } from './render-progress.js';
import { renderProgressStateJs } from './render-progress-state.js';
import { activityHelpersJs } from './activity-helpers.js';
import { searchJs } from './search.js';
import { toastJs } from './toast.js';
import { versionHistoryUndoJs } from './version-history-undo.js';
import { workspaceSwitchProgressJs } from './workspace-switch-progress.js';
import { tabsJs } from './tabs.js';
import { sidebarJs } from './sidebar.js';
import { routerJs } from './router.js';
import { dashboardJs } from './dashboard.js';
import { tableViewJs } from './table-view.js';
import { detailViewJs } from './detail-view.js';
import { markdownJs } from './markdown.js';
import { settingsDrawerJs } from './settings-drawer.js';
import { systemTablesJs } from './system-tables.js';
import { graphIngestAnimationJs } from './graph-ingest-animation.js';
import { versionHistoryPageJs } from './version-history-page.js';
import { rowContextJs } from './row-context.js';
import { dataModelJs } from './data-model.js';
import { provenanceJs } from './provenance.js';
import { latticeTeamsJs } from './lattice-teams.js';
import { onboardingJs } from './onboarding.js';
import { voiceLocalJs } from './voice-local.js';
import { createDatabaseWizardJs } from './create-database-wizard.js';
import { inlineImportJs } from './inline-import.js';
import { connectorsSettingsJs } from './connectors-settings.js';
import { sourcesJs } from './sources.js';
import { inputsJs } from './inputs.js';
import { outputsJs } from './outputs.js';
import { activityHeaderJs } from './activity-header.js';
import { askLatticeJs } from './ask-lattice.js';
import { modelTablesJs } from './model-tables.js';
import { computedBuilderJs } from './computed-builder.js';
import { foldersJs } from './folders.js';
import { columnCollapseJs } from './column-collapse.js';
import { wireMergeJs } from './wiremerge.js';

export const appJs = [
  displayConfigJs,
  bootJs,
  bootInterstitialJs,
  realtimeFeedJs,
  statusIndicatorJs,
  offlineEditQueueJs,
  eventStreamJs,
  renderProgressJs,
  renderProgressStateJs,
  activityHelpersJs,
  searchJs,
  toastJs,
  versionHistoryUndoJs,
  workspaceSwitchProgressJs,
  tabsJs,
  sidebarJs,
  routerJs,
  dashboardJs,
  tableViewJs,
  // Must stay INSIDE the main client IIFE (alongside selectDrawerTab, which
  // dispatches to it) so renderConnectorsPanel can see the wrapper-scoped
  // helpers (fetchJson, escapeHtml). Appended last, it would be defined at true
  // global scope and throw "fetchJson is not defined" when the tab is opened.
  connectorsSettingsJs,
  sourcesJs,
  // The 5.0 Inputs/Model/Outputs segments. Like sourcesJs they use wrapper-scoped
  // helpers (fetchJson/escapeHtml/showToast/stageFiles) and are invoked from
  // renderSources()/boot(), so they MUST stay INSIDE the main client IIFE —
  // placed immediately after sourcesJs (the IIFE closes at the end of
  // createDatabaseWizardJs).
  inputsJs,
  outputsJs,
  activityHeaderJs,
  askLatticeJs,
  modelTablesJs,
  computedBuilderJs,
  foldersJs,
  columnCollapseJs,
  wireMergeJs,
  detailViewJs,
  markdownJs,
  settingsDrawerJs,
  systemTablesJs,
  graphIngestAnimationJs,
  versionHistoryPageJs,
  rowContextJs,
  dataModelJs,
  provenanceJs,
  latticeTeamsJs,
  onboardingJs,
  voiceLocalJs,
  createDatabaseWizardJs,
  inlineImportJs,
].join('');
