// The ONE metric value-slot state machine (stored-metrics design §5).
// Pure: rows from the canonical read + the metric's compute state + the
// unit's sibling coverage → exactly what a value slot renders. Every
// surface (Match scoreboard cells, Reports appendix, PlayerProfile's
// career panel, Builder's preview) runs THIS function, so the
// precedence can never drift between views — and because the input is
// only {state, row, unitHasRows}, the presentation carries no stamp
// field of any kind: no version number can reach a render by
// construction (design §5's no-version pin).
//
// Precedence (design §5's five states, in order):
//   processing  the transient in-flight set covers (metric, unit) — in
//               lieu of EVERYTHING (never a stale number, never bare
//               no-data mid-flight)
//   failed      the last attempt failed and no fresh row exists (the
//               error text rides the state entry, never a stamp)
//   fresh       a fresh row came back from the canonical read → the
//               value (title = formula + n)
//   no-data     the metric is fresh for this unit but has no row for
//               this player — or nothing at all to compute over → '—'
//   behind      no fresh rows for the unit and no failure recorded →
//               the chip (never computed, outdated-and-deleted and
//               rules-behind are deliberately indistinguishable)
//
// `unitHasRows` is the SIBLING coverage the design derives from the
// one read: for the match grain, rows the read returned for this match;
// for the career grain, rows in the bucket (the reads are per-unit, so
// both grains spell it as "rows for this metric > 0").

// The five state words — the complete vocabulary (GetMetricComputeState
// on the Go side; this module is the display twin).
export const METRIC_STATES = ['processing', 'failed', 'fresh', 'no-data', 'behind'];

// Titles for the states whose copy the design fixes. 'failed' takes the
// engine's error text instead (metricStateTitle), 'fresh' takes the
// caller's formula + n. None of them ever carries a version number or
// a timestamp.
const STATE_TITLES = {
  processing: 'recomputing — this value is not final yet',
  'no-data': 'no data for this player',
  behind: 'value not available yet — recompute pending',
};

// metricPresentation maps (state, the player's row, the unit's sibling
// coverage) onto what the slot renders:
//   {kind: 'value', value, n}   the stored number
//   {kind: 'nodata'}            the '—' (no fabricated 0)
//   {kind: 'chip', state}       processing | failed | behind
// An unknown/absent state (read not landed yet) renders the neutral
// dash — never a guessed chip and never a number.
export function metricPresentation(state, row, unitHasRows) {
  if (state === 'processing') return { kind: 'chip', state: 'processing' };
  if (state === 'failed') return { kind: 'chip', state: 'failed' };
  if (row) return { kind: 'value', value: row.value, n: row.n };
  if (state === 'no-data' || unitHasRows) return { kind: 'nodata' };
  if (state === 'behind') return { kind: 'chip', state: 'behind' };
  return { kind: 'nodata' };
}

// metricStateTitle is the tooltip for a non-value presentation:
// failed → the compute error text (must never look like a value),
// otherwise the fixed copy above (empty for an unknown state).
export function metricStateTitle(state, error) {
  if (state === 'failed') return error || 'compute failed';
  return STATE_TITLES[state] || '';
}

// liveMetricState merges the two state SOURCES a view holds: the LIVE
// progress feed (spectra:metric-progress — a sweep is on this metric
// right now) wins over the refetch-time GetMetricComputeState word, so
// a sweep that starts after a view mounted still flips its cells to
// processing without a refetch (design §5: processing in lieu of
// everything). stateMap is metricId → {state, error}.
export function liveMetricState(progressMap, stateMap, metricId) {
  if (progressMap && progressMap.has(metricId)) return 'processing';
  const entry = stateMap && stateMap.get(metricId);
  return (entry && entry.state) || '';
}

// metricProgressFrac is the honest k/N behind a processing chip's
// quantified bar (done/total from spectra:metric-progress); null when
// the feed carries no denominator for this metric yet — StatusChip
// then draws the indeterminate bar, never a fabricated percentage.
export function metricProgressFrac(progressMap, metricId) {
  const p = progressMap && progressMap.get(metricId);
  if (!p || !(p.total > 0)) return null;
  return p.done / p.total;
}

// metricProgressStage is the payload's phase (metrics.StageRemove |
// metrics.StageCompute) for the chip's tooltip/pct suffix — the display
// layer translates it (StatusChip STAGE_LABELS), never this module.
export function metricProgressStage(progressMap, metricId) {
  const p = progressMap && progressMap.get(metricId);
  return (p && p.stage) || '';
}
