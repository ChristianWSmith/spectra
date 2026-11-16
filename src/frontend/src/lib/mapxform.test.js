// Characterization pin for THE pack→transform reader (components/mapxform.js
// makeTransform) over the REAL de_cache meta (pos_x −2000, pos_y 3250,
// scale 5.5, 1024² radar): the transform is self-inverse and its image frame
// maps onto the demo world frame. Added 2026-11-16 with the heatmaps
// region-drill fix — that investigation verified exactly these properties
// end-to-end, but the transform had no direct unit pin of its own (the defect
// was in the region COMPOSER — pad-on-drag + the clip/anchor fallback — never
// in the transform; mapxform.js itself is untouched by the fix).
// Run: node --test src/lib/mapxform.test.js   (from frontend/)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeTransform } from './components/mapxform.js';

const deCacheMeta = {
  transform: { pos_x: -2000, pos_y: 3250, scale: 5.5 },
  radar: { file: 'de_cache.png', width: 1024, height: 1024 },
};

// World frame implied by the meta: x ∈ [pos_x, pos_x + width·scale] =
// [−2000, 3632]; Y flips (image row 0 is world MAX y), so
// y ∈ [pos_y − height·scale, pos_y] = [−2382, 3250].
const CORNERS = [
  { x: -2000, y: 3250 }, // image (0, 0)
  { x: 3632, y: 3250 }, // image (1024, 0)
  { x: -2000, y: -2382 }, // image (0, 1024)
  { x: 3632, y: -2382 }, // image (1024, 1024)
];
const CENTRE = { x: 816, y: 434 }; // image (512, 512)

const near = (a, b) => Math.abs(a - b) < 1e-9;

test('de_cache: the image corners and centre land on the documented world frame', () => {
  const tf = makeTransform(deCacheMeta);
  assert.ok(tf, 'makeTransform must build a transform from the meta');
  assert.equal(tf.width, 1024);
  assert.equal(tf.height, 1024);
  // The two pins the investigation quoted verbatim.
  assert.deepEqual(tf.toWorld(0, 0), { x: -2000, y: 3250 });
  assert.deepEqual(tf.toWorld(1024, 1024), { x: 3632, y: -2382 });
  // The other two corners and the centre (512·5.5 = 2816 → x = 816,
  // y = 3250 − 2816 = 434).
  assert.deepEqual(tf.toWorld(1024, 0), { x: 3632, y: 3250 });
  assert.deepEqual(tf.toWorld(0, 1024), { x: -2000, y: -2382 });
  assert.deepEqual(tf.toWorld(512, 512), CENTRE);
  // toImage is the exact inverse direction on the same frame.
  assert.deepEqual(tf.toImage(-2000, 3250), { x: 0, y: 0 });
  assert.deepEqual(tf.toImage(3632, -2382), { x: 1024, y: 1024 });
});

test('de_cache: toWorld(toImage(p)) == p for the four corners + centre', () => {
  const tf = makeTransform(deCacheMeta);
  for (const p of [...CORNERS, CENTRE]) {
    const img = tf.toImage(p.x, p.y);
    const back = tf.toWorld(img.x, img.y);
    assert.ok(
      near(back.x, p.x) && near(back.y, p.y),
      `round trip ${JSON.stringify(p)} → ${JSON.stringify(img)} → ${JSON.stringify(back)}`,
    );
  }
});
