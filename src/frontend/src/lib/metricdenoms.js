// metricdenoms.js — THE metric denominator filter vocabulary (the
// denominator column's three buckets in their canonical order) and THE
// checked-set → denominator-filter word mapping behind the Builder
// Filters popover's Denominator group.
//
// METRIC_DENOMS is the single frontend spelling of the vocabulary: the
// group's three checkboxes (Rounds / Matches / None) map onto it in
// order, and denomFilterWord composes filter words from the SAME order —
// one list, one composer, never a re-spelled token. It is the frontend
// twin of the Go contracts: store.metricDenomTokens (the filter word's
// canonical order) and store.ListMetricsPage's DENOMINATOR FILTER note,
// which is what makes a subset word canonical instead of merely valid.
// "none" is the DENOMINATOR-LESS bucket (the column's '' value) — the
// box labelled "None" — and the empty checked set therefore needs its
// own word ('empty'): the other filter groups spell their empty set
// "none", but that token is taken by a bucket here (Reading B,
// 2026-11-16).
export const METRIC_DENOMS = ['rounds', 'matches', 'none'];

// denomFilterWord(checked) — the ONE checked-set → server-word
// derivation for the Denominator group, keyed by bucket ({rounds: true,
// matches: false, none: true, …}): every box checked = '' (no predicate
// — the other groups' all-on, equivalent to listing all three), no box
// checked = 'empty' (the empty set), otherwise the canonical
// comma-subset in METRIC_DENOMS order ("rounds,none"), which is exactly
// the shape store.ListMetricsPage accepts (anything else is its
// pre-SQL rejection).
export function denomFilterWord(checked) {
  const on = METRIC_DENOMS.filter((t) => checked[t]);
  if (on.length === METRIC_DENOMS.length) return '';
  if (on.length === 0) return 'empty';
  return on.join(',');
}
