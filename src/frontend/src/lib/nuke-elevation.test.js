// Guard for de_nuke's hand-derived Rafter/Catwalk elevation regions —
// the region data only (no rule logic lives here; lib/replay/layers.js
// is the canonical evaluator this test drives). Rafter and Catwalk are
// NOT single square regions: each is a set of connected rectangles
// (3 / 4) derived from the 2026-11-08 in-game setpos_exact boundary
// samples — the points below are transcribed from that session (the
// raw capture is not in the repo, so the samples live here as
// constants). What this pins:
//   1. every measured boundary point marks with the right verdict
//      (Above → ⊥ 'above', Below → 'T' below) — including the six
//      y≈−1360 Below-south points the OLD single box (y ≥ −1350)
//      missed entirely (they claimed no box → no mark: the regression
//      this split fixes);
//   2. each rectangle's interior is live (2-unit inset samples mark
//      both surfaces) — no rect may be shrunk to a sliver;
//   3. no-gap adjacency: a structure's rects form ONE connected
//      component (closed-interval touch), the intended pairs really
//      touch, any non-touching pair is far apart (no ε-gap dead
//      strips), shared world edges are EXACTLY equal (===), and every
//      rect of a structure carries IDENTICAL threshold/scope fields
//      (first-match can then never flip a verdict inside a
//      structure);
//   4. ordering: the untouched neighbour boxes (0–3, 6) keep their
//      slots around the new rects — box 3 and box 0 still win the
//      sliver overlaps they won before the split, and the catwalk's
//      z_max scope keeps it the only claimer below −495;
//   5. (skip-if-absent) the data-dir copy's elevation_regions match
//      this fixture — catches drift between the two checked-in files.
// Run: node --test src/lib/nuke-elevation.test.js   (from frontend/;
// the lib test glob src/lib/*.test.js picks it up too).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

import { elevationFor } from './replay/layers.js';

const meta = JSON.parse(
  readFileSync(new URL('../../public/maps/de_nuke/meta.json', import.meta.url), 'utf8'),
);
const regions = meta.elevation_regions;

// --- structure slices ------------------------------------------------------
// Layout after the split: [0..3] untouched upper boxes, [4..6] RAFTER,
// [7..10] CATWALK, [11] untouched box 6. Identified by their threshold
// reference — each structure has exactly ONE threshold set (the whole
// no-flip invariant).
const rafter = regions.filter((r) => r.reference_z === -260);
const catwalk = regions.filter((r) => r.reference_z === -704);
const RAFTER_T = { reference_z: -260, above: 124, below: 124, z_min: -495 };
const CATWALK_T = { reference_z: -704, above: 56, below: 56, z_max: -495 };

const scopeOf = (r) => ({ reference_z: r.reference_z, above: r.above, below: r.below, ...('z_min' in r ? { z_min: r.z_min } : {}), ...('z_max' in r ? { z_max: r.z_max } : {}) });

// --- measured boundary samples (setpos_exact, 2026-11-08) ------------------
// [label, x, y, z]; z is the surface the sample was taken at: Above
// samples stand ON the structure (rafter −127.97, catwalk −586..−640),
// Below samples stand UNDER it (rafter −392..−416, catwalk −767.97).
const ABOVE = 'above';
const BELOW = 'below';
const samples = [
  // Rafter — Above (z −127.96875): the three strips of the C open south.
  ['rafter above north', 305.03125, -292.03125, -127.96875, ABOVE],
  ['rafter above north', 974.96875, -280.062134, -127.96875, ABOVE],
  ['rafter above north', 974.908752, -318.750366, -127.96875, ABOVE],
  ['rafter above north', 305.03125, -315.444702, -127.96875, ABOVE],
  ['rafter above east', 974.962769, -280.03125, -127.96875, ABOVE],
  ['rafter above east', 991.954651, -945.927246, -127.96875, ABOVE],
  ['rafter above east', 957.220154, -950.458618, -127.96875, ABOVE],
  ['rafter above east', 960.447632, -280.03125, -127.96875, ABOVE],
  ['rafter above west', 305.039703, -292.03125, -127.96875, ABOVE],
  ['rafter above west', 288.02948, -947.970703, -127.96875, ABOVE],
  ['rafter above west', 319.834534, -949.710632, -127.96875, ABOVE],
  ['rafter above west', 317.417969, -292.050171, -127.96875, ABOVE],
  // Rafter — Below: 2-point edge lines traced from underneath.
  ['rafter below north', 917.312317, -334.028625, -401.594849, BELOW],
  ['rafter below north', 352.033295, -331.067261, -413.96875, BELOW],
  ['rafter below east', 956.072571, -432.054688, -415.96875, BELOW],
  ['rafter below east', 959.927917, -977.904846, -415.96875, BELOW],
  ['rafter below west', 328.044983, -352.03125, -415.96875, BELOW],
  ['rafter below west', 336.552887, -824.686768, -391.96875, BELOW],
  // Catwalk — Above.
  ['catwalk above south', 943.968689, -1317.96875, -639.96875, ABOVE],
  ['catwalk above south', 340.081451, -1317.944092, -639.96875, ABOVE],
  ['catwalk above south', 340.06897, -1259.744629, -632.96875, ABOVE],
  ['catwalk above south', 943.936035, -1267.994141, -639.96875, ABOVE],
  ['catwalk above east', 937.192566, -265.287842, -639.96875, ABOVE],
  ['catwalk above east', 884.037476, -260.088013, -639.96875, ABOVE],
  ['catwalk above east', 882.390747, -1317.967529, -639.96875, ABOVE],
  ['catwalk above east', 943.926331, -1317.9198, -639.96875, ABOVE],
  ['catwalk above west', 396.050079, -553.06189, -585.96875, ABOVE],
  ['catwalk above west', 340.03125, -557.389587, -632.96875, ABOVE],
  ['catwalk above west', 340.03125, -1317.947876, -639.96875, ABOVE],
  ['catwalk above west', 394.612305, -1316.102783, -639.96875, ABOVE],
  ['catwalk above overhang', 883.546875, -332.046021, -597.96875, ABOVE],
  ['catwalk above overhang', 800.648682, -330.916138, -639.96875, ABOVE],
  ['catwalk above overhang', 800.057983, -259.451477, -639.96875, ABOVE],
  ['catwalk above overhang', 883.836548, -259.813965, -639.96875, ABOVE],
  // Catwalk — Below (all z −767.96875).
  ['catwalk below south', 943.968384, -1276.04187, -767.96875, BELOW],
  ['catwalk below south', 943.967163, -1359.96875, -767.96875, BELOW],
  ['catwalk below south', 337.112762, -1359.968628, -767.96875, BELOW],
  ['catwalk below south', 340.03125, -1260.016602, -767.96875, BELOW],
  ['catwalk below east', 881.845703, -272.03125, -767.96875, BELOW],
  ['catwalk below east', 943.937378, -272.049133, -767.96875, BELOW],
  ['catwalk below east', 943.96875, -1359.959106, -767.96875, BELOW],
  ['catwalk below east', 881.94043, -1359.945557, -767.96875, BELOW],
  ['catwalk below west', 401.506958, -1359.96875, -767.96875, BELOW],
  ['catwalk below west', 394.050354, -560.053162, -767.96875, BELOW],
  ['catwalk below west', 340.048187, -560.046265, -767.96875, BELOW],
  ['catwalk below west', 337.093109, -1359.96875, -767.96875, BELOW],
  ['catwalk below overhang', 882.169617, -272.03064, -767.96875, BELOW],
  ['catwalk below overhang', 816.040527, -272.03125, -767.96875, BELOW],
  ['catwalk below overhang', 816.102722, -337.398682, -767.96875, BELOW],
  ['catwalk below overhang', 884.168579, -337.922607, -767.96875, BELOW],
];

// The six Below-south samples at y ≈ −1360 — the concrete regression:
// the OLD catwalk box (y: −1350, h: 1153.4) contained NONE of them, so
// they claimed no box at all and drew no mark. The new south edge is
// snapped to −1360, south of every one of them.
const regressionSix = [
  [943.967163, -1359.96875],
  [337.112762, -1359.968628],
  [943.96875, -1359.959106],
  [881.94043, -1359.945557],
  [401.506958, -1359.96875],
  [337.093109, -1359.96875],
];

const containsXY = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

// --- 1. layout: counts, slots, thresholds, no new fields --------------------

test('layout: 3 rafter + 4 catwalk rects, neighbours untouched, one threshold set per structure', () => {
  assert.equal(regions.length, 12); // 0-3 untouched, 4-6 rafter, 7-10 catwalk, 11 untouched
  // One contiguous slot per structure (first-match order).
  assert.deepEqual(rafter.map((r) => regions.indexOf(r)), [4, 5, 6]);
  assert.deepEqual(catwalk.map((r) => regions.indexOf(r)), [7, 8, 9, 10]);
  assert.equal(rafter.length, 3);
  assert.equal(catwalk.length, 4);
  // Untouched neighbours stay exactly where they were (order is the
  // first-match contract — see the ordering test below).
  assert.deepEqual(regions[3], { x: 986.3, y: -828, w: 453.9, h: 580, reference_z: -327, above: 79, below: 79, z_min: -495 });
  assert.deepEqual(regions[11], { x: -532.1, y: -1421, w: 803, h: 1173, reference_z: -331, above: 75, below: 75, z_min: -495 });
  // ONE threshold+scope set per structure — first-match can then never
  // flip a verdict between two rects of the same structure.
  for (const r of rafter) assert.deepEqual(scopeOf(r), RAFTER_T);
  for (const r of catwalk) assert.deepEqual(scopeOf(r), CATWALK_T);
  // Never add fields: preserveElevation round-trips these objects
  // through Go's encoding/json, which silently DROPS unknown keys on
  // the next re-extract.
  for (const r of rafter) {
    assert.deepEqual(Object.keys(r).sort(), ['above', 'below', 'h', 'reference_z', 'w', 'x', 'y', 'z_min']);
  }
  for (const r of catwalk) {
    assert.deepEqual(Object.keys(r).sort(), ['above', 'below', 'h', 'reference_z', 'w', 'x', 'y', 'z_max']);
  }
});

// --- 2. every measured point marks with the right verdict -------------------

test('measured boundary samples: Above marks ⊥, Below marks T', () => {
  assert.equal(samples.length, 50);
  for (const [label, x, y, z, want] of samples) {
    assert.equal(
      elevationFor(x, y, z, regions),
      want,
      `${label}: elevationFor(${x}, ${y}, ${z})`,
    );
  }
});

test('the six y≈−1360 Below-south samples (missed by the old box) are inside the new catwalk and mark T', () => {
  for (const [x, y] of regressionSix) {
    assert.ok(
      catwalk.some((r) => containsXY(r, x, y)),
      `(${x}, ${y}) not inside any catwalk rect`,
    );
    assert.equal(elevationFor(x, y, -767.96875, regions), 'below', `(${x}, ${y})`);
  }
});

// --- 3. interior liveness: 2-unit inset samples of every rect ----------------

test('interior samples of every rect mark both surfaces', () => {
  // Expected verdicts per structure surface: the rafter's two surfaces
  // (on −127.97 / under −400) vs its gates −136/−384; the catwalk's
  // (−640 / −768) vs its gates −648/−760.
  const structures = [
    { name: 'rafter', rects: rafter, on: -127.96875, under: -400, onWant: 'above', underWant: 'below' },
    { name: 'catwalk', rects: catwalk, on: -639.96875, under: -767.96875, onWant: 'above', underWant: 'below' },
  ];
  for (const s of structures) {
    for (const r of s.rects) {
      const pts = [
        [r.x + r.w / 2, r.y + r.h / 2],
        [r.x + 2, r.y + 2],
        [r.x + r.w - 2, r.y + 2],
        [r.x + 2, r.y + r.h - 2],
        [r.x + r.w - 2, r.y + r.h - 2],
      ];
      for (const [x, y] of pts) {
        const at = `(${x}, ${y})`;
        assert.ok(containsXY(r, x, y), `${s.name} ${at} outside its own rect`);
        assert.equal(elevationFor(x, y, s.on, regions), s.onWant, `${s.name} on-surface ${at}`);
        // The rafter-east NE inset lands in box 3's XY sliver (x ≥
        // 986.3, y −828..−248). Box 3 stays ahead of the rafter strips
        // (the ordering decision below) and at z −400 its band has no
        // verdict — the SAME result the pre-split data gave there.
        const box3Sliver = r === rafter[1] && x === r.x + r.w - 2 && y === r.y + r.h - 2;
        assert.equal(
          elevationFor(x, y, s.under, regions),
          box3Sliver ? null : s.underWant,
          `${s.name} under-surface ${at}`,
        );
      }
    }
  }
});

// --- 4. no-gap adjacency ----------------------------------------------------

// Closed-interval touch: shared edge (=== endpoints) counts as touching,
// interiors may overlap — but a positive gap on BOTH axes separates.
function touch(a, b) {
  return (
    Math.max(a.x, b.x) <= Math.min(a.x + a.w, b.x + b.w) &&
    Math.max(a.y, b.y) <= Math.min(a.y + a.h, b.y + b.h)
  );
}

function connected(rects) {
  const seen = new Set([0]);
  const queue = [0];
  while (queue.length) {
    const i = queue.pop();
    for (let j = 0; j < rects.length; j++) {
      if (!seen.has(j) && touch(rects[i], rects[j])) {
        seen.add(j);
        queue.push(j);
      }
    }
  }
  return seen.size === rects.length;
}

test('no-gap adjacency: each structure is one connected component of exactly-touching rects', () => {
  // Rafter: C open to the south — north connects both arms (their
  // north faces share the exact edge y+h = −280; the west arm meets
  // the north strip in a corner OVERLAP, which is safe because both
  // carry identical thresholds).
  assert.ok(touch(rafter[0], rafter[1]), 'north ↔ east must touch');
  assert.ok(touch(rafter[0], rafter[2]), 'north ↔ west must touch');
  // Catwalk: ⊔ open to the north + the overhang hanging off the east
  // arm — south shares exact edges with both arms (x = 337 west,
  // x+w = 944 east, y = −1360 south), the overhang overlaps the east
  // arm (their measured faces interleave at x ≈ 882–884, so exact
  // edges are impossible there — overlap, not a gap, is the correct
  // union).
  assert.ok(touch(catwalk[0], catwalk[1]), 'south ↔ east must touch');
  assert.ok(touch(catwalk[0], catwalk[2]), 'south ↔ west must touch');
  assert.ok(touch(catwalk[1], catwalk[3]), 'east ↔ overhang must touch');
  // Full connectivity — nothing may sit detached (an ε gap between
  // intended neighbours would disconnect the graph and turn the strip
  // into a dead zone where elevationFor returns null).
  assert.ok(connected(rafter), 'rafter rects must form one component');
  assert.ok(connected(catwalk), 'catwalk rects must form one component');
  // And no pair may drift apart by a hair: any non-touching pair (the
  // open mouths of the C/⊔, the gap west of the overhang) must be
  // separated by a wide margin on some axis — never ε.
  for (const rects of [rafter, catwalk]) {
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const [a, b] = [rects[i], rects[j]];
        if (touch(a, b)) continue;
        const gap = Math.max(
          b.x - (a.x + a.w),
          a.x - (b.x + b.w),
          b.y - (a.y + a.h),
          a.y - (b.y + b.h),
        );
        assert.ok(gap >= 100, `rects ${i}/${j} nearly touch with a ${gap}-unit gap`);
      }
    }
  }
});

test('shared world edges are derived from one source value (===, not two roundings)', () => {
  // Rafter: north strip and east strip meet the north face at −280
  // (both sums recompute to exactly −280 as parsed).
  assert.equal(rafter[0].y + rafter[0].h, -280);
  assert.equal(rafter[1].y + rafter[1].h, -280);
  assert.equal(rafter[0].y + rafter[0].h, rafter[1].y + rafter[1].h);
  // Catwalk: west edge, east edge, south edge each shared exactly.
  assert.equal(catwalk[0].x, catwalk[2].x);
  assert.equal(catwalk[0].x + catwalk[0].w, 944);
  assert.equal(catwalk[1].x + catwalk[1].w, 944);
  assert.equal(catwalk[0].x + catwalk[0].w, catwalk[1].x + catwalk[1].w);
  assert.equal(catwalk[0].y, -1360);
  assert.equal(catwalk[0].y, catwalk[1].y);
  assert.equal(catwalk[0].y, catwalk[2].y);
});

// --- 5. ordering: neighbours keep the slots they had ------------------------

test('ordering: box 3 and box 0 still win their slivers; the catwalk scope stacks with box 0', () => {
  // The rafter east strip's x+w = 992 pokes past box 3 (x ≥ 986.3) in
  // a ~6-unit sliver — the SAME overlap the pre-split single box had,
  // and box 3 was ahead of it then too (smaller-area-first would flip
  // this; we keep box 3 first = equivalent behaviour, a deliberate
  // choice). Proof: at (988, −300, −200) box 3 marks 'above' while
  // the rafter thresholds (−260 ±124) would return null.
  assert.equal(elevationFor(988, -300, -200, regions), 'above');
  // Same for the west strip's x ≥ 320 kiss against box 0 (y
  // −1228.6..−867.2): box 0 stays first, exactly as before the
  // split — at (335, −947.8, −200) box 0 marks 'above' while the
  // rafter band (−384..−136) would return null.
  assert.equal(elevationFor(335, -947.8, -200, regions), 'above');
  // The catwalk (z_max −495) and box 0 (z_min −495) overlap in XY
  // under the west arm; their half-open scopes partition by floor, so
  // the FIRST box admitting z decides on each side of the boundary.
  assert.equal(elevationFor(350, -1000, -768, regions), 'below'); // lower: box 0 skipped → catwalk
  assert.equal(elevationFor(350, -1000, -200, regions), 'above'); // upper: catwalk skipped → box 0
  // The overhang sits in the rafter north strip's XY too: below −495
  // only the catwalk admits (⊥ on the catwalk surface), above it only
  // the rafter band does (−200 is inside the band → no mark).
  assert.equal(elevationFor(840, -300, -640, regions), 'above');
  assert.equal(elevationFor(840, -300, -200, regions), null);
  // The old single boxes are really gone: their oversized interiors
  // no longer claim outside the derived footprints (the NW hole the
  // old rafter box covered, west of x 288, is unboxed again).
  assert.equal(elevationFor(275, -300, -127.96875, regions), null);
  assert.equal(elevationFor(320, -1300, -767.96875, regions), null); // old catwalk box's SW corner
});

// --- 6. two-copies drift (skip-if-absent) -----------------------------------

test('data-dir copy elevation_regions match the repo fixture', {
  skip: !existsSync(`${homedir()}/.local/share/spectra/maps/de_nuke/meta.json`),
}, () => {
  const dataDir = JSON.parse(
    readFileSync(`${homedir()}/.local/share/spectra/maps/de_nuke/meta.json`, 'utf8'),
  );
  // Only the regions are a contract between the two files — the
  // source.note legitimately differs (the data-dir one is the
  // extractor's, the repo one documents the hand derivation).
  assert.deepEqual(dataDir.elevation_regions, regions);
});
