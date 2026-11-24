// Tests for lib/nav.js: the profile return trip (profileBackTarget — the
// resolution behind PlayerProfile's top-left back button), the navigation
// guards the profile links share (isSteam/openProfile), the sidebar
// action highlighters (NAV_ACTIONS active()) and the nav decision pair
// (MATCH_FAMILY + PROFILE_FAMILY and isNavEnabled/resolveNavTarget — the
// Match tab's and the Profiles tab's session-memory targets, shared by
// the rail and the command palette),
// and the replay entry
// resolvers (entrySeekTick — the ?tick= position contract: the ONLY
// "where to jump" instruction, with the round scope as feed-filter
// state that never seeks — plus entryLoopRange and
// the ?loop= stampers entryLoopSpan / entryLoopAround /
// entryLoopSpanAround beside it, and the
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
  MATCH_FAMILY,
  PROFILE_FAMILY,
  isNavEnabled,
  resolveNavTarget,
  entrySeekTick,
  entryLoopRange,
  entrySeed,
  entrySeedPlan,
  entryLoopSpan,
  entryLoopAround,
  entryLoopSpanAround,
  LOOP_SECS_DEFAULT,
  prefLoopSecs,
  expandReplayHash,
} from './nav.js';

test('an explicit ?back= origin wins (durable, deep-linkable)', () => {
  assert.equal(
    profileBackTarget({ back: 'match/5/scoreboard' }, '#/profiles'),
    '/match/5/scoreboard',
  );
  assert.equal(profileBackTarget({ back: 'match/5/rounds' }, ''), '/match/5/rounds');
});

test('without ?back= the back button goes to the players list, not the page it came from', () => {
  assert.equal(profileBackTarget({}), '/profiles');
  assert.equal(profileBackTarget({ back: undefined }), '/profiles');
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
  assert.equal(active.Match(route('player')), false);
  // The directory itself stays Profiles-active.
  assert.equal(active.Profiles(route('profiles')), true);
  // L4: the match family is the MATCH tab's, never the Library hub's —
  // the Library claims only its own route, so exactly one action claims
  // each of them (the invariant pinned below).
  for (const name of ['match', 'replay']) {
    assert.equal(active.Library(route(name)), false, `Library on ${name}`);
    assert.equal(active.Match(route(name)), true, `Match on ${name}`);
    assert.equal(active.Profiles(route(name)), false, `Profiles on ${name}`);
  }
  // …and the Library route itself is still the Library's alone.
  assert.equal(active.Library(route('library')), true, 'Library on library');
  assert.equal(active.Match(route('library')), false, 'Match on library');
});

// MATCH_FAMILY — THE nav-level partition behind the Match tab (L4): the
// four route names that are the match view, and nothing else.
test('MATCH_FAMILY holds exactly the match view routes (the nav partition)', () => {
  assert.deepEqual([...MATCH_FAMILY].sort(), ['match', 'replay']);
  const matchAction = NAV_ACTIONS.find((a) => a.label === 'Match');
  assert.ok(matchAction, 'the Match action exists');
  for (const name of MATCH_FAMILY) {
    assert.equal(matchAction.active({ name }), true, `Match on ${name}`);
  }
  assert.equal(matchAction.active({ name: 'library' }), false, 'Match on library');
});

// PROFILE_FAMILY — the same partition for the Profiles tab (N7): the
// directory and a player's own page. THE set, and the ONE criterion —
// active(), the memory store and the memory validate all read it, so
// they can never diverge (the wave's own ruling: no second
// `route name === 'player'` branch lives in the helpers).
test('PROFILE_FAMILY holds exactly {profiles, player} and active() agrees', () => {
  assert.deepEqual([...PROFILE_FAMILY].sort(), ['player', 'profiles']);
  const profilesAction = NAV_ACTIONS.find((a) => a.label === 'Profiles');
  assert.ok(profilesAction, 'the Profiles action exists');
  for (const name of PROFILE_FAMILY) {
    assert.equal(profilesAction.active({ name }), true, `Profiles on ${name}`);
  }
  // …and nothing else lights it up (the exactly-one invariant below
  // covers the other side).
  for (const name of ['library', 'match', 'replay', 'builder', 'reportbuilder', 'sql', 'settings']) {
    assert.equal(profilesAction.active({ name }), false, `Profiles on ${name}`);
  }
  // The memory policy is declared ON the action — the helpers never
  // branch on its label.
  assert.equal(profilesAction.memory, 'fallback');
  assert.equal(profilesAction.family, PROFILE_FAMILY);
  assert.equal(profilesAction.memoryKey, 'lastProfilesHash');
});

test('sidebar active(): exactly one action lights up per route', () => {
  const routes = [
    'library',
    'match',
    'replay',
    'player',
    'profiles',
    'builder',
    'reportbuilder',
    'componentbuilder',
    'sql',
    'settings',
  ];
  for (const name of routes) {
    const on = NAV_ACTIONS.filter((a) => a.active({ name })).map((a) => a.label);
    assert.equal(on.length, 1, `${name} → ${on.join(', ')}`);
  }
});

// --- resolveNavTarget / isNavEnabled: THE shared decision pair ------------
// Both surfaces (App's rail, the command palette's Actions) resolve
// through these, so they can never diverge about what an action does or
// whether it is live. ctx = { lastMatchHash, lastProfilesHash }: the
// full hashes of the last match-family / profile-family routes the user
// visited this session.
test('isNavEnabled: Match is the only gated action — the other memory-backed one (Profiles) is never gated', () => {
  const byLabel = Object.fromEntries(NAV_ACTIONS.map((a) => [a.label, a]));
  const withHash = { lastMatchHash: '#/match/5/scoreboard?roundFrom=3' };
  // Every fixed-target action is enabled whatever the memory says.
  // The Reports builder rides the same list: a single-route action with
  // no `memory` field is always enabled and always targets its own hash.
  for (const label of ['Library', 'Metric builder', 'Reports builder', 'SQL console', 'Settings']) {
    assert.equal(isNavEnabled(byLabel[label], { lastMatchHash: '' }), true, `${label} empty`);
    assert.equal(isNavEnabled(byLabel[label], withHash), true, `${label} with memory`);
    assert.equal(isNavEnabled(byLabel[label], undefined), true, `${label} no ctx`);
  }
  // Profiles is memory-backed ('fallback') but ALWAYS enabled: there is
  // always a directory to go to, so no memory state can gate it.
  for (const ctx of [
    undefined,
    {},
    { lastProfilesHash: '' },
    { lastProfilesHash: '#/player/76561198012345678?back=match/5' },
    { lastProfilesHash: '#/library' },
    { lastProfilesHash: '#/not-a-profile' },
  ]) {
    assert.equal(isNavEnabled(byLabel.Profiles, ctx), true, `Profiles ctx=${JSON.stringify(ctx)}`);
  }
  // The Match action ('gate'): disabled until the memory names a REAL match.
  assert.equal(isNavEnabled(byLabel.Match, { lastMatchHash: '' }), false, 'no memory yet');
  assert.equal(isNavEnabled(byLabel.Match, undefined), false, 'no ctx');
  assert.equal(isNavEnabled(byLabel.Match, {}), false, 'ctx without the key');
  assert.equal(isNavEnabled(byLabel.Match, { lastMatchHash: '#/library' }), false, 'not match-family');
  assert.equal(isNavEnabled(byLabel.Match, { lastMatchHash: '#/match' }), false, 'no id (parses to library)');
  assert.equal(isNavEnabled(byLabel.Match, { lastMatchHash: '#/match/0' }), false, 'id 0 is no match');
  // Every match-family shape with a real id enables it.
  for (const h of [
    '#/match/5',
    '#/match/5/scoreboard',
    '#/match/5/round/7',
    '#/replay/5?cat=chat&tick=100',
  ]) {
    assert.equal(isNavEnabled(byLabel.Match, { lastMatchHash: h }), true, h);
  }
});

test('resolveNavTarget: fixed actions ignore the memory; the memory-backed actions return their remembered FULL hash', () => {
  const byLabel = Object.fromEntries(NAV_ACTIONS.map((a) => [a.label, a]));
  const withHash = { lastMatchHash: '#/replay/5?cat=chat&tick=100' };
  // Fixed targets are the action's own hash, memory or not.
  assert.equal(resolveNavTarget(byLabel.Library, withHash), '/library');
  assert.equal(resolveNavTarget(byLabel.Settings, { lastMatchHash: '' }), '/settings');
  assert.equal(resolveNavTarget(byLabel['Reports builder'], withHash), '/reportbuilder');
  // The Match action lands on the WHOLE remembered hash — path AND query
  // (the tab, round and URL filters survive the round trip).
  assert.equal(resolveNavTarget(byLabel.Match, withHash), '#/replay/5?cat=chat&tick=100');
  assert.equal(
    resolveNavTarget(byLabel.Match, { lastMatchHash: '#/match/5/scoreboard?roundFrom=3' }),
    '#/match/5/scoreboard?roundFrom=3',
  );
  // Unusable memory (empty / not a match / no id) → the fallback hash,
  // never a broken target: the rail disables the button and the palette
  // omits the row, so this leg is only a stray-click safety net.
  assert.equal(resolveNavTarget(byLabel.Match, { lastMatchHash: '' }), '/library');
  assert.equal(resolveNavTarget(byLabel.Match, { lastMatchHash: '#/profiles' }), '/library');
  assert.equal(resolveNavTarget(byLabel.Match, { lastMatchHash: '#/match/0' }), '/library');
  assert.equal(resolveNavTarget(byLabel.Match, undefined), '/library');
  // The Profiles action ('fallback') targets the remembered hash of the
  // WHOLE family — directory OR player page — verbatim, query included;
  // anything unusable falls back to the directory (the button is always
  // enabled, so this fallback is a live path, not a safety net).
  assert.equal(
    resolveNavTarget(byLabel.Profiles, { lastProfilesHash: '#/player/76561198012345678?back=match/5' }),
    '#/player/76561198012345678?back=match/5',
    'the player page + its query comes back verbatim',
  );
  assert.equal(
    resolveNavTarget(byLabel.Profiles, { lastProfilesHash: '#/profiles?map=de_cache' }),
    '#/profiles?map=de_cache',
    'the directory itself is a remembered place in the family',
  );
  assert.equal(resolveNavTarget(byLabel.Profiles, { lastProfilesHash: '' }), '/profiles', 'empty');
  assert.equal(resolveNavTarget(byLabel.Profiles, {}), '/profiles', 'absent');
  assert.equal(resolveNavTarget(byLabel.Profiles, undefined), '/profiles', 'no ctx');
  // Wrong family → never a broken target (the Match memory can never
  // steer the Profiles tab and vice versa: each reads its OWN key and
  // validates against its OWN family).
  assert.equal(
    resolveNavTarget(byLabel.Profiles, { lastProfilesHash: '#/match/5/scoreboard' }),
    '/profiles',
  );
  assert.equal(
    resolveNavTarget(byLabel.Profiles, { lastMatchHash: '#/match/5/scoreboard' }),
    '/profiles',
    'the match memory never feeds the profiles target',
  );
});

// --- entrySeekTick: the replay entry time target --------------------------
// PARAMETER SEPARATION (the product-owner contract): ?tick= is the ONLY
// "where to jump" instruction — ?roundFrom=/?roundTo= are feed-filter
// state ("what to show") and never a position, at mount or mid-session.
// The watch/drill links stamp roundStartTick as ?tick= BESIDE their
// scope; a scope-only URL resolves null (Replay lands on the pref-aware
// default, the filter still applies).

test('entrySeekTick: an exact ?tick= link is the only position source', () => {
  // RoundDetail's "Watch round" / Combat's EventPlay / Utility's
  // "replay" / Economy's stat-card drill all stamp an exact
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
  // No position param at all: null → Replay applies its load-time
  // default (the first counted round's start — the knife/warmup
  // visibility pref that used to pick between it and frame 0 died with
  // the discard) — the DELIBERATE CHANGE
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

// The loop LENGTH of the two event categories is the user's `loop_secs`
// pref (Settings → Replay) — nav.prefLoopSecs is its ONE coercer and
// LOOP_SECS_DEFAULT its default home.
test('prefLoopSecs: the one loop_secs coercer (round, clamp 1..60, unset/corrupt → the default)', () => {
  assert.equal(LOOP_SECS_DEFAULT, 5); // the default is this wave's owner-set number
  // Unset / not this pref's shape → the default (never 0, never NaN).
  assert.equal(prefLoopSecs(undefined), 5);
  assert.equal(prefLoopSecs(null), 5);
  assert.equal(prefLoopSecs(''), 5);
  assert.equal(prefLoopSecs('5'), 5); // a string is never this pref's shape
  assert.equal(prefLoopSecs('nope'), 5);
  assert.equal(prefLoopSecs([]), 5); // the econ-tables auto-stub's `[]` answer
  assert.equal(prefLoopSecs({}), 5);
  assert.equal(prefLoopSecs(true), 5);
  assert.equal(prefLoopSecs(NaN), 5);
  assert.equal(prefLoopSecs(Infinity), 5);
  // A real value rounds to whole seconds…
  assert.equal(prefLoopSecs(5), 5);
  assert.equal(prefLoopSecs(7.4), 7);
  assert.equal(prefLoopSecs(7.6), 8);
  // …and clamps into the Settings control's own bounds (min 1 / max 60).
  assert.equal(prefLoopSecs(0), 1);
  assert.equal(prefLoopSecs(-9), 1);
  assert.equal(prefLoopSecs(999), 60);
});

test('entryLoopAround anchors an event at the loop length (the loop_secs pref, default 5 s)', () => {
  // Default: 5 s × 64 tick = 320 ticks either side (LOOP_SECS_DEFAULT).
  assert.equal(entryLoopAround(10640, 64), '10320,10960');
  // An explicit width pads exactly that many seconds — 10 s was the old
  // fixed width and stays reachable as a stored pref.
  assert.equal(entryLoopAround(10640, 64, 10), '10000,11280');
  // …and the width scales with the match rate (5 s × 128 = 640 a side).
  assert.equal(entryLoopAround(10640, 128), '10000,11280');
  // The lower bound floors at 0 (never negative); the upper keeps full
  // width — the range is never reshaped to the round.
  assert.equal(entryLoopAround(100, 64), '0,420');
  // An absent/invalid tick rate is the engine's own 64 fallback
  // (fmt.normTickRate), not a zero-width anchor.
  assert.equal(entryLoopAround(10640, 0), '10320,10960');
  assert.equal(entryLoopAround(10640, undefined), '10320,10960');
  // A corrupt seconds argument falls back to the default as well — the
  // coercer is the only reader of the pref.
  assert.equal(entryLoopAround(10640, 64, null), '10320,10960');
  assert.equal(entryLoopAround(10640, 64, 'x'), '10320,10960');
  // No tick, no promise (null would coerce to 0 — never a bound).
  assert.equal(entryLoopAround(undefined, 64), undefined);
  assert.equal(entryLoopAround(null, 64), undefined);
  assert.equal(entryLoopAround(NaN, 64), undefined);
  assert.equal(entryLoopAround(-1, 64), undefined);
});

// The LONG-EVENT category (the owner's rule shape: `seconds` before the
// first … to `seconds` after the last): the same half-width as
// entryLoopAround — the loop_secs pref — padded onto BOTH ends of the
// occurrence span.
test('entryLoopSpanAround pads the loop length onto BOTH ends of a long-event span', () => {
  // Default 5 s × 64 tick = 320 ticks on each side of each bound.
  assert.equal(entryLoopSpanAround(10640, 20000, 64), '10320,20320');
  // An explicit width pads exactly that many seconds (10 s = the old
  // fixed width).
  assert.equal(entryLoopSpanAround(10640, 20000, 64, 10), '10000,20640');
  // A single-occurrence span (first === last) degenerates to the
  // singular-event anchor.
  assert.equal(entryLoopSpanAround(10640, 10640, 64), '10320,10960');
  // The lower bound floors at 0 (never negative); the upper keeps full
  // width — never reshaped to the round, same clamp as entryLoopAround.
  assert.equal(entryLoopSpanAround(100, 5000, 64), '0,5320');
  // An absent/invalid tick rate falls back to the engine's 64
  // (fmt.normTickRate), never a zero-width pad.
  assert.equal(entryLoopSpanAround(10640, 20000, 0), '10320,20320');
  assert.equal(entryLoopSpanAround(10640, 20000, undefined), '10320,20320');
  // 128-tick matches scale the width with the match rate (5 s → 640).
  assert.equal(entryLoopSpanAround(10640, 20000, 128), '10000,20640');
  assert.equal(entryLoopSpanAround(10640, 20000, 128, 10), '9360,21280');
});

test('entryLoopSpanAround states nothing when a bound or the order is unstatable', () => {
  // Either bound absent/non-finite/negative, or an inverted span: never a
  // promise (undefined → buildHash drops it; the seek still fires).
  assert.equal(entryLoopSpanAround(undefined, 20000, 64), undefined);
  assert.equal(entryLoopSpanAround(10640, undefined, 64), undefined);
  assert.equal(entryLoopSpanAround(null, null, 64), undefined); // Number(null) is 0 — never a bound
  assert.equal(entryLoopSpanAround('', '', 64), undefined); // Number('') is 0 too
  assert.equal(entryLoopSpanAround(NaN, 20000, 64), undefined);
  assert.equal(entryLoopSpanAround(10640, NaN, 64), undefined);
  assert.equal(entryLoopSpanAround(-1, 20000, 64), undefined);
  assert.equal(entryLoopSpanAround(10640, -1, 64), undefined);
  assert.equal(entryLoopSpanAround(20000, 10640, 64), undefined); // first > last
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
