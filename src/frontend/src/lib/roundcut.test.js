// Tests for the unified round-boundary cleanup rule (lib/replay/
// roundcut.js): THE one rule the replay renderer uses to stop entities
// from lingering past their round (smoke/fire areas, detonation pops,
// grenade arcs, decoy rest windows — the same strategy the death X and
// the planted C4 already solved).
//
// Two rules, one home:
//   P1 roundCutTick      — first SAME-ROUND round_end at/after the row,
//                          else the first round_start after it, else
//                          null (never cut a live/truncated round);
//   P2 nextRoundStartTick — the first round_start strictly after the row:
//                          round_end is NEVER a terminator (pops/arcs —
//                          bomb_explode sits exactly ON end_tick).
// plus ROUND_POLICY (which rule each pre-bucketed drawBucket obeys) and
// entityEndTick (min(own lifetime, cut) with the fallback semantics).
//
// The renderer-side end-to-end behavior (gone AT the boundary, scrub
// re-derivation, the P2 grace) is pinned in src/lib/renderer.test.js.
// Run: node --test src/lib/roundcut.test.js (from frontend/; the lib
// test glob src/lib/*.test.js picks it up too).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ROUND_POLICY,
  roundCutTick,
  sameRoundEndTick,
  nextRoundStartTick,
  entityEndTick,
} from './replay/roundcut.js';

// one round of evidence, shared by the entityEndTick cases below
const ends0 = () => [{ round: 1, tick: 400 }];
const starts0 = () => [{ round: 2, tick: 450 }];

// --- P1: roundCutTick (the areas' rule) --------------------------------------

test('roundCutTick: the FIRST same-round round_end at/after the row is the cut', () => {
  const row = { round: 1, tick: 100 };
  const ends = [
    { round: 2, tick: 900 }, // a later round's end — ignored (foreign)
    { round: 1, tick: 900 }, // a same-round end AFTER the first one — not the earliest
    { round: 1, tick: 400 }, // THE round end
  ];
  const starts = [{ round: 2, tick: 450 }];
  // round_end (400) wins over the next round's start (450): the round's
  // own end is the boundary for an entity inside that round.
  assert.equal(roundCutTick(row, ends, starts), 400);
  // order-independent: the earliest same-round end at/after the row wins
  assert.equal(roundCutTick(row, [...ends].reverse(), starts), 400);
  // a same-round end AT the row's own tick cuts at that very tick (>=)
  assert.equal(roundCutTick({ round: 1, tick: 400 }, ends, starts), 400);
});

test('roundCutTick: a same-round end BEFORE the row cannot terminate it', () => {
  // the row happens after its round already ended (the post-round window):
  // no same-round end is left, so the next round's start is the boundary
  const ends = [{ round: 1, tick: 400 }];
  assert.equal(roundCutTick({ round: 1, tick: 500 }, ends, [{ round: 2, tick: 900 }]), 900);
  assert.equal(roundCutTick({ round: 1, tick: 500 }, ends, []), null, 'and with no later start → no cut');
});

test('roundCutTick: a row stamped AFTER its round_end falls to the next round_start', () => {
  // The post-round C4-detonation shape: the row belongs to round 1 but
  // happens past round 1's round_end (400) — no same-round end is left to
  // terminate it, so the NEXT round's start (450) is the boundary.
  const ends = [{ round: 1, tick: 400 }];
  const starts = [{ round: 1, tick: 0 }, { round: 2, tick: 450 }, { round: 3, tick: 900 }];
  assert.equal(roundCutTick({ round: 1, tick: 420 }, ends, starts), 450);
  // …and with no later round_start loaded (truncated feed) there is no
  // cut at all — never a fabricated boundary.
  assert.equal(roundCutTick({ round: 1, tick: 420 }, ends, []), null);
  assert.equal(roundCutTick({ round: 1, tick: 420 }, ends, null), null);
});

test('roundCutTick: a foreign round never cuts (round scoping on round_end)', () => {
  const row = { round: 2, tick: 100 };
  const ends = [
    { round: 1, tick: 50 }, // an earlier round's end — ignored
    { round: 3, tick: 900 }, // a LATER round's end — ignored
  ];
  assert.equal(roundCutTick(row, ends, []), null, 'no same-round end and no start → no cut');
  assert.equal(roundCutTick(row, ends, null), null);
  // the start half is deliberately NOT round-scoped (a round_start is
  // always the boundary of the round that follows it)
  assert.equal(roundCutTick(row, ends, [{ round: 3, tick: 500 }]), 500);
});

test('roundCutTick: no rows at all → null (never cut a live/truncated round)', () => {
  const row = { round: 1, tick: 100 };
  assert.equal(roundCutTick(row, [], []), null);
  assert.equal(roundCutTick(row, null, null), null);
  assert.equal(roundCutTick(row, undefined, undefined), null);
  // a row with no round field can never match a round_end; without a
  // round_start there is still no cut
  assert.equal(roundCutTick({ tick: 100 }, [{ round: 1, tick: 400 }], []), null);
  // non-finite input never produces a cut (NaN comparisons fail)
  assert.equal(roundCutTick({ round: 1, tick: NaN }, [{ round: 1, tick: 400 }], [{ round: 2, tick: 450 }]), null);
});

// --- P2: nextRoundStartTick (the pops/arcs' rule) -----------------------------

test('P2: the round_end is NEVER a terminator for a pop', () => {
  const row = { round: 1, tick: 100 };
  const ends = [{ round: 1, tick: 400 }];
  const starts = [{ round: 2, tick: 450 }];
  // the P2 primitive only ever consults the round_start list…
  assert.equal(nextRoundStartTick(row.tick, starts), 450);
  assert.equal(nextRoundStartTick(row.tick, null), null);
  // …and entityEndTick with the 'pop' policy therefore returns the NEXT
  // round's start, never the round_end sitting in between (the ratified
  // P2 rule: grace to the next round_start, cut at round_end forbidden).
  assert.equal(entityEndTick(row, { policy: 'pop' }, ends, starts), 450);
  // even a round_end at/after the row cannot terminate a pop: without a
  // round_start after it there is no cut at all (NOT the round_end)
  assert.equal(entityEndTick(row, { policy: 'pop' }, ends, [{ round: 1, tick: 0 }]), null);
  assert.equal(entityEndTick(row, { policy: 'pop' }, ends, []), null, 'no start → no cut (not the round_end)');
  // a round_start AT or BEFORE the row is the row's own round's start —
  // it cannot terminate an entity it contains
  assert.equal(nextRoundStartTick(450, starts), null);
  assert.equal(nextRoundStartTick(500, [{ round: 2, tick: 450 }, { round: 3, tick: 600 }]), 600);
});

// --- entityEndTick: min(own end, cut) with the fallbacks ----------------------

test('entityEndTick: the own lifetime caps the cut, and vice versa', () => {
  const row = { round: 1, tick: 128 };
  const ends = [{ round: 1, tick: 400 }];
  const starts = [{ round: 2, tick: 450 }];
  // own = 128 + 18 s · 64 = 1280; the round cut is 400 → the round wins
  // (a synthetic lifetime outrunning its round — the smoke's REAL own end
  // is the recorded 1412 ticks, see the endTick test below)
  assert.equal(
    entityEndTick(row, { policy: 'area', lifetimeS: 18, tickRate: 64 }, ends, starts),
    400,
  );
  // no cut (truncated round) → the lifetime alone ends the entity
  assert.equal(entityEndTick(row, { policy: 'area', lifetimeS: 18, tickRate: 64 }, [], []), 1280);
  // cut shorter than the lifetime: the cut wins
  assert.equal(
    entityEndTick({ round: 1, tick: 420 }, { policy: 'area', lifetimeS: 7, tickRate: 64 }, ends, starts),
    450,
  );
  // no own lifetime (a pop) → the cut alone, or null
  assert.equal(entityEndTick(row, { policy: 'pop' }, ends, starts), 450);
  assert.equal(entityEndTick(row, { policy: 'pop' }, [], []), null);
  // an invalid tickRate defaults to 64 exactly like killEndTick
  assert.equal(
    entityEndTick(row, { policy: 'area', lifetimeS: 18, tickRate: 0 }, [], []),
    1280,
  );
});

test('entityEndTick: a NaN-tick row ends at 0 (it can never draw)', () => {
  // Same convention as killEndTick → 0: the draw loops' boundary
  // spelling `tick >= end && tick !== row.tick` skips it forever (the
  // row tick is NaN, so the own-tick exemption never matches).
  assert.equal(entityEndTick({ round: 1, tick: NaN }, { policy: 'pop' }, [], []), 0);
  assert.equal(entityEndTick(null, { policy: 'pop' }, [], []), 0);
  assert.equal(entityEndTick({ round: 1, tick: NaN }, { policy: 'area', lifetimeS: 18, tickRate: 64 }, [], []), 0);
  // an unknown/absent policy is P3/P4: no round row ever cuts it, so
  // only an own lifetime the caller supplied can bound the entity
  assert.equal(
    entityEndTick({ round: 1, tick: 128 }, { lifetimeS: 18, tickRate: 64 }, ends0(), starts0()),
    128 + 18 * 64,
  );
  assert.equal(entityEndTick({ round: 1, tick: 128 }, {}, ends0(), starts0()), null);
});

test('entityEndTick: a recorded absolute endTick is the own end (beats lifetimeS, still cut)', () => {
  // The owner ruling (2026-11-12): use the DEMO's recorded end per entity
  // when available — world.js stamps it as `areaEndTick` (the paired
  // smokegrenade_expired / inferno_expire tick) and the renderer passes it
  // as opts.endTick. The seconds-based lifetimeS stays the fallback form.
  const row = { round: 1, tick: 128 };
  const ends = [{ round: 1, tick: 900 }];
  const starts = [{ round: 2, tick: 950 }];
  // no round rows → the recorded end alone, EXACT (never re-derived from
  // a lifetime: a smoke's recorded expiry is 1412 ticks, not 18 s)
  assert.equal(entityEndTick(row, { policy: 'area', endTick: 1540, tickRate: 64 }, [], []), 1540);
  // endTick PRECEDES the seconds lifetime (128 + 18·64 = 1280): the
  // recorded end wins — an EXTINGUISHED fire's early inferno_expire beats
  // the fixed window (the whole point of the ruling)
  assert.equal(
    entityEndTick(row, { policy: 'area', endTick: 700, lifetimeS: 18, tickRate: 64 }, [], []),
    700,
    'endTick takes precedence over lifetimeS',
  );
  // …and a recorded end BEYOND the round is still MIN'd with the round
  // cut (the roundcut standard: the cut only ever shortens)
  assert.equal(
    entityEndTick(row, { policy: 'area', endTick: 5000, tickRate: 64 }, ends, starts),
    900,
    'the round cut bounds a recorded end that would outlive the round',
  );
  assert.equal(
    entityEndTick(row, { policy: 'area', endTick: 700, tickRate: 64 }, ends, starts),
    700,
    'a recorded end inside the round wins over the later cut',
  );
  // a NON-finite recorded end is unknown → fall back to lifetimeS (never
  // a fabricated end, never NaN leaking into the boundary spelling)
  assert.equal(
    entityEndTick(row, { policy: 'area', endTick: NaN, lifetimeS: 18, tickRate: 64 }, [], []),
    1280,
  );
  // no recorded end and no lifetime → the cut alone (or null)
  assert.equal(entityEndTick(row, { policy: 'area', endTick: undefined }, ends, starts), 900);
  assert.equal(entityEndTick(row, { policy: 'area', endTick: undefined }, [], []), null);
  // a NaN row tick still ends at 0 whatever own end is supplied
  assert.equal(entityEndTick({ round: 1, tick: NaN }, { policy: 'area', endTick: 5000 }, [], []), 0);
});

// --- ROUND_POLICY: the ratified classification -------------------------------

test('ROUND_POLICY: P1 areas and P2 pops are classified; P3/P4 buckets are absent', () => {
  // P1 — the lingering areas (drawn as the area AND as their detonation
  // bloom, hence both rules on the same bucket)
  assert.deepEqual(ROUND_POLICY.smoke, ['area', 'pop']);
  assert.deepEqual(ROUND_POLICY.fire, ['area', 'pop']);
  // P2 — pops/arcs: detonation pops, bomb explode/defuse pops, grenade
  // flight arcs, the decoy rest/noise window
  for (const bucket of ['detonation', 'flash', 'he', 'throw', 'land', 'explode', 'defuse']) {
    assert.deepEqual(ROUND_POLICY[bucket], ['pop'], `${bucket} obeys the P2 rule`);
  }
  // P3 keep (already canonical — bombEndTick / killEnds / drops.js /
  // actionIntervals own them) and P4 non-consolidations (players, trails,
  // tracers, blinds, blooms, the damage flash): deliberately ABSENT from
  // the table, so no round rule ever touches them.
  for (const bucket of [
    'kill',
    'plant',
    'drop',
    'pickup',
    'wdrop',
    'wpickup',
    'damage',
    'round',
    'start',
    'plant_begin',
    'plant_abort',
    'defuse_start',
    'defuse_abort',
    '',
  ]) {
    assert.equal(ROUND_POLICY[bucket], undefined, `${bucket} is never round-cut here`);
  }
  // no bucket is classified by accident: the table holds ONLY the P1/P2 rows
  assert.deepEqual(
    Object.keys(ROUND_POLICY).sort(),
    ['detonation', 'defuse', 'explode', 'fire', 'flash', 'he', 'land', 'smoke', 'throw'].sort(),
  );
});

// --- sameRoundEndTick (the scan killEndTick/bombEndTick delegate to) ----------

test('sameRoundEndTick: the earliest same-round end at/after the row, else null', () => {
  const row = { round: 3, tick: 1000 };
  assert.equal(
    sameRoundEndTick(row, [
      { round: 2, tick: 900 },
      { round: 3, tick: 800 }, // before the row — ignored
      { round: 4, tick: 9000 }, // later round — ignored
      { round: 3, tick: 5000 },
      { round: 3, tick: 7000 },
    ]),
    5000,
    'the earliest same-round end at/after the row wins',
  );
  assert.equal(sameRoundEndTick(row, [{ round: 3, tick: 800 }]), null);
  assert.equal(sameRoundEndTick(row, []), null);
  assert.equal(sameRoundEndTick(row, null), null);
  assert.equal(sameRoundEndTick(null, [{ round: 3, tick: 5000 }]), null);
});
