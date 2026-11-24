// The helpers the Match view's panels carry. The panels are Svelte builtins
// that import these names; componentruntime/compile.js's BUILTIN_HELPERS
// registry lists which names a panel may take. Formatting follows lib/fmt.js,
// lib/teams.js and lib/rounds.js (the rules the panels always showed); a
// missing or NULL stored value is a dash, never a zero (ruling 23).
import * as S from '../../strings/index.js';
import { sideAtRound, resolveSide, DASH } from '../../builtinhelpers.js';


// The read-only SQL the panels run (bound from the context). Plain literals,
// so the audit exempts them by text: SQL the panel runs is not user copy.
export const SQL_ROSTER =
  'SELECT ps.steam_id, p.name, p.side, ps.score FROM player_stats ps ' +
  'JOIN players p ON p.match_id = ps.match_id AND p.steam_id = ps.steam_id ' +
  'WHERE ps.match_id = :match_id AND p.is_bot = 0 ' +
  'ORDER BY (SELECT COUNT(*) FROM events e WHERE e.match_id = ps.match_id AND e.kind = \'kill\' ' +
  'AND e.attacker = ps.steam_id AND e.attacker <> e.victim AND NOT EXISTS (SELECT 1 FROM round_player_sides a ' +
  'JOIN round_player_sides v ON v.match_id = a.match_id AND v.round = a.round AND v.steam_id = e.victim ' +
  'WHERE a.match_id = e.match_id AND a.round = e.round AND a.steam_id = e.attacker AND a.side = v.side)) DESC, p.name ASC';
export const SQL_TEAMS = 'SELECT side, name FROM teams WHERE match_id = :match_id';
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
  "AND e.kind IN ('bomb_plant', 'bomb_defuse', 'bomb_explode') ORDER BY e.seq";
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
const SIDE_FLIP = { ct: 't', t: 'ct' };

// The team colour class: the team's START side (the side it began the
// match on), after the match's side switches (lib/teams.js teamStartClass).
export function startClass(side, switches) {
  if (side !== 'ct' && side !== 't') return '';
  const start = switches % 2 ? SIDE_FLIP[side] : side;
  return start === 'ct' ? 'team-start-ct' : 'team-start-t';
}

// One stored value as its text (lib/fmt.js fmtMetric's rules).
export function fmtValue(v, format) {
  if (v == null || !Number.isFinite(v)) return DASH;
  if (format === 'percent') return Math.round(v * 1000) / 10 + '%';
  if (format === 'float1') return (Math.round(v * 10) / 10).toFixed(1);
  if (format === 'float2') return (Math.round(v * 100) / 100).toFixed(2);
  if (format === 'int') return Math.round(v).toLocaleString();
  return Number.isInteger(v) ? Math.round(v).toLocaleString() : (Math.round(v * 100) / 100).toFixed(2);
}

export const STATE_WORD = { processing: S.builtins.stateCalculating, failed: S.builtins.stateFailed, behind: S.builtins.stateOutOfDate };

// A metric read for this match: its state and each player's value.
export async function readUnit(spectra, name) {
  const m = await spectra.metric(name);
  const map = new Map();
  for (const r of m.rows) map.set(r.subject, r.value);
  return { state: m.state, error: m.error || '', doc: m.doc || '', map };
}

// What a stored cell shows: the value, a dash for no value, or the state.
export function cellText(u, key, format) {
  if (u.state === 'no-data') return DASH;
  if (u.state !== 'fresh') return STATE_WORD[u.state] || u.state;
  return u.map.has(key) ? fmtValue(u.map.get(key), format) : DASH;
}

export function cellValue(u, key) {
  return u.state === 'fresh' && u.map.has(key) ? u.map.get(key) : null;
}

// The team display name of a side: the demo's clan name, else the
// synthesized team_<player> name (lowest SteamID on the side), else CT / T.
export function teamName(side, teamRows, roster) {
  const hit = teamRows.find((r) => r[0] === side);
  if (hit && hit[1]) return hit[1];
  let best = null;
  for (const r of roster) {
    if (r[2] !== side || !r[1]) continue;
    if (!best || r[0] < best[0] || (r[0] === best[0] && r[1] < best[1])) best = r;
  }
  return best ? 'team_' + best[1] : side.toUpperCase();
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
        : a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
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

// {placeholder} fill for catalog copy the panel carries (lib/strings).
export function fill(template, args) {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) => (key in args ? String(args[key]) : whole));
}

export function roundLabel(n) {
  if (n >= 1) return String(n);
  return n === -2 ? S.builtins.roundLabelKnife : S.builtins.roundLabelWarmup;
}

export function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return DASH;
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return h + 'h' + String(m).padStart(2, '0') + 'm' + String(sec).padStart(2, '0') + 's';
  if (m > 0) return m + 'm' + String(sec).padStart(2, '0') + 's';
  return sec + 's';
}

// A player's colour in one round: the side they had in that round, else the
// match's start-side colour for the player (never a guess).
export function playerRoundCls(d, number, steam, name) {
  const final = resolveSide(d.roster.map((r) => ({ steamId: r[0], name: r[1], side: r[2] })), steam, name);
  const at = sideAtRound(d.rounds, d.switches, number, final) || '';
  if (at === 'ct') return 'side-ct';
  if (at === 't') return 'side-t';
  return startClass(final, d.switches);
}

export function roundOf(r) {
  return {
    number: Number(r[0]),
    winner: r[1] || '',
    reason: r[2] || '',
    durationS: r[3] == null ? NaN : Number(r[3]),
    bombSite: r[4] || '',
    mvp: r[5] || '',
    mvpName: r[6] || '',
    firstKillSteam: r[7] || '',
    firstKillName: r[8] || '',
    firstDeathSteam: r[9] || '',
    firstDeathName: r[10] || '',
    kills: Number(r[11]) || 0,
    startTick: r[12] == null ? NaN : Number(r[12]),
    endTick: r[13] == null ? NaN : Number(r[13]),
  };
}

// DETAIL_HELPERS
export function numOf(v) {
  return v == null || v === '' ? NaN : Number(v);
}

export function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return DASH;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return (mb / 1024).toFixed(1) + S.builtins.unitGb;
  if (mb >= 1) return mb.toFixed(1) + S.builtins.unitMb;
  return (bytes / 1024).toFixed(1) + S.builtins.unitKb;
}

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

export function fmtDate(d) {
  if (!d || d.getUTCFullYear() <= 1) return DASH;
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
