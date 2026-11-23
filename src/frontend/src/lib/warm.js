// Pre-warming: every warmable view stays mounted (hidden) so its reads have run
// before the user navigates there. App.svelte owns the reactive state (how many
// panes have mounted, the targets, the placement counter); this module holds the
// plain parts so node and the jsdom drivers can import it raw.
//
// Excluded on purpose: Replay (the heaviest view; it plays audio and would make
// the app chug). Library is warmed as well, scan included (owner ruling).
//
// The match and profile panes take their targets from the backend's own
// records: the newest ready match and the first human player. Before any exist
// the targets are the dummies (match 0, no steam id): the read answers with its
// empty shape, and the pane fills in when real data arrives.
//
// "Use as my view" changes a surface's placement. The builder calls
// notifyPlacementsChanged, and App remounts the match and profile panes: their
// SurfaceView re-reads the placement, so the new component is warm before the
// user gets there.
import { listMatchesPage, listPlayers } from './services.js';
import { listedPlayers } from './players.js';

export const WARM_STEP_MS = 150;

// The order panes are mounted in (after the current route's pane).
export const WARM_VIEWS = [
  'library',
  'profiles',
  'settings',
  'sql',
  'builder',
  'reportbuilder',
  'componentbuilder',
  'explorer',
  'reports',
  'round',
  'compare',
];

// loadWarmTargets reads the two targets from the backend's own lists. A failed
// read leaves its dummy in place: warming never blocks the app.
export async function loadWarmTargets() {
  let matchId = 0;
  let steamId = '';
  try {
    const page = await listMatchesPage('', 'extracted_at', true, 0, 10, { map: '', player: '' });
    const newest = (page?.rows || []).find((r) => r && r.status === 'ready');
    if (newest) matchId = newest.id;
  } catch {
    // dummy match
  }
  try {
    const first = listedPlayers((await listPlayers('')) || [])[0];
    if (first && first.steamId) steamId = first.steamId;
  } catch {
    // dummy profile
  }
  return { matchId, steamId };
}

// Placement listeners: App subscribes, the builder notifies after a change.
const placementListeners = new Set();
export function onPlacementsChanged(fn) {
  placementListeners.add(fn);
  return () => placementListeners.delete(fn);
}
export function notifyPlacementsChanged() {
  for (const fn of placementListeners) fn();
}
