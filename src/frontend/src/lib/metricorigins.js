// metricorigins.js — THE metric origin vocabulary (the origin column's
// three values in origin-rank order) and THE checked-set → origin-filter
// word mapping behind the Builder Filters popover's Origin group.
//
// METRIC_ORIGINS is the single frontend spelling of the vocabulary: the
// group's three checkboxes (Built-in / Custom / Plugin) map onto it in
// order, and originFilterWord composes filter words from the SAME order —
// one list, one composer, never a re-spelled token. It is the frontend
// twin of the Go contracts: store.metricOriginTokens (the filter word's
// canonical order — the three values store.metricOriginRank sorts by)
// and store.ListMetricsPage's ORIGIN FILTER note, which is what makes a
// subset word canonical instead of merely valid. "user" is the
// user-authored origin the Custom box selects — the same origin the
// Reports builder's Custom box filters — and "plugin" the
// installed-plugin origin.
export const METRIC_ORIGINS = ['builtin', 'user', 'plugin'];

// originFilterWord(checked) — the ONE checked-set → server-word
// derivation for the Origin group, keyed by token ({builtin: true,
// user: false, …}): every box checked = '' (no predicate — the other
// groups' all-on), no box checked = 'none' (the empty set, the same
// spelling the other groups use), otherwise the canonical
// comma-subset in METRIC_ORIGINS order ("builtin,plugin"), which is
// exactly the shape store.ListMetricsPage accepts (anything else is
// its pre-SQL rejection).
export function originFilterWord(checked) {
  const on = METRIC_ORIGINS.filter((t) => checked[t]);
  if (on.length === METRIC_ORIGINS.length) return '';
  if (on.length === 0) return 'none';
  return on.join(',');
}
