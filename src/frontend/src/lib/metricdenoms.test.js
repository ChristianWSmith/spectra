// The Denominator group's filter contract (frontend side): METRIC_DENOMS
// IS the canonical bucket order (Rounds / Matches / None) and
// denomFilterWord maps every checked set to exactly the word
// store.ListMetricsPage's denominator filter accepts (Reading B,
// 2026-11-16): '' all-on, 'empty' all-off — the empty set needs its own
// word because "none" is a bucket token here — otherwise the canonical
// comma-subset with "none" naming the denominator-less rows. Run from
// frontend/:
//   node --test src/lib/metricdenoms.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

import { METRIC_DENOMS, denomFilterWord } from './metricdenoms.js';

const BUCKETS = ['rounds', 'matches', 'none'];

test('the vocabulary is the canonical bucket order the store composes in', () => {
  assert.deepEqual(
    METRIC_DENOMS,
    BUCKETS,
    "rounds, matches, none in order — the store's metricDenomTokens twin",
  );
});

test('every box checked → "" (no predicate) and no box checked → "empty" (the empty set)', () => {
  const allOn = Object.fromEntries(BUCKETS.map((t) => [t, true]));
  assert.equal(denomFilterWord(allOn), '', 'all three checked is the all-on word, like the other groups');
  assert.equal(denomFilterWord({}), 'empty', 'nothing checked is the empty-set word');
  assert.equal(
    denomFilterWord(Object.fromEntries(BUCKETS.map((t) => [t, false]))),
    'empty',
  );
});

test('the eight checked sets map to their exact store words (Reading B)', () => {
  const set = (...on) => denomFilterWord(Object.fromEntries(BUCKETS.map((t) => [t, on.includes(t)])));
  assert.equal(set('rounds', 'matches', 'none'), '', 'all three → no predicate');
  assert.equal(set('rounds', 'matches'), 'rounds,matches', 'the NEW two-token subset');
  assert.equal(set('rounds', 'none'), 'rounds,none', "the old 'rounds' window's rows");
  assert.equal(set('matches', 'none'), 'matches,none', "the old 'matches' window's rows");
  assert.equal(set('rounds'), 'rounds', 'the NEW rounds-only subset');
  assert.equal(set('matches'), 'matches', 'the NEW matches-only subset');
  assert.equal(set('none'), 'none', "the old 'none' window's rows");
  assert.equal(set(), 'empty', 'all off → nothing passes');
});

test('a subset joins in CANONICAL order, whatever order the checks landed in', () => {
  assert.equal(denomFilterWord({ none: true, rounds: true }), 'rounds,none', 'rounds sorts first, never last');
  assert.equal(
    denomFilterWord({ none: true, matches: true, rounds: true }),
    '',
    'the full set is "" — order never reaches the word',
  );
});
