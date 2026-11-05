// Cross-language side-parity (half-switch) fixture runner: the SAME
// internal/rules/testdata/sideparity.json is asserted by
// internal/rules/sideparity_test.go (Go) and by this file, so the backend
// (analytics.Compute, store sideFlips, heatmap side resolver) and the
// frontend RoundStrip can never diverge again.
// Run: node --test src/lib/sideparity.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { flipIndexes, eraOf, startSideFor, sideInEra, teamKeyAt, sideAtRound } from './sideparity.js';

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
  // A uniform eraLen = ceil(n / eras) would put the second
  // overtime boundary at 18 for this match; the per-boundary floor
  // division says 17.
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
  // (started CT → indigo, started T → orange).
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

test('teamKeyAt: a round\'s side resolves to the TEAM that played it', () => {
  // MR12 (23 counted rounds, one switch): the team that FINISHED CT
  // opened T, so the 'ct' side of round 1 belongs to the final-T team
  // and the 'ct' side of round 13 (the second-half pistol) belongs to
  // the final-CT team — the mapping flips exactly at the half.
  assert.equal(teamKeyAt('ct', 0, 23, 1), 't');
  assert.equal(teamKeyAt('t', 0, 23, 1), 'ct');
  assert.equal(teamKeyAt('ct', 12, 23, 1), 'ct');
  assert.equal(teamKeyAt('t', 12, 23, 1), 't');
  // No recorded switch: side and team key are the same thing.
  assert.equal(teamKeyAt('ct', 0, 23, 0), 'ct');
  assert.equal(teamKeyAt('t', 22, 23, 0), 't');
  // Two switches (OT) flip twice — era 0 and the last era share the
  // opening mapping, the middle era is the flipped one.
  assert.equal(teamKeyAt('ct', 0, 25, 2), 'ct');
  assert.equal(teamKeyAt('ct', 10, 25, 2), 't');
  assert.equal(teamKeyAt('ct', 17, 25, 2), 'ct');
  // Unknown side never gets a guessed team.
  assert.equal(teamKeyAt('', 0, 23, 1), null);
  assert.equal(teamKeyAt('ct2', 0, 23, 1), null);
});

// A match's round rows the way the views hold them: the negative-numbered
// warmup/knife rounds ahead of `counted` real rounds (extract's renumber —
// the first real round is 1, so these never count).
function roundList(counted) {
  return [
    { number: -2 },
    { number: -1 },
    ...Array.from({ length: counted }, (_, i) => ({ number: i + 1 })),
  ];
}

test('sideAtRound: a round number resolves to the side played in that round', () => {
  const rounds = roundList(24); // MR12 regulation, one side switch
  // First half (rounds 1–12): the team that finished CT played T.
  assert.equal(sideAtRound(rounds, 1, 1, 'ct'), 't');
  assert.equal(sideAtRound(rounds, 1, 12, 'ct'), 't');
  assert.equal(sideAtRound(rounds, 1, 1, 't'), 'ct');
  // Second half (rounds 13–24): the sides are back to the final sides —
  // the golden demo's FREELOOK-on-round-13 case lives here.
  assert.equal(sideAtRound(rounds, 1, 13, 'ct'), 'ct');
  assert.equal(sideAtRound(rounds, 1, 24, 'ct'), 'ct');
  assert.equal(sideAtRound(rounds, 1, 13, 't'), 't');
  // The derivation is eraOf over the COUNTED index — the same one
  // startSideFor feeds the team-identity colors at era 0.
  assert.equal(sideAtRound(rounds, 1, 1, 'ct'), startSideFor('ct', 1));
});

test('sideAtRound: knife/warmup rounds read as the first era, like RoundStrip cells', () => {
  const rounds = roundList(24);
  assert.equal(sideAtRound(rounds, 1, -2, 'ct'), startSideFor('ct', 1));
  assert.equal(sideAtRound(rounds, 1, -1, 't'), startSideFor('t', 1));
  // No recorded switch → the side never moves.
  assert.equal(sideAtRound(rounds, 0, 1, 'ct'), 'ct');
  assert.equal(sideAtRound(rounds, 0, 24, 'ct'), 'ct');
  // Overtime: 25 counted rounds, two switches → flips at 9 and 17.
  const ot = roundList(25);
  assert.equal(sideAtRound(ot, 2, 10, 'ct'), 't');
  assert.equal(sideAtRound(ot, 2, 18, 'ct'), 'ct');
});

test('sideAtRound: missing data never gets a guessed side', () => {
  const rounds = roundList(24);
  // Round not in this match's list.
  assert.equal(sideAtRound(rounds, 1, 99, 'ct'), null);
  // No rounds list at all (fetch failed / not loaded yet).
  assert.equal(sideAtRound([], 1, 13, 'ct'), null);
  assert.equal(sideAtRound(null, 1, 13, 'ct'), null);
  // Not a side.
  assert.equal(sideAtRound(rounds, 1, 13, ''), null);
  assert.equal(sideAtRound(rounds, 1, 13, 'ct2'), null);
  // Garbage switch counts coerce to 0 rather than throwing.
  assert.equal(sideAtRound(rounds, undefined, 13, 'ct'), 'ct');
});
