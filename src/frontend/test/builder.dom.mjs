// jsdom driver for the metrics Builder's list UX (owner wave: list
// filter toggles + built-in immutability + the W4 state surface).
// Section labels below match the run's console.log letters:
//   A. the Built-in / My metrics source toggles — defaults built-in OFF,
//      My metrics ON — and the SERVER-side origin partition they drive:
//      the scripted backend below applies store.ListMetricsPage's exact
//      predicate to the fixture, so a view that filtered client-side,
//      passed the wrong partition word, or forgot the arg would render
//      the wrong rows here;
//   B. a toggle restarts the keyset window at cursor 0 — the same path
//      as a search change (one debounced effect reads query +
//      originFilter) — and the group headers follow the partition;
//   C. built-in only → both toggles off (a legal empty read) → back;
//   D. built-in immutability in the UI: a builtin row renders NO edit
//      control (its main area is plain content — a div, never a button)
//      and NO delete control, while a user row renders both; pin and
//      preview stay live on the builtin row;
//   E. a SAVED (unmodified) preview reads the canonical stored-value
//      read for the newest ready match + the no-execution compile as
//      provenance, shows the STATE indicator instead of a timing chip,
//      and never loads the form (design §5's saved-form criterion —
//      PreviewMetric stays the on-demand calculator for dirty drafts);
//   F. a user row still loads the form for editing (unaffected);
//   G. the search composes with the filter in ONE server call;
//   H. the toggles are view-local registry state (viewstate.svelte.js):
//      they restore across unmount → remount, and resetViewState()
//      returns the next mount to the defaults;
//   I. the compute-state surface (design §4/§5): every list item and
//      the editor card wear its state chip (all five words), processing
//      quantifies with the live k/N feed (block form on the card, inline
//      bar in the row), metric-done refetches the state and clears the
//      feed, the draft-vs-saved preview criterion holds, and no rendered
//      state output carries a version number or timestamp;
//   J. the Order dialog (dogfooding design §2): the list-header entry
//      point, ONE dialog with two stacked sections, the read-only fixed
//      block over the full catalog in sequence order, keyboard moves
//      write the pref through (SetPref with the whole sequence), Reset
//      deletes both keys, the pin indicator is read-only, and Close
//      dismisses.
//
// Backend semantics — the SQL partition + keyset tiling
// (store.TestListMetricsPageOriginFilter*) and the SaveMetric/DeleteMetric
// guards (TestSaveMetricBuiltinGuards) — live in the Go tests; the
// read-cache key carries originFilter via services-cache.test.js. This
// pins the VIEW wiring only.
//
// jsdom is a declared devDependency of frontend/ — a plain `npm ci`
// there provides it (never `npm i --no-save`, which makes the next
// `npm ci` prune it). From frontend/ run:
//   node --test test/builder.dom.mjs
// (must be run with frontend/ as the working directory)
import { JSDOM } from 'jsdom';
import { compile } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { installEsmDirHook } from './esm-dir-hook.mjs';

installEsmDirHook();

// Same redirection as library.dom.mjs: services.js runs against the
// shared TEST STUBS (no live Wails backend), and 'svelte' is pinned to
// the CLIENT entry so plain `node --test` mounts for real.
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
// The Wails event-bus stub — the SAME module instance services.js
// subscribes to (the '@wailsio/runtime' hook above redirects to this
// file, built from the same cwd-relative path), so firing here drives
// the view's metric-progress / metric-done listeners.
const { fire } = await import(pathToFileURL(join('test', 'stubs', 'wails-runtime.mjs')).href);

// The mount-time fire-and-forget plugin-state read: an empty list keeps
// every row's plugin chip undimmed.
bindings.PlatformService.ListPlugins = () => Promise.resolve([]);
// The live expression check resolves "valid" so loading a row for edit
// never parks an error state beside the form.
bindings.handlers.ValidateExpr = () => [true, {}];

// The library-wide catalog (one cached listMetrics()): the mount effect
// resolves an ABSENT pins key's DEFAULT_PINS (design §1.6) through it,
// and the Order dialog lists the FULL catalog (design §2.4 — one
// listMetrics() on open). Scripted BEFORE the first mount so the
// resolved selection is stable across every section.
bindings.MetricsService.ListMetrics = () => Promise.resolve(METRICS);

// The fixture catalog in the store's canonical order (builtin → user →
// plugin, name ASC within each origin) — the order the paged read and
// the view's group headers are built on.
const METRICS = [
  {
    id: 1, name: 'trade_rate', title: 'Trade rate', shortName: '',
    expr: 'from player_stats, match_trade_opps: ratio(sum(trade_kills), sum(opps))',
    scope: 'match', format: 'percent', doc: 'Formula: trade successes / opportunities',
    origin: 'builtin', pluginId: '', denominator: '',
  },
  {
    id: 2, name: 'adr_avg', title: 'ADR average', shortName: 'ADR',
    expr: 'from player_stats: avg(adr)', scope: 'match', format: 'float1',
    doc: 'Formula: average ADR', origin: 'user', pluginId: '', denominator: '',
  },
  {
    id: 3, name: 'my_kd', title: 'My K/D', shortName: '',
    expr: 'from events: ratio(count(victim), count(attacker))', scope: 'match',
    format: 'float1', doc: 'Formula: kills / deaths', origin: 'user', pluginId: '',
    denominator: '',
  },
  {
    id: 4, name: 'plug_stat', title: 'Plugin stat', shortName: '',
    expr: 'from events: count()', scope: 'match', format: 'int',
    doc: 'Formula: count()', origin: 'plugin', pluginId: 'p1', denominator: '',
  },
];

// The scripted paged read: the SAME partition + LIKE the store applies
// (store.ListMetricsPage), recorded so the checks can assert the exact
// args the view sent — (query, originFilter, afterID, limit).
const pageCalls = [];
bindings.handlers.ListMetricsPage = (q, originFilter, afterID, limit) => {
  pageCalls.push([q, originFilter, afterID, limit]);
  let rows = METRICS.slice();
  if (originFilter === 'builtin') rows = rows.filter((m) => m.origin === 'builtin');
  else if (originFilter === 'mine') rows = rows.filter((m) => m.origin !== 'builtin');
  else if (originFilter === 'none') rows = [];
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter((m) => `${m.name} ${m.title}`.toLowerCase().includes(needle));
  }
  const start = afterID ? rows.findIndex((r) => r.id === afterID) + 1 : 0;
  const win = rows.slice(start, start + (limit || 100));
  return { rows: win, hasNext: start + win.length < rows.length };
};

// The row play's preview: the stored definition echoed back (the shape
// MetricPreview carries — `metric` is the full row), recorded so the
// checks can assert the AD-HOC (dirty draft) leg still rides
// PreviewMetric — the SAVED leg must NOT (design §5: a saved +
// unmodified definition reads its stored rows).
const previewCalls = [];
bindings.handlers.PreviewMetric = (id, expr, scope, limit) => {
  previewCalls.push([id, expr, scope, limit]);
  const m = METRICS.find((r) => r.id === id) || {};
  return {
    metric: m,
    rows: [{ group: '', label: 'alice', value: 0.412, n: 13 }],
    ms: 3,
    sql: 'select 1',
    truncated: false,
  };
};

// --- The SAVED-preview read path (design §5) -------------------------------
// The canonical stored-value read (recorded so the checks can pin the
// args), the no-execution compile for provenance, the newest-ready-match
// resolution, the label source, and the compute-state read.
const storedCalls = [];
bindings.handlers.GetMetricValuesForMatch = (matchID, metricIDs) => {
  storedCalls.push([matchID, metricIDs]);
  return (metricIDs || []).map((id) => ({
    metricId: id,
    steamId: '76561198000000001',
    value: id === 1 ? 0.412 : 6,
    n: 13,
  }));
};
const compileCalls = [];
bindings.handlers.CompileMetric = (id, expr, scope) => {
  compileCalls.push([id, expr, scope]);
  return 'select 1';
};
bindings.handlers.ListMatches = () => [{ id: 9, status: 'ready', map: 'de_cache' }];
bindings.handlers.ListPlayers = () => [{ steamId: '76561198000000001', name: 'alice' }];
bindings.handlers.GetMetric = (id) => METRICS.find((m) => m.id === id) || null;

// The compute-state read: one entry per metric covering the whole
// vocabulary (the state-surface section below asserts each chip).
let computeStates = [
  { metricId: 1, state: 'fresh' },
  { metricId: 2, state: 'behind' },
  { metricId: 3, state: 'failed', error: 'upstream vanished' },
  { metricId: 4, state: 'processing' },
];
let stateReads = 0;
bindings.handlers.GetMetricComputeState = () => {
  stateReads++;
  return computeStates;
};

const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'builder');
mkdirSync(dir, { recursive: true });

const svelteCompile = (src, filename, out) => {
  const code = compile(src, { filename, generate: 'client' }).js.code;
  writeFileSync(out, code);
  return out;
};
const fileURL = (p) => pathToFileURL(p).href;

// StatusChip is a leaf (no imports) → local bundle. ProfileLink imports
// nav.js + services.js → local bundle with both pinned to the SAME
// absolute URLs the view links (one module instance each).
svelteCompile(
  readFileSync('src/lib/components/StatusChip.svelte', 'utf8'),
  'StatusChip.svelte',
  join(dir, 'statuschip.js'),
);
const plSrc = readFileSync('src/lib/components/ProfileLink.svelte', 'utf8')
  .replace("from '../nav.js'", `from '${fileURL('src/lib/nav.js')}'`)
  .replace("from '../services.js'", `from '${fileURL('src/lib/services.js')}'`);
svelteCompile(plSrc, 'ProfileLink.svelte', join(dir, 'profilelink.js'));

// The Order dialog + its Dialog wrapper: the dialog rewrites its
// services/metricorder imports to the same absolute URLs the view links
// (one module instance each) and its ./Dialog.svelte to the local
// bundle; Dialog itself is a leaf apart from 'svelte'.
const moSrc = readFileSync('src/lib/components/MetricOrderDialog.svelte', 'utf8')
  .replace("from '../services.js'", `from '${fileURL('src/lib/services.js')}'`)
  .replace("from '../metricorder.js'", `from '${fileURL('src/lib/metricorder.js')}'`)
  .replace("from './Dialog.svelte'", "from './dialog.js'");
svelteCompile(moSrc, 'MetricOrderDialog.svelte', join(dir, 'metricorderdialog.js'));
svelteCompile(
  readFileSync('src/lib/components/Dialog.svelte', 'utf8'),
  'Dialog.svelte',
  join(dir, 'dialog.js'),
);

// The view: plain-ESM imports (services/fmt/viewstate) resolve from
// their real module locations — viewstate through the SAME absolute URL
// the pins below import, so the view and the test share one registry
// instance (the jsdom cross-talk rule in that module's header).
const bldSrc = readFileSync('src/lib/views/Builder.svelte', 'utf8')
  .replace("from '../services.js'", `from '${fileURL('src/lib/services.js')}'`)
  .replace("from '../metricorder.js'", `from '${fileURL('src/lib/metricorder.js')}'`)
  .replace("from '../fmt.js'", `from '${fileURL('src/lib/fmt.js')}'`)
  .replace("from '../metricstate.js'", `from '${fileURL('src/lib/metricstate.js')}'`)
  .replace("from '../viewstate.svelte.js'", `from '${fileURL('src/lib/viewstate.svelte.js')}'`)
  .replace("from '../components/ProfileLink.svelte'", "from './profilelink.js'")
  .replace("from '../components/StatusChip.svelte'", "from './statuschip.js'")
  .replace("from '../components/MetricOrderDialog.svelte'", "from './metricorderdialog.js'");
svelteCompile(bldSrc, 'Builder.svelte', join(dir, 'builder-bundle.js'));

const { mount, unmount } = await import('svelte');
const mod = await import(pathToFileURL(join(dir, 'builder-bundle.js')).href);
// The registry the view imports (same URL → same instance — section F
// drives it directly).
const viewstate = await import(pathToFileURL('src/lib/viewstate.svelte.js').href);

const sleep = (ms = 40) => new Promise((r) => setTimeout(r, ms));
// The list effect debounces non-first refreshes by 250 ms — wait past it.
const DEBOUNCE = 350;

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}

let inst = null;
let root = null;
async function mountBuilder() {
  if (inst) {
    await unmount(inst);
    inst = null;
  }
  if (root) {
    root.remove();
    root = null;
  }
  root = document.createElement('div');
  document.body.appendChild(root);
  inst = mount(mod.default, { target: root, props: { nav: () => {} } });
  await sleep(120); // mount + the immediate first list fetch
  return root;
}

const rowsOf = (r) => [...r.querySelectorAll('.bld-row')];
const namesOf = (r) =>
  rowsOf(r).map((x) => x.querySelector('.bld-row-sub .mono')?.textContent.trim());
const headersOf = (r) =>
  [...r.querySelectorAll('.bld-group h3')].map((h) => h.textContent.trim());
const rowNamed = (r, name) =>
  rowsOf(r).find((x) => x.querySelector('.bld-row-sub .mono')?.textContent.trim() === name);
const toggle = (r, label) =>
  [...r.querySelectorAll('button.bld-src')].find((b) => b.textContent.trim() === label);
// The source toggles are BUTTONS now (btn small bld-src — the Combat
// Clutches won/lost pattern): state rides aria-pressed and a click flips
// it. setToggle keeps the old setCheck semantics — an ABSOLUTE value,
// clicking only when the current pressed state differs.
const pressed = (b) => b?.getAttribute('aria-pressed') === 'true';
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const setToggle = (btn, v) => {
  if (btn && pressed(btn) !== v) click(btn);
};
const type = (el, value) => {
  el.value = value;
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
};
const heading = (r) => r.querySelector('.bld-right h2')?.textContent.trim();

viewstate.resetViewState();

console.log('A. defaults: Built-in OFF / My metrics ON — the first window is the mine partition');
let r = await mountBuilder();
check(
  'first list call = (query "", filter "mine", cursor 0, 100)',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', 'mine', 0, 100]),
  JSON.stringify(pageCalls[0]),
);
const tgBuiltin = toggle(r, 'Built-in');
const tgMine = toggle(r, 'My metrics');
check('the Built-in toggle starts unchecked', !!tgBuiltin && !pressed(tgBuiltin));
check('the My metrics toggle starts checked', !!tgMine && pressed(tgMine));
check(
  'the rendered list is the mine partition (no builtin row)',
  JSON.stringify(namesOf(r)) === JSON.stringify(['adr_avg', 'my_kd', 'plug_stat']),
  JSON.stringify(namesOf(r)),
);
check(
  'group headers follow the partition (Yours + Plugins, no Builtins)',
  JSON.stringify(headersOf(r)) === JSON.stringify(['Yours', 'Plugins']),
  JSON.stringify(headersOf(r)),
);
check(
  'the server-side search box is rendered',
  !!r.querySelector('input[type="search"][aria-label="Search metrics"]'),
);

console.log('B. toggling Built-in ON restarts the keyset window at cursor 0 (both sources)');
services.invalidate(); // same-key windows are cached — record this window fresh
pageCalls.length = 0;
setToggle(tgBuiltin, true);
await sleep(DEBOUNCE);
check(
  'the toggle restarts the window: (query "", filter "", cursor 0, 100)',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', 0, 100]),
  JSON.stringify(pageCalls[0]),
);
check(
  'all four rows render with the Builtins header',
  JSON.stringify(namesOf(r)) === JSON.stringify(['trade_rate', 'adr_avg', 'my_kd', 'plug_stat']) &&
    headersOf(r).includes('Builtins'),
  JSON.stringify(namesOf(r)) + ' headers=' + JSON.stringify(headersOf(r)),
);

console.log('C. Built-in only → both off (empty list is legal) → back to mine');
services.invalidate();
pageCalls.length = 0;
setToggle(tgMine, false);
await sleep(DEBOUNCE);
check(
  'mine OFF → (query "", filter "builtin", cursor 0, 100)',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', 'builtin', 0, 100]),
  JSON.stringify(pageCalls[0]),
);
check(
  'only the builtin row renders (Yours/Plugins headers gone)',
  JSON.stringify(namesOf(r)) === JSON.stringify(['trade_rate']) &&
    !headersOf(r).includes('Yours') &&
    !headersOf(r).includes('Plugins'),
  JSON.stringify(namesOf(r)) + ' headers=' + JSON.stringify(headersOf(r)),
);
services.invalidate();
pageCalls.length = 0;
setToggle(tgBuiltin, false);
await sleep(DEBOUNCE);
check(
  'both off → (query "", filter "none", cursor 0, 100) — a legal empty read',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', 'none', 0, 100]),
  JSON.stringify(pageCalls[0]),
);
check(
  'both off → empty list, no error, the empty state says so',
  rowsOf(r).length === 0 &&
    !r.querySelector('p.error[role="alert"]') &&
    r.textContent.includes('No metrics to show.'),
  `rows=${rowsOf(r).length} text=${r.textContent.replace(/\s+/g, ' ').slice(0, 200)}`,
);
services.invalidate();
pageCalls.length = 0;
setToggle(tgMine, true);
await sleep(DEBOUNCE);
check(
  'mine back ON → (query "", filter "mine", cursor 0, 100) — cursor reset again',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', 'mine', 0, 100]),
  JSON.stringify(pageCalls[0]),
);
check(
  'the mine rows render again',
  JSON.stringify(namesOf(r)) === JSON.stringify(['adr_avg', 'my_kd', 'plug_stat']),
  JSON.stringify(namesOf(r)),
);

console.log('D. built-in immutability: the builtin row exposes no edit and no delete control');
services.invalidate();
pageCalls.length = 0;
setToggle(tgBuiltin, true); // both on: builtin + user rows side by side
await sleep(DEBOUNCE);
check(
  'both on → (query "", filter "", cursor 0, 100)',
  JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', 0, 100]),
  JSON.stringify(pageCalls[0]),
);
{
  const bRow = rowNamed(r, 'trade_rate');
  const uRow = rowNamed(r, 'adr_avg');
  check('the builtin row renders', !!bRow, JSON.stringify(namesOf(r)));
  check(
    'the builtin row main area is plain content — NO edit button',
    !!bRow && !bRow.querySelector('button.bld-row-main') && !!bRow.querySelector('div.bld-row-main'),
    bRow ? [...bRow.children].map((c) => c.className || c.tagName).join(' | ') : 'no row',
  );
  check(
    'the builtin row has NO delete control',
    !!bRow && !bRow.querySelector('[aria-label="Delete trade_rate"]'),
    bRow ? bRow.innerHTML.slice(0, 200) : 'no row',
  );
  check(
    'the builtin row keeps pin + preview',
    !!bRow &&
      !!bRow.querySelector('[aria-label="Toggle pin for trade_rate"]') &&
      !!bRow.querySelector('[aria-label="Preview trade_rate"]'),
  );
  check(
    'a user row still HAS an edit button and a delete control',
    !!uRow &&
      !!uRow.querySelector('button.bld-row-main') &&
      !!uRow.querySelector('[aria-label="Delete adr_avg"]'),
    uRow ? [...uRow.children].map((c) => c.className || c.tagName).join(' | ') : 'no row',
  );
  // The form is untouched: heading "New metric", empty name field.
  check('the form starts at "New metric"', heading(r) === 'New metric', heading(r));
  click(bRow.querySelector('div.bld-row-main'));
  await sleep(60);
  check(
    'clicking the builtin main area does NOT load the form',
    heading(r) === 'New metric' && r.querySelector('#bld-name')?.value === '',
    `heading=${heading(r)} name=${r.querySelector('#bld-name')?.value}`,
  );
  // The builtin still pins.
  const pinBtn = bRow.querySelector('[aria-label="Toggle pin for trade_rate"]');
  click(pinBtn);
  await sleep(40);
  check(
    'the builtin row still pins (title flips to Unpin + the on-class)',
    pinBtn.classList.contains('bld-pin-on') &&
      pinBtn.getAttribute('title') === 'Unpin from scoreboard',
    `class=${pinBtn.className} title=${pinBtn.getAttribute('title')}`,
  );
  click(pinBtn); // leave the pin state as it was found
  await sleep(40);
}

console.log('E. the builtin PREVIEWS from its STORED rows — a saved read never calculates');
previewCalls.length = 0;
storedCalls.length = 0;
compileCalls.length = 0;
{
  const bRow = rowNamed(r, 'trade_rate');
  click(bRow.querySelector('[aria-label="Preview trade_rate"]'));
  await sleep(120);
  check(
    'the saved preview read the stored rows for the newest ready match',
    JSON.stringify(storedCalls[0]) === JSON.stringify([9, [1]]),
    JSON.stringify(storedCalls[0]),
  );
  check(
    'PreviewMetric was NOT called — saved + unmodified reads stored (design §5)',
    previewCalls.length === 0,
    JSON.stringify(previewCalls),
  );
  check(
    'the provenance SQL came from the no-execution compile of that same match',
    JSON.stringify(compileCalls[0]) === JSON.stringify([1, '', 'match:9']),
    JSON.stringify(compileCalls[0]),
  );
  check(
    'the preview table renders',
    !!r.querySelector('.bld-preview table.data-table tbody tr'),
    r.querySelector('.bld-preview')?.textContent.replace(/\s+/g, ' ').slice(0, 160),
  );
  const valueCell = r.querySelector('.bld-preview table.data-table tbody tr td.num')?.textContent;
  check(
    "the value formats from the BUILTIN's stored format (percent), not the empty form",
    valueCell === '41.2%',
    String(valueCell),
  );
  const previewText = r.querySelector('.bld-preview')?.textContent || '';
  check(
    'the panel names the unit the stored rows came from (match stated)',
    previewText.includes('newest ready match #9') && previewText.includes('de_cache'),
    previewText.replace(/\s+/g, ' ').slice(0, 200),
  );
  check(
    'the saved preview shows the STATE indicator and no timing chip (it timed nothing)',
    !!r.querySelector('.bld-preview .toolbar .chip.status') &&
      ![...r.querySelectorAll('.bld-preview .toolbar .chip')].some((c) => /ms$/.test(c.textContent.trim())),
    r.querySelector('.bld-preview .toolbar')?.textContent.replace(/\s+/g, ' '),
  );
  check(
    'previewing a builtin still does NOT load the form',
    heading(r) === 'New metric' && r.querySelector('#bld-name')?.value === '',
    `heading=${heading(r)} name=${r.querySelector('#bld-name')?.value}`,
  );
  // The fresh state chip on the list item (the state vocabulary's
  // fifth word — the others are pinned in section I).
  {
    const chip = rowNamed(r, 'trade_rate')?.querySelector('.bld-row-sub .chip.status');
    check(
      'list item: fresh renders the ok chip',
      !!chip && chip.classList.contains('ok') && chip.textContent.trim() === 'fresh',
      chip ? `${chip.className} "${chip.textContent.trim()}"` : 'no chip',
    );
  }
}

console.log('F. a user row still loads the form for editing (unaffected)');
{
  const uRow = rowNamed(r, 'adr_avg');
  click(uRow.querySelector('button.bld-row-main'));
  await sleep(60);
  check(
    'clicking the user row loads it into the form',
    heading(r) === 'Edit metric' && r.querySelector('#bld-name')?.value === 'adr_avg',
    `heading=${heading(r)} name=${r.querySelector('#bld-name')?.value}`,
  );
  await sleep(500); // the 400 ms expression check lands on its scripted "valid"
  check(
    'the live expression check resolves valid for the loaded row',
    !!r.querySelector('.bld-expr-state.ok'),
    r.querySelector('.bld-expr-state')?.textContent ?? 'no state line',
  );
}

console.log('G. the search composes with the filter in ONE server call');
{
  const search = r.querySelector('input[type="search"][aria-label="Search metrics"]');
  services.invalidate();
  pageCalls.length = 0;
  type(search, 'adr');
  await sleep(DEBOUNCE);
  check(
    'typing restarts the window with BOTH narrowings: (query "adr", filter "", cursor 0, 100)',
    JSON.stringify(pageCalls[0]) === JSON.stringify(['adr', '', 0, 100]),
    JSON.stringify(pageCalls[0]),
  );
  check(
    'the composed server-side result renders (one row)',
    JSON.stringify(namesOf(r)) === JSON.stringify(['adr_avg']),
    JSON.stringify(namesOf(r)),
  );
  services.invalidate();
  pageCalls.length = 0;
  type(search, '');
  await sleep(DEBOUNCE);
  check(
    'clearing the query restores the full partition window',
    JSON.stringify(pageCalls[0]) === JSON.stringify(['', '', 0, 100]) && rowsOf(r).length === 4,
    JSON.stringify(pageCalls[0]) + ' rows=' + rowsOf(r).length,
  );
}

console.log('H. the toggles are view-local registry state (restore, then reset to defaults)');
{
  // Leave a DISTINCT toggle state (Built-in ON, My metrics OFF) behind.
  services.invalidate();
  setToggle(tgMine, false);
  await sleep(DEBOUNCE);
  check(
    'the parting state is Built-in only',
    JSON.stringify(pageCalls[pageCalls.length - 1]) === JSON.stringify(['', 'builtin', 0, 100]) &&
      JSON.stringify(namesOf(r)) === JSON.stringify(['trade_rate']),
    JSON.stringify(pageCalls[pageCalls.length - 1]) + ' rows=' + JSON.stringify(namesOf(r)),
  );
  r = await mountBuilder(); // unmount → remount, registry intact
  const tgB2 = toggle(r, 'Built-in');
  const tgM2 = toggle(r, 'My metrics');
  check(
    'unmount → remount restores the toggles (Built-in ON, My metrics OFF)',
    !!tgB2 && pressed(tgB2) && !!tgM2 && !pressed(tgM2),
    `builtin=${tgB2 && pressed(tgB2)} mine=${tgM2 && pressed(tgM2)}`,
  );
  check(
    '…and the restored view shows the restored partition',
    JSON.stringify(namesOf(r)) === JSON.stringify(['trade_rate']),
    JSON.stringify(namesOf(r)),
  );
  viewstate.resetViewState();
  r = await mountBuilder();
  const tgB3 = toggle(r, 'Built-in');
  const tgM3 = toggle(r, 'My metrics');
  check(
    'resetViewState() → the next mount is back to the defaults (OFF / ON)',
    !!tgB3 && !pressed(tgB3) && !!tgM3 && pressed(tgM3),
    `builtin=${tgB3 && pressed(tgB3)} mine=${tgM3 && pressed(tgM3)}`,
  );
  check(
    '…and the default view is the mine partition again',
    JSON.stringify(namesOf(r)) === JSON.stringify(['adr_avg', 'my_kd', 'plug_stat']),
    JSON.stringify(namesOf(r)),
  );
}

console.log('I. compute-state surface: list chips, editor card, k/N progress, draft-vs-saved preview');
{
  const chipOf = (name) => rowNamed(r, name)?.querySelector('.bld-row-sub .chip.status');
  const editorPanel = () => r.querySelector('.bld-right > section.panel');
  const previewBtn = () =>
    [...r.querySelectorAll('.bld-preview .toolbar button')].find((b) =>
      b.textContent.includes('Preview'),
    );

  // Every list item wears its state chip (the scripted states: 2
  // behind, 3 failed, 4 processing — and 1 fresh, checked in E).
  {
    const chip = chipOf('adr_avg');
    check(
      'list item: behind renders the idle chip',
      !!chip && chip.classList.contains('idle') && chip.textContent.trim() === 'behind',
      chip ? `${chip.className} "${chip.textContent.trim()}"` : 'no chip',
    );
  }
  {
    const chip = chipOf('my_kd');
    check(
      'list item: failed renders the bad chip with the engine error as its title',
      !!chip &&
        chip.classList.contains('bad') &&
        chip.textContent.trim() === 'failed' &&
        chip.getAttribute('title') === 'upstream vanished',
      chip ? `${chip.className} title=${chip.getAttribute('title')}` : 'no chip',
    );
  }
  {
    const chip = chipOf('plug_stat');
    check(
      'list item: processing renders the busy chip',
      !!chip && chip.classList.contains('busy') && chip.textContent.includes('processing'),
      chip ? `${chip.className} "${chip.textContent.trim()}"` : 'no chip',
    );
  }

  // The editor card shows the loaded metric's state (adr_avg = behind).
  click(rowNamed(r, 'adr_avg').querySelector('button.bld-row-main'));
  await sleep(60);
  {
    const chip = editorPanel()?.querySelector('.chip.status');
    check(
      'editor card: the loaded metric shows its state chip (behind)',
      !!chip && chip.classList.contains('idle') && chip.textContent.trim() === 'behind',
      chip ? `${chip.className} "${chip.textContent.trim()}"` : 'no chip',
    );
    check(
      'no block progress while nothing runs for this metric',
      !editorPanel()?.querySelector('.bld-card-prog'),
      editorPanel()?.querySelector('.bld-card-prog')?.textContent ?? '',
    );
  }

  // The live feed flips BOTH surfaces to processing and quantifies:
  // the card goes block-form with the honest k/N underneath, the list
  // row keeps the compact inline bar (in-cell rule).
  fire('spectra:metric-progress', { metricId: 2, stage: 'compute', done: 2, total: 5 });
  await sleep(60);
  {
    const prog = editorPanel()?.querySelector('.bld-card-prog .chip-block');
    check(
      'editor card: processing shows the block indicator with "computing 2 of 5 metrics" underneath',
      !!prog && prog.textContent.includes('computing 2 of 5 metrics'),
      prog ? prog.textContent.replace(/\s+/g, ' ') : 'no block progress',
    );
    const chip = chipOf('adr_avg');
    check(
      'list item: the same metric quantifies with the inline k/N bar',
      !!chip &&
        chip.classList.contains('busy') &&
        chip.textContent.includes('processing') &&
        !!chip.querySelector('.chip-bar') &&
        chip.textContent.includes('40%'),
      chip ? chip.textContent.replace(/\s+/g, ' ') : 'no chip',
    );
  }

  // metric-done: the sweep is over — the state read refetches and the
  // feed clears, so the card falls back to the refetched word.
  {
    const before = stateReads;
    fire('spectra:metric-done', { ok: true, error: '', metricIds: [2] });
    await sleep(80);
    check('metric-done refetches GetMetricComputeState', stateReads > before, `${before} -> ${stateReads}`);
    const chip = editorPanel()?.querySelector('.chip.status');
    check(
      'the feed cleared: the editor is back to the refetched behind chip',
      !editorPanel()?.querySelector('.bld-card-prog') &&
        !!chip &&
        chip.classList.contains('idle'),
      chip ? `${chip.className} "${chip.textContent.trim()}"` : 'no chip',
    );
  }

  // THE draft-vs-saved preview criterion: clean-saved form → stored
  // rows (no PreviewMetric); dirty draft → on-demand calculation.
  storedCalls.length = 0;
  previewCalls.length = 0;
  compileCalls.length = 0;
  click(previewBtn());
  await sleep(120);
  check(
    'clean-saved form preview reads stored rows (PreviewMetric untouched)',
    JSON.stringify(storedCalls[0]) === JSON.stringify([9, [2]]) && previewCalls.length === 0,
    `stored=${JSON.stringify(storedCalls)} preview=${JSON.stringify(previewCalls)}`,
  );

  type(r.querySelector('#bld-name'), 'adr_avg_edited'); // dirty the form
  await sleep(20);
  storedCalls.length = 0;
  previewCalls.length = 0;
  click(previewBtn());
  await sleep(120);
  check(
    'a dirty draft previews on demand through PreviewMetric (no stored read)',
    previewCalls.length === 1 && storedCalls.length === 0,
    `stored=${JSON.stringify(storedCalls)} preview=${JSON.stringify(previewCalls)}`,
  );
  check(
    'the ad-hoc preview keeps its timing chip (it genuinely computed)',
    [...r.querySelectorAll('.bld-preview .toolbar .chip')].some((c) =>
      /ms$/.test(c.textContent.trim()),
    ),
    r.querySelector('.bld-preview .toolbar')?.textContent.replace(/\s+/g, ' '),
  );

  // The no-version pin on this surface: no stamp, version number or
  // timestamp in any state chip, chip title, progress detail or the
  // preview toolbar.
  const leakRe = /version|\bv\d+\b|\d{4}-\d{2}-\d{2}|rule stamp|computed at/i;
  const leaks = [];
  for (const chip of r.querySelectorAll('.chip.status, .chip-block')) {
    const tip = chip.getAttribute('title') || '';
    if (leakRe.test(tip)) leaks.push(`title: ${tip}`);
    if (leakRe.test(chip.textContent || '')) leaks.push(`text: ${chip.textContent.trim()}`);
  }
  for (const w of r.querySelectorAll('.bld-preview .toolbar .chip')) {
    if (leakRe.test(w.textContent || '')) leaks.push(`toolbar: ${w.textContent.trim()}`);
  }
  check(
    'no version number or timestamp appears in any Builder state output',
    leaks.length === 0,
    leaks.join(' | '),
  );
}

console.log('J. the Order dialog: entry point, write-through moves, Reset, read-only pins, fixed block');
{
  // Pin one metric first (on the Builder row — pin TOGGLING stays with
  // this single writer) so the dialog has a pinned indicator to show.
  const pinBtn = rowNamed(r, 'adr_avg')?.querySelector('[aria-label="Toggle pin for adr_avg"]');
  click(pinBtn);
  await sleep(60);

  const orderBtn = [...r.querySelectorAll('.bld-list button')].find((b) =>
    b.textContent.includes('Order'),
  );
  check(
    'the Order… button sits in the list header beside New, arrow-glyph pair',
    !!orderBtn &&
      !!orderBtn.querySelector('.codicon-arrow-up') &&
      !!orderBtn.querySelector('.codicon-arrow-down') &&
      [...(orderBtn.parentElement?.querySelectorAll('button') || [])].some((b) =>
        b.textContent.includes('New'),
      ),
    orderBtn ? orderBtn.textContent.replace(/\s+/g, ' ').trim() : 'no Order button',
  );

  bindings.resetCalls();
  click(orderBtn);
  await sleep(150);
  const dlg = document.querySelector('.dlg-panel.mo-prompt');
  check(
    'the dialog opens (mo-prompt panel with role=dialog)',
    !!dlg && dlg.getAttribute('role') === 'dialog',
    dlg ? 'open' : 'not found',
  );
  check(
    'both order prefs were read through their bare kvstore keys',
    ['metric_order_match', 'metric_order_profile'].every((k) =>
      bindings.calls.some((c) => c.method === 'GetPref' && c.args[0] === k),
    ),
    JSON.stringify(bindings.calls.filter((c) => c.method === 'GetPref').map((c) => c.args)),
  );

  const sec = (scope) => dlg?.querySelector(`.mo-sec[data-mo-scope="${scope}"]`);
  const dRows = (scope) => [...(sec(scope)?.querySelectorAll('.mo-row') || [])];
  const dNames = (scope) => dRows(scope).map((x) => x.dataset.moName);

  check(
    'one dialog, two stacked sections (scoreboard then profile — no tabs)',
    [...(dlg?.querySelectorAll('.mo-sec-title') || [])].map((h) => h.textContent.trim()).join(' | ') ===
      'Scoreboard (match metrics) | Player profile (profile metrics)' &&
      !dlg?.querySelector('[role="tab"]'),
    [...(dlg?.querySelectorAll('.mo-sec-title') || [])].map((h) => h.textContent.trim()).join(' | '),
  );
  {
    const fixed = sec('match')?.querySelector('.mo-fixed');
    const items = fixed ? [...fixed.querySelectorAll('.mo-fixed-item')].map((x) => x.textContent) : [];
    check(
      'fixed block: read-only context (role=list, aria-readonly, no controls, not draggable) — Go stats only',
      !!fixed &&
        fixed.getAttribute('role') === 'list' &&
        fixed.getAttribute('aria-readonly') === 'true' &&
        items[0] === 'Name' &&
        items[items.length - 1] === 'Score' &&
        items.includes('KDA') &&
        !items.includes('ADR') &&
        !items.includes('KAST%') &&
        !fixed.querySelector('button') &&
        !fixed.hasAttribute('draggable') &&
        !fixed.querySelector('[draggable]'),
      fixed ? JSON.stringify(items) : 'no fixed block',
    );
  }
  check(
    'the metric list covers the FULL catalog in the default sequence (absent pref)',
    JSON.stringify(dNames('match')) ===
      JSON.stringify(['trade_rate', 'adr_avg', 'my_kd', 'plug_stat']),
    JSON.stringify(dNames('match')),
  );
  check(
    'the profile section says so when its catalog is empty',
    !!sec('profile')?.textContent.includes('No profile metrics yet.'),
    sec('profile')?.textContent.replace(/\s+/g, ' ').slice(0, 120),
  );
  {
    const rows = dRows('match');
    const up0 = rows[0]?.querySelector('[aria-label="Move trade_rate up"]');
    const down0 = rows[0]?.querySelector('[aria-label="Move trade_rate down"]');
    const downLast = rows[3]?.querySelector('[aria-label="Move plug_stat down"]');
    check(
      'every row carries labelled ↑/↓ buttons; the boundary ones are disabled',
      !!up0 && up0.disabled && !!down0 && !down0.disabled && !!downLast && downLast.disabled,
      `up0=${up0 && up0.disabled} down0=${down0 && !down0.disabled} downLast=${downLast && downLast.disabled}`,
    );
  }
  {
    const row0 = dRows('match')[0];
    row0.focus();
    row0.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await sleep(80);
    check(
      'ArrowDown on the focused row moves it one slot down',
      JSON.stringify(dNames('match')) ===
        JSON.stringify(['adr_avg', 'trade_rate', 'my_kd', 'plug_stat']),
      JSON.stringify(dNames('match')),
    );
    const set = bindings.calls.find((c) => c.method === 'SetPref');
    check(
      'the move is write-through: SetPref carries the key AND the whole resolved sequence',
      !!set &&
        set.args[0] === 'metric_order_match' &&
        JSON.stringify(set.args[1]) ===
          JSON.stringify(['adr_avg', 'trade_rate', 'my_kd', 'plug_stat']),
      set ? JSON.stringify(set.args) : 'no SetPref call',
    );
  }
  {
    // Focus follows the moved row — pinned through the BUTTON path: a
    // keyboard move re-focuses the same DOM node (the keyed each moves
    // nodes), so only a button click on a NON-focused row can prove
    // focusRow ran. The move also leaves a non-default sequence behind,
    // which is what the reset check below must undo.
    const btn = dRows('match')
      .find((x) => x.dataset.moName === 'my_kd')
      ?.querySelector('[aria-label="Move my_kd up"]');
    click(btn);
    await sleep(80);
    check(
      'focus follows the row moved by its button',
      document.activeElement?.dataset?.moName === 'my_kd' &&
        JSON.stringify(dNames('match')) ===
          JSON.stringify(['adr_avg', 'my_kd', 'trade_rate', 'plug_stat']),
      `${document.activeElement?.className ?? 'none'} seq=${JSON.stringify(dNames('match'))}`,
    );
  }
  {
    const pinnedRow = dRows('match').find((x) => x.dataset.moName === 'adr_avg');
    const pin = pinnedRow?.querySelector('.mo-pin');
    const plain = dRows('match').find((x) => x.dataset.moName === 'trade_rate')?.querySelector('.mo-pin');
    check(
      'pin indicator: filled on the pinned row, dimmed on the unpinned one',
      !!pin && pin.classList.contains('mo-pin-on') && !!plain && !plain.classList.contains('mo-pin-on'),
      `pin=${pin && pin.className} plain=${plain && plain.className}`,
    );
    check(
      'the indicator is READ-ONLY — a span, no pin-toggle control anywhere in the dialog',
      !!pin && pin.tagName === 'SPAN' && !pinnedRow.querySelector('button[aria-label*="pin" i]') &&
        !dlg.querySelector('[aria-label^="Toggle pin"]'),
      pin ? pin.outerHTML : 'no indicator',
    );
  }
  {
    const resetBtn = [...dlg.querySelectorAll('button')].find((b) =>
      b.textContent.includes('Reset order'),
    );
    click(resetBtn);
    await sleep(80);
    const dels = bindings.calls.filter((c) => c.method === 'Delete');
    check(
      'Reset order deletes BOTH pref keys (key gone ⇒ default sequence)',
      JSON.stringify(dels.map((c) => c.args[0]).sort()) ===
        JSON.stringify(['metric_order_match', 'metric_order_profile']),
      JSON.stringify(dels.map((c) => c.args)),
    );
    check(
      'the lists snap back to the default sequence after reset',
      JSON.stringify(dNames('match')) ===
        JSON.stringify(['trade_rate', 'adr_avg', 'my_kd', 'plug_stat']),
      JSON.stringify(dNames('match')),
    );
  }
  {
    const closeBtn = [...dlg.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Close');
    click(closeBtn);
    await sleep(60);
    check('Close dismisses the dialog', !document.querySelector('.dlg-panel.mo-prompt'));
  }
}

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
if (inst) await unmount(inst);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
