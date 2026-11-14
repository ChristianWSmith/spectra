// The Type group's format contract (frontend side): METRIC_FORMATS IS
// the canonical enum order — the editor's Format select and the filter
// word composer share it — and formatFilterWord maps every checked set
// to exactly the word store.ListMetricsPage's format filter accepts (''
// all-on, 'none' all-off, otherwise the canonical comma-subset with
// "auto" naming the '' format). Run from frontend/:
//   node --test src/lib/metricformats.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

import { METRIC_FORMATS, formatFilterWord } from './metricformats.js';

const TOKENS = ['auto', 'int', 'float1', 'float2', 'percent', 'currency'];

test('the vocabulary is the canonical enum order, auto carrying the empty format value', () => {
  assert.deepEqual(
    METRIC_FORMATS.map((f) => f.token),
    TOKENS,
    'the six format tokens in enum order — the store composes subset words in this order',
  );
  const values = METRIC_FORMATS.map((f) => f.value);
  assert.deepEqual(values, ['', 'int', 'float1', 'float2', 'percent', 'currency'],
    "auto's stored value is the format column's ''; every other token is its own value");
});

test('every box checked → "" (no predicate) and no box checked → "none" (the empty set)', () => {
  const allOn = Object.fromEntries(TOKENS.map((t) => [t, true]));
  assert.equal(formatFilterWord(allOn), '', 'all six checked is the all-on word, like the other groups');
  assert.equal(formatFilterWord({}), 'none', 'nothing checked is the empty-set word');
  assert.equal(formatFilterWord(Object.fromEntries(TOKENS.map((t) => [t, false]))), 'none');
});

test('one checked box → its bare token', () => {
  for (const t of TOKENS) {
    const checked = Object.fromEntries(TOKENS.map((x) => [x, x === t]));
    assert.equal(formatFilterWord(checked), t, `only ${t} checked`);
  }
});

test('a subset joins in CANONICAL order, whatever order the checks landed in', () => {
  assert.equal(formatFilterWord({ percent: true, auto: true }), 'auto,percent', 'auto sorts first, never last');
  assert.equal(
    formatFilterWord({ currency: true, float2: true, int: true }),
    'int,float2,currency',
    'the word order is the vocabulary order, not the object key order',
  );
  assert.equal(
    formatFilterWord({ auto: true, int: true, float1: true, float2: true, percent: true }),
    'auto,int,float1,float2,percent',
    'five of six → the canonical five-token subset',
  );
});

test('each single box OFF → the other five tokens, in order (subset math)', () => {
  for (const off of TOKENS) {
    const checked = Object.fromEntries(TOKENS.map((x) => [x, x !== off]));
    const want = TOKENS.filter((t) => t !== off).join(',');
    assert.equal(formatFilterWord(checked), want, `all on except ${off}`);
  }
});
