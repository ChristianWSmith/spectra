// Tests for the hash router (parseHash + buildHash): the base route
// table, every match tab deep-linkable, optional
// #/explorer/:id + #/reports/:id context ids, query-carrying routes,
// and the legacy raw-event routes resolving to Replay's landmark feed.
// Run: node --test src/lib/router.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseHash, buildHash, MATCH_TABS, matchTabSlug, matchTabFromSlug } from './router.js';

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
  // and no empty query key either (query-less hashes keep their shape)
  assert.equal('query' in parseHash('#/match/42'), false);
});

test('#/match/:id/round/:n — a round opens on the Rounds tab, expanded (negative rounds allowed)', () => {
  // A round is no longer a page: the old round link lands on the Rounds tab with the round asked open.
  assert.deepEqual(parseHash('#/match/42/round/7'), { name: 'match', id: 42, tab: 'Rounds', query: { round: 7 } });
  assert.deepEqual(parseHash('#/match/42/round/0'), { name: 'match', id: 42, tab: 'Rounds', query: { round: 0 } });
  // a pre-reprocess match's knife/warmup rounds carry negative indices
  assert.deepEqual(parseHash('#/match/42/round/-3?hs=1'), { name: 'match', id: 42, tab: 'Rounds', query: { round: -3, hs: '1' } });
  // The redirected link keeps ?back= (the origin path for the return trip).
  const rd = parseHash('#/match/5/round/7?back=match/5/rounds');
  assert.deepEqual(rd, { name: 'match', id: 5, tab: 'Rounds', query: { round: 7, back: 'match/5/rounds' } });
  // Compare route carries ?rounds= + ?back=.
  const cmp = parseHash('#/compare/5?rounds=3,5,7&back=match/5/rounds');
  assert.deepEqual(cmp.query, { rounds: '3,5,7', back: 'match/5/rounds' });
  // An empty query string is not a query.
  assert.equal('query' in parseHash('#/replay/5?'), false);
});


test('#/reports/:id carries an optional match context id', () => {
  assert.deepEqual(parseHash('#/reports/7'), { name: 'reports', id: 7 });
  assert.deepEqual(parseHash('#/reports'), { name: 'reports' });
  assert.equal('id' in parseHash('#/reports'), false);
});

// The Reports builder is a SIBLING top-level view, never a /reports
// sub-path: `path.startsWith('/reports')` would swallow a /reports-
// prefixed name, so the route lives on its own prefix — pinned here so a
// future rename cannot quietly hand it to the Reports view.
test('#/reportbuilder is its own prefix route (never swallowed by /reports)', () => {
  assert.deepEqual(parseHash('#/reportbuilder'), { name: 'reportbuilder' });
  assert.deepEqual(parseHash('#/reportbuilder/anything'), { name: 'reportbuilder' });
  assert.equal('id' in parseHash('#/reportbuilder'), false);
  // no query key on the plain hash; a query still rides along
  assert.equal('query' in parseHash('#/reportbuilder'), false);
  assert.deepEqual(parseHash('#/reportbuilder?title=abc'), {
    name: 'reportbuilder',
    query: { title: 'abc' },
  });
  // …and the Reports view keeps its own route untouched.
  assert.deepEqual(parseHash('#/reports'), { name: 'reports' });
});

test('#/profiles is a prefix route (the player directory)', () => {
  assert.deepEqual(parseHash('#/profiles'), { name: 'profiles' });
  assert.deepEqual(parseHash('#/profiles/foo'), { name: 'profiles' });
  // no params, and no query key on the plain hash
  assert.equal('id' in parseHash('#/profiles'), false);
  assert.equal('query' in parseHash('#/profiles'), false);
  // a #/profiles query still rides along (prefix + withQuery)
  assert.deepEqual(parseHash('#/profiles?q=donk'), { name: 'profiles', query: { q: 'donk' } });
});

test('a palette jump between match tabs keeps route.name stable (no remount)', () => {
  // App.svelte switches views on route.name only, and re-seeds Match's
  // active tab from route.tab — so "#/match/A/combat" → "#/match/B/
  // combat" (CommandPalette's "jump to another match" path) must keep
  // name: 'match' on both sides of the navigation.
  const from = parseHash('#/match/42/combat');
  const to = parseHash('#/match/7/economy');
  assert.equal(from.name, 'match');
  assert.equal(to.name, 'match');
  assert.equal(from.tab, 'Combat');
  assert.equal(to.tab, 'Economy');
  // and a tab jump inside one match is still name: 'match' (same view)
  assert.equal(parseHash('#/match/42/utility').name, 'match');
  // A legacy-tab jump lands on replay on BOTH sides (name stays stable,
  // the view is Replay, not Match).
  assert.equal(parseHash('#/match/42/chat').name, 'replay');
});

test('#/timeline/:id (removed deep-link shape) falls through to the library', () => {
  assert.deepEqual(parseHash('#/timeline/42'), { name: 'library' });
  const hashes = [
    '',
    '#',
    '#/library',
    '#/match/42',
    '#/match/42/round/7',
    '#/player/76561198012345678',
    '#/compare/9',
    '#/timeline/42',
    '#/replay/42',
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

test('#/player/:steamid carries ?back= (the profile return trip)', () => {
  assert.deepEqual(parseHash('#/player/76561198012345678?back=profiles'), {
    name: 'player',
    steamId: '76561198012345678',
    query: { back: 'profiles' },
  });
  // Origin paths keep their slashes (and their own query) — the same
  // readable-URL rule buildHash applies when stamping them.
  assert.equal(
    parseHash('#/player/76561198012345678?back=match/5/scoreboard').query.back,
    'match/5/scoreboard',
  );
  assert.equal(
    parseHash('#/player/76561198012345678?back=compare/5?rounds=3,5').query.back,
    'compare/5?rounds=3,5',
  );
});

test('#/compare/:id', () => {
  assert.deepEqual(parseHash('#/compare/9'), { name: 'compare', id: 9 });
});

test('prefix routes match with startsWith (extra path stays on the route)', () => {
  assert.deepEqual(parseHash('#/settings'), { name: 'settings' });
  assert.deepEqual(parseHash('#/settings/foo'), { name: 'settings' });
  assert.deepEqual(parseHash('#/builder'), { name: 'builder' });
  assert.deepEqual(parseHash('#/builder/x/y'), { name: 'builder' });
  assert.deepEqual(parseHash('#/reports'), { name: 'reports' });
  assert.deepEqual(parseHash('#/profiles'), { name: 'profiles' });
  assert.deepEqual(parseHash('#/sql'), { name: 'sql' });
});

test('the leading # is optional (hash strings arrive both ways)', () => {
  assert.deepEqual(parseHash('/match/42'), { name: 'match', id: 42 });
  assert.deepEqual(parseHash('/settings'), { name: 'settings' });
});

test('buildHash renders path + query; "/" stays readable, empties drop', () => {
  assert.equal(buildHash('/replay/5', {}), '/replay/5');
  assert.equal(buildHash('/replay/5', { cat: 'kills,chat', round: 7 }), '/replay/5?cat=kills,chat&round=7');
  // back= origin paths keep their slashes (readable URLs).
  assert.equal(buildHash('/match/5/round/7', { back: 'match/5/rounds' }), '/match/5/round/7?back=match/5/rounds');
  // null/undefined values drop (unset); explicit "" survives — "?cat="
  // is the meaningful "no categories" state.
  assert.equal(buildHash('/replay/5', { cat: '', tick: null, sel: undefined, round: 3 }), '/replay/5?cat=&round=3');
  // Values still encode their own specials.
  assert.equal(buildHash('/replay/5', { bbox: 'a b&c' }), '/replay/5?bbox=a%20b%26c');
  // Round-trips through parseHash.
  const h = buildHash('/replay/5', { cat: 'kills,chat', back: 'match/5/combat' });
  assert.deepEqual(parseHash('#' + h), {
    name: 'replay',
    id: 5,
    query: { cat: 'kills,chat', back: 'match/5/combat' },
  });
});
