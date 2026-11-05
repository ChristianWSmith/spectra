// Tests for the canonical bomb lifecycle module (lib/replay/bomb.js):
// the planted-C4 visibility rule (round-end cleanup — item 13) and the
// dropped-C4 reconstruction rule (evidence → position at a tick).
// Run: node --test src/lib/bomb.test.js   (from frontend/; the lib test
// glob src/lib/*.test.js picks it up too).
import test from 'node:test';
import assert from 'node:assert/strict';

import { hasBombPos, bombEndTick, bombEvidenceAt } from './replay/bomb.js';

// Row factories — the normalized landmark-row shape (kind/round/tick
// plus x/y aliased from the stored positions; missing evidence = null).
const plant = (tick, round = 7, x = 100, y = 200) => ({ kind: 'bomb_plant', tick, round, x, y, z: 10 });
const drop = (tick, round = 7, x = 300, y = 400) => ({ kind: 'bomb_drop', tick, round, x, y, z: 12 });
const pickup = (tick, round = 7, x = 500, y = 600) => ({ kind: 'bomb_pickup', tick, round, x, y, z: 8 });
const roundEnd = (tick, round = 7) => ({ kind: 'round_end', tick, round, x: null, y: null });

// --- bombEndTick: planted-C4 visibility -------------------------------------

test('no terminator → the 40s C4 timer is the hard fallback', () => {
  const p = plant(1000);
  assert.equal(bombEndTick(p, 64, [], [], []), 1000 + 40 * 64);
});

test('a same-round detonation ends the marker (the original rule)', () => {
  const p = plant(1000);
  const boom = { kind: 'bomb_explode', tick: 1600, round: 7 };
  assert.equal(bombEndTick(p, 64, [boom], [], []), 1600);
});

test('ROUND END ends the marker — a round that resolves before the bomb does', () => {
  // The item-13 fix: defused / decided rounds used to keep the C4
  // marker up to the full 40s after the round was already over.
  const p = plant(1000);
  const defuse = { kind: 'bomb_defuse', tick: 1500, round: 7 };
  const end = roundEnd(1504);
  assert.equal(bombEndTick(p, 64, [], [defuse], [end]), 1500);
  // Even with no defuse/explode rows the round end alone cleans up.
  assert.equal(bombEndTick(p, 64, [], [], [end]), 1504);
});

test('terminators from ANOTHER round or before the plant are ignored', () => {
  const p = plant(1000);
  const otherRoundEnd = roundEnd(1200, 6);
  const earlierEnd = roundEnd(900, 7);
  const otherRoundBoom = { kind: 'bomb_explode', tick: 1300, round: 8 };
  assert.equal(
    bombEndTick(p, 64, [otherRoundBoom], [], [otherRoundEnd, earlierEnd]),
    1000 + 40 * 64,
  );
});

test('the EARLIEST same-round terminator wins', () => {
  const p = plant(1000);
  const boom = { kind: 'bomb_explode', tick: 2000, round: 7 };
  const defuse = { kind: 'bomb_defuse', tick: 1400, round: 7 };
  const end = roundEnd(1402);
  assert.equal(bombEndTick(p, 64, [boom], [defuse], [end]), 1400);
});

// --- bombEvidenceAt: the dropped-C4 reconstruction rule ----------------------

test('no drop evidence → unknown (carried from spawn / planted directly)', () => {
  assert.equal(bombEvidenceAt({}, 500), null);
  assert.equal(bombEvidenceAt({ drops: [], pickups: [], plants: [], roundEnds: [] }, 500), null);
});

test('live round + on the ground → the drop position (carrier evidence)', () => {
  const d = drop(1000);
  const ev = { drops: [d], pickups: [], plants: [], roundEnds: [] };
  const at = bombEvidenceAt(ev, 1500);
  assert.equal(at.state, 'dropped');
  assert.equal(at.x, 300);
  assert.equal(at.y, 400);
  assert.equal(at.row, d);
  // Not yet dropped at the drop tick's own frame boundary.
  assert.equal(bombEvidenceAt(ev, 999), null);
});

test('drop without stored position → unknown (never extrapolate)', () => {
  const d = { kind: 'bomb_drop', tick: 1000, round: 7, x: null, y: null, z: null };
  assert.equal(bombEvidenceAt({ drops: [d], pickups: [], plants: [], roundEnds: [] }, 1500), null);
});

test('a pickup at/after the drop and ≤ T → picked-up with the pickup position', () => {
  const d = drop(1000);
  const pk = pickup(1300);
  const ev = { drops: [d], pickups: [pk], plants: [], roundEnds: [] };
  const at = bombEvidenceAt(ev, 1500);
  assert.equal(at.state, 'picked-up');
  assert.equal(at.x, 500); // branch 1: the pickup's own evidence position
  assert.equal(at.row, pk);
  assert.equal(at.row.attacker, undefined); // carrier resolution is the consumer's job
  // The pickup is NOT yet reached → still dropped at the drop position.
  const before = bombEvidenceAt(ev, 1200);
  assert.equal(before.state, 'dropped');
  assert.equal(before.x, 300);
});

test('a plant after the drop and ≤ T → planted (the plant path owns drawing)', () => {
  const d = drop(1000);
  const p = plant(1400);
  const at = bombEvidenceAt({ drops: [d], pickups: [], plants: [p], roundEnds: [] }, 1500);
  assert.equal(at.state, 'planted');
  assert.equal(at.row, p);
});

test('round ends with the bomb still on the ground → unknown (the cleanup case)', () => {
  const d = drop(1000);
  const end = roundEnd(1800);
  const ev = { drops: [d], pickups: [], plants: [], roundEnds: [end] };
  assert.equal(bombEvidenceAt(ev, 1500).state, 'dropped'); // live at 1500
  assert.equal(bombEvidenceAt(ev, 1800), null); // at/after the round end
  assert.equal(bombEvidenceAt(ev, 2500), null); // and into the next round
});

test('a previous round’s drop is scoped out by its round_end; a foreign pickup never closes it', () => {
  const d = drop(1000, 6);
  const end = roundEnd(1200, 6);
  const ev = { drops: [d], pickups: [], plants: [], roundEnds: [end] };
  // T inside round 7 (after round 6 ended): out of scope → unknown.
  assert.equal(bombEvidenceAt(ev, 5000), null);
  // Even without a round_end row the pickup of the NEXT round (different
  // round) must not close this drop as 'picked-up'.
  const pkNext = pickup(4000, 7);
  const ev2 = { drops: [d], pickups: [pkNext], plants: [], roundEnds: [] };
  assert.equal(bombEvidenceAt(ev2, 5000).state, 'dropped');
});

test('the LAST drop ≤ T wins (drop → pickup → drop again)', () => {
  const d1 = drop(1000, 7, 10, 10);
  const pk = pickup(1200, 7, 20, 20);
  const d2 = drop(1400, 7, 30, 30);
  const ev = { drops: [d1, d2], pickups: [pk], plants: [], roundEnds: [] };
  const at = bombEvidenceAt(ev, 1600);
  assert.equal(at.state, 'dropped');
  assert.equal(at.row, d2);
  assert.equal(at.x, 30);
  // Before the second drop the pickup had already resolved d1.
  assert.equal(bombEvidenceAt(ev, 1300).state, 'picked-up');
});

test('terminators from another round do not close the drop', () => {
  const d = drop(1000, 7);
  const pkOther = pickup(1500, 8); // a next-round pickup, no round_end row
  const ev = { drops: [d], pickups: [pkOther], plants: [], roundEnds: [] };
  const at = bombEvidenceAt(ev, 1600);
  assert.equal(at.state, 'dropped'); // still round 7's ground bomb
  assert.equal(at.x, 300);
});

test('hasBombPos: finite x/y only', () => {
  assert.equal(hasBombPos({ x: 1, y: 2 }), true);
  assert.equal(hasBombPos({ x: null, y: 2 }), false);
  assert.equal(hasBombPos({ x: NaN, y: 2 }), false);
  assert.equal(hasBombPos(null), false);
});
