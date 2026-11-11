// Player-profile navigation helpers, shared by every view that links a
// name/chip to #/player/:steamid. One Steam-id test, one navigation.
import { buildHash, parseHash } from './router.js';
import { serializeLandmarkFilter } from './replay/landmarks.js';
import { roundStartTick } from './rounds.js';
import { normTickRate } from './fmt.js';

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
//   loop   — initial loop range "<fromTick>,<toTick>" (ticks; the comma
//            stays raw in buildHash). ENTRY-ONLY: Replay applies it on
//            entry (nav.entryLoopRange → engine bounds + arm), re-arms
//            only a DISTINCT range while the keep-alive instance lives
//            (nav.entrySeedPlan), and drops it from the URL as soon as
//            the user edits a bound, so the URL keeps mirroring the
//            engine's loop state.
//   sel    — selected landmark key (e:123 / c:4 / g:9)
//   back   — origin path for the return trip ("match/5/rounds",
//            "compare/5?rounds=3,5", …) — rendered as-is by buildHash
// One navigation system: every event drill-down lands in Replay —
// normally as a SEEK (?tick=, usually + ?loop=, empty filter), and for
// the two accepted filter-arrival exceptions (Heatmaps' region drill,
// the command palette's saved-filter apply) with its scope intact.
export function replayHash(matchId, filter, extras) {
  return buildHash(`/replay/${matchId}`, {
    ...serializeLandmarkFilter(filter || {}),
    ...(extras || {}),
  });
}

// expandReplayHash — THE mini-player expand path (the keep-alive's one
// canonical way back into Replay; App.svelte calls it for BOTH expand
// triggers: the dock panel's click and Match's header "Watch replay"
// while the instance is alive). It takes the CAPTURED replay hash —
// whatever the user last had open (filter/scope, ?tick=/?loop=/?sel=
// entry params, all preserved) — and rewrites only its ?back= origin to
// the LATEST match path (keepalive.backOrigin), so Back inside the
// expanded replay returns to the tab the user was actually on instead
// of the entry-time origin. The fresh-entry builder stays replayHash
// above (it must never be used here: a same-id navigation keeps the
// instance, but a re-minted query would drop the live state). A hash
// that does not parse to a replay route is handed back unchanged —
// never minted into a wrong replay URL. A missing/empty backPath DROPS
// a stale ?back= rather than keeping an origin the user has left.
export function expandReplayHash(replayHashValue, backPath) {
  const route = parseHash(replayHashValue || '');
  if (route.name !== 'replay' || route.id == null) return replayHashValue;
  const q = { ...(route.query || {}) };
  if (backPath) q.back = backPath;
  else delete q.back;
  return buildHash(`/replay/${route.id}`, q);
}

// entryLoopSpan stamps the ?loop= extra for a RANGE link (the closing
// half of the replayHash contract above): "<fromTick>,<toTick>". Bounds
// that cannot be stated exactly — absent (null/"" — Number(null) would
// silently read 0), non-finite, negative or inverted (from > to) —
// yield undefined, which buildHash drops: a link never promises a loop
// it cannot state (the seek still happens on its own).
export function entryLoopSpan(fromTick, toTick) {
  const from = asTick(fromTick);
  const to = asTick(toTick);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || from > to) return undefined;
  return `${from},${to}`;
}

// asTick reads a link-site tick strictly: null/undefined/"" are ABSENT
// (never the 0 Number(null)/Number("") would coerce them to) and
// anything non-numeric is NaN — both resolve to "no promise".
function asTick(v) {
  return v == null || v === '' ? NaN : Number(v);
}

// EVENT_LOOP_SECONDS is the engine's own default loop width (toggleLoop
// arms "10 s from the current frame" — engine.js): every EVENT anchor
// link spans ± this around the event tick, so a linked loop feels the
// same as a manually armed one.
const EVENT_LOOP_SECONDS = 10;

// entryLoopAround stamps the ?loop= extra for an EVENT link: ±10 s
// around the event tick at the match tick rate, floored at 0 — a
// negative bound is never legal and is the ONLY clamp (the range may
// legitimately run past the round's edge; it is never reshaped to it).
export function entryLoopAround(tick, tickRate) {
  const t = asTick(tick);
  if (!Number.isFinite(t) || t < 0) return undefined;
  const half = Math.round(EVENT_LOOP_SECONDS * normTickRate(tickRate));
  return entryLoopSpan(Math.max(0, Math.round(t - half)), Math.round(t + half));
}

// entrySeekTick resolves the INITIAL TIME TARGET of a Replay entry URL —
// the counterpart to replayHash: the one place a link's time promise
// becomes a tick (startEngine applies it once per fresh load, and the
// keep-alive's seed watcher re-applies a DISTINCT resolution while the
// instance lives — entry-once PER DISTINCT SEED: identical-value
// in-session churn keeps the playback position, a no-promise rewrite
// never seeks). Watch links from OUTSIDE the replay (RoundDetail's
// "Watch round", Combat's round chips, Utility's ▶, Economy's stat-card
// drill) stamp that tick EXPLICITLY through ?tick= — they never carry a
// landmark filter; the round scope below is the in-replay/deep-link
// form of the same promise. Priority:
//   1. ?tick=  — an exact tick link (event/round-start "watch" buttons)
//               wins as-is;
//   2. else the round scope — ?roundFrom= when it names a round, else
//               ?roundTo= — resolves to that round's START tick (a
//               round-scoped link stamps BOTH bounds to the same
//               number, so a range opens at its first round): a round
//               link is a link to a point in time (the in-replay round
//               bounds and deep links — outside the replay, buttons
//               stamp ?tick= and never a landmark filter),
//               never the first frame;
//   3. else null — the URL makes NO time promise, so there is nothing to
//               resolve here: Replay applies the user's DEFAULT start
//               position (the knife/warmup hiding pref decides between
//               the first counted round's start and frame 0). Returning
//               null instead of 0 keeps "no promise" distinguishable
//               from an explicit first-frame target, which is the whole
//               point of the pref-aware default.
// `rounds` is the GetRounds array; an unknown round or an unusable tick
// falls through to the next source — never a guessed time. The round is
// read from the RAW params rather than parseLandmarkFilter: that parser
// folds "no bound" onto 0 (the unset sentinel), which cannot say
// whether the URL named a round — while the raw param can (absent/0 =
// no time promise, "-1" = the warmup round, which is a real round with
// a real start). Round 0 never exists, so a 0 bound is never a target.
// The loop range is a SEPARATE promise resolved by entryLoopRange below
// — neither resolver reads the other's params.
export function entrySeekTick(query, rounds) {
  const q = query || {};
  // ?tick= is explicit whenever it names a real non-negative tick —
  // 0 included (a round-1 start link stamps tick 0, and an explicit
  // first frame must not be reinterpreted as "no promise").
  if (q.tick != null && q.tick !== '') {
    const tick = Number(q.tick);
    if (Number.isFinite(tick) && tick >= 0) return tick;
  }
  // The round scope: the first bound that actually names a round wins
  // (roundFrom, else roundTo). Absent, empty, 0 (the unset sentinel) and
  // malformed values are not round names; a named-but-unknown round
  // resolves to nothing rather than to a guess.
  for (const raw of [q.roundFrom, q.roundTo]) {
    if (raw == null || raw === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n === 0) continue;
    const start = roundStartTick(rounds, n);
    return start != null ? start : null;
  }
  return null;
}

// entryLoopRange resolves the ENTRY-ONLY ?loop= range of a Replay URL —
// the counterpart of the loop extras entryLoopSpan / entryLoopAround
// stamp and the second, independent promise of an entry link (beside
// entrySeekTick above): "<fromTick>,<toTick>" (the comma stays raw in
// buildHash) → { from, to }, or null when the URL makes NO usable loop
// promise. Never guesses — each of these resolves to null:
//   - absent / empty / a value that is not exactly two comma-separated
//     numbers (including an empty half: "1," / ",1" / "1,2,3" / "x,9"),
//   - a non-finite or negative bound, or an inverted range (from > to),
//   - "an unknown round": when the round list is loaded and knows its
//     own tick span, a range lying ENTIRELY outside it names no known
//     round and is not a promise (roundSpan returns null when there is
//     no span to check against — then the explicit finite bounds stand
//     on their own).
// Independent of entrySeekTick's priority: ?tick= / ?roundFrom= /
// ?roundTo= decide WHERE the replay starts, never what it loops over.
// Replay applies the resolved range in startEngine (bounds, then arm)
// and the keep-alive's seed watcher re-arms only a DISTINCT range
// (entrySeedPlan below) — identical-value in-session query churn can
// neither re-apply nor cancel it.
export function entryLoopRange(query, rounds) {
  const raw = query == null ? null : query.loop;
  if (raw == null || raw === '') return null;
  const parts = String(raw).split(',');
  if (parts.length !== 2 || parts.some((p) => p.trim() === '')) return null;
  const nums = parts.map((p) => Number(p.trim()));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [from, to] = nums;
  if (from < 0 || from > to) return null;
  const span = roundSpan(rounds);
  if (span && (to < span.first || from > span.last)) return null;
  return { from, to };
}

// roundSpan is the loaded rounds' tick span [first start, last end] —
// the stretch of the demo the round rows actually cover. Rows without a
// usable end tick contribute their start (an open row still begins
// where it begins); when NO row has a usable start tick there is no
// span to check against and null disables the gate above.
function roundSpan(rounds) {
  let first = null;
  let last = null;
  for (const r of rounds || []) {
    if (!r || !Number.isFinite(r.startTick)) continue;
    if (first == null || r.startTick < first) first = r.startTick;
    const end = Number.isFinite(r.endTick) ? r.endTick : r.startTick;
    if (last == null || end > last) last = end;
  }
  return first == null ? null : { first, last };
}

// entrySeed — THE resolved entry seed of a Replay URL: the two
// independent promises above resolved TOGETHER against the loaded
// rounds → { seek: number|null, loop: {from,to}|null }. One bundle, ONE
// resolution source for both apply paths in Replay — startEngine's
// fresh-mount block and the keep-alive's seed watcher: neither may
// resolve on its own, or the two could disagree about what the URL
// promised. Each half keeps its own resolver's contract: seek is null
// when the URL makes no time promise (never a guess — a round scope
// whose rounds have not loaded yet resolves to null too), loop null
// when it states no usable range.
export function entrySeed(query, rounds) {
  return { seek: entrySeekTick(query, rounds), loop: entryLoopRange(query, rounds) };
}

// entrySeedPlan — THE distinct-seed rule of the replay keep-alive
// ("entry-once per load" became "entry-once per DISTINCT seed"): given
// the last-applied seed and a freshly resolved one, what does the
// engine still owe? Both flags are false — nothing is applied — unless
// at least one NON-NULL component resolves to a value the last-applied
// seed does not carry. Distinctness is by VALUE (the seek tick; the
// loop's from/to pair), never object identity, so a fresh query object
// carrying the same seed — a filter edit that keeps ?tick=/?loop=, an
// expandReplayHash round trip, a ?back= rewrite — applies NOTHING.
// A null component is "no promise": it never seeks, never arms and
// never disarms (absence clears nothing — the Loop toggle, Replay's
// range-edit rule and the engine's own cancelLoopIfOutside own every
// removal), so dropping ?loop= while ?tick= is unchanged (a bound edit)
// is NOT a new seed and can never yank the playhead back.
// When something IS distinct, the WHOLE current promise applies: both
// flags then mirror the non-null halves of `next`, in startEngine's
// entry order (seek first — a seek landing outside an armed range
// cancels it, engine.js cancelLoopIfOutside — then loop bounds + arm),
// so a link's full promise lands even when only one half changed and
// the arm re-asserts a range the seek just cancelled. The CALLER owns
// the bookkeeping: it records `next` as the last-applied seed on EVERY
// resolution (nulls included — a no-promise rewrite becomes the new
// baseline), so a repeat of the last value resolves equal and applies
// nothing.
export function entrySeedPlan(prev, next) {
  const p = prev || { seek: null, loop: null };
  const n = next || { seek: null, loop: null };
  const seekNew = n.seek != null && n.seek !== p.seek;
  const loopNew =
    n.loop != null && (p.loop == null || p.loop.from !== n.loop.from || p.loop.to !== n.loop.to);
  const distinct = seekNew || loopNew;
  return { applySeek: distinct && n.seek != null, applyLoop: distinct && n.loop != null };
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
