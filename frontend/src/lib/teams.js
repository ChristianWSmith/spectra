// Team display names, team identity colors and display-order helpers.
// Pure functions — no services.
//
// Sides ("ct"/"t") switch at halftime, so a side never names a TEAM: show
// the demo's clan name when the extract recorded one (MatchSummary
// ctName/tName — teams.name is keyed by the team's FINAL side), otherwise
// synthesize a name after one of its players, in the golden demo's style:
// `team_<playerName>` (e.g. team_kRaSnaL). Only when no player on a side
// has a recorded side at all (a known data-quality gap) do we fall back to
// the bare side as a last resort.
//
// CROSS-LAYER TWIN: Go's report.synthTeamNames (internal/report/report.go)
// implements the same synthesis for surfaces with store access, and the
// MatchService.GetTeamNames getter serves it to the frontend. The Go
// fixture is TestSynthTeamNames (internal/report/report_test.go); this
// file's fixture is src/lib/teams.test.js — same inputs/outputs, same
// tie-break. Keep the three in sync or the labels diverge per surface.

import { startSideFor } from './sideparity.js';

// pickPlayer chooses the player used to name one side's team: the lowest
// SteamID on that side (then name). Deterministic by design — callers pass
// scoreboards the user may have re-sorted, so input order must not matter
// (SteamID64s share a length, so string compare orders them numerically).
function pickPlayer(players, side) {
  let best = null;
  for (const p of players || []) {
    if (!p || p.side !== side || !p.name) continue;
    if (!best) {
      best = p;
      continue;
    }
    const id = p.steamId || '';
    const bestId = best.steamId || '';
    if (id < bestId || (id === bestId && p.name < best.name)) best = p;
  }
  return best;
}

// synthTeamName returns `team_<playerName>` for the players on side
// ("ct" | "t"), or '' when no player on that side records a side.
export function synthTeamName(players, side) {
  const p = pickPlayer(players, side);
  return p ? `team_${p.name}` : '';
}

// teamNames resolves the display names of a match's two teams from a
// summary row (demo clan names, may be empty) plus the scoreboard rows:
// demo name → synthesized player-derived name → bare side, per side.
// Returns { ct, t } — both always non-empty.
export function teamNames({ ctName = '', tName = '', players = [] } = {}) {
  return {
    ct: ctName || synthTeamName(players, 'ct') || 'CT',
    t: tName || synthTeamName(players, 't') || 'T',
  };
}

// displayHalfScore orders a match's halftime score the way the match view
// shows its teams: the scoreline, the round-strip labels and the roster
// headings all put the team that FINISHED CT first, while halfCT/halfT are
// stored in FIRST-half side terms (extract flips the halftime score back to
// the sides it was played on — internal/extract/agg.go halfPending). After
// an odd number of side switches the two orders disagree and the numbers
// must swap: the golden demo is 8/4 as stored and reads "half 4–8" in
// display order. Returns { first, second } for the team shown first/second;
// missing or non-numeric fields read as 0 — total, never throws.
export function displayHalfScore(match) {
  const halfCT = Number(match?.halfCT) || 0;
  const halfT = Number(match?.halfT) || 0;
  const sideSwitches = Number(match?.sideSwitches) || 0;
  // startSideFor('ct') is the canonical final-side → first-half-side
  // derivation (lib/sideparity.js): 't' means the team shown first played
  // T in the first half, so its half score is the stored halfT.
  return startSideFor('ct', sideSwitches) === 't'
    ? { first: halfT, second: halfCT }
    : { first: halfCT, second: halfT };
}

// --- Team identity colors (changes.txt #10/#20) ----------------------------
// A TEAM's color comes from the side it played in the FIRST half: started
// CT → indigo (.team-start-ct), started T → orange (.team-start-t) —
// never the live side, which swaps at halftime. The start side comes from
// the canonical side-parity helper (sideparity.startSideFor), so the
// colors can't drift from the strip's own side derivation; the classes
// live in public/style.css next to the side colors they complement.

// teamStartClass maps a team's FINAL side ('ct' | 't') to its identity
// color class; an unknown side yields '' — missing data never gets a
// guessed color.
export function teamStartClass(finalSide, sideSwitches) {
  const start = startSideFor(finalSide, sideSwitches);
  return start === 'ct' ? 'team-start-ct' : start === 't' ? 'team-start-t' : '';
}

// playerStartClass resolves ONE name surface (a scoreboard row, a round's
// MVP/first-blood, a kill-feed killer…) to its team's color class: the
// player's FINAL side, looked up by steam id first and exact display name
// as the fallback (round/chat rows may carry only a name). Unresolvable →
// '' — best effort, no guessing.
export function playerStartClass(players, sideSwitches, steamId, name) {
  let side = '';
  if (steamId) {
    const byId = (players || []).find((p) => p && p.steamId === steamId);
    if (byId) side = byId.side || '';
  }
  if (!side && name) {
    const byName = (players || []).find((p) => p && p.name === name);
    if (byName) side = byName.side || '';
  }
  return teamStartClass(side, sideSwitches);
}
