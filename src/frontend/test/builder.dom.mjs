// jsdom driver for the metrics Builder's list UX (owner wave: list
// filter toggles + built-in immutability).
//   A. the Built-in / My metrics source toggles — defaults built-in OFF,
//      My metrics ON — and the SERVER-side origin partition they drive:
//      the scripted backend below applies store.ListMetricsPage's exact
//      predicate to the fixture, so a view that filtered client-side,
//      passed the wrong partition word, or forgot the arg would render
//      the wrong rows here;
//   B. a toggle restarts the keyset window at cursor 0 — the same path
//      as a search change (one debounced effect reads query +
//      originFilter) — and the group headers follow the partition;
//   C. built-in immutability in the UI: a builtin row renders NO edit
//      control (its main area is plain content — a div, never a button)
//      and NO delete control, while a user row renders both; pin and
//      preview stay live on the builtin row, and the builtin preview
//      runs off the stored id WITHOUT loading the form (its percent
//      format comes from the echoed stored row, not the empty form);
//   D. a user row still loads the form for editing (unaffected);
//   E. the search composes with the filter in ONE server call;
//   F. the toggles are view-local registry state (viewstate.svelte.js):
//      they restore across unmount → remount, and resetViewState()
//      returns the next mount to the defaults.
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

// The mount-time fire-and-forget plugin-state read: an empty list keeps
// every row's plugin chip undimmed.
bindings.PlatformService.ListPlugins = () => Promise.resolve([]);
// The live expression check resolves "valid" so loading a row for edit
// never parks an error state beside the form.
bindings.handlers.ValidateExpr = () => [true, {}];

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
// checks can assert the builtin preview rode the SAVED id (expr "").
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

// The view: plain-ESM imports (services/fmt/viewstate) resolve from
// their real module locations — viewstate through the SAME absolute URL
// the pins below import, so the view and the test share one registry
// instance (the jsdom cross-talk rule in that module's header).
const bldSrc = readFileSync('src/lib/views/Builder.svelte', 'utf8')
  .replace("from '../services.js'", `from '${fileURL('src/lib/services.js')}'`)
  .replace("from '../fmt.js'", `from '${fileURL('src/lib/fmt.js')}'`)
  .replace("from '../viewstate.svelte.js'", `from '${fileURL('src/lib/viewstate.svelte.js')}'`)
  .replace("from '../components/ProfileLink.svelte'", "from './profilelink.js'")
  .replace("from '../components/StatusChip.svelte'", "from './statuschip.js'");
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
  [...r.querySelectorAll('label.filt-check')].find((l) => l.textContent.trim() === label)
    ?.querySelector('input');
const setCheck = (input, v) => {
  input.checked = v;
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
};
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
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
const cbBuiltin = toggle(r, 'Built-in');
const cbMine = toggle(r, 'My metrics');
check('the Built-in toggle starts unchecked', !!cbBuiltin && !cbBuiltin.checked);
check('the My metrics toggle starts checked', !!cbMine && cbMine.checked);
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
setCheck(cbBuiltin, true);
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
setCheck(cbMine, false);
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
setCheck(cbBuiltin, false);
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
setCheck(cbMine, true);
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
setCheck(cbBuiltin, true); // both on: builtin + user rows side by side
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

console.log('E. the builtin still PREVIEWS — off its stored id, without loading the form');
previewCalls.length = 0;
{
  const bRow = rowNamed(r, 'trade_rate');
  click(bRow.querySelector('[aria-label="Preview trade_rate"]'));
  await sleep(80);
  check(
    'the preview rides the stored id with an empty expr (saved definition)',
    JSON.stringify(previewCalls[0]) === JSON.stringify([1, '', '', 200]),
    JSON.stringify(previewCalls[0]),
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
  check(
    'previewing a builtin still does NOT load the form',
    heading(r) === 'New metric' && r.querySelector('#bld-name')?.value === '',
    `heading=${heading(r)} name=${r.querySelector('#bld-name')?.value}`,
  );
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
  setCheck(cbMine, false);
  await sleep(DEBOUNCE);
  check(
    'the parting state is Built-in only',
    JSON.stringify(pageCalls[pageCalls.length - 1]) === JSON.stringify(['', 'builtin', 0, 100]) &&
      JSON.stringify(namesOf(r)) === JSON.stringify(['trade_rate']),
    JSON.stringify(pageCalls[pageCalls.length - 1]) + ' rows=' + JSON.stringify(namesOf(r)),
  );
  r = await mountBuilder(); // unmount → remount, registry intact
  const cbB2 = toggle(r, 'Built-in');
  const cbM2 = toggle(r, 'My metrics');
  check(
    'unmount → remount restores the toggles (Built-in ON, My metrics OFF)',
    !!cbB2 && cbB2.checked && !!cbM2 && !cbM2.checked,
    `builtin=${cbB2 && cbB2.checked} mine=${cbM2 && cbM2.checked}`,
  );
  check(
    '…and the restored view shows the restored partition',
    JSON.stringify(namesOf(r)) === JSON.stringify(['trade_rate']),
    JSON.stringify(namesOf(r)),
  );
  viewstate.resetViewState();
  r = await mountBuilder();
  const cbB3 = toggle(r, 'Built-in');
  const cbM3 = toggle(r, 'My metrics');
  check(
    'resetViewState() → the next mount is back to the defaults (OFF / ON)',
    !!cbB3 && !cbB3.checked && !!cbM3 && cbM3.checked,
    `builtin=${cbB3 && cbB3.checked} mine=${cbM3 && cbM3.checked}`,
  );
  check(
    '…and the default view is the mine partition again',
    JSON.stringify(namesOf(r)) === JSON.stringify(['adr_avg', 'my_kd', 'plug_stat']),
    JSON.stringify(namesOf(r)),
  );
}

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
if (inst) await unmount(inst);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
