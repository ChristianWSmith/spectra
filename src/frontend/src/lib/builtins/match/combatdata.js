// The Combat tab's shared reads (builtins/match: the Kill tags and Clutches
// panels both use them). The reads are the ones the Combat view always made:
// a roster from the scoreboard, the match's side switches and tick rate, and
// the round list. Nothing here reads a stored metric or a preference. The pure
// model (kinds, grouping, kill ticks) is combatmodel.js.
import { getScoreboard, getMatch, getRounds } from '../../services.js';
import { listedPlayers } from '../../players.js';
import { DEFAULT_TICK_RATE } from './combatmodel.js';

// loadCombatSide reads the side inputs both panels need. Each read falls back
// on its own, as the view did: a failed roster or round list is an empty one.
export async function loadCombatSide(matchId) {
  const [sb, m, rd] = await Promise.all([
    getScoreboard(matchId, 'kills', true).catch(() => []),
    getMatch(matchId).catch(() => null),
    getRounds(matchId).catch(() => []),
  ]);
  return {
    players: listedPlayers(sb) || [],
    rounds: rd || [],
    sideSwitches: (m && m.sideSwitches) || 0,
    tickRate: m && m.tickRate > 0 ? m.tickRate : DEFAULT_TICK_RATE,
  };
}
