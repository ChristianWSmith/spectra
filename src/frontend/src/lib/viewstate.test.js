// Tests for lib/viewstate.svelte.js — THE process-scoped view-state
// registry: seed-over-defaults (with the whitelist + shape gate),
// remember/restore round-trips, resetViewState() as the cross-test
// isolation hook, matchKey()'s cross-match isolation, and the PURE
// navigation arbiter arbitrate(prev, route) → next (the keepalive.js
// discipline: same inputs → same output, no hidden globals).
// Run: node --test src/lib/viewstate.test.js   (from frontend/)
//
// jsdom driver cross-talk note (mirrored in the module header): the
// drivers import this SAME module instance per suite, so driver pins
// call resetViewState() in their setup — every case here does too.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  seed,
  remember,
  resetViewState,
  matchKey,
  arbitrate,
  captureScroll,
  scrollTopFor,
} from './viewstate.svelte.js';

// Route shapes exactly as parseHash produces them (router.js) — the
// same literal-shape style keepalive.test.js uses.
const replay = (id) => ({ name: 'replay', id });
const match = (id, tab) => ({ name: 'match', id, ...(tab ? { tab } : {}) });
const round = (id, n) => ({ name: 'round', id, round: n });
const library = { name: 'library' };
const sql = { name: 'sql' };

test('seed: absent entry → the defaults, as a FRESH object every call', () => {
  resetViewState();
  const dflt = () => ({ sortKey: 'extracted_at', desc: true });
  const a = seed('library', dflt());
  assert.deepEqual(a, { sortKey: 'extracted_at', desc: true });
  // The caller owns the object: mutating it must not become registry
  // state (write-through is remember()'s job only).
  a.sortKey = 'map';
  assert.deepEqual(seed('library', dflt()), { sortKey: 'extracted_at', desc: true });
  // Two seeds never alias each other either.
  const b = seed('library', dflt());
  b.desc = false;
  assert.equal(seed('library', dflt()).desc, true);
});

test('seed: a recorded entry merges OVER the defaults, whitelisted to their keys', () => {
  resetViewState();
  remember('combat', { engKind: 'trade' });
  const got = seed('combat', { engKind: '', clutchWon: true });
  // Recorded field wins; fields it never recorded keep their defaults.
  assert.deepEqual(got, { engKind: 'trade', clutchWon: true });

  // Keys outside the defaults never surface (a stray remember() cannot
  // widen a view's shape).
  remember('combat', { junk: 42, loading: true });
  assert.deepEqual(Object.keys(seed('combat', { engKind: '' })).sort(), ['engKind']);
});

test('seed: wrong-shaped recorded values are rejected per field (invalid entry → defaults)', () => {
  resetViewState();
  // Array defaults only accept arrays (compareSel is round numbers).
  remember('match:5:scoreboard', { compareSel: [3, 5], expanded: 0 });
  assert.deepEqual(seed('match:5:scoreboard', { compareSel: [], expanded: 0 }).compareSel, [3, 5]);
  remember('match:5:scoreboard', { compareSel: 'not-an-array' });
  assert.deepEqual(seed('match:5:scoreboard', { compareSel: [], expanded: 0 }).compareSel, []);

  // Scalar defaults keep their type: a number where a string belongs
  // (and vice versa) falls back to the default, never a coercion.
  remember('heat', { kind: 42 });
  assert.equal(seed('heat', { kind: 'presence' }).kind, 'presence');
  remember('heat', { kind: 'kd', roundFrom: '17' });
  const h = seed('heat', { kind: 'presence', roundFrom: -1 });
  assert.equal(h.kind, 'kd'); // same shape → restored
  assert.equal(h.roundFrom, -1); // string vs number → default

  // Object defaults reject non-objects; null defaults (the Heatmaps
  // grid before its first Generate) accept null and an object.
  remember('stat', { statSort: 'kastPct' });
  assert.deepEqual(seed('stat', { statSort: { key: 'kastPct', desc: true } }).statSort, {
    key: 'kastPct',
    desc: true,
  });
  remember('grid', { grid: { w: 64, h: 64 } });
  assert.deepEqual(seed('grid', { grid: null }).grid, { w: 64, h: 64 });
  remember('grid', { grid: 7 });
  assert.equal(seed('grid', { grid: null }).grid, null);
});

test('remember: write-through round-trip — partials merge, repeated writes accumulate', () => {
  resetViewState();
  remember('sql', { sql: 'select 1' });
  assert.equal(seed('sql', { sql: '' }).sql, 'select 1');
  remember('sql', { sql: 'select 2' }); // last write wins per field
  assert.equal(seed('sql', { sql: '' }).sql, 'select 2');

  // A partial that carries no defaults' keys still round-trips through
  // seed's whitelist without widening the shape.
  remember('builder', { form: { name: 'x' }, baseline: 'b' });
  const b = seed('builder', { form: { name: '' }, baseline: '' });
  assert.deepEqual(b, { form: { name: 'x' }, baseline: 'b' });

  // Defensive: a non-object partial is ignored, a bogus key is refused.
  remember('sql', null);
  remember('sql', 'nope');
  remember('', { sql: 'x' });
  assert.equal(seed('sql', { sql: '' }).sql, 'select 2');
});

test('resetViewState: clears EVERYTHING (the cross-test / cross-driver isolation hook)', () => {
  resetViewState();
  remember('library', { sortKey: 'map', desc: false });
  remember('match:5:combat', { engKind: 'opening' });
  remember('scroll:library', { top: 400 });
  assert.equal(seed('library', { sortKey: 'extracted_at', desc: true }).sortKey, 'map');
  assert.equal(seed('match:5:combat', { engKind: '' }).engKind, 'opening');
  assert.equal(scrollTopFor('library'), 400);

  resetViewState();
  assert.deepEqual(seed('library', { sortKey: 'extracted_at', desc: true }), {
    sortKey: 'extracted_at',
    desc: true,
  });
  assert.equal(seed('match:5:combat', { engKind: '' }).engKind, '');
  assert.equal(scrollTopFor('library'), 0);
});

test('matchKey: THE match-scoped key — match A never seeds into match B', () => {
  resetViewState();
  assert.equal(matchKey('combat', 5), 'match:5:combat');
  // The shape is the contract (stable across runs — a change here is a
  // change to every stored key).
  assert.equal(matchKey('heatmaps', 12), 'match:12:heatmaps');

  remember(matchKey('heatmaps', 5), { kind: 'kd', player: '76561198000000001' });
  // Same view, another match: fresh defaults — the foreign record is
  // unreachable under this key.
  assert.deepEqual(seed(matchKey('heatmaps', 6), { kind: 'presence', player: '' }), {
    kind: 'presence',
    player: '',
  });
  // Match A's own record is still there when its view comes back.
  assert.deepEqual(seed(matchKey('heatmaps', 5), { kind: 'presence', player: '' }), {
    kind: 'kd',
    player: '76561198000000001',
  });
  // A different view under the same match does not share either.
  assert.equal(seed(matchKey('combat', 5), { engKind: '' }).engKind, '');
});

test('arbitrate: boot and missing inputs → null (nothing to restore, nothing touched)', () => {
  assert.equal(arbitrate(null, library), null); // before the first navigation
  assert.equal(arbitrate({ key: 'library', top: 10 }, null), null);
  assert.equal(arbitrate(undefined, undefined), null);
  // A route with no scroll key (unknown shape) never arbitrates a key.
  assert.equal(arbitrate({ key: 'library', top: 10 }, { name: 'wat' }), null);
});

test('arbitrate: same view → keep (position carries); another view → restore', () => {
  // A query-only change on the same view: keep — the container is the
  // same DOM, the position must not jump.
  assert.deepEqual(arbitrate({ key: 'library', top: 120 }, library), {
    key: 'library',
    keep: true,
  });
  // A match TAB hop shares the match's key (view-level scroll): keep —
  // exactly today's in-place tab swap.
  assert.deepEqual(arbitrate({ key: 'match:5', top: 300 }, match(5, 'Combat')), {
    key: 'match:5',
    keep: true,
  });
  assert.deepEqual(arbitrate({ key: 'match:5', top: 300 }, match(5)), {
    key: 'match:5',
    keep: true,
  });
  // Another match is another view: restore from the new key's record.
  assert.deepEqual(arbitrate({ key: 'match:5', top: 300 }, match(6)), {
    key: 'match:6',
    keep: false,
  });
  // Sidebar hops between distinct views: every hop restores its own key.
  assert.deepEqual(arbitrate({ key: 'match:5', top: 300 }, library), {
    key: 'library',
    keep: false,
  });
  assert.deepEqual(arbitrate({ key: 'library', top: 40 }, sql), {
    key: 'sql',
    keep: false,
  });
  // Distinct views that merely share an id namespace stay distinct.
  assert.deepEqual(arbitrate({ key: 'match:5', top: 10 }, round(5, 3)), {
    key: 'round:5',
    keep: false,
  });
  assert.deepEqual(arbitrate({ key: 'round:5', top: 10 }, replay(5)), {
    key: 'replay:5',
    keep: false,
  });
});

test('arbitrate: pure — same inputs → same output, no hidden globals (registry-blind)', () => {
  const prev = { key: 'match:5', top: 300 };
  const route = match(6);
  const first = arbitrate(prev, route);
  // Registry state cannot leak in: pollute it, reset it, ask again.
  remember('match:6', { top: 999 });
  remember('scroll:match:6', { top: 999 });
  assert.deepEqual(arbitrate(prev, route), first);
  resetViewState();
  assert.deepEqual(arbitrate(prev, route), first);
  // And a different record shape never throws (the key comparison is
  // the only thing that matters).
  assert.deepEqual(arbitrate({ key: 'nope' }, route), { key: 'match:6', keep: false });
  assert.equal(arbitrate({ top: 1 }, route).key, 'match:6');
});

test('captureScroll / scrollTopFor: leave-time record + registry round-trip', () => {
  resetViewState();
  // Leaving a view records its scrollTop under its key and returns the
  // record arbitrate() consumes next navigation.
  const rec = captureScroll(match(5), 412.5);
  assert.deepEqual(rec, { key: 'match:5', top: 412.5 });
  assert.equal(scrollTopFor('match:5'), 412.5);
  // A never-scrolled view restores to 0 (the default), and junk in the
  // entry never reaches the container (sameKind gate).
  assert.equal(scrollTopFor('match:6'), 0);
  remember('scroll:sql', { top: 'down' });
  assert.equal(scrollTopFor('sql'), 0);

  // A route with no scroll key still yields a record — key '' matches
  // no real key, so the NEXT view restores from the registry instead of
  // keeping whatever was on screen (replay-without-back beneath).
  const none = captureScroll(null, 250);
  assert.deepEqual(none, { key: '', top: 250 });
  assert.deepEqual(arbitrate(none, library), { key: 'library', keep: false });
  // Garbage tops normalize to 0 (never NaN into the container).
  assert.deepEqual(captureScroll(library, undefined), { key: 'library', top: 0 });
  assert.deepEqual(captureScroll(library, -5), { key: 'library', top: 0 });
  // Nothing recorded for a key-less route (no entry, no pollution).
  assert.equal(scrollTopFor(''), 0);
});

test('URL-wins by construction: the registry only carries what seed() is asked for', () => {
  // The registry never holds navigation state because no view passes
  // URL-owned fields to seed()/remember() — this pins the shape side of
  // that invariant: a remembered entry surfaces ONLY the keys a view
  // declares as its defaults (so a query param can never be double-
  // stored through a careless partial, and a seeded value can never
  // widen into one).
  resetViewState();
  remember('library', { map: 'de_mirage', player: '76561198000000001', sortKey: 'map' });
  const got = seed('library', { sortKey: 'extracted_at', desc: true });
  assert.deepEqual(got, { sortKey: 'map', desc: true }); // facets invisible
});
