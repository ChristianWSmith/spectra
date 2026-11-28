// The shipped Profile view as builtin components. Each panel is app Svelte compiled by the bundler, so it
// mounts through ComponentFrame's `component` prop (nested mounts from
// ChildFrame, and the Profile component's own frame from the surface). The
// ids live in the reserved builtin namespace (componentbuiltins.js
// BUILTIN_PREFIX). BUILTIN_COMPONENTS (componentbuiltins.js) lists every
// key of BUILTIN_PANELS, labelled from the string catalog, so the Component
// builder shows, edits and restores each one.
import ProfileView from './profile/ProfileView.svelte';
import CareerPanel from './profile/CareerPanel.svelte';
import TrendPanel from './profile/TrendPanel.svelte';
import SidesPanel from './profile/SidesPanel.svelte';
import MapsPanel from './profile/MapsPanel.svelte';
import WeaponsPanel from './profile/WeaponsPanel.svelte';
import HistoryPanel from './profile/HistoryPanel.svelte';
import ReportsView from './reports/ReportsView.svelte';
// The Match view's Heatmaps and Combat tabs: each tab
// is a composition, and its panels are mounted by the tab through Child.
import MatchHeatmaps from './match/Heatmaps.svelte';
import HeatmapPanel from './match/HeatmapsPanel.svelte';
import MatchCombat from './match/Combat.svelte';
import CombatKillTags from './match/CombatKillTags.svelte';
import CombatClutches from './match/CombatClutches.svelte';
import MatchTabs from './match/MatchTabs.svelte';
// The Economy and Utility tabs: a composer and the panels it mounts. The
// helpers they import are on the spectra/helpers surface.
import EconomyView from './econ/Economy.svelte';
import EconCurve from './econ/EconCurve.svelte';
import EconCards from './econ/EconCards.svelte';
import EconRounds from './econ/EconRounds.svelte';
import UtilityView from './util/Utility.svelte';
import UtilLog from './util/UtilLog.svelte';
// One component, two panels: the measure prop tells the bars which they are.
import UtilBars from './util/UtilBars.svelte';
// The Match view's panels: the overview, rosters, scoreboard, rounds, details and
// facts. Their shared helpers are in ./match/panelhelpers.js.
import MatchOverview from './match/MatchOverview.svelte';
import MatchRosters from './match/MatchRosters.svelte';
import MatchScoreboard from './match/MatchScoreboard.svelte';
import MatchRounds from './match/MatchRounds.svelte';
import MatchDetails from './match/MatchDetails.svelte';

export const PROFILE_VIEW_ID = 'profile';
const REPORTS_VIEW_ID = 'match-reports';

// The Match tabs' component ids (the Match view mounts the tab components
// directly, with its context).
export const MATCH_TABS_ID = 'match';
const MATCH_HEATMAPS_ID = 'match-heatmaps';
const MATCH_COMBAT_ID = 'match-combat';

// The Economy and Utility tabs' ids (the Match view mounts the composers).
const ECONOMY_ID = 'match-economy';
const ECON_CURVE_ID = 'match-economy-curve';
const ECON_CARDS_ID = 'match-economy-cards';
const ECON_ROUNDS_ID = 'match-economy-rounds';
const UTILITY_ID = 'match-utility';
const UTIL_LOG_ID = 'match-utility-log';
const UTIL_DAMAGE_ID = 'match-utility-damage';
const UTIL_BLIND_ID = 'match-utility-blind';

// The Match view's six panels.
const MATCH_OVERVIEW_ID = 'match-overview';
const MATCH_ROSTERS_ID = 'match-rosters';
const MATCH_SCOREBOARD_ID = 'match-scoreboard';
const MATCH_ROUNDS_ID = 'match-rounds';
const MATCH_DETAILS_ID = 'match-details';

export const BUILTIN_PANELS = Object.freeze({
  [PROFILE_VIEW_ID]: ProfileView,
  'profile-career': CareerPanel,
  'profile-trend': TrendPanel,
  'profile-sides': SidesPanel,
  'profile-maps': MapsPanel,
  'profile-weapons': WeaponsPanel,
  'profile-history': HistoryPanel,
  // The Match view's Reports tab (the composed report and its panels).
  [REPORTS_VIEW_ID]: ReportsView,
  [MATCH_TABS_ID]: MatchTabs,
  [MATCH_HEATMAPS_ID]: MatchHeatmaps,
  'match-heatmap': HeatmapPanel,
  [MATCH_COMBAT_ID]: MatchCombat,
  'match-combat-kill-tags': CombatKillTags,
  'match-combat-clutches': CombatClutches,
  [ECONOMY_ID]: EconomyView,
  [ECON_CURVE_ID]: EconCurve,
  [ECON_CARDS_ID]: EconCards,
  [ECON_ROUNDS_ID]: EconRounds,
  [UTILITY_ID]: UtilityView,
  [UTIL_LOG_ID]: UtilLog,
  [UTIL_DAMAGE_ID]: UtilBars,
  [UTIL_BLIND_ID]: UtilBars,
  [MATCH_OVERVIEW_ID]: MatchOverview,
  [MATCH_ROSTERS_ID]: MatchRosters,
  [MATCH_SCOREBOARD_ID]: MatchScoreboard,
  [MATCH_ROUNDS_ID]: MatchRounds,
  [MATCH_DETAILS_ID]: MatchDetails,
});

// builtinPanelById is the compiled component of a panel id, or null.
export function builtinPanelById(id) {
  return Object.hasOwn(BUILTIN_PANELS, id) ? BUILTIN_PANELS[id] : null;
}
