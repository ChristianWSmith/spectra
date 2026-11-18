// The Type group's format contract (frontend side): METRIC_FORMATS IS
// the canonical enum order — the editor's Format select renders its
// SELECTABLE members and the filter word composer shares the full list
// — and formatFilterWord maps every checked set to exactly the word
// store.ListMetricsPage's format filter accepts ('' all-on, 'none'
// all-off, otherwise the canonical comma-subset with "auto" naming the
// '' format and "identity" the key-valued metrics). Run from frontend/:
//   node --test src/lib/metricformats.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

import { METRIC_FORMATS, formatFilterWord } from './metricformats.js';

// The seven tokens in THE canonical enum order (identity joined the
// vocabulary with metrics Phase 7, 2026-11-18 — the Builder Type
// group's Identity box).
const TOKENS = ['auto', 'int', 'float1', 'float2', 'percent', 'currency', 'identity'];

test('the vocabulary is the canonical enum order, auto carrying the empty format value', () => {
  assert.deepEqual(
    METRIC_FORMATS.map((f) => f.token),
    TOKENS,
    'the seven format tokens in enum order — the store composes subset words in this order',
  );
  const values = METRIC_FORMATS.map((f) => f.value);
  assert.deepEqual(values, ['', 'int', 'float1', 'float2', 'percent', 'currency', 'identity'],
    "auto's stored value is the format column's ''; every other token is its own value");
});

test('identity is filter-only — the Type group offers it, the editor select never does', () => {
  const byToken = new Map(METRIC_FORMATS.map((f) => [f.token, f]));
  assert.equal(byToken.get('identity').filterOnly, true, 'identity carries the filterOnly flag');
  for (const t of TOKENS.filter((x) => x !== 'identity')) {
    assert.ok(!byToken.get(t).filterOnly, `${t} stays selectable`);
  }
  assert.deepEqual(
    METRIC_FORMATS.filter((f) => !f.filterOnly).map((f) => f.token),
    TOKENS.filter((t) => t !== 'identity'),
    'the editor Format select renders the selectable members only',
  );
});

test('every box checked → "" (no predicate) and no box checked → "none" (the empty set)', () => {
  const allOn = Object.fromEntries(TOKENS.map((t) => [t, true]));
  assert.equal(formatFilterWord(allOn), '', 'all seven checked is the all-on word, like the other groups');
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
    formatFilterWord({ identity: true, currency: true, percent: true, auto: true }),
    'auto,percent,currency,identity',
    'identity ranks LAST in the canonical order',
  );
  assert.equal(
    formatFilterWord({ auto: true, int: true, float1: true, float2: true, percent: true }),
    'auto,int,float1,float2,percent',
    'five of seven → the canonical five-token subset (an unchecked box drops its token)',
  );
});

test('each single box OFF → the other tokens, in order (subset math)', () => {
  for (const off of TOKENS) {
    const checked = Object.fromEntries(TOKENS.map((x) => [x, x !== off]));
    const want = TOKENS.filter((t) => t !== off).join(',');
    assert.equal(formatFilterWord(checked), want, `all on except ${off}`);
  }
});
