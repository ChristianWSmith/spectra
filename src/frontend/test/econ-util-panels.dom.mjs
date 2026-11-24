import { warm, compileIdle } from './compile-worker-node.mjs';
await warm();
// jsdom driver for the Economy and Utility builtins. Each view mounts through the real
// ComponentFrame (its composer, then the panels the composer mounts with
// spectra.Child), reads through the real read API, and renders from a fixture
// whose every value this file can compute by hand. Fixture: match 9, four
// counted rounds (CT, T, CT, T), no side switch.
//   A. the economy cards show the six stored statistics, drill to the round;
//   B. the economy curve has one strip cell per round, in winner colours;
//   C. the rounds table: winners by team name, buy chips, deaths from the stored
//      round metric (a dash where none is stored, a real 0 as 0), loss pips,
//      and a round click opens the round;
//   D. the Utility throw log: round scope preselected to the first round with
//      throws, the count, one row per throw with its clock, damage, blind, the
//      affected count and the coordinate (a dash where unknown);
//   E. the kind filter narrows the log and the damage bars, and the damage card
//      hides when nothing is drawable;
//   F. a throw's ▶ watches it with its thrower followed, back to the tab;
//   G. a metric still calculating shows a dash, never a number.
//
// Run (from frontend/):  node test/econ-util-panels.dom.mjs
// Then grep the log for FAIL and UNCAUGHT: the exit code is not the verdict.
import { reachesSvelte } from './bundle-reach.mjs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { compile, compileModule } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
});

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
for (const k of [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement',
  'HTMLTextAreaElement', 'HTMLButtonElement', 'HTMLMediaElement', 'HTMLAnchorElement', 'SVGSVGElement', 'SVGElement', 'Element', 'Node', 'Text', 'Comment',
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

// --- bundling (as match-panels.dom.mjs) ---------------------------------------
const cacheDir = join('node_modules', '.cache', 'spectra-dom-tests', 'econ-util-panels');
mkdirSync(cacheDir, { recursive: true });
const panelStub = join(cacheDir, 'panels-stub.js');
writeFileSync(panelStub, 'export function builtinPanelById() { return null; }\n');
const compiled = new Map();
let seq = 0;
function bundle(absPath) {
  if (compiled.has(absPath)) return compiled.get(absPath);
  const out = join(cacheDir, `${String(++seq).padStart(2, '0')}-${absPath.split('/').pop()}.js`);
  compiled.set(absPath, out);
  const src = readFileSync(absPath, 'utf8').replace(/from '(\.{1,2}\/[^']+)'/g, (whole, rel) => {
    const target = resolve(dirname(absPath), rel);
    if (target.endsWith('.svelte')) return `from '${pathToFileURL(bundle(target)).href}'`;
    if (target.endsWith('.svelte.js')) return `from '${pathToFileURL(bundle(target)).href}'`;
    // The Profile panels are app Svelte the bundler compiles; this driver mounts
    // no Profile panel, so the registry is a stub (as component-frame.dom.mjs does).
    if (target.endsWith('builtins/panels.js')) return `from '${pathToFileURL(panelStub).href}'`;
    // A .js that reaches the stubbed registry through its own imports (resolve.js) is
    // bundled too, so its import of the registry is rewritten.
    if (target.endsWith('.js') && reachesSvelte(target)) return `from '${pathToFileURL(bundle(target)).href}'`;
    return `from '${pathToFileURL(target).href}'`;
  });
  writeFileSync(out, absPath.endsWith('.svelte') ? compile(src, { filename: absPath, generate: 'client' }).js.code
    : /\.svelte\.js$/.test(absPath) ? compileModule(src, { filename: absPath, generate: 'client' }).js.code : src);
  return out;
}
const harnessBundle = bundle(resolve('test/match-panels.harness.svelte'));

const { mount, unmount, flushSync } = await import('svelte');
// The Economy and Utility composers are Svelte builtins: their source is the .svelte file.
const ECON_DIR = 'src/lib/builtins/econ';
const UTIL_DIR = 'src/lib/builtins/util';
const panels = { ECONOMY_SOURCE: readFileSync(resolve(ECON_DIR, 'Economy.svelte'), 'utf8') };
const upanels = { UTILITY_SOURCE: readFileSync(resolve(UTIL_DIR, 'Utility.svelte'), 'utf8') };
const Harness = (await import(pathToFileURL(harnessBundle).href)).default;

// --- the fixture: match 9 -------------------------------------------------------
const ALPHA = '76561190000000001'; // CT
const BRAVO = '76561190000000002'; // CT
const CHARLIE = '76561190000000003'; // T (lowest T steam id: the synthesized name)
const DELTA = '76561190000000004'; // T
const MATCH = 9;

const ROSTER = [
  [ALPHA, 'Alpha', 'ct', 20],
  [BRAVO, 'Bravo', 'ct', 12],
  [CHARLIE, 'Charlie', 't', 20],
  [DELTA, 'Delta', 't', 5],
];
// The clan name exists for CT only: T is named by its lowest SteamID player.
const TEAMS = [['ct', 'Alpha Squad'], ['t', '']];

// Rounds: number, winner, start tick, end tick (64 ticks a second).
const ROUNDS = [
  [1, 'ct', 1000, 1900],
  [2, 't', 2000, 2900],
  [3, 'ct', 3000, 3900],
  [4, 't', 4000, 4900],
];

// The economy rows the economy query returns (17 columns, see builtins/econ/Economy.svelte
// SQL_ECON): number, winner, equip ct/t, money ct/t, spent ct/t, free pistol
// ct/t, label, explanation, rule version, class ct/why, class t/why.
const ECON = [
  [1, 'ct', 4000, 2000, 500, 300, 0, 0, 0, 0, 'pistol', 'pistol round', 3, 'full', 'full buy', 'eco', 'eco save'],
  [2, 't', 1000, 3000, 200, 100, 0, 0, 0, 0, '', '', 3, 'eco', '', 'full', ''],
  [3, 'ct', 3500, 2500, 0, 0, 0, 0, 0, 0, '', '', 3, 'force', '', 'force', ''],
  [4, 't', 2000, 4500, 0, 0, 0, 0, 0, 0, '', '', 3, 'full', '', 'full', ''],
];

// The utility rows (16 columns, see builtins/util/Utility.svelte SQL_UTIL): seq, tick, throw
// tick, round, thrower, thrower name, kind, throw x/y, det x/y, damage, flash
// ms, affected (JSON), site, trajectory ref.
const UTIL = [
  [1, 1700, 1640, 1, ALPHA, 'Alpha', 'flash', 100, 0, 0, 0, 0, 2500, '["a","b"]', '', ''],
  [2, 1200, 0, 1, CHARLIE, 'Charlie', 'he', null, null, 0, 0, 45, 0, '[]', '', ''],
  [3, 2400, 2320, 2, BRAVO, 'Bravo', 'smoke', 0, 0, 0, 0, 0, 0, '', '', ''],
  [4, 3600, 3560, 3, DELTA, 'Delta', 'he', 10, 20, 0, 0, 30, 0, '["x"]', '', ''],
  [5, 3700, 3700, 3, ALPHA, 'Alpha', 'flash', 50, 60, 0, 0, 0, 1200, '', '', ''],
];

// The stored values the economy and utility metrics hold for this match (the
// values a metric's SQL produces; the fixture gives them, the panels read them).
const METRIC_IDS = [
  'pistol_hold', 'team_force_wins', 'team_force_rounds', 'avg_equip_gap', 'lost_equip', 'team_lost_equip',
  'raw_player_round_deaths', 'unrelated_probe',
];
const DEFS = METRIC_IDS.map((name, i) => ({ id: i + 1, name, scope: 'match' }));
const idOf = (name) => DEFS.find((d) => d.name === name).id;

const MATCH_VALUES = [
  ['pistol_hold', '', 0],
  ['team_force_wins', 'ct', 1],
  ['team_force_wins', 't', 0],
  ['team_force_rounds', 'ct', 1],
  ['team_force_rounds', 't', 1],
  ['avg_equip_gap', '', 1875],
  ['lost_equip', '', 7500],
  ['team_lost_equip', 'ct', 3000],
  ['team_lost_equip', 't', 4500],
];
// Round deaths: round → side → value. Round 4 has no stored row (a dash).
const ROUND_DEATHS = {
  1: { ct: 3, t: 4 },
  2: { ct: 5, t: 0 },
  3: { t: 2 },
};

// The compute states the fixture reports (none unless a case sets them).
let computeStates = [];

// The read services the panels call: the metric catalog, the stored values by
// match and round, the compute state, and the component queries answered from
// the fixture by the SQL each panel runs.
function answer(sql) {
  const matchId = Number((/match_id = (\d+)/.exec(sql) || [])[1]);
  if (matchId !== MATCH) return { columns: ['x'], rows: [] };
  if (/round_economy/.test(sql)) return { columns: ['c'], rows: ECON.map((r) => [...r]) };
  if (/score_ct, score_t, side_switches FROM matches/.test(sql)) return { columns: ['a', 'b', 'c'], rows: [[2, 1, 0]] };
  if (/tick_rate, side_switches FROM matches/.test(sql)) return { columns: ['a', 'b'], rows: [[64, 0]] };
  if (/number, winner, start_tick, end_tick FROM rounds/.test(sql)) return { columns: ['a'], rows: ROUNDS.map((r) => [...r]) };
  if (/^SELECT round, steam_id, side FROM round_player_sides/.test(sql)) return { columns: ['a'], rows: [] };
  if (/FROM utility_events/.test(sql)) return { columns: ['a'], rows: UTIL.map((r) => [...r]) };
  if (/FROM teams/.test(sql)) return { columns: ['side', 'name'], rows: TEAMS.map((r) => [...r]) };
  if (/FROM player_stats ps/.test(sql)) {
    const rows = ROSTER.map((r) => [...r]).sort((a, b) => b[3] - a[3] || (a[1] < b[1] ? -1 : 1));
    return { columns: ['steam_id', 'name', 'side', 'score'], rows };
  }
  return { err: 'the fixture does not answer: ' + sql };
}

const reads = {
  listMetrics: async () => DEFS,
  getMetricValuesForMatch: async (matchId, ids) =>
    matchId !== MATCH
      ? []
      : MATCH_VALUES.filter(([name]) => ids.includes(idOf(name))).map(([name, key, value]) => ({
          metricId: idOf(name),
          subjectKey: key,
          dim: '',
          value,
          valueKey: '',
        })),
  getMetricValuesForRound: async (matchId, round, ids) => {
    if (matchId !== MATCH || !ids.includes(idOf('raw_player_round_deaths')) || !ROUND_DEATHS[round]) return [];
    // One row per player per round, its dim the side: ALPHA is the CT player,
    // CHARLIE the T player (the side sums are the values in ROUND_DEATHS).
    const PLAYER_OF = { ct: ALPHA, t: CHARLIE };
    return Object.entries(ROUND_DEATHS[round]).map(([side, value]) => ({
      metricId: idOf('raw_player_round_deaths'),
      subjectKey: PLAYER_OF[side],
      dim: side,
      value,
      valueKey: '',
    }));
  },
  getMetricValuesForPlayer: async () => [],
  getMetricComputeState: async () => computeStates,
  getMetricStates: async () => computeStates,
  componentQuery: async (sql) => answer(sql),
};

// --- helpers ------------------------------------------------------------------
const sleep = async (ms = 30) => {
  await new Promise((r) => setTimeout(r, ms));
  await compileIdle();
};
const settle = async (rounds = 12) => {
  for (let i = 0; i < rounds; i++) {
    await sleep(25);
    flushSync();
  }
};
// The kind filter is a popover multi-select: open its trigger, check the kinds wanted, then close it.
async function setKindsFor(kinds) {
  const trig = root.querySelector('.util-kind-host > button');
  if (!root.querySelector('.util-kind-pop')) trig.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep();
  for (const cb of root.querySelectorAll('.util-kind-pop input[type=checkbox]')) {
    const want = kinds.includes(cb.parentElement.textContent.trim());
    if (cb.checked !== want) cb.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  }
  await sleep();
}
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
const change = (el, value) => {
  el.value = value;
  el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
};

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
const mountPanel = async ({ source, context, props = {}, reads: readsOverride = reads, builtinDir = ECON_DIR }) => {
  unmountAll();
  navCalls.length = 0;
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(Harness, { target, props: { source, context, props, reads: readsOverride, nav: (h) => navCalls.push(h), builtinDir } });
  await settle();
  return target;
};

const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const tableRows = (root) => [...root.querySelectorAll('tbody tr')].filter((tr) => !tr.classList.contains('econ-why-row')).map((tr) => [...tr.children].map((td) => text(td)));
const CTX = { matchId: MATCH, steamId: null, round: null };
const ECON_BACK = { back: 'match/9/economy' };
const UTIL_BACK = { back: 'match/9/utility' };

// --- A. the economy cards -----------------------------------------------------------
console.log('A. economy cards (match 9)');
// The Economy view is mounted whole: its composer loads the rows and mounts the
// curve, the cards and the rounds table.
let root = await mountPanel({ source: panels.ECONOMY_SOURCE, context: CTX, props: ECON_BACK });
// A card's label, without its provenance badge (computed / inferred).
const labelOf = (c) => text(c.querySelector('.field-label')).replace(/computed|inferred/g, '').trim();
const cardBy = (label) => [...root.querySelectorAll('.stat-cell')].find((c) => labelOf(c) === label);
const cardVal = (label) => text(cardBy(label)?.querySelector('.stat-value'));
check('six cards, in the default order',
  [...root.querySelectorAll('.stat-cell')].map(labelOf).join('|') ===
    'Pistol → next round|Force rounds won|Force rounds|Winner equipment value advantage|Lost equipment|Team lost equipment',
  [...root.querySelectorAll('.stat-cell')].map(labelOf).join('|'));
check('pistol hold: the stored percent, 0 shown as 0%', cardVal('Pistol → next round') === '0%', cardVal('Pistol → next round'));
check('force rounds won: both teams, named by the clan and the synthesized name', cardVal('Force rounds won') === 'Alpha Squad 1 · team_Charlie 0', cardVal('Force rounds won'));
check('force rounds: both teams', cardVal('Force rounds') === 'Alpha Squad 1 · team_Charlie 1', cardVal('Force rounds'));
check('winner equipment advantage: the stored currency', cardVal('Winner equipment value advantage') === '$1,875', cardVal('Winner equipment value advantage'));
check('lost equipment: the stored currency', cardVal('Lost equipment') === '$7,500', cardVal('Lost equipment'));
check('team lost equipment: both teams', cardVal('Team lost equipment') === 'Alpha Squad $3,000 · team_Charlie $4,500', cardVal('Team lost equipment'));
check('the inferred badge is on the two lost-equipment cards only',
  [...root.querySelectorAll('.stat-cell .badge-inferred')].length === 2 && [...root.querySelectorAll('.stat-cell .badge-computed')].length === 4);

// --- B. the economy curve -------------------------------------------------------------
console.log('B. economy curve (match 9)');
check('the curve heading is the equip metric', text(root.querySelector('.econ-curve-panel h2')) === 'Equip value per round');
check('one winner-strip cell per round', root.querySelectorAll('.econ-strip-cell').length === 4);
const strip = [...root.querySelectorAll('.econ-strip-cell')];
check('the winner strip colours the winners (CT, T, CT, T)',
  strip.map((c) => (c.classList.contains('ct') ? 'ct' : c.classList.contains('t') ? 't' : '-')).join(',') === 'ct,t,ct,t',
  strip.map((c) => c.className).join(' | '));
check('the scale runs to the largest equip value (4500), as money', text(root.querySelector('.econ-axis-note')) === '0 – $4,500', text(root.querySelector('.econ-axis-note')));

// --- C. the rounds table ------------------------------------------------------------------
console.log('C. economy rounds (match 9)');
const rows = tableRows(root);
check('four rounds, numbered 1-4', rows.map((r) => r[1]).join(',') === '1,2,3,4', rows.map((r) => r[1]).join(','));
check('the winners are named by their team', rows.map((r) => r[2]).join('|') === 'Alpha Squad|team_Charlie|Alpha Squad|team_Charlie', rows.map((r) => r[2]).join('|'));
check('the buy chips show each side’s class', rows.map((r) => r[3] + '/' + r[4]).join('|') === 'full/eco|eco/full|force/force|full/full', rows.map((r) => r[3] + '/' + r[4]).join('|'));
check('deaths come from the stored round metric; a missing value is a dash, a zero is 0',
  rows.map((r) => r[5] + '/' + r[6]).join('|') === '3/4|5/0|—/2|—/—', rows.map((r) => r[5] + '/' + r[6]).join('|'));
const trs = [...root.querySelectorAll('tbody tr')].filter((tr) => !tr.classList.contains('econ-why-row'));
const pipCount = (tr, cls) => tr.querySelectorAll(`.econ-loss-pip.${cls}`).length;
check('loss pips: round 1 CT 2 and T 2 (the 1900 bonus)', pipCount(trs[0], 'ct') === 2 && pipCount(trs[0], 't') === 2, `${pipCount(trs[0], 'ct')}/${pipCount(trs[0], 't')}`);
check('loss pips: round 2 CT 1 (the base 1400) and T 3 (2400)', pipCount(trs[1], 'ct') === 1 && pipCount(trs[1], 't') === 3, `${pipCount(trs[1], 'ct')}/${pipCount(trs[1], 't')}`);
check('the pistol round is marked on the strip', strip[0].classList.contains('pistol'));
check('the round number opens the Rounds tab with that round expanded',
  (() => {
    click(trs[2].querySelector('button.econ-rd'));
    return navCalls.at(-1) === '/match/9/rounds?round=3';
  })(),
  navCalls.at(-1));
// The watch button of a round opens the replay at its start, the round as the loop.
click(trs[0].querySelector('button[aria-label="Watch round 1"]'));
check('a round’s watch button opens the replay at its start with the round span',
  navCalls.at(-1) === '/replay/9?tick=1000&loop=1000,1900&back=match/9/economy', navCalls.at(-1));

// The card drill: the first pistol round's card watches round 1.
click(cardBy('Pistol → next round'));
check('a card drills to its round: the first decided pistol round',
  navCalls.at(-1) === '/replay/9?tick=1000&loop=1000,1900&back=match/9/economy', navCalls.at(-1));
click(cardBy('Lost equipment'));
check('the lost-equipment card drills to the round that lost the most equipment (round 3)',
  navCalls.at(-1) === '/replay/9?tick=3000&loop=3000,3900&back=match/9/economy', navCalls.at(-1));

// The why chip expands the explanation row.
click(trs[0].querySelector('button.econ-cls'));
await settle(4);
check('a buy chip opens its reason row', root.querySelectorAll('.econ-why-row').length === 1 && text(root.querySelector('.econ-why-text')) === 'full buy');

// --- D. the Utility throw log -----------------------------------------------------------------
console.log('D. utility throw log (match 9)');
root = await mountPanel({ source: upanels.UTILITY_SOURCE, context: CTX, props: { ...UTIL_BACK, loopSecs: 5 }, builtinDir: UTIL_DIR });
const count = text(root.querySelector('.util-filters .muted'));
check('the count reads five of five grenades', count === '5 of 5 grenades', count);
check('the round scope preselects round 1, the first round with throws', root.querySelectorAll('.util-nade').length === 2, String(root.querySelectorAll('.util-nade').length));
const nades = [...root.querySelectorAll('.util-nade')];
const nadeCells = (li) => ({
  kind: text(li.querySelector('.util-kind')),
  name: text(li.querySelector('.util-thrower')),
  clock: text(li.querySelector('.util-tick')),
  damage: text(li.querySelectorAll('.util-num')[0]),
  blind: text(li.querySelectorAll('.util-num')[1]),
  aff: text(li.querySelectorAll('.util-num')[2]),
  coord: text(li.querySelector('.util-coord')),
});
check('row 1: the flash by Alpha, into round 1 at 0:10, blind 2.5s, 2 affected, coordinate (100, 0)',
  JSON.stringify(nadeCells(nades[0])) === JSON.stringify({ kind: 'flash', name: 'Alpha', clock: '0:10', damage: '—', blind: '2.5s', aff: '2 aff', coord: '(100, 0)' }),
  JSON.stringify(nadeCells(nades[0])));
check('row 2: the unpaired throw falls back to its detonation tick (0:03), 45 damage, no coordinate',
  JSON.stringify(nadeCells(nades[1])) === JSON.stringify({ kind: 'he', name: 'Charlie', clock: '0:03', damage: '45 dmg', blind: '—', aff: '—', coord: '—' }),
  JSON.stringify(nadeCells(nades[1])));
// Round select: all rounds.
const roundSelect = root.querySelector('#util-round');
check('the round select offers the rounds with throws, scored', [...roundSelect.options].map((o) => o.textContent).join('|') === 'All rounds|RD1 | 1-0|RD2 | 1-1|RD3 | 2-1',
  [...roundSelect.options].map((o) => o.textContent).join('|'));
change(roundSelect, 'all');
await settle(6);
check('all rounds shows all five throws', root.querySelectorAll('.util-nade').length === 5, String(root.querySelectorAll('.util-nade').length));

// The damage and blind charts: one bar per round, the legend's maxima.
const legends = [...root.querySelectorAll('.util-legend .muted')].map((el) => text(el));
check('the damage chart: the largest team total is 45 damage',
  legends.some((t) => t === 'max 45 dmg/round · totals of recorded damage'), legends.join(' || '));
check('the blind chart: the largest team total is 2.5s',
  legends.some((t) => t === 'max 2.5s blind/round · totals of recorded blind time'), legends.join(' || '));
check('both charts show; bars for the three rounds with damage or blind time',
  root.querySelectorAll('.util-card-damage .util-bar').length === 2 * 3 && root.querySelectorAll('.util-card-blind .util-bar').length === 2 * 3,
  `${root.querySelectorAll('.util-card-damage .util-bar').length}/${root.querySelectorAll('.util-card-blind .util-bar').length}`);

// --- E. the kind filter narrows the log and the damage bars ------------------------------------
console.log('E. filters');
await setKindsFor(['flash']);
await settle(6);
const flashRows = [...root.querySelectorAll('.util-nade')];
check('the flash filter keeps the two flashes (the round scope stays on All rounds), and the count', flashRows.length === 2 && text(root.querySelector('.util-filters .muted')) === '2 of 5 grenades',
  `${flashRows.length} ${text(root.querySelector('.util-filters .muted'))}`);
check('the damage card hides when the filtered throws draw no damage', !root.querySelector('.util-card-damage'));
check('the blind card stays: blind time is drawable under the flash filter', !!root.querySelector('.util-card-blind'));
await setKindsFor([]);
await settle(6);

// The thrower filter.
change(root.querySelector('#util-thrower'), CHARLIE);
await settle(6);
check('the thrower filter keeps one player’s throws', root.querySelectorAll('.util-nade').length === 1 && text(root.querySelector('.util-filters .muted')) === '1 of 5 grenades');
change(root.querySelector('#util-thrower'), '');
await settle(6);

// --- F. a throw's ▶ watches it with its thrower followed -----------------------------------------
console.log('F. watch a throw');
root = await mountPanel({ source: upanels.UTILITY_SOURCE, context: CTX, props: { ...UTIL_BACK, loopSecs: 5 }, builtinDir: UTIL_DIR });
click(root.querySelector('.util-nade button.btn'));
check('a throw’s ▶ opens the replay at the throw, its loop, the thrower followed, back to the tab',
  navCalls.at(-1) === `/replay/9?tick=1640&loop=1320,1960&follow=${ALPHA}&back=match/9/utility`, navCalls.at(-1));
click(root.querySelector('.util-nade .comb-name-btn'));
check('a thrower’s name opens the profile', navCalls.at(-1) === '/player/' + ALPHA, navCalls.at(-1));

// --- G. a metric still calculating shows a dash -------------------------------------------------
console.log('G. metric states (match 9)');
computeStates = [{ metricId: idOf('lost_equip'), state: 'processing', error: '' }];
root = await mountPanel({ source: panels.ECONOMY_SOURCE, context: CTX, props: ECON_BACK });
check('a card still calculating shows a dash, not a number', cardVal('Lost equipment') === '—', cardVal('Lost equipment'));
check('the other cards keep their stored values', cardVal('Pistol → next round') === '0%');
computeStates = [];

// A match with no stored rows: the view shows its empty states, not values.
root = await mountPanel({ source: panels.ECONOMY_SOURCE, context: { matchId: 8, steamId: null, round: null }, props: ECON_BACK });
check('a match with no economy rows shows no rounds and no curve', root.querySelectorAll('tbody tr').length === 0 && root.querySelectorAll('.econ-strip-cell').length === 0);

unmountAll();
console.log(failures === 0 && escaped.length === 0 ? 'ALL PASS' : `FAILURES: ${failures}, escaped: ${escaped.length}`);
process.exit(failures === 0 && escaped.length === 0 ? 0 : 1);
