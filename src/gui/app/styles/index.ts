// Composes the GUI stylesheet from its per-section segments, in exact original
// order, joined with the empty string. The concatenation is byte-identical to the
// original single template literal (pinned by tests/unit/app-css-composition.test.ts).
import { tokensCss } from './tokens.js';
import { topbarCss } from './topbar.js';
import { searchCss } from './search.js';
import { realtimeCss } from './realtime.js';
import { layoutCss } from './layout.js';
import { filePreviewCss } from './file-preview.js';
import { dashboardCss } from './dashboard.js';
import { tableViewCss } from './table-view.js';
import { detailViewCss } from './detail-view.js';
import { dataModelCss } from './data-model.js';
import { provenanceCss } from './provenance.js';
import { toastCss } from './toast.js';
import { buttonsCss } from './buttons.js';
import { teamsCss } from './teams.js';
import { settingsGearCss } from './settings-gear.js';
import { sidebarCss } from './sidebar.js';
import { fsWorkspaceCss } from './fs-workspace.js';
import { settingsDrawerCss } from './settings-drawer.js';
import { assistantRailCss } from './assistant-rail.js';
import { analyticsViewCss } from './analytics-view.js';
import { outputsCss } from './outputs.js';
import { modelTablesCss } from './model-tables.js';
import { computedBuilderCss } from './computed-builder.js';
import { chatCss } from './chat.js';
import { questionsCss } from './questions.js';
import { inlineImportCss } from './inline-import.js';
import { tabsCss } from './tabs.js';
import { sourcesCss } from './sources.js';
import { statusIndicatorCss } from './status-indicator.js';
import { fileDocCss } from './file-doc.js';
import { connectWallCss } from './connect-wall.js';

export const css = [
  tokensCss,
  topbarCss,
  searchCss,
  realtimeCss,
  layoutCss,
  filePreviewCss,
  dashboardCss,
  tableViewCss,
  detailViewCss,
  dataModelCss,
  provenanceCss,
  toastCss,
  buttonsCss,
  teamsCss,
  settingsGearCss,
  sidebarCss,
  fsWorkspaceCss,
  settingsDrawerCss,
  assistantRailCss,
  analyticsViewCss,
  outputsCss,
  modelTablesCss,
  computedBuilderCss,
  chatCss,
  questionsCss,
  inlineImportCss,
  tabsCss,
  sourcesCss,
  statusIndicatorCss,
  fileDocCss,
  connectWallCss,
].join('');
