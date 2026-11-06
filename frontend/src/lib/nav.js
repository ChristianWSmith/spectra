// Player-profile navigation helpers, shared by every view that links a
// name/chip to #/player/:steamid. One Steam-id test, one navigation.
import { buildHash, parseHash } from './router.js';
import { serializeLandmarkFilter } from './replay/landmarks.js';
import { roundStartTick } from './rounds.js';

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
//   tick   — initial replay position
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

// entrySeekTick resolves the INITIAL TIME TARGET of a Replay entry URL —
// the counterpart to replayHash: the one place a link's time promise
// becomes a tick (Replay applies it once the position data is loaded,
// then never again — in-session filter changes keep the playback
// position). Priority:
//   1. ?tick=  — an exact tick link (event/round-start "watch" buttons)
//               wins as-is;
//   2. else the ?round= feed scope resolves to that round's START tick
//               — a round link is a link to a point in time (Economy's
//               gap-round card, Combat's round chips, the "events"
//               buttons), never the first frame;
//   3. else null — the URL makes NO time promise, so there is nothing to
//               resolve here: Replay applies the user's DEFAULT start
//               position (the knife/warmup hiding pref decides between
//               the first counted round's start and frame 0). Returning
//               null instead of 0 keeps "no promise" distinguishable
//               from an explicit first-frame target, which is the whole
//               point of the pref-aware default.
// `rounds` is the GetRounds array; an unknown round or an unusable tick
// falls through to the next source — never a guessed time. The round is
// read from the RAW param rather than parseLandmarkFilter: that parser
// must collapse "no round filter" onto the -1 sentinel, which is also
// the warmup round's NUMBER, so a parsed -1 cannot say whether the URL
// named a round — while the raw param can (absent = no time promise,
// "-1" = the warmup round, which is a real round with a real start).
export function entrySeekTick(query, rounds) {
  const q = query || {};
  // ?tick= is explicit whenever it names a real non-negative tick —
  // 0 included (a round-1 start link stamps tick 0, and an explicit
  // first frame must not be reinterpreted as "no promise").
  if (q.tick != null && q.tick !== '') {
    const tick = Number(q.tick);
    if (Number.isFinite(tick) && tick >= 0) return tick;
  }
  if (q.round != null && q.round !== '' && Number.isFinite(Number(q.round))) {
    const start = roundStartTick(rounds, Number(q.round));
    if (start != null) return start;
  }
  return null;
}

// profileBackTarget resolves the player profile's top-left back button —
// the same return trip every other detail view takes (RoundDetail,
// CompareRounds and Replay all read ?back= and fall back to their own
// default). Priority:
//   1. the route's ?back= origin — durable and deep-linkable (the view
//      that linked in can stamp its own path),
//   2. else the hash the app navigated from (App records it on
//      hashchange), unless that origin is another profile: profile →
//      profile is a sibling jump, not a way back,
//   3. else the Profiles directory — a profile opened directly (deep
//      link, refresh, first launch) returns to the list it lives in.
export function profileBackTarget(query, originHash) {
  const explicit = query && query.back;
  if (explicit) return '/' + explicit;
  if (originHash) {
    const origin = String(originHash).replace(/^#/, '');
    // A player origin is rejected; every other hash is handed back to the
    // router as-is (legacy shapes such as /match/:id/chat redirect there).
    if (origin && parseHash(originHash).name !== 'player') return origin;
  }
  return '/profiles';
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
    // The Library is the hub: every in-app match detail view (match,
    // round, replay, compare) is reached from it.
    active: (r) =>
      r.name === 'library' ||
      r.name === 'match' ||
      r.name === 'round' ||
      r.name === 'replay' ||
      r.name === 'compare',
  },
  {
    label: 'Profiles',
    icon: 'codicon-person',
    hash: '/profiles',
    // The player directory — its own route; a row click drills into the
    // player profile (#/player/:steamid), which is Profiles-active: the
    // profile's back button returns to this list (profileBackTarget).
    active: (r) => r.name === 'profiles' || r.name === 'player',
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
