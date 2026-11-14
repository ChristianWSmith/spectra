// THE metric ordering mechanism (dogfooding design §1) — reader,
// writer, resolver and the two default tables, all in one module
// (AGENTS "One canonical way"): no view ever composes sequence order
// itself, and this is the ONLY place `pref ∩ pins` is computed.
//
// Storage ruling (design §1.1): the order is a durable preference in
// the kvstore (prefs.go's metric_order_match / metric_order_profile),
// frontend-written, Go never consumes it — the font_size precedent.
// NOT localStorage (webstorage.test.js bans new references), NOT the
// route query (not a link), NOT the registry (not view state).
//
// Composition (design §1.3):  render = FIXED_BLOCK ++ resolveOrder ∩ pins
//   - FIXED_BLOCK is CODE (the Go-rendered stats' current order minus
//     the entries that convert), never stored, never reorderable.
//   - resolveOrder(pref, catalog) is the scope's full metric sequence.
//   - pins are a pure SELECTION set: the pins array's own order stopped
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

// DEFAULT_RANKS — the default metric sequence per scope (design §1.6),
// name-keyed. A rank places the metric at that position among the
// converted columns; anything unranked (user/plugin metrics, not-yet
// seeded names) has rank ∞ and enters in catalog order.
//
// Match: the four scoreboard columns that convert to metrics keep
// today's exact relative order — adr #6 (Match.svelte SCORE_COLS :98),
// kast #7 (:99), hs_pct #8 (:100), kd #9 (:101); everything else was
// never on the scoreboard (rank ∞).
export const DEFAULT_RANKS = Object.freeze({
  match: Object.freeze({ adr: 1, kast: 2, hs_pct: 3, kd: 4 }),
  // Profile: today's StatCards grid order (PlayerProfile.svelte :342-374)
  // minus the cards that stay Go — Matches, Win%, Opening duels and the
  // Clutches COUNT are fixed-block, never ranked. The σ half of
  // "ADR ± σ" (:345) follows its mean; the clutch-win% follows the
  // Clutches card's old position (:359); Trade rate is :350.
  profile: Object.freeze({
    career_adr: 1,
    career_adr_sigma: 2,
    career_kd: 3,
    career_hs_pct: 4,
    career_kast: 5,
    career_trade_rate: 6,
    career_clutch_win_rate: 7,
    career_avg_enemies_flashed: 8,
    career_avg_util_damage: 9,
  }),
});

// DEFAULT_PINS — the absent-key default SELECTION (design §1.6), the
// mechanism that makes the conversion visually transparent: these are
// today's always-on derived columns / cards, so post-conversion they
// reappear as metric entries in default order. The pins reader
// (resolvePinIds below) applies it ONLY when the key is absent — a
// present key (even '[]') is the stored selection verbatim; an
// explicit "pin nothing" is never overridden. No migration marker
// (pre-release no-versioning policy).
//
// match = adr, kast, hs_pct, kd — NOT trade_rate (today it is not a
// scoreboard column). profile = the nine rank-1..9 names above.
export const DEFAULT_PINS = Object.freeze({
  match: Object.freeze(['adr', 'kast', 'hs_pct', 'kd']),
  profile: Object.freeze([
    'career_adr',
    'career_adr_sigma',
    'career_kd',
    'career_hs_pct',
    'career_kast',
    'career_trade_rate',
    'career_clutch_win_rate',
    'career_avg_enemies_flashed',
    'career_avg_util_damage',
  ]),
});

// FIXED_BLOCK — the Go-rendered stats' labels in their current
// relative order, MINUS the entries that convert (design §1.5). Code,
// not state: it can never drift from what the Go readers serve, and no
// preference can promote a metric ahead of it. The dialog renders it
// read-only as context ("where will my metric land?").
//
// match: SCORE_COLS (Match.svelte :89-133) minus adr/kast/hs_pct/kd
// (→ metrics D1/D6/D4/D5) — Name, Team, K, D, A, KDA, DMG, Rnds,
// 2K–5K, Entry, Trade, Opening K/D, Streak, Util, MVPs, Score.
// profile: the StatCards grid (PlayerProfile.svelte :342-374) minus
// ADR ± σ, K/D, HS%, KAST%, Trade rate, the Clutches win-% sub, Avg
// enemies flashed and Avg util damage (→ metrics) — Matches, Win%,
// Opening duels, Clutches (count only).
export const FIXED_BLOCK = Object.freeze({
  match: Object.freeze([
    'Name',
    'Team',
    'K',
    'D',
    'A',
    'KDA',
    'DMG',
    'Rnds',
    '2K',
    '3K',
    '4K',
    '5K',
    'Entry',
    'Trade',
    'Opening K/D',
    'Streak',
    'Util',
    'MVPs',
    'Score',
  ]),
  profile: Object.freeze(['Matches', 'Win%', 'Opening duels', 'Clutches']),
});

// fixedBlock(scope) — the read-only label list for the dialog.
export function fixedBlock(scope) {
  return FIXED_BLOCK[scope] || [];
}

// defaultRanker(scope) — name → default rank (∞ for unknown/user/
// plugin names), the rankOf of design §1.4's resolveOrder contract.
export function defaultRanker(scope) {
  const ranks = DEFAULT_RANKS[scope] || {};
  return (name) => (Number.isFinite(ranks[name]) ? ranks[name] : Infinity);
}

// resolveOrder(saved, catalog, scope) — THE pure sequencing function
// (design §1.4, the whole contract):
//   1. base = saved present ? saved ∩ catalog (names, deduped, saved
//      order; deleted/renamed/wrong-scope names drop out here) : []
//   2. saved absent  → the DEFAULT sequence: sort(catalog, by
//      (rank, catalogIndex)) — never the pins array
//   3. each catalog name not in base inserts at the FIRST index whose
//      rank is greater than its own, else appends — so a newly seeded
//      metric lands at its default rank wherever that rank's slot sits,
//      while rank ∞ (user/plugin) never satisfies the predicate and
//      appends in catalog order
//   4. return base (now the full sequence)
// `saved` non-array (absent/corrupt pref) is step 2. A present-but-
// empty array walks 1/3 and resolves to the same default sequence.
// scope defaults to 'match' for the two-argument call shape; every
// profile-scope call site passes 'profile' explicitly.
export function resolveOrder(saved, catalog, scope = 'match') {
  const rankOf = defaultRanker(scope);
  // Catalog: names only, deduped (first occurrence wins), order kept.
  const names = [];
  const seen = new Set();
  for (const n of catalog || []) {
    if (typeof n !== 'string' || seen.has(n)) continue;
    seen.add(n);
    names.push(n);
  }

  if (!Array.isArray(saved)) {
    // Step 2 — the default sequence (rank asc, ties by catalog index).
    return names
      .map((n, i) => ({ n, i }))
      .sort((a, b) => {
        const ra = rankOf(a.n);
        const rb = rankOf(b.n);
        if (ra !== rb) return ra < rb ? -1 : 1;
        return a.i - b.i;
      })
      .map((x) => x.n);
  }

  // Step 1 — saved ∩ catalog, deduped, saved order.
  const inCatalog = new Set(names);
  const base = [];
  const placed = new Set();
  for (const n of saved) {
    if (typeof n !== 'string' || !inCatalog.has(n) || placed.has(n)) continue;
    placed.add(n);
    base.push(n);
  }

  // Step 3 — everything the pref did not name, at its default rank.
  for (const n of names) {
    if (placed.has(n)) continue;
    const r = rankOf(n);
    const i = base.findIndex((b) => rankOf(b) > r); // ∞ never satisfies ⇒ append
    if (i === -1) base.push(n);
    else base.splice(i, 0, n);
    placed.add(n);
  }
  return base;
}

// inSequence(scope, saved, defs) — the scope's defs in sequence order:
// resolveOrder over the scope-filtered catalog, mapped back to defs.
// A def whose scope field is missing counts as match (the store always
// sets it; the rule matches both views' historical filters).
export function inSequence(scope, saved, defs) {
  const scoped = (defs || []).filter((d) => d && (d.scope || 'match') === scope);
  const byName = new Map(scoped.map((d) => [d.name, d]));
  return resolveOrder(saved, scoped.map((d) => d.name), scope)
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
// sequence again (design §1.7: reset never touches the fixed block).
export function resetOrder(scope) {
  return Promise.resolve(deletePref(ORDER_KEYS[scope]));
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
