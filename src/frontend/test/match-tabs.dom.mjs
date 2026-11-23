import { warm, compileIdle } from './compile-worker-node.mjs';
await warm();
// jsdom driver for the Match tab set. The tab set mounts through the real
// ComponentFrame with only its context (and the tab the URL owns). Its data is
// its own: the panels read the fixture below through the real read API, and the
// facts panel reads the match services through the bindings stub.
//   (a) the tab bar renders every Match tab from the context alone;
//   (b) the Rounds and Details tabs render their panels from the context;
//   (c) the compare picks survive a tab switch, and are kept per match;
//   (d) the Details facts (stored facts, voice, demo copy and Free copy) read
//       the same as before, for a copied, an external and an unvoiced match.
//
// Run (from frontend/):  node test/match-tabs.dom.mjs
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

// --- bundling (as match-rounds.dom.mjs) -----------------------------------------
// Static and dynamic relative imports both go to one bundled instance per file,
// so the registry's helper imports and this driver share state (viewstate).
const cacheDir = join('node_modules', '.cache', 'spectra-dom-tests', 'match-tabs');
mkdirSync(cacheDir, { recursive: true });
const compiled = new Map();
let seq = 0;
function bundle(absPath) {
  if (compiled.has(absPath)) return compiled.get(absPath);
  const out = join(cacheDir, `${String(++seq).padStart(2, '0')}-${absPath.split('/').pop()}.js`);
  compiled.set(absPath, out);
  const src = readFileSync(absPath, 'utf8').replace(/(from |import\()'(\.{1,2}\/[^']+)'/g, (whole, lead, rel, offset, str) => {
    // Inside a template literal (a built-in's source text) the import is text, not code: leave it.
    if ((str.slice(0, offset).match(/(?<!\\)`/g) || []).length % 2 === 1) return whole;
    const target = resolve(dirname(absPath), rel);
    if (target.endsWith('.svelte') || (target.endsWith('.js') && !target.includes('/generated/'))) return `${lead}'${pathToFileURL(bundle(target)).href}'`;
    return `${lead}'${pathToFileURL(target).href}'`;
  });
  writeFileSync(out, absPath.endsWith('.svelte') ? compile(src, { filename: absPath, generate: 'client' }).js.code : src);
  return out;
}
const harnessBundle = bundle(resolve('test/match-tabs.harness.svelte'));

const { mount, unmount, flushSync } = await import('svelte');
const router = await import(pathToFileURL(bundle(resolve('src/lib/router.js'))).href);
const vs = await import(pathToFileURL(bundle(resolve('src/lib/viewstate.svelte.js'))).href);
const S = await import(pathToFileURL(bundle(resolve('src/lib/strings/index.js'))).href);
const bindings = await import(stub('bindings.mjs'));
// The app hands its startup modules to the helper table (App.svelte); this driver
// bundles them, so it provides the bundled copies the same way.
const runtime = await import(pathToFileURL(bundle(resolve('src/lib/componentruntime/compile.js'))).href);
runtime.provideHelperModule('src/lib/services.js', await import(pathToFileURL(bundle(resolve('src/lib/services.js'))).href));
const Harness = (await import(pathToFileURL(harnessBundle).href)).default;

// --- the fixture ----------------------------------------------------------------------
// Match 7: copied demo, one side switch, two voices. Match 8: external demo,
// no voice. Match 9: a match with rounds only (its picks are its own).
const ALPHA = '76561190000000001';
const CHARLIE = '76561190000000003';

// Round rows in the rounds query's column order (see match-rounds.dom.mjs).
const rowsFor = (n) =>
  Array.from({ length: n }, (_, i) => [
    i + 1, i % 2 ? 't' : 'ct', 'Elimination', 30, 'A', '', '', ALPHA, 'Alpha', CHARLIE, 'Charlie', 1, 100 * (i + 1), 100 * (i + 1) + 50,
  ]);
const ROUNDS = { 7: rowsFor(14), 9: rowsFor(15), 8: [] };
const FACTS = {
  7: ['Test Server', 64.0, 125742, 181793649, '2026-11-18 21:00:15.014365321 +0000 UTC', 'demoinfocs/v6', '/demos/de_mirage.dem.zst', 2],
  8: [null, null, null, null, null, '', '', 0],
  9: [null, null, null, null, null, '', '', 0],
};

function answer(sql) {
  const m = /\b(?:match_id|id) = (\d+)/.exec(sql);
  const matchId = m ? Number(m[1]) : NaN;
  if (/FROM rounds r/.test(sql)) return { columns: [], rows: (ROUNDS[matchId] || []).map((r) => [...r]) };
  if (/side_switches FROM matches/.test(sql)) return { columns: [], rows: [[1]] };
  if (/FROM matches WHERE id/.test(sql)) return { columns: [], rows: FACTS[matchId] ? [[...FACTS[matchId]]] : [] };
  if (/FROM player_stats/.test(sql)) return { columns: [], rows: [] };
  if (/FROM teams/.test(sql)) return { columns: [], rows: [] };
  return { err: 'the fixture does not answer: ' + sql };
}

const reads = {
  listMetrics: async () => [],
  getMetricValuesForMatch: async () => [],
  getMetricValuesForPlayer: async () => [],
  getMetricComputeState: async () => [],
  componentQuery: async (sql) => answer(sql),
};

// The match services the facts panel reads (the bindings stub answers them).
const MATCH_ROWS = {
  7: { id: 7, copyState: 'copied', size: 1048576 },
  8: { id: 8, copyState: 'external', size: 0 },
};
const VOICE = { 7: { hasVoice: true, playerCount: 3, keyFound: true }, 8: { hasVoice: false, playerCount: 0, keyFound: false } };
const evicted = [];
bindings.handlers.GetMatch = (id) => (MATCH_ROWS[id] ? { ...MATCH_ROWS[id] } : null);
bindings.handlers.GetVoicePresence = (id) => (VOICE[id] ? { ...VOICE[id] } : null);
bindings.handlers.EvictDemoCopy = (id) => {
  evicted.push(id);
  MATCH_ROWS[id] = { ...MATCH_ROWS[id], copyState: 'missing', size: 0 };
  return 1048576;
};

// --- helpers ----------------------------------------------------------------------------
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
const unmountAll = () => {
  if (instance) unmount(instance);
  instance = null;
  if (target) target.remove();
  target = null;
};
// Mount the tab set with a context and the placement props (tab, when given).
const mountTabs = async ({ context, props = {} }) => {
  unmountAll();
  navCalls = [];
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(Harness, {
    target,
    props: { context, props, reads, nav: (h) => navCalls.push(h) },
  });
  await settle(60);
  return target;
};

const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const tabTexts = (root) => [...root.querySelectorAll('nav.tabs button.tab')].map((b) => text(b));
const rowsOf = (root) => [...root.querySelectorAll('tbody tr')];
const M7 = { matchId: 7, steamId: null, round: null };

// The view state is process-scoped: each section starts from a clean registry.
vs.resetViewState();

// --- (a) the tab bar from the context alone -------------------------------------------------
console.log('A. the tab bar renders every tab from the context alone');
let root = await mountTabs({ context: M7 });
check('the tab bar lists every Match tab, in route order', JSON.stringify(tabTexts(root)) === JSON.stringify([...router.MATCH_TABS]),
  JSON.stringify(tabTexts(root)));
check('with no tab given, the Overview tab is the active one',
  root.querySelector('nav.tabs button.tab.active') && text(root.querySelector('nav.tabs button.tab.active')) === 'Overview');

// --- (b) the Rounds and Details tabs render from the context --------------------------------
console.log('B. the Rounds and Details tabs render their panels from the context');
root = await mountTabs({ context: M7, props: { tab: 'Rounds' } });
check('the Rounds tab shows the rounds of its match (14 rows)', rowsOf(root).length === 14, String(rowsOf(root).length));
check('the active tab is Rounds', text(root.querySelector('nav.tabs button.tab.active')) === 'Rounds');

// --- (c) the compare picks survive a tab switch, and are kept per match -------------------------
console.log('C. compare picks survive a tab switch and are keyed by match');
const ticks = (r, idxs) => {
  for (const i of idxs) {
    const box = r.querySelectorAll('input.cmp-cb')[i];
    box.checked = true;
    change(box);
  }
};
root = await mountTabs({ context: M7, props: { tab: 'Rounds' } });
ticks(root, [0, 1]);
await settle(4);
check('two ticks in match 7 are kept for match 7', JSON.stringify(vs.seed(vs.matchKey('selection', 7), { compareSel: [] }).compareSel) === '[1,2]');
// A tab switch: the Rounds panel leaves and comes back.
root = await mountTabs({ context: M7, props: { tab: 'Overview' } });
root = await mountTabs({ context: M7, props: { tab: 'Rounds' } });
let boxes = [...root.querySelectorAll('input.cmp-cb')];
check('after a tab switch, the picks still show as checked', boxes[0].checked === true && boxes[1].checked === true && boxes[2].checked === false);
check('the compare button still offers the two picks', text(root.querySelector('.cmp-float')) === 'Compare 2 rounds', text(root.querySelector('.cmp-float')));
// Another match on the same tab set reads its own picks, not match 7's.
root = await mountTabs({ context: { matchId: 9, steamId: null, round: null }, props: { tab: 'Rounds' } });
boxes = [...root.querySelectorAll('input.cmp-cb')];
check('match 9 shows no picks from match 7', boxes.length === 15 && boxes.every((b) => !b.checked), String(boxes.filter((b) => b.checked).length));
check('match 7 keeps its own picks after match 9 is seen',
  JSON.stringify(vs.seed(vs.matchKey('selection', 7), { compareSel: [] }).compareSel) === '[1,2]');

// --- (d) the Details facts ----------------------------------------------------------------------------
console.log('D. details: stored facts, voice and demo copy (matches 7 and 8)');
root = await mountTabs({ context: M7, props: { tab: 'Details' } });
const facts = [...root.querySelectorAll('dl.facts > div')].map((d) => [text(d.querySelector('dt')), text(d.querySelector('dd'))]);
check('the stored facts render as before (server, tickrate, size, parser, warnings, source)',
  facts.length === 10 && facts[0][1] === 'Test Server' && facts[1][1] === '64.0 Hz' && facts[3][1] === '173.4 MB' && facts[6][1] === '2' && facts[7][1] === '/demos/de_mirage.dem.zst',
  JSON.stringify(facts));
const voiceRow = facts.find((f) => f[0] === S.match.factVoice);
check('voice: a recorded match names its players', !!voiceRow && voiceRow[1] === S.fill(S.match.voiceRecordedBadge, { n: 3 }), JSON.stringify(voiceRow));
const copyRow = root.querySelectorAll('dl.facts')[1].lastElementChild;
check('demo copy: a copied demo shows its size and the Free copy button',
  text(copyRow.querySelector('dd span')) === `${S.match.copyPrefix} 1.0 MB` && text(copyRow.querySelector('dd button')) === S.match.freeCopy,
  text(copyRow));
const freeBtn = copyRow.querySelector('dd button');
click(freeBtn);
await settle(8);
check('Free copy frees match 7’s copy through the service', evicted.length === 1 && evicted[0] === 7, JSON.stringify(evicted));
const copyAfter = root.querySelectorAll('dl.facts')[1].lastElementChild.querySelector('dd');
check('after Free copy the state line re-derives: the demo is missing', text(copyAfter) === S.match.copyMissing, text(copyAfter));

root = await mountTabs({ context: { matchId: 8, steamId: null, round: null }, props: { tab: 'Details' } });
const voice8 = [...root.querySelectorAll('dl.facts > div')].find((d) => text(d.querySelector('dt')) === S.match.factVoice);
check('an unvoiced match shows the no-voice badge', text(voice8.querySelector('dd')) === S.match.voiceNoneBadge, text(voice8.querySelector('dd')));
const copy8 = root.querySelectorAll('dl.facts')[1].lastElementChild.querySelector('dd');
check('an external demo shows its external line, with no Free copy button',
  text(copy8) === S.match.copyExternal && !copy8.querySelector('button'), text(copy8));
const nullFacts8 = [...root.querySelectorAll('dl.facts > div')].map((d) => text(d.querySelector('dd')));
check('a match with NULL stored facts shows dashes and a stored zero', nullFacts8[0] === '—' && nullFacts8[6] === '0', JSON.stringify(nullFacts8));

unmountAll();
console.log(failures === 0 && escaped.length === 0 ? 'ALL PASS' : `FAILURES: ${failures}, escaped: ${escaped.length}`);
process.exit(0);
