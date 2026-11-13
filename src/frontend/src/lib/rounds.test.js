// Tests for lib/rounds.js — the canonical round helpers: the
// round-number predicate (isCounted — today an identity over stored
// rows, the legacy guard over a pre-reprocess match's negative numbers),
// roundStartTick / roundEndTick, the round-number → start/end-tick
// lookups behind every "jump to round N" link (the watch/drill links'
// stamped ?tick=) and every round-span loop
// range (nav.entryLoopSpan, Replay's round ribbon),
// scoreThrough (the scoreline-at-a-round aggregate), separatorAfter
// (the round-ribbon separator cadence), separatorFlags (its gating over
// a rendered list), moneyResetIndexes (the money-reset cadence behind
// EconCurve's line gaps), the freeze window
// (freezeWindowAt — THE window the inFreezeTime predicate reports on and
// the replay engine's auto-skip jumps to) and seekTargetTick (the
// freeze-zero seek step behind the ±15 s transport when skip-freeze is
// armed).
// Run: node --test src/lib/rounds.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { isCounted, roundStartTick, roundEndTick, roundIndexLabel, scoreThrough, inFreezeTime, freezeWindowAt, freezeWindows, seekTargetTick, separatorAfter, separatorFlags, moneyResetIndexes } from './rounds.js';
import { flipIndexes } from './sideparity.js';

const ROUNDS = [
  { number: -2, startTick: 100 }, // knife
  { number: -1, startTick: 400 }, // warmup
  { number: 1, startTick: 1200 },
  { number: 7, startTick: 24500 },
];

// isCounted pins the ONE number rule (number >= 1): over stored rows it
// is an IDENTITY (the extractor discards knife/warmup rounds at ingest)
// — the negative rows here are the LEGACY shape a pre-reprocess match
// still delivers, and keeping them out of the cadence/score/stat math is
// the function's whole surviving job (the null/junk guards too).
test('isCounted: only positive-numbered rounds are counted play', () => {
  assert.equal(isCounted(ROUNDS[2]), true);
  assert.equal(isCounted(ROUNDS[0]), false); // knife
  assert.equal(isCounted(ROUNDS[1]), false); // warmup
  assert.equal(isCounted(null), false);
  assert.equal(isCounted(undefined), false);
});

// separatorAfter — the ONE ribbon separator cadence (… 11 12 | 13 … 23
// 24 | 25 26 27 | 28 29 30 | …): MR12 halftime after 12, regulation end
// after 24, then every 3 counted rounds (OT halves). The trailing-
// marker suppression and counted-gating over a VISIBLE list are
// separatorFlags' (below, same file); the DOM rendering of both is
// pinned in test/round-strip.dom.mjs and test/econ-tables.dom.mjs.
test('separatorAfter: after 12, then 24 and every 3 OT rounds', () => {
  for (const n of [12, 24, 27, 30, 33, 36, 45]) {
    assert.equal(separatorAfter(n), true, `round ${n} should separate`);
  }
});

test('separatorAfter: everything else does not separate', () => {
  // Just before each boundary, and the in-between OT rounds.
  for (const n of [11, 13, 15, 18, 21, 23, 25, 26, 28, 29, 31, 32, 34, 35]) {
    assert.equal(separatorAfter(n), false, `round ${n} should not separate`);
  }
  // Small numbers never separate.
  for (let n = 1; n <= 11; n++) {
    assert.equal(separatorAfter(n), false, `round ${n} should not separate`);
  }
  // Legacy knife/warmup negatives, round 0 and junk are never separators.
  assert.equal(separatorAfter(0), false);
  assert.equal(separatorAfter(-12), false);
  assert.equal(separatorAfter(-2), false);
  assert.equal(separatorAfter(null), false);
  assert.equal(separatorAfter(undefined), false);
  assert.equal(separatorAfter('x'), false);
  assert.equal(separatorAfter(NaN), false);
  // Numeric strings coerce (a route/query round param would).
  assert.equal(separatorAfter('24'), true);
  assert.equal(separatorAfter('13'), false);
});

// separatorFlags — the gating over a RENDERED list: index-aligned
// booleans, true where a separator follows that row. Characterized
// against the inline bookkeeping RoundStrip used to do (counted-only
// increment + trailing suppression), so the strip's markers and the
// tables' `.split-before` rows can never drift apart.
const countedRows = (n) => Array.from({ length: n }, (_, i) => ({ number: i + 1 }));

const flagAt = (flags, rows) =>
  rows.filter((_, i) => flags[i]).map((r) => r.number);

test('separatorFlags: cadence after 12 / 24 / every 3 OT rounds, index-aligned', () => {
  // 13 rows: only the boundary after 12 renders (24 not reached).
  assert.deepEqual(
    flagAt(separatorFlags(countedRows(13)), countedRows(13)),
    [12],
    '13 counted → separator after 12 only',
  );
  // 25 rows: after 12 and after 24.
  assert.deepEqual(flagAt(separatorFlags(countedRows(25)), countedRows(25)), [12, 24]);
  // 28 rows (golden nuke shape): 12, 24, 27 — no switch at OT start
  // does NOT affect the display cadence (see separatorAfter above).
  assert.deepEqual(flagAt(separatorFlags(countedRows(28)), countedRows(28)), [12, 24, 27]);
  // 34 rows: the every-3 cadence keeps going.
  assert.deepEqual(
    flagAt(separatorFlags(countedRows(34)), countedRows(34)),
    [12, 24, 27, 30, 33],
  );
  // The flags are index-aligned with the input list.
  const rows = countedRows(13);
  const flags = separatorFlags(rows);
  assert.equal(flags.length, rows.length);
  assert.equal(flags[11], true, 'index 11 = round 12'); // the boundary row
  assert.equal(flags[10], false);
  assert.equal(flags[12], false, 'the last row never flags');
});

test('separatorFlags: trailing suppression — a boundary on the LAST row never flags', () => {
  // A match ending exactly on 12/24/27/30/33 gets no dangling separator.
  for (const n of [12, 24, 27, 30, 33]) {
    const rows = countedRows(n);
    assert.ok(
      !flagAt(separatorFlags(rows), rows).includes(n),
      `round ${n} must not flag itself (it is the last row)`,
    );
  }
  assert.deepEqual(flagAt(separatorFlags(countedRows(24)), countedRows(24)), [12], '24 rows: after 24 suppressed');
  assert.deepEqual(flagAt(separatorFlags(countedRows(12)), countedRows(12)), [], '12 rows: halftime suppressed');
  assert.deepEqual(flagAt(separatorFlags(countedRows(30)), countedRows(30)), [12, 24, 27], '30 rows: after 30 suppressed');
  assert.deepEqual(flagAt(separatorFlags(countedRows(33)), countedRows(33)), [12, 24, 27, 30], '33 rows: after 33 suppressed');
});

test('separatorFlags: negative knife/warmup rows never flag nor shift a boundary', () => {
  // The LEGACY pre-reprocess shape (old imports only): three pre-match
  // rows (negatives) ahead of the counted rounds — every rendered row
  // now reaches separatorFlags (the visibility pref is dead), so this
  // gating is what keeps a legacy row from shifting a marker.
  const preMatch = [
    { number: -3 },
    { number: -2 },
    { number: -1 },
  ];
  const rows = [...preMatch, ...countedRows(13)];
  const flags = separatorFlags(rows);
  assert.equal(flags.length, 16);
  assert.deepEqual(flags.slice(0, 3), [false, false, false], 'negatives never flag');
  // Round 12 sits at index 14 — its flag must NOT have been pushed to 15.
  assert.equal(flags[14], true, 'round 12 still carries the boundary');
  assert.equal(flags[15], false);
  // Trailing suppression also sees through the negatives.
  const rows24 = [...preMatch, ...countedRows(24)];
  assert.deepEqual(
    flagAt(separatorFlags(rows24), rows24),
    [12],
    '24 counted + negatives: after 12 only, after 24 suppressed',
  );
  assert.deepEqual(
    flagAt(separatorFlags([...preMatch, ...countedRows(25)]), [...preMatch, ...countedRows(25)]),
    [12, 24],
  );
});

test('separatorFlags: empty, short and junk input degrade to no separators', () => {
  assert.deepEqual(separatorFlags([]), []);
  assert.deepEqual(separatorFlags(null), [], 'null list → []');
  assert.deepEqual(separatorFlags(undefined), []);
  assert.deepEqual(separatorFlags('x'), [], 'non-array → []');
  assert.deepEqual(separatorFlags(countedRows(11)), Array(11).fill(false), 'no boundary yet');
  assert.deepEqual(separatorFlags(countedRows(1)), [false]);
  // A round row with junk/missing fields is still not a separator.
  assert.deepEqual(separatorFlags([{ number: 12 }, { number: 13 }]), [false, false]);
  // The counted predicate reads `number` (the round number — a legacy
  // negative ingest index is what it guards) and NOTHING
  // else: a row keyed like models.EconomyRow (`round`) is never counted
  // here — callers project the shape first (Economy.svelte maps
  // { number: r.round } before calling), so a mis-keyed call degrades to
  // "no separators" instead of misplacing a boundary.
  assert.deepEqual(separatorFlags([{ round: 12 }, { round: 13 }]), [false, false]);
});

// moneyResetIndexes — where the game SETS cash again (round 13 → $800,
// every 3-round OT sub-half → $10,000), as counted-round indexes: 12,
// then 24, 27, 30, 33, …. The EconCurve breaks its lines on these
// boundaries only (money does not carry across them — CS2.md "Money
// resets"). The cadence delegates to separatorAfter, so these pins are
// the guard on BOTH sides of that identity.
test('moneyResetIndexes: the reset cadence 12, then 24 and every 3 OT rounds', () => {
  assert.deepEqual(moneyResetIndexes(13), [12], 'half 2 starts at index 12 (round 13)');
  assert.deepEqual(moneyResetIndexes(24), [12], 'no OT → the round-25 boundary is out of range');
  assert.deepEqual(moneyResetIndexes(25), [12, 24], 'first OT sub-half starts at index 24 (round 25)');
  assert.deepEqual(moneyResetIndexes(28), [12, 24, 27], 'golden nuke shape (round 28 = OT half 2)');
  assert.deepEqual(moneyResetIndexes(31), [12, 24, 27, 30]);
  assert.deepEqual(
    moneyResetIndexes(50),
    [12, 24, 27, 30, 33, 36, 39, 42, 45, 48],
    'large n keeps the every-3 cadence',
  );
});

test('moneyResetIndexes: no boundary inside regulation, exact-n boundaries dropped, junk → []', () => {
  // n = 12: the halftime boundary IS index 12, which a 12-row match
  // never reaches (the same (0, n) rule as flipIndexes).
  assert.deepEqual(moneyResetIndexes(12), []);
  assert.deepEqual(moneyResetIndexes(11), []);
  assert.deepEqual(moneyResetIndexes(1), []);
  assert.deepEqual(moneyResetIndexes(0), []);
  // Boundary at exactly n dropped for every cadence point (n = 24 → the
  // round-25 reset would be index 24 ≥ n).
  assert.deepEqual(moneyResetIndexes(24), [12]);
  assert.deepEqual(moneyResetIndexes(27), [12, 24], 'index 27 (round 28) needs n > 27');
  // Non-finite input coerces exactly like flipIndexes (never throws).
  assert.deepEqual(moneyResetIndexes(NaN), []);
  assert.deepEqual(moneyResetIndexes(-3), []);
  assert.deepEqual(moneyResetIndexes(undefined), []);
});

test('moneyResetIndexes: side switches are a strict subset of money resets', () => {
  // The structural fact EconCurve leans on: EVERY color-change boundary
  // is also a money gap (flips ⊆ resets), so a line never crosses a
  // color boundary and each money era lies wholly inside one side era.
  // Exhaustive over a grid of match shapes and switch counts — including
  // shapes where the switch has not happened yet (flipIndexes drops it,
  // the reset series does not care).
  for (const n of [1, 2, 5, 12, 13, 14, 23, 24, 25, 26, 27, 28, 29, 30, 31, 33, 34, 36, 40, 55, 100]) {
    for (const s of [0, 1, 2, 3, 4, 5, 12]) {
      const resets = new Set(moneyResetIndexes(n));
      for (const f of flipIndexes(n, s)) {
        assert.ok(resets.has(f), `flip ${f} missing from resets at n=${n}, switches=${s}`);
      }
      // And the series are not equal in general: the OT-start reset at
      // 24 has no side switch (no switch at OT start).
      if (n > 24) assert.ok(resets.has(24), `n=${n} must carry the round-25 reset`);
    }
  }
  // The one boundary that is a reset but never a flip.
  const resets28 = moneyResetIndexes(28);
  assert.ok(resets28.includes(24));
  assert.ok(!flipIndexes(28, 2).includes(24));
});

test('roundStartTick resolves a round number to its start tick', () => {
  assert.equal(roundStartTick(ROUNDS, 1), 1200);
  assert.equal(roundStartTick(ROUNDS, 7), 24500);
  // Negative-numbered rounds resolve too (knife/warmup are real rounds).
  assert.equal(roundStartTick(ROUNDS, -2), 100);
  // Numeric strings coerce — a <select> value or a route query param.
  assert.equal(roundStartTick(ROUNDS, '7'), 24500);
});

test('roundStartTick returns null instead of a guessed time', () => {
  assert.equal(roundStartTick(ROUNDS, 0), null); // round 0 never exists
  assert.equal(roundStartTick(ROUNDS, 12), null); // unknown round
  assert.equal(roundStartTick(ROUNDS, 'x'), null); // NaN round
  assert.equal(roundStartTick([], 1), null); // rounds not loaded
  assert.equal(roundStartTick(null, 1), null);
  assert.equal(roundStartTick([{ number: 3 }], 3), null); // no startTick
  assert.equal(roundStartTick([{ number: 3, startTick: NaN }], 3), null);
});

// roundEndTick is the closing twin: the second bound of a round-span
// link (nav.entryLoopSpan — RoundDetail's "Watch round", Combat's round
// chips and "Replay start" loop over the whole round, freeze included).
// Same never-a-guess contract.
const END_ROUNDS = [
  { number: -2, startTick: 100, endTick: 380 }, // knife
  { number: 1, startTick: 1200, endTick: 24000 },
  { number: 7, startTick: 24500, endTick: 30000 },
];

test('roundEndTick resolves a round number to its end tick', () => {
  assert.equal(roundEndTick(END_ROUNDS, 1), 24000);
  assert.equal(roundEndTick(END_ROUNDS, 7), 30000);
  // Negative-numbered rounds resolve too (knife/warmup are real rounds).
  assert.equal(roundEndTick(END_ROUNDS, -2), 380);
  // Numeric strings coerce — a <select> value or a route query param.
  assert.equal(roundEndTick(END_ROUNDS, '7'), 30000);
});

test('roundEndTick returns null instead of a guessed time', () => {
  assert.equal(roundEndTick(END_ROUNDS, 0), null); // round 0 never exists
  assert.equal(roundEndTick(END_ROUNDS, 12), null); // unknown round
  assert.equal(roundEndTick(END_ROUNDS, 'x'), null); // NaN round
  assert.equal(roundEndTick([], 1), null); // rounds not loaded
  assert.equal(roundEndTick(null, 1), null);
  assert.equal(roundEndTick([{ number: 3, startTick: 100 }], 3), null); // no endTick
  assert.equal(roundEndTick([{ number: 3, startTick: 100, endTick: NaN }], 3), null);
});

test('roundIndexLabel: counted rounds show their number', () => {
  assert.equal(roundIndexLabel(1), '1');
  assert.equal(roundIndexLabel(24), '24');
  assert.equal(roundIndexLabel({ number: 12 }), '12');
});

// BEHAVIOR RE-PIN, labeled (knife/warmup discard, Phase 3): roundIndexLabel
// used to prefer the row's pregame/warmup FLAGS when present — those
// fields died with the discard (no read ever delivers them again), so
// the NUMBER rule is the whole rule. The letters themselves stay as
// LEGACY tolerance: a pre-reprocess match still carries negative
// indices, and no surface may show a raw "-1".
test('roundIndexLabel: negative indices map to K/W letters', () => {
  // The old renumber shape: -3 warmup, -2 knife, -1 warmup (a second
  // warmup after the knife round).
  assert.equal(roundIndexLabel(-3), 'W');
  assert.equal(roundIndexLabel(-2), 'K');
  assert.equal(roundIndexLabel(-1), 'W');
  assert.equal(roundIndexLabel(-4), 'W'); // a fourth pre-match round
  // Row objects read their NUMBER (the flag branch is gone).
  assert.equal(roundIndexLabel({ number: -2 }), 'K');
  assert.equal(roundIndexLabel({ number: -1 }), 'W');
  assert.equal(roundIndexLabel({ number: -3 }), 'W');
  // Numeric strings coerce; junk renders empty (never "NaN").
  assert.equal(roundIndexLabel('-2'), 'K');
  assert.equal(roundIndexLabel('x'), '');
  assert.equal(roundIndexLabel(null), '');
});

// scoreThrough — the scoreline-at-a-round aggregate (RoundDetail's
// scoreline, Replay's HUD score). Characterized against the inline
// formula RoundDetail used before it moved here: cumulative counted
// wins with `number <= round`.
const SCORE_ROUNDS = [
  { number: -2, winner: 'ct' }, // knife — never counted
  { number: -1, winner: 't' }, // warmup — never counted
  { number: 1, winner: 'ct' },
  { number: 2, winner: 't' },
  { number: 3, winner: 'ct' },
  { number: 4, winner: '' }, // decided row with no winner — counts for nobody
];

test('scoreThrough: cumulative counted wins through the given round', () => {
  assert.deepEqual(scoreThrough(SCORE_ROUNDS, 4), { ct: 2, t: 1 });
  assert.deepEqual(scoreThrough(SCORE_ROUNDS, 3), { ct: 2, t: 1 });
  assert.deepEqual(scoreThrough(SCORE_ROUNDS, 2), { ct: 1, t: 1 });
  assert.deepEqual(scoreThrough(SCORE_ROUNDS, 1), { ct: 1, t: 0 });
  // Before every counted round (0, or a pre-match round's negative
  // number): 0-0 — knife/warmup wins never reach the scoreline.
  assert.deepEqual(scoreThrough(SCORE_ROUNDS, 0), { ct: 0, t: 0 });
  assert.deepEqual(scoreThrough(SCORE_ROUNDS, -1), { ct: 0, t: 0 });
});

test('scoreThrough: degrades to 0-0 instead of guessing', () => {
  assert.deepEqual(scoreThrough([], 5), { ct: 0, t: 0 });
  assert.deepEqual(scoreThrough(null, 5), { ct: 0, t: 0 });
  assert.deepEqual(scoreThrough(SCORE_ROUNDS, NaN), { ct: 0, t: 0 });
  assert.deepEqual(scoreThrough(SCORE_ROUNDS, 'x'), { ct: 0, t: 0 });
  // A numeric string coerces — a route query round param.
  assert.deepEqual(scoreThrough(SCORE_ROUNDS, '2'), { ct: 1, t: 1 });
});

test('inFreezeTime: true only inside a round with a usable freeze window', () => {
  const rounds = [
    { number: -2, startTick: 100, freezeEndTick: 100 }, // knife round: no window
    { number: -1, startTick: 200, freezeEndTick: 0 }, // warmup row ships 0
    { number: 1, startTick: 1000, freezeEndTick: 1160, endTick: 5000 },
  ];
  assert.equal(inFreezeTime(rounds, 999), false, 'before the round there is no freeze');
  assert.equal(inFreezeTime(rounds, 1000), true, 'round start is inside freeze');
  assert.equal(inFreezeTime(rounds, 1159), true);
  assert.equal(inFreezeTime(rounds, 1160), false, 'freeze END is exclusive — live play');
  assert.equal(inFreezeTime(rounds, 3000), false);
  assert.equal(inFreezeTime(rounds, 250), false, 'warmup fe=0 must never silence anything');
  assert.equal(inFreezeTime(rounds, 150), false, 'knife fe=start must not gate');
  assert.equal(inFreezeTime([], 100), false);
  assert.equal(inFreezeTime(null, 100), false);
  assert.equal(inFreezeTime(rounds, NaN), false);
});

test('inFreezeTime takes the round reaching tick regardless of row order', () => {
  const rounds = [
    { number: 1, startTick: 1000, freezeEndTick: 1160 },
    { number: 2, startTick: 5000, freezeEndTick: 5160 },
  ];
  assert.equal(inFreezeTime([...rounds].reverse(), 1050), true, 'shuffled rows still resolve');
  assert.equal(inFreezeTime([...rounds].reverse(), 5100), true);
});

// freezeWindowAt — THE freeze window {start, end} the inFreezeTime
// predicate reports on and the replay engine's auto-skip jumps to (its
// `end` is the exact tick playback resumes at). Same usable-window rule,
// half-open: start ≤ tick < freezeEndTick, null when the row cannot say.
const WINDOW_ROUNDS = [
  { number: -1, startTick: 200, freezeEndTick: 0 }, // warmup row ships fe = 0
  { number: 1, startTick: 1000, freezeEndTick: 1160, endTick: 5000 },
  { number: 2, startTick: 5000, freezeEndTick: 5160 },
];

test('freezeWindowAt: the window of the round whose freeze contains the tick', () => {
  assert.deepEqual(
    freezeWindowAt(WINDOW_ROUNDS, 1000),
    { start: 1000, end: 1160 },
    'tick == start is INSIDE (half-open)',
  );
  assert.deepEqual(freezeWindowAt(WINDOW_ROUNDS, 1159), { start: 1000, end: 1160 });
  assert.equal(freezeWindowAt(WINDOW_ROUNDS, 1160), null, 'tick == freezeEnd is OUT');
  assert.equal(freezeWindowAt(WINDOW_ROUNDS, 999), null, 'before the round there is no window');
  assert.equal(freezeWindowAt(WINDOW_ROUNDS, 3000), null, 'live play has no window');
  assert.deepEqual(
    freezeWindowAt(WINDOW_ROUNDS, 5050),
    { start: 5000, end: 5160 },
    'the round reaching the tick decides, any row order',
  );
  assert.equal(freezeWindowAt(WINDOW_ROUNDS, 250), null, 'warmup fe = 0 → no window');
  assert.equal(freezeWindowAt([], 100), null);
  assert.equal(freezeWindowAt(null, 100), null);
  assert.equal(freezeWindowAt(WINDOW_ROUNDS, NaN), null);
});

test('freezeWindowAt: a corrupt window (fe ≤ start) reports no window', () => {
  const rounds = [{ number: 1, startTick: 1000, freezeEndTick: 900 }];
  assert.equal(freezeWindowAt(rounds, 1050), null, 'never a guessed window');
  assert.equal(freezeWindowAt(rounds, 1000), null, 'start is inside only with a usable window');
});

test('inFreezeTime is exactly freezeWindowAt ≠ null (the two can never disagree)', () => {
  for (let tick = 0; tick <= 5300; tick += 50) {
    assert.equal(
      inFreezeTime(WINDOW_ROUNDS, tick),
      freezeWindowAt(WINDOW_ROUNDS, tick) !== null,
      `disagreement at tick ${tick}`,
    );
  }
});

// seekTargetTick — the ONE freeze-zero seek step (the ±15 s transport's
// arithmetic when skip-freeze is armed): freeze windows are 0-LENGTH
// for the budget, so the result never lands inside one and the
// playback snap can never fire right after the seek. WINDOW_ROUNDS
// (above): the warmup row ships fe = 0 (no window), round 1 is
// [1000, 1160), round 2 is [5000, 5160) — real-shaped, disjoint rows.
const TR = 64; // the match tick rate these pins speak
const S15 = 15 * TR; // the ±15 s budget in ticks (960)
const S1 = TR; // one second (64)

test('seekTargetTick: the owner example — from freezeEnd + 1s, −15s lands start − 14s, outside the freeze', () => {
  const w = { start: 1000, end: 1160 };
  const from = w.end + S1; // 1224 — one second of live play after the freeze
  const got = seekTargetTick(WINDOW_ROUNDS, from, -S15);
  assert.equal(
    got,
    w.start - 14 * S1,
    '1s of live play reaches fe, the freeze costs 0, the remaining 14s run below start',
  );
  assert.equal(freezeWindowAt(WINDOW_ROUNDS, got), null, 'the landing is outside every usable window');
  assert.ok(got < w.start, 'strictly below the window — never at/inside it');
});

test('seekTargetTick backward crosses TWO freezes at 0 cost (the budget counts live time only)', () => {
  // 6000 → below round 1: live 840 (down to round 2's fe) + 3840 (round
  // 2's start down to round 1's fe) + 100 = 4780. Plain wall-clock
  // arithmetic would land at 1120 — INSIDE round 1's freeze.
  const delta = -4880;
  assert.ok(
    freezeWindowAt(WINDOW_ROUNDS, 6000 + delta) !== null,
    'plain arithmetic would land inside [1000, 1160) — the old bug',
  );
  const got = seekTargetTick(WINDOW_ROUNDS, 6000, delta);
  assert.equal(got, 800, 'both freezes crossed free, 200 live ticks left below start');
  assert.equal(freezeWindowAt(WINDOW_ROUNDS, got), null, 'outside every window it crossed');
});

test('seekTargetTick backward: gap == rem stops exactly on the window END (half-open, safe)', () => {
  const from = 1224; // fe + 1s
  // Budget == the live gap exactly: the landing IS freezeEndTick —
  // outside, because the window is [start, end).
  assert.equal(seekTargetTick(WINDOW_ROUNDS, from, -S1), 1160, 'exact gap → the window END');
  assert.equal(freezeWindowAt(WINDOW_ROUNDS, 1160), null, 'freezeEnd is OUT (half-open)');
  // One tick less: stops strictly above the end, in live play.
  assert.equal(seekTargetTick(WINDOW_ROUNDS, from, -(S1 - 1)), 1161);
  // One tick more: the window crosses free and 1 tick remains below start.
  assert.equal(seekTargetTick(WINDOW_ROUNDS, from, -(S1 + 1)), 999, 'crossed at 0 cost, 1 tick left');
});

test('seekTargetTick backward from INSIDE a freeze spends the full budget below start', () => {
  const got = seekTargetTick(WINDOW_ROUNDS, 1100, -S15);
  assert.equal(got, 1000 - S15, 'the exit downward is free, the whole 15s runs below start');
  assert.equal(freezeWindowAt(WINDOW_ROUNDS, got), null);
});

test('seekTargetTick: empty/absent rounds and unusable rows degrade to plain from + delta', () => {
  for (const rounds of [[], null, undefined]) {
    assert.equal(seekTargetTick(rounds, 1000, -S15), 40, 'no windows → plain arithmetic');
    assert.equal(seekTargetTick(rounds, 1000, S15), 1960);
  }
  // A legacy row with no usable window (ships fe = 0)…
  const feZero = [{ number: -1, startTick: 200, freezeEndTick: 0 }];
  assert.equal(seekTargetTick(feZero, 1000, -S15), 40, 'an fe = 0 row is never a window');
  assert.equal(seekTargetTick(feZero, 1000, S15), 1960);
  // …and a corrupt row (fe ≤ start).
  const corrupt = [{ number: 1, startTick: 1000, freezeEndTick: 900 }];
  assert.equal(seekTargetTick(corrupt, 5000, -S15), 4040);
  assert.equal(seekTargetTick(corrupt, 1050, S15), 2010);
  // A zero seek never moves — not even out of the freeze it sits in.
  assert.equal(seekTargetTick(WINDOW_ROUNDS, 1100, 0), 1100);
});

test('seekTargetTick forward (+15): crosses the next freeze at 0 cost and lands outside it', () => {
  const got = seekTargetTick(WINDOW_ROUNDS, 4100, S15);
  assert.equal(
    got,
    5160 + (S15 - 900),
    '900 live ticks reach start, the freeze costs 0, the rest runs past fe',
  );
  assert.equal(got, 5220);
  assert.equal(freezeWindowAt(WINDOW_ROUNDS, got), null, 'never inside the crossed window');
  assert.ok(
    freezeWindowAt(WINDOW_ROUNDS, 4100 + S15) !== null,
    'plain arithmetic would land inside [5000, 5160) — the mirrored old bug',
  );
});

test('seekTargetTick forward: stopping short lands in live play; an exact gap lands on the END, never the START', () => {
  const short = seekTargetTick(WINDOW_ROUNDS, 0, S15);
  assert.equal(short, 960, 'stops 40 ticks short of round 1 start — live play');
  assert.ok(short < 1000, 'strictly before the window');
  assert.equal(freezeWindowAt(WINDOW_ROUNDS, short), null);
  // gap (1000 − 384 = 616) == budget: the freeze point is crossed at
  // 0 cost and the landing is its END — the START is inside (half-open).
  assert.equal(seekTargetTick(WINDOW_ROUNDS, 384, 616), 1160, 'exact gap → the window END');
  assert.equal(freezeWindowAt(WINDOW_ROUNDS, 1160), null);
  assert.equal(seekTargetTick(WINDOW_ROUNDS, 384, 615), 999, 'one less → strictly before start');
  assert.equal(seekTargetTick(WINDOW_ROUNDS, 384, 617), 1161, 'one more → one tick past the end');
});

test('seekTargetTick: an out-of-stream target is returned as-is (clamping is seekTick\'s job)', () => {
  assert.equal(seekTargetTick(WINDOW_ROUNDS, 100, -S15), 100 - S15, '−860, never clamped here');
  assert.equal(seekTargetTick(WINDOW_ROUNDS, 500, -100000), 500 - 100000);
  // Forward past round 2's freeze: the crossed 160 ticks cost 0, so the
  // result runs 160 FURTHER than plain arithmetic.
  assert.equal(seekTargetTick(WINDOW_ROUNDS, 4000, 1e9), 5160 + (1e9 - 1000));
});

test('seekTargetTick properties: never lands inside a usable window; backward never ON a window start', () => {
  const starts = new Set([1000, 5000]); // the usable window starts (warmup excluded)
  for (let from = 0; from <= 5300; from += 50) {
    for (const d of [1, 63, 64, 65, 300, 960, 1500, -1, -63, -64, -65, -300, -960, -1500]) {
      const got = seekTargetTick(WINDOW_ROUNDS, from, d);
      assert.equal(
        freezeWindowAt(WINDOW_ROUNDS, got),
        null,
        `from=${from} d=${d} landed inside a window at ${got}`,
      );
      if (d < 0) {
        assert.ok(!starts.has(got), `from=${from} d=${d} landed ON a window start at ${got}`);
      }
    }
  }
});

test('freezeWindows: the list form of the SAME usable-window predicate', () => {
  assert.deepEqual(
    freezeWindows(WINDOW_ROUNDS),
    [
      { start: 1000, end: 1160 },
      { start: 5000, end: 5160 },
    ],
    'warmup (fe = 0) excluded, ascending by start',
  );
  assert.deepEqual(freezeWindows([{ number: 1, startTick: 1000, freezeEndTick: 900 }]), [], 'corrupt fe ≤ start excluded');
  assert.deepEqual(freezeWindows(null), []);
  assert.deepEqual(freezeWindows(undefined), []);
});
