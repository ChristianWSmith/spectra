// Cross-language side-parity (half-switch) fixture runner: the SAME
// internal/rules/testdata/sideparity.json is asserted by
// internal/rules/sideparity_test.go (Go) and by this file, so the backend
// (analytics.Compute, store sideFlips, heatmap side resolver) and the
// frontend RoundStrip can never diverge again.
// Run: node --test src/lib/sideparity.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { flipIndexes, eraOf } from './sideparity.js';

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
