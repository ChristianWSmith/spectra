// Tests for lib/rounds.js — the canonical round helpers: the
// counted-round predicate (the analytics CountedRounds twin),
// roundStartTick / roundEndTick, the round-number → start/end-tick
// lookups behind every "jump to round N" link and every round-span loop
// range (nav.entrySeekTick, nav.entryLoopSpan, Replay's round ribbon),
// scoreThrough (the scoreline-at-a-round aggregate), separatorAfter
// (the round-ribbon separator cadence), and the freeze window
// (freezeWindowAt — THE window the inFreezeTime predicate reports on and
// the replay engine's auto-skip jumps to).
// Run: node --test src/lib/rounds.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { isCounted, roundStartTick, roundEndTick, roundIndexLabel, scoreThrough, inFreezeTime, freezeWindowAt, separatorAfter, separatorFlags } from './rounds.js';

const ROUNDS = [
  { number: -2, startTick: 100 }, // knife
  { number: -1, startTick: 400 }, // warmup
  { number: 1, startTick: 1200 },
  { number: 7, startTick: 24500 },
];

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
// pinned in test/round-strip.dom.mjs and test/economy.dom.mjs.
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
  // Knife/warmup negatives, round 0 and junk are never separators.
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
  // The Rounds-tab / RoundStrip pref-on shape: three pre-match rows
  // (negatives) ahead of the counted rounds.
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
  // The counted predicate reads `number` (extract's renumber) and NOTHING
  // else: a row keyed like models.EconomyRow (`round`) is never counted
  // here — callers project the shape first (Economy.svelte maps
  // { number: r.round } before calling), so a mis-keyed call degrades to
  // "no separators" instead of misplacing a boundary.
  assert.deepEqual(separatorFlags([{ round: 12 }, { round: 13 }]), [false, false]);
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
// link (nav.entryLoopSpan — "Watch round" / "Replay start" loop over the
// whole round, freeze included). Same never-a-guess contract.
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
  assert.equal(roundIndexLabel({ number: 12, warmup: false, pregame: false }), '12');
});

test('roundIndexLabel: negative indices map to K/W letters', () => {
  // The golden demo's shape: -3 warmup, -2 knife, -1 warmup (a second
  // warmup after the knife round).
  assert.equal(roundIndexLabel(-3), 'W');
  assert.equal(roundIndexLabel(-2), 'K');
  assert.equal(roundIndexLabel(-1), 'W');
  assert.equal(roundIndexLabel(-4), 'W'); // a fourth pre-match round
  // Rows decide from their flags when present.
  assert.equal(roundIndexLabel({ number: -2, pregame: true, warmup: false }), 'K');
  assert.equal(roundIndexLabel({ number: -1, pregame: false, warmup: true }), 'W');
  assert.equal(roundIndexLabel({ number: -3, pregame: false, warmup: true }), 'W');
  // Flagless rows fall back to the number rule.
  assert.equal(roundIndexLabel({ number: -2 }), 'K');
  assert.equal(roundIndexLabel({ number: -1 }), 'W');
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
