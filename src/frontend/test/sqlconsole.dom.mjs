// jsdom driver for the SQL console (help-buttons wave, 2026-11-15, then
// the sql-history wave = changes.txt C2 + C3, 2026-11-15). Sections A/B
// are the shared HelpButton's mount coverage — the `?` is the header's
// LAST element, right of the .spacer (and the running chip while a query
// is in flight), and clicking it hands App's openDocs the `sql-console`
// section id. C–G pin the console's own surface: the save form living in
// the Statement card above the Run/Export row, history lines as rows with
// per-line Save (load-into-form with a CLEARED save tie — a stale tie
// would silently update another saved row) and per-line Remove (a server
// delete), and the schema accordion.
//
// The console's three mount-time reads (schema, history, saved queries)
// are scripted; no query is ever RUN here — the engine is pinned in Go
// (session_test.go / query_store_test.go), the loading lines in
// progress-presentation.dom.mjs.
//
// jsdom is a declared devDependency of frontend/ — a plain `npm ci`
// there provides it (never `npm i --no-save`, which makes the next
// `npm ci` prune it). From frontend/ run:
//   node --test test/sqlconsole.dom.mjs
// (must be run with frontend/ as the working directory)
import { JSDOM } from 'jsdom';
import { compile } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { installEsmDirHook } from './esm-dir-hook.mjs';

installEsmDirHook();

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
});
for (const k of [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement',
  'HTMLButtonElement', 'HTMLTextAreaElement', 'HTMLMediaElement', 'HTMLAnchorElement',
  'SVGElement', 'Element', 'Node', 'Text', 'Comment', 'DocumentFragment',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'MutationObserver',
  'DOMParser', 'localStorage', 'location',
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

// services.js links the generated bindings (its imports are the app's,
// so the same redirections every view driver uses apply here) and 'svelte'
// must resolve to the CLIENT entry — node's default condition picks the
// server build, where mount() is unavailable.
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

const bindings = await import('./stubs/bindings.mjs');
// The console's mount-time reads, scripted: one schema (a noted table
// with typed columns), two history lines and one saved row — the rows
// sections C–G drive (an unscripted QueryService method is a TypeError
// the view would surface as an error banner — honest, but noise for
// these pins).
const historyFix = [
  { id: 11, sql: 'SELECT 1 AS first', ms: 3, rows: 1, ok: true, ran_at: '2026-11-15T00:00:00Z' },
  { id: 7, sql: 'SELECT * FROM rounds', ms: 9, rows: 40, ok: false, ran_at: '2026-11-15T00:01:00Z' },
];
const savedFix = [
  {
    id: 3,
    name: 'openings',
    description: 'opening kills by player',
    sql: 'SELECT 1',
    created_at: '2026-11-15T00:00:00Z',
  },
];
bindings.QueryService.GetSchema = () =>
  Promise.resolve([
    {
      name: 'matches',
      note: 'one row per imported demo',
      columns: [
        { name: 'id', type: 'INTEGER' },
        { name: 'map', type: 'TEXT', note: 'map name as extracted' },
      ],
    },
    { name: 'query_history', note: 'SQL console run history', columns: [{ name: 'sql', type: 'TEXT' }] },
  ]);
bindings.QueryService.ListHistory = () => Promise.resolve(historyFix);
bindings.QueryService.ListSavedQueriesPage = () => Promise.resolve({ rows: savedFix, hasNext: false });
// The mutators run through the stub's rec() — every call is recorded
// (method + args) and answered with a row shaped like the backend's.
bindings.handlers.SaveQuery = (name, q, description) => ({
  id: 42,
  name,
  description,
  sql: q,
  created_at: '2026-11-15T00:02:00Z',
});
bindings.handlers.UpdateQuery = (id, name, q, description) => ({
  id,
  name,
  description,
  sql: q,
  created_at: '2026-11-15T00:00:00Z',
});
bindings.handlers.DeleteQuery = () => null;
bindings.handlers.DeleteHistory = () => null;
bindings.handlers.ClearHistory = () => null;

const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'sqlconsole');
mkdirSync(dir, { recursive: true });
const fileURL = (p) => pathToFileURL(p).href;
const svelteCompile = (src, filename, out) => {
  writeFileSync(out, compile(src, { filename, generate: 'client' }).js.code);
};

// StatusChip is a leaf → local bundle.
svelteCompile(
  readFileSync('src/lib/components/StatusChip.svelte', 'utf8'),
  'StatusChip.svelte',
  join(dir, 'statuschip.js'),
);
// HelpButton — the shared header `?` (the one canonical idiom): its
// strings catalog resolves from the real tree like every other ../ module.
svelteCompile(
  readFileSync('src/lib/components/HelpButton.svelte', 'utf8').replace(
    "from '../strings/index.js'",
    `from '${fileURL('src/lib/strings/index.js')}'`,
  ),
  'HelpButton.svelte',
  join(dir, 'helpbutton.js'),
);

// The view: plain-ESM imports resolve from their real module locations,
// the component imports from the local bundles.
let sqlSrc = readFileSync('src/lib/views/SqlConsole.svelte', 'utf8');
for (const rel of ['services.js', 'download.js', 'csv.js', 'viewstate.svelte.js', 'strings/index.js']) {
  sqlSrc = sqlSrc.split(`from '../${rel}'`).join(`from '${fileURL(`src/lib/${rel}`)}'`);
}
sqlSrc = sqlSrc.split("from '../components/StatusChip.svelte'").join("from './statuschip.js'");
sqlSrc = sqlSrc.split("from '../components/HelpButton.svelte'").join("from './helpbutton.js'");
svelteCompile(sqlSrc, 'SqlConsole.svelte', join(dir, 'sqlconsole-bundle.js'));

const { mount, unmount } = await import('svelte');
const mod = await import(pathToFileURL(join(dir, 'sqlconsole-bundle.js')).href);
const target = document.createElement('div');
document.body.appendChild(target);
const inst = mount(mod.default, {
  target,
  props: { openDocs: (s) => (globalThis.__docs = [...(globalThis.__docs || []), s]) },
});

const sleep = (ms = 40) => new Promise((r) => setTimeout(r, ms));
await sleep(120); // mount + the schema/history/saved reads

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
// bind:value listens for the delegated `input` event — set the value the
// way a keystroke would leave it and dispatch it.
const type = (el, v) => {
  el.value = v;
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
};
const panelByHeading = (title) =>
  [...document.querySelectorAll('section.panel')].find(
    (s) => s.querySelector('h2')?.textContent.trim() === title,
  );

console.log('A. the header `?` renders as the header’s last element (help-buttons)');
const hdr = document.querySelector('.view-header');
const help = hdr?.querySelector(':scope > button[aria-label="Help for this view"]');
check(
  'the ? is the header’s LAST element, right of the .spacer, with the shared labels + question glyph',
  !!help && !!hdr && hdr.lastElementChild === help &&
    !!hdr.querySelector(':scope > .spacer') &&
    help.getAttribute('title') === 'Help for this view' &&
    help.classList.contains('btn') && !!help.querySelector('.codicon-question'),
  hdr ? [...hdr.children].map((c) => c.className || c.tagName).join(' | ') : 'no header',
);
check(
  'the header keeps its own notes (defaults · read-only) and the view stays mounted',
  !!document.querySelector('.view.sql-view') &&
    /rows cap/.test(document.querySelector('.sql-head-note')?.textContent || ''),
  document.querySelector('.sql-head-note')?.textContent || 'no head note',
);

console.log('B. clicking it hands openDocs the sql-console section (no navigation)');
const docs0 = (globalThis.__docs || []).length;
const hash0 = location.hash;
click(help);
await sleep();
check(
  'openDocs fired exactly once with the sql-console section id',
  (globalThis.__docs || []).length === docs0 + 1 && (globalThis.__docs || []).at(-1) === 'sql-console',
  JSON.stringify((globalThis.__docs || []).slice(docs0)),
);
check('the route did not move (the console stays put behind the sheet)', location.hash === hash0, location.hash);

console.log('C. the save form lives in the Statement card, above the Run/Export row');
const stmtCard = panelByHeading('Statement');
const editor = document.querySelector('.sql-editor');
const saveBar = stmtCard?.querySelector('.sql-save-bar');
const cardToolbars = stmtCard ? [...stmtCard.querySelectorAll(':scope > .toolbar')] : [];
const kids = stmtCard ? [...stmtCard.children] : [];
check(
  'the save bar renders exactly once, inside the Statement card',
  !!saveBar && document.querySelectorAll('.sql-save-bar').length === 1,
  `${document.querySelectorAll('.sql-save-bar').length} save bar(s), inStatement=${stmtCard?.contains(saveBar)}`,
);
check(
  'the form sits between the textarea and the Run/Export toolbar (its own toolbar, save first)',
  cardToolbars.length === 2 &&
    cardToolbars[0] === saveBar &&
    kids.indexOf(editor) < kids.indexOf(saveBar) &&
    kids.indexOf(saveBar) < kids.indexOf(cardToolbars[1]) &&
    !!cardToolbars[1].querySelector('button.primary'),
  cardToolbars.map((t) => t.className).join(' | '),
);
check(
  'it carries the name and description inputs and the Save button',
  !!saveBar?.querySelector('input[aria-label="Query name"]') &&
    !!saveBar.querySelector('input[aria-label="Query description"]') &&
    [...saveBar.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Save'),
);
const savedCard = panelByHeading('Saved queries');
check(
  'the saved-queries card keeps only its heading, list and footer — no save form',
  !!savedCard && !savedCard.querySelector('.sql-save-bar') &&
    !savedCard.querySelector('input[aria-label="Query name"]') &&
    !!savedCard.querySelector('h2'),
  savedCard ? savedCard.className : 'no saved card',
);
// The form's error slot travelled with it: an empty-name Save reports
// right where the form is (the statement card), never in the list card.
type(editor, 'SELECT 1');
click([...saveBar.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save'));
await sleep();
const saveErr = saveBar.nextElementSibling;
check(
  'a save error renders in the Statement card, right under the save bar',
  !!saveErr && saveErr.classList.contains('error') &&
    /name is required/i.test(saveErr.textContent) && stmtCard.contains(saveErr),
  saveErr ? `${saveErr.className} ${saveErr.textContent.trim()}` : 'none',
);

console.log('D. each history line is a row: a load body plus Save and Remove');
const histCard = panelByHeading('History (last 50)');
const histRows = () => [...(histCard?.querySelectorAll('.sql-hist.as-row') || [])];
const savedRows = () => [...(savedCard?.querySelectorAll('.sql-hist.as-row') || [])];
const ghosts = (r) => [...r.querySelectorAll(':scope > button.btn.ghost')];
check(
  'both lines render as rows (div.sql-hist.as-row, never one big button)',
  histRows().length === 2 && histRows().every((r) => r.tagName === 'DIV'),
  histRows().map((r) => r.tagName).join(','),
);
check(
  'each row = one load button + two ghost buttons, with no button inside a button',
  histRows().every((r) => {
    const load = r.querySelector(':scope > .sql-hist-load');
    return !!load && ghosts(r).length === 2 && !load.querySelector('button');
  }),
);
check(
  'the load body keeps the status dot, statement and run meta',
  !!histRows()[0].querySelector('.sql-dot.ok') &&
    /3 ms/.test(histRows()[0].querySelector('.sql-hist-meta')?.textContent || '') &&
    !!histRows()[1].querySelector('.sql-dot.bad') &&
    (histRows()[1].querySelector('.sql-hist-sql')?.textContent || '').includes('SELECT * FROM rounds'),
);
check(
  'the buttons are Save (save glyph) and Remove (close glyph), titled in the user’s terms',
  !!ghosts(histRows()[0])[0]?.querySelector('.codicon-save') &&
    ghosts(histRows()[0])[0].title === 'Save this line as a query' &&
    !!ghosts(histRows()[0])[1]?.querySelector('.codicon-close') &&
    ghosts(histRows()[0])[1].title === 'Remove this line from history',
);
check(
  'the card keeps its heading and its Clear button',
  (histCard?.querySelector('h2')?.textContent || '').includes('History') &&
    [...(histCard?.querySelectorAll('button') || [])].some((b) => b.textContent.trim() === 'Clear'),
);

console.log('E. a line loads into the editor with a FRESH save form (no stale save tie)');
const nameIn = saveBar.querySelector('input[aria-label="Query name"]');
const descIn = saveBar.querySelector('input[aria-label="Query description"]');
const saveBtn = [...saveBar.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save');
click(savedRows()[0].querySelector('.sql-hist-load'));
await sleep();
check(
  'loading a saved row fills the form (name + description) and ties Save to it',
  nameIn.value === 'openings' && descIn.value === 'opening kills by player',
  `${nameIn.value} / ${descIn.value}`,
);
bindings.resetCalls();
click(ghosts(histRows()[0])[0]); // the line's Save — the load-into-form flow
await sleep();
check('the line’s Save loads its statement into the editor', editor.value === historyFix[0].sql, editor.value);
check(
  '…clears name + description (a history line starts a fresh save)',
  nameIn.value === '' && descIn.value === '',
  JSON.stringify([nameIn.value, descIn.value]),
);
check(
  '…and hands focus to the name field',
  document.activeElement === nameIn,
  document.activeElement?.getAttribute?.('aria-label') || document.activeElement?.tagName || 'none',
);
type(nameIn, 'openings'); // an EXISTING saved name: only a cleared tie inserts here
type(descIn, 'first bloods');
click(saveBtn);
await sleep();
const saves = bindings.calls.filter((c) => c.method === 'SaveQuery');
const ups = bindings.calls.filter((c) => c.method === 'UpdateQuery');
check(
  'naming it after an existing saved row still INSERTS — the stale tie never survives a history load',
  saves.length === 1 && ups.length === 0,
  JSON.stringify({ saves: saves.length, updates: ups.length }),
);
check('the insert carries the loaded line’s statement', saves[0]?.args?.[1] === historyFix[0].sql, String(saves[0]?.args?.[1]));
type(nameIn, 'typed by hand');
click(ghosts(histRows()[1])[0]);
await sleep();
check(
  'the row’s load button loads its statement and clears the form too',
  editor.value === historyFix[1].sql && nameIn.value === '',
  `${editor.value} / ${nameIn.value}`,
);

console.log('F. a line’s Remove deletes it server-side (history is persisted)');
bindings.resetCalls();
const doomed = histRows()[0];
click(ghosts(doomed)[1]);
await sleep();
const dels = bindings.calls.filter((c) => c.method === 'DeleteHistory');
check(
  'Remove calls DeleteHistory with that line’s id',
  dels.length === 1 && dels[0].args[0] === historyFix[0].id,
  JSON.stringify(dels),
);
check(
  'the line leaves the list and its neighbour stays',
  histRows().length === 1 &&
    (histRows()[0].querySelector('.sql-hist-sql')?.textContent || '').includes('FROM rounds'),
  String(histRows().length),
);
check('the removal surfaced no error', !histCard.querySelector('.error'), histCard.querySelector('.error')?.textContent || 'none');

console.log('G. the schema sidebar is an accordion over the live schema');
const tables = [...document.querySelectorAll('.sql-side .sql-table')];
check(
  'every schema table renders as an entry with its name and note affordance',
  tables.length === 2 &&
    tables[0].querySelector('.sql-table-head .mono')?.textContent === 'matches' &&
    tables[0].querySelector('.sql-table-head')?.title === 'one row per imported demo' &&
    !!tables[0].querySelector('.sql-table-head .m5-ib'),
  tables.map((t) => t.querySelector('.sql-table-head .mono')?.textContent).join(','),
);
check(
  'entries start collapsed — a chevron-right caret and no column list',
  tables.every(
    (t) => !t.classList.contains('open') &&
      !!t.querySelector('.sql-table-head .codicon-chevron-right') &&
      !t.querySelector('.sql-cols'),
  ),
);
click(tables[0].querySelector('.sql-table-head'));
await sleep();
check(
  'expanding reveals the columns with their type chips (the noted column carries its info icon)',
  tables[0].classList.contains('open') &&
    !!tables[0].querySelector('.codicon-chevron-down') &&
    [...tables[0].querySelectorAll('.sql-col .mono')].map((c) => c.textContent).join(',') === 'id,map' &&
    tables[0].querySelector('.sql-type')?.textContent === 'INTEGER' &&
    tables[0].querySelectorAll('.sql-col .m5-ib').length === 1,
);
click(tables[0].querySelector('.sql-table-head'));
await sleep();
check('clicking the head again collapses it', !tables[0].classList.contains('open'));
click(tables[0].querySelector('.sql-table-head'));
await sleep();
type(editor, 'SELECT 1');
click([...tables[0].querySelectorAll('.sql-col')].find((c) => c.querySelector('.mono')?.textContent === 'id'));
await sleep();
check('a column click inserts its name into the statement', editor.value.includes('id'), editor.value);

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
await unmount(inst);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
