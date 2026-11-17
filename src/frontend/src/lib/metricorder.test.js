// The ordering mechanism's contract pins (dogfooding design §1, extended
// by W6): the default tables ship exactly as §1.6, resolveOrder
// implements §1.4's whole contract (default sequence, saved order,
// new-seed insertion, ∞-append, deleted/renamed/scope-changed
// filtering, dedupe) over the MERGED universe (fixed stats as
// '@'-namespaced sequence entries with negative ranks + metrics), the
// absent-vs-present pins rule (§1.6), the compositions (the metric-only
// ∩ pins, and the one merged composedSequence), the visibility pref
// pair, the read/write/reset routing over the kvstore pref keys
// (§1.2), and the dialog's third pref — the scoreboard's opening shape
// (w25: a boolean, absent ⇒ off, no reset path).
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
  STARTS_TRANSPOSED_KEY,
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
  resolvePins,
  parseStoredPins,
  readOrder,
  writeOrder,
  resetOrder,
  readHidden,
  writeHidden,
  resetHidden,
  readStartsTransposed,
  writeStartsTransposed,
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

test('DEFAULT_RANKS.match replicates today\'s scoreboard: the fourteen converted columns in display order (w13d, 2026-11-16)', () => {
  // w13d (owner, 2026-11-16): kda joins beside kd (rank 6 — the
  // scoreboard's KDA column left the fixed block) and entry_deaths
  // beside entry_kills (rank 12 — the Opening K/D compound split into
  // its halves), shifting two_k … best_streak up by one. Every rank is
  // POSITIVE: metric ranks are what make a metric a metric here.
  assert.deepEqual(DEFAULT_RANKS.match, {
    assists: 1,
    adr: 2,
    kast: 3,
    hs_pct: 4,
    kd: 5,
    kda: 6,
    two_k: 7,
    three_k: 8,
    four_k: 9,
    five_k: 10,
    entry_kills: 11,
    entry_deaths: 12,
    trade_kills: 13,
    best_streak: 14,
  });
  assert.ok(
    Object.values(DEFAULT_RANKS.match).every((r) => r > 0),
    'metric ranks stay positive (only the fixed block ranks negative)',
  );
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

test('DEFAULT_PINS: match = the fourteen always-on columns (NOT trade_rate), profile = the eleven cards', () => {
  assert.deepEqual(DEFAULT_PINS.match, [
    'assists',
    'adr',
    'kast',
    'hs_pct',
    'kd',
    'kda',
    'two_k',
    'three_k',
    'four_k',
    'five_k',
    'entry_kills',
    'entry_deaths',
    'trade_kills',
    'best_streak',
  ]);
  assert.deepEqual(DEFAULT_PINS.profile, Object.keys(DEFAULT_RANKS.profile));
  // The pins select exactly the ranked match set (the §4.3 invariant).
  assert.deepEqual(DEFAULT_PINS.match, Object.keys(DEFAULT_RANKS.match));
  // PINs are metric ids only — a fixed key never enters the selection.
  assert.ok([...DEFAULT_PINS.match, ...DEFAULT_PINS.profile].every((n) => !n.startsWith('@')));
});

test('FIXED_BLOCK: structured {key, name, short, field} entries — full names over UNCHURNED identity (W13b, 2026-11-16)', () => {
  // Rnds is gone with the owner's C14 scoreboard change (the column
  // left SCORE_COLS too — metricorder mirrors it, never leads it);
  // @KDA and @Opening K/D left with w13d (owner, 2026-11-16 — KDA is
  // the seeded `kda` metric, the compound cell's halves are metric
  // columns), leaving the eight entries below. `key` and `short` stay
  // byte-identical to the flat label the table shipped as before W13b,
  // so every stored pref, FIXED_RANKS key, data-mo-name, colByLabel key
  // and RAW_FIELDS key keeps working — identity never churns
  // (pre-release no-versioning policy).
  assert.deepEqual(FIXED_BLOCK.match, [
    { key: '@Name', name: 'Name', short: 'Name', field: null },
    { key: '@Team', name: 'Team', short: 'Team', field: null },
    { key: '@K', name: 'Kills', short: 'K', field: 'kills' },
    { key: '@D', name: 'Deaths', short: 'D', field: 'deaths' },
    { key: '@DMG', name: 'Damage', short: 'DMG', field: 'totalDamage' },
    { key: '@Util', name: 'Utility damage', short: 'Util', field: 'utilityDamage' },
    { key: '@MVPs', name: 'MVPs', short: 'MVPs', field: 'mvps' },
    { key: '@Score', name: 'Score', short: 'Score', field: 'score' },
  ]);
  assert.deepEqual(FIXED_BLOCK.profile, [
    { key: '@Matches', name: 'Matches', short: 'Matches', field: null },
    { key: '@Win%', name: 'Win%', short: 'Win%', field: null },
  ]);
  // The identity invariant, mechanical: key = '@' + short for EVERY
  // entry — the pre-W13b flat label — so a name-only edit can never
  // move a pref key, and name===short marks the entries that show no
  // mono slot in the dialog (never "Team Team").
  for (const entries of Object.values(FIXED_BLOCK)) {
    for (const e of entries) {
      assert.equal(e.key, `@${e.short}`, `${e.key}: identity churned`);
    }
  }
  // The three full-name rows the dialog/Reports ask for, and the short
  // the scoreboard mirror keeps.
  const byKey = new Map(FIXED_BLOCK.match.map((e) => [e.key, e]));
  assert.equal(byKey.get('@K').name, 'Kills');
  assert.equal(byKey.get('@DMG').name, 'Damage');
  assert.equal(byKey.get('@DMG').short, 'DMG');
  assert.equal(byKey.get('@Util').name, 'Utility damage');
  assert.equal(byKey.get('@Util').short, 'Util');
});

// --- The fixed namespace + its negative ranks (W6) ---------------------------

test('fixedKeys: every fixed entry is its "@"+short namespaced key, in canonical order', () => {
  assert.deepEqual(
    fixedKeys('match'),
    FIXED_BLOCK.match.map((e) => e.key),
  );
  assert.deepEqual(fixedKeys('profile'), ['@Matches', '@Win%']);
  assert.deepEqual(fixedKeys('nope'), []);
  // The namespace is the identity: '@' can never appear in a metric
  // name, so a fixed entry and a metric can never be the same key.
  assert.ok(fixedKeys('match').every((k) => k.startsWith('@')));
});

test('FIXED_RANKS: negative, one per fixed entry, in canonical order (absent pref ⇒ fixed leads)', () => {
  // w13d (2026-11-16) removed @KDA and @Opening K/D; the surviving
  // keys keep their values (only the sign and the order ever matter),
  // so the holes at −6/−4 are deliberate.
  assert.deepEqual(FIXED_RANKS.match, {
    '@Name': -10,
    '@Team': -9,
    '@K': -8,
    '@D': -7,
    '@DMG': -5,
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
    '@Name', '@Team', '@K', '@D', '@DMG', '@Util', '@MVPs', '@Score',
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
    '@Name', '@Team', '@K', '@D', '@DMG', '@Util', '@MVPs', '@Score',
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
    '@K', '@Name', '@Team', '@D', '@DMG', '@Util', '@MVPs', '@Score',
    'kd', 'adr',
  ];
  assert.deepEqual(resolveOrder(moved, catalog, 'match'), moved);
  // A hand-trimmed pref naming only ONE fixed entry: the rest insert at
  // their negative ranks under §1.4's first-greater-rank rule and the
  // block re-assembles in canonical order, metrics still trailing.
  assert.deepEqual(resolveOrder(['@K', 'kd'], catalog, 'match'), [
    '@Name', '@Team', '@K', '@D', '@DMG', '@Util', '@MVPs', '@Score',
    'adr', 'kd',
  ]);
  // …and a fixed key this scope does not carry is not a sequence entry.
  assert.ok(!resolveOrder(['@Matches', 'kd'], catalog, 'match').includes('@Matches'));
});

test('a newly seeded metric inserts before its default-rank successor wherever it sits', () => {
  // kast (rank 3) lands immediately before hs_pct (rank 4), wherever
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

test('w13d retires @KDA and @Opening K/D: stray saved keys degrade harmlessly (no migration)', () => {
  // Owner ruling 2026-11-16: both entries left the fixed block (KDA is
  // the seeded `kda` metric; the Opening K/D compound cell's halves are
  // metric columns). A pref written before the wave still carries their
  // keys — they are outside the universe, so step 1 (saved ∩ universe)
  // drops them: no error, no residue, no writer that has to know about
  // them. The same holds for a stray VISIBILITY key: hideable() answers
  // false for a key no fixed block carries, so it never hides anything.
  const catalog = ['kd', 'adr'];
  const seq = resolveOrder(['@KDA', '@Opening K/D', 'kd'], catalog, 'match');
  assert.deepEqual(seq, [
    '@Name', '@Team', '@K', '@D', '@DMG', '@Util', '@MVPs', '@Score', 'adr', 'kd',
  ]);
  assert.ok(!seq.includes('@KDA') && !seq.includes('@Opening K/D'), 'the retired keys never re-enter');
  assert.equal(hideable('match', '@KDA'), false, 'a retired key is never hideable');
  assert.equal(hideable('match', '@Opening K/D'), false);
  const composed = composedSequence('match', null, [], ['@KDA', '@Opening K/D', '@K']);
  assert.ok(composed.every((e) => !e.hidden || e.key === '@K'), 'a stray hidden key marks nothing (only @K hides)');
  assert.ok(composed.some((e) => e.key === '@K' && e.hidden), 'a LIVE key beside them still hides normally');
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
  // DEFAULT_PINS order (not catalog order): twelve of the fourteen default
  // names are absent from this catalog → resolve to nothing; the
  // resolved selection keeps the DEFAULT order and carries NAMES (w22 —
  // re-pinned from the id form [1, 3] the pre-w22 reader returned: same
  // two metrics, same order, name-keyed).
  assert.deepEqual(resolvePins('match', null, catalog), ['adr', 'kd']);
  // A catalog with no default names in it → [] — the honest
  // "nothing resolves" fallback, same shape as an empty selection.
  assert.deepEqual(resolvePins('match', null, []), []);
  assert.deepEqual(resolvePins('profile', null, []), []);
});

test('present pins key → the stored selection verbatim, even empty', () => {
  const catalog = [
    { id: 1, name: 'adr' },
    { id: 3, name: 'kd' },
  ];
  assert.deepEqual(resolvePins('match', [], catalog), [], "explicit '[]' is never overridden");
  assert.deepEqual(resolvePins('match', ['trade_rate'], catalog), ['trade_rate'], 'even a non-default name');
  assert.deepEqual(resolvePins('match', ['kd', 'adr'], catalog), ['kd', 'adr'], 'stored order kept (selection, not sequence)');
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
  // The selection carries NAMES (w22 — re-pinned from the id form
  // [2, 1] the pre-w22 reader passed: same metrics, same order).
  assert.deepEqual(
    pinnedInSequence('match', null, defs, ['u1', 'adr']).map((d) => d.name),
    ['adr', 'u1'],
  );
  // Unpinning re-selects without rewriting the sequence; a later pin
  // appears exactly where the sequence puts it (not appended).
  assert.deepEqual(
    pinnedInSequence('match', null, defs, ['kast', 'u1']).map((d) => d.name),
    ['kast', 'u1'],
  );
});

// --- w22: NAME-keyed pins (owner, 2026-11-16) -------------------------------
// The pre-w22 storage was id-keyed; the id-content pins above were
// re-pinned in place (old → new, noted there). The three invariants
// below pin the NEW contract directly: the old id behavior WAS the
// defect (a pinned plugin metric silently unpinned across a
// disable → re-enable, because ReplacePluginMetrics hands plugin
// metrics fresh ids), so there is no characterization of it to keep.

test('parseStoredPins: drop, never migrate — an old id-array reads as no selection, and reads never write', () => {
  // Absent ⇒ null (the DEFAULT_PINS branch resolves through resolvePins).
  assert.equal(parseStoredPins(null), null);
  // THE old format: a numeric id array. Every entry drops through this
  // SAME read that carries current names — no format flag, no version,
  // no conversion pass — so the selection resolves to NOTHING and the
  // user re-pins once.
  assert.deepEqual(parseStoredPins('[7,12]'), []);
  assert.deepEqual(parseStoredPins('[42]'), []);
  // A mixed array keeps its names only (ids can never be names).
  assert.deepEqual(parseStoredPins('["kd",7,"adr"]'), ['kd', 'adr']);
  // Present-but-now-empty stays PRESENT: resolvePins never lets
  // DEFAULT_PINS override it — the old array reads as an explicit
  // "nothing selected", not as a default selection.
  assert.deepEqual(resolvePins('match', parseStoredPins('[7]'), [{ id: 7, name: 'kd' }]), []);
  // The read is PURE: nothing in this module touches storage, so the
  // old bytes sit in localStorage until the next real pin toggle
  // overwrites them (the write side is Builder.writePins alone).
  // Corrupt / non-array content reads as ABSENT (falls to the default
  // rule) instead of breaking the surface.
  assert.equal(parseStoredPins('nonsense'), null);
  assert.equal(parseStoredPins('{"kd":1}'), null);
  // Current format rides through: names deduped, order kept.
  assert.deepEqual(parseStoredPins('["kd","adr","kd"]'), ['kd', 'adr']);
});

test('a pinned NAME still selects after an id churn — the plugin disable → re-enable proof', () => {
  // The stored selection from BEFORE the plugin churn…
  const stored = parseStoredPins('["plug_stat"]');
  // …and the same metric after re-enable: same name, FRESH database id
  // (ReplacePluginMetrics). Name-keyed pins select the metric, whatever
  // id it carries — the pre-w22 id-keyed selection selected nothing here
  // (the silent-unpin defect).
  const reenabled = [{ id: 44, name: 'plug_stat', scope: 'match' }];
  const picked = pinnedInSequence('match', null, reenabled, resolvePins('match', stored, reenabled));
  assert.deepEqual(picked.map((d) => [d.id, d.name]), [[44, 'plug_stat']]);
  // A name no live metric carries renders NOWHERE (the defs
  // intersection every reader performs)…
  const live = [{ id: 2, name: 'kd', scope: 'match' }];
  assert.deepEqual(
    pinnedInSequence('match', null, live, resolvePins('match', ['deleted_one'], live)),
    [],
  );
  // …but rides along verbatim on the next READ: the drop happens at the
  // render intersection, never at a write — that is exactly what keeps
  // a plugin metric's pin across the window its plugin is disabled and
  // its name is absent from the catalog.
  assert.deepEqual(resolvePins('match', ['deleted_one'], live), ['deleted_one']);
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
    ['@Name', '@Team', '@K', '@D', '@DMG', '@Util', '@MVPs', '@Score',
      'adr', 'u1'],
    'fixed block leads (negative ranks), metrics follow in sequence order',
  );
  assert.deepEqual(
    seq.filter((e) => e.kind === 'fixed').map((e) => e.label),
    FIXED_BLOCK.match.map((e) => e.name),
    'a fixed entry carries its FULL name as the display label (the one label table)',
  );
  assert.deepEqual(
    seq.filter((e) => e.kind === 'fixed').map((e) => e.short),
    FIXED_BLOCK.match.map((e) => e.short),
    'a fixed entry carries its `short` (the SCORE_COLS mirror) beside the full name',
  );
  assert.deepEqual(
    seq.filter((e) => e.kind === 'fixed').map((e) => e.name),
    FIXED_BLOCK.match.map((e) => e.key),
    "a fixed entry's `name` stays the '@'-key identity (data-mo-name)",
  );
  const adr = seq.find((e) => e.key === 'adr');
  assert.equal(adr.kind, 'metric');
  assert.equal(adr.def.id, 1);
  assert.equal(adr.label, 'adr', 'a metric entry carries its title||name');
  assert.equal(adr.short, undefined, 'a metric entry carries no short (no column-header twin)');
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

test('rawItems: the fixed stats that carry a raw scoreboard field, labelled with the FULL name from the one table (W13b)', () => {
  assert.deepEqual(
    rawItems('match').map((r) => r.label),
    ['Kills', 'Deaths', 'Damage', 'Utility damage', 'MVPs', 'Score'],
    'every label is a FIXED_BLOCK entry name — the one label table, never its short',
  );
  // Exactly the exclusions N5 ruled: Name/Team are descriptors with no
  // raw value, Opening K/D was a compound cell (and left the fixed
  // block entirely in w13d) — as did KDA, whose `raw:kda` id left this
  // table with @KDA. A stale pick of `raw:kda` in a saved selection can
  // never resolve: `picked` filters the ITEM UNIVERSE by the selection,
  // never the reverse, so an id no universe carries never matches.
  for (const gone of ['Name', 'Team', 'Opening K/D']) {
    assert.ok(!rawItems('match').some((r) => r.label === gone), `${gone} has no raw item`);
  }
  assert.ok(!rawItems('match').some((r) => r.id === 'raw:kda'), 'raw:kda left with @KDA (w13d)');
  // The ids are namespaced strings over the PlayerStatsRow JSON field,
  // and every field is the field of the label-table entry that carries
  // that name (RAW_FIELDS is keyed by that entry's `short`).
  const byName = new Map(FIXED_BLOCK.match.map((e) => [e.name, e]));
  for (const r of rawItems('match')) {
    const e = byName.get(r.label);
    assert.ok(e, `${r.label} is a FIXED_BLOCK name`);
    assert.equal(r.id, `raw:${r.field}`);
    assert.equal(r.kind, 'raw');
    assert.equal(r.field, e.field);
    assert.equal(r.field, RAW_FIELDS[e.short], 'RAW_FIELDS is keyed by short');
    assert.ok(isRawId(r.id), `${r.id} is a raw id`);
  }
  assert.ok(!isRawId(3) && !isRawId('kd'), 'a metric id is never a raw id');
  // The appendix is a per-match document: the profile scope offers none.
  assert.deepEqual(rawItems('profile'), []);
});

test('RAW_FIELDS derives from the fixed table — keyed by short, exactly the entries carrying a field (W13b)', () => {
  // Today's exported shape (rawItems/Reports/tests keep one source:
  // the derivation below, not a second hand-written list). w13d dropped
  // `KDA: 'kda'` with @KDA — the `kda` JSON field left PlayerStatsRow
  // in the same wave (the stored `kda` metric is THE value now), so no
  // fixed entry can offer it as a recorded value any more.
  assert.deepEqual(RAW_FIELDS, {
    K: 'kills',
    D: 'deaths',
    DMG: 'totalDamage',
    Util: 'utilityDamage',
    MVPs: 'mvps',
    Score: 'score',
  });
  const derived = {};
  for (const entries of Object.values(FIXED_BLOCK)) {
    for (const e of entries) if (e.field) derived[e.short] = e.field;
  }
  assert.deepEqual(RAW_FIELDS, derived, 'the table IS the source — no forked key list');
  // The exclusions are the null fields: descriptors and the compound.
  const noField = Object.values(FIXED_BLOCK)
    .flat()
    .filter((e) => !e.field)
    .map((e) => e.name);
  assert.deepEqual(noField, ['Name', 'Team', 'Matches', 'Win%']);
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

// --- The dialog's THIRD pref: the scoreboard's opening shape (w25) -----------

test('STARTS_TRANSPOSED_KEY is the dialog\'s third pref — a bare boolean key outside the order/hidden tables', () => {
  assert.equal(STARTS_TRANSPOSED_KEY, 'scoreboard_starts_transposed');
  // NOT a sequence entry and not visibility: it never rides either scope
  // table (a collision would make Reset order or a visibility write hit
  // the shape), and like every other pref here it carries no version
  // marker (pre-release no-versioning policy).
  assert.ok(!Object.values(ORDER_KEYS).includes(STARTS_TRANSPOSED_KEY));
  assert.ok(!Object.values(HIDDEN_KEYS).includes(STARTS_TRANSPOSED_KEY));
  assert.ok(!/\bv\d\b|version|_v/.test(STARTS_TRANSPOSED_KEY));
});

test('readStartsTransposed: only the literal true reads as on; absent/corrupt ⇒ false', async () => {
  bindings.resetCalls();
  bindings.handlers.GetPref = (key) =>
    key === 'scoreboard_starts_transposed' ? true : undefined;
  assert.equal(await readStartsTransposed(), true, 'a stored true reads as on');
  bindings.handlers.GetPref = (key) =>
    key === 'scoreboard_starts_transposed' ? 'yes' : undefined;
  assert.equal(await readStartsTransposed(), false, 'a non-boolean pref reads as off');
  delete bindings.handlers.GetPref;
  bindings.resetCalls();
  assert.equal(await readStartsTransposed(), false, 'ABSENT ⇒ off (the default, player rows)');
  assert.deepEqual(
    bindings.calls.map((c) => [c.method, c.args]),
    [['GetPref', ['scoreboard_starts_transposed']]],
    'one GetPref with the bare key',
  );
});

test('writeStartsTransposed persists a strict boolean under the shape key (no reset path)', async () => {
  bindings.resetCalls();
  await writeStartsTransposed(true);
  await writeStartsTransposed(false);
  await writeStartsTransposed('yes'); // never stored verbatim — the reader is `v === true`
  assert.deepEqual(bindings.calls, [
    { method: 'SetPref', args: ['scoreboard_starts_transposed', true] },
    { method: 'SetPref', args: ['scoreboard_starts_transposed', false] },
    { method: 'SetPref', args: ['scoreboard_starts_transposed', false] },
  ]);
  // Reset order deletes only the two pref PAIRS — the shape key is never
  // deleted from here (there is deliberately no resetStartsTransposed).
  await resetOrder('match');
  await resetHidden('match');
  assert.deepEqual(
    bindings.calls.filter((c) => c.args[0] === 'scoreboard_starts_transposed').map((c) => c.method),
    ['SetPref', 'SetPref', 'SetPref'],
    'no Delete ever targets the shape key',
  );
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
