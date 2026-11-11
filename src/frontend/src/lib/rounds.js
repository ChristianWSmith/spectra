// Round helpers — the ONE frontend home for round rules: the
// counted-round predicate ("stats-eligible play"), the round-number →
// start/end-tick lookups behind every "jump to round N" link and every
// round-span loop range, the scoreline-through-a-round aggregate, and the
// round-group separator rule (the cadence + its gating over a rendered
// list). Pure functions, no services.
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
// Companion rule kept OUT of this predicate on purpose: whether a marker
// actually RENDERS depends on the visible row list (counted-gating and
// trailing suppression) — that composition is separatorFlags below.
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

// separatorFlags — THE separator GATING over one rendered round list: an
// array aligned index-for-index with `rows`, true where a separator
// FOLLOWS that row. It composes the cadence above (separatorAfter) with
// the two render-time rules that depend on the visible list — the
// semantics that used to live inline in RoundStrip.svelte:
//
//   - counted-gating: only a counted row can carry a separator, counted
//     by its ORDINAL among the counted rows of this list (negative
//     knife/warmup rows never increment the counter, so showing them —
//     the Rounds/RoundStrip warmup pref — can never shift a marker);
//   - trailing suppression: the LAST counted row never carries one (the
//     boundary needs at least one more counted round after it), so a
//     match ending exactly on 12/24/27/30/33 gets no dangling marker.
//
// Consumers: RoundStrip renders its `.round-split` span right after a
// flagged cell; the Rounds and Economy tables put a class on the
// FOLLOWING data row (row i reads flags[i - 1] → `.split-before` in
// style.css), which is the same rule seen from the other side — the
// trailing case is covered here, and in a table the follower simply
// cannot exist past the last row. Non-array input reads as [].
export function separatorFlags(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const countedTotal = list.filter(isCounted).length;
  let seen = 0;
  return list.map((r) =>
    isCounted(r) ? ++seen < countedTotal && separatorAfter(seen) : false,
  );
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

// roundEndTick resolves a round NUMBER to its END tick — the closing
// bound of a round-span link (the "Watch round" / "Replay start" loop
// range, nav.entryLoopSpan), the exact twin of roundStartTick above and
// the same never-a-guess contract: a missing round or a row without a
// usable end tick returns null, so callers stamp NO loop rather than a
// bound they do not know.
export function roundEndTick(rounds, number) {
  const n = Number(number);
  const r = (rounds || []).find((x) => x && x.number === n);
  return r && Number.isFinite(r.endTick) ? r.endTick : null;
}

// freezeWindowAt — the ONE freeze WINDOW: the {start, end} bounds of the
// round whose freeze contains `tick` (start ≤ tick < freezeEndTick, a
// half-open window), or null when no round has a usable one. The window
// is exactly the rule inFreezeTime reports on — this is its canonical
// home, so both can never disagree. A row without a real window — the
// warmup row ships start/freezeEnd 0, a corrupt row may ship
// freezeEnd ≤ start — yields null rather than guessing, so callers skip
// (or silence) nothing they do not actually know. Rounds arrive
// number-ordered (= start-tick-ordered), but the scan tolerates any
// order by taking the LAST row whose start reaches tick.
//
// Consumers: inFreezeTime (the freeze-phase predicate behind bullets.js
// / sfx.js), and the replay engine's auto-skip of the pre-round freeze
// (skipFreeze jumps playhead → freezeEndTick, the first-action tick).
export function freezeWindowAt(rounds, tick) {
  if (!Number.isFinite(tick)) return null;
  let best = null;
  for (const r of rounds || []) {
    if (!r || !Number.isFinite(r.startTick) || r.startTick > tick) continue;
    if (!best || r.startTick > best.startTick) best = r;
  }
  if (!best) return null;
  const fe = best.freezeEndTick;
  if (!Number.isFinite(fe) || fe <= best.startTick || tick >= fe) return null;
  return { start: best.startTick, end: fe };
}

// inFreezeTime — the ONE freeze-phase predicate: true while `tick` sits
// inside a round's FREEZE time (round start ≤ tick < freezeEndTick).
// Freeze is where the game forbids firing, so no gun sound, no utility
// sound and no tracer may play there (replay/bullets.js filters bullets
// with it; replay/sfx.js gates utility/knife cues with it). The usable-
// window rule is freezeWindowAt's (above) — the HUD round clock's honest
// fallback (renderer.js roundClockLine) reports false rather than
// guessing, so a row without a real window never silences anything.
export function inFreezeTime(rounds, tick) {
  return freezeWindowAt(rounds, tick) !== null;
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
