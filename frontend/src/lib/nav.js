// Player-profile navigation helpers, shared by every view that links a
// name/chip to #/player/:steamid. One Steam-id test, one navigation —
// the views used to each carry a byte-identical copy.

// isSteam reports whether a name/id field holds a 17-digit Steam id
// (bots, empty and malformed names are not linkable).
export function isSteam(s) {
  return /^\d{17}$/.test(s || '');
}

// openProfile navigates to the player profile, but only for a well-formed
// Steam id — call sites with their own event handling (stopPropagation
// rows) keep a thin local wrapper around this.
export function openProfile(nav, steam) {
  if (isSteam(steam)) nav(`/player/${steam}`);
}

// NAV_ACTIONS is the one sidebar action list: App.svelte renders it as
// the sidebar buttons (active(route) drives the highlight) and
// CommandPalette renders it as its Actions section (run closes over the
// palette's nav). Membership and order are shared — a nav entry added
// here appears in both surfaces.
export const NAV_ACTIONS = [
  {
    label: 'Library',
    hash: '/library',
    // The Library is the hub: every in-app detail view (match, round,
    // replay, profile, compare) is reached from it.
    active: (r) =>
      r.name === 'library' ||
      r.name === 'match' ||
      r.name === 'round' ||
      r.name === 'replay' ||
      r.name === 'player' ||
      r.name === 'compare',
  },
  { label: 'Settings', hash: '/settings', active: (r) => r.name === 'settings' },
  { label: 'Builder', hash: '/builder', active: (r) => r.name === 'builder' },
  { label: 'SQL console', hash: '/sql', active: (r) => r.name === 'sql' },
  { label: 'Explorer', hash: '/explorer', active: (r) => r.name === 'explorer' },
  { label: 'Reports', hash: '/reports', active: (r) => r.name === 'reports' },
];
