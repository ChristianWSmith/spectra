// Tests for lib/nav.js: the profile return trip (profileBackTarget — the
// resolution behind PlayerProfile's top-left back button), the navigation
// guards the profile links share (isSteam/openProfile), the sidebar
// action highlighters (NAV_ACTIONS active()) and the replay entry
// resolvers (entrySeekTick — the ?tick= position contract: the ONLY
// "where to jump" instruction, with the round scope as feed-filter
// state that never seeks — plus entryLoopRange and
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
// PARAMETER SEPARATION (the product-owner contract): ?tick= is the ONLY
// "where to jump" instruction — ?roundFrom=/?roundTo= are feed-filter
// state ("what to show") and never a position, at mount or mid-session.
// The watch/drill links stamp roundStartTick as ?tick= BESIDE their
// scope; a scope-only URL resolves null (Replay lands on the pref-aware
// default, the filter still applies).

test('entrySeekTick: an exact ?tick= link is the only position source', () => {
  // RoundDetail's "Watch round" / Combat's EventPlay and round chips /
  // Utility's "replay" / Economy's stat-card drill all stamp an exact
  // tick — the outside-replay buttons seek (never filter), so ?tick= is
  // the dominant real-world entry promise.
  assert.equal(entrySeekTick({ tick: '9999' }), 9999);
  // A scope BESIDE the tick is irrelevant to position (it still filters
  // the feed — replayHash serializes it; this half never reads it).
  assert.equal(entrySeekTick({ tick: '9999', roundFrom: '7', roundTo: '7' }), 9999);
  assert.equal(entrySeekTick({ tick: 9999 }), 9999);
  assert.equal(entrySeekTick({ tick: '0' }), 0); // tick 0 = first frame
  // Malformed / negative ?tick= is not a promise — null, never a guess.
  assert.equal(entrySeekTick({ tick: 'x' }), null);
  assert.equal(entrySeekTick({ tick: '-5' }), null);
  // No position param at all: null → Replay applies the pref-based
  // default (first counted round's start while the pref hides
  // knife/warmup, frame 0 when it shows them) — the DELIBERATE CHANGE
  // that keeps "no promise" distinguishable from the explicit
  // first-frame target (?tick=0 → 0, asserted above).
  assert.equal(entrySeekTick({}), null);
  assert.equal(entrySeekTick(undefined), null);
  assert.equal(entrySeekTick({ cat: 'kills' }), null);
});

test('entrySeekTick: the round scope NEVER seeks (feed filter, never a position)', () => {
  // The scope shapes that USED to resolve to a round's start tick now
  // resolve null — every one of them — because the resolver does not
  // even take a rounds list anymore: loaded, empty or absent rounds
  // cannot turn a filter into a jump.
  assert.equal(entrySeekTick({ roundFrom: '7', roundTo: '7' }), null);
  assert.equal(entrySeekTick({ roundFrom: 1 }), null);
  assert.equal(entrySeekTick({ roundTo: 7 }), null);
  assert.equal(entrySeekTick({ roundFrom: 1, roundTo: 7 }), null); // a range opens at its first round — still no seek
  // Knife/warmup scope is filter state too (never a start tick).
  assert.equal(entrySeekTick({ roundFrom: '-2', roundTo: '-2' }), null);
  assert.equal(entrySeekTick({ roundFrom: '-1' }), null);
  // Unknown rounds, the unset sentinel, malformed bounds: null for the
  // right reason now — the scope is never consulted.
  assert.equal(entrySeekTick({ roundFrom: '12' }), null);
  assert.equal(entrySeekTick({ roundFrom: '0', roundTo: '0' }), null);
  assert.equal(entrySeekTick({ roundFrom: 'x' }), null);
  assert.equal(entrySeekTick({ roundFrom: 'x', roundTo: '7' }), null);
  // The stamped tick beside a scope still lands (the watch-link rule:
  // Economy's cards, RoundDetail/Combat/Utility's scoped entries all
  // stamp roundStartTick this way).
  assert.equal(entrySeekTick({ roundFrom: '7', roundTo: '7', tick: '24500' }), 24500);
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
  // ?tick= decides WHERE the replay starts (the round scope decides
  // nothing — feed filter only); the loop range is a separate promise
  // that neither reads nor is read by them — a URL may carry either or
  // both, and each resolves on its own.
  assert.deepEqual(entryLoopRange({ tick: '9999', loop: '1200,2400' }, LOOP_ROUNDS), {
    from: 1200,
    to: 2400,
  });
  assert.equal(entrySeekTick({ tick: '9999', loop: '1200,2400' }), 9999, 'seek unaffected by loop');
  assert.deepEqual(entryLoopRange({ roundFrom: '7', roundTo: '7', loop: '1200,2400' }, LOOP_ROUNDS), {
    from: 1200,
    to: 2400,
  });
  // A malformed loop does not borrow the round scope, and a round scope
  // does not rescue it (nor ever seek on its own).
  assert.equal(entryLoopRange({ roundFrom: '7', roundTo: '7', loop: 'x' }, LOOP_ROUNDS), null);
  assert.equal(entrySeekTick({ roundFrom: '7', loop: 'x' }), null, 'the scope never seeks, loop or not');
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
  // The round scope is FEED state: no seek promise at all (the stamped
  // tick beside it is what a watch link lands on).
  assert.deepEqual(entrySeed({ roundFrom: '7', roundTo: '7' }, LOOP_ROUNDS), {
    seek: null,
    loop: null,
  });
  assert.deepEqual(entrySeed({ loop: '1200,2400' }, LOOP_ROUNDS), {
    seek: null,
    loop: { from: 1200, to: 2400 },
  });
  assert.deepEqual(entrySeed({}, LOOP_ROUNDS), { seek: null, loop: null });
  // Rounds still loading: the LOOP half's span gate has no span to
  // check against (the explicit bounds stand on their own); the seek
  // half never reads rounds at all.
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
// The dock's captured replay hash goes in; ?back= is rewritten to the
// latest match path and the consumed ?tick= is DROPPED, every other
// param (filter scope, loop, sel) preserved byte-for-byte — expanding
// must never reset state or move the playhead (the instance was never
// unmounted; the engine owns the position), while dropping the tick
// resets the seed baseline so the SAME watch link clicked again
// re-seeks.
test('expandReplayHash rewrites ?back= and drops the consumed ?tick= (keeps loop/sel/filter)', () => {
  assert.equal(
    expandReplayHash(
      '#/replay/5?cat=kill&roundFrom=3&roundTo=7&tick=1234&loop=100,200&sel=e%3A9&back=match/5/rounds',
      'match/5/economy',
    ),
    '/replay/5?cat=kill&roundFrom=3&roundTo=7&loop=100,200&sel=e%3A9&back=match/5/economy',
  );
  // ?tick= is the ONLY param the expand drops: a tick-only capture
  // leaves nothing but the fresh back (never a bare "?").
  assert.equal(expandReplayHash('#/replay/5?tick=42', 'match/5'), '/replay/5?back=match/5');
  // …and with an empty origin too (the stale ?back= goes as well).
  assert.equal(expandReplayHash('#/replay/5?tick=42', ''), '/replay/5');
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
  // mint the canonical #/replay/:id form and stamp the fresh back
  // origin, never echo the match path back. Q3a: the chat SCOPE is gone
  // with the chat category (router.js maps the legacy tab to the plain
  // feed), so only the back origin rides along.
  assert.equal(
    expandReplayHash('#/match/5/chat', 'match/5/economy'),
    '/replay/5?back=match/5/economy',
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
