// Round helpers — the ONE frontend home for round rules: the
// counted-round predicate ("stats-eligible play") and the round-number →
// start-tick lookup behind every "jump to round N" link. Pure functions,
// no services.
//
// Cross-layer twins that must stay identical (all three are exercised by
// the golden demo):
//   - Go: analytics.CountedRounds (`!warmup && !pregame`) —
//     internal/analytics/analytics.go, whose doc comment names this file.
//   - Go: extract's renumber (internal/extract/build.go) stamps the
//     numbering the check relies on: the first real round is 1 and
//     knife/warmup rounds take NEGATIVE numbers (-2 knife, -1 warmup), so
//     `number >= 1` excludes exactly the rounds CountedRounds drops (round
//     0 never exists).
//   - Go: store.GetEconomy's SQL twin (`warmup = 0 AND pregame = 0`).
//
// Used by every round <select> (FilterBar's round filter, Heatmaps'
// from/to ranges, Match's chat round picker) and the Match Rounds tab's
// hide-warmup pref.

// isCounted reports whether a round row is counted play (number >= 1).
export function isCounted(r) {
  return !!r && r.number >= 1;
}

// roundStartTick resolves a round NUMBER to its start tick — the time a
// "jump to round N" link targets (Replay's ?round= entry seek via
// nav.entrySeekTick, and the transport's jump-to-round selector). The
// GetRounds rows carry the number/startTick pair; a missing round or a
// row without a usable start tick returns null so callers keep their
// current position — a round link must never fall back to the first
// frame or a guessed time.
export function roundStartTick(rounds, number) {
  const n = Number(number);
  const r = (rounds || []).find((x) => x && x.number === n);
  return r && Number.isFinite(r.startTick) ? r.startTick : null;
}
