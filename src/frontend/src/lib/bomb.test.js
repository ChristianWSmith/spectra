// Tests for the canonical bomb lifecycle module (lib/replay/bomb.js):
// the planted-C4 visibility rule (round-end cleanup — item 13), the
// dropped-C4 reconstruction rule (evidence → position at a tick) and
// the plant/defuse ATTEMPT lifecycle (begin → completion | abort |
// round end — the one visibility rule behind the renderer's progress
// rings, plus the rings' fixed game DURATION: actionDurationTicks /
// actionProgressAt).
// Run: node --test src/lib/bomb.test.js   (from frontend/; the lib test
// glob src/lib/*.test.js picks it up too).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasBombPos,
  bombEndTick,
  bombEvidenceAt,
  ACTION_KINDS,
  actionIntervals,
  actionDurationTicks,
  actionProgressAt,
} from './replay/bomb.js';

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

test('a bomb dropped AFTER its round ended cuts at the next round_start (the post-round tail)', () => {
  // The golden round-2 shape: round 7's round_end (1800) PRECEDES the
  // drop (1900), so a round_end-only scan finds no terminator; the
  // canonical cut (roundcut.js roundCutTick) falls through to the next
  // round_start (2200) instead of anchoring the frame forever.
  const d = drop(1900);
  const ev = {
    drops: [d],
    pickups: [],
    plants: [],
    roundEnds: [roundEnd(1800)],
    roundStarts: [roundStart(2200)],
  };
  assert.equal(bombEvidenceAt(ev, 2100).state, 'dropped', 'the round-over tail: the bomb really is on the ground');
  assert.equal(bombEvidenceAt(ev, 2200), null, 'gone AT the next round_start');
  assert.equal(bombEvidenceAt(ev, 2500), null, '…and for the rest of the replay');
  // Backward scrub re-derives — pure, nothing sticky.
  assert.equal(bombEvidenceAt(ev, 2100).state, 'dropped', 'a backwards scrub re-derives it');
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

// --- actionIntervals / actionProgressAt: the plant/defuse ATTEMPT lifecycle --

// Lifecycle row factories (the normalized landmark shape: kind, round,
// tick, attacker — normalizeEvent blanks `steamId` on the COMPLETED
// bomb-entity rows but keeps `attacker`, which is what ties the attempt
// to the dot its ring surrounds).
const pBegin = (tick, round = 7, attacker = '1') => ({ kind: 'bomb_plant_begin', tick, round, attacker });
const pAbort = (tick, round = 7, attacker = '1') => ({ kind: 'bomb_plant_abort', tick, round, attacker });
const planted = (tick, round = 7, attacker = '1') => ({ kind: 'bomb_plant', tick, round, attacker });
const dStart = (tick, round = 7, attacker = '2') => ({ kind: 'bomb_defuse_start', tick, round, attacker });
const dAbort = (tick, round = 7, attacker = '2') => ({ kind: 'bomb_defuse_abort', tick, round, attacker });
const defused = (tick, round = 7, attacker = '2') => ({ kind: 'bomb_defuse', tick, round, attacker });

test('ACTION_KINDS is the one begin/complete/abort kind taxonomy', () => {
  assert.deepEqual(ACTION_KINDS, {
    plant: { begin: 'bomb_plant_begin', complete: 'bomb_plant', abort: 'bomb_plant_abort' },
    defuse: { begin: 'bomb_defuse_start', complete: 'bomb_defuse', abort: 'bomb_defuse_abort' },
  });
});

test('actionIntervals: a begin closes at its COMPLETION (the golden shape)', () => {
  // Every plant on the golden pool is begin → +200 ticks → bomb_plant.
  const ivs = actionIntervals([pBegin(100), planted(300)]);
  assert.equal(ivs.length, 1);
  assert.deepEqual({ ...ivs[0] }, {
    action: 'plant', start: 100, end: 300, closedBy: 'complete', steamId: '1', round: 7,
  });
  // …and the defuse family closes the same way (10 s / 5 s rows).
  const d = actionIntervals([dStart(1000), defused(1640)]);
  assert.equal(d.length, 1);
  assert.equal(d[0].action, 'defuse');
  assert.equal(d[0].end, 1640);
  assert.equal(d[0].closedBy, 'complete');
});

test('actionIntervals: an ABORT closes the attempt (cancels are direct)', () => {
  const ivs = actionIntervals([pBegin(100), pAbort(112)]);
  assert.equal(ivs.length, 1);
  assert.equal(ivs[0].closedBy, 'abort');
  assert.equal(ivs[0].end, 112);
  const d = actionIntervals([dStart(500), dAbort(515)]);
  assert.equal(d[0].closedBy, 'abort');
  assert.equal(d[0].end, 515);
});

test('actionIntervals: a COMPLETION overrides any cancel in the window', () => {
  // The spec's precedence — completion always wins, whatever the cancel
  // detection says (defensive: the golden pool never sees both).
  const ivs = actionIntervals([pBegin(100), pAbort(150), planted(300)]);
  assert.equal(ivs.length, 1);
  assert.equal(ivs[0].closedBy, 'complete');
  assert.equal(ivs[0].end, 300);
  // …and an abort AFTER the completion is not this attempt's close.
  const after = actionIntervals([pBegin(100), planted(300), pAbort(400)]);
  assert.equal(after[0].end, 300);
  assert.equal(after[0].closedBy, 'complete');
});

test('actionIntervals: the window ends at the NEXT begin of the same action', () => {
  // A second attempt owns everything after its own begin: the first
  // attempt never closed, so it is bounded by the next begin (not by
  // the round end that comes later).
  const ivs = actionIntervals([
    pBegin(100), pBegin(400), planted(600), roundEnd(800), roundStart(900),
  ]);
  assert.equal(ivs.length, 2);
  assert.deepEqual(
    [ivs[0].start, ivs[0].end, ivs[0].closedBy],
    [100, 400, 'next-begin'],
  );
  assert.deepEqual(
    [ivs[1].start, ivs[1].end, ivs[1].closedBy],
    [400, 600, 'complete'],
  );
  // A defuse attempt between two plant attempts never bounds a plant
  // (and, with no close and no round rows, is dropped itself).
  const mixed = actionIntervals([pBegin(100), dStart(200), planted(300)]);
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].action, 'plant');
  assert.equal(mixed[0].end, 300);
});

test('actionIntervals: an attempt with no close falls back to its round end', () => {
  // The one golden-pool shape that emits neither an abort nor a
  // completion (de_ancient 80055): the attempt must stop at the round,
  // never ring forever and never invent a duration.
  const ivs = actionIntervals([pBegin(100), roundEnd(1500), roundStart(1600)]);
  assert.equal(ivs.length, 1);
  assert.equal(ivs[0].closedBy, 'round');
  assert.equal(ivs[0].end, 1500);
  // The NEXT round's start is the fallback when its round_end is not
  // loaded (the same evidence bombEndTick/killEndTick consume).
  const noEnd = actionIntervals([pBegin(100), roundStart(1600)]);
  assert.equal(noEnd[0].end, 1600);
  // Another round's round_end never closes this attempt.
  const other = actionIntervals([pBegin(100, 7), roundEnd(500, 6)]);
  assert.deepEqual(other, []);
  // With NO round rows loaded at all the attempt is DROPPED: no
  // evidence → no interval, never a guessed duration.
  assert.deepEqual(actionIntervals([pBegin(100)]), []);
});

test('actionIntervals: another player’s close never closes the attempt', () => {
  // A defuser's abort must not terminate a planter's attempt even
  // though both are 'close' rows of the same window.
  const ivs = actionIntervals([pBegin(100, 7, '1'), dAbort(150, 7, '2'), roundEnd(1500)]);
  assert.equal(ivs.length, 1);
  assert.equal(ivs[0].closedBy, 'round');
  // An ABSENT actor never vetoes (the same rule as sameUtilityWeapon).
  const unknown = actionIntervals([pBegin(100, 7, '1'), planted(300, 7, '')]);
  assert.equal(unknown[0].closedBy, 'complete');
  // The interval's actor comes from the BEGIN row — the completed
  // plant's blank steamId must not lose the dot it rings.
  assert.equal(unknown[0].steamId, '1');
});

test('actionIntervals: only real attempts — junk, zero spans and foreign rows', () => {
  // Unrelated rows make no intervals at all.
  assert.deepEqual(actionIntervals([]), []);
  assert.deepEqual(actionIntervals(null), []);
  assert.deepEqual(
    actionIntervals([
      { kind: 'kill', tick: 10, round: 1 },
      { kind: 'grenade', tick: 20, round: 1 },
      { kind: 'bomb_explode', tick: 30, round: 1 },
      { kind: 'round_end', tick: 40, round: 1 },
    ]),
    [],
  );
  // A close on the begin's OWN tick is a zero span — dropped (progress
  // would be undefined), never a NaN interval.
  assert.deepEqual(actionIntervals([pBegin(100), pAbort(100), roundEnd(1500)]), []);
  // A completion without any begin is not an attempt (0 on the pool).
  assert.deepEqual(actionIntervals([planted(300), roundEnd(1500)]), []);
  // Rows with a non-finite tick are ignored.
  assert.deepEqual(actionIntervals([pBegin(NaN), roundEnd(1500)]), []);
});

test('actionDurationTicks: the fixed game durations (THE ring denominator)', () => {
  // CS2.md "Plant / defuse durations": plant 3.125 s = 200 ticks @64;
  // defuse 640 (10 s) / 320 (5 s with a kit).
  assert.equal(actionDurationTicks('plant', false, 64), 200);
  assert.equal(actionDurationTicks('plant', true, 64), 200); // a kit never moves the plant
  assert.equal(actionDurationTicks('defuse', false, 64), 640);
  assert.equal(actionDurationTicks('defuse', true, 64), 320);
  // Kit is TRI-STATE (kits.js hasKitAt): only an answered `true` buys
  // the 5 s denominator — false, null (unanswerable) and junk all read
  // as NO kit, the conservative side (a fake must never fill fast).
  assert.equal(actionDurationTicks('defuse', null, 64), 640);
  assert.equal(actionDurationTicks('defuse', 'junk', 64), 640);
  // An invalid tickRate reads as 64 (the killEndTick rule); a real one
  // scales the durations.
  assert.equal(actionDurationTicks('defuse', true, 0), 320);
  assert.equal(actionDurationTicks('defuse', false, 128), 1280);
  assert.equal(actionDurationTicks('plant', false, 128), 400);
  // Unknown family → no duration → no ring, never a guessed one.
  assert.equal(actionDurationTicks('c4', false, 64), null);
});

test('actionProgressAt: elapsed / fixed game duration, null outside the window', () => {
  // THE formula pin (it replaced the old (tick − start)/(end − start)
  // pin): progress = (tick − start) / actionDurationTicks(...), clamped
  // ≤ 1. The interval's [start, end) span bounds VISIBILITY only —
  // never the denominator (dividing by it was the fake-defuse bug: a
  // 15-tick tap span raced the arc to ~1.0).
  //
  // A completed 10 s NO-KIT defuse: 640-tick span == 640-tick duration.
  const [iv] = actionIntervals([dStart(1000), defused(1640)]);
  assert.equal(actionProgressAt(iv, 1000, 640), null); // the begin tick draws nothing
  assert.equal(actionProgressAt(iv, 1320, 640), 0.5); // 5 s elapsed → exactly half a turn
  assert.equal(actionProgressAt(iv, 1639, 640), 639 / 640);
  assert.equal(actionProgressAt(iv, 1640, 640), null); // over AT the completion
  assert.equal(actionProgressAt(iv, 999, 640), null); // before the begin
  assert.equal(actionProgressAt(iv, 5000, 640), null); // long after
  // Monotonic inside the window — a scrub replays the same phase.
  let prev = 0;
  for (let t = 1001; t < 1640; t++) {
    const p = actionProgressAt(iv, t, 640);
    assert.ok(p > prev, `progress at ${t} (${p}) must grow past ${prev}`);
    prev = p;
  }
  // A COMPLETED attempt's span EQUALS its duration (200 = 3.125 s @64),
  // so a finished plant reads the numbers the old span pin had — the
  // fix changes nothing where the old formula was accidentally right.
  const [plantIv] = actionIntervals([pBegin(100), planted(300)]);
  assert.equal(actionProgressAt(plantIv, 200, 200), 0.5);
  assert.equal(actionProgressAt(plantIv, 299, 200), 0.995);

  // FAKE (tapped) defuse — THE bug pin: begin 500 → abort 515 (15
  // ticks). The old span denominator read (507−500)/(515−500) = 7/15 ≈
  // 0.47 and ~0.93 at the last visible tick — a tap looked nearly done.
  // The fixed 10 s denominator gives 7/640 ≈ 0.011: brief, and not far.
  const [fake] = actionIntervals([dStart(500), dAbort(515)]);
  assert.equal(fake.closedBy, 'abort');
  assert.equal(actionProgressAt(fake, 507, 640), 7 / 640); // ≈ 0.0109
  assert.ok(actionProgressAt(fake, 507, 640) < 0.02, 'a tick into the tap is barely on');
  assert.equal(actionProgressAt(fake, 514, 640), 14 / 640); // ≈ 0.022 at the last visible tick
  assert.equal(actionProgressAt(fake, 515, 640), null); // gone AT the abort
  // Kit variant: the same tap against the 5 s denominator — a sliver.
  assert.equal(actionProgressAt(fake, 507, 320), 7 / 320); // ≈ 0.022

  // A TAPPED plant (begin 100 → abort 115, 15 ticks — the plant ring
  // had the identical shape): the last visible tick is 14/200 = 0.07 of
  // a turn, and the whole tap could never exceed 15/200 = 0.075 (the
  // old formula read 14/15 ≈ 0.93 there).
  const [tap] = actionIntervals([pBegin(100), pAbort(115)]);
  assert.equal(tap.closedBy, 'abort');
  assert.equal(actionProgressAt(tap, 114, 200), 14 / 200); // 0.07
  assert.ok(actionProgressAt(tap, 114, 200) < 15 / 200, 'never past 15/200 across the whole tap');
  assert.equal(actionProgressAt(tap, 115, 200), null); // gone AT the abort

  // CLAMP: an attempt that outlives its duration (the round-end
  // fallback window) holds a FULL circle — exactly 1.0, never > 1 and
  // never wrapping past 2π (drawActionRing's arc math).
  const [long] = actionIntervals([pBegin(100), roundEnd(1500), roundStart(1600)]);
  assert.equal(long.closedBy, 'round');
  assert.equal(actionProgressAt(long, 300, 200), 1); // 200 ticks elapsed → full
  assert.equal(actionProgressAt(long, 1000, 200), 1); // …and it HOLDS, not wraps
  assert.equal(actionProgressAt(long, 1499, 200), 1);
  assert.equal(actionProgressAt(long, 1500, 200), null); // gone AT the round end

  // Hostile input never produces a number (boundaries unchanged).
  assert.equal(actionProgressAt(null, 150, 640), null);
  assert.equal(actionProgressAt(iv, NaN, 640), null);
  assert.equal(actionProgressAt({ start: 200, end: 100 }, 150, 640), null);
  assert.equal(actionProgressAt({ start: 100, end: 100 }, 150, 640), null);
  // …and a missing/invalid DURATION draws nothing — never a fallback to
  // the observed span (that fallback IS the bug this replaced).
  assert.equal(actionProgressAt(iv, 1320), null);
  assert.equal(actionProgressAt(iv, 1320, undefined), null);
  assert.equal(actionProgressAt(iv, 1320, 0), null);
  assert.equal(actionProgressAt(iv, 1320, -640), null);
  assert.equal(actionProgressAt(iv, 1320, NaN), null);
});
