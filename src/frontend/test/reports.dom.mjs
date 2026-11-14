// jsdom driver for the Reports metrics appendix (stored-metrics design
// §5's Reports surface).
//   A. the checkbox list is FLAT and match-scope only — the groupBy
//      grouping died with the W2 grammar wave (no "by …" group headers,
//      no profile-scope rows: those surface on PlayerProfile);
//   B. checking a metric reads the STORED rows through the canonical
//      read (one call carrying the whole checked set + the roster label
//      read) — PreviewMetric is NEVER called for a saved definition;
//   C. the generated document (the export surface) carries the design
//      copy "per player · N rows · match #id" and the displayed rows —
//      never "group by …", never a `· N ms` timing line, never a stamp;
//   D. a non-fresh metric renders its STATE chip in the list and an
//      honest "value not computed — <state>" line in the document (no
//      table, no fabricated number);
//   E. the live feed flips a checked metric to processing and
//      metric-done refetches the stored rows (the cache flushed);
//   F. the no-version pin over every rendered metric output.
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
  .replace("from './Popover.svelte'", "from './popover.js'");
svelteCompile(matchPickerSrc, 'MatchPicker.svelte', join(dir, 'matchpicker.js'));
const playerPickerSrc = readFileSync('src/lib/components/PlayerPicker.svelte', 'utf8')
  .replace("from '../fmt.js'", `from '${fileURL('src/lib/fmt.js')}'`);
svelteCompile(playerPickerSrc, 'PlayerPicker.svelte', join(dir, 'playerpicker.js'));

// The view: plain-ESM imports resolve from their real module locations
// (services → the stubs, metricstate/players/viewstate absolute), the
// .svelte imports point at the local bundles.
const repSrc = readFileSync('src/lib/views/Reports.svelte', 'utf8')
  .replace("from '../services.js'", `from '${fileURL('src/lib/services.js')}'`)
  .replace("from '../metricstate.js'", `from '${fileURL('src/lib/metricstate.js')}'`)
  .replace("from '../players.js'", `from '${fileURL('src/lib/players.js')}'`)
  .replace("from '../viewstate.svelte.js'", `from '${fileURL('src/lib/viewstate.svelte.js')}'`)
  .replace("from '../components/MatchPicker.svelte'", "from './matchpicker.js'")
  .replace("from '../components/PlayerPicker.svelte'", "from './playerpicker.js'")
  .replace("from '../components/StatusChip.svelte'", "from './statuschip.js'");
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

console.log('A. the checkbox list is flat and match-scope only');
{
  const boxes = [...r.querySelectorAll('.rep-metric')];
  check(
    'exactly the match-scope metrics list (a profile-scope metric never does)',
    boxes.length === 2 &&
      boxes[0].textContent.includes('Match stat') &&
      boxes[1].textContent.includes('Behind stat') &&
      !r.textContent.includes('Career stat'),
    JSON.stringify(boxes.map((b) => b.textContent.replace(/\s+/g, ' ').trim())),
  );
  check(
    'no groupBy grouping survives — no "by …" headers, no group wrappers',
    !r.querySelector('.rep-mgroup') && !r.querySelector('.rep-sub') &&
      !/by ungrouped/.test(r.textContent),
    r.textContent.replace(/\s+/g, ' ').slice(0, 300),
  );
}

console.log('B. checking reads the STORED rows (one call) — never PreviewMetric');
{
  const previewBefore = bindings.callCount('PreviewMetric');
  storedCalls.length = 0;
  const box = r.querySelector('.rep-metric input[type="checkbox"]');
  box.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await sleep(120);
  check(
    'the canonical read carried the checked id for this match',
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
  const chip = r.querySelector('.rep-metric .chip.status');
  const rowsChip = [...r.querySelectorAll('.rep-metric .chip')].find((c) =>
    /rows$/.test(c.textContent.trim()),
  );
  check(
    'the checked metric shows its honest row count (fresh)',
    !chip && !!rowsChip && rowsChip.textContent.trim() === '1 rows',
    r.querySelector('.rep-metric')?.textContent.replace(/\s+/g, ' '),
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

console.log('D. a non-fresh metric renders its STATE — chip in the list, honest line in the document');
{
  const boxes = [...r.querySelectorAll('.rep-metric')];
  const behindBox = boxes.find((b) => b.textContent.includes('Behind stat'));
  behindBox.querySelector('input[type="checkbox"]').dispatchEvent(
    new dom.window.MouseEvent('click', { bubbles: true }),
  );
  await sleep(120);
  const chip = behindBox.querySelector('.chip.status');
  check(
    'the behind metric shows the idle chip, never a row count',
    !!chip && chip.classList.contains('idle') && chip.textContent.trim() === 'behind',
    behindBox.textContent.replace(/\s+/g, ' '),
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
  const boxes = [...r.querySelectorAll('.rep-metric')];
  const box = boxes.find((b) => b.textContent.includes('Match stat'));
  fire('spectra:metric-progress', { metricId: 1, stage: 'compute', done: 2, total: 5 });
  await sleep(60);
  const chip = box.querySelector('.chip.status');
  check(
    'metric-progress flips the checked metric to the busy chip with its k/N bar',
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

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
if (inst) await unmount(inst);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
