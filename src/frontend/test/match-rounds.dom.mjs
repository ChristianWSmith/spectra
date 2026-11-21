import { warm, compileIdle } from './compile-worker-node.mjs';
await warm();
// jsdom driver for the Match view's rounds and details panels (dogfood/PLAN.md
// C5c, dogfood/04-COMPONENTS.md §3, §3.5). Each panel mounts through the real
// ComponentFrame, compiles from its source and reads through the real read API.
// The read services are a fixture, so every rendered value is one this file
// computes by hand:
//   A. the rounds: one row per round, the stored values, a dash for NULL;
//   B. the winner is the team that won (the side switch flips it after round 12);
//   C. the MVP and first-blood names carry the side the player had in that round;
//   D. the watch button opens the replay at the round's start, looped to its
//      end, back to the tab (the same route the replay link builds);
//   E. a round row opens that round's page, back to the tab;
//   F. the compare box reports its pick, and the compare button appears at two;
//   G. the separator class falls after round 12 only;
//   H. the details panel shows the match's stored facts, a dash for NULL and
//      0 for a stored zero;
//   I. a panel mounted with another match's context reads only that match.
//
// Run (from frontend/):  node test/match-rounds.dom.mjs
// Then grep the log for FAIL and UNCAUGHT: the exit code is not the verdict.
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { compile } from 'svelte/compiler';
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

// --- bundling (as match-panels.dom.mjs) -------------------------------------
const cacheDir = join('node_modules', '.cache', 'spectra-dom-tests', 'match-rounds');
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
const panels = await import(pathToFileURL(resolve('src/lib/matchpanels.js')).href);
const nav = await import(pathToFileURL(resolve('src/lib/nav.js')).href);
const Harness = (await import(pathToFileURL(harnessBundle).href)).default;

// --- the fixture -------------------------------------------------------------------
// Match 7: Alpha, Bravo (CT); Charlie, Delta (T); Echo (no side); a bot (never
// listed). The match had one side switch, so the teams swap sides after round 12.
// Match 8: a match whose stored facts are NULL, to check the dashes.
const ALPHA = '76561190000000001';
const BRAVO = '76561190000000002';
const CHARLIE = '76561190000000003';
const DELTA = '76561190000000004';
const ECHO = '76561190000000005';

const ROSTER_7 = [
  [ALPHA, 'Alpha', 'ct', 31],
  [BRAVO, 'Bravo', 'ct', 12],
  [CHARLIE, 'Charlie', 't', 25],
  [DELTA, 'Delta', 't', 7],
  [ECHO, 'Echo', '', 0],
];

// Round rows in the rounds query's column order:
// number, winner, reason, duration_s, bomb_site, mvp, mvp name,
// first_kill_steam, first kill name, first_death_steam, first death name,
// kills, start_tick, end_tick.
const ROUNDS_7 = [
  [1, 'ct', 'Bomb defused', 105.9, 'B', '', '', ALPHA, 'Alpha', CHARLIE, 'Charlie', 3, 100, 1000],
  [2, 't', 'Elimination', null, '', BRAVO, 'Bravo', '', '', '', '', 0, 1100, null],
  [3, 't', 'Time', 60, 'A', DELTA, 'Delta', DELTA, 'Delta', ALPHA, 'Alpha', 2, 1500, 2100],
  [4, 'ct', 'Elimination', 40.2, 'A', ALPHA, 'Alpha', BRAVO, 'Bravo', CHARLIE, 'Charlie', 2, 2200, 2800],
  [5, 'ct', 'Elimination', 30, 'B', '', '', '', '', '', '', 0, 2900, 3300],
  [6, 'ct', 'Elimination', 30, 'B', '', '', '', '', '', '', 0, 3400, 3800],
  [7, 'ct', 'Elimination', 30, 'B', '', '', '', '', '', '', 0, 3900, 4300],
  [8, 'ct', 'Elimination', 30, 'B', '', '', '', '', '', '', 0, 4400, 4800],
  [9, 'ct', 'Elimination', 30, 'B', '', '', '', '', '', '', 0, 4900, 5300],
  [10, 'ct', 'Elimination', 30, 'B', '', '', '', '', '', '', 0, 5400, 5800],
  [11, 'ct', 'Elimination', 30, 'B', '', '', '', '', '', '', 0, 5900, 6300],
  [12, 'ct', 'Time', 60, 'A', ALPHA, 'Alpha', DELTA, 'Delta', ALPHA, 'Alpha', 2, 9000, 9500],
  [13, 'ct', 'Elimination', 93, 'B', '', '', CHARLIE, 'Charlie', BRAVO, 'Bravo', 1, 10000, 10900],
  [14, 't', 'Bomb exploded', 50, 'A', '', '', '', '', '', '', 0, 11000, 11500],
];

// Match 9 (ruling 42 port of the Rounds-tab pre-match checks): two pre-match
// rows (-2 K, -1 W) ahead of 13 counted rounds. Round 5 has no winner (the
// neutral chip); rounds 1 and 12 are CT wins in era 0 (the final-T side),
// round 13 a CT win after the switch.
const ROUNDS_9 = [
  [-2, '', '', null, '', '', '', '', '', '', '', 0, 0, null],
  [-1, '', '', null, '', '', '', '', '', '', '', 0, 0, null],
  ...Array.from({ length: 13 }, (_, i) => {
    const n = i + 1;
    const winner = n === 5 ? '' : n === 1 || n === 12 || n === 13 ? 'ct' : 't';
    return [n, winner, 'Elimination', 30, 'A', '', '', '', '', '', '', 0, 100 * n, 100 * n + 50];
  }),
];

const FACTS_7 = [
  'Test Server', 64.0, 125742, 181793649, '2026-11-18 21:00:15.014365321 +0000 UTC',
  'demoinfocs/v6', '/demos/de_mirage.dem.zst', 2,
];
const FACTS_8 = [null, null, null, null, null, '', '', 0];

const SWITCHES = { 7: 1, 8: 0, 9: 1 };
const TEAMS = { 7: [['ct', 'Alpha Squad'], ['t', '']], 8: [], 9: [['ct', 'Alpha Squad'], ['t', 'Charlie Crew']] };

// The component queries, answered for the fixture (a match with no rows answers none).
function answer(sql) {
  const m = /\b(?:match_id|id) = (\d+)/.exec(sql);
  const matchId = m ? Number(m[1]) : NaN;
  if (/FROM rounds r/.test(sql)) {
    const rows = matchId === 7 ? ROUNDS_7 : matchId === 9 ? ROUNDS_9 : [];
    return { columns: [], rows: rows.map((r) => [...r]) };
  }
  // The switches query also reads FROM matches, so it is answered first.
  if (/side_switches FROM matches/.test(sql)) {
    return { columns: [], rows: matchId in SWITCHES ? [[SWITCHES[matchId]]] : [] };
  }
  if (/FROM matches WHERE id/.test(sql)) {
    if (matchId !== 7 && matchId !== 8 && matchId !== 9) return { columns: [], rows: [] };
    return { columns: [], rows: [matchId === 8 ? [...FACTS_8] : [...FACTS_7]] };
  }
  if (/FROM player_stats/.test(sql)) {
    return { columns: [], rows: matchId === 7 ? ROSTER_7.map((r) => [...r]) : [] };
  }
  if (/FROM teams/.test(sql)) return { columns: [], rows: (TEAMS[matchId] || []).map((r) => [...r]) };
  return { err: 'the fixture does not answer: ' + sql };
}

const reads = {
  listMetrics: async () => [],
  getMetricValuesForMatch: async () => [],
  getMetricValuesForPlayer: async () => [],
  getMetricComputeState: async () => [],
  componentQuery: async (sql) => answer(sql),
};

// --- helpers --------------------------------------------------------------------------
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
const change = (el) => el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

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
let navCalls = [];
let pickCalls = [];
let compareCalls = 0;
const unmountAll = () => {
  if (instance) unmount(instance);
  instance = null;
  if (target) target.remove();
  target = null;
};
const mountPanel = async ({ source, context, props = {} }) => {
  unmountAll();
  navCalls = [];
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(Harness, {
    target,
    props: { source, context, props, reads, nav: (h) => navCalls.push(h) },
  });
  await settle();
  return target;
};

const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const tableRows = (root) =>
  [...root.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => text(td)));
const rowsOf = (root) => [...root.querySelectorAll('tbody tr')];
const MATCH = { matchId: 7, steamId: null, round: null };
const BACK = { back: 'match/7/rounds' };
const rounds = (root) => rowsOf(root);

const propsWith = (extra) => ({ ...BACK, ...extra });
const roundsProps = (picks = []) => propsWith({
  picks,
  onPick: (n) => pickCalls.push(n),
  onCompare: () => {
    compareCalls++;
  },
});

// --- A. the rounds: the stored values -----------------------------------------------------
console.log('A. rounds: stored values (match 7)');
let root = await mountPanel({ source: panels.ROUNDS_SOURCE, context: MATCH, props: roundsProps() });
let rs = rounds(root);
check('one row per round, in round order', rs.length === 14 && text(rs[0].children[2]) === '1' && text(rs[13].children[2]) === '14', String(rs.length));
let r1 = tableRows(root)[0];
check('round 1: RD, reason, duration, site and kills',
  r1[2] === '1' && r1[4] === 'Bomb defused' && r1[5] === '1m46s' && r1[6] === 'B' && r1[9] === '3',
  JSON.stringify(r1));
check('round 1: the winner is the team that played the other side in round 1 (team_Charlie)', r1[3] === 'team_Charlie', r1[3]);
check('round 1: no MVP shows a dash', r1[7] === '—', r1[7]);
check('round 1: first blood names the killer and the victim', r1[8] === 'Alpha killed Charlie', r1[8]);
const r2 = tableRows(root)[1];
check('round 2: a NULL duration shows a dash, never a zero', r2[5] === '—' && r2[6] === '—', JSON.stringify(r2));
check('round 2: a round with no first blood shows a dash', r2[8] === '—', r2[8]);
check('round 2: the MVP is named', r2[7] === 'Bravo', r2[7]);
check('round 2: a zero kill count is shown as 0', r2[9] === '0', r2[9]);
const r13 = tableRows(root)[12];
check('round 13: after the switch the winner is the team on the CT side (Alpha Squad)', r13[3] === 'Alpha Squad', r13[3]);

// --- B. the side switch -----------------------------------------------------------------------
console.log('B. side class of the MVP after the switch');
const mvpBravo = rowsOf(root)[1].children[7].querySelector('button');
check('round 2: Bravo (CT final) is shown in the T colour, as he played T that round', !!mvpBravo && mvpBravo.classList.contains('side-t'), mvpBravo ? mvpBravo.className : 'no button');

// --- C. the separator ----------------------------------------------------------------------------
console.log('C. separator after round 12');
const splits = rowsOf(root).map((tr, i) => (tr.classList.contains('split-before') ? i + 1 : 0)).filter(Boolean);
check('the one separator falls before round 13', JSON.stringify(splits) === '[13]', JSON.stringify(splits));

// --- D. the watch button -----------------------------------------------------------------------------
console.log('D. watch round');
const watch1 = rowsOf(root)[0].querySelector('button[aria-label]');
check('the watch button names its round', watch1 && watch1.getAttribute('aria-label') === 'Watch round 1', watch1 && watch1.getAttribute('aria-label'));
click(watch1);
await settle(4);
const want1 = nav.replayHash(7, {}, { tick: 100, loop: '100,1000', back: 'match/7/rounds' });
check('the watch link is the replay at the round start, looped to its end, back to the tab',
  navCalls.length === 1 && navCalls[0] === want1, JSON.stringify(navCalls) + ' want ' + want1);
click(rowsOf(root)[1].querySelector('button[aria-label]'));
await settle(4);
const want2 = nav.replayHash(7, {}, { tick: 1100, back: 'match/7/rounds' });
check('a round with no end tick opens the replay at its start, with no loop',
  navCalls.length === 2 && navCalls[1] === want2, JSON.stringify(navCalls));

// --- E. the round row ---------------------------------------------------------------------------------
console.log('E. round row');
navCalls = [];
click(rowsOf(root)[3].children[4]);
await settle(4);
check('a click on the row opens that round, back to the tab',
  navCalls.length === 1 && navCalls[0] === '/match/7/round/4?back=match/7/rounds', JSON.stringify(navCalls));
navCalls = [];
click(rowsOf(root)[3].querySelector('td .comb-name-btn'));
await settle(4);
check('a name button opens the profile, not the round', navCalls.length === 1 && navCalls[0] === '/player/' + ALPHA, JSON.stringify(navCalls));

// --- E2. pre-match labels, winner chips and the boundary (match 9) ----------------------------
console.log('E2. pre-match K/W labels, winners, neutral chip, boundary (match 9)');
root = await mountPanel({ source: panels.ROUNDS_SOURCE, context: { matchId: 9, steamId: null, round: null }, props: roundsProps() });
const r9 = rowsOf(root);
check('match 9: every stored row renders (2 pre-match + 13 counted, no pref)', r9.length === 15, String(r9.length));
check('match 9: the pre-match rows carry the K and W labels in the Rd cell',
  text(r9[0].children[2]) === 'K' && text(r9[1].children[2]) === 'W', `${text(r9[0].children[2])} / ${text(r9[1].children[2])}`);
const winnerChip = (i) => r9[i].children[3].querySelector('.chip');
check('match 9: round 1 (CT win, era 0) names the final-T team', text(r9[2].children[3]) === 'Charlie Crew', text(r9[2].children[3]));
const chip5r = winnerChip(6);
check('match 9: round 5 (no winner) falls back to the neutral bare chip',
  !!chip5r && chip5r.classList.contains('none') && text(chip5r) === '—', chip5r ? chip5r.className + ' "' + text(chip5r) + '"' : 'missing');
check('match 9: round 12 (era 0, CT win) names the final-T team', text(r9[13].children[3]) === 'Charlie Crew', text(r9[13].children[3]));
check('match 9: round 13 (era 1, CT win) names the final-CT team', text(r9[14].children[3]) === 'Alpha Squad', text(r9[14].children[3]));
const splits9 = r9.map((tr, i) => (tr.classList.contains('split-before') ? i + 1 : 0)).filter(Boolean);
check('match 9: the boundary rides round 13 (1-based row 15), not shifted by the pre-match rows',
  JSON.stringify(splits9) === '[15]', JSON.stringify(splits9));

// --- F. the compare box ----------------------------------------------------------------------------
console.log('F. compare picks');
root = await mountPanel({ source: panels.ROUNDS_SOURCE, context: MATCH, props: roundsProps([1]) });
let boxes = [...root.querySelectorAll('input.cmp-cb')];
check('a pick from the surface shows as checked', boxes[0].checked === true && boxes[1].checked === false);
check('one pick shows no compare button', root.querySelector('.cmp-float') === null);
check('one pick shows the count line', text(root.querySelector('.cmp-hint')) === '1 of 4 rounds selected.', text(root.querySelector('.cmp-hint')));
pickCalls = [];
boxes[1].checked = true;
change(boxes[1]);
await settle(4);
check('ticking a box reports that round to the surface', pickCalls.length === 1 && pickCalls[0] === 2, JSON.stringify(pickCalls));
root = await mountPanel({ source: panels.ROUNDS_SOURCE, context: MATCH, props: roundsProps([1, 2]) });
const floatBtn = root.querySelector('.cmp-float');
check('two picks show the compare button', !!floatBtn && text(floatBtn) === 'Compare 2 rounds', floatBtn && text(floatBtn));
compareCalls = 0;
click(floatBtn);
await settle(4);
check('the compare button calls the surface', compareCalls === 1, String(compareCalls));
root = await mountPanel({ source: panels.ROUNDS_SOURCE, context: MATCH, props: roundsProps([1, 2, 3, 4]) });
boxes = [...root.querySelectorAll('input.cmp-cb')];
check('four picks disable every other box', boxes[4].disabled === true && boxes[0].disabled === false);

// --- H. the details panel -----------------------------------------------------------------------------
console.log('H. details: stored facts (match 7)');
root = await mountPanel({ source: panels.DETAILS_SOURCE, context: MATCH, props: BACK });
const facts = [...root.querySelectorAll('dl.facts > div')].map((d) => [text(d.querySelector('dt')), text(d.querySelector('dd'))]);
const dateWant = new Date('2026-11-18T21:00:15.014Z').toLocaleString(undefined, {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
});
const factWant = [
  ['Server', 'Test Server'],
  ['Tickrate', '64.0 Hz'],
  ['Frames', '125,742'],
  ['Size', '173.4 MB'],
  ['Imported', dateWant],
  ['Parser', 'demoinfocs/v6'],
  ['Warnings', '2'],
  ['Source', '/demos/de_mirage.dem.zst'],
];
check('the eight stored facts, in order, with the app’s formats', JSON.stringify(facts) === JSON.stringify(factWant), JSON.stringify(facts));
check('the key facts heading', text(root.querySelector('h2')) === 'Key facts', text(root.querySelector('h2')));

// --- I. another match's context; NULL facts ---------------------------------------------------------------
console.log('I. context binds the match; NULL facts');
root = await mountPanel({ source: panels.DETAILS_SOURCE, context: { matchId: 8, steamId: null, round: null }, props: BACK });
const nullFacts = [...root.querySelectorAll('dl.facts > div')].map((d) => text(d.querySelector('dd')));
check('a NULL fact shows a dash, and a stored zero shows 0',
  JSON.stringify(nullFacts) === JSON.stringify(['—', '—', '—', '—', '—', '—', '0', '—']), JSON.stringify(nullFacts));
root = await mountPanel({ source: panels.ROUNDS_SOURCE, context: { matchId: 8, steamId: null, round: null }, props: roundsProps() });
check('a match with no stored rounds shows no rows (match 8)', rowsOf(root).length === 0);

// --- G. the registry ------------------------------------------------------------------------------------------
console.log('G. registry');
check('the rounds and details panels are registered as builtins',
  panels.MATCH_PANELS.some((p) => p.id === panels.MATCH_PANEL_IDS.rounds) &&
    panels.MATCH_PANELS.some((p) => p.id === panels.MATCH_PANEL_IDS.details));

unmountAll();
console.log(failures === 0 && escaped.length === 0 ? 'ALL PASS' : `FAILURES: ${failures}, escaped: ${escaped.length}`);
process.exit(0);
