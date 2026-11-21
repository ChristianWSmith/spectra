// The component context (dogfood/04-COMPONENTS.md §3, ruling 34): metric()
// and query() take their binds from the mounting surface's context by
// default, an explicit bind object replaces that set, and the context is
// frozen with its three fields.
//
// Run: node --test src/lib/componentcontext.test.js   (from frontend/)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createReadApi, resolveBinds, bindQuery } from './componentruntime/readapi.js';
import { frozenContext } from './componentruntime/frameContext.js';

const DEFS = [{ id: 1, name: 'adr', scope: 'match' }];

// A read API over recording services; `ctx` is the surface's context.
function harness(ctx = {}) {
  const calls = [];
  const reads = {
    listMetrics: async () => DEFS,
    getMetricValuesForMatch: async (m, ids) => {
      calls.push(['match', m, ids]);
      return [{ metricId: 1, subjectKey: 'a', dim: '', value: 81.5, valueKey: '' }];
    },
    getMetricValuesForPlayer: async (s, ids) => {
      calls.push(['player', s, ids]);
      return [{ metricId: 1, subjectKey: s, dim: '', value: 60, valueKey: '' }];
    },
    getMetricComputeState: async () => [{ metricId: 1, state: 'fresh' }],
    componentQuery: async (sql) => {
      calls.push(['query', sql]);
      return { columns: ['x'], rows: [[1]] };
    },
  };
  let current = frozenContext(ctx);
  const api = createReadApi({
    reads,
    report: () => {},
    nav: () => {},
    context: () => current,
  });
  return { api, calls, setContext: (next) => (current = frozenContext(next)) };
}

test('metric() with no explicit binds reads the context match', async () => {
  const { api, calls } = harness({ matchId: 5 });
  const r = await api.metric('adr');
  assert.deepEqual(calls[0], ['match', 5, [1]]);
  assert.equal(r.state, 'fresh');
});

test('an explicit { matchId } overrides the context match', async () => {
  const { api, calls } = harness({ matchId: 5 });
  await api.metric('adr', { matchId: 9 });
  assert.deepEqual(calls[0], ['match', 9, [1]]);
});

test('an explicit bind set replaces the context set as a whole', async () => {
  // A career read (steamId only) must not pick up the context's match.
  const { api, calls } = harness({ matchId: 5, steamId: '7656' });
  await api.metric('adr', { steamId: '7657' });
  assert.deepEqual(calls[0], ['player', '', [1]]);
});

test('a later context change is seen by the next read', async () => {
  const { api, calls, setContext } = harness({ matchId: 5 });
  await api.metric('adr');
  setContext({ matchId: 6 });
  await api.metric('adr');
  assert.deepEqual(calls.map((c) => c[1]), [5, 6]);
});

test('query() substitutes the context binds as literals', async () => {
  const { api, calls } = harness({ matchId: 5, steamId: '76561198000000001' });
  await api.query('SELECT :match_id, :steam_id');
  assert.deepEqual(calls[0], ['query', "SELECT 5, '76561198000000001'"]);
});

test('query() with an explicit bind uses it, not the context', async () => {
  const { api, calls } = harness({ matchId: 5 });
  await api.query('SELECT :match_id', { matchId: 7 });
  assert.deepEqual(calls[0], ['query', 'SELECT 7']);
});

test('query() refuses a named bind the surface has no value for', async () => {
  const { api, calls } = harness({});
  await assert.rejects(api.query('SELECT :match_id'), /no value for it/);
  assert.equal(calls.length, 0, 'nothing reaches the backend');
});

test('query() refuses a bind value of the wrong shape', () => {
  assert.throws(() => bindQuery('SELECT :match_id', { match_id: '5; DROP TABLE x' }), /cannot be used/);
  assert.throws(() => bindQuery('SELECT :steam_id', { steam_id: "1' OR '1" }), /cannot be used/);
  assert.equal(bindQuery('SELECT :round', { round: 3 }), 'SELECT 3');
});

test('a query that names no bind is unchanged', () => {
  assert.equal(bindQuery('SELECT 1', {}), 'SELECT 1');
});

test('resolveBinds refuses one bind given in both spellings', () => {
  assert.throws(() => resolveBinds({ matchId: 1, match_id: 2 }, {}), /once/);
  assert.deepEqual(resolveBinds({ match_id: 2 }, { matchId: 9 }), { match_id: 2 });
});

test('frozenContext fills the three fields and cannot be written', () => {
  const c = frozenContext({ matchId: 3, steamId: '765' });
  assert.deepEqual({ ...c }, { matchId: 3, steamId: '765', round: null });
  assert.ok(Object.isFrozen(c));
  assert.deepEqual({ ...frozenContext(null) }, { matchId: null, steamId: null, round: null });
});
