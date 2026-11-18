// metricformats.js — THE metric format vocabulary (the format column's
// seven values in their canonical enum order) and THE checked-set →
// format-filter word mapping behind the Builder Filters popover's Type
// group.
//
// METRIC_FORMATS is the single frontend spelling of the vocabulary: the
// editor's Format select renders its SELECTABLE members, and
// formatFilterWord composes filter words from the SAME order — one
// list, both consumers, never a re-spelled token. It is the frontend
// twin of the Go contracts: metricservice.go's metricFormats (accepted
// Format values) and store.metricFormatTokens (the filter word's
// canonical order), which is what makes a subset word canonical instead
// of merely valid. "auto" is the form's own Auto: its stored value is
// the format column's '' — the store binds that token as `format = ?`
// with the empty string (store.ListMetricsPage's FORMAT FILTER).
//
// `identity` is FILTER-ONLY (metrics expansion Phase 7, 2026-11-18):
// the Type group offers it so the key-valued identity metrics are
// selectable in the list, but the editor's Format select never OFFERS
// it as a fresh choice — identity belongs to a definition whose
// expression leads with argmax under subject=match — a combination the
// editor's Subject select (2026-11-18) now makes authorable, so the
// premise moved: what still withholds identity is that the format
// select has never been gated on the expression's SHAPE, so offering it
// as a fresh choice would invite a value-less metric. `filterOnly` marks that split;
// entries WITHOUT it are the selectable set (the editor renders
// METRIC_FORMATS.filter(f => !f.filterOnly), and a loaded definition
// already carrying the filter-only token still shows it — see
// Builder's editorFormats).
export const METRIC_FORMATS = [
  { token: 'auto', value: '' },
  { token: 'int', value: 'int' },
  { token: 'float1', value: 'float1' },
  { token: 'float2', value: 'float2' },
  { token: 'percent', value: 'percent' },
  { token: 'currency', value: 'currency' },
  { token: 'identity', value: 'identity', filterOnly: true },
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
