// Unit tests for Explorer's pure payload-tree helpers.
// Run: node --test src/lib/payloadTree.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePayload,
  isObj,
  entries,
  countKeys,
  kvText,
  kvClass,
  matchPaths,
} from './payloadTree.js';

test('parsePayload parses objects and maps bad input to null', () => {
  assert.deepEqual(parsePayload('{"a":1}'), { a: 1 });
  assert.deepEqual(parsePayload(''), {});
  assert.deepEqual(parsePayload(null), {});
  assert.equal(parsePayload('{oops'), null);
  assert.equal(parsePayload('"scalar"'), 'scalar');
});

test('isObj / entries / countKeys describe branch nodes', () => {
  assert.equal(isObj({}), true);
  assert.equal(isObj([]), true);
  assert.equal(isObj(null), false);
  assert.equal(isObj('x'), false);
  assert.deepEqual(
    entries({ a: 1, b: 2 }),
    [
      ['a', 1],
      ['b', 2],
    ],
  );
  assert.equal(countKeys({ a: 1, b: 2, c: 3 }), 3);
  assert.equal(countKeys(7), 0);
});

test('kvText / kvClass render leaves', () => {
  assert.equal(kvText(null), 'null');
  assert.equal(kvText(undefined), 'undefined');
  assert.equal(kvText([1]), '[…]');
  assert.equal(kvText({ a: 1 }), '{…}');
  assert.equal(kvText(12), '12');
  assert.equal(kvClass(12), 'kv-num');
  assert.equal(kvClass(true), 'kv-bool');
  assert.equal(kvClass(null), 'kv-null');
  assert.equal(kvClass('s'), 'kv-str');
});

test('matchPaths: empty query disables filtering (null)', () => {
  const p = { userid: 1 };
  assert.equal(matchPaths(p, ''), null);
  assert.equal(matchPaths(p, '   '), null);
  assert.equal(matchPaths(p, undefined), null);
});

test('matchPaths: flat payload matches keys case-insensitively', () => {
  const p = { UserID: 3, weapon: 'ak47', dmg_health: 10 };
  const m = matchPaths(p, 'user');
  assert.ok(m instanceof Set);
  assert.deepEqual([...m], ['UserID']);
  assert.deepEqual([...matchPaths(p, 'WEAPON')], ['weapon']);
  assert.equal(matchPaths(p, 'nope').size, 0);
});

test('matchPaths: a hit brings its whole ancestor chain along', () => {
  const p = {
    round: { score: 5, winner: 'ct' },
    other: { deep: { winner: 't' } },
  };
  // Every path from the root down to each "winner" key is visible, so the
  // template can render the chain; unrelated siblings stay hidden.
  assert.deepEqual([...matchPaths(p, 'winner')].sort(), [
    'other',
    'other:deep',
    'other:deep:winner',
    'round',
    'round:winner',
  ]);
  assert.deepEqual([...matchPaths(p, 'score')].sort(), ['round', 'round:score']);
  assert.deepEqual([...matchPaths(p, 'nope')], []);
});

test('matchPaths: deep chains keep every intermediate path', () => {
  const p = { a: { b: { c: 1 } } };
  assert.deepEqual([...matchPaths(p, 'c')].sort(), ['a', 'a:b', 'a:b:c']);
  assert.deepEqual([...matchPaths(p, 'b')].sort(), ['a', 'a:b']);
});

test('matchPaths: non-object payload yields an empty set', () => {
  assert.equal(matchPaths(null, 'x').size, 0);
  assert.equal(matchPaths(undefined, 'x').size, 0);
  assert.equal(matchPaths(42, 'x').size, 0);
});
