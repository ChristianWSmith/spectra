// The metric sequence's contract pins after ruling 33 (pinning, metric
// ordering and hiding are retired): every metric list shows its DEFAULT rank
// order. resolveOrder implements the default sequence over the MERGED
// universe (the scope's fixed entries, negative ranks, plus the catalog's
// metric names); inSequence and composedSequence are its metric-only and
// merged views; rawItems / isRawId derive the recorded-value offers from the
// fixed block. The retired surface is pinned absent (no reader or writer).
//
// Run from frontend/:
//   node --test src/lib/metricorder.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from './metricorder.js';

const row = (name, scope = 'match') => ({ name, scope, title: name });

test('the default sequence leads with the fixed entries, then rank order, then catalog order', () => {
  const order = M.resolveOrder(['assists', 'mystery', 'adr', 'kills'], 'match');
  // fixed entries first (negative ranks), then ascending rank, then the unranked
  assert.deepEqual(order.slice(0, 2), ['@Name', '@Team']);
  // kills (rank -8) leads the fixed Score entry (rank -1), which leads the positive ranks
  assert.ok(order.indexOf('kills') < order.indexOf('@Score'), 'kills (rank -8) before @Score (rank -1)');
  assert.ok(order.indexOf('@Score') < order.indexOf('assists'), '@Score (rank -1) before assists (rank 1)');
  assert.ok(order.indexOf('assists') < order.indexOf('adr'), 'assists (rank 1) before adr (rank 2)');
  assert.equal(order.at(-1), 'mystery', 'an unranked name appends in catalog order');
});

test('a metric name that wears a fixed key never displaces the fixed entry', () => {
  const order = M.resolveOrder(['@Name', 'adr'], 'match');
  assert.equal(order.filter((n) => n === '@Name').length, 1);
});

test('inSequence is metric-only, scope-filtered and in default order', () => {
  const defs = [row('adr'), row('kills'), row('pw_profile_only', 'profile'), row('kd')];
  const names = M.inSequence('match', defs).map((d) => d.name);
  assert.deepEqual(names, ['kills', 'adr', 'kd']);
  assert.ok(!names.some((n) => n.startsWith('@')), 'fixed keys are stripped');
});

test('composedSequence merges the fixed entries and the metrics into one default-ordered list', () => {
  const entries = M.composedSequence('match', [row('adr'), row('kills')]);
  assert.deepEqual(
    entries.map((e) => e.key),
    ['@Name', '@Team', 'kills', '@Score', 'adr'],
  );
  assert.equal(entries[0].kind, 'fixed');
  assert.equal(entries[2].kind, 'metric');
  assert.equal(entries[2].def.name, 'kills');
});

test('the raw recorded-value offers derive from the fixed block (Score only)', () => {
  assert.deepEqual(
    M.rawItems('match').map((r) => r.id),
    ['raw:score'],
  );
  assert.ok(M.isRawId('raw:score'));
  assert.ok(!M.isRawId('score'));
});

test('the profile career card set is the shipped list, in the default order', () => {
  assert.ok(M.DEFAULT_CARDS.profile.includes('career_matches'));
  assert.equal(M.DEFAULT_CARDS.profile.length, 13);
  const names = M.inSequence('profile', M.DEFAULT_CARDS.profile.map((n) => row(n, 'profile'))).map((d) => d.name);
  assert.deepEqual(names, M.DEFAULT_CARDS.profile, 'the shipped rank order is the card order');
});

test('the retired pinning, ordering and hiding surface is gone (ruling 33)', () => {
  for (const gone of [
    'ORDER_KEYS',
    'OVERVIEW_PINS_KEY',
    'ECONOMY_KEY',
    'DEFAULT_ECONOMY',
    'HIDDEN_KEYS',
    'STARTS_TRANSPOSED_KEY',
    'DEFAULT_PINS',
    'hideable',
    'pinnedInSequence',
    'readOrder',
    'writeOrder',
    'resetOrder',
    'readHidden',
    'writeHidden',
    'resetHidden',
    'readOverviewPins',
    'writeOverviewPins',
    'readEconomyPins',
    'writeEconomyPins',
    'parseStoredPins',
    'resolvePins',
    'readStartsTransposed',
    'writeStartsTransposed',
    'overviewDefs',
  ]) {
    assert.ok(!(gone in M), `${gone} must not be exported`);
  }
});
