// Tests for the hash router (parseHash). The first block was extracted
// verbatim from App.svelte in Phase 0 of the consolidation wave — it
// pins the original route table; the later blocks cover the
// consolidation additions (every match tab deep-linkable, optional
// #/explorer/:id + #/reports/:id context ids, removed tabs falling
// through). Run: node --test src/lib/router.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseHash, MATCH_TABS, matchTabSlug, matchTabFromSlug } from './router.js';

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
});

test('every match tab deep-links as #/match/:id/<slug> (slug = lowercase tab)', () => {
  // One canonical list: MATCH_TABS is what Match.svelte renders, so a
  // deep link can never drift from a tab that exists.
  assert.deepEqual(MATCH_TABS, [
    'Overview',
    'Scoreboard',
    'Rounds',
    'Economy',
    'Utility',
    'Heatmaps',
    'Combat',
    'Timeline',
    'Chat',
    'Context',
  ]);
  assert.equal(new Set(MATCH_TABS.map(matchTabSlug)).size, MATCH_TABS.length);
  for (const tab of MATCH_TABS) {
    const slug = matchTabSlug(tab);
    assert.deepEqual(parseHash(`#/match/42/${slug}`), { name: 'match', id: 42, tab });
    // and the slug round-trips back to the tab name
    assert.equal(matchTabFromSlug(slug), tab);
  }
});

test('plain #/match/:id still defaults to Overview (no tab key)', () => {
  const r = parseHash('#/match/42');
  assert.deepEqual(r, { name: 'match', id: 42 });
  assert.equal(r.tab, undefined);
  // Match.svelte seeds Overview when the route carries no tab.
  assert.equal(matchTabFromSlug('overview'), 'Overview');
});

test('an unknown or removed match-tab segment falls through to the library', () => {
  assert.deepEqual(parseHash('#/match/42/bogus'), { name: 'library' });
  // The Raw tab was removed (its inspectors live in the Explorer view).
  assert.deepEqual(parseHash('#/match/42/raw'), { name: 'library' });
  assert.deepEqual(parseHash('#/match/42/Overview'), { name: 'library' }); // slugs are lowercase
});

test('#/explorer/:id carries an optional match context id', () => {
  assert.deepEqual(parseHash('#/explorer/42'), { name: 'explorer', id: 42 });
  assert.deepEqual(parseHash('#/explorer'), { name: 'explorer' });
  assert.equal('id' in parseHash('#/explorer'), false);
  // prefix semantics stay startsWith (no id extracted from a non-numeric tail)
  assert.deepEqual(parseHash('#/explorer/foo'), { name: 'explorer' });
});

test('#/reports/:id carries an optional match context id', () => {
  assert.deepEqual(parseHash('#/reports/7'), { name: 'reports', id: 7 });
  assert.deepEqual(parseHash('#/reports'), { name: 'reports' });
  assert.equal('id' in parseHash('#/reports'), false);
});

test('a palette jump between match tabs keeps route.name stable (no remount)', () => {
  // App.svelte switches views on route.name only, and re-seeds Match's
  // active tab from route.tab — so "#/match/A/timeline" → "#/match/B/
  // timeline" (CommandPalette's "jump to another match" path) must keep
  // name: 'match' on both sides of the navigation.
  const from = parseHash('#/match/42/timeline');
  const to = parseHash('#/match/7/chat');
  assert.equal(from.name, 'match');
  assert.equal(to.name, 'match');
  assert.equal(from.tab, 'Timeline');
  assert.equal(to.tab, 'Chat');
  // and a tab jump inside one match is still name: 'match' (same view)
  assert.equal(parseHash('#/match/42/combat').name, 'match');
});

test('#/timeline/:id (removed deep-link shape) falls through to the library', () => {
  // Timeline is a match tab (#/match/:id/timeline); the standalone shape
  // is not a route — it lands on the default like any unknown hash, with
  // no rewrite and no legacy key on the parsed route object.
  assert.deepEqual(parseHash('#/timeline/42'), { name: 'library' });
  const hashes = [
    '',
    '#',
    '#/library',
    '#/match/42',
    '#/match/42/timeline',
    '#/match/42/round/7',
    '#/player/76561198012345678',
    '#/compare/9',
    '#/timeline/42',
    '#/replay/42',
    '#/explorer/42',
    '#/reports/42',
    '#/settings',
    '#/builder',
    '#/sql',
  ];
  for (const h of hashes) {
    assert.equal('legacy' in parseHash(h), false, h);
  }
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
