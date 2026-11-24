import './compile-worker-node.mjs';
// jsdom driver for the Profile panels as builtin components. Each panel mounts in a real
// ComponentFrame with a FIXED context ({ matchId: null, steamId, round: null })
// and the real read services over the scripted Wails stub. The checks read the
// rendered values:
//   A. career cards: the default profile set, one metric() read each, values
//      formatted in the component, a NULL-free dash, and a behind chip;
//   B. trend: the sparkline caption carries the trend's min and max;
//   C. sides, maps and weapons: each cell is the player's stored dim row, a
//      zero shows as 0 and a NULL shows as the dash (ruling 23);
//   D. history: K/D/A, ADR and KAST are match-bound reads of the player's rows;
//   E. the context picks the player: the same panels for another player show
//      that player's rows, or the honest empty text, never the other's rows.
//
// Run (from frontend/):  node test/profile-panels.dom.mjs
// Then grep the log for FAIL and UNCAUGHT: the exit code is not the verdict.
import { boot } from './profile-harness.mjs';

const A = '76561198000000001';
const B = '76561198000000002';

const h = await boot('profile-panels');
const { bindings, services, panels, mountComponent, dom } = h;
const { invalidate } = services;

// --- the scripted backend -----------------------------------------------------
const DEFS = [
  { id: 82, name: 'career_matches', title: 'Matches played', scope: 'profile', format: 'int', doc: 'career doc' },
  { id: 83, name: 'win_pct', title: 'Win %', scope: 'profile', format: 'percent', doc: '' },
  { id: 84, name: 'career_adr', title: 'ADR', scope: 'profile', format: 'float1', doc: '' },
  { id: 85, name: 'career_kd', title: 'K/D', scope: 'profile', format: 'float2', doc: '' },
  { id: 1, name: 'adr', title: 'ADR', scope: 'match', format: 'float1', doc: '' },
  { id: 2, name: 'kast', title: 'KAST%', scope: 'match', format: 'percent', doc: '' },
  { id: 3, name: 'kills', title: 'Kills', scope: 'match', format: 'int', doc: '' },
  { id: 4, name: 'deaths', title: 'Deaths', scope: 'match', format: 'int', doc: '' },
  { id: 5, name: 'assists', title: 'Assists', scope: 'match', format: 'int', doc: '' },
  { id: 10, name: 'side_rounds', title: 'Rounds', scope: 'profile', format: 'int', partition: 'side' },
  { id: 11, name: 'side_win_pct', title: 'Round win %', scope: 'profile', format: 'percent', partition: 'side' },
  { id: 12, name: 'side_adr', title: 'ADR', scope: 'profile', format: 'float1', partition: 'side' },
  { id: 13, name: 'side_kast', title: 'KAST%', scope: 'profile', format: 'percent', partition: 'side' },
  { id: 14, name: 'side_kd', title: 'K/D', scope: 'profile', format: 'float2', partition: 'side' },
  { id: 20, name: 'map_matches', title: 'Matches', scope: 'profile', format: 'int', partition: 'map' },
  { id: 21, name: 'map_wins', title: 'Wins', scope: 'profile', format: 'int', partition: 'map' },
  { id: 22, name: 'map_adr', title: 'ADR', scope: 'profile', format: 'float1', partition: 'map' },
  { id: 30, name: 'weapon_kills', title: 'Weapon kills', scope: 'profile', format: 'int', partition: 'weapon' },
  { id: 31, name: 'weapon_damage', title: 'Weapon damage', scope: 'profile', format: 'int', partition: 'weapon' },
  { id: 32, name: 'weapon_headshots', title: 'Weapon headshots', scope: 'profile', format: 'int', partition: 'weapon' },
];

// Career rows (match_id 0) for both players; the panels see only the bound
// player's rows, because metric() filters by subject. Player B's rows would
// show up in A's cards if the context were ignored.
const CAREER = [
  { metricId: 82, subjectKey: A, dim: '', value: 2, valueKey: '', n: 2 },
  { metricId: 82, subjectKey: B, dim: '', value: 9, valueKey: '', n: 9 },
  { metricId: 83, subjectKey: A, dim: '', value: 0.5, valueKey: '', n: 2 },
  { metricId: 84, subjectKey: A, dim: '', value: 37.2, valueKey: '', n: 2 },
  { metricId: 84, subjectKey: B, dim: '', value: 80, valueKey: '', n: 9 },
  // Sides: CT has a fresh row for every seed; T has a NULL K/D (ruling 23).
  { metricId: 10, subjectKey: A, dim: 'ct', value: 10, valueKey: '', n: 10 },
  { metricId: 10, subjectKey: A, dim: 't', value: 12, valueKey: '', n: 12 },
  { metricId: 11, subjectKey: A, dim: 'ct', value: 0.25, valueKey: '', n: 10 },
  { metricId: 11, subjectKey: A, dim: 't', value: 0.5, valueKey: '', n: 12 },
  { metricId: 12, subjectKey: A, dim: 'ct', value: 41, valueKey: '', n: 10 },
  { metricId: 12, subjectKey: A, dim: 't', value: 39, valueKey: '', n: 12 },
  { metricId: 13, subjectKey: A, dim: 'ct', value: 0.6, valueKey: '', n: 10 },
  { metricId: 13, subjectKey: A, dim: 't', value: 0.55, valueKey: '', n: 12 },
  { metricId: 14, subjectKey: A, dim: 'ct', value: 1.25, valueKey: '', n: 10 },
  { metricId: 14, subjectKey: A, dim: 't', value: null, valueKey: '', n: 12 },
  { metricId: 10, subjectKey: B, dim: 'ct', value: 99, valueKey: '', n: 99 },
  // Maps: de_mirage has a row, de_cache has a ZERO ADR (a real zero, not a NULL).
  { metricId: 20, subjectKey: A, dim: 'de_mirage', value: 2, valueKey: '', n: 2 },
  { metricId: 20, subjectKey: A, dim: 'de_cache', value: 1, valueKey: '', n: 1 },
  { metricId: 21, subjectKey: A, dim: 'de_mirage', value: 1, valueKey: '', n: 2 },
  { metricId: 21, subjectKey: A, dim: 'de_cache', value: 0, valueKey: '', n: 1 },
  { metricId: 22, subjectKey: A, dim: 'de_mirage', value: 38.5, valueKey: '', n: 2 },
  { metricId: 22, subjectKey: A, dim: 'de_cache', value: 0, valueKey: '', n: 1 },
  // Weapons: the AWP's damage is NULL (a dash), its kills are 5.
  { metricId: 30, subjectKey: A, dim: 'ak47', value: 30, valueKey: '', n: 30 },
  { metricId: 31, subjectKey: A, dim: 'ak47', value: 4200, valueKey: '', n: 30 },
  { metricId: 32, subjectKey: A, dim: 'ak47', value: 12, valueKey: '', n: 30 },
  { metricId: 30, subjectKey: A, dim: 'awp', value: 5, valueKey: '', n: 5 },
  { metricId: 31, subjectKey: A, dim: 'awp', value: null, valueKey: '', n: 5 },
  { metricId: 32, subjectKey: A, dim: 'awp', value: 2, valueKey: '', n: 5 },
];

// Match rows for the history: player A's stored per-match values.
const MATCH_ROWS = {
  1: [
    { metricId: 3, subjectKey: A, dim: '', value: 17, valueKey: '', n: 1 },
    { metricId: 4, subjectKey: A, dim: '', value: 4, valueKey: '', n: 1 },
    { metricId: 5, subjectKey: A, dim: '', value: 2, valueKey: '', n: 1 },
    { metricId: 1, subjectKey: A, dim: '', value: 40.5, valueKey: '', n: 1 },
    { metricId: 2, subjectKey: A, dim: '', value: 0.7, valueKey: '', n: 1 },
  ],
  2: [
    { metricId: 3, subjectKey: A, dim: '', value: 3, valueKey: '', n: 1 },
    { metricId: 4, subjectKey: A, dim: '', value: 9, valueKey: '', n: 1 },
    { metricId: 1, subjectKey: A, dim: '', value: 35, valueKey: '', n: 1 },
    { metricId: 2, subjectKey: A, dim: '', value: 0.6, valueKey: '', n: 1 },
  ],
};

// Compute states: everything fresh, except K/D, which is BEHIND with no rows
// (a behind metric with stored rows reads as fresh; no rows is the chip).
const STATES = DEFS.map((d) => ({ metricId: d.id, state: d.id === 85 ? 'behind' : 'fresh', error: '' }));

function script() {
  bindings.MetricsService.ListMetrics = () => Promise.resolve(DEFS);
  bindings.MetricsService.GetMetricValuesForPlayer = (steam, ids) =>
    Promise.resolve(CAREER.filter((r) => ids.includes(r.metricId)));
  bindings.MetricsService.GetMetricValuesForMatch = (matchId, ids) =>
    Promise.resolve((MATCH_ROWS[matchId] || []).filter((r) => ids.includes(r.metricId)).map((r) => ({ ...r, matchId })));
  bindings.MetricsService.GetMetricComputeState = () => Promise.resolve(STATES);
  // The scoped read answers from the same states (every player reads them).
  bindings.MetricsService.GetMetricStates = (scope, id) => bindings.MetricsService.GetMetricComputeState(scope, id);
  // History reads every match's stored values in ONE series read (S13); it is
  // scripted from the same match rows, so both reads agree.
  bindings.MetricsService.GetMetricSeries = (steam, ids) =>
    Promise.resolve(
      Object.entries(MATCH_ROWS).flatMap(([mid, rows]) =>
        rows.filter((r) => ids.includes(r.metricId)).map((r) => ({ metricId: r.metricId, matchId: Number(mid), value: r.value, n: r.n })),
      ),
    );
  bindings.ProfileService.GetProfile = (sid) =>
    Promise.resolve({
      steamId: sid,
      name: sid === A ? 'amy' : 'zoe',
      wins: sid === A ? 1 : 4,
      history: [
        { matchId: 1, extractedAt: '2026-03-03T10:00:00Z', map: 'de_mirage', win: true, scoreCT: 13, scoreT: 8, startSide: 'ct', adr: 40, kastPct: 70 },
        { matchId: 2, extractedAt: '2026-03-01T10:00:00Z', map: 'de_cache', win: false, scoreCT: 10, scoreT: 13, startSide: 't', adr: 35, kastPct: 60 },
      ],
    });
  bindings.ProfileService.GetCareerTrend = () =>
    Promise.resolve([
      { matchId: 1, seq: 0, value: 35, patch: 14089, extractedAt: '2025-07-28T09:00:00Z' },
      { matchId: 2, seq: 1, value: 40, patch: 14113, extractedAt: '2026-03-01T10:00:00Z' },
    ]);
  invalidate();
}

// --- checks -------------------------------------------------------------------
let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}
const ctx = (steamId) => ({ matchId: null, steamId, round: null });
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const rowsOf = (root) => [...root.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map(text));

script();

console.log('A. career cards: the default set, formatted in the panel, a behind chip');
{
  const m = await mountComponent(panels['profile-career'], ctx(A));
  const cells = [...m.target.querySelectorAll('.stat-cell')];
  const values = cells.map((c) => text(c.children[1]));
  check('four default cards for the bound player (the defaults the catalog carries)', cells.length === 4, JSON.stringify(cells.map(text)));
  check('Matches played renders the stored count', values[0] === '2', values[0]);
  check('Matches card carries the wins sub-line from the profile fact', text(cells[0]).includes('1 wins'), text(cells[0]));
  check('Win % renders the stored fraction as a percent', values[1] === '50%', values[1]);
  check('ADR renders one decimal', values[2] === '37.2', values[2]);
  const chip = cells[3].querySelector('.chip.status');
  check('K/D behind with no rows is the state chip, never a number', !!chip && text(chip) === 'behind' && !/\d/.test(text(cells[3].children[1])), text(cells[3]));
  check('the behind chip carries the design copy as its title', cells[3].getAttribute('title') === 'value not available yet — recompute pending', cells[3].getAttribute('title') || '');
  m.cleanup();
}
{
  const m = await mountComponent(panels['profile-career'], ctx(B));
  const values = [...m.target.querySelectorAll('.stat-cell')].map((c) => text(c.children[1]));
  check('the same panel for another player shows that player (Matches 9, ADR 80.0)', values[0] === '9' && values[2] === '80.0', JSON.stringify(values));
  check('a metric with no row for this player is the dash, never another player’s value', values[1] === '—', values[1]);
  m.cleanup();
}

console.log('B. trend: the sparkline caption carries the min and max');
{
  const m = await mountComponent(panels['profile-trend'], ctx(A));
  const caption = text(m.target.querySelector('.prof-spark-cap'));
  check('two dots, one per trend point', m.target.querySelectorAll('svg.prof-spark circle').length === 2);
  check('the caption names the min and the max of the metric', caption.includes('35.0') && caption.includes('40.0'), caption);
  m.cleanup();
}

console.log('C. sides, maps and weapons: stored dim rows, zero shows as 0, NULL as the dash');
{
  const m = await mountComponent(panels['profile-sides'], ctx(A));
  const rows = rowsOf(m.target);
  check('CT row: rounds, win %, ADR, KAST, K/D from the stored side rows', JSON.stringify(rows[0]) === JSON.stringify(['CT', '10', '25%', '41.0', '60%', '1.25']), JSON.stringify(rows[0]));
  check('T row: a NULL K/D is the dash, never 0', rows[1] && rows[1][5] === '—', JSON.stringify(rows[1]));
  m.cleanup();
}
{
  const m = await mountComponent(panels['profile-maps'], ctx(A));
  const rows = rowsOf(m.target);
  check('maps sort by matches (de_mirage first) and show their stored cells', JSON.stringify(rows) === JSON.stringify([['de_mirage', '2', '1', '38.5'], ['de_cache', '1', '0', '0.0']]), JSON.stringify(rows));
  m.cleanup();
}
{
  const m = await mountComponent(panels['profile-weapons'], ctx(A));
  const rows = rowsOf(m.target);
  check('weapons sort by kills; a NULL damage is the dash, the thousands group', JSON.stringify(rows) === JSON.stringify([['ak47', '30', '4,200', '12'], ['awp', '5', '—', '2']]), JSON.stringify(rows));
  m.cleanup();
}

console.log('D. match history: K/D/A, ADR and KAST are match-bound reads');
{
  const m = await mountComponent(panels['profile-history'], ctx(A));
  const rows = [...m.target.querySelectorAll('tbody tr')];
  const cells = rows.map((tr) => [...tr.children].map(text));
  check('row one: K/D/A from the match reads, the missing assists is a dash', cells[0] && cells[0][5] === '17/4/2', JSON.stringify(cells[0]));
  check('row one: ADR and KAST are the stored match values', cells[0] && cells[0][6] === '40.5' && cells[0][7] === '70%', JSON.stringify(cells[0]));
  check('row two: no assists row is a dash, the rest are stored', cells[1] && cells[1][5] === '3/9/—' && cells[1][6] === '35.0', JSON.stringify(cells[1]));
  check('the W/L and the start side come from the match record', cells[0] && cells[0][2] === 'W' && cells[1][2] === 'L' && cells[0][4] === 'CT', JSON.stringify(cells.map((c) => c[2])));
  m.cleanup();
}

console.log('E. the context picks the player: another player gets their own rows or the honest empty text');
{
  // B's only side row is CT (99 rounds); A's rows (10 rounds) never show.
  const m = await mountComponent(panels['profile-sides'], ctx(B));
  const rows = rowsOf(m.target);
  check('the same panel for player B shows B’s CT row only', JSON.stringify(rows) === JSON.stringify([['CT', '99', '—', '—', '—', '—']]), JSON.stringify(rows));
  m.cleanup();
}
{
  // C has no rows at all: the honest empty text.
  const m = await mountComponent(panels['profile-sides'], ctx('76561198000000003'));
  check('a player with no side rows gets the honest empty text', text(m.target).includes('No CT/T breakdown yet.'), text(m.target).slice(0, 120));
  m.cleanup();
}

if (h.escaped.length) {
  failures++;
  console.log('  FAIL escaped errors: ' + h.escaped.map((e) => e && e.message).join(' | '));
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
dom.window.close();
process.exit(failures || h.escaped.length ? 1 : 0);
