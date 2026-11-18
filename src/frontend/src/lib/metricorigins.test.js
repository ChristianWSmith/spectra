// originFilterWord maps every checked set to exactly the word
// store.ListMetricsPage accepts — the frontend twin of the store's
// metricOriginTokens contract, pinned so a box/token drift on either
// side fails here first.
import test from 'node:test';
import assert from 'node:assert/strict';

import { METRIC_ORIGINS, originFilterWord } from './metricorigins.js';

test('METRIC_ORIGINS is the canonical origin order (builtin, user, plugin)', () => {
  assert.deepEqual(
    METRIC_ORIGINS,
    ['builtin', 'user', 'plugin'],
    "builtin, user, plugin in order — the store's metricOriginTokens twin",
  );
});

test('originFilterWord — all-on is the no-predicate word, none is the empty set', () => {
  const allOn = Object.fromEntries(METRIC_ORIGINS.map((t) => [t, true]));
  assert.equal(originFilterWord(allOn), '', 'all three checked is the all-on word, like the other groups');
  assert.equal(
    originFilterWord(Object.fromEntries(METRIC_ORIGINS.map((t) => [t, false]))),
    'none',
    'nothing checked is the empty-set word',
  );
});

test('originFilterWord — subsets are the canonical comma-subset in token order', () => {
  const set = (...on) => originFilterWord(Object.fromEntries(METRIC_ORIGINS.map((t) => [t, on.includes(t)])));
  assert.equal(set('builtin'), 'builtin', 'one box is its own token');
  assert.equal(set('user'), 'user', 'the Custom box is the user token');
  assert.equal(set('plugin'), 'plugin', 'the Plugin box is the plugin token');
  assert.equal(set('user', 'plugin'), 'user,plugin', 'the default pair, order fixed');
  assert.equal(set('plugin', 'user'), 'user,plugin', 'never the click order');
  assert.equal(set('builtin', 'user'), 'builtin,user');
  assert.equal(set('builtin', 'plugin'), 'builtin,plugin');
});
