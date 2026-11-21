import '../../test/compile-worker-node.mjs';
// The component read API (lib/componentruntime/readapi.js): metric reads
// with the five states over the stored-value reads, the live query read,
// navigation, and the error routing into the component's frame.
//
// Run: node --test src/lib/componentreadapi.test.js   (from frontend/)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createReadApi } from './componentruntime/readapi.js';
import * as S from './strings/index.js';

const DEFS = [
  { id: 1, name: 'adr', scope: 'match' },
  { id: 2, name: 'career_adr', scope: 'profile' },
];

function harness({ values = [], states = [], query = null } = {}) {
  const calls = [];
  const reported = [];
  const navs = [];
  const reads = {
    listMetrics: async () => DEFS,
    getMetricValuesForMatch: async (m, ids) => {
      calls.push(['match', m, ids]);
      return values;
    },
    getMetricValuesForRound: async (m, r, ids) => {
      calls.push(['round', m, r, ids]);
      return values;
    },
    getMetricValuesForPlayer: async (s, ids) => {
      calls.push(['player', s, ids]);
      return values;
    },
    getMetricComputeState: async () => states,
    componentQuery: async (sql) => {
      calls.push(['query', sql]);
      return query ? query(sql) : { columns: ['x'], rows: [[1]] };
    },
  };
  const api = createReadApi({ reads, report: (e) => reported.push(e.message), nav: (h) => navs.push(h) });
  return { api, calls, reported, navs };
}

const row = (subjectKey, value) => ({ metricId: 1, subjectKey, dim: '', value, valueKey: '' });

test('a match-grain read for one player is fresh with that player’s value', async () => {
  const { api, calls } = harness({ values: [row('7656', 81.5), row('7657', 60)], states: [{ metricId: 1, state: 'fresh' }] });
  const r = await api.metric('adr', { match_id: 5, steam_id: '7656' });
  assert.deepEqual(calls[0], ['match', 5, [1]]);
  assert.equal(r.state, 'fresh');
  assert.equal(r.value, 81.5);
  assert.equal(r.n, undefined, 'the component read carries no sample size');
  assert.deepEqual(r.rows.map((x) => x.subject), ['7656']);
});

test('a unit read without a subject returns every fresh row of the unit', async () => {
  const { api } = harness({ values: [row('a', 1), row('b', 2)], states: [{ metricId: 1, state: 'fresh' }] });
  const r = await api.metric('adr', { match_id: 5 });
  assert.equal(r.state, 'fresh');
  assert.equal(r.value, null);
  assert.deepEqual(r.rows.map((x) => x.value), [1, 2]);
});

test('a player with no row in a covered unit reads no-data, never a zero', async () => {
  const { api } = harness({ values: [row('other', 3)], states: [{ metricId: 1, state: 'fresh' }] });
  const r = await api.metric('adr', { match_id: 5, steam_id: 'missing' });
  assert.equal(r.state, 'no-data');
  assert.equal(r.value, null);
  assert.deepEqual(r.rows, []);
});

test('no rows and a behind state reads behind', async () => {
  const { api } = harness({ values: [], states: [{ metricId: 1, state: 'behind' }] });
  assert.equal((await api.metric('adr', { match_id: 5 })).state, 'behind');
});

test('processing wins over a stored row and carries no number', async () => {
  const { api } = harness({ values: [row('a', 9)], states: [{ metricId: 1, state: 'processing' }] });
  const r = await api.metric('adr', { match_id: 5, steam_id: 'a' });
  assert.equal(r.state, 'processing');
  assert.equal(r.value, null);
  assert.deepEqual(r.rows, []);
});

test('a failed metric carries the compute error text', async () => {
  const { api } = harness({ values: [], states: [{ metricId: 1, state: 'failed', error: 'no such column' }] });
  const r = await api.metric('adr', { match_id: 5 });
  assert.equal(r.state, 'failed');
  assert.equal(r.error, 'no such column');
});

test('without match_id the read is the career bucket, narrowed by steam_id', async () => {
  const { api, calls } = harness({
    values: [{ metricId: 2, subjectKey: 'p', dim: '', value: 77, valueKey: '' }],
    states: [{ metricId: 2, state: 'fresh' }],
  });
  const r = await api.metric('career_adr', { steam_id: 'p' });
  assert.deepEqual(calls[0], ['player', '', [2]]);
  assert.equal(r.value, 77);
});

test('an unknown metric rejects and is reported to the frame once', async () => {
  const { api, reported } = harness();
  await assert.rejects(api.metric('nope'), { message: S.fill(S.components.metricUnknown, { name: 'nope' }) });
  assert.equal(reported.length, 1);
});

test('an unbound (library-wide) read is refused, never served career values', async () => {
  const { api, calls, reported } = harness();
  await assert.rejects(api.metric('adr'), { message: S.components.metricLibraryUnavailable });
  await assert.rejects(api.metric('adr', {}), { message: S.components.metricLibraryUnavailable });
  assert.deepEqual(calls, [], 'no stored read was issued');
  assert.equal(reported.length, 2);
});

test('a round-grain read takes the stored rows of that round only', async () => {
  const { api, calls } = harness({ values: [row('ct', 4)], states: [{ metricId: 1, state: 'fresh' }] });
  const r = await api.metric('adr', { match_id: 5, round: 3 });
  assert.deepEqual(calls[0], ['round', 5, 3, [1]], 'the round read, not the match read');
  assert.equal(r.state, 'fresh');
  assert.deepEqual(r.rows.map((x) => [x.subject, x.value]), [['ct', 4]]);
});

test('a round read without its match is refused', async () => {
  const { api, reported } = harness();
  await assert.rejects(api.metric('adr', { round: 3 }), { message: S.fill(S.components.bindUnset, { name: 'match_id' }) });
  assert.equal(reported.length, 1);
});

test('query returns columns and rows; a refusal rejects and is reported', async () => {
  const ok = harness();
  assert.deepEqual(await ok.api.query('select 1 as x'), { columns: ['x'], rows: [[1]] });
  assert.deepEqual(ok.calls[0], ['query', 'select 1 as x']);
  assert.deepEqual(ok.reported, []);

  const bad = harness({ query: () => ({ err: 'only read statements are allowed' }) });
  await assert.rejects(bad.api.query('delete from x'), { message: 'only read statements are allowed' });
  assert.deepEqual(bad.reported, ['only read statements are allowed']);
});

test('guard reports a thrown handler error and swallows it', () => {
  const { api, reported } = harness();
  const h = api.guard(() => {
    throw new Error('handler boom');
  });
  assert.doesNotThrow(() => h());
  assert.deepEqual(reported, ['handler boom']);
  assert.equal(api.guard((a, b) => a + b)(2, 3), 5, 'a clean handler returns its value');
});

test('guard reports an async rejection once, even when a read already reported it', async () => {
  const { api, reported } = harness({ query: () => ({ err: 'bad sql' }) });
  await api.guard(async () => {
    await api.query('select nope');
  })();
  assert.deepEqual(reported, ['bad sql']);
  await api.guard(async () => {
    throw 'plain string';
  })();
  assert.deepEqual(reported, ['bad sql', 'plain string']);
});

test('navigate takes a hash or a path with a query', () => {
  const { api, navs } = harness();
  api.navigate('/match/5');
  api.navigate({ path: '/match/5/rounds', query: { sel: 3 } });
  assert.deepEqual(navs, ['/match/5', '/match/5/rounds?sel=3']);
});

test('the API surface is exactly the documented set', () => {
  const { api } = harness();
  assert.deepEqual(Object.keys(api).sort(), ['guard', 'isHuman', 'listedPlayers', 'metric', 'navigate', 'query']);
  assert.ok(Object.isFrozen(api));
});
