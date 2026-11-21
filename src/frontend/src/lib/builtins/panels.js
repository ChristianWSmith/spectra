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

export const PROFILE_VIEW_ID = 'builtin-profile-view';

export const BUILTIN_PANELS = Object.freeze({
  [PROFILE_VIEW_ID]: ProfileView,
  'builtin-profile-career': CareerPanel,
  'builtin-profile-trend': TrendPanel,
  'builtin-profile-sides': SidesPanel,
  'builtin-profile-maps': MapsPanel,
  'builtin-profile-weapons': WeaponsPanel,
  'builtin-profile-history': HistoryPanel,
});

// builtinPanelById is the compiled component of a panel id, or null.
export function builtinPanelById(id) {
  return Object.hasOwn(BUILTIN_PANELS, id) ? BUILTIN_PANELS[id] : null;
}
