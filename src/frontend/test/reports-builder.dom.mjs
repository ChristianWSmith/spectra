import './compile-worker-node.mjs';
// jsdom driver for the Reports builder (views/ReportsBuilder.svelte) —
// the template AUTHORING surface: the list with its origin surfacing,
// the editor's read-only/fork/delete rules, the create flow, the
// preview target gate and the viewstate round-trip.
//   A. mount shape — header + help target, the two-panel grid;
//   B. the list: one row per template carrying title, scope, format and
//      ORIGIN chips in the served order, and a trash button on user rows
//      only;
//   C. the origin group + title search narrow the list (client-side —
//      the catalog is single-digit), each empty state distinct;
//   D. the editor: field order (Title / Scope / Format / Template body),
//      the scope + format vocabularies, the monospace power-surface body;
//   E. built-ins are read-only (Save disabled, fields readonly, the
//      chip's title, no delete anywhere) and plugin rows fork on save
//      (payload id "") — the metric editor's rule;
//   F. delete is the user-row control, bottom-LEFT in the actions line
//      while Preview + Save stay right;
//   G. create flow: New → an empty editor → Save sends id "" and the
//      minted row lands in the list, active;
//   H. preview gating: disabled with no target (never fabricated),
//      enabled by the pickers, renders the DRAFT body through
//      RenderReportDraft, and any edit clears the stale document;
//   I. viewstate round-trip through the process-scoped registry.
//
// services.js runs against the shared TEST STUBS (no live Wails
// backend), 'svelte' is pinned to the CLIENT entry so plain `node --test`
// mounts for real — the reports.dom.mjs harness shape.
// jsdom is a declared devDependency of frontend/ — a plain `npm ci`
// there provides it (never `npm i --no-save`). From frontend/ run:
//   node --test test/reports-builder.dom.mjs
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
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement',
  'HTMLTextAreaElement', 'HTMLButtonElement', 'HTMLMediaElement', 'HTMLVideoElement',
  'HTMLAnchorElement', 'SVGElement', 'Element', 'Node', 'Text', 'Comment', 'DocumentFragment',
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

const fileURL = (p) => pathToFileURL(p).href;
const svelteCompile = (src, filename, out) => {
  const code = compile(src, { filename, generate: 'client' }).js.code;
  writeFileSync(out, code);
  return out;
};

const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'reports-builder');
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
  .replace("from '../strings/index.js'", `from '${fileURL('src/lib/strings/index.js')}'`);
svelteCompile(matchPickerSrc, 'MatchPicker.svelte', join(dir, 'matchpicker.js'));
const playerPickerSrc = readFileSync('src/lib/components/PlayerPicker.svelte', 'utf8')
  .replace("from '../fmt.js'", `from '${fileURL('src/lib/fmt.js')}'`)
  .replace("from '../services.js'", `from '${fileURL('src/lib/services.js')}'`)
  .replace("from '../metricstate.js'", `from '${fileURL('src/lib/metricstate.js')}'`)
  .replace("from '../strings/index.js'", `from '${fileURL('src/lib/strings/index.js')}'`);
svelteCompile(playerPickerSrc, 'PlayerPicker.svelte', join(dir, 'playerpicker.js'));
const helpButtonSrc = readFileSync('src/lib/components/HelpButton.svelte', 'utf8').replace(
  "from '../strings/index.js'",
  `from '${fileURL('src/lib/strings/index.js')}'`,
);
svelteCompile(helpButtonSrc, 'HelpButton.svelte', join(dir, 'helpbutton.js'));

// The view: plain-ESM imports resolve from their real module locations
// (services → the stubs, players/viewstate absolute), the .svelte
// imports point at the local bundles.
const rbSrc = readFileSync('src/lib/views/ReportsBuilder.svelte', 'utf8')
  .replace("from '../services.js'", `from '${fileURL('src/lib/services.js')}'`)
  .replace("from '../players.js'", `from '${fileURL('src/lib/players.js')}'`)
  .replace("from '../viewstate.svelte.js'", `from '${fileURL('src/lib/viewstate.svelte.js')}'`)
  .replace("from '../components/MatchPicker.svelte'", "from './matchpicker.js'")
  .replace("from '../components/PlayerPicker.svelte'", "from './playerpicker.js'")
  .replace("from '../components/HelpButton.svelte'", "from './helpbutton.js'")
  .replace("from '../strings/index.js'", `from '${fileURL('src/lib/strings/index.js')}'`);
svelteCompile(rbSrc, 'ReportsBuilder.svelte', join(dir, 'reportsbuilder-bundle.js'));

const { mount, unmount } = await import('svelte');
const mod = await import(pathToFileURL(join(dir, 'reportsbuilder-bundle.js')).href);
const viewstate = await import(pathToFileURL('src/lib/viewstate.svelte.js').href);

const sleep = (ms = 50) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const $ = (sel, scope) => [...(scope || root).querySelectorAll(sel)];
const setInput = async (el, value) => {
  el.value = value;
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await sleep();
};
const setSelect = async (el, value) => {
  el.value = value;
  el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await sleep();
};
const setCheck = async (el, on) => {
  el.checked = on;
  el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await sleep();
};

// --- The scripted backend ---------------------------------------------------
const BUILTIN = {
  id: 'match.md', title: 'Match report', scope: 'match', format: 'md',
  origin: 'builtin', body: 'builtin body',
};
const BUILTIN_HTML = {
  id: 'match.html', title: 'Match report (HTML)', scope: 'match', format: 'html',
  origin: 'builtin', body: '<h1>builtin</h1>',
};
const USER = {
  id: 'my-summary', title: 'My summary', scope: 'player', format: 'html',
  origin: 'user', body: 'user body',
};
const PLUGIN = {
  id: 'plug-tpl', title: 'Plugin report', scope: 'round', format: 'md',
  origin: 'plugin', body: 'plugin body',
};
// The served catalog mutates with the mutators, exactly as the store
// would: a create appends, an update replaces, a delete drops.
let TPLS = [BUILTIN, BUILTIN_HTML, USER, PLUGIN];

const savedPayloads = [];
const deletedIds = [];
const draftCalls = [];
let minted = 0;

bindings.handlers.ListReportTemplates = () => TPLS.map((t) => ({ ...t }));
bindings.handlers.ListMatches = () => [
  {
    id: 13, status: 'ready', map: 'de_cache', scoreCT: 13, scoreT: 9,
    realRounds: 22, durationS: 2400, ctName: 'Alpha', tName: 'Beta',
  },
];
bindings.handlers.ListPlayers = () => [
  { steamId: '76561198000000001', name: 'amy', matches: 3, lastSeen: '' },
  { steamId: '76561198000000002', name: 'bot', matches: 1, isBot: true },
];
bindings.handlers.GetRounds = () => [{ number: 1 }, { number: 2 }, { number: 3 }];
bindings.handlers.SaveReportTemplate = (t) => {
  savedPayloads.push({ ...t });
  // The Go side mints a FRESH slug on every create (de-duped against
  // every id in play) — the stub mirrors that with a counter so the
  // keyed list can never see a duplicate id.
  const saved = { ...t, id: t.id || `minted-template-${++minted}`, origin: 'user' };
  TPLS = t.id ? TPLS.map((x) => (x.id === t.id ? saved : x)) : [...TPLS, saved];
  return saved;
};
bindings.handlers.DeleteReportTemplate = (id) => {
  deletedIds.push(id);
  TPLS = TPLS.filter((x) => x.id !== id);
  return null;
};
// The builtin edit and restore (owner ruling 44): the override replaces the
// body of the one served builtin; restore brings its shipped body back.
const builtinCalls = [];
const SHIPPED_BODY = { 'match.md': 'builtin body' };
bindings.handlers.SaveBuiltinReport = (id, body) => {
  builtinCalls.push({ op: 'save', id, body });
  TPLS = TPLS.map((x) => (x.id === id ? { ...x, body, edited: true } : x));
  return { ...TPLS.find((x) => x.id === id) };
};
bindings.handlers.RestoreBuiltinReport = (id) => {
  builtinCalls.push({ op: 'restore', id });
  TPLS = TPLS.map((x) => (x.id === id ? { ...x, body: SHIPPED_BODY[id], edited: false } : x));
  return { ...TPLS.find((x) => x.id === id) };
};
bindings.handlers.RenderReportDraft = (scope, body, matchId, steamId, round) => {
  draftCalls.push({ scope, body, matchId, steamId, round });
  return `DRAFT ${scope} ${body} ${matchId} ${steamId} ${round}`;
};
const callArgs = (method) =>
  bindings.calls.filter((c) => c.method === method).map((c) => c.args);

let root = null;
let inst = null;
async function mountRB() {
  if (inst) {
    await unmount(inst);
    inst = null;
    root.remove();
  }
  root = document.createElement('div');
  document.body.appendChild(root);
  inst = mount(mod.default, {
    target: root,
    props: { openDocs: (s) => (globalThis.__docs = [...(globalThis.__docs || []), s]) },
  });
  await sleep(160); // mount + the template/match/player reads
  return root;
}

viewstate.resetViewState();
const r = await mountRB();

console.log('A. mount shape — header + help target over the two-panel grid');
{
  check('the header names the view and carries the shared head note',
    r.querySelector('.view-header h1')?.textContent.trim() === 'Reports builder' &&
      !!r.querySelector('.rb-head-note'),
    r.querySelector('.view-header h1')?.textContent.trim());
  const hdr = r.querySelector('.view-header');
  const help = hdr?.querySelector(':scope > button[aria-label="Help for this view"]');
  check('the ? is the header’s LAST element right of the .spacer (shared HelpButton)',
    !!help && hdr.lastElementChild === help && !!hdr.querySelector(':scope > .spacer') &&
      !!help.querySelector('.codicon-question'),
    hdr ? [...hdr.children].map((c) => c.className || c.tagName).join(' | ') : 'no header');
  const docs0 = (globalThis.__docs || []).length;
  click(help);
  await sleep();
  check('clicking it opens the guide at the reports-builder section',
    (globalThis.__docs || []).length === docs0 + 1 &&
      (globalThis.__docs || []).at(-1) === 'reports-builder',
    JSON.stringify((globalThis.__docs || []).slice(docs0)));
  check('ONE .rb-grid holds the list panel and a right column of editor + preview',
    !!r.querySelector('.rb-grid > .panel.rb-list') &&
      !!r.querySelector('.rb-grid > .rb-right > section.panel:not(.rb-preview)') &&
      !!r.querySelector('.rb-grid > .rb-right > section.panel.rb-preview'),
    r.querySelector('.rb-grid') ? 'shaped' : 'no .rb-grid');
}

console.log('B. the list renders every template with its origin chip, in the served order');
{
  const rows = $('.rb-row');
  check('four rows, one per served template',
    rows.length === 4, `${rows.length} rows`);
  check('titles render in the served order',
    rows.map((x) => x.querySelector('.rb-row-title').textContent.trim()).join('|') ===
      'Match report|Match report (HTML)|My summary|Plugin report',
    rows.map((x) => x.querySelector('.rb-row-title').textContent.trim()).join('|'));
  check('every row carries scope, format AND origin chips',
    rows.every((x) => {
      const chips = [...x.querySelectorAll('.rb-row-sub .chip')].map((c) => c.textContent.trim());
      return chips.length === 3;
    }),
    rows.map((x) => [...x.querySelectorAll('.rb-row-sub .chip')].map((c) => c.textContent.trim()).join('/')).join(' | '));
  const origins = rows.map((x) => x.querySelectorAll('.rb-row-sub .chip')[2].textContent.trim());
  check('the origin chips read builtin / user / plugin — the row’s own origin word',
    JSON.stringify(origins) === JSON.stringify(['builtin', 'builtin', 'user', 'plugin']),
    JSON.stringify(origins));
  const withTrash = rows.filter((x) => x.querySelector('.rb-row-acts .codicon-trash'));
  check('only the user row carries a trash button (built-ins and plugins never do)',
    withTrash.length === 1 &&
      withTrash[0].querySelector('.rb-row-title').textContent.trim() === 'My summary',
    `${withTrash.length} trash rows`);
}

console.log('C. the origin group and the title search narrow the list (client-side)');
{
  const boxes = $('.rb-filters input[type="checkbox"]');
  check('the Origin group starts UNFILTERED — all three boxes checked',
    boxes.length === 3 && boxes.every((b) => b.checked), `${boxes.length} boxes`);
  const search = $('.rb-list input[type="search"]')[0];
  await setCheck(boxes[0], false); // Built-in off
  check('Built-in off → the two non-built-ins remain',
    $('.rb-row').length === 2 &&
      !r.textContent.includes('Match report'),
    `${$('.rb-row').length} rows`);
  await setCheck(boxes[1], false); // Custom off
  check('Custom off too → only the plugin row',
    $('.rb-row').length === 1 &&
      $('.rb-row')[0].querySelector('.rb-row-title').textContent.trim() === 'Plugin report',
    `${$('.rb-row').length} rows`);
  await setCheck(boxes[2], false); // Plugin off
  check('every box off → the honest empty state, never a blank panel',
    $('.rb-row').length === 0 &&
      r.textContent.includes('No templates to show.'),
    r.querySelector('.rb-list')?.textContent.slice(0, 120));
  await setCheck(boxes[0], true);
  await setCheck(boxes[1], true);
  await setCheck(boxes[2], true);
  check('all three back on → the whole catalog returns',
    $('.rb-row').length === 4, `${$('.rb-row').length} rows`);
  await setInput(search, 'my');
  check('the title search narrows by title',
    $('.rb-row').length === 1 &&
      $('.rb-row')[0].querySelector('.rb-row-title').textContent.trim() === 'My summary',
    `${$('.rb-row').length} rows`);
  await setInput(search, 'zzz');
  check('a search that matches nothing names the query instead of a blank list',
    $('.rb-row').length === 0 && r.textContent.includes('No templates match'),
    r.querySelector('.rb-list')?.textContent.slice(0, 140));
  await setInput(search, '');
}

console.log('D. the editor form — field order and vocabularies');
{
  const labels = $('.rb-fields .field-label').map((l) => l.textContent.trim());
  check('field order is Title, Scope, Format, Template body',
    JSON.stringify(labels) === JSON.stringify(['Title', 'Scope', 'Format', 'Template body']),
    JSON.stringify(labels));
  const scope = $('#rb-scope')[0];
  check('the Scope select offers exactly match / player / round in that order',
    [...scope.options].map((o) => o.value).join(',') === 'match,player,round',
    [...scope.options].map((o) => o.value).join(','));
  const format = $('#rb-format')[0];
  check('the Format select offers exactly md / html',
    [...format.options].map((o) => o.value).join(',') === 'md,html',
    [...format.options].map((o) => o.value).join(','));
  const body = $('#rb-body')[0];
  check('the body is a monospace, unspellchecked power surface with no chrome hint',
    body.classList.contains('mono') && body.getAttribute('spellcheck') === 'false' &&
      !body.getAttribute('placeholder'),
    `${body.className} / placeholder=${body.getAttribute('placeholder')}`);
  check('the editor starts on the New template card with an empty user form',
    r.querySelector('.rb-right h2')?.textContent.trim() === 'New template' &&
      $('#rb-title')[0].value === '' && !r.querySelector('.rb-readonly'),
    r.querySelector('.rb-right h2')?.textContent.trim());
}

console.log('E. built-ins edit in place (owner ruling 44); plugin rows fork on save');
{
  // Load the built-in.
  click($('.rb-row')[0].querySelector('.rb-row-main'));
  await sleep();
  // The editor's own chips (the list rows carry their own edited marks).
  const hasChip = (text) => [...r.querySelectorAll('.rb-right .chip')].some((c) => c.textContent.trim() === text);
  check('the built-in loads with its built-in chip, unedited, and Save disabled while clean',
    r.querySelector('.rb-readonly')?.textContent.trim() === 'built-in' &&
      !hasChip('edited') &&
      $('.rb-actions button.primary')[0].disabled === true,
    `${r.querySelector('.rb-readonly')?.textContent.trim()} / disabled=${$('.rb-actions button.primary')[0].disabled}`);
  check('its text is editable; its title, scope and format stay as shipped (readonly / disabled)',
    $('#rb-body')[0].readOnly === false && $('#rb-title')[0].readOnly === true &&
      $('#rb-scope')[0].disabled === true && $('#rb-format')[0].disabled === true,
    `body RO=${$('#rb-body')[0].readOnly} title RO=${$('#rb-title')[0].readOnly} scope disabled=${$('#rb-scope')[0].disabled}`);
  check('an unedited built-in offers no restore control',
    [...r.querySelectorAll('.rb-destructive button')].every((b) => b.textContent.trim() !== 'Restore to default'),
    '');
  check('a built-in never offers a delete anywhere',
    $('.rb-actions .codicon-trash').length === 0 &&
      $('.rb-row')[0].querySelector('.codicon-trash') === null,
    `actions=${$('.rb-actions .codicon-trash').length} row0=${!!$('.rb-row')[0].querySelector('.codicon-trash')}`);

  // Edit the text and save: the edit is stored as the built-in's override.
  const EDIT = 'builtin body\n<!-- my edit -->';
  await setInput($('#rb-body')[0], EDIT);
  check('editing the text enables Save', $('.rb-actions button.primary')[0].disabled === false, '');
  click($('.rb-actions button.primary')[0]);
  await sleep(80);
  const saveCall = builtinCalls.at(-1);
  check('Save stores the edit as the built-in override: SaveBuiltinReport(id, text)',
    saveCall?.op === 'save' && saveCall.id === 'match.md' && saveCall.body === EDIT,
    JSON.stringify(saveCall));
  check('after the save the built-in shows the edited chip, Save is clean, and the list marks it',
    hasChip('edited') && $('.rb-actions button.primary')[0].disabled === true &&
      $('.rb-row')[0].textContent.includes('edited'),
    `edited=${hasChip('edited')} disabled=${$('.rb-actions button.primary')[0].disabled}`);
  check('the edited built-in offers Restore to default beside Save',
    [...r.querySelectorAll('.rb-destructive button')].some((b) => b.textContent.trim() === 'Restore to default'),
    '');

  // Restore to default: the override is deleted and the shipped text comes back.
  const restoreBtn = [...r.querySelectorAll('.rb-destructive button')].find((b) => b.textContent.trim() === 'Restore to default');
  click(restoreBtn);
  await sleep(80);
  const restoreCall = builtinCalls.at(-1);
  check('Restore to default calls RestoreBuiltinReport and the shipped text is back in the editor',
    restoreCall?.op === 'restore' && restoreCall.id === 'match.md' && $('#rb-body')[0].value === SHIPPED_BODY['match.md'] &&
      !hasChip('edited'),
    `${JSON.stringify(restoreCall)} body=${$('#rb-body')[0].value}`);
  check('the restored built-in is unedited again: Save disabled, no restore control',
    $('.rb-actions button.primary')[0].disabled === true &&
      [...r.querySelectorAll('.rb-destructive button')].every((b) => b.textContent.trim() !== 'Restore to default'),
    '');
  // Load the plugin row (last row).
  click($('.rb-row')[3].querySelector('.rb-row-main'));
  await sleep();
  check('the plugin row wears the read-only source chip and keeps Save live (it forks)',
    r.querySelector('.rb-readonly')?.textContent.trim() === 'read-only source' &&
      r.querySelector('.rb-readonly').getAttribute('title')?.startsWith('Plugin templates are read-only') &&
      $('.rb-actions button.primary')[0].disabled === false,
    `${r.querySelector('.rb-readonly')?.textContent.trim()} / disabled=${$('.rb-actions button.primary')[0].disabled}`);
  const before = savedPayloads.length;
  click($('.rb-actions button.primary')[0]);
  await sleep(80);
  const payload = savedPayloads[before];
  check('saving a plugin row sends id "" — a fork, never a write to the source',
    !!payload && payload.id === '' && payload.origin === 'user',
    JSON.stringify(payload));
  check('the fork lands as your own row — the read-only chip is gone and the editor holds it',
    !!payload && r.querySelector('.rb-readonly') === null &&
      $('.rb-row.active').length === 1,
    `chip=${r.querySelector('.rb-readonly')?.textContent.trim()} active=${$('.rb-row.active').length}`);
}

console.log('F. delete is the user control — bottom-left, positives right');
{
  // Select the original user row (title "My summary" — the fork above
  // appended a fifth row, so find it by title).
  const userRow = $('.rb-row').find(
    (x) => x.querySelector('.rb-row-title').textContent.trim() === 'My summary',
  );
  click(userRow.querySelector('.rb-row-main'));
  await sleep();
  const actions = $('.rb-actions')[0];
  check('the actions line puts the destructive slot LEFT and Preview + Save RIGHT',
    actions.firstElementChild.classList.contains('rb-destructive') &&
      !!actions.lastElementChild.classList.contains('toolbar') &&
      !!actions.querySelector('.rb-destructive .codicon-trash'),
    [...actions.children].map((c) => c.className).join(' | '));
  check('the editor delete names the row it deletes',
    actions.querySelector('.rb-destructive button').getAttribute('aria-label') === 'Delete My summary',
    actions.querySelector('.rb-destructive button').getAttribute('aria-label'));
  check('the user row offers NO read-only chip',
    r.querySelector('.rb-readonly') === null,
    r.querySelector('.rb-readonly')?.textContent.trim());
  const before = deletedIds.length;
  click(actions.querySelector('.rb-destructive button'));
  await sleep(120);
  check('deleting calls DeleteReportTemplate with the row id and the row leaves',
    deletedIds.length === before + 1 && deletedIds[before] === 'my-summary' &&
      !$('.rb-row').some((x) => x.querySelector('.rb-row-title').textContent.trim() === 'My summary'),
    JSON.stringify(deletedIds.slice(before)));
  check('the editor falls back to a fresh New template card after the delete',
    r.querySelector('.rb-right h2')?.textContent.trim() === 'New template',
    r.querySelector('.rb-right h2')?.textContent.trim());
}

console.log('G. create flow — New, the fields, Save sends id "" and the row lands');
{
  click($('.rb-list .row-between button')[0]); // New
  await sleep();
  check('New resets the editor to an empty user form with no chip and no delete',
    r.querySelector('.rb-right h2')?.textContent.trim() === 'New template' &&
      $('#rb-title')[0].value === '' && !r.querySelector('.rb-readonly') &&
      $('.rb-actions .codicon-trash').length === 0,
    `${r.querySelector('.rb-right h2')?.textContent.trim()} trash=${$('.rb-actions .codicon-trash').length}`);
  await setInput($('#rb-title')[0], 'Round recap');
  await setSelect($('#rb-scope')[0], 'round');
  await setSelect($('#rb-format')[0], 'md');
  await setInput($('#rb-body')[0], 'round body {{.Match.Map}}');
  const before = savedPayloads.length;
  click($('.rb-actions button.primary')[0]);
  await sleep(140);
  const payload = savedPayloads[before];
  check('Save sends the whole form with id "" and origin "user" (Go mints the id)',
    !!payload && payload.id === '' && payload.origin === 'user' &&
      payload.title === 'Round recap' && payload.scope === 'round' &&
      payload.format === 'md' && payload.body === 'round body {{.Match.Map}}',
    JSON.stringify(payload));
  check('the minted template lands in the list and the editor holds it',
    !!payload &&
      $('.rb-row').some((x) => x.querySelector('.rb-row-title').textContent.trim() === 'Round recap') &&
      r.querySelector('.rb-right h2')?.textContent.trim() === 'Edit template',
    `${$('.rb-row').length} rows / ${r.querySelector('.rb-right h2')?.textContent.trim()}`);
  check('a clean stored row reads Saved on the button',
    $('.rb-actions button.primary')[0].textContent.includes('Saved'),
    $('.rb-actions button.primary')[0].textContent.trim());
}

console.log('H. preview gating — never a fabricated target, the DRAFT body renders');
{
  viewstate.resetViewState();
  const p = await mountRB();
  const previewBtn = () => $('.rb-actions .toolbar button')[0]; // Play leads Preview
  check('Preview is DISABLED on a fresh mount — no target is chosen for you',
    previewBtn().disabled === true &&
      p.textContent.includes('Pick a target to preview'),
    `disabled=${previewBtn().disabled}`);
  check('the preview button leads with the PLAY codicon',
    previewBtn().firstElementChild.classList.contains('codicon-play'),
    previewBtn().firstElementChild?.className);
  // A body with no target is still not previewable (never fabricated).
  await setInput($('#rb-body')[0], 'draft body only');
  check('a typed body with no target stays gated',
    previewBtn().disabled === true,
    `disabled=${previewBtn().disabled}`);
  // Pick the match through the canonical MatchPicker.
  click($('.mp-trigger')[0]);
  await sleep(60);
  click($('.mp-opt')[0]);
  await sleep(80);
  check('picking a match enables Preview (still no render yet)',
    previewBtn().disabled === false && $('.rb-doc').length === 0,
    `disabled=${previewBtn().disabled} docs=${$('.rb-doc').length}`);
  const before = draftCalls.length;
  click(previewBtn());
  await sleep(100);
  const call = draftCalls[before];
  check('Preview calls RenderReportDraft with the DRAFT body and the chosen match',
    !!call && call.body === 'draft body only' && call.scope === 'match' && call.matchId === 13,
    JSON.stringify(call));
  check('the composed document renders in the preview panel',
    $('.rb-doc').length === 1 && $('.rb-doc')[0].textContent.startsWith('DRAFT match'),
    $('.rb-doc')[0]?.textContent.slice(0, 60));
  await setInput($('#rb-body')[0], 'edited');
  check('editing the body clears the stale document (never a preview of an older draft)',
    $('.rb-doc').length === 0 &&
      p.textContent.includes('Nothing previewed yet'),
    `${$('.rb-doc').length} docs`);
  // Player scope: the player field appears and gates the preview.
  await setSelect($('#rb-scope')[0], 'player');
  check('player scope adds a player field and gates Preview until it is chosen',
    !!$('#rb-player')[0] && previewBtn().disabled === true,
    `player=${!!$('#rb-player')[0]} disabled=${previewBtn().disabled}`);
  click($('.pp-trigger')[0]);
  await sleep(60);
  check('the player list offers only humans (the bot row never offers itself)',
    $('.pp-opt').length === 1 && $('.pp-opt')[0].textContent.includes('amy'),
    `${$('.pp-opt').length} options`);
  click($('.pp-opt')[0]);
  await sleep(80);
  check('choosing the player re-enables Preview',
    previewBtn().disabled === false &&
      $('.pp-trigger')[0].textContent.includes('amy'),
    `disabled=${previewBtn().disabled} trigger=${$('.pp-trigger')[0].textContent.trim()}`);
  // Round scope: the round field states the counted range.
  await setSelect($('#rb-scope')[0], 'round');
  check('round scope adds a round field stating the counted range (1..3)',
    !!$('#rb-round')[0] && p.querySelector('.rb-hint')?.textContent.trim() === '1..3',
    p.querySelector('.rb-hint')?.textContent.trim());
}

console.log('I. viewstate round-trip through the process-scoped registry');
{
  viewstate.resetViewState();
  await mountRB();
  await setInput($('.rb-list input[type="search"]')[0], 'my');
  await setInput($('#rb-title')[0], 'Restored title');
  await setInput($('#rb-body')[0], 'restored body');
  click($('.mp-trigger')[0]);
  await sleep(60);
  click($('.mp-opt')[0]);
  await sleep(80);
  await unmount(inst);
  inst = null;
  root.remove();
  const b = await mountRB(); // same process — the registry survives
  check('the search text, the form and the preview target all restore',
    $('.rb-list input[type="search"]')[0].value === 'my' &&
      $('#rb-title')[0].value === 'Restored title' &&
      $('#rb-body')[0].value === 'restored body' &&
      !!b.querySelector('.mp-trigger-map'),
    `query=${$('.rb-list input[type="search"]')[0].value} title=${$('#rb-title')[0].value}`);
  check('the restored target keeps Preview live (nothing was fabricated in between)',
    $('.rb-actions .toolbar button')[0].disabled === false,
    `disabled=${$('.rb-actions .toolbar button')[0].disabled}`);
  viewstate.resetViewState();
  await mountRB();
  check('resetViewState() → a fresh mount starts empty with no target',
    $('.rb-list input[type="search"]')[0].value === '' &&
      $('#rb-title')[0].value === '' &&
      $('.rb-actions .toolbar button')[0].disabled === true,
    `query=${$('.rb-list input[type="search"]')[0].value} title=${$('#rb-title')[0].value}`);
}

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
if (inst) await unmount(inst);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
