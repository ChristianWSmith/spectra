// snapshot-fixture.mjs — the read services the built-in snapshot driver mounts every
// registry component over. One match (id 7): seven players and one bot, with the
// stored values a hand computation can check. Any query the fixture does not
// recognise answers empty rows, so a panel whose data is out of scope renders
// its empty state, deterministically.
//
// The fixture is injected through ComponentFrame's `reads` prop, so the panels run
// the real read API (readapi.js) and never reach the Wails bindings.

export const MATCH_ID = 7;
export const ALPHA = '76561190000000001';
export const BRAVO = '76561190000000002';
export const CHARLIE = '76561190000000003';
export const DELTA = '76561190000000004';
export const ECHO = '76561190000000005';
const BOT = '76561190000000009';

const PLAYERS = [
  { steam: ALPHA, name: 'Alpha', side: 'ct', score: 31, is_bot: 0 },
  { steam: BRAVO, name: 'Bravo', side: 'ct', score: 12, is_bot: 0 },
  { steam: CHARLIE, name: 'Charlie', side: 't', score: 25, is_bot: 0 },
  { steam: DELTA, name: 'Delta', side: 't', score: 7, is_bot: 0 },
  { steam: ECHO, name: 'Echo', side: '', score: 0, is_bot: 0 },
  { steam: BOT, name: 'Bot', side: 't', score: 9, is_bot: 1 },
];

const STATS = {
  [ALPHA]: { kills: 20, deaths: 10, assists: 3, adr: 90.5, total_damage: 1800, utility_damage: 150, mvps: 2, entry_kills: 4, entry_deaths: 1, kast: 0.75, hs_pct: 0.5, kd: 2, kda: 2.3, two_k: 2, three_k: 1, four_k: 0, five_k: 0, trade_kills: 2, best_streak: 3 },
  [BRAVO]: { kills: 12, deaths: 14, assists: 1, adr: 64.2, total_damage: 1100, utility_damage: 1200, mvps: 0, entry_kills: 0, entry_deaths: 2, kast: 0.6, hs_pct: 0.25, kd: 0.86, kda: 0.93, two_k: 1, three_k: 0, four_k: 0, five_k: 0, trade_kills: 0, best_streak: 1 },
  [CHARLIE]: { kills: 20, deaths: 15, assists: 4, adr: 80, total_damage: 1500, utility_damage: 300, mvps: 1, entry_kills: 1, entry_deaths: 3, kast: 0.7, hs_pct: 0.4, kd: 1.33, kda: 1.6, two_k: 3, three_k: 0, four_k: 0, five_k: 0, trade_kills: 1, best_streak: 2 },
  [DELTA]: { kills: 5, deaths: 16, assists: 0, adr: 30, total_damage: 500, utility_damage: 40, mvps: 0, entry_kills: 0, entry_deaths: 1, kast: 0.4, hs_pct: 0, kd: 0.31, kda: 0.31, two_k: 0, three_k: 0, four_k: 0, five_k: 0, trade_kills: 0, best_streak: 0 },
  [ECHO]: { kills: 3, deaths: 4, assists: 0, adr: 10, total_damage: 200, utility_damage: 0, mvps: 0, entry_kills: 0, entry_deaths: 0, kast: 0.2, hs_pct: 0, kd: 0.75, kda: 0.75, two_k: 0, three_k: 0, four_k: 0, five_k: 0, best_streak: 0 },
};

const DEF_NAMES = [
  'kills', 'deaths', 'assists', 'adr', 'total_damage', 'utility_damage', 'mvps', 'entry_kills', 'entry_deaths',
  'kast', 'hs_pct', 'kd', 'kda', 'two_k', 'three_k', 'four_k', 'five_k', 'trade_kills', 'best_streak',
  'top_fragger', 'best_adr', 'most_util', 'entry_opens', 'most_mvps',
];
const DEFS = DEF_NAMES.map((name, i) => ({ id: i + 1, name, doc: `Formula of ${name}` }));
const idOf = (name) => DEFS.find((d) => d.name === name).id;

const IDENTITY = {
  top_fragger: { key: ALPHA, value: 20 },
  best_adr: { key: ALPHA, value: 90.5 },
  most_util: { key: BRAVO, value: 1200 },
  entry_opens: { key: ALPHA, value: 4 },
  most_mvps: { key: ALPHA, value: 2 },
};

const VALUES = [];
for (const [steam, stats] of Object.entries(STATS)) {
  for (const [name, value] of Object.entries(stats)) {
    VALUES.push({ matchId: MATCH_ID, metricId: idOf(name), subjectKey: steam, dim: '', value, valueKey: '' });
  }
}
for (const [name, { key, value }] of Object.entries(IDENTITY)) {
  VALUES.push({ matchId: MATCH_ID, metricId: idOf(name), subjectKey: '', dim: '', value, valueKey: key });
}

const TEAMS = [['ct', 'Alpha Squad'], ['t', '']];

function answer(sql) {
  const matchId = Number((/match_id = (\d+)/.exec(sql) || [])[1]);
  if (/FROM player_stats/.test(sql)) {
    const rows = PLAYERS.filter((p) => p.is_bot === 0 && matchId === MATCH_ID).map((p) => [p.steam, p.name, p.side, p.score]);
    rows.sort((a, b) => STATS[b[0]].kills - STATS[a[0]].kills || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    return { columns: ['steam_id', 'name', 'side', 'score'], rows };
  }
  if (/FROM teams/.test(sql)) return { columns: ['side', 'name'], rows: matchId === MATCH_ID ? TEAMS.map((r) => [...r]) : [] };
  if (/side_switches FROM matches/.test(sql)) {
    return { columns: ['side_switches'], rows: matchId === MATCH_ID ? [[0]] : [] };
  }
  return { columns: [], rows: [] };
}

export function snapshotReads() {
  return {
    listMetrics: async () => DEFS,
    getMetricValuesForMatch: async (matchId, ids) => VALUES.filter((v) => v.matchId === matchId && ids.includes(v.metricId)),
    getMetricValuesForPlayer: async () => [],
    getMetricValuesForRound: async () => [],
    getMetricSeries: async () => [],
    getMetricComputeState: async () => [],
    getMetricStates: async () => [],
    componentQuery: async (sql) => answer(sql),
  };
}
