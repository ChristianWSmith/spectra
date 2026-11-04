// Cross-language side-parity (half-switch) fixture runner: the SAME
// internal/rules/testdata/sideparity.json is asserted by
// internal/rules/sideparity_test.go (Go) and by this file, so the backend
// (analytics.Compute, store sideFlips, heatmap side resolver) and the
// frontend RoundStrip can never diverge again.
// Run: node --test src/lib/sideparity.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { flipIndexes, eraOf, startSideFor, sideInEra } from './sideparity.js';

const fixture = JSON.parse(
  readFileSync(new URL('../../../internal/rules/testdata/sideparity.json', import.meta.url), 'utf8'),
);

test('fixture is present', () => {
  assert.ok(Array.isArray(fixture.cases) && fixture.cases.length > 0, 'no fixture cases');
});

test('flip indexes and eras match the shared fixture', () => {
  for (const c of fixture.cases) {
    const flips = flipIndexes(c.rounds, c.switches);
    assert.deepEqual(flips, c.flips, `flips(rounds=${c.rounds}, switches=${c.switches})`);
    const era = Array.from({ length: c.rounds }, (_, i) => eraOf(i, flips));
    assert.deepEqual(era, c.era, `era(rounds=${c.rounds}, switches=${c.switches})`);
  }
});

test('regulation MR12 splits at the 12th counted round', () => {
  assert.deepEqual(flipIndexes(24, 1), [12]);
  assert.deepEqual(flipIndexes(23, 1), [12]);
  // No switch → a single era for every round.
  assert.deepEqual(flipIndexes(24, 0), []);
  assert.deepEqual(Array.from({ length: 5 }, (_, i) => eraOf(i, [])), [0, 0, 0, 0, 0]);
});

test('overtime (switches >= 2) uses per-boundary floor division, not a uniform era length', () => {
  // The old RoundStrip math (eraLen = ceil(n / eras)) put the second
  // overtime boundary at 18 for this match; the backend formula says 17.
  assert.deepEqual(flipIndexes(25, 2), [9, 17]);
  assert.deepEqual(flipIndexes(23, 2), [8, 16]);
  // A match too short for the second switch keeps only the first boundary.
  assert.deepEqual(flipIndexes(2, 2), [1]);
  assert.deepEqual(flipIndexes(1, 2), []);
});

test('startSideFor: first-half side of the team that ended on a side', () => {
  // No switch recorded (partial/short demo): they started on the side
  // they ended on.
  assert.equal(startSideFor('ct', 0), 'ct');
  assert.equal(startSideFor('t', 0), 't');
  // Regulation MR12 (one switch): the team that FINISHED CT played T in
  // the first half — the input for the team-identity name colors
  // (changes.txt #10/#20: started CT → indigo, started T → orange).
  assert.equal(startSideFor('ct', 1), 't');
  assert.equal(startSideFor('t', 1), 'ct');
  // Each further switch flips it again (OT halves).
  assert.equal(startSideFor('ct', 2), 'ct');
  assert.equal(startSideFor('t', 2), 't');
  assert.equal(startSideFor('ct', 3), 't');
  // Missing data never gets a guessed side; a non-numeric switch count
  // reads as 0 (same coercion as flipIndexes).
  assert.equal(startSideFor('', 1), null);
  assert.equal(startSideFor('x', 1), null);
  assert.equal(startSideFor('ct', NaN), 'ct');
});

test('sideInEra reproduces the RoundStrip per-cell label derivation', () => {
  // Characterization of the formula RoundStrip computed inline before it
  // moved into this module: the team that finished CT plays CT in the
  // LAST era, each earlier era flipping it — (eras - 1 - era) % 2 === 0
  // → 'ct' — so the strip's arrows, tints and the start-side name colors
  // all rest on one derivation. Era indexes past the last half are
  // included to pin the parity handling there too.
  for (const switches of [0, 1, 2, 3]) {
    const eras = Math.max(1, switches + 1);
    for (let era = 0; era < eras + 2; era++) {
      const want = (eras - 1 - era) % 2 === 0 ? 'ct' : 't';
      assert.equal(sideInEra('ct', switches, era), want, `era=${era} switches=${switches}`);
      assert.equal(sideInEra('t', switches, era), want === 'ct' ? 't' : 'ct');
      // The two halves are always opposites.
      assert.notEqual(
        sideInEra('ct', switches, era),
        sideInEra('t', switches, era),
      );
    }
  }
  // Unknown side stays unknown in every era.
  assert.equal(sideInEra('', 1, 0), null);
});

test('startSideFor is sideInEra at era 0, and each era flips it', () => {
  for (const switches of [0, 1, 2, 3]) {
    for (const side of ['ct', 't']) {
      const start = startSideFor(side, switches);
      assert.equal(start, sideInEra(side, switches, 0));
      assert.equal(sideInEra(side, switches, 1), start === 'ct' ? 't' : 'ct');
    }
  }
});
