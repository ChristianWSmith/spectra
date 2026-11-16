// The ordering mechanism's contract pins (dogfooding design §1, extended
// by W6): the default tables ship exactly as §1.6, resolveOrder
// implements §1.4's whole contract (default sequence, saved order,
// new-seed insertion, ∞-append, deleted/renamed/scope-changed
// filtering, dedupe) over the MERGED universe (fixed stats as
// '@'-namespaced sequence entries with negative ranks + metrics), the
// absent-vs-present pins rule (§1.6), the compositions (the metric-only
// ∩ pins, and the one merged composedSequence), the visibility pref
// pair, and the read/write/reset routing over the kvstore pref keys
// (§1.2).
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
  HIDDEN_KEYS,
  DEFAULT_RANKS,
  DEFAULT_PINS,
  FIXED_BLOCK,
  FIXED_RANKS,
  RAW_FIELDS,
  fixedKeys,
  hideable,
  defaultRanker,
  resolveOrder,
  inSequence,
  pinnedInSequence,
  composedSequence,
  rawItems,
  isRawId,
  resolvePinIds,
  readOrder,
  writeOrder,
  resetOrder,
  readHidden,
  writeHidden,
  resetHidden,
} = mo;

// The METRIC half of a resolved sequence — the fixed keys stripped,
// which is exactly what inSequence renders (resolveOrder itself
// returns the whole merged universe; these assertions are about the
// metric sequencing contract §1.4 pinned before W6, so they read it
// through the same strip the production caller uses).
const metricsOnly = (saved, catalog, scope = 'match') =>
  resolveOrder(saved, catalog, scope).filter((n) => !n.startsWith('@'));

// --- The tables ship exactly as design §1.6 ---------------------------------

test('ORDER_KEYS are the two bare kvstore keys (no version marker)', () => {
  assert.deepEqual(ORDER_KEYS, { match: 'metric_order_match', profile: 'metric_order_profile' });
  // Pre-release no-versioning policy (§3.7.2): no v1/ladder anywhere.
  assert.ok(!Object.values(ORDER_KEYS).some((k) => /\bv\d\b|version|_v/.test(k)));
});

test('HIDDEN_KEYS are the two bare visibility keys (no version marker)', () => {
  assert.deepEqual(HIDDEN_KEYS, { match: 'metric_hidden_match', profile: 'metric_hidden_profile' });
  assert.ok(!Object.values(HIDDEN_KEYS).some((k) => /\bv\d\b|version|_v/.test(k)));
  // The pair never collides with the order pair (they are read side by side).
  assert.ok(!Object.values(HIDDEN_KEYS).some((k) => Object.values(ORDER_KEYS).includes(k)));
});

test('DEFAULT_RANKS.match replicates today\'s scoreboard: the twelve converted columns in display order', () => {
  assert.deepEqual(DEFAULT_RANKS.match, {
    assists: 1,
    adr: 2,
    kast: 3,
    hs_pct: 4,
    kd: 5,
    two_k: 6,
    three_k: 7,
    four_k: 8,
    five_k: 9,
    entry_kills: 10,
    trade_kills: 11,
    best_streak: 12,
  });
});

test('DEFAULT_RANKS.profile replicates today\'s card grid (eleven converted cards)', () => {
  assert.deepEqual(DEFAULT_RANKS.profile, {
    career_adr: 1,
    career_adr_sigma: 2,
    career_kd: 3,
    career_hs_pct: 4,
    career_kast: 5,
    career_opening_rate: 6,
    career_trade_rate: 7,
    career_clutches: 8,
    career_clutch_win_rate: 9,
    career_avg_enemies_flashed: 10,
    career_avg_util_damage: 11,
  });
});

test('DEFAULT_PINS: match = the twelve always-on columns (NOT trade_rate), profile = the eleven cards', () => {
  assert.deepEqual(DEFAULT_PINS.match, [
    'assists',
    'adr',
    'kast',
    'hs_pct',
    'kd',
    'two_k',
    'three_k',
    'four_k',
    'five_k',
    'entry_kills',
    'trade_kills',
    'best_streak',
  ]);
  assert.deepEqual(DEFAULT_PINS.profile, Object.keys(DEFAULT_RANKS.profile));
  // The pins select exactly the ranked match set (the §4.3 invariant).
  assert.deepEqual(DEFAULT_PINS.match, Object.keys(DEFAULT_RANKS.match));
  // PINs are metric ids only — a fixed key never enters the selection.
  assert.ok([...DEFAULT_PINS.match, ...DEFAULT_PINS.profile].every((n) => !n.startsWith('@')));
});

test('FIXED_BLOCK: the Go stats\' labels minus the converted entries (unchanged labels)', () => {
  // Rnds is gone with the owner's C14 scoreboard change (the column
  // left SCORE_COLS too — metricorder mirrors it, never leads it).
  assert.deepEqual(FIXED_BLOCK.match, [
    'Name', 'Team', 'K', 'D', 'KDA', 'DMG', 'Opening K/D',
    'Util', 'MVPs', 'Score',
  ]);
  assert.deepEqual(FIXED_BLOCK.profile, ['Matches', 'Win%']);
});

// --- The fixed namespace + its negative ranks (W6) ---------------------------

test('fixedKeys: every fixed entry is its "@"+label namespaced key, in canonical order', () => {
  assert.deepEqual(
    fixedKeys('match'),
    FIXED_BLOCK.match.map((l) => `@${l}`),
  );
  assert.deepEqual(fixedKeys('profile'), ['@Matches', '@Win%']);
  assert.deepEqual(fixedKeys('nope'), []);
  // The namespace is the identity: '@' can never appear in a metric
  // name, so a fixed entry and a metric can never be the same key.
  assert.ok(fixedKeys('match').every((k) => k.startsWith('@')));
});

test('FIXED_RANKS: negative, one per fixed entry, in canonical order (absent pref ⇒ fixed leads)', () => {
  assert.deepEqual(FIXED_RANKS.match, {
    '@Name': -10,
    '@Team': -9,
    '@K': -8,
    '@D': -7,
    '@KDA': -6,
    '@DMG': -5,
    '@Opening K/D': -4,
    '@Util': -3,
    '@MVPs': -2,
    '@Score': -1,
  });
  assert.deepEqual(FIXED_RANKS.profile, { '@Matches': -2, '@Win%': -1 });
  // Every fixed key ranks below every metric rank — that is what makes
  // an old metric-name-only pref re-insert the fixed block ahead of it.
  const matchRank = defaultRanker('match');
  assert.ok(Object.keys(FIXED_RANKS.match).every((k) => matchRank(k) < 1));
  assert.ok(Object.keys(DEFAULT_RANKS.match).every((n) => matchRank(n) > 0));
  assert.equal(matchRank('not_seeded_yet'), Infinity, 'a metric name is never a fixed key');
});

test('hideable: every fixed stat but the scoreboard Name column (owner ruling — only Name is exempt)', () => {
  for (const key of fixedKeys('match')) {
    assert.equal(hideable('match', key), key !== '@Name', `match ${key}`);
  }
  // Profile has no Name — both of its fixed stats are hideable.
  for (const key of fixedKeys('profile')) {
    assert.equal(hideable('profile', key), true, `profile ${key}`);
  }
  // A metric key (or anything else) is never hideable: metric
  // visibility stays pin-driven.
  assert.equal(hideable('match', 'kd'), false);
  assert.equal(hideable('match', '@NoSuchStat'), false);
  assert.equal(hideable('nope', '@K'), false);
});

// --- resolveOrder: §1.4's whole contract (over the merged universe) ----------

test('absent pref → the default sequence (fixed block first, then rank asc, catalog index as tiebreak)', () => {
  // Catalog deliberately unsorted; user/plugin names carry rank ∞ and
  // keep their CATALOG order after the ranked ones.
  const catalog = ['kd', 'u_second', 'adr', 'u_first', 'kast', 'plug_a', 'hs_pct'];
  assert.deepEqual(resolveOrder(null, catalog, 'match'), [
    '@Name', '@Team', '@K', '@D', '@KDA', '@DMG', '@Opening K/D', '@Util', '@MVPs', '@Score',
    'adr', 'kast', 'hs_pct', 'kd', 'u_second', 'u_first', 'plug_a',
  ]);
  // The metric half alone is the pre-W6 default sequence (the contract
  // those tests pinned before fixed stats joined it).
  assert.deepEqual(metricsOnly(null, catalog, 'match'), [
    'adr', 'kast', 'hs_pct', 'kd', 'u_second', 'u_first', 'plug_a',
  ]);
  // Non-array saved (corrupt pref) reads as absent — same default.
  assert.deepEqual(resolveOrder(undefined, catalog, 'match'), resolveOrder(null, catalog, 'match'));
  // Profile leads with Matches, Win%.
  assert.deepEqual(resolveOrder(null, ['career_kd'], 'profile'), [
    '@Matches', '@Win%', 'career_kd',
  ]);
});

test('present-but-empty order pref resolves to the same default sequence', () => {
  const catalog = ['kd', 'adr', 'kast', 'hs_pct', 'u1'];
  assert.deepEqual(resolveOrder([], catalog, 'match'), resolveOrder(null, catalog, 'match'));
});

test('a stored METRIC-NAME-ONLY array re-inserts every fixed entry ahead of it (today\'s rendering, no migration)', () => {
  // Every pref written before W6 carries metric names only — the fixed
  // keys are unknown to it, so step 3 re-inserts them at their negative
  // ranks: ahead of every metric, in canonical order. The ranked metric
  // the pref omitted still lands at ITS default rank inside the metric
  // half (the §1.4 seed rule, unchanged).
  const catalog = ['kd', 'adr', 'kast'];
  assert.deepEqual(resolveOrder(['kast', 'kd'], catalog, 'match'), [
    '@Name', '@Team', '@K', '@D', '@KDA', '@DMG', '@Opening K/D', '@Util', '@MVPs', '@Score',
    'adr', 'kast', 'kd',
  ]);
  assert.deepEqual(resolveOrder(['career_kd'], ['career_kd'], 'profile'), [
    '@Matches', '@Win%', 'career_kd',
  ]);
});

test('saved order wins for its entries; relative saved order is preserved', () => {
  // u1 before kast stays u1-before-kast; adr (rank 1) still slots first.
  const catalog = ['adr', 'kast', 'u1'];
  assert.deepEqual(metricsOnly(['u1', 'kast'], catalog, 'match'), ['adr', 'u1', 'kast']);
});

test('a saved pref may move a FIXED entry — its stored position wins over its default rank', () => {
  const catalog = ['kd', 'adr'];
  // A FIRST move persists the WHOLE merged sequence (the writer's
  // contract), so a later read replays the arrangement verbatim —
  // nothing is left for step 3 to insert and the moved '@K' stands.
  const moved = [
    '@K', '@Name', '@Team', '@D', '@KDA', '@DMG', '@Opening K/D', '@Util', '@MVPs', '@Score',
    'kd', 'adr',
  ];
  assert.deepEqual(resolveOrder(moved, catalog, 'match'), moved);
  // A hand-trimmed pref naming only ONE fixed entry: the rest insert at
  // their negative ranks under §1.4's first-greater-rank rule and the
  // block re-assembles in canonical order, metrics still trailing.
  assert.deepEqual(resolveOrder(['@K', 'kd'], catalog, 'match'), [
    '@Name', '@Team', '@K', '@D', '@KDA', '@DMG', '@Opening K/D', '@Util', '@MVPs', '@Score',
    'adr', 'kd',
  ]);
  // …and a fixed key this scope does not carry is not a sequence entry.
  assert.ok(!resolveOrder(['@Matches', 'kd'], catalog, 'match').includes('@Matches'));
});

test('a newly seeded metric inserts before its default-rank successor wherever it sits', () => {
  // kast (rank 2) lands immediately before hs_pct (rank 3), wherever
  // the pref put hs_pct — the user's arrangement is not reset.
  const catalog = ['hs_pct', 'adr', 'kast', 'kd'];
  assert.deepEqual(metricsOnly(['hs_pct'], catalog, 'match'), ['adr', 'kast', 'hs_pct', 'kd']);
  // …and the literal §1.4 rule: the insertion point is the FIRST index
  // whose rank is greater, so a rank-∞ entry ahead of the successor
  // counts as a greater rank and the seed lands before it (documented
  // nuance of "wherever that successor sits").
  assert.deepEqual(metricsOnly(['u1', 'hs_pct'], ['u1', 'hs_pct', 'adr', 'kast'], 'match'), [
    'adr', 'kast', 'u1', 'hs_pct',
  ]);
  // If every ranked successor is gone, the seed still lands at its rank
  // head — never appended behind ranked entries.
  assert.deepEqual(metricsOnly(['u1'], ['u1', 'adr'], 'match'), ['adr', 'u1']);
});

test('user/plugin metrics (rank ∞) append, in catalog order, until moved', () => {
  const catalog = ['u2', 'kd', 'u1', 'plug_a'];
  assert.deepEqual(metricsOnly(['kd'], catalog, 'match'), ['kd', 'u2', 'u1', 'plug_a']);
});

test('deleted names drop out at read time — no writer needs to know about deletes', () => {
  const catalog = ['kd', 'adr'];
  assert.deepEqual(metricsOnly(['kd', 'ghost', 'adr'], catalog, 'match'), ['kd', 'adr']);
  // …and the ghost never re-enters through step 3 (it is not in catalog).
  assert.ok(!metricsOnly(['ghost'], catalog, 'match').includes('ghost'));
});

test('a renamed user metric: old name drops, unknown new name appends (rank ∞)', () => {
  const catalog = ['kd', 'renamed_stat'];
  assert.deepEqual(metricsOnly(['old_stat', 'kd'], catalog, 'match'), ['kd', 'renamed_stat']);
});

test('a scope-changed name never enters the other scope\'s sequence', () => {
  // career_kd is profile-scope: it drops from the match sequence (it is
  // not in the match catalog) and the match names resolve normally.
  const matchCatalog = ['kd', 'adr'];
  assert.deepEqual(metricsOnly(['career_kd', 'kd'], matchCatalog, 'match'), ['adr', 'kd']);
  // The profile side picks the new name up at its default rank.
  const profileCatalog = ['career_kd'];
  assert.deepEqual(metricsOnly(null, profileCatalog, 'profile'), ['career_kd']);
});

test('dedupe: duplicate saved names collapse to their first occurrence', () => {
  const catalog = ['kd', 'adr'];
  assert.deepEqual(metricsOnly(['kd', 'kd', 'adr', 'kd'], catalog, 'match'), ['kd', 'adr']);
  // Duplicate catalog names also collapse (first occurrence wins).
  assert.deepEqual(metricsOnly(null, ['kd', 'kd', 'adr'], 'match'), ['adr', 'kd']);
});

test('namespace collision: a metric named like a fixed key never displaces the fixed entry', () => {
  // The '@' namespace is the fixed side's alone. A catalog carrying a
  // metric named '@K' loses THAT name to the dedupe set (the fixed
  // entry stands), and inSequence never maps the key to the metric's
  // definition — a metric can never masquerade as a fixed stat.
  const colliding = { id: 42, name: '@K', scope: 'match' };
  const catalog = ['kd', '@K'];
  const seq = resolveOrder(null, catalog, 'match');
  assert.equal(seq.filter((n) => n === '@K').length, 1, 'exactly one @K in the sequence');
  assert.deepEqual(
    inSequence('match', null, [colliding, { id: 1, name: 'kd', scope: 'match' }]).map((d) => d.name),
    ['kd'],
    'the colliding metric def never renders through the fixed key',
  );
  assert.ok(
    !composedSequence('match', null, [colliding]).some((e) => e.kind === 'metric' && e.key === '@K'),
    'composedSequence classifies @K as the fixed entry',
  );
  // A NON-colliding '@'-prefixed metric name is just a metric name
  // (rank ∞ — the store's identifier rules keep them out in practice,
  // but the sequence never breaks on one): it sequences, trailing.
  const odd = resolveOrder(null, ['kd', '@odd'], 'match');
  assert.equal(odd[odd.length - 1], '@odd');
  assert.ok(odd.includes('kd'));
});

// --- The absent-vs-present PINS rule (§1.6) ---------------------------------

test('absent pins key → DEFAULT_PINS resolved by name through the catalog', () => {
  const catalog = [
    { id: 7, name: 'trade_rate' },
    { id: 3, name: 'kd' },
    { id: 1, name: 'adr' },
  ];
  // DEFAULT_PINS order (not catalog order): ten of the twelve default
  // names are absent from this catalog → resolve to nothing; the
  // resolved ids keep the DEFAULT order.
  assert.deepEqual(resolvePinIds('match', null, catalog), [1, 3]);
  // A catalog with no default names in it → [] — the honest
  // "nothing resolves" fallback, same shape as an empty selection.
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

test('inSequence scope-filters the defs and orders them by sequence (metric-only: fixed keys stripped)', () => {
  const defs = [
    { id: 1, name: 'adr', scope: 'match' },
    { id: 2, name: 'career_kd', scope: 'profile' },
    { id: 3, name: 'u1', scope: 'match' },
    { id: 4, name: 'kast', scope: 'match' },
  ];
  assert.deepEqual(inSequence('match', null, defs).map((d) => d.name), ['adr', 'kast', 'u1']);
  assert.deepEqual(inSequence('profile', null, defs).map((d) => d.name), ['career_kd']);
  assert.deepEqual(inSequence('match', ['u1'], defs).map((d) => d.name), ['adr', 'kast', 'u1']);
  // A stored sequence carrying fixed keys still yields metrics only —
  // this is the metric-only surface contract (Reports, trend picker).
  assert.deepEqual(
    inSequence('match', ['@K', 'u1'], defs).map((d) => d.name),
    ['adr', 'kast', 'u1'],
  );
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

// --- composedSequence: THE merged entry list (W6) ---------------------------

test('composedSequence: fixed stats and metrics as ONE ordered entry list', () => {
  const defs = [
    { id: 1, name: 'adr', scope: 'match' },
    { id: 2, name: 'career_kd', scope: 'profile' },
    { id: 3, name: 'u1', scope: 'match' },
  ];
  const seq = composedSequence('match', null, defs);
  assert.deepEqual(
    seq.map((e) => e.key),
    ['@Name', '@Team', '@K', '@D', '@KDA', '@DMG', '@Opening K/D', '@Util', '@MVPs', '@Score',
      'adr', 'u1'],
    'fixed block leads (negative ranks), metrics follow in sequence order',
  );
  assert.deepEqual(
    seq.filter((e) => e.kind === 'fixed').map((e) => e.label),
    FIXED_BLOCK.match,
    'a fixed entry carries its OWN label (the one label table)',
  );
  const adr = seq.find((e) => e.key === 'adr');
  assert.equal(adr.kind, 'metric');
  assert.equal(adr.def.id, 1);
  assert.equal(adr.label, 'adr', 'a metric entry carries its title||name');
  assert.equal(adr.hidden, false, 'metric visibility is pin-driven, never this pref');
  // Only the scope's own defs enter (the profile def never does).
  assert.ok(!seq.some((e) => e.key === 'career_kd'));
});

test('composedSequence: a hidden fixed entry stays IN the sequence and is marked, only when hideable', () => {
  const keys = composedSequence('match', null, [], ['@K', '@Name']).map((e) => [e.key, e.hidden]);
  const byKey = new Map(keys);
  assert.equal(byKey.get('@K'), true, 'a hidden hideable entry is marked hidden — it never drops out');
  assert.equal(byKey.get('@Name'), false, 'the Name exemption wins over a stored hidden key');
  assert.equal(byKey.get('@Score'), false);
  assert.equal(
    composedSequence('match', null, [], 'garbage').every((e) => !e.hidden),
    true,
    'a non-array hidden pref reads as nothing hidden',
  );
  // Profile: both fixed stats hideable.
  const prof = new Map(
    composedSequence('profile', null, [], ['@Win%']).map((e) => [e.key, e.hidden]),
  );
  assert.equal(prof.get('@Win%'), true);
  assert.equal(prof.get('@Matches'), false);
});

// --- rawItems: the report raw-item table (N5) --------------------------------

test('rawItems: the fixed stats that carry a raw scoreboard field, labelled from FIXED_BLOCK', () => {
  assert.deepEqual(
    rawItems('match').map((r) => r.label),
    ['K', 'D', 'KDA', 'DMG', 'Util', 'MVPs', 'Score'],
    'every label is a FIXED_BLOCK entry — the one label table',
  );
  // Exactly the exclusions N5 ruled: Name/Team are descriptors with no
  // raw value, Opening K/D is a compound cell.
  for (const gone of ['Name', 'Team', 'Opening K/D']) {
    assert.ok(!rawItems('match').some((r) => r.label === gone), `${gone} has no raw item`);
  }
  // The ids are namespaced strings over the PlayerStatsRow JSON field,
  // and every field is a real RAW_FIELDS value.
  for (const r of rawItems('match')) {
    assert.equal(r.id, `raw:${r.field}`);
    assert.equal(r.kind, 'raw');
    assert.equal(r.field, RAW_FIELDS[r.label]);
    assert.ok(isRawId(r.id), `${r.id} is a raw id`);
  }
  assert.ok(!isRawId(3) && !isRawId('kd'), 'a metric id is never a raw id');
  // The appendix is a per-match document: the profile scope offers none.
  assert.deepEqual(rawItems('profile'), []);
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

// --- The visibility pref pair (W6) -------------------------------------------

test('readHidden: the hidden keys round-trip; absent/corrupt reads as NOTHING hidden', async () => {
  bindings.resetCalls();
  bindings.handlers.GetPref = (key) =>
    key === 'metric_hidden_match' ? ['@K', 7, '@Score'] : key === 'metric_hidden_profile' ? 'nope' : undefined;
  assert.deepEqual(await readHidden('match'), ['@K', '@Score'], 'non-string entries filter out');
  assert.deepEqual(await readHidden('profile'), [], 'a non-array pref reads as nothing hidden');
  delete bindings.handlers.GetPref;
  bindings.resetCalls();
  assert.deepEqual(await readHidden('match'), [], 'ABSENT ⇒ nothing hidden (never null)');
  assert.deepEqual(
    bindings.calls.map((c) => [c.method, c.args]),
    [['GetPref', ['metric_hidden_match']]],
    'one GetPref with the bare visibility key',
  );
});

test('writeHidden persists the hidden set under the scope key', async () => {
  bindings.resetCalls();
  await writeHidden('match', ['@K']);
  await writeHidden('profile', ['@Matches', '@Win%']);
  assert.deepEqual(bindings.calls, [
    { method: 'SetPref', args: ['metric_hidden_match', ['@K']] },
    { method: 'SetPref', args: ['metric_hidden_profile', ['@Matches', '@Win%']] },
  ]);
});

test('resetHidden deletes the visibility key (its own reset — resetOrder never touches it)', async () => {
  bindings.resetCalls();
  await resetHidden('match');
  await resetHidden('profile');
  assert.deepEqual(bindings.calls, [
    { method: 'Delete', args: ['metric_hidden_match'] },
    { method: 'Delete', args: ['metric_hidden_profile'] },
  ]);
});

test('defaultRanker: unranked/user names are ∞, unknown scopes rank everything ∞', () => {
  const rank = defaultRanker('match');
  assert.equal(rank('assists'), 1);
  assert.equal(rank('adr'), 2);
  assert.equal(rank('not_seeded_yet'), Infinity);
  assert.equal(defaultRanker('profile')('career_kd'), 3);
  assert.equal(defaultRanker('nope')('adr'), Infinity, 'a bogus scope never ranks anything');
  assert.equal(defaultRanker('nope')('@K'), Infinity, 'a bogus scope never ranks a fixed key');
});
