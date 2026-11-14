// The ordering mechanism's contract pins (dogfooding design §1): the
// default tables ship exactly as §1.6, resolveOrder implements §1.4's
// whole contract (default sequence, saved order, new-seed insertion,
// ∞-append, deleted/renamed/scope-changed filtering, dedupe), the
// absent-vs-present pins rule (§1.6), the composition (∩ pins), and
// the read/write/reset routing over the kvstore pref keys (§1.2).
//
// services.js loads against the shared TEST STUBS for its bindings
// (the same redirect services-cache.test.js uses) — the real bindings
// talk to a live Wails backend. Run from frontend/:
//   node --test src/lib/metricorder.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

import { registerHooks } from 'node:module';
import { installEsmDirHook } from '../../test/esm-dir-hook.mjs';

installEsmDirHook();

const stub = (name) => new URL(`../../test/stubs/${name}`, import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@wailsio/runtime') return { url: stub('wails-runtime.mjs'), shortCircuit: true };
    if (specifier.includes('bindings/github.com')) return { url: stub('bindings.mjs'), shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const mo = await import('./metricorder.js');
const bindings = await import('../../test/stubs/bindings.mjs');

const {
  ORDER_KEYS,
  DEFAULT_RANKS,
  DEFAULT_PINS,
  FIXED_BLOCK,
  fixedBlock,
  defaultRanker,
  resolveOrder,
  inSequence,
  pinnedInSequence,
  resolvePinIds,
  readOrder,
  writeOrder,
  resetOrder,
} = mo;

// --- The tables ship exactly as design §1.6 ---------------------------------

test('ORDER_KEYS are the two bare kvstore keys (no version marker)', () => {
  assert.deepEqual(ORDER_KEYS, { match: 'metric_order_match', profile: 'metric_order_profile' });
  // Pre-release no-versioning policy (§3.7.2): no v1/ladder anywhere.
  assert.ok(!Object.values(ORDER_KEYS).some((k) => /\bv\d\b|version|_v/.test(k)));
});

test('DEFAULT_RANKS.match replicates today\'s scoreboard: adr, kast, hs_pct, kd', () => {
  assert.deepEqual(DEFAULT_RANKS.match, { adr: 1, kast: 2, hs_pct: 3, kd: 4 });
});

test('DEFAULT_RANKS.profile replicates today\'s card grid (nine converted cards)', () => {
  assert.deepEqual(DEFAULT_RANKS.profile, {
    career_adr: 1,
    career_adr_sigma: 2,
    career_kd: 3,
    career_hs_pct: 4,
    career_kast: 5,
    career_trade_rate: 6,
    career_clutch_win_rate: 7,
    career_avg_enemies_flashed: 8,
    career_avg_util_damage: 9,
  });
});

test('DEFAULT_PINS: match = the four always-on columns (NOT trade_rate), profile = the nine cards', () => {
  assert.deepEqual(DEFAULT_PINS.match, ['adr', 'kast', 'hs_pct', 'kd']);
  assert.deepEqual(DEFAULT_PINS.profile, Object.keys(DEFAULT_RANKS.profile));
});

test('FIXED_BLOCK: the Go stats\' labels minus the converted entries (post-conversion order)', () => {
  assert.deepEqual(FIXED_BLOCK.match, [
    'Name', 'Team', 'K', 'D', 'A', 'KDA', 'DMG', 'Rnds',
    '2K', '3K', '4K', '5K', 'Entry', 'Trade', 'Opening K/D',
    'Streak', 'Util', 'MVPs', 'Score',
  ]);
  assert.deepEqual(FIXED_BLOCK.profile, ['Matches', 'Win%', 'Opening duels', 'Clutches']);
  // Never reorderable: the accessor returns the same constant list.
  assert.equal(fixedBlock('match'), FIXED_BLOCK.match);
  assert.deepEqual(fixedBlock('nope'), []);
});

// --- resolveOrder: §1.4's whole contract ------------------------------------

test('absent pref → the default sequence (rank asc, catalog index as tiebreak)', () => {
  // Catalog deliberately unsorted; user/plugin names carry rank ∞ and
  // keep their CATALOG order after the ranked ones.
  const catalog = ['kd', 'u_second', 'adr', 'u_first', 'kast', 'plug_a', 'hs_pct'];
  assert.deepEqual(resolveOrder(null, catalog, 'match'), [
    'adr', 'kast', 'hs_pct', 'kd', 'u_second', 'u_first', 'plug_a',
  ]);
  // Non-array saved (corrupt pref) reads as absent — same default.
  assert.deepEqual(resolveOrder(undefined, catalog, 'match'), resolveOrder(null, catalog, 'match'));
});

test('present-but-empty order pref resolves to the same default sequence', () => {
  const catalog = ['kd', 'adr', 'kast', 'hs_pct', 'u1'];
  assert.deepEqual(resolveOrder([], catalog, 'match'), resolveOrder(null, catalog, 'match'));
});

test('saved order wins for its entries; relative saved order is preserved', () => {
  // u1 before kast stays u1-before-kast; adr (rank 1) still slots first.
  const catalog = ['adr', 'kast', 'u1'];
  assert.deepEqual(resolveOrder(['u1', 'kast'], catalog, 'match'), ['adr', 'u1', 'kast']);
});

test('a newly seeded metric inserts before its default-rank successor wherever it sits', () => {
  // kast (rank 2) lands immediately before hs_pct (rank 3), wherever
  // the pref put hs_pct — the user's arrangement is not reset.
  const catalog = ['hs_pct', 'adr', 'kast', 'kd'];
  assert.deepEqual(resolveOrder(['hs_pct'], catalog, 'match'), ['adr', 'kast', 'hs_pct', 'kd']);
  // …and the literal §1.4 rule: the insertion point is the FIRST index
  // whose rank is greater, so a rank-∞ entry ahead of the successor
  // counts as a greater rank and the seed lands before it (documented
  // nuance of "wherever that successor sits").
  assert.deepEqual(resolveOrder(['u1', 'hs_pct'], ['u1', 'hs_pct', 'adr', 'kast'], 'match'), [
    'adr', 'kast', 'u1', 'hs_pct',
  ]);
  // If every ranked successor is gone, the seed still lands at its rank
  // head — never appended behind ranked entries.
  assert.deepEqual(resolveOrder(['u1'], ['u1', 'adr'], 'match'), ['adr', 'u1']);
});

test('user/plugin metrics (rank ∞) append, in catalog order, until moved', () => {
  const catalog = ['u2', 'kd', 'u1', 'plug_a'];
  assert.deepEqual(resolveOrder(['kd'], catalog, 'match'), ['kd', 'u2', 'u1', 'plug_a']);
});

test('deleted names drop out at read time — no writer needs to know about deletes', () => {
  const catalog = ['kd', 'adr'];
  assert.deepEqual(resolveOrder(['kd', 'ghost', 'adr'], catalog, 'match'), ['kd', 'adr']);
  // …and the ghost never re-enters through step 3 (it is not in catalog).
  assert.ok(!resolveOrder(['ghost'], catalog, 'match').includes('ghost'));
});

test('a renamed user metric: old name drops, unknown new name appends (rank ∞)', () => {
  const catalog = ['kd', 'renamed_stat'];
  assert.deepEqual(resolveOrder(['old_stat', 'kd'], catalog, 'match'), ['kd', 'renamed_stat']);
});

test('a scope-changed name never enters the other scope\'s sequence', () => {
  // career_kd is profile-scope: it drops from the match sequence (it is
  // not in the match catalog) and the match names resolve normally.
  const matchCatalog = ['kd', 'adr'];
  assert.deepEqual(resolveOrder(['career_kd', 'kd'], matchCatalog, 'match'), ['adr', 'kd']);
  // The profile side picks the new name up at its default rank.
  const profileCatalog = ['career_kd'];
  assert.deepEqual(resolveOrder(null, profileCatalog, 'profile'), ['career_kd']);
});

test('dedupe: duplicate saved names collapse to their first occurrence', () => {
  const catalog = ['adr', 'kd'];
  assert.deepEqual(resolveOrder(['kd', 'kd', 'adr', 'kd'], catalog, 'match'), ['kd', 'adr']);
  // Duplicate catalog names also collapse (first occurrence wins).
  assert.deepEqual(resolveOrder(null, ['kd', 'kd', 'adr'], 'match'), ['adr', 'kd']);
});

// --- The absent-vs-present PINS rule (§1.6) ---------------------------------

test('absent pins key → DEFAULT_PINS resolved by name through the catalog', () => {
  const catalog = [
    { id: 7, name: 'trade_rate' },
    { id: 3, name: 'kd' },
    { id: 1, name: 'adr' },
  ];
  // DEFAULT_PINS order (not catalog order): kast/hs_pct are not seeded
  // yet → resolve to nothing; the resolved ids keep the DEFAULT order.
  assert.deepEqual(resolvePinIds('match', null, catalog), [1, 3]);
  // Before W2's seeds (no default names in the catalog) → [] — exactly
  // today's "absent ⇒ []" behaviour, no visible change.
  assert.deepEqual(resolvePinIds('match', null, []), []);
  assert.deepEqual(resolvePinIds('profile', null, []), []);
});

test('present pins key → the stored selection verbatim, even empty', () => {
  const catalog = [
    { id: 1, name: 'adr' },
    { id: 3, name: 'kd' },
  ];
  assert.deepEqual(resolvePinIds('match', [], catalog), [], "explicit '[]' is never overridden");
  assert.deepEqual(resolvePinIds('match', [7], catalog), [7], 'even a non-default id');
  assert.deepEqual(resolvePinIds('match', [3, 1], catalog), [3, 1], 'stored order kept (selection, not sequence)');
});

// --- The composition: resolveOrder ∩ pins (§1.3) ----------------------------

test('inSequence scope-filters the defs and orders them by sequence', () => {
  const defs = [
    { id: 1, name: 'adr', scope: 'match' },
    { id: 2, name: 'career_kd', scope: 'profile' },
    { id: 3, name: 'u1', scope: 'match' },
    { id: 4, name: 'kast', scope: 'match' },
  ];
  assert.deepEqual(inSequence('match', null, defs).map((d) => d.name), ['adr', 'kast', 'u1']);
  assert.deepEqual(inSequence('profile', null, defs).map((d) => d.name), ['career_kd']);
  assert.deepEqual(inSequence('match', ['u1'], defs).map((d) => d.name), ['adr', 'kast', 'u1']);
});

test('pinnedInSequence: pins SELECT, the sequence ORDERS (pins array order ignored)', () => {
  const defs = [
    { id: 1, name: 'adr', scope: 'match' },
    { id: 2, name: 'u1', scope: 'match' },
    { id: 3, name: 'kast', scope: 'match' },
  ];
  // Pinned in the "wrong" order — render order is still the sequence:
  // adr (rank 1) then u1 (∞); kast is not pinned, so it never renders.
  assert.deepEqual(
    pinnedInSequence('match', null, defs, [2, 1]).map((d) => d.name),
    ['adr', 'u1'],
  );
  // Unpinning re-selects without rewriting the sequence; a later pin
  // appears exactly where the sequence puts it (not appended).
  assert.deepEqual(
    pinnedInSequence('match', null, defs, [3, 2]).map((d) => d.name),
    ['kast', 'u1'],
  );
});

// --- read / write / reset route the scope keys (§1.2) -----------------------

test('readOrder: the scope key round-trips; absent/corrupt reads as null', async () => {
  bindings.resetCalls();
  bindings.handlers.GetPref = (key) =>
    key === 'metric_order_match' ? ['kd', 'adr', 5] : key === 'metric_order_profile' ? 42 : undefined;
  assert.deepEqual(await readOrder('match'), ['kd', 'adr'], 'non-string entries filter out');
  assert.equal(await readOrder('profile'), null, 'non-array pref reads as absent (default)');
  delete bindings.handlers.GetPref;
  bindings.resetCalls();
  assert.equal(await readOrder('match'), null, 'absent key → null → default sequence');
  assert.deepEqual(
    bindings.calls.map((c) => [c.method, c.args]),
    [['GetPref', ['metric_order_match']]],
    'one GetPref with the bare key',
  );
});

test('writeOrder persists the FULL sequence under the scope key', async () => {
  bindings.resetCalls();
  await writeOrder('match', ['adr', 'kd', 'u1']);
  await writeOrder('profile', ['career_kd']);
  assert.deepEqual(bindings.calls, [
    { method: 'SetPref', args: ['metric_order_match', ['adr', 'kd', 'u1']] },
    { method: 'SetPref', args: ['metric_order_profile', ['career_kd']] },
  ]);
});

test('resetOrder deletes the key (both scopes route to their own key)', async () => {
  bindings.resetCalls();
  await resetOrder('match');
  await resetOrder('profile');
  assert.deepEqual(bindings.calls, [
    { method: 'Delete', args: ['metric_order_match'] },
    { method: 'Delete', args: ['metric_order_profile'] },
  ]);
  // After a delete the next read is absent again → step 2, the default.
  bindings.handlers.GetPref = () => undefined;
  assert.equal(await readOrder('match'), null);
  delete bindings.handlers.GetPref;
});

test('defaultRanker: unranked/user names are ∞, unknown scopes rank everything ∞', () => {
  const rank = defaultRanker('match');
  assert.equal(rank('adr'), 1);
  assert.equal(rank('not_seeded_yet'), Infinity);
  assert.equal(defaultRanker('profile')('career_kd'), 3);
  assert.equal(defaultRanker('nope')('adr'), Infinity, 'a bogus scope never ranks anything');
});
