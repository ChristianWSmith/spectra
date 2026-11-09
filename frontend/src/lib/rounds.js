// Round helpers — the ONE frontend home for round rules: the
// counted-round predicate ("stats-eligible play"), the round-number →
// start-tick lookup behind every "jump to round N" link, the
// scoreline-through-a-round aggregate, and the round-ribbon separator
// rule. Pure functions, no services.
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
// Used by every round range/select (Heatmaps' from/to ranges, Match's
// chat round picker, FilterBar's round from/to bounds) and the Match
// Rounds tab's hide-warmup pref.

// isCounted reports whether a round row is counted play (number >= 1).
export function isCounted(r) {
  return !!r && r.number >= 1;
}

// separatorAfter — THE one round-ribbon separator rule (RoundStrip's
// `.round-split` marker): true for the counted round a separator
// FOLLOWS. Cadence — after 12 (MR12 halftime: regulation halves are
// rounds 1-12 | 13-24), after 24 (regulation's end / the OT boundary),
// then every 3 counted rounds (OT is MR3: … | 25 26 27 | 28 29 30 |
// 31 32 33 | …), i.e. 12, 24, 27, 30, 33, …. Round numbering stays
// dense 1..N through OT (extract's renumber never resets per half —
// see the cross-layer twin note above), so the argument is the
// counted-round NUMBER itself; knife/warmup negatives are never
// separators (callers gate on isCounted first).
//
// Companion rule kept OUT of this predicate on purpose: a marker
// renders only when at least one MORE counted round follows it (a match
// ending exactly on a boundary cell gets no dangling marker) — that
// depends on the visible cell list and lives in RoundStrip.svelte.
//
// Display convention, not side parity: the real side switches fall at
// 12, 27, 30, … (no switch at OT start — teams keep regulation sides
// for rounds 25-27); the marker after 24 marks the regulation/OT
// boundary instead. See CS2.md "MR12 regulation + MR3 overtime".
export function separatorAfter(countedRoundNumber) {
  const n = Number(countedRoundNumber);
  if (!Number.isFinite(n)) return false;
  if (n === 12) return true; // MR12 halftime
  return n >= 24 && (n - 24) % 3 === 0; // regulation end + OT's 3-round halves
}

// roundIndexLabel renders a round's DISPLAY label: counted rounds show
// their number ("12"), while negative ingest indices (extract's renumber)
// show a single letter — the knife round shows "K" and every other
// negative index shows "W" (warmup). A demo can carry more than one
// warmup (they number backwards from round 1: -3 warmup, -2 knife,
// -1 warmup), so the letter is decided by the round ROW's flags when a
// row is available (pregame → K, warmup → W); a bare number falls back
// to the number rule (-2 → K, any other negative → W). Used by the Match
// ribbon (RoundStrip) and the Replay landmark feed's round column.
export function roundIndexLabel(r) {
  if (r && typeof r === 'object') {
    if (r.pregame) return 'K';
    if (r.warmup) return 'W';
    return roundIndexLabel(r.number);
  }
  if (r == null || r === '') return '';
  const n = Number(r);
  if (!Number.isFinite(n)) return '';
  if (n >= 1) return String(n);
  return n === -2 ? 'K' : 'W';
}

// roundStartTick resolves a round NUMBER to its start tick — the time a
// "jump to round N" link targets (Replay's round-scope entry seek via
// nav.entrySeekTick, and Replay's round ribbon). The
// GetRounds rows carry the number/startTick pair; a missing round or a
// row without a usable start tick returns null so callers keep their
// current position — a round link must never fall back to the first
// frame or a guessed time.
export function roundStartTick(rounds, number) {
  const n = Number(number);
  const r = (rounds || []).find((x) => x && x.number === n);
  return r && Number.isFinite(r.startTick) ? r.startTick : null;
}

// inFreezeTime — the ONE freeze-phase predicate: true while `tick` sits
// inside a round's FREEZE time (round start ≤ tick < freezeEndTick).
// Freeze is where the game forbids firing, so no gun sound, no utility
// sound and no tracer may play there (replay/bullets.js filters bullets
// with it; replay/sfx.js gates utility/knife cues with it). The usable-
// window rule mirrors the HUD round clock's honest fallback (renderer.js
// roundClockLine): a row without a real window — the warmup row ships
// start/freezeEnd 0, a corrupt row may ship freezeEnd ≤ start — reports
// false rather than guessing, so such rounds never silence anything.
// Rounds arrive number-ordered (= start-tick-ordered), but the scan
// tolerates any order by taking the LAST row whose start reaches tick.
export function inFreezeTime(rounds, tick) {
  if (!Number.isFinite(tick)) return false;
  let best = null;
  for (const r of rounds || []) {
    if (!r || !Number.isFinite(r.startTick) || r.startTick > tick) continue;
    if (!best || r.startTick > best.startTick) best = r;
  }
  if (!best) return false;
  const fe = best.freezeEndTick;
  return Number.isFinite(fe) && fe > best.startTick && tick < fe;
}

// scoreThrough — the ONE scoreline-at-a-round aggregate: cumulative
// counted-round WINS by side through `roundNumber` inclusive ({ct, t}).
// Rounds are numbered in time order, so "number <= round" is "through
// this round"; isCounted drops knife/warmup rows and unknown winners
// (winner === "") count for neither side. Consumers: RoundDetail's
// scoreline and Replay's HUD score (which passes the last round that
// ENDED at the playhead, so a mid-round readout never shows a result
// the round has not produced yet). Pure view aggregate over already-
// fetched rows — see AGENTS.md "View-level aggregates".
export function scoreThrough(rounds, roundNumber) {
  const n = Number(roundNumber);
  let ct = 0;
  let t = 0;
  for (const r of rounds || []) {
    if (!isCounted(r) || !Number.isFinite(n) || r.number > n) continue;
    if (r.winner === 'ct') ct++;
    else if (r.winner === 't') t++;
  }
  return { ct, t };
}
