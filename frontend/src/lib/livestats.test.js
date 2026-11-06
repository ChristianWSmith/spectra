// Node tests for lib/replay/livestats.js — the live K/D/A + ADR fold
// behind the player card's stats row. The rules mirror the canonical Go
// fold (internal/analytics/rounds.go PlayerRounds): counted rounds only,
// enemy-only kills (unknown side permissive), cross-team non-flash
// assists, every death, ALL damage (friendly fire included), ADR over the
// counted rounds STARTED at/before the playhead.
// Run: node --test src/lib/livestats.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { liveStats } from './replay/livestats.js';

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
