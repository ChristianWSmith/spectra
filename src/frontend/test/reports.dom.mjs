// jsdom driver for the Reports metrics appendix (stored-metrics design
// §5's Reports surface — the appendix METRIC PICKER: N searchable
// single-select rows with + / − row buttons).
//   A. the metric list behind the picker rows is FLAT and match-scope
//      only — the groupBy grouping died with the W2 grammar wave (no
//      "by …" group headers, no profile-scope rows: those surface on
//      PlayerProfile);
//   B. picking a stat (through SuggestInput's suggestion) reads the
//      STORED rows through the canonical read (one call carrying the
//      whole picked set + the roster label read) — PreviewMetric is
//      NEVER called for a saved definition;
//   C. the generated document (the export surface) carries the design
//      copy "per player · N rows · match #id" and the displayed rows —
//      never "group by …", never a `· N ms` timing line, never a stamp;
//   D. + adds a row that offers only the stats no other row holds (no
//      duplicate can form), and a non-fresh stat renders its STATE chip
//      in its row and an honest "value not computed — <state>" line in
//      the document (no table, no fabricated number);
//   E. the live feed flips a picked stat to processing and metric-done
//      refetches the stored rows (the cache flushed);
//   F. the no-version pin over every rendered metric output;
//   G. the picker follows the match ORDER pref (dogfooding design §1)
//      AND the exported document's sections follow the same sequence
//      (the W4 addendum — design §2.5): absent key ⇒ the default
//      sequence (= catalog order, pinned in A), a saved order
//      re-sequences the suggestions and the generated document, and a
//      deleted key (reset) returns both to the default — the pins array
//      never orders this list; the − button removes rows, and NO rows
//      means no appendix (only the add button stays);
//   H. the player picker's K/D/A triple composes per half (inferred
//      conversion design §3.1/Q2): K and D are the raw scoreboard
//      fields, the A half is the match-scope `assists` METRIC row
//      Reports fetches beside sbBySteam — its stored value renders
//      (never the raw `assists` column), and with no fresh row the
//      half is the honest dash (`20/5/—`), never a fabricated number.
//
// services.js runs against the shared TEST STUBS (no live Wails
// backend), 'svelte' is pinned to the CLIENT entry so plain `node --test`
// mounts for real — the builder.dom.mjs harness shape.
// jsdom is a declared devDependency of frontend/ — a plain `npm ci`
// there provides it (never `npm i --no-save`). From frontend/ run:
//   node --test test/reports.dom.mjs
// (must be run with frontend/ as the working directory)
import { JSDOM } from 'jsdom';
import { compile } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { installEsmDirHook } from './esm-dir-hook.mjs';

installEsmDirHook();

const stub = (name) => pathToFileURL(join('test', 'stubs', name)).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'svelte') {
      return { url: pathToFileURL('node_modules/svelte/src/index-client.js').href, shortCircuit: true };
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
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement',
  'HTMLButtonElement', 'HTMLMediaElement', 'HTMLVideoElement', 'HTMLAnchorElement',
  'SVGElement', 'Element', 'Node', 'Text', 'Comment', 'DocumentFragment',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'MutationObserver',
  'DOMParser', 'localStorage',
]) {
  if (!(k in dom.window)) continue;
  try {
    globalThis[k] = dom.window[k];
  } catch {
    Object.defineProperty(globalThis, k, {
      value: dom.window[k],
      configurable: true,
      writable: true,
    });
  }
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;

const errors = [];
process.on('uncaughtException', (e) => {
  errors.push(e);
  console.error('UNCAUGHT: ' + (e && e.stack ? e.stack : e));
});
process.on('unhandledRejection', (e) => {
  errors.push(e);
  console.error('REJECTION: ' + (e && e.stack ? e.stack : e));
});

const bindings = await import('./stubs/bindings.mjs');
const services = await import(pathToFileURL('src/lib/services.js').href);
const { fire } = await import(pathToFileURL(join('test', 'stubs', 'wails-runtime.mjs')).href);

const fileURL = (p) => pathToFileURL(p).href;
const svelteCompile = (src, filename, out) => {
  const code = compile(src, { filename, generate: 'client' }).js.code;
  writeFileSync(out, code);
  return out;
};

const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'reports');
mkdirSync(dir, { recursive: true });

// Leaf components (StatusChip, Popover) → local bundles; the pickers
// import fmt + those leaves, so their specifiers are rebased too.
for (const name of ['StatusChip', 'Popover']) {
  svelteCompile(
    readFileSync(`src/lib/components/${name}.svelte`, 'utf8'),
    `${name}.svelte`,
    join(dir, `${name.toLowerCase()}.js`),
  );
}
const matchPickerSrc = readFileSync('src/lib/components/MatchPicker.svelte', 'utf8')
  .replace("from '../fmt.js'", `from '${fileURL('src/lib/fmt.js')}'`)
  .replace("from './StatusChip.svelte'", "from './statuschip.js'")
  .replace("from './Popover.svelte'", "from './popover.js'")
  // plumbing (Strings Stage 3): the picker imports the strings catalog.
  .replace("from '../strings/index.js'", `from '${fileURL('src/lib/strings/index.js')}'`);
svelteCompile(matchPickerSrc, 'MatchPicker.svelte', join(dir, 'matchpicker.js'));
const playerPickerSrc = readFileSync('src/lib/components/PlayerPicker.svelte', 'utf8')
  .replace("from '../fmt.js'", `from '${fileURL('src/lib/fmt.js')}'`)
  .replace("from '../services.js'", `from '${fileURL('src/lib/services.js')}'`)
  // plumbing (Strings Stage 3): the picker imports the strings catalog.
  .replace("from '../strings/index.js'", `from '${fileURL('src/lib/strings/index.js')}'`);
svelteCompile(playerPickerSrc, 'PlayerPicker.svelte', join(dir, 'playerpicker.js'));
// The appendix picker's suggestion box (kind="text" over the metric
// catalog) — Popover leaf + fmt/services/strings imports rebased like
// every other component this driver mounts.
const suggestInputSrc = readFileSync('src/lib/components/SuggestInput.svelte', 'utf8')
  .replace("from './Popover.svelte'", "from './popover.js'")
  .replace("from '../fmt.js'", `from '${fileURL('src/lib/fmt.js')}'`)
  .replace("from '../services.js'", `from '${fileURL('src/lib/services.js')}'`)
  // plumbing (Strings Stage 3): the widget imports the strings catalog.
  .replace("from '../strings/index.js'", `from '${fileURL('src/lib/strings/index.js')}'`);
svelteCompile(suggestInputSrc, 'SuggestInput.svelte', join(dir, 'suggestinput.js'));

// The view: plain-ESM imports resolve from their real module locations
// (services → the stubs, metricstate/players/viewstate absolute), the
// .svelte imports point at the local bundles.
const repSrc = readFileSync('src/lib/views/Reports.svelte', 'utf8')
  .replace("from '../services.js'", `from '${fileURL('src/lib/services.js')}'`)
  .replace("from '../metricorder.js'", `from '${fileURL('src/lib/metricorder.js')}'`)
  .replace("from '../metricstate.js'", `from '${fileURL('src/lib/metricstate.js')}'`)
  .replace("from '../players.js'", `from '${fileURL('src/lib/players.js')}'`)
  .replace("from '../viewstate.svelte.js'", `from '${fileURL('src/lib/viewstate.svelte.js')}'`)
  .replace("from '../components/MatchPicker.svelte'", "from './matchpicker.js'")
  .replace("from '../components/PlayerPicker.svelte'", "from './playerpicker.js'")
  .replace("from '../components/SuggestInput.svelte'", "from './suggestinput.js'")
  .replace("from '../components/StatusChip.svelte'", "from './statuschip.js'")
  // plumbing (Strings Stage 3): the view imports the strings catalog —
  // resolve it from the real tree, like every other ../ module above.
  .replace("from '../strings/index.js'", `from '${fileURL('src/lib/strings/index.js')}'`);
svelteCompile(repSrc, 'Reports.svelte', join(dir, 'reports-bundle.js'));

const { mount, unmount } = await import('svelte');
const mod = await import(pathToFileURL(join(dir, 'reports-bundle.js')).href);
// The registry the view imports (same URL → same instance).
const viewstate = await import(pathToFileURL('src/lib/viewstate.svelte.js').href);

const sleep = (ms = 40) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}

// --- The appendix metric picker ---------------------------------------------
// One row per stat: a SuggestInput single-select (focus opens its
// suggestion panel) with its remove button beside it, the add-row button
// underneath. The pick lives in the input's VALUE — an input's value
// never lands in textContent, so rows are found by value, never by the
// text they contain.
const pickRows = (root) => [...root.querySelectorAll('.rep-metric')];
const rowValue = (row) => row.querySelector('input[type="search"]')?.value || '';
const rowByValue = (root, title) => pickRows(root).find((row) => rowValue(row) === title);
const addBtn = (root) => root.querySelector('.rep-add');
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
// Focus opens the suggestion panel (SuggestInput's onfocus → open), so
// the options are readable once the panel paints; they come back scoped
// to THIS row (the widget's panel renders inside it).
const openRow = async (row) => {
  row.querySelector('input[type="search"]').dispatchEvent(
    new dom.window.FocusEvent('focus', { bubbles: false }),
  );
  await sleep(60);
  return [...row.querySelectorAll('.sg-opt')];
};

// --- The scripted backend ---------------------------------------------------
// One match-scope metric (checked → stored rows) and one profile-scope
// metric (must never appear in this per-match appendix).
const MATCH_METRIC = {
  id: 1, name: 'match_stat', title: 'Match stat', scope: 'match',
  format: '', doc: 'Formula: count()', origin: 'user', expr: 'from events: count()',
  shortName: '', denominator: '', pluginId: '',
};
const PROFILE_METRIC = {
  id: 2, name: 'career_stat', title: 'Career stat', scope: 'profile',
  format: '', doc: 'Formula: avg', origin: 'user', expr: 'from events: count()',
  shortName: '', denominator: '', pluginId: '',
};
const BEHIND_METRIC = {
  id: 3, name: 'behind_stat', title: 'Behind stat', scope: 'match',
  format: '', doc: 'Formula: sum', origin: 'user', expr: 'from events: sum(dmg)',
  shortName: '', denominator: '', pluginId: '',
};

bindings.handlers.ListReportTemplates = () => [
  { id: 't1', title: 'Match summary', scope: 'match', format: 'md', origin: 'builtin' },
];
bindings.handlers.ListMatches = () => [
  { id: 13, status: 'ready', map: 'de_cache', scoreCT: 13, scoreT: 9 },
];
bindings.handlers.ListPlayers = () => [];
bindings.handlers.GetRounds = () => [];
bindings.handlers.ListMetrics = () => [MATCH_METRIC, PROFILE_METRIC, BEHIND_METRIC];
bindings.handlers.GetPlayerRefs = () => [
  { steamId: '76561198000000001', name: 'amy', side: 'ct', isBot: false },
];
bindings.handlers.RenderReport = () => 'REPORT BODY';
bindings.handlers.GetMetricComputeState = () => [
  { metricId: 1, state: 'fresh' },
  { metricId: 2, state: 'fresh' },
  { metricId: 3, state: 'behind' },
];

// The canonical stored-value read — recorded so the checks can pin the
// args (design §5: no per-toggle query-time run, no PreviewMetric).
const storedCalls = [];
bindings.handlers.GetMetricValuesForMatch = (matchID, metricIDs) => {
  storedCalls.push([matchID, metricIDs]);
  const out = [];
  for (const id of metricIDs || []) {
    if (id === 1) {
      out.push({ metricId: 1, steamId: '76561198000000001', value: 4.25, n: 7 });
    }
    // id 3 (behind) deliberately has NO stored row.
  }
  return out;
};

let root = null;
let inst = null;
async function mountReports() {
  if (inst) {
    await unmount(inst);
    inst = null;
    root.remove();
  }
  root = document.createElement('div');
  document.body.appendChild(root);
  inst = mount(mod.default, { target: root, props: { nav: () => {} } });
  await sleep(120); // mount + the template/match/metrics reads
  return root;
}

viewstate.resetViewState();
const r = await mountReports();

console.log('A. the metric list behind the picker rows is flat and match-scope only');
{
  const opts = await openRow(pickRows(r)[0]);
  const labels = opts.map((o) => o.textContent.trim());
  check(
    'exactly the match-scope metrics offer themselves (a profile-scope metric never does)',
    JSON.stringify(labels) === JSON.stringify(['Match stat', 'Behind stat']) &&
      !r.textContent.includes('Career stat'),
    JSON.stringify(labels),
  );
  check(
    'no groupBy grouping survives — no "by …" headers, no group wrappers',
    !r.querySelector('.rep-mgroup') && !r.querySelector('.rep-sub') &&
      !/by ungrouped/.test(r.textContent),
    r.textContent.replace(/\s+/g, ' ').slice(0, 300),
  );
}

console.log('B. picking a stat reads the STORED rows (one call) — never PreviewMetric');
{
  const previewBefore = bindings.callCount('PreviewMetric');
  storedCalls.length = 0;
  const row = pickRows(r)[0];
  const opts = await openRow(row);
  click(opts.find((o) => o.textContent.includes('Match stat')));
  await sleep(120);
  check(
    'the canonical read carried the picked id for this match',
    JSON.stringify(storedCalls[0]) === JSON.stringify([13, [1]]),
    JSON.stringify(storedCalls),
  );
  check(
    'PreviewMetric was never called (a saved definition reads stored)',
    bindings.callCount('PreviewMetric') === previewBefore,
    String(bindings.callCount('PreviewMetric')),
  );
  check(
    'the roster label read rode along for the appendix labels',
    bindings.callCount('GetPlayerRefs') >= 1,
    String(bindings.callCount('GetPlayerRefs')),
  );
  const chip = row.querySelector('.chip.status');
  const rowsChip = [...row.querySelectorAll('.chip')].find((c) =>
    /rows$/.test(c.textContent.trim()),
  );
  check(
    'the picked stat shows its honest row count (fresh), named in the field',
    !chip && !!rowsChip && rowsChip.textContent.trim() === '1 rows' &&
      rowValue(row) === 'Match stat',
    rowValue(row) + ' | ' + row.textContent.replace(/\s+/g, ' '),
  );
}

console.log('C. the generated document carries the design copy — no groupBy, no timing, no stamp');
{
  const gen = [...r.querySelectorAll('button')].find((b) =>
    b.textContent.includes('Generate report'),
  );
  gen.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await sleep(120);
  const doc = r.querySelector('.rep-md')?.textContent || '';
  check('the report body renders with the appendix', doc.includes('REPORT BODY'), doc.slice(0, 120));
  check(
    'the appendix line is the design §5 copy ("per player · N rows · match #id")',
    doc.includes('per player · 1 rows · match #13'),
    doc.replace(/\s+/g, ' ').slice(0, 400),
  );
  check(
    'no "group by …" copy and no "· ms" timing line survives',
    !doc.includes('group by') && !/\d+\s*ms/.test(doc),
    doc.replace(/\s+/g, ' ').slice(0, 400),
  );
  check(
    'the displayed rows carry the roster label, the value and n',
    doc.includes('| 76561198000000001 | amy | 4.25 | 7 |'),
    doc.replace(/\s+/g, ' ').slice(0, 400),
  );
}

console.log('D. + adds a row offering only the free stats; a non-fresh stat renders its STATE — chip in its row, honest line in the document');
{
  click(addBtn(r));
  await sleep(60);
  const rows2 = pickRows(r);
  const opts = await openRow(rows2[rows2.length - 1]);
  const labels = opts.map((o) => o.textContent.trim());
  check(
    'the new row offers only the stats no other row already holds (no duplicate can form)',
    JSON.stringify(labels) === JSON.stringify(['Behind stat']),
    JSON.stringify(labels),
  );
  click(opts.find((o) => o.textContent.includes('Behind stat')));
  await sleep(120);
  const row = rowByValue(r, 'Behind stat');
  const chip = row && row.querySelector('.chip.status');
  check(
    'the behind stat shows the idle chip, never a row count',
    !!chip && chip.classList.contains('idle') && chip.textContent.trim() === 'behind',
    row ? row.textContent.replace(/\s+/g, ' ') : 'no Behind stat row',
  );
  const gen = [...r.querySelectorAll('button')].find((b) =>
    b.textContent.includes('Generate report'),
  );
  gen.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await sleep(120);
  const doc = r.querySelector('.rep-md')?.textContent || '';
  check(
    'the document carries "value not computed — behind" and no table for it',
    doc.includes('value not computed — behind') &&
      !doc.includes('Behind stat\n\n|'),
    doc.replace(/\s+/g, ' ').slice(0, 500),
  );
}

console.log('E. the live feed flips to processing; metric-done refetches the stored rows');
{
  const box = rowByValue(r, 'Match stat');
  fire('spectra:metric-progress', { metricId: 1, stage: 'compute', done: 2, total: 5 });
  await sleep(60);
  const chip = box.querySelector('.chip.status');
  check(
    'metric-progress flips the picked stat to the busy chip with its k/N bar',
    !!chip && chip.classList.contains('busy') && chip.textContent.includes('processing') &&
      !!chip.querySelector('.chip-bar'),
    box.textContent.replace(/\s+/g, ' '),
  );
  const before = storedCalls.length;
  fire('spectra:metric-done', { ok: true, error: '', metricIds: [1] });
  await sleep(120);
  check(
    'metric-done refetches the stored rows (the cache flushed + the reload)',
    storedCalls.length > before && !box.querySelector('.chip.status.busy'),
    `calls ${before} -> ${storedCalls.length}`,
  );
}

console.log('F. no version number or timestamp in any rendered metric output');
{
  const leakRe = /version|\bv\d+\b|\d{4}-\d{2}-\d{2}|rule stamp|computed at/i;
  const leaks = [];
  for (const el of r.querySelectorAll('.rep-metric .chip, .rep-metric [title], .rep-md')) {
    const tip = el.getAttribute('title') || '';
    if (leakRe.test(tip)) leaks.push(`title: ${tip}`);
    if (leakRe.test(el.textContent || '')) leaks.push(`text: ${el.textContent.trim().slice(0, 80)}`);
  }
  check('no version number or timestamp appears anywhere in the appendix output', leaks.length === 0, leaks.join(' | '));
}

console.log('G. the picker follows the match ORDER pref (metricorder — the one sequence), and − removes rows');
{
  // Absent pref ⇒ the default sequence, which over this unranks catalog
  // equals catalog order (already pinned by A's default options).
  bindings.handlers.GetPref = (key) =>
    key === 'metric_order_match' ? ['behind_stat', 'match_stat'] : undefined;
  const r2 = await mountReports();
  // The selection persists in the view registry (B/D wrote the rows), so
  // this mount restores BOTH picks — the preview carries the appendix
  // suffix before anything is removed.
  const previewLine = () => {
    const h2 = [...r2.querySelectorAll('h2')].find((h) => h.textContent.includes('Preview'));
    return (h2 && h2.parentElement.querySelector('p.muted')?.textContent) || '';
  };
  const hadAppendix = previewLine().includes('+ appendix');
  // The − button removes each row (element refs: the survivors re-index
  // between clicks), and NO rows means NO appendix — the add button is
  // all that stays, so the picker remains reachable.
  for (const row of [...pickRows(r2)]) {
    click(row.querySelector('.rep-drop'));
    await sleep(60);
  }
  check(
    'the − button removes every row — no rows means no appendix, only the add button left',
    pickRows(r2).length === 0 &&
      !!addBtn(r2) &&
      hadAppendix &&
      !previewLine().includes('+ appendix'),
    JSON.stringify({ hadAppendix, rows: pickRows(r2).length }),
  );

  // A fresh (empty) row offers the WHOLE list, in sequence order.
  click(addBtn(r2));
  await sleep(60);
  const opts = await openRow(pickRows(r2)[0]);
  const labels = opts.map((o) => o.textContent.trim());
  check(
    'a saved order re-sequences the metric list (behind_stat first)',
    JSON.stringify(labels) === JSON.stringify(['Behind stat', 'Match stat']),
    JSON.stringify(labels),
  );
  // The EXPORTED document follows the SAME sequence (design §2.5's
  // intent — the W4 addendum): appendixEntries() sorts by the match
  // sequence instead of the selection's id-ASC build order, so the
  // generated document's sections re-order with the pref too. Pick both
  // stats (the second row only offers what the first doesn't hold) and
  // generate while THIS mount is live — mounting the next root unmounts
  // and detaches this one.
  const generate = async (root) => {
    const gen = [...root.querySelectorAll('button')].find((b) =>
      b.textContent.includes('Generate report'),
    );
    click(gen);
    await sleep(120);
    return root.querySelector('.rep-md')?.textContent || '';
  };
  const sectionOrder = (text) => [text.indexOf('### Match stat'), text.indexOf('### Behind stat')];
  click(opts.find((o) => o.textContent.includes('Behind stat')));
  await sleep(60);
  click(addBtn(r2));
  await sleep(60);
  const opts2 = await openRow(pickRows(r2)[1]);
  click(opts2.find((o) => o.textContent.includes('Match stat')));
  await sleep(60);
  const doc2 = await generate(r2);
  {
    const [m, b] = sectionOrder(doc2);
    check(
      'the exported document orders its sections by the match sequence (behind_stat first)',
      m > -1 && b > -1 && b < m,
      doc2.replace(/\s+/g, ' ').slice(0, 300),
    );
  }

  // Reset deletes the key (metricorder.resetOrder → kvstore Delete) —
  // here: the key simply stops resolving, and the default returns.
  delete bindings.handlers.GetPref;
  const r3 = await mountReports();
  for (const row of [...pickRows(r3)]) {
    click(row.querySelector('.rep-drop'));
    await sleep(60);
  }
  click(addBtn(r3));
  await sleep(60);
  const opts3 = await openRow(pickRows(r3)[0]);
  const labels3 = opts3.map((o) => o.textContent.trim());
  check(
    'key gone → the default sequence again (catalog order)',
    JSON.stringify(labels3) === JSON.stringify(['Match stat', 'Behind stat']),
    JSON.stringify(labels3),
  );
  click(opts3.find((o) => o.textContent.includes('Match stat')));
  await sleep(60);
  click(addBtn(r3));
  await sleep(60);
  const opts4 = await openRow(pickRows(r3)[1]);
  click(opts4.find((o) => o.textContent.includes('Behind stat')));
  await sleep(60);
  const doc3 = await generate(r3);
  {
    const [m, b] = sectionOrder(doc3);
    check(
      'key gone → the document returns to the default section order (match_stat first)',
      m > -1 && b > -1 && m < b,
      doc3.replace(/\s+/g, ' ').slice(0, 300),
    );
  }
}

console.log('H. the player picker triple composes per half — raw K/D + the assists metric half (absent → —)');
{
  // Re-script the backend for a PLAYER-scoped target: one roster player,
  // one scoreboard row whose raw `assists` column is 9 (it must NEVER
  // render), and the seeded match-scope `assists` definition. The picker
  // reads the metric row Reports fetches beside sbBySteam — value 7
  // renders in the A half; with no fresh row the half is the dash.
  const ASSISTS_METRIC = {
    id: 4, name: 'assists', title: 'Assists', scope: 'match',
    format: 'int', doc: 'Formula: sum(player_stats.assists)', origin: 'builtin',
    expr: 'from player_stats: sum(assists)', shortName: 'A', denominator: '', pluginId: '',
  };
  bindings.handlers.ListReportTemplates = () => [
    { id: 't2', title: 'Player summary', scope: 'player', format: 'md', origin: 'builtin' },
  ];
  bindings.handlers.ListPlayers = () => [
    { steamId: '76561198000000001', name: 'amy', matches: 3, lastSeen: '2026-11-01' },
  ];
  bindings.handlers.GetScoreboard = () => [
    {
      steamId: '76561198000000001', name: 'amy', side: 'ct', isBot: false,
      kills: 20, deaths: 5, assists: 9, adr: 70.5, roundsPlayed: 24,
    },
  ];
  bindings.handlers.ListMetrics = () => [ASSISTS_METRIC];
  bindings.handlers.GetMetricComputeState = () => [{ metricId: 4, state: 'fresh' }];
  let assistsRow = { value: 7, n: 24 };
  bindings.handlers.GetMetricValuesForMatch = (matchID, metricIDs) =>
    assistsRow && (metricIDs || []).includes(4)
      ? [{ metricId: 4, steamId: '76561198000000001', value: assistsRow.value, n: assistsRow.n }]
      : [];
  // The read-through cache holds the previous handlers' answers — flush
  // it so this section's re-scripted reads are the ones the view gets.
  services.invalidate();
  viewstate.resetViewState();

  const openTriple = async (root) => {
    const trigger = root.querySelector('#rep-player');
    if (!trigger) return null;
    trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await sleep(60);
    return root.querySelector('.pp-opt [title="K / D / A in this match"]');
  };

  const r4 = await mountReports();
  const kda = await openTriple(r4);
  check(
    'the triple renders raw K/D with the assists METRIC half (the stored column never renders)',
    !!kda && kda.textContent === '20/5/7',
    kda ? kda.textContent : 'no triple cell',
  );

  // No fresh row for this match (absent or behind alike — the canonical
  // read serves fresh rows only): the A half dashes, K/D keep stored.
  assistsRow = null;
  services.invalidate();
  const r5 = await mountReports();
  const kda2 = await openTriple(r5);
  check(
    'an absent assists row renders 20/5/— — never the stored 9, never a 0',
    !!kda2 && kda2.textContent === '20/5/—',
    kda2 ? kda2.textContent : 'no triple cell',
  );
}

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
if (inst) await unmount(inst);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
