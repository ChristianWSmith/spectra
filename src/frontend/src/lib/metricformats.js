// metricformats.js — THE metric format vocabulary (the format column's
// six values in their canonical enum order) and THE checked-set →
// format-filter word mapping behind the Builder Filters popover's Type
// group.
//
// METRIC_FORMATS is the single frontend spelling of the vocabulary: the
// editor's Format select renders from it, and formatFilterWord composes
// filter words from the SAME order — one list, both consumers, never a
// re-spelled token. It is the frontend twin of the Go contracts:
// metricservice.go's metricFormats (accepted Format values) and
// store.metricFormatTokens (the filter word's canonical order), which
// is what makes a subset word canonical instead of merely valid.
// "auto" is the form's own Auto: its stored value is the format
// column's '' — the store binds that token as `format = ?` with the
// empty string (store.ListMetricsPage's FORMAT FILTER).
export const METRIC_FORMATS = [
  { token: 'auto', value: '' },
  { token: 'int', value: 'int' },
  { token: 'float1', value: 'float1' },
  { token: 'float2', value: 'float2' },
  { token: 'percent', value: 'percent' },
  { token: 'currency', value: 'currency' },
];

// formatFilterWord(checked) — the ONE checked-set → server-word
// derivation for the Type group, keyed by token ({auto: true, int:
// false, …}): every format checked = '' (no predicate — the other
// groups' all-on), none checked = 'none' (the empty set), otherwise
// the canonical comma-subset in METRIC_FORMATS order ("auto,percent"),
// which is exactly the shape store.ListMetricsPage accepts (anything
// else is its pre-SQL rejection).
export function formatFilterWord(checked) {
  const on = METRIC_FORMATS.filter((f) => checked[f.token]).map((f) => f.token);
  if (on.length === METRIC_FORMATS.length) return '';
  if (on.length === 0) return 'none';
  return on.join(',');
}
