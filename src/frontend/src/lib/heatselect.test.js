// Tests for the heatmap rubber-band selection math (lib/heatselect.js): the
// one client px → world mapping (shared by click and drag), the bare-click
// threshold, the gesture box's normalisation/clamping, and the cell read
// that anchors a selection. (The raster clip `intersectGrid` died with the
// 2026-11-16 pad-on-drag fix — a drag now emits its raw world box.)
// Run: node --test src/lib/heatselect.test.js   (from frontend/)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DRAG_THRESHOLD_PX,
  isBareClick,
  clientToWorld,
  dragWorldBox,
  overlayRect,
  cellAt,
} from './heatselect.js';

// The harness transform (mapxform's formula: px=(wx−pos_x)/scale,
// py=(pos_y−wy)/scale) built by hand so the tests never depend on the
// component reader — the math under test is tf.toWorld itself.
const tf = {
  toWorld(px, py) {
    return { x: px * 1 + -50, y: 50 - py * 1 };
  },
};
// The DOM driver's stub: a 1024×1024 canvas rect at the origin, image space
// 1024×1024 — client (x, y) maps to world (x − 50, 50 − y).
const RECT = { left: 0, top: 0, width: 1024, height: 1024 };

// The 4×4 fixture grid spanning [−50, 50]², cells row-major with row 0 at
// minY (cells[i] = i + 1, so cell (col 0, row 3) holds 13).
const GRID = {
  w: 4,
  h: 4,
  minX: -50,
  maxX: 50,
  minY: -50,
  maxY: 50,
  cells: Array.from({ length: 16 }, (_, i) => i + 1),
};

test('the bare-click threshold is 4px and counts each axis on its own', () => {
  assert.equal(DRAG_THRESHOLD_PX, 4);
  // A press with no movement is a click (the ordinary case).
  assert.equal(isBareClick(10, 10, 10, 10), true);
  // 3px on either axis stays below the bar…
  assert.equal(isBareClick(10, 10, 13, 10), true);
  assert.equal(isBareClick(10, 10, 10, 13), true);
  assert.equal(isBareClick(10, 10, 13, 13), true);
  // …and 4px crosses it (the boundary is inclusive: a real drag).
  assert.equal(isBareClick(10, 10, 14, 10), false);
  assert.equal(isBareClick(10, 10, 10, 14), false);
  assert.equal(isBareClick(10, 10, 14, 13), false);
  // Chebyshev, not Euclidean: a long axis with a small cross-axis jitter is
  // still a drag (a diagonal length would hide behind the squaring).
  assert.equal(isBareClick(10, 10, 100, 12), false);
  // A reversed gesture (right-to-left / bottom-up) measures the same.
  assert.equal(isBareClick(14, 10, 10, 10), false);
  // An explicit threshold overrides the default (still "<", so a movement
  // of exactly the threshold is a drag).
  assert.equal(isBareClick(10, 10, 17, 10, 8), true);
  assert.equal(isBareClick(10, 10, 18, 10, 8), false);
});

test('clientToWorld mirrors the click formula exactly (rect origin + display scale)', () => {
  // Origin rect: client px ARE image px, then toWorld flips Y.
  assert.deepEqual(clientToWorld(tf, RECT, 0, 0, 1024, 1024), { x: -50, y: 50 });
  assert.deepEqual(clientToWorld(tf, RECT, 10, 10, 1024, 1024), { x: -40, y: 40 });
  assert.deepEqual(clientToWorld(tf, RECT, 512, 512, 1024, 1024), { x: 462, y: -462 });
  // A rect that does not start at the origin and is not the image size —
  // the displayed size is what scales, never c.width (the device backing).
  const shifted = { left: 100, top: 50, width: 512, height: 256 };
  // ix = (256 − 100)/512·1024 = 312 → world 262; iy = (118 − 50)/256·512 = 136 → world −86.
  assert.deepEqual(clientToWorld(tf, shifted, 256, 118, 1024, 512), { x: 262, y: -86 });
  // Degenerate inputs map to nothing rather than a guessed point.
  assert.equal(clientToWorld(tf, { left: 0, top: 0, width: 0, height: 0 }, 5, 5, 1024, 1024), null);
  assert.equal(clientToWorld(null, RECT, 5, 5, 1024, 1024), null);
  assert.equal(clientToWorld(tf, null, 5, 5, 1024, 1024), null);
  assert.equal(clientToWorld(tf, RECT, 5, 5, 0, 1024), null);
});

test('dragWorldBox normalises both corners — the Y flip comes out in min/max', () => {
  // Top-left (10, 10) → world (−40, 40); bottom-right (510, 510) → world
  // (460, −460). The screen-top corner is the world MAX y, so the raw
  // corner order is already inverted on Y — min/max over both corners is
  // what straightens it (and X too, for a right-to-left drag).
  assert.deepEqual(dragWorldBox(tf, RECT, 1024, 1024, 10, 10, 510, 510), {
    minX: -40,
    minY: -460,
    maxX: 460,
    maxY: 40,
  });
  // Same box dragged in the opposite direction: identical result.
  assert.deepEqual(dragWorldBox(tf, RECT, 1024, 1024, 510, 510, 10, 10), {
    minX: -40,
    minY: -460,
    maxX: 460,
    maxY: 40,
  });
  // A box that runs off the right/bottom edge is NOT clamped here (the
  // overlay clamps for display; the world box keeps the true gesture —
  // the view queries that rect verbatim for a drag).
  const wide = dragWorldBox(tf, RECT, 1024, 1024, 10, 10, 4000, 4000);
  assert.ok(wide.maxX > 50 && wide.minY < -50, JSON.stringify(wide));
  // Unmappable corners → null (never a half-invented box).
  assert.equal(dragWorldBox(null, RECT, 1024, 1024, 0, 0, 10, 10), null);
});

test('overlayRect normalises, clamps to the canvas and is origin-relative', () => {
  // Plain in-bounds gesture: left/top relative to the rect's origin.
  assert.deepEqual(overlayRect(10, 10, 510, 310, RECT), { left: 10, top: 10, width: 500, height: 300 });
  // Reversed gesture (right-to-left, bottom-up): same box as its mirror.
  assert.deepEqual(overlayRect(510, 310, 10, 10, RECT), { left: 10, top: 10, width: 500, height: 300 });
  // Clamped inside the rect on every edge — the overlay never spills.
  assert.deepEqual(overlayRect(10, 10, 4000, 4000, RECT), { left: 10, top: 10, width: 1014, height: 1014 });
  assert.deepEqual(overlayRect(-50, -50, 500, 500, RECT), { left: 0, top: 0, width: 500, height: 500 });
  // Off-origin rect: the result is relative to ITS origin (the overlay is
  // positioned against the canvas it is drawn over).
  const shifted = { left: 100, top: 50, width: 200, height: 100 };
  assert.deepEqual(overlayRect(150, 60, 250, 90, shifted), { left: 50, top: 10, width: 100, height: 30 });
  assert.deepEqual(overlayRect(0, 0, 1000, 1000, shifted), { left: 0, top: 0, width: 200, height: 100 });
  // A press with no movement yet → an empty (not negative) box.
  assert.deepEqual(overlayRect(10, 10, 10, 10, RECT), { left: 10, top: 10, width: 0, height: 0 });
});

test('cellAt reads the containing cell: row 0 at minY, missing value outside', () => {
  // The driver's standard click at client (10, 10) → world (−40, 40) →
  // col = floor(10/25) = 0, row = floor(90/25) = 3 → raw cell
  // [−50, −25] × [25, 50], value cells[3·4+0] = 13.
  const hit = cellAt(GRID, { x: -40, y: 40 });
  assert.deepEqual(hit.bbox, { minX: -50, minY: 25, maxX: -25, maxY: 50 });
  assert.equal(hit.value, 13);
  assert.equal(hit.inGrid, true);
  // The opposite corner cell (col 3, row 0) — bounds are inclusive of the
  // min edge, exclusive of the max (floor convention at exact boundaries).
  const last = cellAt(GRID, { x: 49.9, y: -49.9 });
  assert.deepEqual(last.bbox, { minX: 25, minY: -50, maxX: 50, maxY: -25 });
  assert.equal(last.value, 4);
  // Outside the raster the cell box still resolves but the value is
  // MISSING (undefined) — never a fabricated 0 (the kd sign rule).
  const out = cellAt(GRID, { x: 450, y: -450 });
  assert.equal(out.inGrid, false);
  assert.equal('value' in out, true);
  assert.equal(out.value, undefined);
  // Degenerate inputs → null (no cell, no region).
  assert.equal(cellAt(null, { x: 0, y: 0 }), null);
  assert.equal(cellAt(GRID, null), null);
  assert.equal(cellAt({ ...GRID, w: 0 }, { x: 0, y: 0 }), null);
  assert.equal(cellAt({ ...GRID, maxX: -50 }, { x: 0, y: 0 }), null);
});

// Re-pinned 2026-11-16 (owner fix — pad-on-drag + clip/anchor fallback):
// the drag path is gesture → world box → THE RAW REGION, and the anchor
// cell contributes only its VALUE. `intersectGrid` (the raster clip that
// existed to serve the view's cell pad) was deleted with the fix, and the
// caller no longer substitutes the anchor cell when a gesture misses the
// raster — an honest raw rect that simply returns nothing.
test('the full drag path: gesture → world box emitted AS-IS + anchor value', () => {
  // End-to-end over the driver fixture: press (10, 10), release (510, 510).
  const box = dragWorldBox(tf, RECT, 1024, 1024, 10, 10, 510, 510);
  // The drawn box runs past the raster on every side — NOT clipped: the
  // region IS the gesture (the view pads only a 'cell' emission).
  assert.deepEqual(box, { minX: -40, minY: -460, maxX: 460, maxY: 40 });
  // The anchor cell's value rides along (kd sign source in Heatmaps.onRegion).
  const anchor = clientToWorld(tf, RECT, 10, 10, 1024, 1024);
  assert.equal(cellAt(GRID, anchor).value, 13);
  // A gesture that misses the raster entirely: the region is STILL the
  // drawn box, and the anchor value is MISSING (out of grid — never a
  // fabricated 0), never a substitute cell region.
  const miss = dragWorldBox(tf, RECT, 1024, 1024, 500, 500, 900, 900);
  assert.deepEqual(miss, { minX: 450, minY: -850, maxX: 850, maxY: -450 });
  const anchorCell = cellAt(GRID, clientToWorld(tf, RECT, 500, 500, 1024, 1024));
  assert.equal(anchorCell.inGrid, false);
  assert.equal(anchorCell.value, undefined);
});
