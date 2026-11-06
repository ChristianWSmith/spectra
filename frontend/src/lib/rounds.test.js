// Tests for lib/rounds.js — the canonical round helpers: the
// counted-round predicate (the analytics CountedRounds twin),
// roundStartTick, the round-number → start-tick lookup behind every
// "jump to round N" link (nav.entrySeekTick, Replay's round ribbon),
// and scoreThrough (the scoreline-at-a-round aggregate).
// Run: node --test src/lib/rounds.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { isCounted, roundStartTick, roundIndexLabel, scoreThrough } from './rounds.js';

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
