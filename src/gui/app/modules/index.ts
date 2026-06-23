// Composes the GUI client script from its per-subsystem segments, in exact original
// order, joined with the empty string. The concatenation is byte-identical to the
// original single template literal (pinned by tests/unit/app-js-composition.test.ts).
import { chartLibJs } from './chart-lib.js';
import { displayConfigJs } from './display-config.js';
import { bootJs } from './boot.js';
import { bootInterstitialJs } from './boot-interstitial.js';
import { realtimeFeedJs } from './realtime-feed.js';
import { offlineEditQueueJs } from './offline-edit-queue.js';
import { eventStreamJs } from './event-stream.js';
import { renderProgressJs } from './render-progress.js';
import { renderProgressStateJs } from './render-progress-state.js';
import { activityHelpersJs } from './activity-helpers.js';
import { searchJs } from './search.js';
import { toastJs } from './toast.js';
import { versionHistoryUndoJs } from './version-history-undo.js';
import { workspaceSwitchProgressJs } from './workspace-switch-progress.js';
import { sidebarJs } from './sidebar.js';
import { routerJs } from './router.js';
import { dashboardJs } from './dashboard.js';
import { tableViewJs } from './table-view.js';
import { detailViewJs } from './detail-view.js';
import { markdownJs } from './markdown.js';
import { settingsDrawerJs } from './settings-drawer.js';
import { systemTablesJs } from './system-tables.js';
import { versionHistoryPageJs } from './version-history-page.js';
import { rowContextJs } from './row-context.js';
import { dataModelJs } from './data-model.js';
import { latticeTeamsJs } from './lattice-teams.js';
import { onboardingJs } from './onboarding.js';
import { createDatabaseWizardJs } from './create-database-wizard.js';
import { inlineImportJs } from './inline-import.js';
import { connectorsSettingsJs } from './connectors-settings.js';

export const appJs = [
  chartLibJs,
  displayConfigJs,
  bootJs,
  bootInterstitialJs,
  realtimeFeedJs,
  offlineEditQueueJs,
  eventStreamJs,
  renderProgressJs,
  renderProgressStateJs,
  activityHelpersJs,
  searchJs,
  toastJs,
  versionHistoryUndoJs,
  workspaceSwitchProgressJs,
  sidebarJs,
  routerJs,
  dashboardJs,
  tableViewJs,
  detailViewJs,
  markdownJs,
  settingsDrawerJs,
  systemTablesJs,
  versionHistoryPageJs,
  rowContextJs,
  dataModelJs,
  latticeTeamsJs,
  onboardingJs,
  createDatabaseWizardJs,
  inlineImportJs,
  connectorsSettingsJs,
].join('');
