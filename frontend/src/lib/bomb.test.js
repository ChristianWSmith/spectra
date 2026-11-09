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
const roundStart = (tick, round = 8) => ({ kind: 'round_start', tick, round, x: null, y: null });

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

// --- the round_start terminator (the death-X fix's second cutoff) -----------
// Commit 5b21c4f gave the death markers a round_start terminator and
// 5dc0f93 made the X vanish AT it; the planted C4 had the same leak
// through its own missing terminator.

test('the NEXT round\'s start ends the marker — even with NO round_end loaded', () => {
  // The leak: a plant with no same-round round_end in the loaded rows
  // (truncated feed, or the round_end that PRECEDES the plant) used to
  // ride the 40 s fallback into the next round's frames.
  const p = plant(1000);
  assert.equal(bombEndTick(p, 64, [], [], [], [roundStart(1500)]), 1500);
  // The same rule beside a round_end: the EARLIER cutoff wins (the
  // round ends first here)…
  assert.equal(bombEndTick(p, 64, [], [], [roundEnd(1400)], [roundStart(1500)]), 1400);
  // …and a round_end AFTER the next round's start (a round stamped past
  // its own end) never wins over the earlier start.
  assert.equal(bombEndTick(p, 64, [], [], [roundEnd(1700)], [roundStart(1500)]), 1500);
});

test('a plant stamped AT/AFTER its own round_end dies with the next round_start', () => {
  // The golden-demo shape the death-X fix verified: the round's round_end
  // lands BEFORE the plant tick, so it is no terminator at all (the
  // "before the plant — ignored" rule) and only the next round's start
  // can clean the marker up.
  const late = plant(1600); // round_end at 1504 is before the plant
  assert.equal(
    bombEndTick(late, 64, [], [], [roundEnd(1504)], [roundStart(1700)]),
    1700,
  );
  // A plant stamped ON its round_end tick is terminated AT that very tick
  // (the marker still draws on the plant's own tick — the draw path's
  // `tick !== l.tick` — and is gone from the next tick on).
  const onEnd = plant(1504);
  assert.equal(bombEndTick(onEnd, 64, [], [], [roundEnd(1504)], [roundStart(1700)]), 1504);
});

test('round_start cutoffs respect the 40 s fallback ceiling', () => {
  const p = plant(1000);
  const ceiling = 1000 + 40 * 64;
  // A round start EARLIER than the fallback wins — it is a real cutoff.
  assert.equal(bombEndTick(p, 64, [], [], [], [roundStart(1200)]), 1200);
  // A round start BEYOND the fallback never LENGTHENS the window: the
  // 40 s C4 timer is the hard fallback, in both directions.
  assert.equal(bombEndTick(p, 64, [], [], [], [roundStart(4000)]), ceiling);
  // Same rule as the other terminator lists: starts at/before the plant
  // (the plant round's own start) are ignored.
  assert.equal(bombEndTick(p, 64, [], [], [], [roundStart(1000, 7), roundStart(900, 6)]), ceiling);
});

// --- the 40 s fallback vs REAL terminator rows ------------------------------
// The freeze-clock fix: every detonation in both dev matches records
// bomb_plant → bomb_explode at exactly 2624 ticks = 41 s — one second
// PAST plant + 40 s — so the fallback must never cap a PRESENT
// terminator row (only stand in when none is loaded).

test('a terminator BEYOND the 40 s fallback wins — the 41 s recorded plant→blast', () => {
  // Pre-fix this asserted the cap (plant + 40 s): `end` was truncated
  // before the real explosion, renderer detonatedAt's `e.tick === end`
  // gate never matched, and the HUD's 115 s round clock resurrected
  // during the round-over tail (nuke match 3 round 2: plant 14268,
  // explode 16892).
  const p = plant(1000);
  const boom = { kind: 'bomb_explode', tick: 1000 + 2624, round: 7 };
  const end = roundEnd(1000 + 2624, 7);
  assert.equal(bombEndTick(p, 64, [boom], [], [end]), 1000 + 2624);
  // The next round's start still only SHORTENS (never lengthens) — the
  // marker dies at the blast, not a tick past it.
  assert.equal(
    bombEndTick(p, 64, [boom], [], [end], [roundStart(1000 + 2624 + 64)]),
    1000 + 2624,
  );
  // …and with NO terminator rows loaded the 40 s fallback still bounds
  // the marker (the rule the cap used to enforce everywhere).
  assert.equal(bombEndTick(p, 64, [], [], []), 1000 + 40 * 64);
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
