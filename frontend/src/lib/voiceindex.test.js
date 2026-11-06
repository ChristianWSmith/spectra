// Tests for lib/replay/voiceindex.js — the speaking-bucket index behind
// the live "talking" ring (data only). The per-player COLORS are NOT
// voice facts anymore: they moved to playercolor.js (the one palette
// home) and are tested in src/lib/playercolor.test.js — this file keeps
// only the speaking contract.
// Run: node --test src/lib/voiceindex.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSpeakingIndex, speakingAt } from './replay/voiceindex.js';

// The bucket mapping under test mirrors voiceservice.go:
//   b = int(float64(tick-from) / (to-from) * float64(buckets)), clamped
//       to [0, buckets-1] (tick == to lands in the last bucket).
function goBucket(from, to, buckets, tick) {
  const b = Math.floor(((tick - from) / (to - from)) * buckets);
  return Math.min(buckets - 1, Math.max(0, b));
}

const LANES = {
  fromTick: 100,
  toTick: 200,
  buckets: 10,
  players: [{ steamId: 'A', counts: [1, 0, 0, 0, 0, 0, 0, 0, 0, 1] }],
};

test('buildSpeakingIndex: shape, Map lookup, and unusable results', () => {
  const idx = buildSpeakingIndex(LANES);
  assert.equal(idx.fromTick, 100);
  assert.equal(idx.toTick, 200);
  assert.equal(idx.buckets, 10);
  assert.ok(idx.counts instanceof Map);
  assert.deepEqual(idx.counts.get('A'), LANES.players[0].counts);

  // Empty / degenerate results build a dead index (everything false).
  for (const bad of [null, undefined, {}, { fromTick: 0, toTick: 0, buckets: 10 }]) {
    const dead = buildSpeakingIndex(bad);
    assert.equal(dead.buckets, 0, JSON.stringify(bad));
    assert.equal(speakingAt(dead, 'A', 5), false);
  }
  // Non-array counts normalize to an empty row (never a crash).
  const odd = buildSpeakingIndex({ ...LANES, players: [{ steamId: 'A', counts: null }] });
  assert.deepEqual(odd.counts.get('A'), []);
  assert.equal(speakingAt(odd, 'A', 100), false);
});

test('speakingAt: bucket edges match the Go formula exactly', () => {
  // Single-1 counts identify which bucket the lookup picked: every tick
  // must land in the bucket voiceservice.go would count it into.
  for (let t = LANES.fromTick; t <= LANES.toTick; t++) {
    const expected = goBucket(LANES.fromTick, LANES.toTick, LANES.buckets, t);
    const counts = new Array(LANES.buckets).fill(0);
    counts[expected] = 1;
    const idx = buildSpeakingIndex({ ...LANES, players: [{ steamId: 'A', counts }] });
    assert.equal(speakingAt(idx, 'A', t), true, `tick ${t} → bucket ${expected}`);
    // The neighboring bucket must NOT light up.
    const other = (expected + 1) % LANES.buckets;
    const counts2 = new Array(LANES.buckets).fill(0);
    counts2[other] = 1;
    const idx2 = buildSpeakingIndex({ ...LANES, players: [{ steamId: 'A', counts: counts2 }] });
    assert.equal(speakingAt(idx2, 'A', t), false, `tick ${t} must not be bucket ${other}`);
  }
});

test('speakingAt: first tick, last tick, tick == toTick (Go clamp), out of range', () => {
  const idx = buildSpeakingIndex(LANES);
  // counts: bucket 0 and bucket 9 have chunks, the rest are silent.
  assert.equal(speakingAt(idx, 'A', 100), true); // first tick → bucket 0
  assert.equal(speakingAt(idx, 'A', 109), true); // still bucket 0 (0.9 → 0)
  assert.equal(speakingAt(idx, 'A', 110), false); // bucket 1, silent
  assert.equal(speakingAt(idx, 'A', 198), true); // bucket 9 (9.8 → 9)
  assert.equal(speakingAt(idx, 'A', 199), true); // last tick → bucket 9
  assert.equal(speakingAt(idx, 'A', 200), true); // toTick clamps to last bucket
  assert.equal(speakingAt(idx, 'A', 99), false); // before fromTick
  assert.equal(speakingAt(idx, 'A', 201), false); // after toTick
  assert.equal(speakingAt(idx, 'A', -1), false);
  assert.equal(speakingAt(idx, 'A', NaN), false);
  assert.equal(speakingAt(idx, 'A', '105'), true); // numeric string → bucket 0
});

test('speakingAt: unknown steamId, all-silent counts, short counts → false', () => {
  const idx = buildSpeakingIndex(LANES);
  assert.equal(speakingAt(idx, 'stranger', 100), false);
  assert.equal(speakingAt(idx, null, 100), false);
  const silent = buildSpeakingIndex({
    ...LANES,
    players: [{ steamId: 'A', counts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }],
  });
  assert.equal(speakingAt(silent, 'A', 100), false);
  assert.equal(speakingAt(silent, 'A', 199), false);
  // counts shorter than `buckets` never throws — missing bucket = silent.
  const short = buildSpeakingIndex({
    ...LANES,
    players: [{ steamId: 'A', counts: [1] }],
  });
  assert.equal(speakingAt(short, 'A', 100), true); // bucket 0 exists
  assert.equal(speakingAt(short, 'A', 150), false); // bucket 5 past the end
});
