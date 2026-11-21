// The shipped Profile view as builtin components (dogfood/04-COMPONENTS.md
// §1, §7; PLAN C5d). Each panel is app Svelte compiled by the bundler, so it
// mounts through ComponentFrame's `component` prop (nested mounts from
// ChildFrame, and the Profile component's own frame from the surface). The
// ids live in the reserved builtin namespace (componentbuiltins.js
// BUILTIN_PREFIX). Panels are not in BUILTIN_COMPONENTS: that list is the
// Component builder's duplicable set, and these have no source text yet.
import ProfileView from './profile/ProfileView.svelte';
import CareerPanel from './profile/CareerPanel.svelte';
import TrendPanel from './profile/TrendPanel.svelte';
import SidesPanel from './profile/SidesPanel.svelte';
import MapsPanel from './profile/MapsPanel.svelte';
import WeaponsPanel from './profile/WeaponsPanel.svelte';
import HistoryPanel from './profile/HistoryPanel.svelte';
import ReportsView from './reports/ReportsView.svelte';
import ReportsTemplates from './reports/ReportsTemplates.svelte';
import ReportsAppendix from './reports/ReportsAppendix.svelte';
import ExplorerView from './explorer/ExplorerView.svelte';
import ExplorerProvenance from './explorer/ExplorerProvenance.svelte';
import ExplorerDiagnostics from './explorer/ExplorerDiagnostics.svelte';
import ExplorerReference from './explorer/ExplorerReference.svelte';
// The Match view's Heatmaps and Combat tabs (PLAN C5-Heat-Combat): each tab
// is a composition, and its panels are mounted by the tab through Child.
import MatchHeatmaps from './match/Heatmaps.svelte';
import HeatmapPanel from './match/HeatmapsPanel.svelte';
import MatchCombat from './match/Combat.svelte';
import CombatEngagements from './match/CombatEngagements.svelte';
import CombatClutches from './match/CombatClutches.svelte';
import MatchTabs from './match/MatchTabs.svelte';

export const PROFILE_VIEW_ID = 'builtin-profile-view';
export const REPORTS_VIEW_ID = 'builtin-reports';
export const EXPLORER_VIEW_ID = 'builtin-explorer';

// The Match tabs' component ids (the Match view mounts the tab components
// directly, with its context).
export const MATCH_TABS_ID = 'builtin-match-tabs';
export const MATCH_HEATMAPS_ID = 'builtin-match-heatmaps';
export const MATCH_COMBAT_ID = 'builtin-match-combat';

export const BUILTIN_PANELS = Object.freeze({
  [PROFILE_VIEW_ID]: ProfileView,
  'builtin-profile-career': CareerPanel,
  'builtin-profile-trend': TrendPanel,
  'builtin-profile-sides': SidesPanel,
  'builtin-profile-maps': MapsPanel,
  'builtin-profile-weapons': WeaponsPanel,
  'builtin-profile-history': HistoryPanel,
  // The Match view's Reports tab (the composed report and its panels).
  [REPORTS_VIEW_ID]: ReportsView,
  'builtin-reports-templates': ReportsTemplates,
  'builtin-reports-appendix': ReportsAppendix,
  // The Match view's Details tab and the standalone Explorer route.
  [EXPLORER_VIEW_ID]: ExplorerView,
  'builtin-explorer-provenance': ExplorerProvenance,
  'builtin-explorer-diagnostics': ExplorerDiagnostics,
  'builtin-explorer-reference': ExplorerReference,
  [MATCH_TABS_ID]: MatchTabs,
  [MATCH_HEATMAPS_ID]: MatchHeatmaps,
  'builtin-match-heatmap': HeatmapPanel,
  [MATCH_COMBAT_ID]: MatchCombat,
  'builtin-match-combat-engagements': CombatEngagements,
  'builtin-match-combat-clutches': CombatClutches,
});

// builtinPanelById is the compiled component of a panel id, or null.
export function builtinPanelById(id) {
  return Object.hasOwn(BUILTIN_PANELS, id) ? BUILTIN_PANELS[id] : null;
}
