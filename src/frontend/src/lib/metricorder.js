// THE metric ordering mechanism (dogfooding design §1) — reader,
// writer, resolver and the default tables, all in one module (AGENTS
// "One canonical way"): no view ever composes sequence order itself,
// and this is the ONLY place `pref ∩ pins` is computed.
//
// Storage ruling (design §1.1): the order is a durable preference in
// the kvstore (prefs.go's metric_order_match / metric_order_profile),
// frontend-written, Go never consumes it — the font_size precedent.
// NOT localStorage (webstorage.test.js bans new references), NOT the
// route query (not a link), NOT the registry (not view state).
// Visibility rides its own twin key pair (metric_hidden_match /
// metric_hidden_profile) under the same rules — the same writers, the
// same kvstore, absent ⇒ nothing hidden.
//
// Composition (W6, 2026-11-16):  composedSequence = resolveOrder over
// the FIXED stats AND the metrics, one merged entry list.
//   - The fixed stats are first-class SEQUENCE entries under a
//     namespace key ('@Name', '@K', '@Matches', '@Win%'): identity is
//     the metric NAME and users may name a metric 'K', so the fixed
//     side needs a namespace no metric name can hold (metric names are
//     validated identifiers — the '@' prefix is theirs alone). They
//     carry NEGATIVE default ranks, so an absent pref leads with the
//     fixed block exactly as before and an EXISTING metric-name array
//     re-inserts them ahead of every metric (today's rendering).
//     No migration, no version marker: the first user move persists
//     the full merged sequence (pre-release no-versioning policy).
//   - A fixed stat's VISIBILITY is separate from its position: hidden
//     entries stay in the sequence (and stay listed in the ordering
//     dialog — the toggle never removes a row), they just do not
//     render on the view. Every fixed stat is hideable except the
//     scoreboard's Name column (owner ruling: only Name is exempt).
//   - resolveOrder(pref, catalog) sequences the whole universe;
//     inSequence / pinnedInSequence stay METRIC-only (the Reports
//     appendix and the trend picker are metric-only surfaces) — they
//     strip the fixed keys right after resolveOrder.
//   - Pins are a pure SELECTION set: the pins array's own order stops
//     being an ordering source — render order is always the sequence
//     filtered to the pinned set (pinnedInSequence below).
//
// Identity is the metric NAME (ids churn on plugin replace; names are
// UNIQUE and stable), scope-matched on read: a scope-changed or deleted
// name simply drops out of the sequence — read-time filtering only, no
// writer ever needs to know about deletes or renames. A renamed
// USER metric re-enters unknown → its default rank (rank ∞ → append),
// losing its custom position; that is accepted and documented here
// (built-ins are immutable, so only user/plugin metrics can hit it).
import { getPref, setPref, deletePref } from './services.js';

// The kvstore keys (mirror the pins' scope routing —
// 'spectra:pinned-metrics' = match, 'spectra:pinned-profile-metrics' =
// profile — without the spectra: prefix; kvstore keys are bare and the
// file already lives under spectra/).
export const ORDER_KEYS = Object.freeze({
  match: 'metric_order_match',
  profile: 'metric_order_profile',
});

// The VISIBILITY twin: which FIXED stats are hidden from their view.
// Same routing, same storage rules, absent ⇒ nothing hidden. Namespaced
// keys ('@K' …) — a metric can never be hidden here (metric visibility
// stays pin-driven); these hold fixed-entry keys only.
export const HIDDEN_KEYS = Object.freeze({
  match: 'metric_hidden_match',
  profile: 'metric_hidden_profile',
});

// DEFAULT_RANKS — the default METRIC sequence per scope (design §1.6),
// name-keyed. A rank places the metric at that position among the
// converted columns; anything unranked (user/plugin metrics, not-yet
// seeded names) has rank ∞ and enters in catalog order.
//
// Match: the twelve scoreboard columns that render as metrics keep
// today's exact relative order — the original 23-column scoreboard's
// positions: A #5 < ADR #6 < KAST% #7 < HS% #8 < K/D #9 < 2K #13 <
// 3K #14 < 4K #15 < 5K #16 < Entry #17 < Trade #18 < Streak #20 (the
// W2a swap converted the eight SCORE_COLS entries that sat among the
// fixed block; dogfood W2 had already converted the tail four);
// everything else was never on the scoreboard (rank ∞).
export const DEFAULT_RANKS = Object.freeze({
  match: Object.freeze({
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
  }),
  // Profile: today's StatCards grid order (PlayerProfile.svelte) minus
  // the cards that stay Go — Matches and Win% are fixed-block entries
  // with their own negative ranks below. The σ half of "ADR ± σ"
  // follows its mean; the Opening-duels rate takes the Opening duels
  // card's position and the Clutches card splits into its count then
  // its win-% sub (inferred-conversion W3a, Addendum A/I9 — both cards
  // left the grid for these rows).
  profile: Object.freeze({
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
  }),
});

// DEFAULT_PINS — the absent-key default SELECTION (design §1.6), the
// mechanism that makes the conversion visually transparent: these are
// today's always-on derived columns / cards, so post-conversion they
// reappear as metric entries in default order. The pins reader
// (resolvePinIds below) applies it ONLY when the key is absent — a
// present key (even '[]') is the stored selection verbatim; an
// explicit "pin nothing" is never overridden. No migration marker
// (pre-release no-versioning policy). PINs are METRIC ids only: the
// fixed stats are sequence entries, never a selection.
//
// match = the twelve always-on scoreboard columns: the four that
// converted in dogfood W2 plus the eight SCORE_COLS the W2a swap
// moved (NOT trade_rate — today it is not a scoreboard column;
// entry_deaths stays unpinned because it only ever renders inside the
// Opening K/D pair cell's fixed named slot). profile = the eleven
// rank-1..11 names above (the always-on card set: the nine dogfood
// cards plus W3a's Opening-duels rate and Clutches count).
export const DEFAULT_PINS = Object.freeze({
  match: Object.freeze([
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
  ]),
  profile: Object.freeze([
    'career_adr',
    'career_adr_sigma',
    'career_kd',
    'career_hs_pct',
    'career_kast',
    'career_opening_rate',
    'career_trade_rate',
    'career_clutches',
    'career_clutch_win_rate',
    'career_avg_enemies_flashed',
    'career_avg_util_damage',
  ]),
});

// FIXED_BLOCK — the Go-rendered stats' {key, name, short, field}
// entries in their canonical order, MINUS the entries that convert
// (design §1.5). This is THE label table (W13b): ONE entry carries
// both label shapes — `name` is the FULL name the ordering dialog
// title, the aria labels and the Reports appendix/export read, `short`
// is the compact header Match's SCORE_COLS mirrors (pinned in
// econ-tables.dom.mjs) and the ordering dialog's mono slot shows beside
// the full name when the two differ. `key` is the '@'-namespaced
// sequence identity and `field` the PlayerStatsRow JSON field a raw
// report item reads (null = no raw counterpart) — RAW_FIELDS derives
// from it below, never a second list. `key` and `short` are byte-
// identical to the pre-W13b flat label, so every stored pref, every
// FIXED_RANKS key, every data-mo-name and colByLabel key keeps working
// with zero migration — identity never churns (pre-release no-versioning
// policy).
//
// match: SCORE_COLS (Match.svelte) minus every entry that renders as
// a metric — adr/kast/hs_pct/kd (dogfood W2) and A, 2K–5K, Entry,
// Trade, Streak (the W2a swap) — leaving the ten entries whose
// `short`s are Name, Team, K, D, KDA, DMG, Opening K/D, Util, MVPs,
// Score (their `name`s read Kills / Deaths / Damage / Utility damage
// where the two differ). Opening K/D STAYS fixed: it
// keeps its fixed position (design Q2) while its cell composes the
// entry_kills / entry_deaths metric halves. (The Rnds row left with the
// owner's C14 scoreboard change — the column is gone from SCORE_COLS
// too, so this list stays its mirror; rounds played itself remains a
// store column and a metric input.)
// profile: the StatCards grid (PlayerProfile.svelte) minus every card
// that renders as a metric — ADR ± σ, K/D, HS%, KAST%, Trade rate, the
// Clutches win-% sub, Avg enemies flashed and Avg util damage (the
// dogfood swap) plus, in the inferred-conversion W3a swap, the
// Opening-duels card and the Clutches COUNT (both became Career
// metrics rows: career_opening_rate / career_clutches) — leaving
// Matches and Win% (raw / N2).
export const FIXED_BLOCK = Object.freeze({
  match: Object.freeze([
    Object.freeze({ key: '@Name', name: 'Name', short: 'Name', field: null }),
    Object.freeze({ key: '@Team', name: 'Team', short: 'Team', field: null }),
    Object.freeze({ key: '@K', name: 'Kills', short: 'K', field: 'kills' }),
    Object.freeze({ key: '@D', name: 'Deaths', short: 'D', field: 'deaths' }),
    Object.freeze({ key: '@KDA', name: 'KDA', short: 'KDA', field: 'kda' }),
    Object.freeze({ key: '@DMG', name: 'Damage', short: 'DMG', field: 'totalDamage' }),
    Object.freeze({ key: '@Opening K/D', name: 'Opening K/D', short: 'Opening K/D', field: null }),
    Object.freeze({ key: '@Util', name: 'Utility damage', short: 'Util', field: 'utilityDamage' }),
    Object.freeze({ key: '@MVPs', name: 'MVPs', short: 'MVPs', field: 'mvps' }),
    Object.freeze({ key: '@Score', name: 'Score', short: 'Score', field: 'score' }),
  ]),
  profile: Object.freeze([
    Object.freeze({ key: '@Matches', name: 'Matches', short: 'Matches', field: null }),
    Object.freeze({ key: '@Win%', name: 'Win%', short: 'Win%', field: null }),
  ]),
});

// The key → entry index (keys are unique across scopes — the '@'
// namespace is the fixed side's alone). composedSequence resolves a
// sequence key through this; a key not in it can only arrive through a
// saved pref and never reaches the fixed branch.
const FIXED_BY_KEY = new Map();
for (const entries of Object.values(FIXED_BLOCK)) {
  for (const e of entries) FIXED_BY_KEY.set(e.key, e);
}

// The namespace: a fixed entry's identity is '@' + its `short` —
// byte-identical to the flat label the table shipped as before W13b,
// so the stored pref keys, FIXED_RANKS keys and data-mo-name values
// never churn. The '@' prefix can never appear in a metric name, so
// the two identity spaces cannot collide — and where a colliding name
// is attempted anyway, the FIXED entry wins (the dedupe set below is
// seeded with the fixed keys first, so the metric name drops and the
// fixed entry stands).
export const FIXED_PREFIX = '@';

// fixedKeys(scope) — the scope's fixed entries as their sequence keys,
// in canonical order.
export function fixedKeys(scope) {
  return (FIXED_BLOCK[scope] || []).map((e) => e.key);
}

// FIXED_RANKS — the fixed entries' NEGATIVE default ranks, one per
// scope, in canonical order (-10 … -1 for the scoreboard's ten columns,
// -2/-1 for the profile pair). Negative so the fixed block leads the
// default sequence exactly as today's code prefix did, and so a stored
// metric-name-only array re-inserts every fixed entry ahead of every
// metric (composition note above). Metric ranks are untouched and stay
// positive.
export const FIXED_RANKS = Object.freeze({
  match: Object.freeze({
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
  }),
  profile: Object.freeze({ '@Matches': -2, '@Win%': -1 }),
});

// RAW_FIELDS — the fixed stats that ALSO have a raw scoreboard field,
// DERIVED from the one label table (FIXED_BLOCK entries carrying a
// `field`), keyed by their `short` — byte-identical to the flat-label
// shape it shipped as before W13b (rawItems, Reports and the tests
// read one source, never a forked list). The value is the PlayerStatsRow
// JSON field GetScoreboard serves, the same field Match's cellText
// derives from a SCORE_COLS key. Reports' raw items compose from this;
// the fixed block minus this table is exactly the entries with no raw
// counterpart or no numeric cell:
//   Name / Team       — descriptors, not values
//   Opening K/D       — a compound cell (lead ruling: its halves are
//                       metrics and the compound fights the table)
//   Matches / Win%    — profile-scope descriptors (no scoreboard row)
export const RAW_FIELDS = Object.freeze(
  Object.fromEntries(
    Object.values(FIXED_BLOCK)
      .flat()
      .filter((e) => e.field)
      .map((e) => [e.short, e.field]),
  ),
);

// rawItems(scope) — the scope's raw report items in fixed-block order:
// {id: 'raw:<field>', label, kind: 'raw', field}. The id is a STRING
// (namespaced) so a raw pick can never collide with a metric id in the
// selection set; `label` is the entry's FULL name from the ONE label
// table (W13b — the appendix chips and the exported headings read
// "Kills", never the bare short). Only a scope with raw counterparts
// (match — the Reports appendix is a per-match document) yields any.
export function rawItems(scope) {
  const out = [];
  for (const e of FIXED_BLOCK[scope] || []) {
    if (!e.field) continue;
    out.push({ id: `raw:${e.field}`, label: e.name, kind: 'raw', field: e.field });
  }
  return out;
}

// isRawId — the selection-set discriminator (a metric id is a number, a
// raw id is this namespace's string).
export function isRawId(id) {
  return typeof id === 'string' && id.startsWith('raw:');
}

// HIDE_EXEMPT — THE visibility exemption (owner ruling, W6): the
// scoreboard's Name column is structural (the row identity every other
// cell hangs off), so it is the ONE fixed stat a user may not hide;
// the profile scope has no Name and both of its fixed stats are
// hideable. A stored hidden key outside this predicate never hides
// anything — the exemption wins on read, no writer filter needed.
const HIDE_EXEMPT = Object.freeze({
  match: Object.freeze([FIXED_PREFIX + 'Name']),
  profile: Object.freeze([]),
});

// hideable(scope, key) — may this fixed entry be hidden at all? Metric
// entries are never hideable (their visibility is the pin selection),
// so a metric key answers false.
export function hideable(scope, key) {
  if (typeof key !== 'string' || !key.startsWith(FIXED_PREFIX)) return false;
  if (!(FIXED_BLOCK[scope] || []).some((e) => e.key === key)) return false;
  return !(HIDE_EXEMPT[scope] || []).includes(key);
}

// defaultRanker(scope) — name → default rank (∞ for unknown/user/
// plugin names), the rankOf of design §1.4's resolveOrder contract.
// Fixed keys rank from FIXED_RANKS; a fixed key this scope does not
// carry (never in its catalog) ranks ∞, which is moot — it can only
// arrive through a saved pref and drops out at read time.
export function defaultRanker(scope) {
  const ranks = DEFAULT_RANKS[scope] || {};
  const fixedRanks = FIXED_RANKS[scope] || {};
  return (name) => {
    if (fixedRanks[name] !== undefined) return fixedRanks[name];
    if (typeof name === 'string' && name.startsWith(FIXED_PREFIX)) return Infinity;
    return Number.isFinite(ranks[name]) ? ranks[name] : Infinity;
  };
}

// resolveOrder(saved, catalog, scope) — THE pure sequencing function
// (design §1.4, the whole contract), over the MERGED universe:
//   0. universe = the scope's fixed keys ++ the catalog's metric names
//      (deduped, first occurrence wins — the fixed keys seed the dedupe
//      set, so a metric name wearing a fixed key drops and the fixed
//      entry stands)
//   1. base = saved present ? saved ∩ universe (entries, deduped, saved
//      order; deleted/renamed/wrong-scope names drop out here) : []
//   2. saved absent  → the DEFAULT sequence: sort(universe, by
//      (rank, index)) — negative fixed ranks lead, never the pins array
//   3. each universe entry not in base inserts at the FIRST index whose
//      rank is greater than its own, else appends — so a newly seeded
//      metric lands at its default rank wherever that rank's slot sits,
//      while rank ∞ (user/plugin) never satisfies the predicate and
//      appends in catalog order
//   4. return base (now the full sequence)
// `saved` non-array (absent/corrupt pref) is step 2. A present-but-
// empty array walks 1/3 and resolves to the same default sequence. A
// stored METRIC-NAME-ONLY array (every pref written before W6) hits
// step 3 for the fixed keys, whose negative ranks land them ahead of
// every metric — today's rendering, no migration.
// scope defaults to 'match' for the two-argument call shape; every
// profile-scope call site passes 'profile' explicitly.
export function resolveOrder(saved, catalog, scope = 'match') {
  const rankOf = defaultRanker(scope);
  const fixed = fixedKeys(scope);
  // Catalog: metric names only, deduped against the fixed namespace
  // (first occurrence wins), order kept.
  const seen = new Set(fixed);
  const names = [];
  for (const n of catalog || []) {
    if (typeof n !== 'string' || seen.has(n)) continue;
    seen.add(n);
    names.push(n);
  }
  const universe = fixed.concat(names);

  if (!Array.isArray(saved)) {
    // Step 2 — the default sequence (rank asc, ties by universe index).
    return universe
      .map((n, i) => ({ n, i }))
      .sort((a, b) => {
        const ra = rankOf(a.n);
        const rb = rankOf(b.n);
        if (ra !== rb) return ra < rb ? -1 : 1;
        return a.i - b.i;
      })
      .map((x) => x.n);
  }

  // Step 1 — saved ∩ universe, deduped, saved order.
  const inUniverse = new Set(universe);
  const base = [];
  const placed = new Set();
  for (const n of saved) {
    if (typeof n !== 'string' || !inUniverse.has(n) || placed.has(n)) continue;
    placed.add(n);
    base.push(n);
  }

  // Step 3 — everything the pref did not name, at its default rank.
  // Universe order (fixed keys first) decides which entries try first,
  // so the fixed block re-assembles ahead of the metrics whatever the
  // stored array carried.
  for (const n of universe) {
    if (placed.has(n)) continue;
    const r = rankOf(n);
    const i = base.findIndex((b) => rankOf(b) > r); // ∞ never satisfies ⇒ append
    if (i === -1) base.push(n);
    else base.splice(i, 0, n);
    placed.add(n);
  }
  return base;
}

// inSequence(scope, saved, defs) — the scope's METRIC defs in sequence
// order: resolveOrder over the scope-filtered catalog, the fixed keys
// stripped, mapped back to defs. A def whose scope field is missing
// counts as match (the store always sets it; the rule matches both
// views' historical filters). Metric-only by contract — the Reports
// appendix and the trend picker are metric-only surfaces; a surface
// that renders fixed stats too composes through composedSequence.
export function inSequence(scope, saved, defs) {
  const scoped = (defs || []).filter((d) => d && (d.scope || 'match') === scope);
  const byName = new Map(scoped.map((d) => [d.name, d]));
  const fixed = new Set(fixedKeys(scope));
  return resolveOrder(saved, scoped.map((d) => d.name), scope)
    .filter((n) => !fixed.has(n))
    .map((n) => byName.get(n))
    .filter(Boolean);
}

// pinnedInSequence(scope, saved, defs, pinIds) — THE composition of
// design §1.3: `resolveOrder ∩ pins`. Pins SELECT what renders; the
// sequence decides where the selection renders (the pins array's own
// order is never consulted — a newly pinned metric appears exactly
// where the sequence puts it, not appended).
export function pinnedInSequence(scope, saved, defs, pinIds) {
  const pinned = new Set(pinIds || []);
  return inSequence(scope, saved, defs).filter((d) => pinned.has(d.id));
}

// composedSequence(scope, saved, defs, hiddenKeys) — THE merged
// sequence (W6): fixed stats AND metrics as ONE ordered entry list —
// the input for the ordering dialog, the Match scoreboard and the
// profile card block. Each entry:
//   { kind:'fixed',  key, name, short, label, hidden }
//   { kind:'metric', key, name, label, def, hidden:false }
// `key`/`name` are the sequence identity (fixed entries carry their
// '@'-key — the data-mo-name/focus contract — metrics their name);
// `label` is the display label (the fixed entry's FULL name from the
// ONE label table — W13b, so the dialog reads "Kills" — else the
// metric's title||name) and `short` the fixed entry's compact header
// form (the SCORE_COLS mirror; metrics carry none — they have no
// column-header twin here). `hidden` marks a fixed entry the user hid:
// it stays in the sequence (and stays listed in the dialog) and the
// VIEW filters it out — never the dialog, never Reports' addable set
// (lead ruling: visibility is view-display only). Metric visibility is
// pin-driven and therefore never expressed here.
export function composedSequence(scope, saved, defs, hiddenKeys = []) {
  const fixed = new Set(fixedKeys(scope));
  const hidden = new Set(Array.isArray(hiddenKeys) ? hiddenKeys : []);
  const scoped = (defs || []).filter((d) => d && (d.scope || 'match') === scope);
  const byName = new Map(scoped.map((d) => [d.name, d]));
  const out = [];
  for (const n of resolveOrder(saved, scoped.map((d) => d.name), scope)) {
    if (fixed.has(n)) {
      const entry = FIXED_BY_KEY.get(n);
      out.push({
        kind: 'fixed',
        key: n,
        name: n,
        short: entry.short,
        label: entry.name,
        hidden: hideable(scope, n) && hidden.has(n),
      });
    } else {
      const def = byName.get(n);
      if (!def) continue;
      out.push({
        kind: 'metric',
        key: n,
        name: n,
        label: def.title || def.name,
        def,
        hidden: false,
      });
    }
  }
  return out;
}

// readOrder(scope) — the saved sequence, or null when the key is
// ABSENT (design §1.2: absent = default order). A non-array pref
// (corrupt) reads as absent too — a broken pref falls back to the
// default instead of breaking the surface.
export function readOrder(scope) {
  return Promise.resolve(getPref(ORDER_KEYS[scope])).then((v) =>
    Array.isArray(v) ? v.filter((n) => typeof n === 'string') : null,
  );
}

// writeOrder(scope, names) — persist the FULL resolved sequence (the
// first move materializes it: default-resolved, then the move applied).
// kvstore AutoSave makes every write durable immediately.
export function writeOrder(scope, names) {
  return Promise.resolve(setPref(ORDER_KEYS[scope], [...names]));
}

// resetOrder(scope) — delete the key ⇒ the next read is the default
// sequence again. The hidden set is its OWN key with its own reset
// (resetHidden) — the dialog's Reset clears both, but a caller that
// only means the order never silently wipes visibility.
export function resetOrder(scope) {
  return Promise.resolve(deletePref(ORDER_KEYS[scope]));
}

// readHidden(scope) — the saved hidden fixed-entry keys, [] when the
// key is ABSENT (absent ⇒ nothing hidden) or corrupt. Same raw-read
// shape as readOrder: a broken pref must not break the surface.
export function readHidden(scope) {
  return Promise.resolve(getPref(HIDDEN_KEYS[scope])).then((v) =>
    Array.isArray(v) ? v.filter((n) => typeof n === 'string') : [],
  );
}

// writeHidden(scope, keys) — persist the hidden set verbatim.
export function writeHidden(scope, keys) {
  return Promise.resolve(setPref(HIDDEN_KEYS[scope], [...keys]));
}

// resetHidden(scope) — delete the key ⇒ nothing hidden again.
export function resetHidden(scope) {
  return Promise.resolve(deletePref(HIDDEN_KEYS[scope]));
}

// resolvePinIds(scope, stored, catalog) — THE absent-vs-present pins
// rule (design §1.6), the pins readers' shared reader (Builder, Match,
// PlayerProfile):
//   stored null  (key ABSENT)  ⇒ DEFAULT_PINS[scope] resolved by NAME
//     through the catalog — names not yet seeded resolve to nothing,
//     so before W2's seeds an absent key behaves exactly like today's
//     "absent ⇒ []";
//   stored array (key PRESENT) ⇒ the stored selection verbatim, even
//     '[]' — an explicit "pin nothing" is never overridden.
// localStorage stays where it is (webstorage.test.js pins the three
// durable-pref sites); this function only maps the raw read.
export function resolvePinIds(scope, stored, catalog) {
  if (Array.isArray(stored)) return [...stored];
  const byName = new Map((catalog || []).map((d) => [d.name, d]));
  const out = [];
  for (const n of DEFAULT_PINS[scope] || []) {
    const d = byName.get(n);
    if (d && Number.isFinite(d.id)) out.push(d.id);
  }
  return out;
}
