// Tests for the canonical dropped-gun/util evidence module
// (lib/replay/drops.js): THE ground-drop reconstruction rule — position
// evidence, pickup termination, round-end cleanup (the death-marker /
// dropped-C4 parity), duplicate-name best-evidence matching and the
// missing-position never-guess rule.
// Run: node --test src/lib/drops.test.js   (from frontend/; the lib test
// glob src/lib/*.test.js picks it up too).
import test from 'node:test';
import assert from 'node:assert/strict';

import { hasDropPos, dropEvidenceAt } from './replay/drops.js';

// Row factories — the normalized landmark-row shape (kind/round/tick/
// weapon plus x/y aliased from the stored positions; missing evidence
// = null).
const wdrop = (tick, weapon = 'AK-47', round = 7, x = 300, y = 400) => ({
  kind: 'weapon_drop',
  tick,
  round,
  weapon,
  x,
  y,
  z: 12,
});
const wpickup = (tick, weapon = 'AK-47', round = 7, x = 500, y = 600) => ({
  kind: 'weapon_pickup',
  tick,
  round,
  weapon,
  x,
  y,
  z: 8,
});
const roundEnd = (tick, round = 7) => ({ kind: 'round_end', tick, round, x: null, y: null });

const bundle = (over = {}) => ({ drops: [], pickups: [], roundEnds: [], ...over });

// --- position evidence -------------------------------------------------------

test('nothing dropped at/before T → null', () => {
  assert.equal(dropEvidenceAt(bundle(), 1000), null);
  // A drop strictly AFTER T never anchors the frame (scrub before it).
  assert.equal(dropEvidenceAt(bundle({ drops: [wdrop(1000)] }), 999), null);
});

test('a drop without a stored position draws nothing — never extrapolated', () => {
  // The zero-vector convention (extract posPtrs → null x/y): the row
  // exists but there is nowhere honest to draw it.
  const noPos = { kind: 'weapon_drop', tick: 100, round: 7, weapon: 'AK-47', x: null, y: null };
  assert.equal(dropEvidenceAt(bundle({ drops: [noPos] }), 500), null);
  assert.equal(hasDropPos(noPos), false);
  // …while the stored position wins as soon as it exists.
  const pos = wdrop(100);
  assert.equal(hasDropPos(pos), true);
  const ev = dropEvidenceAt(bundle({ drops: [pos] }), 500);
  assert.ok(ev && ev.state === 'dropped');
  assert.equal(ev.x, 300);
  assert.equal(ev.y, 400);
  assert.equal(ev.z, 12, 'z rides along for the elevation indicator');
  assert.equal(ev.row, pos, 'the row rides along (weapon/cat/ammo for the renderer)');
});

// --- pickup termination ------------------------------------------------------

test('a same-name pickup after the drop and ≤ T hides it', () => {
  const d = wdrop(100);
  const ev = { drops: [d], pickups: [wpickup(400)], roundEnds: [] };
  assert.ok(dropEvidenceAt(ev, 399), 'on the ground until the pickup');
  assert.equal(dropEvidenceAt(ev, 400), null, 'gone AT the pickup tick');
  assert.equal(dropEvidenceAt(ev, 900), null, 'still gone later in the round');
});

test('the pickup must be AFTER the drop and at/before T', () => {
  const d = wdrop(500);
  // A pickup BEFORE the drop (a restock earlier in the round) cannot
  // terminate a drop that happened later.
  assert.ok(dropEvidenceAt({ drops: [d], pickups: [wpickup(400)], roundEnds: [] }, 900));
  // A pickup strictly AFTER T is future evidence — still on the ground now.
  assert.ok(dropEvidenceAt({ drops: [d], pickups: [wpickup(600)], roundEnds: [] }, 550));
});

test('only the SAME weapon name and round terminates', () => {
  const d = wdrop(100, 'AK-47');
  // Different gun picked up — this drop is untouched.
  assert.ok(dropEvidenceAt({ drops: [d], pickups: [wpickup(400, 'AWP')], roundEnds: [] }, 900));
  // Same name, ANOTHER round — never cross-round matching.
  assert.ok(dropEvidenceAt({ drops: [d], pickups: [wpickup(400, 'AK-47', 8)], roundEnds: [] }, 900));
});

// --- round scoping (the round-end cleanup parity) ----------------------------

test('the drop vanishes AT its round end — death-marker cleanup parity', () => {
  const ev = { drops: [wdrop(100)], pickups: [], roundEnds: [roundEnd(1500)] };
  assert.ok(dropEvidenceAt(ev, 1499), 'on the ground inside the round');
  assert.equal(dropEvidenceAt(ev, 1500), null, 'gone AT the round_end tick');
  // Back into the round on a reverse scrub: re-derived, nothing sticky.
  assert.ok(dropEvidenceAt(ev, 1400));
});

test('a round_end BEFORE the drop is no terminator, another round stays out', () => {
  const ev = {
    drops: [wdrop(1600)], // stamped after this round's round_end (the C4-tail shape)
    pickups: [],
    roundEnds: [roundEnd(1500), roundEnd(1400, 6)],
  };
  assert.ok(dropEvidenceAt(ev, 1700), 'the earlier round_end cannot kill a later drop');
});

// --- duplicate-name best-evidence matching -----------------------------------

test('duplicates: the marker follows the LAST drop at/before T', () => {
  const first = wdrop(100, 'AK-47');
  const second = wdrop(800, 'AK-47', 7, 900, 950);
  const ev = { drops: [first, second], pickups: [], roundEnds: [] };
  assert.equal(dropEvidenceAt(ev, 500).row, first, 'before the second death: the first AK');
  assert.equal(dropEvidenceAt(ev, 800).row, second, 'from the second death on: the newer AK');
  assert.equal(dropEvidenceAt(ev, 800).x, 900, 'at the newer drop position');
});

test('duplicates: one same-name pickup kills the EARLIER drop only', () => {
  // The documented best-evidence rule: the pickup hides the drop the
  // marker is currently on (the latest at/before T); a drop AFTER the
  // pickup is untouched by it.
  const first = wdrop(100);
  const pickup = wpickup(400);
  const second = wdrop(800, 'AK-47', 7, 900, 950);
  const ev = { drops: [first, second], pickups: [pickup], roundEnds: [] };
  assert.equal(dropEvidenceAt(ev, 399).row, first, 'first still on the ground pre-pickup');
  assert.equal(dropEvidenceAt(ev, 500), null, 'pickup consumed the visible (first) drop');
  assert.equal(dropEvidenceAt(ev, 800).row, second, 'a NEW drop after the pickup shows again');
});

test('the renderer call shape: one row per query — every live drop answers', () => {
  // drawDrops iterates the 'wdrop' rows and queries EACH as the
  // bundle's only drops entry (each dropped item is its own marker —
  // unlike the single C4). Both same-name drops coexist on the map
  // while neither was picked up.
  const first = wdrop(100);
  const second = wdrop(800, 'AK-47', 7, 900, 950);
  const roundEnds = [roundEnd(1500)];
  const q = (row, pickups, tick) =>
    dropEvidenceAt({ drops: [row], pickups, roundEnds }, tick);
  assert.ok(q(first, [], 500), 'the first drop is on the ground at 500');
  assert.ok(q(second, [], 900), 'the second drop is on the ground at 900');
  assert.ok(q(first, [], 900), '…and the FIRST one is still lying there too');
  // Round-end cleanup applies to every row independently.
  assert.equal(q(first, [], 1500), null, 'gone AT the round_end tick');
  assert.equal(q(second, [], 1500), null);
  // A pickup hides exactly the rows it postdates; a later drop survives.
  const pickups = [wpickup(400)];
  assert.equal(q(first, pickups, 500), null, 'pickup after the first drop hides it');
  assert.ok(q(second, pickups, 900), 'the pickup predates the second drop — it stays');
  // Before its own tick a later drop draws nothing.
  assert.equal(q(second, [], 700), null);
});
