// Team display names. Pure functions — no services.
//
// Sides ("ct"/"t") switch at halftime, so a side never names a TEAM: show
// the demo's clan name when the extract recorded one (MatchSummary
// ctName/tName — teams.name is keyed by the team's FINAL side), otherwise
// synthesize a name after one of its players, in the golden demo's style:
// `team_<playerName>` (e.g. team_kRaSnaL). Only when no player on a side
// has a recorded side at all (a known data-quality gap) do we fall back to
// the bare side as a last resort.

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
