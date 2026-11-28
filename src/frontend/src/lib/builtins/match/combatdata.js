  import { getScoreboard, getMatch, getRounds, listedPlayers } from '../../helperdefs.js';
// The Combat tab's shared reads (builtins/match: the Kill tags and Clutches
// panels both use them). The reads are the ones the Combat view always made:
// a roster from the scoreboard, the match's side switches and tick rate, and
// the round list. Nothing here reads a stored metric or a preference. The pure
// model (kinds, grouping, kill ticks) is combatmodel.js.
import { DEFAULT_TICK_RATE } from './combatmodel.js';

// loadCombatSide reads the side inputs both panels need. A failed read rejects: the
// panel shows it through the frame. A silent empty roster or side-switch count would
// colour teams wrongly, so nothing here defaults a failure.
export async function loadCombatSide(matchId) {
  const [sb, m, rd] = await Promise.all([getScoreboard(matchId, 'kills', true), getMatch(matchId), getRounds(matchId)]);
  return {
    players: listedPlayers(sb) || [],
    rounds: rd || [],
    sideSwitches: m.sideSwitches || 0,
    tickRate: m.tickRate > 0 ? m.tickRate : DEFAULT_TICK_RATE,
  };
}
