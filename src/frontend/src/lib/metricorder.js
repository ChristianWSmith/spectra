// The metric sequence, default order only.
//
// Every metric list shows its DEFAULT rank order: the fixed entries (the
// scoreboard's Name, Team and Score) and the metrics, sequenced by
// DEFAULT_RANKS (negative fixed ranks lead; a metric with no rank appends in
// catalog order). Ruling 33 retired the user metric order, hiding,
// the economy placement and the transposed toggle: none of them is stored or
// read, and no list takes a saved order. A view shows what its component shows.
//
// Identity is the metric NAME. Names are unique and stable (ids churn on
// plugin replace); a name that is not in the catalog drops out of the sequence.
//
// The fixed entries have their own '@'-prefixed keys, so no metric name can
// collide with them. Metric-only consumers (the Reports appendix, the trend
// picker) use inSequence; the merged lists use composedSequence.
//
// Raw recorded values (RAW_FIELDS, rawItems, isRawId) derive from the fixed
// block's fields. Only Score carries one today.

// DEFAULT_RANKS — the default METRIC sequence per scope (design §1.6),
// name-keyed. A rank places the metric at that position among the
// converted columns; anything unranked (user/plugin metrics, not-yet
// seeded names) has rank ∞ and enters in catalog order.
//
// UNIFICATION (owner, 2026-11-18): a metric rank may be NEGATIVE —
// the seven count metrics that left the fixed block (the five scoreboard
// counts here, career_matches / win_pct in the profile scope) keep the
// exact negative ranks their '@' entries held, so an absent pref
// resolves to the byte-identical pre-unification column/card order (the
// fixed block led by negative ranks; these names now occupy those
// slots). This is the ONE ranks table — no second "leading" table.
//
// Match: the fourteen scoreboard columns that render as metrics keep
// their exact relative order — the original 23-column scoreboard's
// positions: A #5 < ADR #6 < KAST% #7 < HS% #8 < K/D #9 < 2K #13 <
// 3K #14 < 4K #15 < 5K #16 < Open K #17 < Trade #18 < Streak #20. w13d
// (owner, 2026-11-16) added kda beside K/D (rank 6 — the scoreboard's
// KDA column left the fixed block for the metric system) and
// entry_deaths beside entry_kills (rank 12 — the halves of the retired
// compound cell now stand as their own columns), shifting two_k …
// best_streak up by one; everything else was never on the scoreboard
// (rank ∞).
export const DEFAULT_RANKS = Object.freeze({
  match: Object.freeze({
    // The former '@'-entries' slots (byte-identical relative order:
    // K -8 < D -7 < DMG -5 < Util -3 < MVPs -2, between Team -9 and
    // Score -1): these metrics now LEAD the positive block below.
    kills: -8,
    deaths: -7,
    total_damage: -5,
    utility_damage: -3,
    mvps: -2,
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
  }),
  // Profile: today's StatCards grid order (PlayerProfile.svelte) —
  // Matches and Win% are metric entries now (career_matches / win_pct,
  // unification 2026-11-18) keeping their former fixed-block head
  // slots as negative ranks. The σ half of "ADR ± σ" follows its
  // mean; the Opening-duels rate takes the Opening duels
  // card's position and the Clutches card splits into its count then
  // its win-% sub (inferred-conversion W3a, Addendum A/I9 — both cards
  // left the grid for these rows).
  profile: Object.freeze({
    career_matches: -2,
    win_pct: -1,
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

// FIXED_BLOCK — the stats that stay FIXED sequence entries because
// they have NO metric twin: the descriptor columns (Name/Team —
// identity, not statistics) and Score. This is THE label table (W13b):
// ONE entry carries both label shapes — `name` is the FULL name the
// ordering dialog title, the aria labels and the Reports
// appendix/export read, `short` is the compact header Match's SCORE_COLS
// mirrors (pinned in econ-tables.dom.mjs) and the ordering dialog's
// mono slot shows beside the full name when the two differ. `key` is
// the '@'-namespaced sequence identity and `field` the PlayerStatsRow
// JSON field a raw report item reads (null = no raw counterpart) —
// RAW_FIELDS derives from it below, never a second list. `key` and
// `short` are byte-identical to the pre-W13b flat label, so every
// stored pref, every FIXED_RANKS key, every data-mo-name and colByLabel
// key keeps working with zero migration — identity never churns
// (pre-release no-versioning policy).
//
// UNIFICATION: the count entries that had
// metric twins LEFT the block — @K/@D/@DMG/@Util/@MVPs (seeds kills /
// deaths / total_damage / utility_damage / mvps, count addendum
// 2026-11-17) and the profile pair @Matches/@Win% (career_matches /
// win_pct). Their scoreboard values had read the seeds since W36
// (SEEDED_FIXED); now the ENTITIES unify too: one "Kills" row in the
// ordering dialog, one Kills column on the scoreboard, one Kills offer
// in Reports — never an '@' twin beside the metric. A stale '@K'-style
// key in a stored order/hidden pref drops out of the universe on read
// (by construction, exactly as `raw:kda` did); the raw `field` mapping
// survives ONLY for Score — the last recorded-value column (no seed:
// owner ruling, a game-internal composite whose sum has no honest
// reading; R3 of the unification wave). (The Rnds row left earlier with
// the owner's C14 scoreboard change — the column is gone from SCORE_COLS
// too, so this list stays its mirror.)
// profile: EMPTY — Matches and Win% are the career_matches / win_pct
// metric entries now (their cards read the stored seed rows since the
// owner ruling of 2026-11-17; the entities followed on 2026-11-18).
export const FIXED_BLOCK = Object.freeze({
  match: Object.freeze([
    Object.freeze({ key: '@Name', name: 'Name', short: 'Name', field: null }),
    Object.freeze({ key: '@Team', name: 'Team', short: 'Team', field: null }),
    Object.freeze({ key: '@Score', name: 'Score', short: 'Score', field: 'score' }),
  ]),
  profile: Object.freeze([]),
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
// scope, in canonical order (@Name -10 … @Score -1 — the descriptors
// and Score now, after the unification of 2026-11-18 moved the five
// count entries to DEFAULT_RANKS as metrics holding those same slots;
// w13d, owner 2026-11-16, earlier removed @KDA and @Opening K/D and
// left every remaining key's value untouched, since only the sign and
// the relative order ever matter). Negative so the fixed block leads
// the default sequence exactly as today's code prefix did, and so a
// stored metric-name-only array re-inserts every fixed entry ahead of
// every metric (composition note above). The metrics that took the
// vacated slots carry their negative ranks in DEFAULT_RANKS — ONE
// ranking spine across both tables, never a second table.
export const FIXED_RANKS = Object.freeze({
  match: Object.freeze({
    '@Name': -10,
    '@Team': -9,
    '@Score': -1,
  }),
  profile: Object.freeze({}),
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
// UNIFICATION (owner, 2026-11-18): the count stats left the fixed
// block for their metrics, so this table is now EXACTLY {Score}. A
// stale `raw:kills` / `raw:deaths` / `raw:totalDamage` /
// `raw:utilityDamage` / `raw:mvps` pick in a saved report selection
// drops SILENTLY BY CONSTRUCTION (the precedent w13d set for
// `raw:kda`): a selection never resolves items — `picked` filters the
// ITEM UNIVERSE (appendixItems) by the selection, so an id no universe
// carries simply never matches, no writer and no migration needed.
// Those five stats offer through the metric catalog instead — one
// entity per stat, never a raw twin beside it.
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
// table (W13b — the appendix chips and the exported headings read the
// full name, never the bare short). Only a scope with raw counterparts
// (match — the Reports appendix is a per-match document) yields any.
// Post-unification (owner, 2026-11-18) match yields EXACTLY one item —
// `raw:score`: every other recorded-value stat whose seed exists is a
// metric offer (the count addendum's seeds), and Score stays raw by
// owner ruling (no seed).
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


// DEFAULT_CARDS — the Profile career panel's shipped card set: the metric
// names the career panel shows, in default rank order. It is a fixed list of
// the component, not a selection the user can change (ruling 33).
export const DEFAULT_CARDS = Object.freeze({
  profile: Object.freeze([
    'career_matches',
    'win_pct',
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

// resolveOrder(catalog, scope) — the default sequence over the scope's fixed
// entries and the catalog's metric names (deduped, first occurrence wins).
// Entries sort by (rank, catalog index); an unranked name (rank ∞) appends in
// catalog order.
export function resolveOrder(catalog, scope = 'match') {
  const rankOf = defaultRanker(scope);
  const fixed = fixedKeys(scope);
  const seen = new Set(fixed);
  const names = [];
  for (const n of catalog || []) {
    if (typeof n !== 'string' || seen.has(n)) continue;
    seen.add(n);
    names.push(n);
  }
  return fixed
    .concat(names)
    .map((n, i) => ({ n, i }))
    .sort((a, b) => {
      const ra = rankOf(a.n);
      const rb = rankOf(b.n);
      if (ra !== rb) return ra < rb ? -1 : 1;
      return a.i - b.i;
    })
    .map((x) => x.n);
}

// inSequence(scope, defs) — the scope's metric entries in default order (the
// fixed entries are left out). defs are the catalog rows ({name, scope, ...}).
export function inSequence(scope, defs) {
  const scoped = (defs || []).filter((d) => d && (d.scope || 'match') === scope);
  const byName = new Map(scoped.map((d) => [d.name, d]));
  const fixed = new Set(fixedKeys(scope));
  return resolveOrder(
    scoped.map((d) => d.name),
    scope,
  )
    .filter((n) => !fixed.has(n))
    .map((n) => byName.get(n))
    .filter(Boolean);
}

// composedSequence(scope, defs) — the scope's fixed entries and metrics in
// default order, one merged list. Fixed entries carry kind 'fixed'; metrics
// carry kind 'metric' and their catalog row as def.
export function composedSequence(scope, defs) {
  const fixed = new Set(fixedKeys(scope));
  const scoped = (defs || []).filter((d) => d && (d.scope || 'match') === scope);
  const byName = new Map(scoped.map((d) => [d.name, d]));
  const out = [];
  for (const n of resolveOrder(
    scoped.map((d) => d.name),
    scope,
  )) {
    if (fixed.has(n)) {
      const entry = FIXED_BY_KEY.get(n);
      out.push({ kind: 'fixed', key: n, name: n, short: entry.short, label: entry.name });
    } else {
      const def = byName.get(n);
      if (!def) continue;
      out.push({ kind: 'metric', key: n, name: n, label: def.title || def.name, def });
    }
  }
  return out;
}
