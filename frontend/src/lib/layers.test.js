// Tests for the pure layer-assignment and elevation rules
// (lib/replay/layers.js): the half-open Z-band convention (adjacent
// sections share a boundary value and exactly one claims it), the
// default-layer fallback for missing/invalid Z, and the region→layer
// threshold resolution for the T/⊥ indicators.
// Run: node --test src/lib/layers.test.js   (from frontend/; the lib
// test glob src/lib/*.test.js picks it up too).
import test from 'node:test';
import assert from 'node:assert/strict';

import { layerIndexForZ, elevationFor } from './replay/layers.js';

// de_nuke's real bands (CS2.md "verticalsections" — verified 2026-06
// build): default (upper) [-495, 10000], lower [-10000, -495). The two
// bands SHARE the boundary value -495 — the case the convention pins.
const nukeLayers = [
  { id: 'default', zMin: -495, zMax: 10000 },
  { id: 'lower', zMin: -10000, zMax: -495 },
];

// --- layerIndexForZ --------------------------------------------------------

test('layerIndexForZ: band containment with the half-open [zMin, zMax) convention', () => {
  // Inside each band.
  assert.equal(layerIndexForZ(0, nukeLayers), 0); // upper floor
  assert.equal(layerIndexForZ(-600, nukeLayers), 1); // lower floor
  // THE shared boundary -495: claimed by the band whose zMin it is
  // (default), never by lower's exclusive zMax — adjacent ranges must
  // not both claim an entity.
  assert.equal(layerIndexForZ(-495, nukeLayers), 0);
  // One ulp below the boundary → lower.
  assert.equal(layerIndexForZ(-495.0001, nukeLayers), 1);
  // Band edges: zMin inclusive, zMax exclusive.
  assert.equal(layerIndexForZ(-10000, nukeLayers), 1); // lower's zMin — inclusive
  assert.equal(layerIndexForZ(10000, nukeLayers), 0); // default's zMax — exclusive → outside → fallback 0
});

test('layerIndexForZ: missing/invalid/out-of-band Z falls back to the default layer', () => {
  assert.equal(layerIndexForZ(null, nukeLayers), 0);
  assert.equal(layerIndexForZ(undefined, nukeLayers), 0);
  assert.equal(layerIndexForZ(NaN, nukeLayers), 0);
  assert.equal(layerIndexForZ(Infinity, nukeLayers), 0);
  assert.equal(layerIndexForZ(-10001, nukeLayers), 0); // below every band
  assert.equal(layerIndexForZ(10001, nukeLayers), 0); // above every band
  // No layers at all (single-layer pack) → the only layer.
  assert.equal(layerIndexForZ(-500, []), 0);
  assert.equal(layerIndexForZ(0, null), 0);
});

test('layerIndexForZ: a layer with missing/non-finite bounds never claims', () => {
  const layers = [{ id: 'a', zMin: null, zMax: null }, { id: 'b', zMin: 5, zMax: 10 }];
  // The unbounded layer claims nothing; the bounded one still works.
  assert.equal(layerIndexForZ(7, layers), 1);
  assert.equal(layerIndexForZ(1, layers), 0); // outside b → fallback
  // Inverted bounds (zMin > zMax) match nothing — no crash.
  const bad = [{ id: 'x', zMin: 10, zMax: 5 }];
  assert.equal(layerIndexForZ(7, bad), 0);
});

// --- elevationFor (REGION-ONLY) ---------------------------------------------

test('elevationFor: region thresholds with strict boundary semantics', () => {
  // One box covering the origin spot, reference 0 ±128 — the shape a
  // hand-authored pack writes (e.g. a catwalk over the floor at (0,0)).
  const regions = [
    { x: -100, y: -100, w: 200, h: 200, reference_z: 0, above: 128, below: 128 },
  ];
  // Strictly outside the band → indicator.
  assert.equal(elevationFor(0, 0, 129, regions), 'above');
  assert.equal(elevationFor(0, 0, -129, regions), 'below');
  // Exactly at the threshold → SAME level → no indicator (strict).
  assert.equal(elevationFor(0, 0, 128, regions), null);
  assert.equal(elevationFor(0, 0, -128, regions), null);
  assert.equal(elevationFor(0, 0, 0, regions), null);
});

test('elevationFor: outside every region → null — there is NO layer fallback', () => {
  const regions = [
    { x: 100, y: 100, w: 50, h: 50, reference_z: 1000, above: 10, below: 10 },
  ];
  // In-box: the region's thresholds decide.
  assert.equal(elevationFor(120, 120, 1011, regions), 'above');
  assert.equal(elevationFor(120, 120, 989, regions), 'below');
  assert.equal(elevationFor(120, 120, 1005, regions), null); // within ±10
  // Outside the box (half-open: x=150 is the exclusive edge; y=99 the
  // exclusive low edge) → NULL, even at an absurd Z: an unboxed XY is
  // declared unambiguous and never marks — the whole region-only rule.
  assert.equal(elevationFor(150, 120, 5000, regions), null);
  assert.equal(elevationFor(99, 120, -5000, regions), null);
  assert.equal(elevationFor(120, 99, 5000, regions), null);
  // No regions at all → never configured.
  assert.equal(elevationFor(0, 0, 5000, null), null);
  assert.equal(elevationFor(0, 0, 5000, []), null);
});

test('elevationFor: optional z scope — a box only applies on its floor', () => {
  // Nuke's catwalk ring scoped to the LOWER band (half-open z < -495):
  // its threshold must never fire on upper-panel players standing over
  // the same XY. below=10000 → the T branch never fires (floor =
  // reference), as in the derived pack data.
  const catwalk = [
    { x: 0, y: 0, w: 100, h: 100, reference_z: -768, above: 64, below: 10000, z_max: -495 },
  ];
  // Lower-band entity: catwalk (-640 > -704) marks, floor (-768) doesn't.
  assert.equal(elevationFor(50, 50, -640, catwalk), 'above');
  assert.equal(elevationFor(50, 50, -768, catwalk), null);
  // Upper-band entity at the same XY: the scope excludes the box → null
  // — the spurious-⊥ case this feature exists for.
  assert.equal(elevationFor(50, 50, -416, catwalk), null);
  // Half-open, the SAME convention as layerIndexForZ: -495 belongs to
  // the upper band → excluded; one ulp below → admitted.
  assert.equal(elevationFor(50, 50, -495, catwalk), null);
  assert.equal(elevationFor(50, 50, -495.0001, catwalk), 'above');
  // z_min is inclusive (the low end of the half-open interval).
  const both = [
    { x: 0, y: 0, w: 10, h: 10, reference_z: 0, above: 1, below: 1, z_min: -495, z_max: 10000 },
  ];
  assert.equal(elevationFor(5, 5, -495, both), 'below'); // z_min edge admitted
  assert.equal(elevationFor(5, 5, -495.0001, both), null); // …below it → excluded
  assert.equal(elevationFor(5, 5, 5, both), 'above'); // inside scope + past threshold
  // A z-scoped-out box is SKIPPED, not terminal: another box at the
  // same XY still decides (stacking lower-band + upper-band boxes).
  const stacked = [
    { x: 0, y: 0, w: 100, h: 100, reference_z: -768, above: 64, below: 10000, z_max: -495 },
    { x: 0, y: 0, w: 100, h: 100, reference_z: -416, above: 128, below: 10000 },
  ];
  assert.equal(elevationFor(50, 50, -640, stacked), 'above'); // box 0
  assert.equal(elevationFor(50, 50, -200, stacked), 'above'); // box 1 (upper structure)
  assert.equal(elevationFor(50, 50, -416, stacked), null); // box 1's floor → unmarked
});

test('elevationFor: unknown Z / malformed boxes return null, never a guess', () => {
  const regions = [
    { x: -100, y: -100, w: 200, h: 200, reference_z: 0, above: 1, below: 1 },
  ];
  // Unknown Z can never prove elevation — even inside a box.
  assert.equal(elevationFor(0, 0, null, regions), null);
  assert.equal(elevationFor(0, 0, NaN, regions), null);
  assert.equal(elevationFor(0, 0, undefined, regions), null);
  // Non-finite x/y match no region → null.
  assert.equal(elevationFor(null, null, 5000, regions), null);
  assert.equal(elevationFor(NaN, 0, 5000, regions), null);
  // A half-configured threshold set is unconfigured (no partial math).
  assert.equal(
    elevationFor(0, 0, 5000, [{ x: -1, y: -1, w: 10, h: 10, reference_z: 0, above: 1 }]),
    null,
  );
  // A box with non-finite geometry never claims (no crash, no guess).
  assert.equal(
    elevationFor(0, 0, 5000, [{ x: null, y: 0, w: 10, h: 10, reference_z: 0, above: 1, below: 1 }]),
    null,
  );
});
