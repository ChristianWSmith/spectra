// Tests for lib/nav.js: the profile return trip (profileBackTarget — the
// resolution behind PlayerProfile's top-left back button), the navigation
// guards the profile links share (isSteam/openProfile), the sidebar
// action highlighters (NAV_ACTIONS active()) and the replay entry
// resolvers (entrySeekTick — the ?tick=/?roundFrom=/?roundTo= contract
// every link into THE event browser relies on — plus entryLoopRange and
// the ?loop= stampers entryLoopSpan / entryLoopAround beside it, and the
// keep-alive's entrySeed/entrySeedPlan: the one resolution bundle and
// the distinct-seed apply rule Replay's mount path and seed watcher
// share).
// Run: node --test src/lib/nav.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isSteam,
  openProfile,
  profileBackTarget,
  NAV_ACTIONS,
  entrySeekTick,
  entryLoopRange,
  entrySeed,
  entrySeedPlan,
  entryLoopSpan,
  entryLoopAround,
  expandReplayHash,
} from './nav.js';

test('an explicit ?back= origin wins (durable, deep-linkable)', () => {
  assert.equal(
    profileBackTarget({ back: 'match/5/scoreboard' }, '#/profiles'),
    '/match/5/scoreboard',
  );
  assert.equal(
    profileBackTarget({ back: 'compare/5?rounds=3,5' }, ''),
    '/compare/5?rounds=3,5',
  );
});

test('without ?back= the in-app origin (the hash before this one) wins', () => {
  assert.equal(profileBackTarget({}, '#/profiles'), '/profiles');
  assert.equal(profileBackTarget({}, '#/match/5/scoreboard'), '/match/5/scoreboard');
  assert.equal(profileBackTarget({}, '#/replay/5?cat=chat'), '/replay/5?cat=chat');
});

test('another profile is never an origin; no origin → the Profiles list', () => {
  // Profile → profile is a sibling jump, not a way back.
  assert.equal(
    profileBackTarget({}, '#/player/76561198012345678?back=match/5'),
    '/profiles',
  );
  assert.equal(profileBackTarget({}, '#/player/76561198012345678'), '/profiles');
  // Opened directly: deep link, refresh, first navigation of the session.
  assert.equal(profileBackTarget({}, ''), '/profiles');
  assert.equal(profileBackTarget({}, '#'), '/profiles');
  assert.equal(profileBackTarget(undefined, undefined), '/profiles');
});

test('isSteam: exactly 17 digits are linkable', () => {
  assert.equal(isSteam('76561198012345678'), true);
  assert.equal(isSteam('7656119801234567'), false); // 16
  assert.equal(isSteam('765611980123456789'), false); // 18
  assert.equal(isSteam('BOT'), false);
  assert.equal(isSteam(''), false);
  assert.equal(isSteam(undefined), false);
});

test('openProfile navigates only for a well-formed Steam id', () => {
  const seen = [];
  const nav = (hash) => seen.push(hash);
  openProfile(nav, '76561198012345678');
  openProfile(nav, 'bot');
  openProfile(nav, '');
  openProfile(nav, undefined);
  assert.deepEqual(seen, ['/player/76561198012345678']);
});

test('sidebar active(): the player profile highlights Profiles, not Library', () => {
  // The profile's back button returns to the Profiles directory
  // (profileBackTarget), so the profile route belongs to that action.
  const active = Object.fromEntries(NAV_ACTIONS.map((a) => [a.label, a.active]));
  const route = (name) => ({ name });
  assert.equal(active.Profiles(route('player')), true);
  assert.equal(active.Library(route('player')), false);
  // The directory itself stays Profiles-active.
  assert.equal(active.Profiles(route('profiles')), true);
  // Match detail routes still light up the Library hub.
  for (const name of ['library', 'match', 'round', 'replay', 'compare']) {
    assert.equal(active.Library(route(name)), true, `Library on ${name}`);
    assert.equal(active.Profiles(route(name)), false, `Profiles on ${name}`);
  }
});

test('sidebar active(): exactly one action lights up per route', () => {
  const routes = [
    'library',
    'match',
    'round',
    'replay',
    'compare',
    'player',
    'profiles',
    'builder',
    'sql',
    'settings',
  ];
  for (const name of routes) {
    const on = NAV_ACTIONS.filter((a) => a.active({ name })).map((a) => a.label);
    assert.equal(on.length, 1, `${name} → ${on.join(', ')}`);
  }
});

// --- entrySeekTick: the replay entry time target --------------------------
const ROUNDS = [
  { number: -2, startTick: 100 }, // knife
  { number: -1, startTick: 400 }, // warmup
  { number: 1, startTick: 1200 },
  { number: 7, startTick: 24500 },
];

test('entrySeekTick: an exact ?tick= link wins over everything', () => {
  // RoundDetail's "Watch round" / Combat's EventPlay / Utility's
  // "replay" buttons all stamp an exact tick.
  assert.equal(entrySeekTick({ tick: '9999' }, ROUNDS), 9999);
  assert.equal(entrySeekTick({ tick: '9999', roundFrom: '7', roundTo: '7' }, ROUNDS), 9999);
  assert.equal(entrySeekTick({ tick: 9999 }, ROUNDS), 9999);
  assert.equal(entrySeekTick({ tick: '0' }, ROUNDS), 0); // tick 0 = first frame
});

test('entrySeekTick: a round-scoped link resolves to that round\'s start tick', () => {
  // The Economy gap-round card, Combat's round chips and every "events"
  // button promise round N — the replay must land on N's start tick,
  // never the first frame (the reported "lands at the first tick" bug).
  // Every round-scoped link stamps BOTH inclusive bounds to the same
  // number; roundFrom is the primary target, roundTo covers a max-only
  // range, and a wider range opens at its FIRST round.
  assert.equal(entrySeekTick({ roundFrom: '7', roundTo: '7' }, ROUNDS), 24500);
  assert.equal(entrySeekTick({ roundFrom: 1 }, ROUNDS), 1200);
  assert.equal(entrySeekTick({ roundTo: 7 }, ROUNDS), 24500);
  assert.equal(entrySeekTick({ roundFrom: 1, roundTo: 7 }, ROUNDS), 1200);
  // Negative-numbered rounds are real rounds too (knife/warmup) — both
  // resolve to their own start tick.
  assert.equal(entrySeekTick({ roundFrom: '-2', roundTo: '-2' }, ROUNDS), 100);
  assert.equal(entrySeekTick({ roundFrom: '-1' }, ROUNDS), 400);
});

test('entrySeekTick: no explicit time target → null (Replay applies the pref-based default)', () => {
  // DELIBERATE CHANGE: the fallback used to be 0 ("start on the first
  // frame"), but Replay now starts at the knife/warmup-hiding pref's
  // default (first COUNTED round's start when the pref hides them, frame
  // 0 when it shows them). nav.js must therefore distinguish "the URL
  // promised nothing" (null → Replay picks the default) from an explicit
  // first-frame target (?tick=0 → 0, asserted above).
  assert.equal(entrySeekTick({}, ROUNDS), null);
  assert.equal(entrySeekTick(undefined, ROUNDS), null);
  assert.equal(entrySeekTick({ roundFrom: '12' }, ROUNDS), null); // unknown round — never a guess
  // Round 0 never exists: 0 is the UNSET bound, so it is never a target.
  assert.equal(entrySeekTick({ roundFrom: '0', roundTo: '0' }, ROUNDS), null);
  // Malformed is not a promise either — but an unusable bound simply
  // falls through to the other bound of the same range.
  assert.equal(entrySeekTick({ roundFrom: 'x' }, ROUNDS), null);
  assert.equal(entrySeekTick({ roundFrom: 'x', roundTo: '7' }, ROUNDS), 24500);
  assert.equal(entrySeekTick({ roundFrom: '1' }, []), null); // rounds not loaded
  assert.equal(entrySeekTick({ roundFrom: '1' }, null), null);
  // Absent bounds = no time promise at all: entrySeekTick reads the RAW
  // params (parseLandmarkFilter folds "absent" onto the same 0 the unset
  // sentinel uses), so an absent range and the warmup round's "-1" stay
  // distinguishable — the warmup round still resolves below.
  assert.equal(entrySeekTick({ roundFrom: '-1' }, ROUNDS), 400); // warmup round start
  assert.equal(entrySeekTick({ roundTo: '-1' }, ROUNDS), 400); // warmup via the max bound
  assert.equal(entrySeekTick({ cat: 'kills' }, ROUNDS), null); // no round param
  assert.equal(entrySeekTick({ tick: 'x' }, ROUNDS), null); // malformed tick, no round
});

// --- entryLoopRange: the replay entry loop range --------------------------
// ?loop=<fromTick>,<toTick> is the SECOND, independent entry promise of a
// Replay URL (the seek target is the first — see entrySeekTick above):
// Replay applies the resolved range ONCE on entry (bounds, then arm) and
// drops the param when the user edits a bound. A row set WITH end ticks,
// because the round-span gate below reads them.
const LOOP_ROUNDS = [
  { number: -1, startTick: 400, endTick: 900 }, // warmup
  { number: 1, startTick: 1200, endTick: 24000 },
  { number: 7, startTick: 24500, endTick: 30000 },
];

test('entryLoopRange: absent or empty → null (the URL promises no loop)', () => {
  assert.equal(entryLoopRange({}, LOOP_ROUNDS), null);
  assert.equal(entryLoopRange(undefined, LOOP_ROUNDS), null);
  assert.equal(entryLoopRange(null, LOOP_ROUNDS), null);
  assert.equal(entryLoopRange({ loop: '' }, LOOP_ROUNDS), null);
  assert.equal(entryLoopRange({ cat: 'kills' }, LOOP_ROUNDS), null); // other params only
});

test('entryLoopRange: malformed pairs → null (never a half-parsed range)', () => {
  assert.equal(entryLoopRange({ loop: 'x' }, LOOP_ROUNDS), null); // not a pair
  assert.equal(entryLoopRange({ loop: '1200' }, LOOP_ROUNDS), null); // one half
  assert.equal(entryLoopRange({ loop: '1,2,3' }, LOOP_ROUNDS), null); // three halves
  assert.equal(entryLoopRange({ loop: 'a,b' }, LOOP_ROUNDS), null); // non-numeric
  assert.equal(entryLoopRange({ loop: '1200,x' }, LOOP_ROUNDS), null);
  assert.equal(entryLoopRange({ loop: '1200,' }, LOOP_ROUNDS), null); // empty half
  assert.equal(entryLoopRange({ loop: ',2400' }, LOOP_ROUNDS), null);
  // Whitespace AROUND a half trims away (Number() does it) — only an
  // empty or non-numeric half is malformed.
  assert.deepEqual(entryLoopRange({ loop: '1200, 2400' }, LOOP_ROUNDS), { from: 1200, to: 2400 });
});

test('entryLoopRange: a negative or inverted range → null (never a guessed order)', () => {
  assert.equal(entryLoopRange({ loop: '-1,100' }, LOOP_ROUNDS), null); // negative bound
  assert.equal(entryLoopRange({ loop: '2400,1200' }, LOOP_ROUNDS), null); // from > to
  // Equal bounds are a legal (zero-width) range, not an inversion.
  assert.deepEqual(entryLoopRange({ loop: '1200,1200' }, LOOP_ROUNDS), { from: 1200, to: 1200 });
});

test('entryLoopRange: a well-formed pair resolves to raw ticks', () => {
  assert.deepEqual(entryLoopRange({ loop: '1200,2400' }, LOOP_ROUNDS), { from: 1200, to: 2400 });
  assert.deepEqual(entryLoopRange({ loop: '0,576' }, LOOP_ROUNDS), { from: 0, to: 576 });
  assert.deepEqual(entryLoopRange({ loop: '1200,2400' }, []), { from: 1200, to: 2400 });
  assert.deepEqual(entryLoopRange({ loop: '1200,2400' }, null), { from: 1200, to: 2400 });
});

test('entryLoopRange: a range naming no known round → null (loaded rounds gate it)', () => {
  // Loaded rounds know their own tick span [400, 30000]: a range lying
  // ENTIRELY outside it names no known round and is not a promise.
  assert.equal(entryLoopRange({ loop: '100,200' }, LOOP_ROUNDS), null); // before every round
  assert.equal(entryLoopRange({ loop: '40000,50000' }, LOOP_ROUNDS), null); // past the last
  // A range that merely REACHES the span (or overhangs one end) keeps —
  // event anchors legitimately cross a round's edge.
  assert.deepEqual(entryLoopRange({ loop: '200,500' }, LOOP_ROUNDS), { from: 200, to: 500 });
  assert.deepEqual(entryLoopRange({ loop: '24500,40000' }, LOOP_ROUNDS), { from: 24500, to: 40000 });
  // Rows without a usable start tick contribute no span → no gate.
  assert.deepEqual(entryLoopRange({ loop: '100,200' }, [{ number: 1 }]), { from: 100, to: 200 });
});

test('entryLoopRange: independent of the entry seek priority', () => {
  // ?tick= / ?roundFrom= decide WHERE the replay starts; the loop range
  // is a separate promise that neither reads nor is read by them — a URL
  // may carry either or both, and each resolves on its own.
  assert.deepEqual(entryLoopRange({ tick: '9999', loop: '1200,2400' }, LOOP_ROUNDS), {
    from: 1200,
    to: 2400,
  });
  assert.equal(entrySeekTick({ tick: '9999', loop: '1200,2400' }, LOOP_ROUNDS), 9999, 'seek unaffected by loop');
  assert.deepEqual(entryLoopRange({ roundFrom: '7', roundTo: '7', loop: '1200,2400' }, LOOP_ROUNDS), {
    from: 1200,
    to: 2400,
  });
  // A malformed loop does not borrow the round scope, and a round scope
  // does not rescue it.
  assert.equal(entryLoopRange({ roundFrom: '7', roundTo: '7', loop: 'x' }, LOOP_ROUNDS), null);
  assert.equal(entrySeekTick({ roundFrom: '7', loop: 'x' }, LOOP_ROUNDS), 24500, 'seek unaffected by a bad loop');
});

// --- entrySeed / entrySeedPlan: entry-once PER DISTINCT SEED ---------------
// The keep-alive's seed contract in pure form: startEngine (the fresh
// mount) and Replay's seed watcher share ONE resolution (entrySeed) and
// ONE apply rule (entrySeedPlan) — a new distinct seed applies once,
// identical-value churn never re-applies, absence never touches.
test('entrySeed bundles both promises through the one resolvers', () => {
  assert.deepEqual(entrySeed({ tick: '9999', loop: '1200,2400' }, LOOP_ROUNDS), {
    seek: 9999,
    loop: { from: 1200, to: 2400 },
  });
  assert.deepEqual(entrySeed({ roundFrom: '7', roundTo: '7' }, LOOP_ROUNDS), {
    seek: 24500,
    loop: null,
  });
  assert.deepEqual(entrySeed({ loop: '1200,2400' }, LOOP_ROUNDS), {
    seek: null,
    loop: { from: 1200, to: 2400 },
  });
  assert.deepEqual(entrySeed({}, LOOP_ROUNDS), { seek: null, loop: null });
  // Rounds still loading: the round scope resolves to NOTHING — never a
  // guess (the watcher then applies nothing; startEngine's mount-time
  // resolution runs after the rounds are in, so the mount still lands).
  assert.deepEqual(entrySeed({ roundFrom: '1' }, []), { seek: null, loop: null });
});

test('entrySeedPlan: identical-value churn applies nothing', () => {
  // A filter edit that keeps ?tick=/?loop=, an expandReplayHash round
  // trip, a ?back= rewrite: a fresh OBJECT with the same resolved
  // VALUES is still the same seed — distinctness is by value, never
  // identity (that is the whole "the playhead survives the round trip"
  // feature).
  const prev = entrySeed({ tick: '1200', loop: '1200,2400' }, LOOP_ROUNDS);
  const same = entrySeed({ tick: 1200, loop: '1200, 2400', back: 'match/5' }, LOOP_ROUNDS);
  assert.deepEqual(entrySeedPlan(prev, same), { applySeek: false, applyLoop: false });
  assert.deepEqual(entrySeedPlan(prev, prev), { applySeek: false, applyLoop: false });
  // Two no-promise rewrites in a row: nothing ever applies.
  assert.deepEqual(
    entrySeedPlan(entrySeed({}, LOOP_ROUNDS), entrySeed({ cat: 'kills' }, LOOP_ROUNDS)),
    { applySeek: false, applyLoop: false },
  );
});

test('entrySeedPlan: a distinct seed applies the WHOLE current promise', () => {
  const prev = entrySeed({ tick: '1200', loop: '1200,2400' }, LOOP_ROUNDS);
  // Only the loop changed → the link's unchanged ?tick= lands too: the
  // full promise, exactly what a fresh mount would do (the seek runs
  // BEFORE the arm — startEngine's order — so the arm survives the
  // seek's cancelLoopIfOutside).
  assert.deepEqual(
    entrySeedPlan(prev, entrySeed({ tick: '1200', loop: '1300,2400' }, LOOP_ROUNDS)),
    { applySeek: true, applyLoop: true },
  );
  // Only the seek changed → the promised range is re-asserted behind it.
  assert.deepEqual(
    entrySeedPlan(prev, entrySeed({ tick: '2400', loop: '1200,2400' }, LOOP_ROUNDS)),
    { applySeek: true, applyLoop: true },
  );
  // A tick-only link (no loop promise): seek only, never an arm.
  assert.deepEqual(entrySeedPlan(prev, entrySeed({ tick: '2400' }, LOOP_ROUNDS)), {
    applySeek: true,
    applyLoop: false,
  });
  // A loop-only link: arm only, never a seek.
  assert.deepEqual(entrySeedPlan(prev, entrySeed({ loop: '1300,2400' }, LOOP_ROUNDS)), {
    applySeek: false,
    applyLoop: true,
  });
  // The pristine record (before any application) applies a real promise.
  assert.deepEqual(entrySeedPlan(null, entrySeed({ tick: '1200' }, LOOP_ROUNDS)), {
    applySeek: true,
    applyLoop: false,
  });
  assert.deepEqual(
    entrySeedPlan({ seek: null, loop: null }, entrySeed({ loop: '1200,2400' }, LOOP_ROUNDS)),
    { applySeek: false, applyLoop: true },
  );
});

test('entrySeedPlan: a null component is never applied (absence promises nothing)', () => {
  const prev = entrySeed({ tick: '1200', loop: '1200,2400' }, LOOP_ROUNDS);
  // The CommandPalette's plain same-id jump (no ?tick=, no round scope):
  // never seeks, never disarms.
  assert.deepEqual(entrySeedPlan(prev, entrySeed({}, LOOP_ROUNDS)), {
    applySeek: false,
    applyLoop: false,
  });
  // The range-edit rule: dropping ?loop= while ?tick= is UNCHANGED is
  // not a new seed — re-applying would yank the playhead back on every
  // bound edit (the exact regression entry-once per distinct seed
  // exists to prevent).
  assert.deepEqual(entrySeedPlan(prev, entrySeed({ tick: '1200' }, LOOP_ROUNDS)), {
    applySeek: false,
    applyLoop: false,
  });
  // A changed seek with no loop promise arms nothing (absence never
  // disarms either — removal is the toggle's/range-edit's/cancel's job).
  assert.deepEqual(entrySeedPlan(prev, entrySeed({ tick: '2400' }, LOOP_ROUNDS)), {
    applySeek: true,
    applyLoop: false,
  });
});

// --- the ?loop= stampers (what the link sites put in the URL) ------------
test('entryLoopSpan stamps a round/clutch span, or nothing when unstatable', () => {
  assert.equal(entryLoopSpan(0, 576), '0,576');
  assert.equal(entryLoopSpan(1200, 2400), '1200,2400');
  // Never a guessed or illegal range: inverted, negative or non-finite
  // bounds yield undefined, which buildHash drops (the seek still fires).
  assert.equal(entryLoopSpan(2400, 1200), undefined);
  assert.equal(entryLoopSpan(-5, 100), undefined);
  assert.equal(entryLoopSpan(NaN, 100), undefined);
  assert.equal(entryLoopSpan(100, undefined), undefined);
  assert.equal(entryLoopSpan(null, null), undefined); // Number(null) is 0 — never a bound
  assert.equal(entryLoopSpan('', ''), undefined); // Number('') is 0 too
});

test('entryLoopAround anchors an event at ±10 s (the engine default width)', () => {
  // 10 s × 64 tick = 640 ticks either side — the width toggleLoop arms.
  assert.equal(entryLoopAround(10640, 64), '10000,11280');
  // The lower bound floors at 0 (never negative); the upper keeps full
  // width — the range is never reshaped to the round.
  assert.equal(entryLoopAround(100, 64), '0,740');
  // An absent/invalid tick rate is the engine's own 64 fallback
  // (fmt.normTickRate), not a zero-width anchor.
  assert.equal(entryLoopAround(10640, 0), '10000,11280');
  assert.equal(entryLoopAround(10640, undefined), '10000,11280');
  // No tick, no promise (null would coerce to 0 — never a bound).
  assert.equal(entryLoopAround(undefined, 64), undefined);
  assert.equal(entryLoopAround(null, 64), undefined);
  assert.equal(entryLoopAround(NaN, 64), undefined);
  assert.equal(entryLoopAround(-1, 64), undefined);
});

// --- expandReplayHash: THE mini-player expand path ------------------------
// The dock's captured replay hash goes in, the SAME hash with only ?back=
// rewritten to the latest match path comes out — every entry param (filter
// scope, tick, loop, sel) is preserved byte-for-byte, because expanding
// must never reset state or re-seek (the instance was never unmounted).
test('expandReplayHash rewrites only ?back= to the latest match path', () => {
  assert.equal(
    expandReplayHash(
      '#/replay/5?cat=kill&roundFrom=3&roundTo=7&tick=1234&loop=100,200&sel=e%3A9&back=match/5/rounds',
      'match/5/economy',
    ),
    '/replay/5?cat=kill&roundFrom=3&roundTo=7&tick=1234&loop=100,200&sel=e%3A9&back=match/5/economy',
  );
  // A captured hash with NO ?back= gets one appended (the last leg of a
  // first-time round trip), and a multi-value cat list stays raw (buildHash
  // keeps "/" and "," unescaped — the same grammar replayHash emits).
  assert.equal(
    expandReplayHash('#/replay/5?cat=chat,connects', 'match/5'),
    '/replay/5?cat=chat,connects&back=match/5',
  );
  // An empty origin DROPS a stale ?back= (never keep an origin the user
  // has already left).
  assert.equal(
    expandReplayHash('#/replay/5?cat=kill&back=match/5/rounds', ''),
    '/replay/5?cat=kill',
  );
});

test('expandReplayHash canonicalizes a legacy match-chat hash to its replay form', () => {
  // The keep-alive captures the RAW location hash — a legacy
  // #/match/:id/chat entry parses as a replay route, so expanding it must
  // mint the canonical #/replay/:id form (with its default scope) and
  // stamp the fresh back origin, never echo the match path back.
  assert.equal(
    expandReplayHash('#/match/5/chat', 'match/5/economy'),
    '/replay/5?cat=chat&back=match/5/economy',
  );
});

test('expandReplayHash passes a non-replay hash through unchanged (never mints one)', () => {
  // Defensive: the App-side caller only hands it captured replay hashes;
  // anything else comes back untouched instead of becoming /replay/undefined.
  assert.equal(expandReplayHash('#/match/5', 'match/5'), '#/match/5');
  assert.equal(expandReplayHash('/match/5/economy', 'match/5'), '/match/5/economy');
  assert.equal(expandReplayHash('', 'match/5'), '');
  assert.equal(expandReplayHash(undefined, 'match/5'), undefined);
});
