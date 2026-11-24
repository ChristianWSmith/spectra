// The helper functions the Economy and Utility builtins import. They live in
// this one module: a compiled builtin imports the names it uses from here, and
// componentruntime/compile.js's BUILTIN_HELPERS registry lists which names a
// builtin may take (a user component takes none). Each name is the canonical
// function of its module (lib/fmt.js, rounds.js, sideparity.js, teams.js,
// econ.js, nav.js), imported and re-exported here; this module holds no second
// implementation. The only own function is chatTag, which draws its tags from
// the strings catalog. builtinhelpers.test.js pins the re-exports.
//
// Rules the builtins keep (AGENTS.md "Builtin conventions"): a missing value is
// a dash, never a zero (ruling 23); a stored value is never recomputed here
// except where the Go read it replaces does the same arithmetic on rows the
// view has already fetched (AGENTS.md "View computation"). The loss-bonus
// reconstruction and the side-flip detection are that second kind: they are
// the Go functions applyLossBonuses and sideFlips (internal/store/analytics.go)
// over the round rows the economy query returns, copied line for line.

// FMT: number and clock formatting. The one implementation is lib/fmt.js:
// the names below are imported from it (the locals the module uses) and
// re-exported (the names a builtin imports from here). DASH is the one dash a
// missing cell shows; fmt.js writes the same character.
import { round1, fmtInt, fmt1, fmt2, fmtMoney, fmtMs, fmtClock, fmtZeroDash, tickSeconds, normTickRate, roundClock, chatClock } from './fmt.js';
import { isCounted } from './rounds.js';
import { playerSideClassAt } from './teams.js';
import * as S from './strings/index.js';
import { econColumns, econValue, lossPips } from './econ.js';
import { entryLoopAround, entryLoopSpan, isSteam } from './nav.js';
import { moneyResetIndexes, roundEndTick, roundIndexLabel, roundScoreLabel, roundStartTick, scoreThrough, separatorAfter, separatorFlags } from './rounds.js';
import { eraOf, flipIndexes, sideAtRound, sideInEra, startSideFor, teamKeyAt, winnerTeamKey } from './sideparity.js';
import { synthTeamName, teamNames, teamStartClass } from './teams.js';
export { econColumns, econValue, entryLoopAround, entryLoopSpan, eraOf, flipIndexes, isSteam, lossPips, moneyResetIndexes, roundEndTick, roundIndexLabel, roundScoreLabel, roundStartTick, scoreThrough, separatorAfter, separatorFlags, sideAtRound, sideInEra, startSideFor, synthTeamName, teamKeyAt, teamNames, teamStartClass, winnerTeamKey };
export { round1, fmtInt, fmt1, fmt2, fmtMoney, fmtMs, fmtClock, fmtZeroDash, tickSeconds, normTickRate, roundClock, chatClock, isCounted };
export const DASH = '\u2014';
export function roundsByNumber(rounds) {
  return new Map((rounds || []).map((r) => [r.number, r]));
}

export function pickPlayer(players, side) {
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
export function resolveSide(players, steamId, name) {
  let side = '';
  if (steamId) {
    const byId = (players || []).find((p) => p && p.steamId === steamId);
    if (byId) side = byId.side || '';
  }
  if (!side && name) {
    const byName = (players || []).find((p) => p && p.name === name);
    if (byName) side = byName.side || '';
  }
  return side;
}
export function sideClassOf(side) {
  return side === 'ct' ? 'side-ct' : side === 't' ? 'side-t' : '';
}
// playerSideClassAt is teams.js's (the one implementation); a builtin imports it from here.
export { playerSideClassAt };
// roundSideClassOf binds playerSideClassAt to a panel's match data: the returned
// (roundNumber, steamId, name) → class reads the data as it is at each call.
export function roundSideClassOf(getScope) {
  return (roundNumber, steamId, name) => {
    const { players, sideSwitches, rounds } = getScope();
    return playerSideClassAt(players, sideSwitches, rounds, roundNumber, steamId, name);
  };
}

// sideFlips: per row index, whether the side-to-team mapping changed from the
// row before (a player observed on the other side proves the switch).
export function sideFlips(rows, exact) {
  const n = rows.length;
  const flips = new Array(n).fill(false);
  for (let i = 1; i < n; i++) {
    const prev = exact.get(rows[i - 1].round) || new Map();
    const cur = exact.get(rows[i].round) || new Map();
    if (prev.size === 0 || cur.size === 0) continue;
    for (const [sid, ps] of prev) {
      const cs = cur.get(sid);
      if (cs !== undefined && ps !== '' && cs !== '' && ps !== cs) {
        flips[i] = true;
        break;
      }
    }
  }
  return flips;
}
// applyLossBonuses: the bonus a side's team collects by losing each round.
// The per-team loss count steps up after a loss and down after a win, from
// a start of 1 at every half. Sides re-map to teams at each flip.
export function applyLossBonuses(rows, flips) {
  const bonus = (count) => 1400 + 500 * Math.min(count, 4);
  const stepDown = (c) => (c > 0 ? c - 1 : 0);
  const stepUp = (c) => (c < 4 ? c + 1 : 4);
  const counts = [1, 1];
  let flip = false;
  const teamOn = (side) => {
    const ctIsA = !flip;
    if (side === 'ct') return ctIsA ? 0 : 1;
    return ctIsA ? 1 : 0;
  };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (i < flips.length && flips[i]) {
      flip = !flip;
      counts[0] = 1;
      counts[1] = 1;
    }
    const ct = teamOn('ct');
    const t = teamOn('t');
    r.lossBonusCT = bonus(counts[ct]);
    r.lossBonusT = bonus(counts[t]);
    if (r.winner === 'ct') {
      counts[ct] = stepDown(counts[ct]);
      counts[t] = stepUp(counts[t]);
    } else if (r.winner === 't') {
      counts[t] = stepDown(counts[t]);
      counts[ct] = stepUp(counts[ct]);
    }
  }
  return rows;
}
// buildEconRows shapes the economy query's rows (see ECON_SQL in the
// economy panels) and the round-side samples into the view's economy rows.
export function buildEconRows(ecoRows, sideRows) {
  const rows = ecoRows.map((x) => ({
    round: Number(x[0]),
    winner: x[1] || '',
    equipCT: Number(x[2]) || 0,
    equipT: Number(x[3]) || 0,
    moneyCT: Number(x[4]) || 0,
    moneyT: Number(x[5]) || 0,
    spentCT: Number(x[6]) || 0,
    spentT: Number(x[7]) || 0,
    freePistolCT: Number(x[8]) || 0,
    freePistolT: Number(x[9]) || 0,
    label: x[10] || '',
    explanation: x[11] || '',
    ruleVersion: Number(x[12]) || 0,
    classCT: x[13] || '',
    classWhyCT: x[14] || '',
    classT: x[15] || '',
    classWhyT: x[16] || '',
    pistolRound: (x[10] || '') === 'pistol',
    wonCT: x[1] === 'ct',
    wonT: x[1] === 't',
  }));
  const exact = new Map();
  for (const s of sideRows) {
    const round = Number(s[0]);
    if (!exact.has(round)) exact.set(round, new Map());
    exact.get(round).set(s[1], s[2]);
  }
  applyLossBonuses(rows, sideFlips(rows, exact));
  return rows;
}

export function hashOf(path, query) {
  const parts = [];
  for (const k of Object.keys(query)) {
    const v = query[k];
    if (v == null || v === '') continue;
    const val = encodeURIComponent(String(v)).replace(/%2F/g, '/').replace(/%2C/g, ',');
    parts.push(k + '=' + val);
  }
  return parts.length ? path + '?' + parts.join('&') : path;
}
export function asTick(v) {
  return v == null || v === '' ? NaN : Number(v);
}
export function replayRoute(matchId, extras) {
  return hashOf('/replay/' + matchId, extras);
}


// The route to a player's profile.
export function playerRoute(steam) {
  return '/player/' + steam;
}

// Open a player's profile (the name link on every builtin that lists players).
export function openPlayer(spectra, steam) {
  spectra.navigate(playerRoute(steam));
}

// The replay route a row opens, following that player. `back` is the tab the
// panel sits on; the replay returns there.
export function followRoute(matchId, back, steam) {
  const to = back || 'match/' + matchId;
  return '/replay/' + matchId + '?back=' + encodeURIComponent(to).replace(/%2F/g, '/') + '&follow=' + steam;
}

// Open the replay following a player.
export function followPlayer(spectra, matchId, back, steam) {
  spectra.navigate(followRoute(matchId, back, steam));
}

// CHAT: a chat line's clock and speaker tag (lib/fmt.js chatClock / chatTag).
// The round prefix is RD (RD12 0:47), and team chat tags the speaker's side.
export function chatTag(channel, side) {
  if (channel === 'all') return S.match.chatTagAll;
  if (channel === 'team') {
    const s = String(side || '').toLowerCase();
    if (s === 'ct') return S.match.chatTagCt;
    if (s === 't') return S.match.chatTagT;
  }
  return '';
}

// The economy of one match, read the way the Economy view reads it: the rounds, the economy rows, the team names,
// the side switches and the winner. The Economy composer loads it for its panels; a panel mounted alone (a
// component preview) loads it itself. Null when there is no match to read.
const SQL_MATCH = 'SELECT score_ct, score_t, side_switches FROM matches WHERE id = :match_id';
const SQL_ROUNDS = 'SELECT number, winner, start_tick, end_tick FROM rounds WHERE match_id = :match_id ORDER BY number';
const SQL_ECON =
  'SELECT r.number, r.winner, r.equip_ct, r.equip_t, ' +
  'COALESCE(ct.money_sampled_sum, 0), COALESCE(t.money_sampled_sum, 0), ' +
  'COALESCE(ct.spent, 0), COALESCE(t.spent, 0), ' +
  'COALESCE(ct.free_pistol_value, 0), COALESCE(t.free_pistol_value, 0), ' +
  "COALESCE(rc.label, ''), COALESCE(rc.explanation, ''), COALESCE(rc.rule_version, 0), " +
  "COALESCE(rsct.class, ''), COALESCE(rsct.why, ''), COALESCE(rst.class, ''), COALESCE(rst.why, '') " +
  'FROM rounds r ' +
  "LEFT JOIN round_economy ct ON ct.match_id = r.match_id AND ct.round = r.number AND ct.side = 'ct' " +
  "LEFT JOIN round_economy t ON t.match_id = r.match_id AND t.round = r.number AND t.side = 't' " +
  'LEFT JOIN round_classifications rc ON rc.match_id = r.match_id AND rc.round = r.number ' +
  "LEFT JOIN round_side_classes rsct ON rsct.match_id = r.match_id AND rsct.round = r.number AND rsct.side = 'ct' " +
  "LEFT JOIN round_side_classes rst ON rst.match_id = r.match_id AND rst.round = r.number AND rst.side = 't' " +
  'WHERE r.match_id = :match_id ORDER BY r.number ASC';
const SQL_SIDES =
  'SELECT round, steam_id, side FROM round_player_sides WHERE match_id = :match_id ORDER BY round ASC, steam_id ASC';
const SQL_TEAMS = 'SELECT side, name FROM teams WHERE match_id = :match_id';
const SQL_ROSTER =
  'SELECT ps.steam_id, p.name, p.side, ps.score FROM player_stats ps ' +
  'JOIN players p ON p.match_id = ps.match_id AND p.steam_id = ps.steam_id ' +
  'WHERE ps.match_id = :match_id AND p.is_bot = 0 ' +
  'ORDER BY (SELECT COUNT(*) FROM events e WHERE e.match_id = ps.match_id AND e.kind = \'kill\' ' +
  'AND e.attacker = ps.steam_id AND e.attacker <> e.victim AND NOT EXISTS (SELECT 1 FROM round_player_sides a ' +
  'JOIN round_player_sides v ON v.match_id = a.match_id AND v.round = a.round AND v.steam_id = e.victim ' +
  'WHERE a.match_id = e.match_id AND a.round = e.round AND a.steam_id = e.attacker AND a.side = v.side)) DESC, p.name ASC';

export async function loadEconomy(spectra, matchId) {
  if (matchId == null) return null;
  const [m, roundRows, ecoRows, sideRows, teamRows, roster] = await Promise.all([
    spectra.query(SQL_MATCH),
    spectra.query(SQL_ROUNDS),
    spectra.query(SQL_ECON),
    spectra.query(SQL_SIDES),
    spectra.query(SQL_TEAMS),
    spectra.query(SQL_ROSTER),
  ]);
  const head = m.rows[0] || [0, 0, 0];
  const scoreCT = Number(head[0]) || 0;
  const scoreT = Number(head[1]) || 0;
  const sideSwitches = Number(head[2]) || 0;
  const rounds = roundRows.rows.map((r) => ({ number: Number(r[0]), winner: r[1] || '', startTick: Number(r[2]), endTick: Number(r[3]) }));
  const rows = buildEconRows(ecoRows.rows, sideRows.rows);
  const clan = new Map(teamRows.rows.map((t) => [t[0], t[1]]));
  const players = roster.rows.map((r) => ({ steamId: r[0], name: r[1], side: r[2] }));
  const names = teamNames({ ctName: clan.get('ct') || '', tName: clan.get('t') || '', players });
  const matchWinner = scoreCT === scoreT ? '' : scoreCT > scoreT ? 'ct' : 't';
  return { rows, rounds, names, sideSwitches, matchWinner };
}
