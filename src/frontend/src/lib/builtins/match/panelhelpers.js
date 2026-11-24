// The helpers the Match view's panels carry. The panels are Svelte builtins
// that import these names; componentruntime/compile.js's BUILTIN_HELPERS
// registry lists which names a panel may take. Formatting follows lib/fmt.js,
// lib/teams.js and lib/rounds.js (the rules the panels always showed); a
// missing or NULL stored value is a dash, never a zero (ruling 23).
import * as S from '../../strings/index.js';
import { DASH, SQL_ROSTER, SQL_TEAMS, asTick, rowOf } from '../../builtinhelpers.js';
import { teamStartClass } from '../../teams.js';
import { fmtMetric, fmtBytes, fmtDate, fmtDuration } from '../../fmt.js';
import { readMetrics } from '../../metricreads.js';
import { metricPresentation } from '../../metricstate.js';
import { compareAsc } from '../../sortstate.js';
import { errText } from '../../services.js';
export { fmtBytes, fmtDate, fmtDuration };


// The read-only SQL the panels run is defined once, in builtinhelpers.js.
export { SQL_ROSTER, SQL_TEAMS } from '../../builtinhelpers.js';
// One round's detail: the round-scoped reads of the Rounds tab's expansion (the
// :round bind is set with :match_id on every call — an explicit bind set replaces
// the context's, so both are passed).
export const SQL_MATCH_TICK_RATE = 'SELECT tick_rate FROM matches WHERE id = :match_id';
export const SQL_ROUND_MVP_REASON = 'SELECT mvp_reason FROM rounds WHERE match_id = :match_id AND number = :round';
export const SQL_ROUND_KILLS =
  'SELECT e.id, e.tick, e.attacker, COALESCE(ap.name, \'\'), e.victim, COALESCE(vp.name, \'\'), e.weapon, ' +
  'e.headshot, e.wallbang, e.noscope, e.through_smoke, e.attacker_blind, e.assisted_flash ' +
  'FROM events e ' +
  'LEFT JOIN players ap ON ap.match_id = e.match_id AND ap.steam_id = e.attacker ' +
  'LEFT JOIN players vp ON vp.match_id = e.match_id AND vp.steam_id = e.victim ' +
  "WHERE e.match_id = :match_id AND e.round = :round AND e.kind = 'kill' ORDER BY e.seq";
export const SQL_ROUND_BOMBS =
  'SELECT e.id, e.tick, e.kind, e.attacker, COALESCE(ap.name, \'\'), e.site FROM events e ' +
  'LEFT JOIN players ap ON ap.match_id = e.match_id AND ap.steam_id = e.attacker ' +
  'WHERE e.match_id = :match_id AND e.round = :round ' +
  "AND e.kind IN ('bomb_plant', 'bomb_defuse', 'bomb_explode', 'bomb_drop', 'bomb_pickup') ORDER BY e.seq";
export const SQL_ROUND_ECONOMY =
  'SELECT side, equip_value, money_sampled_sum, money_samples FROM round_economy ' +
  'WHERE match_id = :match_id AND round = :round ORDER BY side';
export const SQL_ROUND_SIDE_CLASSES = 'SELECT side, class, why FROM round_side_classes WHERE match_id = :match_id AND round = :round';
export const SQL_ROUND_CHAT =
  'SELECT id, tick, round, steam_id, name, text, channel FROM chat ' +
  'WHERE match_id = :match_id AND round = :round ORDER BY tick, id';
export const SQL_SWITCHES = 'SELECT side_switches FROM matches WHERE id = :match_id';
export const SQL_ROUNDS =
  "SELECT r.number, r.winner, r.reason, (CAST(r.end_tick - r.start_tick AS REAL) / (SELECT m.tick_rate FROM matches m WHERE m.id = r.match_id)), r.bomb_site, r.mvp, COALESCE(mp.name, ''), " +
  "r.first_kill_steam, COALESCE(fp.name, ''), r.first_death_steam, COALESCE(dp.name, ''), " +
  "(SELECT COUNT(*) FROM events e WHERE e.match_id = r.match_id AND e.round = r.number AND e.kind = 'kill'), " +
  "r.start_tick, r.end_tick FROM rounds r " +
  "LEFT JOIN players mp ON mp.match_id = r.match_id AND r.mvp <> '' AND mp.steam_id = r.mvp " +
  "LEFT JOIN players fp ON fp.match_id = r.match_id AND r.first_kill_steam <> '' AND fp.steam_id = r.first_kill_steam " +
  "LEFT JOIN players dp ON dp.match_id = r.match_id AND r.first_death_steam <> '' AND dp.steam_id = r.first_death_steam " +
  "WHERE r.match_id = :match_id ORDER BY r.number ASC";
export const SQL_FACTS =
  'SELECT server_name, tick_rate, frames, size, extracted_at, parser_version, path, warnings_count ' +
  'FROM matches WHERE id = :match_id';


// HELPERS

// The team colour class: the team's START side (the side it began the
// match on), after the match's side switches (lib/teams.js teamStartClass).
// The team colour class of a side at the start of the match (teams.js).
export const startClass = teamStartClass;

// One stored value as its text (lib/fmt.js fmtMetric's rules).
export const STATE_WORD = { processing: S.builtins.stateCalculating, failed: S.builtins.stateFailed, behind: S.builtins.stateOutOfDate };

// A metric read for this match: its state and each player's value.
export async function readUnit(spectra, name) {
  const m = (await readMetrics(spectra, [name], errText)).get(name);
  const map = new Map();
  for (const r of m.rows) map.set(r.subject, r.value);
  return { state: m.state, error: m.error || '', doc: m.doc || '', map };
}

// matchPres is one subject's cell presentation (metricstate.js metricPresentation):
// the value, the dash, or the state. The read carries rows only when fresh.
export function matchPres(u, key) {
  return metricPresentation(u.state, u.map.has(key) ? { value: u.map.get(key) } : null, false);
}

// cellText is the same presentation as text, for the joined cells (kda, the
// overview's K/D/A line).
// kdaText is a player's K/D/A line: the three counts, each as its cell text.
export function kdaText(kills, deaths, assists, key) {
  return [cellText(kills, key, 'int'), cellText(deaths, key, 'int'), cellText(assists, key, 'int')].join('/');
}

export function cellText(u, key, format) {
  const p = matchPres(u, key);
  if (p.kind === 'value') return fmtMetric(p.value, format);
  if (p.kind === 'nodata') return DASH;
  return STATE_WORD[p.state] || p.state;
}

export function cellValue(u, key) {
  return u.state === 'fresh' && u.map.has(key) ? u.map.get(key) : null;
}

// The team display name of a side: the demo's clan name, else the
// synthesized team_<player> name (lowest SteamID on the side), else CT / T.

// readFrameBase is the base reads of a match panel, in order: the roster, the team
// rows and the side switches. A panel spreads it into its Promise.all.
export function readFrameBase(spectra) {
  return [spectra.query(SQL_ROSTER), spectra.query(SQL_TEAMS), spectra.query(SQL_SWITCHES)];
}

// The chained sort (the old Match view's rule): each stack entry is applied
// to the sequence the earlier entries produced, so the newest key is the
// primary and the earlier keys break its ties. Every step breaks ties on
// the incoming index, so a key whose values are all tied moves nothing. A
// missing value sorts last in both directions; strings compare by locale,
// numbers by value.
export function sortRows(rows, stack, valueOf) {
  let out = rows;
  for (const entry of stack) {
    const keyed = out.map((p, i) => ({ p, i, v: valueOf(entry.key, p) }));
    keyed.sort((a, b) => {
      if (a.v == null || b.v == null) {
        if (a.v == null && b.v == null) return a.i - b.i;
        return a.v == null ? 1 : -1;
      }
      let c = typeof a.v === 'string' || typeof b.v === 'string'
        ? String(a.v).localeCompare(String(b.v))
        : compareAsc(a.v, b.v);
      if (entry.desc) c = -c;
      return c !== 0 ? c : a.i - b.i;
    });
    out = keyed.map((x) => x.p);
  }
  return out;
}

// The humans of this match in the default order (kills DESC, name ASC):
// [steamId, name, side, score]. Bots are filtered here, as the scoreboard
// always did.

// {placeholder} fill for catalog copy: the strings catalog's fill.
export const fill = S.fill;

export function roundLabel(n) {
  if (n >= 1) return String(n);
  return n === -2 ? S.builtins.roundLabelKnife : S.builtins.roundLabelWarmup;
}

// A player's colour in one round: the side they had in that round, else the
// match's start-side colour for the player (never a guess).

// The round row of a rounds read, shaped for the panel.
const ROUND_SPEC = {
  number: [0, 'raw'],
  winner: [1, 'str'],
  reason: [2, 'str'],
  durationS: [3, 'num'],
  bombSite: [4, 'str'],
  mvp: [5, 'str'],
  mvpName: [6, 'str'],
  firstKillSteam: [7, 'str'],
  firstKillName: [8, 'str'],
  firstDeathSteam: [9, 'str'],
  firstDeathName: [10, 'str'],
  kills: [11, 'count'],
  startTick: [12, 'num'],
  endTick: [13, 'num'],
};
export function roundOf(r) {
  return rowOf(r, ROUND_SPEC);
}

// DETAIL_HELPERS
export const numOf = asTick;

export function parseStamp(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(?: ([+-]\d{2})(\d{2})(?: UTC)?)?$/.exec(t);
  if (!m) {
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const ms = m[3] ? '.' + m[3].slice(1, 4).padEnd(3, '0') : '';
  const off = m[4] ? m[4] + ':' + m[5] : 'Z';
  const d = new Date(m[1] + 'T' + m[2] + ms + off);
  return Number.isNaN(d.getTime()) ? null : d;
}

