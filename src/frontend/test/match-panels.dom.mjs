import { warm, compileIdle } from './compile-worker-node.mjs';
await warm();
// jsdom driver for the Match view's panels: each panel mounts through the real
// ComponentFrame, compiles from its source, and reads through the real read
// API. The read services are a fixture (one match, seven players, one bot),
// so every rendered value here is one this file can compute by hand:
//   A. the overview cards show the identity leaders and their numbers;
//   B. the rosters split the players by side, with K/D/A and ADR;
//   C. the scoreboard shows the default columns in the default order, a dash
//      where a stored value is missing, and 0 where the value is zero;
//   D. a header click sorts on that column, and clicks chain: a new header
//      sorts on top of the keys already sorted, which break its ties;
//   D2. every sortable header, in sequence, gives the chained order;
//   D3. every metric header carries its formula as its tooltip;
//   E. a row click opens the replay following that player, back to the tab
//      the panel sits on;
//   F. a panel mounted with another match's context reads only that match;
//   H. a metric that is calculating or failed shows its state word, never a
//      number, and a failure carries the engine's error as its title.
//
// Run (from frontend/):  node test/match-panels.dom.mjs
// Then grep the log for FAIL and UNCAUGHT: the exit code is not the verdict.
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { compile } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installEsmDirHook } from './esm-dir-hook.mjs';

installEsmDirHook();

const stub = (name) => pathToFileURL(join('test', 'stubs', name)).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'svelte' || specifier.startsWith('svelte/')) {
      return nextResolve(specifier, { ...context, conditions: ['browser', ...(context.conditions || [])] });
    }
    if (specifier === '@wailsio/runtime') return { url: stub('wails-runtime.mjs'), shortCircuit: true };
    if (specifier.includes('bindings/github.com')) return { url: stub('bindings.mjs'), shortCircuit: true };
    return nextResolve(specifier, context);
  },
  // Builtin panels reach .svelte files through plain .js modules (builtins/
  // panels.js imports the Profile panels), which the bundle above does not
  // rewrite: compile any .svelte module that node loads directly.
  load(url, context, nextLoad) {
    if (url.endsWith('.svelte')) {
      const filename = fileURLToPath(url);
      const source = compile(readFileSync(filename, 'utf8'), { filename, generate: 'client', css: 'injected', runes: true }).js.code;
      return { format: 'module', source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
});
for (const k of [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement',
  'HTMLTextAreaElement', 'HTMLButtonElement', 'SVGElement', 'Element', 'Node', 'Text', 'Comment',
  'DocumentFragment', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'MutationObserver', 'localStorage',
]) {
  if (!(k in dom.window)) continue;
  try {
    globalThis[k] = dom.window[k];
  } catch {
    Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
  }
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;

const escaped = [];
process.on('uncaughtException', (e) => {
  escaped.push('uncaught: ' + (e && e.message));
  console.log('UNCAUGHT ' + (e && e.message));
});
process.on('unhandledRejection', (e) => {
  escaped.push('rejection: ' + (e && e.message));
  console.log('UNCAUGHT rejection ' + (e && e.message));
});

// --- bundling (as component-context.dom.mjs) --------------------------------
const cacheDir = join('node_modules', '.cache', 'spectra-dom-tests', 'match-panels');
mkdirSync(cacheDir, { recursive: true });
const compiled = new Map();
let seq = 0;
// Svelte files compile; .js files are rewritten so that any .svelte or .js they
// import (builtins/panels.js imports the profile panels) is bundled too.
function bundle(absPath) {
  if (compiled.has(absPath)) return compiled.get(absPath);
  const out = join(cacheDir, `${String(++seq).padStart(2, '0')}-${absPath.split('/').pop()}.js`);
  compiled.set(absPath, out);
  const src = readFileSync(absPath, 'utf8').replace(/from '(\.{1,2}\/[^']+)'/g, (whole, rel) => {
    const target = resolve(dirname(absPath), rel);
    if (target.endsWith('.svelte') || (target.endsWith('.js') && !target.includes('/generated/'))) return `from '${pathToFileURL(bundle(target)).href}'`;
    return `from '${pathToFileURL(target).href}'`;
  });
  writeFileSync(out, absPath.endsWith('.svelte') ? compile(src, { filename: absPath, generate: 'client' }).js.code : src);
  return out;
}
const harnessBundle = bundle(resolve('test/match-panels.harness.svelte'));

const { mount, unmount, flushSync } = await import('svelte');
const S = await import(pathToFileURL(resolve('src/lib/strings/index.js')).href);
const panels = await import(pathToFileURL(resolve('src/lib/matchpanels.js')).href);
const Harness = (await import(pathToFileURL(harnessBundle).href)).default;

// --- the fixture: match 7 ------------------------------------------------------
// Steam ids: Alpha, Bravo (CT); Charlie, Delta (T); Echo (no side); Bot (a bot,
// never listed). Alpha and Charlie tie on kills, so the name order decides.
const ALPHA = '76561190000000001';
const BRAVO = '76561190000000002';
const CHARLIE = '76561190000000003';
const DELTA = '76561190000000004';
const ECHO = '76561190000000005';
const BOT = '76561190000000009';

const PLAYERS = [
  { steam: ALPHA, name: 'Alpha', side: 'ct', score: 31, is_bot: 0 },
  { steam: BRAVO, name: 'Bravo', side: 'ct', score: 12, is_bot: 0 },
  { steam: CHARLIE, name: 'Charlie', side: 't', score: 25, is_bot: 0 },
  { steam: DELTA, name: 'Delta', side: 't', score: 7, is_bot: 0 },
  { steam: ECHO, name: 'Echo', side: '', score: 0, is_bot: 0 },
  { steam: BOT, name: 'Bot', side: 't', score: 9, is_bot: 1 },
];

// Per-player stored values (metric name → value). Echo has no trade_kills row.
const STATS = {
  [ALPHA]: { kills: 20, deaths: 10, assists: 3, adr: 90.5, total_damage: 1800, utility_damage: 150, mvps: 2, entry_kills: 4, entry_deaths: 1, kast: 0.75, hs_pct: 0.5, kd: 2, kda: 2.3, two_k: 2, three_k: 1, four_k: 0, five_k: 0, trade_kills: 2, best_streak: 3 },
  [BRAVO]: { kills: 12, deaths: 14, assists: 1, adr: 64.2, total_damage: 1100, utility_damage: 1200, mvps: 0, entry_kills: 0, entry_deaths: 2, kast: 0.6, hs_pct: 0.25, kd: 0.86, kda: 0.93, two_k: 1, three_k: 0, four_k: 0, five_k: 0, trade_kills: 0, best_streak: 1 },
  [CHARLIE]: { kills: 20, deaths: 15, assists: 4, adr: 80, total_damage: 1500, utility_damage: 300, mvps: 1, entry_kills: 1, entry_deaths: 3, kast: 0.7, hs_pct: 0.4, kd: 1.33, kda: 1.6, two_k: 3, three_k: 0, four_k: 0, five_k: 0, trade_kills: 1, best_streak: 2 },
  [DELTA]: { kills: 5, deaths: 16, assists: 0, adr: 30, total_damage: 500, utility_damage: 40, mvps: 0, entry_kills: 0, entry_deaths: 1, kast: 0.4, hs_pct: 0, kd: 0.31, kda: 0.31, two_k: 0, three_k: 0, four_k: 0, five_k: 0, trade_kills: 0, best_streak: 0 },
  [ECHO]: { kills: 3, deaths: 4, assists: 0, adr: 10, total_damage: 200, utility_damage: 0, mvps: 0, entry_kills: 0, entry_deaths: 0, kast: 0.2, hs_pct: 0, kd: 0.75, kda: 0.75, two_k: 0, three_k: 0, four_k: 0, five_k: 0, best_streak: 0 },
};

// The metric catalog the read API resolves names through.
const DEF_NAMES = [
  'kills', 'deaths', 'assists', 'adr', 'total_damage', 'utility_damage', 'mvps', 'entry_kills', 'entry_deaths',
  'kast', 'hs_pct', 'kd', 'kda', 'two_k', 'three_k', 'four_k', 'five_k', 'trade_kills', 'best_streak',
  'top_fragger', 'best_adr', 'most_util', 'entry_opens', 'most_mvps',
];
// Each metric carries its formula as its doc (the header tooltip reads it).
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
    VALUES.push({ matchId: 7, metricId: idOf(name), subjectKey: steam, dim: '', value, valueKey: '' });
  }
}
for (const [name, { key, value }] of Object.entries(IDENTITY)) {
  VALUES.push({ matchId: 7, metricId: idOf(name), subjectKey: '', dim: '', value, valueKey: key });
}

const TEAMS = { 7: [['ct', 'Alpha Squad'], ['t', '']] };
const SWITCHES = { 7: 0 };

// The component queries the panels run, answered for the matches the
// fixture holds (a match with no rows answers no rows).
function answer(sql) {
  const matchId = Number((/match_id = (\d+)/.exec(sql) || [])[1]);
  if (/FROM player_stats/.test(sql)) {
    const rows = PLAYERS.filter((p) => p.is_bot === 0 && matchId === 7).map((p) => [
      p.steam,
      p.name,
      p.side,
      p.score,
    ]);
    const kills = (steam) => STATS[steam].kills;
    rows.sort((a, b) => kills(b[0]) - kills(a[0]) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    return { columns: ['steam_id', 'name', 'side', 'score'], rows };
  }
  if (/FROM teams/.test(sql)) return { columns: ['side', 'name'], rows: (TEAMS[matchId] || []).map((r) => [...r]) };
  if (/side_switches FROM matches/.test(sql)) {
    return { columns: ['side_switches'], rows: matchId in SWITCHES ? [[SWITCHES[matchId]]] : [] };
  }
  return { err: 'the fixture does not answer: ' + sql };
}

const reads = {
  listMetrics: async () => DEFS,
  getMetricValuesForMatch: async (matchId, ids) => VALUES.filter((v) => v.matchId === matchId && ids.includes(v.metricId)),
  getMetricValuesForPlayer: async () => [],
  getMetricComputeState: async () => [],
  getMetricStates: async () => [],
  componentQuery: async (sql) => answer(sql),
};

// --- helpers -------------------------------------------------------------------
const sleep = async (ms = 30) => {
  await new Promise((r) => setTimeout(r, ms));
  await compileIdle();
};
const settle = async (rounds = 10) => {
  for (let i = 0; i < rounds; i++) {
    await sleep(25);
    flushSync();
  }
};
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}

let target = null;
let instance = null;
const navCalls = [];
const unmountAll = () => {
  if (instance) unmount(instance);
  instance = null;
  if (target) target.remove();
  target = null;
};
const mountPanel = async ({ source, context, props = {}, reads: readsOverride = reads }) => {
  unmountAll();
  navCalls.length = 0;
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(Harness, {
    target,
    props: { source, context, props, reads: readsOverride, nav: (h) => navCalls.push(h), builtinDir: 'src/lib' },
  });
  await settle();
  return target;
};

const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
// The rows of a table: each row's cell texts.
const tableRows = (root) =>
  [...root.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => text(td)));
const headers = (root) => [...root.querySelectorAll('thead th')].map((th) => text(th));

const MATCH = { matchId: 7, steamId: null, round: null };
const BACK = { back: 'match/7/scoreboard' };

// --- A. the overview cards -------------------------------------------------------
console.log('A. overview cards (match 7)');
let root = await mountPanel({ source: panels.OVERVIEW_SOURCE, context: MATCH, props: BACK });
const cards = [...root.querySelectorAll('.stat-cell')];
const cardIn = (r, label) => [...r.querySelectorAll('.stat-cell')].find((c) => text(c.querySelector('.field-label')) === label);
const card = (label) => cardIn(root, label);
check('five identity cards, in the default order',
  cards.map((c) => text(c.querySelector('.field-label'))).join('|') === 'Top fragger|Best ADR|Most util|Entry opens|Most MVPs',
  cards.map((c) => text(c.querySelector('.field-label'))).join('|'));
check('top fragger: the leader, and K/D/A from the stored rows',
  text(card('Top fragger')?.querySelector('.stat-value')) === '20/10/3' && text(card('Top fragger')?.querySelector('.stat-sub')) === 'Alpha',
  text(card('Top fragger')));
check('best ADR: one decimal', text(card('Best ADR')?.querySelector('.stat-value')) === '90.5');
check('most util: thousands separated', text(card('Most util')?.querySelector('.stat-value')) === '1,200' && text(card('Most util')?.querySelector('.stat-sub')) === 'Bravo');
check('entry opens and most MVPs name their leader', text(card('Entry opens')?.querySelector('.stat-sub')) === 'Alpha' && text(card('Most MVPs')?.querySelector('.stat-value')) === '2');

// --- B. rosters -----------------------------------------------------------------
console.log('B. rosters (match 7)');
root = await mountPanel({ source: panels.ROSTERS_SOURCE, context: MATCH, props: BACK });
const heads = [...root.querySelectorAll('h2')].map((h) => text(h));
check('the CT roster is named by the demo clan name', heads.includes('Alpha Squad roster'), heads.join('|'));
check('the T roster is named by the synthesized team name', heads.includes('team_Charlie roster'), heads.join('|'));
check('the other players get an Other table', heads.includes('Other'), heads.join('|'));
const tables = [...root.querySelectorAll('table')];
check('CT: Alpha then Bravo, with K/D/A and ADR', JSON.stringify(tableRows(tables[0])) === JSON.stringify([['Alpha', '20/10/3', '90.5'], ['Bravo', '12/14/1', '64.2']]), JSON.stringify(tableRows(tables[0])));
check('T: Charlie then Delta', JSON.stringify(tableRows(tables[1])) === JSON.stringify([['Charlie', '20/15/4', '80.0'], ['Delta', '5/16/0', '30.0']]), JSON.stringify(tableRows(tables[1])));
check('Other: Echo, and the bot is not listed', JSON.stringify(tableRows(tables[2])) === JSON.stringify([['Echo', '3/4/0', '10.0']]), JSON.stringify(tableRows(tables[2])));

// --- C. scoreboard: default layout -------------------------------------------------
console.log('C. scoreboard, default layout (match 7)');
root = await mountPanel({ source: panels.SCOREBOARD_SOURCE, context: MATCH, props: BACK });
const hs = headers(root);
check('the default columns, in the default order',
  JSON.stringify(hs) === JSON.stringify(['Name', 'Team', 'Score', 'K', 'D', 'DMG', 'Util', 'MVPs', 'A', 'ADR', 'KAST%', 'HS%', 'K/D', 'KDA', '2K', '3K', '4K', '5K', 'Open K', 'Open D', 'Trade', 'Streak']),
  JSON.stringify(hs));
let rows = tableRows(root);
check('one row per human player, kills first (name breaks the tie), the bot left out',
  rows.map((r) => r[0]).join('|') === 'Alpha|Charlie|Bravo|Delta|Echo', rows.map((r) => r[0]).join('|'));
const alpha = rows[0];
check('Alpha row: team, score and the stored values',
  alpha[1] === 'Alpha Squad' && alpha[2] === '31' && alpha[3] === '20' && alpha[5] === '1,800' && alpha[10] === '75%' && alpha[12] === '2.00' && alpha[13] === '2.30',
  JSON.stringify(alpha));
check('a zero is shown as 0, not a dash (Alpha four_k)', alpha[16] === '0', alpha[16]);
check('Charlie is on the T side, named by the synthesized team', rows[1][1] === 'team_Charlie', rows[1][1]);
check('Echo has no side: a dash for team, and a dash for a missing stored value (trade)',
  rows[4][1] === '—' && rows[4][20] === '—', JSON.stringify(rows[4]));
const teamChip = root.querySelector('tbody tr td .chip');
check('the team chip carries the start-side class', !!teamChip && teamChip.classList.contains('team-start-ct'));

// --- D. sorting by a header ---------------------------------------------------------
console.log('D. header sort');
const deathsHead = [...root.querySelectorAll('thead th button')].find((b) => text(b) === 'D');
click(deathsHead);
await settle(6);
rows = tableRows(root);
check('sorting by deaths puts the most deaths first', rows.map((r) => r[0]).join('|') === 'Delta|Charlie|Bravo|Alpha|Echo', rows.map((r) => r[0]).join('|'));
click([...root.querySelectorAll('thead th button')].find((b) => text(b) === 'D'));
await settle(6);
rows = tableRows(root);
check('a second click reverses the order', rows.map((r) => r[0]).join('|') === 'Echo|Alpha|Bravo|Charlie|Delta', rows.map((r) => r[0]).join('|'));

// D2. the chain: each click on a new header sorts on top of the ones before it.
// Fixture kills: Alpha 20, Charlie 20, Bravo 12, Delta 5, Echo 3 (Alpha and
// Charlie tie); open kills: Alpha 4, Charlie 1, Bravo/Delta/Echo 0; sides:
// Alpha/Bravo ct, Charlie/Delta t, Echo none.
console.log('D2. chained header sort');
root = await mountPanel({ source: panels.SCOREBOARD_SOURCE, context: MATCH, props: BACK });
const clickHeader = (label) => click([...root.querySelectorAll('thead th button')].find((b) => text(b) === label));
const order = () => tableRows(root).map((r) => r[0]).join('|');
const CHAIN = [
  ['start: kills, name breaks the tie', null, 'Alpha|Charlie|Bravo|Delta|Echo'],
  ['Team (descending)', 'Team', 'Charlie|Delta|Alpha|Bravo|Echo'],
  ['K on top of Team: Team breaks the kills tie', 'K', 'Charlie|Alpha|Bravo|Delta|Echo'],
  ['K again reverses the newest key only', 'K', 'Echo|Delta|Bravo|Charlie|Alpha'],
  ['Name (descending) on top', 'Name', 'Echo|Delta|Charlie|Bravo|Alpha'],
  ['Open K on top: Name order breaks the zero ties', 'Open K', 'Alpha|Charlie|Echo|Delta|Bravo'],
];
for (const [what, label, want] of CHAIN) {
  if (label) {
    clickHeader(label);
    await settle(6);
  }
  check('chain ' + what, order() === want, order() + ' (want ' + want + ')');
}
const sortedMarks = [...root.querySelectorAll('thead th[aria-sort]')].filter((th) => th.getAttribute('aria-sort') !== 'none');
check('only the newest key carries a sort mark', sortedMarks.length === 1 && text(sortedMarks[0].querySelector('button')) === 'Open K', sortedMarks.length);

// --- D3. the formula tooltips ------------------------------------------------------
console.log('D3. header formula tooltips');
root = await mountPanel({ source: panels.SCOREBOARD_SOURCE, context: MATCH, props: BACK });
const ths = [...root.querySelectorAll('thead th')];
check('Name, Team and Score carry no formula tooltip', ths.slice(0, 3).every((th) => !th.title), ths.slice(0, 3).map((th) => th.title).join('|'));
const metricThs = ths.slice(3);
check('every metric header has its formula as its tooltip',
  metricThs.length === 19 && metricThs.every((th) => /^Formula of [a-z_]+$/.test(th.title)),
  metricThs.map((th) => th.title).join('|'));
const dHead = ths.find((th) => text(th) === 'D');
check('the D header names the deaths formula', dHead && dHead.title === 'Formula of deaths', dHead && dHead.title);

// --- E. the row click follows the player, back to this tab -------------------------
console.log('E. row click');
root = await mountPanel({ source: panels.SCOREBOARD_SOURCE, context: MATCH, props: BACK });
const firstRow = root.querySelector('tbody tr');
click(firstRow);
await settle(4);
check('a row click opens the replay following that player, back to the Scoreboard tab',
  navCalls.length === 1 && navCalls[0] === '/replay/7?back=match/7/scoreboard&follow=' + ALPHA,
  JSON.stringify(navCalls));
const nameBtn = firstRow.querySelector('button.name-link');
click(nameBtn);
await settle(4);
check('the name button opens the profile, not the replay',
  navCalls.length === 2 && navCalls[1] === '/player/' + ALPHA, JSON.stringify(navCalls));

// --- F. another match's context ----------------------------------------------------
console.log('F. context binds the match');
root = await mountPanel({ source: panels.SCOREBOARD_SOURCE, context: { matchId: 8, steamId: null, round: null }, props: BACK });
check('a match with no stored rows shows no rows', tableRows(root).length === 0, JSON.stringify(tableRows(root)));
root = await mountPanel({ source: panels.OVERVIEW_SOURCE, context: { matchId: 8, steamId: null, round: null }, props: BACK });
check('a match with no stored values shows no cards', root.querySelectorAll('.stat-cell').length === 0);

// --- H. the metric states: calculating and failed --------------------------------------
console.log('H. metric states (match 7)');
const MATCH_STATES = [
  { metricId: idOf('kills'), state: 'processing', error: '' },
  { metricId: idOf('adr'), state: 'failed', error: 'adr engine error' },
];
const stateReads = {
  ...reads,
  getMetricComputeState: async () => MATCH_STATES,
  getMetricStates: async () => MATCH_STATES,
};
root = await mountPanel({ source: panels.SCOREBOARD_SOURCE, context: MATCH, props: BACK, reads: stateReads });
rows = tableRows(root);
check('a metric being calculated shows its state word in every row, not a number',
  rows.every((r) => r[3] === 'Calculating'), JSON.stringify(rows.map((r) => r[3])));
const failedCells = [...root.querySelectorAll('tbody tr td:nth-child(10)')];
check('a failed metric header names the failure in its tooltip',
  root.querySelectorAll('thead th')[9].title === 'Formula of adr — couldn’t calculate: adr engine error',
  root.querySelectorAll('thead th')[9].title);
check('a failed metric shows Failed, with the engine error as its title',
  failedCells.length === 5 && failedCells.every((td) => td.textContent.trim() === 'Failed' && td.title === 'adr engine error'),
  failedCells.map((td) => td.textContent.trim() + '|' + td.title).join(' '));
root = await mountPanel({ source: panels.OVERVIEW_SOURCE, context: MATCH, props: BACK, reads: stateReads });
check('a card whose number is still calculating names no number for that part',
  text(cardIn(root, 'Top fragger')?.querySelector('.stat-value')) === 'Calculating/10/3', text(cardIn(root, 'Top fragger')?.querySelector('.stat-value')));

// --- I. the match view reads its own match's state -----------------------------------
console.log('I. per-match state (the library word says behind, this match is fresh)');
const perMatchReads = {
  ...reads,
  getMetricComputeState: async () => [{ metricId: idOf('kills'), state: 'behind', error: '' }],
  getMetricStates: async () => [{ metricId: idOf('kills'), state: 'fresh', error: '' }],
};
root = await mountPanel({ source: panels.SCOREBOARD_SOURCE, context: MATCH, props: BACK, reads: perMatchReads });
rows = tableRows(root);
check('the library-wide behind word does not reach this match: its stored values show',
  rows.length > 0 && rows.every((r) => r[3] !== 'Out of date' && /^\d/.test(r[3])), JSON.stringify(rows.map((r) => r[3])));

// --- G. the strings every panel shows come from the same table --------------------
console.log('G. panel registry');
check('the six panels are registered as builtins', panels.MATCH_PANELS.length === 6 && panels.MATCH_PANELS.every((p) => p.id.startsWith('builtin-match-')));
check('the Match view’s roster heading suffix is the catalog’s', S.match.rosterSuffix === 'roster');

unmountAll();
console.log(failures === 0 && escaped.length === 0 ? 'ALL PASS' : `FAILURES: ${failures}, escaped: ${escaped.length}`);
process.exit(0);
