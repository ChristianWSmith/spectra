// Node tests for lib/replay/livestats.js — the live K/D/A + ADR fold
// behind the player card's stats row. The rules mirror the canonical Go
// fold (internal/analytics/rounds.go PlayerRounds): counted rounds only,
// enemy-only kills (unknown side permissive), cross-team non-flash
// assists, every death, ALL damage (friendly fire included), ADR over the
// counted rounds STARTED at/before the playhead — for BOTH entry points:
// the pure liveStats and the incremental cursor the view drives per tick
// (the cursor is pinned to the pure fold's output, row order included).
// Run: node --test src/lib/livestats.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { liveStats, liveStatsIncremental, createLiveStatsCursor } from './replay/livestats.js';

// Rounds: #1 starts at 0, #2 at 1000; the knife (#-2) and a warmup (#-1)
// are NOT counted, and round 99 never appears in the rows at all.
const ROUNDS = [
  { number: -2, startTick: -5000, warmup: false, pregame: true },
  { number: -1, startTick: -2000, warmup: true, pregame: false },
  { number: 1, startTick: 0, warmup: false, pregame: false },
  { number: 2, startTick: 1000, warmup: false, pregame: false },
];

// Sides are constant per player for these fixtures (sideAt is injected,
// so the module itself stays a plain function).
const SIDES = { A: 'ct', B: 'ct', C: 'ct', X: 't', Y: 't' };
const sideAt = (id, tick) => SIDES[String(id)] || '';

const kill = (over = {}) => ({ kind: 'kill', tick: 100, round: 1, ...over });
const dmg = (over = {}) => ({ kind: 'damage', tick: 100, round: 1, ...over });

const fold = (events, opts = {}) =>
  liveStats(events, {
    rounds: ROUNDS,
    tick: 1500,
    sideAt,
    steamIds: ['A', 'B', 'C', 'X', 'Y'], // the roster every card would get
    ...opts,
  });

test('enemy kill: killer +1 K, victim +1 D; teamkill is not a K', () => {
  const out = fold([
    kill({ attacker: 'A', victim: 'X' }), // enemy → K for A
    kill({ attacker: 'A', victim: 'B' }), // friendly → no K, still a death for B
  ]);
  assert.equal(out.get('A').k, 1, 'teamkill must not credit a kill');
  assert.equal(out.get('X').d, 1);
  assert.equal(out.get('B').d, 1, 'every death counts, no side gate');
});

test('an UNKNOWN side is permissive — the kill counts (Go sameSide)', () => {
  const unknownSideAt = () => '';
  const out = fold([kill({ attacker: 'A', victim: 'X' })], { sideAt: unknownSideAt });
  assert.equal(out.get('A').k, 1, 'unknown vs unknown must not block a kill');
  assert.equal(out.get('X').d, 1);
  // …and the same permissiveness covers a known attacker vs an unknown victim.
  const half = fold([kill({ attacker: 'A', victim: '?' })], {
    sideAt: (id) => (id === 'A' ? 'ct' : ''),
  });
  assert.equal(half.get('A').k, 1);
});

test('assists: assister set, ≠ victim, cross-team, !assistedFlash', () => {
  const out = fold([
    kill({ attacker: 'A', victim: 'X', assister: 'C' }), // cross-team, plain → assist
    kill({ attacker: 'A', victim: 'X', assister: 'B' }), // same side as victim? B is ct, X t → assist
    kill({ attacker: 'A', victim: 'X', assister: 'C', assistedFlash: true }), // flash assist → no
    kill({ attacker: 'A', victim: 'X', assister: 'X' }), // assister == victim → no
    kill({ attacker: 'A', victim: 'X', assister: '' }), // no assister → no
  ]);
  assert.equal(out.get('C').a, 1, 'flash-assisted assist must not count');
  assert.equal(out.get('B').a, 1, 'cross-team assister counts');
  assert.equal(out.get('X').a, 0, 'a victim cannot assist themselves');
  assert.equal(out.get('A').a, 0);
});

test('damage folds ALL attributed damage — friendly fire included', () => {
  const out = fold([
    dmg({ attacker: 'A', victim: 'X', dmg: 30 }),
    dmg({ attacker: 'A', victim: 'B', dmg: 12 }), // friendly fire — canonical fold has NO side gate
    dmg({ attacker: 'C', victim: 'X', dmg: 8 }),
  ]);
  // ADR = damage ÷ counted rounds started (rounds 1 and 2 started by
  // tick 1500 → 2), so 42/2 and 8/2.
  assert.equal(out.get('A').adr, 42 / 2);
  assert.equal(out.get('C').adr, 8 / 2);
  assert.equal(out.get('X').adr, 0, 'no damage dealt is a real 0, not unknown');
  assert.equal(out.get('A').k, 0, 'damage never fabricates a kill');
});

test('counted rounds only: knife/warmup/unknown-round rows are dropped', () => {
  const out = fold([
    kill({ attacker: 'A', victim: 'X', round: -2, tick: -4000 }), // knife
    kill({ attacker: 'A', victim: 'X', round: -1, tick: -1000 }), // warmup
    kill({ attacker: 'A', victim: 'X', round: 99, tick: 500 }), // round row absent
    dmg({ attacker: 'A', victim: 'X', round: -1, tick: -1000, dmg: 50 }),
  ]);
  assert.equal(out.get('A').k, 0, 'a knife/warmup kill is not counted play');
  assert.equal(out.get('A').adr, 0, 'warmup damage must not reach ADR');
});

test('the playhead gates everything: rows after uiTick are not folded', () => {
  const events = [
    kill({ attacker: 'A', victim: 'X', tick: 1400 }),
    kill({ attacker: 'A', victim: 'Y', tick: 1501 }), // after the playhead
    dmg({ attacker: 'A', victim: 'X', tick: 1500, dmg: 10 }), // at the playhead → in
    dmg({ attacker: 'A', victim: 'X', tick: 1600, dmg: 999 }), // after → out
  ];
  const out = fold(events, { tick: 1500 });
  assert.equal(out.get('A').k, 1, 'only the event at/before the playhead counts');
  assert.equal(out.get('Y')?.d ?? 0, 0, 'a death after the playhead has not happened yet');
  assert.equal(out.get('A').adr, 10 / 2);
});

test('ADR: rounds started at/before the playhead divide; 0 rounds → null', () => {
  // Mid-round-1 playhead: only round 1 has started → one divisor.
  const early = fold([dmg({ attacker: 'A', dmg: 30 })], { tick: 500 });
  assert.equal(early.get('A').adr, 30 / 1);
  // Before every counted round starts: honest null, never 0.
  const cold = fold([dmg({ attacker: 'A', dmg: 30, tick: -6000, round: -2 })], {
    tick: -6000,
    sideAt,
    steamIds: ['A'],
  });
  assert.equal(cold.get('A').adr, null, '0 counted rounds must render "—", never 0');
  assert.equal(cold.get('A').k, 0);
});

test('every steam id gets a row (0 kills is a fact), events add their own', () => {
  const out = fold([kill({ attacker: 'A', victim: 'X' })], {
    steamIds: ['A', 'X', 'B', 'Z'],
  });
  for (const id of ['A', 'X', 'B', 'Z']) {
    assert.ok(out.get(id), `row for ${id}`);
  }
  assert.deepEqual(out.get('B'), { k: 0, d: 0, a: 0, adr: 0 });
  assert.deepEqual(out.get('Z'), { k: 0, d: 0, a: 0, adr: 0 });
  // No steamIds → rows still appear for whoever the events touched.
  const actors = fold([kill({ attacker: 'A', victim: 'X' })], { steamIds: [] });
  assert.equal(actors.get('A').k, 1);
  assert.equal(actors.get('B'), undefined);
});

test('defensive inputs never throw', () => {
  assert.deepEqual([...liveStats(null, {})], []);
  assert.deepEqual([...liveStats([], {})], []);
  const odd = liveStats([null, { kind: 'kill' }, { kind: 'kill', tick: 'x', round: 1 }], {
    rounds: [null, { number: '1' }, { startTick: 'nope', number: 2 }],
    tick: '1500',
    steamIds: null,
    sideAt: null,
  });
  assert.ok(odd instanceof Map);
  // A row without a usable tick cannot be placed at the playhead → dropped.
  assert.equal([...odd.values()].reduce((n, r) => n + r.k, 0), 0);
});

// --- The incremental fold (createLiveStatsCursor / liveStatsIncremental) -----
//
// The view folds once per playhead tick through the cursor, so the cursor
// is held to the pure fold's output at EVERY tick — same rows, same row
// ORDER (the Map's insertion order is part of what the cards render
// through), same ADR float. The fixtures below deliberately include the
// awkward rows (warmup/knife/unknown rounds, a bad tick, an assister
// flash, friendly fire) so the equivalence is pinned on the rules, not
// just on the happy path.

const SWEEP_ROUNDS = [
  { number: -2, startTick: -5000, warmup: false, pregame: true }, // knife
  { number: -1, startTick: -2000, warmup: true, pregame: false }, // warmup
  { number: 1, startTick: 0, warmup: false, pregame: false },
  { number: 2, startTick: 1000, warmup: false, pregame: false },
  { number: 3, startTick: 2000, warmup: false, pregame: false },
];
const SWEEP_ROSTER = ['A', 'B', 'C', 'X', 'Y', 'Z'];

// The shared sweep fixture — tick-sorted like the real drawNorm rows,
// with the junk (a hole, an unusable tick) interleaved. The ORDER is a
// CONTRACT, not a convenience: cursor.usable is verified by the pin
// below, because an unsorted fixture silently parks EVERY incremental
// pin on the pure-fold fallback — those pins compare against the pure
// fold, so they would keep passing while testing nothing of the cursor
// (the defect this fixture was repaired for: 999 used to precede 990).
const SWEEP_EVENTS = [
  { kind: 'kill', tick: -4000, round: -2, attacker: 'A', victim: 'X' }, // knife — dropped
  { kind: 'damage', tick: -1500, round: -1, attacker: 'X', victim: 'A', dmg: 40 }, // warmup — dropped
  { kind: 'damage', tick: 10, round: 1, attacker: 'A', victim: 'X', dmg: 30 },
  { kind: 'kill', tick: 12, round: 1, attacker: 'A', victim: 'X' },
  { kind: 'kill', tick: 13, round: 1, attacker: 'A', victim: 'B' }, // teamkill — no K
  { kind: 'kill', tick: 40, round: 1, attacker: 'A', victim: 'X', assister: 'C' },
  { kind: 'kill', tick: 41, round: 1, attacker: 'A', victim: 'X', assister: 'C', assistedFlash: true },
  { kind: 'damage', tick: 990, round: 1, attacker: 'C', victim: 'X', dmg: 8 },
  { kind: 'kill', tick: 999, round: 99, attacker: 'A', victim: 'X' }, // round row absent — dropped
  null, // a hole in the rows — never folds, never breaks the walk
  { kind: 'damage', tick: 'x', round: 1, attacker: 'A', dmg: 7 }, // unusable tick — dropped
  { kind: 'kill', tick: 1005, round: 2, attacker: 'X', victim: 'A' },
  { kind: 'damage', tick: 1500, round: 2, attacker: 'X', victim: 'A', dmg: 12 },
  { kind: 'kill', tick: 2100, round: 3, attacker: 'B', victim: 'Y' },
  { kind: 'damage', tick: 2500, round: 3, attacker: 'Z', victim: 'Y', dmg: 66 },
];

const sweepOpts = (tick, over = {}) => ({
  rounds: SWEEP_ROUNDS,
  tick,
  sideAt,
  steamIds: SWEEP_ROSTER,
  ...over,
});

const sameRows = (got, want, why) =>
  assert.deepEqual([...got], [...want], `${why} (row order included)`);

test('incremental: the sweep fixture takes the FAST path (the cursor really walks)', () => {
  // The contract the fixture header states: an UNSORTED SWEEP_EVENTS
  // would make cursor.usable false and park every pin below on the
  // pure-fold fallback — those pins compare against the pure fold, so
  // they would pass while testing none of the cursor. This is the guard
  // that keeps them honest.
  const cursor = createLiveStatsCursor();
  liveStatsIncremental(cursor, SWEEP_EVENTS, sweepOpts(0));
  assert.equal(cursor.usable, true, 'SWEEP_EVENTS is unsorted — the incremental pins are testing the fallback');
  assert.ok(cursor.next > 0, 'the walk advanced past the early rows');
});

test('incremental: a FORWARD sweep is byte-identical to the pure fold at every tick', () => {
  const cursor = createLiveStatsCursor();
  // Every 7 ticks across the whole fixture span — through the knife/
  // warmup rows, the round boundaries (0 / 1000 / 2000) and past the end.
  for (let tick = -6000; tick <= 3200; tick += 7) {
    const want = liveStats(SWEEP_EVENTS, sweepOpts(tick));
    const got = liveStatsIncremental(cursor, SWEEP_EVENTS, sweepOpts(tick));
    sameRows(got, want, `tick ${tick}`);
  }
});

test('incremental: a BACKWARD seek rebuilds — scrubbing back never leaks forward state', () => {
  const cursor = createLiveStatsCursor();
  // Warm the cursor up to the end first, then walk back tick by tick.
  liveStatsIncremental(cursor, SWEEP_EVENTS, sweepOpts(3200));
  for (let tick = 3200; tick >= -6000; tick -= 11) {
    const want = liveStats(SWEEP_EVENTS, sweepOpts(tick));
    const got = liveStatsIncremental(cursor, SWEEP_EVENTS, sweepOpts(tick));
    sameRows(got, want, `tick ${tick}`);
  }
  // …and forward again from the cold end (the reset must re-arm the walk).
  for (let tick = -6000; tick <= 3200; tick += 13) {
    sameRows(
      liveStatsIncremental(cursor, SWEEP_EVENTS, sweepOpts(tick)),
      liveStats(SWEEP_EVENTS, sweepOpts(tick)),
      `tick ${tick}`,
    );
  }
});

test('incremental: a REPLACEMENT rows array resets the cursor (identity is the key)', () => {
  const cursor = createLiveStatsCursor();
  liveStatsIncremental(cursor, SWEEP_EVENTS, sweepOpts(2500));
  // New identity (what drawNorm does on every refetch) + one more kill
  // the cursor has never seen — the rebuild must fold it, not skip it.
  const rows2 = SWEEP_EVENTS.concat([
    { kind: 'kill', tick: 3000, round: 3, attacker: 'C', victim: 'Y' },
  ]);
  for (const tick of [100, 2500, 3100]) {
    sameRows(
      liveStatsIncremental(cursor, rows2, sweepOpts(tick)),
      liveStats(rows2, sweepOpts(tick)),
      `replacement rows @ ${tick}`,
    );
  }
});

test('incremental: a SAME-identity rows array never resets the cursor (the category-toggle case)', () => {
  // A SORTED local fixture on purpose: the cursor's fast path is gated
  // on tick order, and the shared SWEEP_EVENTS fixture above interleaves
  // its junk in a way that leaves it unsorted (999 → 990), which parks
  // that whole sweep on the pure-fold fallback (see the report note —
  // the sweep's equivalence pins still hold, they just never walk).
  // This pin has to OBSERVE the walk, so it brings its own ordered rows.
  const rows = [
    { kind: 'kill', tick: 10, round: 1, attacker: 'A', victim: 'X' },
    { kind: 'damage', tick: 20, round: 1, attacker: 'A', victim: 'X', dmg: 30 },
    { kind: 'kill', tick: 1500, round: 2, attacker: 'B', victim: 'Y' },
    { kind: 'damage', tick: 2500, round: 3, attacker: 'Z', victim: 'Y', dmg: 66 },
  ];
  const opts = (tick) => ({ rounds: SWEEP_ROUNDS, tick, sideAt, steamIds: SWEEP_ROSTER });
  const cursor = createLiveStatsCursor();
  liveStatsIncremental(cursor, rows, opts(100));
  assert.ok(cursor.usable, 'the sorted fixture takes the fast path');
  const walked = cursor.next;
  assert.ok(walked > 0, 'the forward walk advanced');
  // The view's world dataset reads NOTHING but the fetched rows
  // (Replay's drawNorm → landmarks.normalizeWorld takes no filter), so a
  // category toggle keeps this EXACT array identity: the cursor must
  // keep its place instead of re-walking from 0 — the rebuild the old
  // filter-dependent normalization caused on every toggle. (A genuine
  // refetch still replaces the array and resets — the identity test
  // above stays true for actual refetches.)
  liveStatsIncremental(cursor, rows, opts(100));
  assert.equal(cursor.next, walked, 'same identity + same playhead → no rebuild');
  assert.equal(cursor.rows, rows, 'the rows identity is untouched');
  // …and the walk continues forward, still byte-identical to the pure
  // fold (the equivalence contract at the top of this file).
  const later = liveStatsIncremental(cursor, rows, opts(3100));
  sameRows(later, liveStats(rows, opts(3100)), 'same-identity forward sweep');
  assert.ok(cursor.next > walked, 'the walk continued forward');
});

test('incremental: rounds / sideAt identity changes rebuild too (ADR + kill sides)', () => {
  const cursor = createLiveStatsCursor();
  liveStatsIncremental(cursor, SWEEP_EVENTS, sweepOpts(2500));
  // A NEW rounds array (a refetch) that starts round 3 EARLIER: the ADR
  // denominator and the counted-round gate both move.
  const rounds2 = SWEEP_ROUNDS.map((r) => (r.number === 3 ? { ...r, startTick: 1500 } : r));
  sameRows(
    liveStatsIncremental(cursor, SWEEP_EVENTS, sweepOpts(2500, { rounds: rounds2 })),
    liveStats(SWEEP_EVENTS, sweepOpts(2500, { rounds: rounds2 })),
    'rounds replaced',
  );
  // A DIFFERENT sideAt (the position store reloaded): the same row can
  // classify differently, so the accumulators cannot survive it.
  const flipped = (id, tick) => (id === 'A' || id === 'B' || id === 'C' ? 't' : 'ct');
  sameRows(
    liveStatsIncremental(cursor, SWEEP_EVENTS, sweepOpts(2500, { sideAt: flipped })),
    liveStats(SWEEP_EVENTS, sweepOpts(2500, { sideAt: flipped })),
    'sideAt replaced',
  );
});

test('incremental: UNSORTED rows fall back to the pure fold (correctness first)', () => {
  const cursor = createLiveStatsCursor();
  // Same rows, deliberately out of tick order: the forward walk would
  // miss the early kill, so the cursor must detect it and stop trusting
  // the fast path — while still returning the pure fold's answer.
  const shuffled = [
    SWEEP_EVENTS[10],
    SWEEP_EVENTS[4],
    SWEEP_EVENTS[3],
    SWEEP_EVENTS[12],
    SWEEP_EVENTS[1],
    SWEEP_EVENTS[13],
    SWEEP_EVENTS[0],
    SWEEP_EVENTS[14],
  ];
  for (const tick of [-100, 500, 1200, 2600]) {
    sameRows(
      liveStatsIncremental(cursor, shuffled, sweepOpts(tick)),
      liveStats(shuffled, sweepOpts(tick)),
      `unsorted @ ${tick}`,
    );
  }
  assert.equal(cursor.usable, false, 'the cursor remembers it cannot walk these rows');
});

test('incremental: every call returns a FRESH Map (the cards re-render on identity)', () => {
  const cursor = createLiveStatsCursor();
  const a = liveStatsIncremental(cursor, SWEEP_EVENTS, sweepOpts(1500));
  const b = liveStatsIncremental(cursor, SWEEP_EVENTS, sweepOpts(1500)); // same tick
  assert.notEqual(a, b, 'a derived consumer must see a new value every evaluation');
  assert.notEqual(a.get('A'), b.get('A'), 'rows are rebuilt, never mutated in place');
  sameRows(b, a, '…but the CONTENT is identical');
});

test('incremental: defensive inputs behave exactly like the pure fold', () => {
  const cursor = createLiveStatsCursor();
  sameRows(liveStatsIncremental(cursor, null, {}), liveStats(null, {}), 'null rows');
  sameRows(liveStatsIncremental(cursor, [], {}), liveStats([], {}), 'empty rows');
  const oddOpts = {
    rounds: [null, { number: '1' }, { startTick: 'nope', number: 2 }],
    tick: '1500',
    steamIds: null,
    sideAt: null,
  };
  const rows = [null, { kind: 'kill' }, { kind: 'kill', tick: 'x', round: 1 }];
  sameRows(liveStatsIncremental(cursor, rows, oddOpts), liveStats(rows, oddOpts), 'odd rows');
  // A non-finite playhead folds nothing and starts no rounds.
  sameRows(
    liveStatsIncremental(cursor, SWEEP_EVENTS, sweepOpts('nope')),
    liveStats(SWEEP_EVENTS, sweepOpts('nope')),
    'non-finite playhead',
  );
  // steamIds is output-only: swapping it between calls must not stale the cursor.
  sameRows(
    liveStatsIncremental(cursor, SWEEP_EVENTS, sweepOpts(2500, { steamIds: ['A', 'Z'] })),
    liveStats(SWEEP_EVENTS, sweepOpts(2500, { steamIds: ['A', 'Z'] })),
    'steamIds swapped',
  );
  // A null cursor is the pure fold.
  sameRows(liveStatsIncremental(null, SWEEP_EVENTS, sweepOpts(2500)), liveStats(SWEEP_EVENTS, sweepOpts(2500)), 'null cursor');
});
