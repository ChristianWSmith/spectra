// Tests for the canonical defuse-kit evidence module
// (lib/replay/kits.js): the nearest-death disambiguation, the buytime
// buy/ground split, the [from,to) visibility window, the never-guess
// rules (no position → never drawn, never claimed) and the round-scoped
// hasKitAt possession rule.
// Run: node --test src/lib/kits.test.js   (from frontend/; the lib test
// glob src/lib/*.test.js picks it up too).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KIT_WEAPON,
  KIT_MATCH_MAX,
  LAMBDA,
  buildKitEvidence,
  buyEndsFromRows,
  kitVisibleAt,
  kitWindow,
} from './replay/kits.js';

// Row factories — the normalized landmark-row shape (kind/round/tick/
// weapon/steamId plus x/y aliased from the stored positions; a missing
// position is null, extract's zero-vector convention).
const kdrop = (tick, x, y, over = {}) => ({
  kind: 'weapon_drop',
  dropCat: 'kit',
  weapon: KIT_WEAPON,
  tick,
  round: 7,
  steamId: 'CT_DROP',
  x,
  y,
  z: 0,
  ...over,
});
const kpickup = (tick, x, y, over = {}) => ({
  kind: 'weapon_pickup',
  weapon: KIT_WEAPON,
  tick,
  round: 7,
  steamId: 'CT_PICK',
  x,
  y,
  z: 0,
  ...over,
});
const roundEnd = (tick, round = 7) => ({ kind: 'round_end', tick, round, x: null, y: null });
const roundStart = (tick, round = 7) => ({ kind: 'round_start', tick, round, x: null, y: null });

const TR = 64; // golden's tick rate — the score's seconds term divisor
const build = (rows, buyEnds = new Map(), tickRate = TR) =>
  buildKitEvidence(rows, buyEnds, tickRate);

// --- constants (the AGENTS formula rule: pinned where they live) ----------

test('constants are pinned', () => {
  assert.equal(KIT_WEAPON, 'Defuse Kit', 'the canonical kit spelling (models.DefuseKitName twin)');
  assert.equal(LAMBDA, 5, 'LAMBDA is 5 world-units per SECOND of delay');
  assert.equal(KIT_MATCH_MAX, 4096, 'KIT_MATCH_MAX is 4096 world-units');
});

// --- bucketing -------------------------------------------------------------

test('only kit rows bucket: gun drops and non-kit pickups are ignored', () => {
  const gun = kdrop(1000, 0, 0, { dropCat: 'gun', weapon: 'AK-47' });
  const util = kdrop(1100, 0, 0, { dropCat: 'util', weapon: 'Smoke Grenade' });
  const unstamped = kdrop(1200, 0, 0, { dropCat: undefined }); // side channel failed
  const otherPickup = kpickup(6000, 0, 0, { weapon: 'AK-47' });
  const kit = kdrop(1300, 10, 10);
  const rows = [
    roundStart(0),
    gun,
    util,
    unstamped,
    kit,
    otherPickup,
    kpickup(6000, 10, 10),
    roundEnd(9000),
  ];
  const { drops } = build(rows);
  assert.equal(drops.size, 1, 'exactly the one cat:"kit" drop buckets');
  assert.ok(drops.has(kit));
});

// --- nearest-death disambiguation -----------------------------------------

test('nearest death claims the pickup; the farther one stays to round end', () => {
  const near = kdrop(4800, 100, 0, { steamId: 'CT_NEAR' });
  const far = kdrop(4600, 0, 0, { steamId: 'CT_FAR' });
  // The picker stands ON the nearer body (dist 10 vs dist 90).
  const pickup = kpickup(5000, 90, 0);
  const end = roundEnd(9000);
  const { drops } = build([roundStart(0), far, near, pickup, end]);

  assert.ok(
    Math.hypot(near.x - pickup.x, near.y - pickup.y) <
      Math.hypot(far.x - pickup.x, far.y - pickup.y),
    'the winner IS the nearer death',
  );
  assert.equal(drops.get(near).to, 5000, 'the NEAREST death ends at the pickup tick');
  assert.equal(drops.get(far).to, 9000, 'the farther death was never picked up → round end');
  assert.equal(drops.get(near).from, 4800, 'from = the death tick');
});

test('LAMBDA breaks the tie: an older-NEAR death loses to a newer-FAR one', () => {
  // dOld is strictly NEARER (100 vs 300 wu) but 140 s older; with the
  // time term (5 wu/s) its score (100 + 703) loses to the newer one's
  // (300 + 78). Distance alone would pick dOld — only LAMBDA flips it.
  const old = kdrop(1000, 100, 0, { steamId: 'CT_OLD' });
  const fresh = kdrop(9000, 300, 0, { steamId: 'CT_FRESH' });
  const pickup = kpickup(10000, 0, 0);
  const end = roundEnd(20000);
  const { drops } = build([roundStart(0), old, fresh, pickup, end]);

  assert.ok(
    Math.hypot(old.x - pickup.x, old.y - pickup.y) <
      Math.hypot(fresh.x - pickup.x, fresh.y - pickup.y),
    'the loser IS the nearer drop — only the time term explains the win',
  );
  assert.equal(drops.get(fresh).to, 10000, 'the newer death claims the pickup');
  assert.equal(drops.get(old).to, 20000, 'the older near death stays to round end');
});

test('distance still dominates when the gap is large (LAMBDA is a tie-breaker)', () => {
  // dNear is 10 wu away but 140 s old (score 10 + 703 = 713); dFar is
  // 900 wu away and fresh (900 + 8 = 908). Distance wins.
  const near = kdrop(1000, 10, 0, { steamId: 'CT_NEAR' });
  const far = kdrop(9900, 900, 0, { steamId: 'CT_FAR' });
  const pickup = kpickup(10000, 0, 0);
  const { drops } = build([roundStart(0), near, far, pickup, roundEnd(20000)]);

  assert.equal(drops.get(near).to, 10000, 'the near death claims it despite its age');
  assert.equal(drops.get(far).to, 20000, 'the far death stays on the ground');
});

test('KIT_MATCH_MAX refusal: a far pickup never claims a drop', () => {
  const drop = kdrop(1000, 0, 0);
  // 5000 wu away — past the 4096 hard filter, even though it is the
  // only candidate and long after buytime.
  const pickup = kpickup(6000, 5000, 0);
  const end = roundEnd(9000);
  const { drops, hasKitAt } = build([roundStart(0), drop, pickup, end], new Map());

  assert.equal(drops.get(drop).to, 9000, 'unmatched → the drop stays to round end');
  // …and the pickup is still a plain GAIN for its picker.
  assert.equal(hasKitAt('CT_PICK', 7000), true, 'an unmatched pickup is still a kit gain');
});

test('a pickup before the drop, or in another round, never claims it', () => {
  const drop = kdrop(5000, 0, 0);
  const early = kpickup(1000, 5, 0); // same round, BEFORE the death
  const nextRound = kpickup(7000, 5, 0, { round: 8 }); // later round
  const end = roundEnd(9000);
  const start8 = roundStart(10000, 8);
  const end8 = roundEnd(19000, 8);
  const { drops } = build([roundStart(0), drop, early, nextRound, end, start8, end8]);

  assert.equal(drops.get(drop).to, 9000, 'neither pickup terminates the round-7 drop');
});

// --- buytime (the buy / ground split) -------------------------------------

test('a buy INSIDE buytime never terminates a drop', () => {
  // Death at 2000, another CT BUYS a kit at 3000 — inside the round's
  // buytime (ended at 4000). The item_pickup row is identical to a
  // ground pickup; only buytime tells them apart.
  const drop = kdrop(2000, 0, 0);
  const buy = kpickup(3000, 10, 0);
  const end = roundEnd(9000);
  const buyEnds = new Map([[7, 4000]]);
  const { drops, hasKitAt } = build([roundStart(0), drop, buy, end], buyEnds);

  assert.equal(drops.get(drop).to, 9000, 'the buy leaves the drop visible to round end');
  assert.equal(hasKitAt('CT_PICK', 3500), true, 'a bought kit is still a gain');
});

test('a pickup AFTER buytime with no earlier drop is a plain gain', () => {
  const pickup = kpickup(6000, 0, 0); // no kit death happened this round
  const end = roundEnd(9000);
  const { drops, hasKitAt } = build([roundStart(0), pickup, end], new Map([[7, 4000]]));

  assert.equal(drops.size, 0, 'nothing to terminate');
  assert.equal(hasKitAt('CT_PICK', 7000), true, 'the gain still counts for possession');
});

test('buyEndsFromRows keeps the first row per round and skips malformed ones', () => {
  const m = buyEndsFromRows([
    { round: 7, tick: 4000 },
    { round: 7, tick: 5000 }, // duplicate → the FIRST wins
    { round: 8, tick: 14000 },
    { round: null, tick: 100 },
    { round: 9 }, // no tick
    null,
  ]);
  assert.equal(m.get(7), 4000);
  assert.equal(m.get(8), 14000);
  assert.equal(m.size, 2);
  // A round with NO buytime row reads as 0 (open bound: post-buytime).
  const drop = kdrop(1000, 0, 0);
  const { drops, hasKitAt } = build(
    [roundStart(0), drop, kpickup(2000, 5, 0), roundEnd(9000)],
    new Map(),
  );
  assert.equal(drops.get(drop).to, 2000, 'no buy evidence → the pickup counts as ground');
  assert.equal(hasKitAt('CT_PICK', 3000), true, 'no buy evidence → the pickup is a gain');
});

// --- never-guess rules -----------------------------------------------------

test('a position-less drop is never drawn and never claimed', () => {
  const noPos = kdrop(1000, null, null, { steamId: 'CT_NOPOS' });
  const placed = kdrop(1200, 40, 0, { steamId: 'CT_PLACED' });
  // The positioned one is NEARER the pickup than nothing — but a
  // position-less candidate can never be scored, so it is skipped and
  // the placed drop claims instead.
  const pickup = kpickup(5000, 30, 0);
  const { drops } = build([roundStart(0), noPos, placed, pickup, roundEnd(9000)]);

  assert.equal(drops.has(noPos), false, 'no window entry → the renderer draws nothing');
  assert.equal(drops.get(placed).to, 5000, 'the drawable drop claims the pickup');
  assert.equal(kitWindow(noPos, null, []), null, 'kitWindow refuses a position-less row');
});

test('a position-less pickup never claims (no honest distance)', () => {
  const drop = kdrop(1000, 0, 0);
  const pickup = kpickup(5000, null, null);
  const end = roundEnd(9000);
  const { drops } = build([roundStart(0), drop, pickup, end]);
  assert.equal(drops.get(drop).to, 9000, 'unmatched → round end');
});

test('no round_end rows → the window lives to Infinity', () => {
  const drop = kdrop(1000, 0, 0);
  const { drops } = build([roundStart(0), drop]);
  assert.equal(drops.get(drop).to, Infinity);
});

test('a kit dropped AFTER its round ended cuts at the next round_start (the post-round tail)', () => {
  // The golden round-2 shape for kits: round 7's round_end (9000)
  // PRECEDES the drop (9500), so a round_end-only scan finds no
  // terminator; the canonical cut (roundcut.js roundCutTick) falls
  // through to the next round_start (10000).
  const drop = kdrop(9500, 0, 0);
  const { drops } = build([roundStart(0), roundEnd(9000), drop, roundStart(10000, 8)]);
  const w = drops.get(drop);
  assert.equal(w.to, 10000, 'the next round_start is the round terminator');
  assert.ok(kitVisibleAt(w, 9999), 'visible in the round-over tail');
  assert.equal(kitVisibleAt(w, 10000), false, 'gone AT the next round_start (half-open)');
});

// --- the window contract ---------------------------------------------------

test('window [from,to) boundary equality', () => {
  const drop = kdrop(1000, 0, 0);
  const pickup = kpickup(5000, 5, 0);
  const win = kitWindow(drop, pickup, [roundEnd(9000)]);
  assert.deepEqual(win, { from: 1000, to: 5000 });

  assert.equal(kitVisibleAt(win, 999), false, 'before the death → not visible');
  assert.equal(kitVisibleAt(win, 1000), true, 'from is INCLUSIVE');
  assert.equal(kitVisibleAt(win, 4999), true);
  assert.equal(kitVisibleAt(win, 5000), false, 'to is EXCLUSIVE (picked up)');
  assert.equal(kitVisibleAt(win, 9000), false);
  assert.equal(kitVisibleAt(null, 1000), false, 'no window → never visible');
  assert.equal(kitVisibleAt(win, NaN), false);
});

// --- hasKitAt (round-scoped possession) ------------------------------------

test('hasKitAt: gain, death-loss, gain-again, round reset, unknown player', () => {
  const rows = [
    roundStart(0, 7),
    kpickup(500, 0, 0, { round: 7, steamId: 'CT1' }), // bought a kit
    kdrop(5000, 0, 0, { round: 7, steamId: 'CT1' }), // …and died with it
    kpickup(7000, 0, 0, { round: 7, steamId: 'CT1' }), // picked another up
    roundEnd(9000, 7),
    roundStart(10000, 8),
    roundEnd(19000, 8), // round 8: CT1 buys NOTHING
  ];
  const { hasKitAt } = build(rows);

  assert.equal(hasKitAt('CT1', 4999), true, 'gain at 500, no loss yet');
  assert.equal(hasKitAt('CT1', 5000), false, 'the death at 5000 is the ONLY loss channel');
  assert.equal(hasKitAt('CT1', 6999), false, 'still lost after the death');
  assert.equal(hasKitAt('CT1', 7000), true, 'gain AFTER the loss → has it again');
  assert.equal(hasKitAt('CT1', 8999), true, 'holds it to the round end');
  assert.equal(hasKitAt('CT1', 12000), false, 'round-scoped: no cross-round carry');
  assert.equal(hasKitAt('OTHER', 1000), false, 'a player with no kit rows → false (evidence is complete)');
});

test('hasKitAt returns null where the rows cannot answer', () => {
  const { hasKitAt } = build([roundStart(0, 7), roundEnd(9000, 7)]);
  assert.equal(hasKitAt(null, 1000), null, 'no player key');
  assert.equal(hasKitAt('', 1000), null, 'empty player key');
  assert.equal(hasKitAt('CT1', NaN), null, 'no playhead');
  assert.equal(hasKitAt('CT1', -100), null, 'before the first round_start → no round to scope to');
  assert.equal(hasKitAt(undefined, 1000), null);
  // …and with NO round rows loaded at all, the answer is unknown too.
  const empty = build([]);
  assert.equal(empty.hasKitAt('CT1', 1000), null, 'no round_start rows → unknown, never a guess');
});

test('a loss before any gain means no kit (gains gate the answer)', () => {
  const rows = [
    roundStart(0, 7),
    kdrop(3000, 0, 0, { round: 7, steamId: 'CT1' }), // died with a kit it never gained here
    roundEnd(9000, 7),
  ];
  const { hasKitAt } = build(rows);
  assert.equal(hasKitAt('CT1', 5000), false, 'no gains → no kit, whatever the losses say');
});
