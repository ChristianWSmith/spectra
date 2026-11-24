import './compile-worker-node.mjs';
// jsdom driver for the SQL console (help-buttons wave, 2026-11-15, then
// the sql-history wave = changes.txt C2 + C3, 2026-11-15, then the
// sql-settings wave = S1–S3, 2026-11-16). Sections A/B are the shared
// HelpButton's mount coverage — the `?` is the header's LAST element,
// right of the .spacer (and the running chip while a query is in
// flight), and clicking it hands App's openDocs the `sql-console`
// section id. C–I pin the console's own surface: the save form, the
// Export popover and Run sharing ONE toolbar in the Statement card,
// history lines as rows with a click-to-load body (a FRESH save form —
// a stale tie would silently update another saved row) and per-line
// Remove (a server delete), the results grid paging its rows through
// the footer's Prev/Next (the export still carries every returned row),
// and the schema accordion.
//
// The console's reads are scripted: the three mount-time reads (schema,
// history, saved queries) plus ONE run over a 25-row fixture (sections
// H/I) — the engine itself is pinned in Go (session_test.go /
// query_store_test.go), the loading lines in
// progress-presentation.dom.mjs.
//
// jsdom is a declared devDependency of frontend/ — a plain `npm ci`
// there provides it (never `npm i --no-save`, which makes the next
// `npm ci` prune it). From frontend/ run:
//   node --test test/sqlconsole.dom.mjs
// (must be run with frontend/ as the working directory)
import { JSDOM } from 'jsdom';
import { compile, compileModule } from 'svelte/compiler';
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
// The ONE scripted run (sections H/I): 25 rows so a three-page grid and
// an export over every row are observable at all — the grid's paging is
// what the checks drive, never the engine.
const runFixture = () => ({
  columns: ['id'],
  rows: Array.from({ length: 25 }, (_, i) => [i + 1]),
  ms: 4,
  rowCount: 25,
  truncated: false,
});
bindings.handlers.Run = runFixture;
// The export path ends at the native save dialog (lib/save.js): the
// dialog resolves a path, WriteFile lands the bytes — both recorded so
// sections H/I can read back what was offered and written.
bindings.DialogService.SaveFile = (name, exts) => {
  bindings.calls.push({ method: 'SaveFile', args: [name, exts] });
  return Promise.resolve('/x/out');
};
bindings.DialogService.WriteFile = (path, data) => {
  bindings.calls.push({ method: 'WriteFile', args: [path, data] });
  return Promise.resolve(null);
};

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
// SourceEditor — the statement box. Monaco is a browser module that does not
// load under jsdom, so the component falls back to its textarea here (the id and
// the bound value the driver reads are the same either way).
svelteCompile(
  readFileSync('src/lib/components/SourceEditor.svelte', 'utf8').replace(
    "from '../editor/monaco.js'",
    `from '${fileURL('src/lib/editor/monaco.js')}'`,
  ),
  'SourceEditor.svelte',
  join(dir, 'sourceeditor.js'),
);
// Popover — the export panel's anchor/dismissal component (no imports
// of its own, so a plain compile is the whole bundle).
svelteCompile(
  readFileSync('src/lib/components/Popover.svelte', 'utf8'),
  'Popover.svelte',
  join(dir, 'popover.js'),
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
for (const rel of ['services.js', 'download.js', 'csv.js', 'viewstate.svelte.js', 'strings/index.js', 'editor/sqlCompletions.js', 'editor/completionSources.js']) {
  sqlSrc = sqlSrc.split(`from '../${rel}'`).join(`from '${fileURL(`src/lib/${rel}`)}'`);
}
sqlSrc = sqlSrc.split("from '../components/StatusChip.svelte'").join("from './statuschip.js'");
sqlSrc = sqlSrc.split("from '../components/HelpButton.svelte'").join("from './helpbutton.js'");
sqlSrc = sqlSrc.split("from '../components/Popover.svelte'").join("from './popover.js'");
sqlSrc = sqlSrc.split("from '../components/SourceEditor.svelte'").join("from './sourceeditor.js'");
// The load state (a runes module) and the shell (a component) the view imports, compiled beside it.
writeFileSync(join(dir, 'loadstate.svelte.js'), compileModule(readFileSync('src/lib/loadstate.svelte.js', 'utf8'), { filename: 'loadstate.svelte.js', generate: 'client' }).js.code);
svelteCompile(readFileSync('src/lib/components/LoadBox.svelte', 'utf8').replace("from '../componentruntime/sizememory.js'", `from '${fileURL('src/lib/componentruntime/sizememory.js')}'`), 'LoadBox.svelte', join(dir, 'loadbox.js'));
sqlSrc = sqlSrc.replace("from '../loadstate.svelte.js'", `from '${fileURL(join(dir, 'loadstate.svelte.js'))}'`).replace("from '../components/LoadBox.svelte'", "from './loadbox.js'");
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

console.log('C. the save form, the Export control and Run share ONE toolbar in the Statement card');
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
  'the card has exactly ONE toolbar — the save bar — sitting after the textarea',
  cardToolbars.length === 1 &&
    cardToolbars[0] === saveBar &&
    kids.indexOf(editor) >= 0 &&
    kids.indexOf(editor) < kids.indexOf(saveBar),
  cardToolbars.map((t) => t.className).join(' | '),
);
check(
  'it carries the name and description inputs and the Save button (save group first)',
  !!saveBar?.querySelector('input[aria-label="Query name"]') &&
    !!saveBar.querySelector('input[aria-label="Query description"]') &&
    [...saveBar.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Save'),
);
// The right cluster: the Export host first, Run LAST (rightmost), with
// the keyboard shortcut living on Run's tooltip — the old .sql-hint
// span is gone with the second toolbar.
const rightCluster = saveBar?.querySelector('.sql-actions-right');
const runBtn = rightCluster?.querySelector('button.primary');
const exportBtn = rightCluster?.querySelector('button[aria-haspopup="true"]');
check(
  'the right cluster parks Export then Run (Run rightmost) with the shortcut on Run’s title',
  !!rightCluster &&
    !!rightCluster.firstElementChild?.classList.contains('sql-pop-host') &&
    !!runBtn &&
    rightCluster.lastElementChild === runBtn &&
    /Ctrl\/Cmd\+Enter/.test(runBtn.getAttribute('title') || ''),
  rightCluster ? [...rightCluster.children].map((c) => c.className).join(' | ') : 'no cluster',
);
// W17 (owner, 2026-11-16): the run codicon LEADS the label (the play
// glyph was retired with the move — "run codicon left of the text").
// The busy branch keeps its plain "Running…" (the busy-button
// exemption) — no icon either side of that word.
check(
  'Run leads with the run codicon before its label (icon-left); Running… stays plain text',
  !!runBtn &&
    runBtn.firstElementChild?.classList.contains('codicon-run') &&
    runBtn.textContent.trim() === 'Run' &&
    !runBtn.querySelector('.codicon-play'),
  runBtn ? `${runBtn.firstElementChild?.className} :: ${JSON.stringify(runBtn.textContent)}` : 'no Run button',
);
check(
  'the Export trigger is the canonical popover host (aria trio, disabled until a result exists)',
  !!exportBtn &&
    exportBtn.disabled &&
    exportBtn.getAttribute('aria-expanded') === 'false' &&
    !exportBtn.hasAttribute('aria-controls') &&
    (exportBtn.getAttribute('title') || '').length > 0,
  exportBtn ? `disabled=${exportBtn.disabled} expanded=${exportBtn.getAttribute('aria-expanded')}` : 'no trigger',
);
check('no .sql-hint shortcut span anywhere (the shortcut is Run’s title)', !document.querySelector('.sql-hint'));
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
  'a save error renders in the Statement card, as the merged toolbar’s next sibling',
  !!saveErr && saveErr.classList.contains('error') &&
    /name is required/i.test(saveErr.textContent) && stmtCard.contains(saveErr),
  saveErr ? `${saveErr.className} ${saveErr.textContent.trim()}` : 'none',
);

console.log('D. each history line is a row: a load body plus Remove');
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
  'each row = one load button + ONE ghost button (Remove), with no button inside a button',
  histRows().every((r) => {
    const load = r.querySelector(':scope > .sql-hist-load');
    return !!load && ghosts(r).length === 1 && !load.querySelector('button');
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
  'the one ghost button is Remove (close glyph), titled in the user’s terms',
  !!ghosts(histRows()[0])[0]?.querySelector('.codicon-close') &&
    ghosts(histRows()[0])[0].title === 'Remove this line from history',
  ghosts(histRows()[0]).map((b) => b.title).join(' | '),
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
click(histRows()[0].querySelector('.sql-hist-load')); // the line's BODY — the only load path left
await sleep();
check('a history line’s body loads its statement into the editor', editor.value === historyFix[0].sql, editor.value);
check(
  '…and clears name + description (a history line starts a fresh save form)',
  nameIn.value === '' && descIn.value === '',
  JSON.stringify([nameIn.value, descIn.value]),
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
click(histRows()[1].querySelector('.sql-hist-load'));
await sleep();
check(
  'the other line’s body loads its statement and clears the form too',
  editor.value === historyFix[1].sql && nameIn.value === '',
  `${editor.value} / ${nameIn.value}`,
);

console.log('F. a line’s Remove deletes it server-side (history is persisted)');
bindings.resetCalls();
const doomed = histRows()[0];
click(ghosts(doomed)[0]); // the row's ONE ghost button — Remove
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

console.log('H. the results grid pages its rows — one page at a time, every row reachable');
bindings.resetCalls();
click(runBtn);
await sleep(80);
const resultPanel = panelByHeading('Results');
const gridRows = () => [...resultPanel.querySelectorAll('tbody tr')];
// The card has TWO .row-between children: the heading/chips header and
// the pager footer — the footer is the LAST one.
const footerRows = () => [...resultPanel.querySelectorAll(':scope > .row-between')];
const pager = () => footerRows()[footerRows().length - 1];
const pagerText = () => pager()?.querySelector('.muted')?.textContent.replace(/\s+/g, ' ').trim();
const pagerBtn = (label) =>
  [...(pager()?.querySelectorAll('button') || [])].find((b) => b.textContent.trim() === label);
const firstCell = () => gridRows()[0]?.querySelector('td')?.textContent;
check(
  'running renders ONE page of the result — 10 of 25 rows, footer naming the absolute range',
  gridRows().length === 10 && pagerText() === 'Rows 1–10 of 25' && firstCell() === '1',
  `${gridRows().length} rows / ${pagerText()} / first=${firstCell()}`,
);
check(
  'Prev waits at the first page while Next steps on',
  !!pagerBtn('Prev') && pagerBtn('Prev').disabled && !pagerBtn('Next').disabled,
  `prev=${pagerBtn('Prev')?.disabled} next=${pagerBtn('Next')?.disabled}`,
);
check(
  'the grid carries no render-cap note (the pager walks every returned row)',
  !resultPanel.querySelector('.sql-note') && !/first 2,000|first 2000/.test(document.body.textContent),
);
click(pagerBtn('Next'));
await sleep();
check(
  'Next → rows 11–20 with Prev armed',
  gridRows().length === 10 && pagerText() === 'Rows 11–20 of 25' &&
    firstCell() === '11' && !pagerBtn('Prev').disabled,
  `${gridRows().length} / ${pagerText()} / first=${firstCell()}`,
);
click(pagerBtn('Next'));
await sleep();
check(
  'the last page holds the remainder and disarms Next',
  gridRows().length === 5 && pagerText() === 'Rows 21–25 of 25' &&
    firstCell() === '21' && pagerBtn('Next').disabled,
  `${gridRows().length} / ${pagerText()} / first=${firstCell()}`,
);
click(pagerBtn('Prev'));
await sleep();
check('Prev walks back to the middle page', pagerText() === 'Rows 11–20 of 25', pagerText());
click(runBtn);
await sleep(80);
check(
  'a re-run resets the grid to the first page',
  pagerText() === 'Rows 1–10 of 25' && pagerBtn('Prev').disabled,
  pagerText(),
);
bindings.handlers.Run = () => ({
  columns: ['id'],
  rows: [[1], [2], [3]],
  ms: 1,
  rowCount: 3,
  truncated: false,
});
click(runBtn);
await sleep(80);
check(
  'a single-page result shows no pager at all',
  footerRows().length === 1 && gridRows().length === 3,
  `${footerRows().length} .row-between, ${gridRows().length} rows`,
);

console.log('I. the Export control is ONE popover offering JSON then CSV (the canonical idiom)');
// Back on the 25-row result: H's last run left the single-page fixture,
// and the export pins read what actually crosses the save dialog.
bindings.handlers.Run = runFixture;
click(runBtn);
await sleep(80);
check('the Export trigger arms once a result exists', !!exportBtn && !exportBtn.disabled, String(exportBtn?.disabled));
click(exportBtn);
await sleep();
const pop = document.getElementById('sql-export-pop');
check(
  'the panel opens under its host as the JSON-then-CSV stack',
  !!pop && pop.classList.contains('sql-pop') &&
    pop.closest('.sql-pop-host') === rightCluster.firstElementChild &&
    [...pop.querySelectorAll('button')].map((b) => b.textContent.trim()).join(' → ') === 'JSON → CSV',
  pop ? [...pop.querySelectorAll('button')].map((b) => b.textContent.trim()).join(',') : 'no panel',
);
check(
  'the trigger reports the open state (aria-expanded + aria-controls)',
  exportBtn.getAttribute('aria-expanded') === 'true' &&
    exportBtn.getAttribute('aria-controls') === 'sql-export-pop',
  `expanded=${exportBtn.getAttribute('aria-expanded')} controls=${exportBtn.getAttribute('aria-controls')}`,
);
document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await sleep();
check(
  'Escape closes the panel and returns focus to the trigger',
  !document.getElementById('sql-export-pop') && document.activeElement === exportBtn,
  document.activeElement?.tagName || 'none',
);
bindings.resetCalls();
click(exportBtn);
await sleep();
click(
  [...document.getElementById('sql-export-pop').querySelectorAll('button')].find(
    (b) => b.textContent.trim() === 'JSON',
  ),
);
await sleep();
const jsonSaves = bindings.calls.filter((c) => c.method === 'SaveFile');
const jsonWrite = bindings.calls.find((c) => c.method === 'WriteFile');
const jsonPayload = jsonWrite
  ? JSON.parse(Buffer.from(jsonWrite.args[1], 'base64').toString('utf8'))
  : null;
check(
  'picking JSON closes the panel and offers a .json name to the save dialog',
  jsonSaves.length === 1 && /\.json$/.test(jsonSaves[0].args[0]) &&
    !document.getElementById('sql-export-pop'),
  JSON.stringify(jsonSaves.map((c) => c.args[0])),
);
check(
  'the JSON carries EVERY returned row, not just the page on screen',
  !!jsonPayload && jsonPayload.columns[0] === 'id' && jsonPayload.rows.length === 25,
  jsonPayload ? String(jsonPayload.rows.length) : 'no payload',
);
bindings.resetCalls();
click(exportBtn);
await sleep();
click(
  [...document.getElementById('sql-export-pop').querySelectorAll('button')].find(
    (b) => b.textContent.trim() === 'CSV',
  ),
);
await sleep();
const csvSaves = bindings.calls.filter((c) => c.method === 'SaveFile');
check(
  'picking CSV offers a .csv name through the same dialog',
  csvSaves.length === 1 && /\.csv$/.test(csvSaves[0].args[0]),
  JSON.stringify(csvSaves.map((c) => c.args[0])),
);

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
await unmount(inst);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
