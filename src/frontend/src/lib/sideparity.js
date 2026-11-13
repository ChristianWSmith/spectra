// Canonical CS2 side-parity (half-switch) arithmetic — the JavaScript twin
// of internal/rules (Go). ONE rule: for a match with n COUNTED rounds and
// `switches` recorded side switches, switch k (1-based) lands on counted
// index (0-based, the first round AFTER the switch)
//
//   - 12                       — switch 1, after counted round 12
//   - 27 + 3 * (k - 2)         — switch k >= 2 (after 27, then every 3
//     rounds while OTs tie; NO switch at overtime start)
//
// so the side-switch rounds are 12, 27, 30, 33, … (CS2.md, "MR12
// regulation + MR3 overtime"). The counted rounds therefore do NOT split
// into equal eras — e.g. 28 counted rounds with 2 switches flip at 12 and
// 27, giving eras of 12 / 15 / 1 rounds.
//
// Both languages assert the same fixture — internal/rules/testdata/
// sideparity.json — from internal/rules/sideparity_test.go (Go) and
// frontend/src/lib/sideparity.test.js (node --test src/lib/sideparity.test.js).
// RoundStrip consumes eraOf()/sideInEra() per cell; startSideFor (era 0)
// feeds the team-identity name colors through lib/teams.js; teamKeyAt
// maps a round's side onto the TEAM behind it for per-team rollups;
// sideAtRound maps a round NUMBER onto the side played in that round for
// the per-round name colors (lib/teams.js playerSideClassAt); and
// winnerTeamKey maps a round's winner side onto the winning TEAM for the
// per-round winner cells (components/WinnerCell.svelte).

import { isCounted } from './rounds.js';

// flipIndexes returns the counted-round indexes (0-based, ascending) where
// side switches happen, per the cadence in the header comment (12, then
// 27 + 3*(k-2)). Boundaries outside (0, n) are dropped — a match too short
// to reach the switch yields no flip.
export function flipIndexes(counted, switches) {
  const n = Number.isFinite(counted) ? Math.trunc(counted) : 0;
  const s = Number.isFinite(switches) ? Math.trunc(switches) : 0;
  if (n <= 0 || s <= 0) return [];
  const flips = [];
  for (let k = 1; k <= s; k++) {
    const idx = k === 1 ? 12 : 27 + 3 * (k - 2);
    if (idx > 0 && idx < n) flips.push(idx);
  }
  return flips;
}

// eraOf returns the era (half index) of the counted round at `index`: how
// many switch boundaries are at or before it. RoundStrip derives each cell's
// side label from this, so a moved boundary flips the labels of every round
// from it onward.
export function eraOf(index, flips) {
  let era = 0;
  for (const flip of flips) {
    if (flip <= index) era++;
  }
  return era;
}

// startSideFor returns the side the team that ENDED on `finalSide` played
// in the FIRST half — 'ct' | 't', or null when finalSide is not a side
// (missing data never gets a guessed side). This is the input for the
// team-identity colors (started CT → indigo, started T → orange),
// independent of the live side, which swaps at halftime. It is the
// era-0 form of sideInEra below.
export function startSideFor(finalSide, sideSwitches) {
  return sideInEra(finalSide, sideSwitches, 0);
}

// sideInEra returns the side that team played in half `era` (0 = first
// half): startSideFor flipped once per half boundary crossed. The team's
// side in the LAST era is finalSide, so era e is finalSide flipped
// (eras - 1 - e) times where eras = switches + 1; only the parity of that
// count matters (and parity ignores the sign, so an era past the last one
// still resolves). RoundStrip renders every cell's side label from this —
// the one derivation behind both the strip arrows and the start-side name
// colors, so they can never disagree.
export function sideInEra(finalSide, sideSwitches, era) {
  if (finalSide !== 'ct' && finalSide !== 't') return null;
  const s = Number.isFinite(sideSwitches) ? Math.trunc(sideSwitches) : 0;
  const e = Number.isFinite(era) ? Math.trunc(era) : 0;
  const eras = Math.max(1, s + 1);
  const flips = Math.abs(eras - 1 - e) % 2;
  if (flips === 0) return finalSide;
  return finalSide === 'ct' ? 't' : 'ct';
}

// teamKeyAt maps the SIDE a team played in the counted round at `index`
// to that TEAM, keyed by the team's FINAL side — the key lib/teams.js
// uses for display names and identity colors. Sides swap at every half,
// so 'ct' names one team before the switch and the other after it: any
// per-TEAM rollup (never per-side) resolves each round through this
// instead of treating a side as a team. `counted` is the number of
// counted rounds in the match — the same length RoundStrip feeds
// flipIndexes — and `sideSwitches` the match's recorded side switches.
// An unknown side maps to null: missing data never gets a guessed team.
// Frontend-only composition over the primitives above (the Go rollups
// read the exact round_player_sides samples rather than parity).
export function teamKeyAt(side, index, counted, switches) {
  if (side !== 'ct' && side !== 't') return null;
  const era = eraOf(index, flipIndexes(counted, switches));
  return sideInEra('ct', switches, era) === side ? 'ct' : 't';
}

// sideAtRound maps a round NUMBER to the side a team played in THAT round
// — the per-round form of startSideFor for surfaces that show data about
// one round (a round's MVP/first blood, a kill row): the round's position
// among the COUNTED rounds (lib/rounds.js isCounted — knife and warmup
// rounds never reach a switch, so they read as era 0, exactly like
// RoundStrip's cells) picks the era, then sideInEra resolves `finalSide`
// (the team's FINAL side) into it. RoundStrip derives its per-cell sides
// through this helper, so the strip arrows and the per-round name colors
// can never disagree. Returns null when the round is not in `rounds` or
// finalSide is not a side — missing data never gets a guessed side.
// Frontend-only composition over the primitives above.
export function sideAtRound(rounds, sideSwitches, roundNumber, finalSide) {
  if (finalSide !== 'ct' && finalSide !== 't') return null;
  const list = Array.isArray(rounds) ? rounds : [];
  if (!list.some((r) => r && r.number === roundNumber)) return null;
  const s = Number.isFinite(sideSwitches) ? Math.trunc(sideSwitches) : 0;
  const counted = list.filter(isCounted);
  const idx = counted.findIndex((r) => r && r.number === roundNumber);
  const flips = flipIndexes(counted.length, s);
  const eras = Math.max(1, s + 1);
  const era = idx < 0 ? 0 : Math.min(eras - 1, eraOf(idx, flips));
  return sideInEra(finalSide, s, era);
}

// winnerTeamKey maps the WINNER of one round (its round number + the
// side it was won by) onto the TEAM that won it, keyed by the team's
// FINAL side — the key lib/teams.js names (teamNames) are keyed by, so
// a round's winner cell can show a team NAME instead of the side name
// that swaps meaning at halftime. Round-number based (through
// sideAtRound), so a surface that re-filters its rows — counted-only
// economy rows — can never move the answer.
//
// The derivation: sideAtRound answers which side the team that FINISHED
// CT played in that round; if that side is the winning side, the winner
// is the final-CT team ('ct'), otherwise the final-T team ('t').
//
// Unknown never gets a guessed team: an unrecorded winner ('' — an
// unfinished/deserted round), a round not in `rounds`, or a `rounds`
// list that has not loaded yet all return null, and callers fall back to
// the bare side chip. Frontend-only composition over sideAtRound.
export function winnerTeamKey(rounds, sideSwitches, roundNumber, winnerSide) {
  if (winnerSide !== 'ct' && winnerSide !== 't') return null;
  const ctSide = sideAtRound(rounds, sideSwitches, roundNumber, 'ct');
  if (ctSide === null) return null;
  return ctSide === winnerSide ? 'ct' : 't';
}
