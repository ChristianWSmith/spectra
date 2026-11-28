import '../../test/compile-worker-node.mjs';
// The component read API (lib/componentruntime/readapi.js): metric reads
// with the five states over the stored-value reads, the live query read,
// navigation, and the error routing into the component's frame.
//
// Run: node --test src/lib/componentreadapi.test.js   (from frontend/)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createReadApi, metricsByMatch } from './componentruntime/readapi.js';
import * as S from './strings/index.js';

const DEFS = [
  { id: 1, name: 'adr', scope: 'match' },
  { id: 2, name: 'career_adr', scope: 'profile' },
];

function harness({ values = [], states = [], query = null } = {}) {
  const calls = [];
  const stateCalls = [];
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
    getMetricComputeState: async () => {
      stateCalls.push(['library-state']);
      return states;
    },
    getMetricStates: async (scope, id) => {
      stateCalls.push([scope + '-state', id]);
      return states;
    },
    componentQuery: async (sql) => {
      calls.push(['query', sql]);
      return query ? query(sql) : { columns: ['x'], rows: [[1]] };
    },
  };
  const api = createReadApi({ reads, report: (e) => reported.push(e.message), nav: (h) => navs.push(h) });
  return { api, calls, stateCalls, reported, navs };
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

// Two matches in one API: match A's metric is behind, match B's is fresh. The
// per-match word answers each match from its own state, so A's behind never
// reaches B (and the library word is not consulted for a match read).
test('a metric behind for match A and fresh for match B reads per match', async () => {
  const statesByMatch = { 5: [{ metricId: 1, state: 'behind' }], 6: [{ metricId: 1, state: 'fresh' }] };
  const valuesByMatch = { 5: [], 6: [row('7656', 81.5)] };
  const calls = [];
  const reads = {
    listMetrics: async () => DEFS,
    getMetricValuesForMatch: async (m, ids) => (ids.length ? valuesByMatch[m] : []),
    getMetricValuesForRound: async () => [],
    getMetricValuesForPlayer: async () => [],
    getMetricComputeState: async () => {
      calls.push('library');
      return [{ metricId: 1, state: 'behind' }];
    },
    getMetricStates: async (scope, id) => {
      calls.push([scope, id]);
      return scope === 'match' ? statesByMatch[id] : [];
    },
    componentQuery: async () => ({ columns: [], rows: [] }),
  };
  const api = createReadApi({ reads, report: () => {} });
  const a = await api.metric('adr', { match_id: 5 });
  const b = await api.metric('adr', { match_id: 6, steam_id: '7656' });
  assert.equal(a.state, 'behind');
  assert.equal(b.state, 'fresh');
  assert.equal(b.value, 81.5);
  assert.deepEqual(calls, [['match', 5], ['match', 6]], 'the library word is never read for a match');
});

// A profile (player) read: a career metric behind for one player and fresh
// for another reads per player through metric(), never the library word.
test('a player behind for one player and fresh for another reads per player', async () => {
  const statesByPlayer = { '7656': [{ metricId: 2, state: 'behind' }], '7657': [{ metricId: 2, state: 'fresh' }] };
  const reads = {
    listMetrics: async () => DEFS,
    getMetricValuesForMatch: async () => [],
    getMetricValuesForRound: async () => [],
    // The career bucket (the read passes no steam id): both players' rows.
    getMetricValuesForPlayer: async () => [{ metricId: 2, subjectKey: '7657', dim: '', value: 60, valueKey: '' }],
    getMetricComputeState: async () => {
      throw new Error('the library word is not read for a player');
    },
    getMetricStates: async (scope, id) => (scope === 'player' ? statesByPlayer[id] : []),
    componentQuery: async () => ({ columns: [], rows: [] }),
  };
  const api = createReadApi({ reads, report: () => {} });
  const behind = await api.metric('career_adr', { steam_id: '7656' });
  const fresh = await api.metric('career_adr', { steam_id: '7657' });
  assert.equal(behind.state, 'behind');
  assert.equal(fresh.state, 'fresh');
  assert.equal(fresh.value, 60);
});

test('a read with no bind keeps the library-wide word', async () => {
  const { api, stateCalls } = harness({ states: [{ metricId: 2, state: 'behind' }] });
  await api.metric('career_adr', {}).catch(() => {});
  assert.ok(stateCalls.some((c) => c[0] === 'library-state'));
  assert.ok(!stateCalls.some((c) => c[0] === 'match-state' || c[0] === 'player-state'));
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
  assert.deepEqual(Object.keys(api).sort(), ['freeDemoCopy', 'guard', 'isHuman', 'listedPlayers', 'metric', 'metricsByMatch', 'navigate', 'query', 'saveCanvasPNG', 'saveText']);
  assert.ok(Object.isFrozen(api));
});

// ---- the one write (freeDemoCopy) ------------------------------------------
test('freeDemoCopy calls the wired write with the match id as a number', async () => {
  const calls = [];
  const api = createReadApi({
    reads: {},
    writes: { freeDemoCopy: async (id) => (calls.push(id), 42) },
    report: () => {},
  });
  assert.equal(await api.freeDemoCopy('7'), 42);
  assert.deepEqual(calls, [7]);
});

test('freeDemoCopy refuses when no write is wired', async () => {
  const api = createReadApi({ reads: {}, report: () => {} });
  await assert.rejects(api.freeDemoCopy(7), /cannot change stored data/);
});

// ---- in-flight dedupe and the series read (S13) -----------------------------
// A stub that counts backend calls the way the app's services do: the stored
// reads are read-cached (a repeat of the same key is a cache hit, not a call);
// the compute-state reads are never cached. A test can hold a read open with a
// deferred so it controls when concurrent reads settle.

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function countingReads({ values = [], series = [], statesOf = () => [] } = {}) {
  const calls = {};
  const cache = new Map();
  const count = (name) => (calls[name] = (calls[name] || 0) + 1);
  const cached = (name, key, make) => {
    const k = name + JSON.stringify(key);
    if (!cache.has(k)) {
      count(name);
      cache.set(k, make());
    }
    return cache.get(k);
  };
  const reads = {
    listMetrics: async () => DEFS,
    getMetricValuesForMatch: (m, ids) => cached('getMetricValuesForMatch', [m, ids], async () => values),
    getMetricValuesForRound: async () => [],
    getMetricValuesForPlayer: async () => [],
    getMetricComputeState: async () => [],
    getMetricStates: (scope, id) => {
      count('getMetricStates');
      return Promise.resolve(statesOf(scope, id));
    },
    getMetricSeries: (sid, ids) => cached('getMetricSeries', [sid, ids], async () => series),
    componentQuery: async () => ({ columns: [], rows: [] }),
  };
  return { reads, calls };
}

test('two concurrent identical state reads share one backend call', async () => {
  const gate = deferred();
  const { reads, calls } = countingReads();
  reads.getMetricStates = () => {
    calls.getMetricStates = (calls.getMetricStates || 0) + 1;
    return gate.promise;
  };
  const api = createReadApi({ reads, report: () => {} });
  const a = api.metric('adr', { match_id: 5 });
  const b = api.metric('adr', { match_id: 5 });
  gate.resolve([{ metricId: 1, state: 'fresh' }]);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(calls.getMetricStates, 1);
  assert.equal(ra.state, 'no-data');
  assert.equal(rb.state, 'no-data');
});

test('state reads for different units do not dedupe', async () => {
  const { reads, calls } = countingReads();
  const api = createReadApi({ reads, report: () => {} });
  await Promise.all([api.metric('adr', { match_id: 5 }), api.metric('adr', { match_id: 6 })]);
  assert.equal(calls.getMetricStates, 2);
});

test('a state read is not remembered once it has settled (no TTL)', async () => {
  const { reads, calls } = countingReads();
  const api = createReadApi({ reads, report: () => {} });
  await api.metric('adr', { match_id: 5 });
  await api.metric('adr', { match_id: 5 });
  assert.equal(calls.getMetricStates, 2);
});

test('a rejected state read is not cached: the next read asks the backend again', async () => {
  let attempts = 0;
  const { reads } = countingReads();
  reads.getMetricStates = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('boom');
    return [{ metricId: 1, state: 'fresh' }];
  };
  const reported = [];
  const api = createReadApi({ reads, report: (e) => reported.push(e.message) });
  await assert.rejects(api.metric('adr', { match_id: 5 }), { message: 'boom' });
  const r = await api.metric('adr', { match_id: 5 });
  assert.equal(attempts, 2);
  assert.equal(r.state, 'no-data');
  assert.deepEqual(reported, ['boom']);
});

test('concurrent callers of a rejected read all see the rejection, then the entry clears', async () => {
  const gate = deferred();
  const { reads, calls } = countingReads();
  reads.getMetricStates = () => {
    calls.getMetricStates = (calls.getMetricStates || 0) + 1;
    return gate.promise;
  };
  const api = createReadApi({ reads, report: () => {} });
  const a = api.metric('adr', { match_id: 5 });
  const b = api.metric('adr', { match_id: 5 });
  gate.reject(new Error('down'));
  await assert.rejects(a, { message: 'down' });
  await assert.rejects(b, { message: 'down' });
  assert.equal(calls.getMetricStates, 1);
});

test('metricsByMatch: one series read, one state read per match, no per-metric value reads', async () => {
  const series = [
    { metricId: 1, matchId: 5, value: 81.5 },
    { metricId: 1, matchId: 6, value: 60 },
  ];
  const states = { 5: [{ metricId: 1, state: 'fresh' }], 6: [{ metricId: 1, state: 'fresh' }] };
  const { reads, calls } = countingReads({ series, statesOf: (scope, id) => states[id] || [] });
  const out = await metricsByMatch(reads, '7656', ['adr'], [5, 6]);
  assert.equal(calls.getMetricSeries, 1);
  assert.equal(calls.getMetricStates, 2);
  assert.equal(calls.getMetricValuesForMatch, undefined);
  assert.equal(out.get(5).get('adr').value, 81.5);
  assert.equal(out.get(6).get('adr').value, 60);
  assert.equal(out.get(5).get('adr').state, 'fresh');
  assert.deepEqual(out.get(5).get('adr').rows, [{ subject: '7656', dim: '', value: 81.5, valueKey: '' }]);
});

test('metricsByMatch states match metric(): processing, failed, behind and no-data', async () => {
  const series = [{ metricId: 1, matchId: 5, value: 1 }];
  const table = {
    5: [{ metricId: 1, state: 'processing' }, { metricId: 2, state: 'fresh' }],
    6: [{ metricId: 1, state: 'failed', error: 'bad' }],
    7: [{ metricId: 1, state: 'behind' }],
    8: [{ metricId: 1, state: 'no-data' }],
  };
  const { reads } = countingReads({ series, statesOf: (scope, id) => table[id] || [] });
  const out = await metricsByMatch(reads, '7656', ['adr'], [5, 6, 7, 8]);
  assert.equal(out.get(5).get('adr').state, 'processing');
  assert.equal(out.get(6).get('adr').state, 'failed');
  assert.equal(out.get(6).get('adr').error, 'bad');
  assert.equal(out.get(7).get('adr').state, 'behind');
  assert.equal(out.get(8).get('adr').state, 'no-data');
  assert.equal(out.get(8).get('adr').value, null);
});

test('metricsByMatch with no metrics or no matches never calls the backend', async () => {
  const { reads, calls } = countingReads();
  const a = await metricsByMatch(reads, '7656', [], [5]);
  const b = await metricsByMatch(reads, '7656', ['adr'], []);
  assert.equal(calls.getMetricSeries, undefined);
  assert.equal(calls.getMetricStates, undefined);
  assert.deepEqual([...a.get(5)], []);
  assert.equal(b.size, 0);
});

test('metricsByMatch refuses an unknown metric name', async () => {
  const { reads } = countingReads();
  await assert.rejects(metricsByMatch(reads, '7656', ['nope'], [5]), {
    message: S.fill(S.components.metricUnknown, { name: 'nope' }),
  });
});

test('saveText and saveCanvasPNG call the wired writes, and refuse when none is wired', async () => {
  const calls = [];
  const api = createReadApi({
    reads: {},
    writes: {
      saveText: async (f, m, t) => (calls.push(['text', f, m, t]), '/out/' + f),
      saveCanvasPNG: async (c, f) => (calls.push(['png', c, f]), '/out/' + f),
    },
    report: () => {},
  });
  assert.equal(await api.saveText('a.csv', 'text/csv', 'x,y'), '/out/a.csv');
  assert.equal(await api.saveCanvasPNG('canvas', 'h.png'), '/out/h.png');
  assert.deepEqual(calls, [['text', 'a.csv', 'text/csv', 'x,y'], ['png', 'canvas', 'h.png']]);
  const bare = createReadApi({ reads: {}, report: () => {} });
  await assert.rejects(bare.saveText('a.csv', 'text/csv', ''), /cannot change stored data/);
  await assert.rejects(bare.saveCanvasPNG({}, 'h.png'), /cannot change stored data/);
});
