// Characterization tests for the hash router (parseHash) — extracted
// verbatim from App.svelte in Phase 0 of the consolidation wave, before
// any behavior change. These pin the CURRENT route table.
// Run: node --test src/lib/router.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseHash } from './router.js';

test('empty/absent hash defaults to the library', () => {
  assert.deepEqual(parseHash(''), { name: 'library' });
  assert.deepEqual(parseHash('#'), { name: 'library' });
  assert.deepEqual(parseHash('#/library'), { name: 'library' });
});

test('unknown hashes fall through to the library default', () => {
  assert.deepEqual(parseHash('#/nope'), { name: 'library' });
  assert.deepEqual(parseHash('#/match/abc'), { name: 'library' });
  assert.deepEqual(parseHash('#/match/42/timeline/extra'), { name: 'library' });
  assert.deepEqual(parseHash('#/match/42/round/7x'), { name: 'library' });
  assert.deepEqual(parseHash('#/timeline'), { name: 'library' });
  assert.deepEqual(parseHash('#/player/123'), { name: 'library' }); // not 17 digits
  assert.deepEqual(parseHash('#/compare'), { name: 'library' });
  assert.deepEqual(parseHash('#/replay/abc'), { name: 'library' });
});

test('#/match/:id', () => {
  assert.deepEqual(parseHash('#/match/42'), { name: 'match', id: 42 });
  assert.deepEqual(parseHash('#/match/0'), { name: 'match', id: 0 });
  // no tab key when the plain match route matches
  assert.equal('tab' in parseHash('#/match/42'), false);
});

test('#/match/:id/round/:n — negative rounds allowed ("-?")', () => {
  assert.deepEqual(parseHash('#/match/42/round/7'), {
    name: 'round',
    id: 42,
    round: 7,
  });
  assert.deepEqual(parseHash('#/match/42/round/0'), {
    name: 'round',
    id: 42,
    round: 0,
  });
  // knife/warmup rounds carry negative indices
  assert.deepEqual(parseHash('#/match/42/round/-3'), {
    name: 'round',
    id: 42,
    round: -3,
  });
});

test('#/match/:id/timeline carries routeTab Timeline', () => {
  assert.deepEqual(parseHash('#/match/42/timeline'), {
    name: 'match',
    id: 42,
    tab: 'Timeline',
  });
  assert.equal('legacy' in parseHash('#/match/42/timeline'), false);
});

test('legacy #/timeline/:id parses to the match Timeline tab with legacy flag', () => {
  assert.deepEqual(parseHash('#/timeline/42'), {
    name: 'match',
    id: 42,
    tab: 'Timeline',
    legacy: true,
  });
});

test('#/replay/:id', () => {
  assert.deepEqual(parseHash('#/replay/42'), { name: 'replay', id: 42 });
});

test('#/player/:steamid requires exactly 17 digits', () => {
  assert.deepEqual(parseHash('#/player/76561198012345678'), {
    name: 'player',
    steamId: '76561198012345678',
  });
  assert.deepEqual(parseHash('#/player/7656119801234567'), {
    name: 'library',
  }); // 16 digits
  assert.deepEqual(parseHash('#/player/765611980123456789'), {
    name: 'library',
  }); // 18 digits
});

test('#/compare/:id', () => {
  assert.deepEqual(parseHash('#/compare/9'), { name: 'compare', id: 9 });
});

test('prefix routes match with startsWith (extra path stays on the route)', () => {
  assert.deepEqual(parseHash('#/settings'), { name: 'settings' });
  assert.deepEqual(parseHash('#/settings/foo'), { name: 'settings' });
  assert.deepEqual(parseHash('#/builder'), { name: 'builder' });
  assert.deepEqual(parseHash('#/builder/x/y'), { name: 'builder' });
  assert.deepEqual(parseHash('#/explorer'), { name: 'explorer' });
  assert.deepEqual(parseHash('#/reports'), { name: 'reports' });
  assert.deepEqual(parseHash('#/sql'), { name: 'sql' });
});

test('the leading # is optional (hash strings arrive both ways)', () => {
  assert.deepEqual(parseHash('/match/42'), { name: 'match', id: 42 });
  assert.deepEqual(parseHash('/settings'), { name: 'settings' });
});
