// Player-profile navigation helpers, shared by every view that links a
// name/chip to #/player/:steamid. One Steam-id test, one navigation —
// the views used to each carry a byte-identical copy.
import { buildHash } from './router.js';
import { serializeLandmarkFilter } from './replay/landmarks.js';

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

// replayHash builds the canonical #/replay/:id URL for a contextual
// entry point into THE event browser: a partial landmark filter (the
// defaults fill every gap — serializeLandmarkFilter only emits non-
// default keys) plus the entry context extras:
//   tick   — initial replay position (the old replay-seek hand-off)
//   sel    — selected landmark key (e:123 / c:4 / g:9)
//   back   — origin path for the return trip ("match/5/rounds",
//            "compare/5?rounds=3,5", …) — rendered as-is by buildHash
// One navigation system: every event drill-down lands in Replay's
// landmark feed with its scope intact.
export function replayHash(matchId, filter, extras) {
  return buildHash(`/replay/${matchId}`, {
    ...serializeLandmarkFilter(filter || {}),
    ...(extras || {}),
  });
}

// NAV_ACTIONS is the one sidebar action list: App.svelte renders it as
// the sidebar buttons (active(route) drives the highlight) and
// CommandPalette renders it as its Actions section (run closes over the
// palette's nav). Membership and order are shared — a nav entry added
// here appears in both surfaces.
//
// `icon` is a codicon class for the icon-only sidebar rail: the button
// shows only the glyph and carries `label` in its title/aria-label (hover
// tooltip); the palette still renders the label as text. `bottom: true`
// partitions the list for the sidebar LAYOUT only — App.svelte pins those
// entries at the rail's foot (Settings as a gear) while the palette
// renders every action inline in array order. Explorer and Reports are
// gone from the nav list (they are match-view tabs now); their standalone
// #/explorer and #/reports routes still parse and render.
export const NAV_ACTIONS = [
  {
    label: 'Library',
    icon: 'codicon-library',
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
  {
    label: 'Profiles',
    icon: 'codicon-person',
    hash: '/profiles',
    // The player directory — its own route; a row click drills into the
    // player profile (#/player/:steamid), which stays Library-active.
    active: (r) => r.name === 'profiles',
  },
  { label: 'Builder', icon: 'codicon-wand', hash: '/builder', active: (r) => r.name === 'builder' },
  { label: 'SQL console', icon: 'codicon-terminal', hash: '/sql', active: (r) => r.name === 'sql' },
  {
    label: 'Settings',
    icon: 'codicon-settings-gear',
    hash: '/settings',
    active: (r) => r.name === 'settings',
    bottom: true, // sidebar: pinned gear at the rail's foot (see above)
  },
];
