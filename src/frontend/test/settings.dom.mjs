// jsdom driver for the Settings view — the analysis-rules card's save
// flow (save = recompute, the metrics-save precedent), the surfaces
// this wave removed, and (w20) the icon-button wave + the plugin row
// and source row the plugin fixture finally makes observable:
//   A. Pristine gating + card shape: with the loaded rules unchanged,
//      Save is disabled and the status slot reads "No changes" (never a
//      recompute note); any edit of the four fields arms Save; reverting
//      disarms again. The four fields are present, Save is the card's
//      only button and it rides a .row-between with the status slot at
//      left (a direct panel child would stretch full width), and the
//      card renders NO rules-version display (internal-only since
//      2026-11-15) and no dirty-state hint.
//   B. The re-run UI is gone: no "Re-run analysis…" subsection, no
//      Re-run-all button, no per-row list, no Load more, no behind
//      count line — and the view performs NO behind fetches at all
//      (zero ListMatchesPage / CountMatches / RecomputeStates calls,
//      including after a spectra:analysis-done event). The Stat
//      definitions card is gone with it (its guide bullet died in the
//      same change — docslockstep pins that census).
//   C. Save = recompute: a save whose ruleVersion bumped kicks
//      RecomputeAll in the background — exactly once, with NO
//      confirmation dialog — and says so in the status slot.
//   D. Save honesty on the no-bump path: the server judged the values
//      identical → "No changes — the rules were already saved with
//      these values.", and NO recompute is kicked.
//   E. Parallel work: the 1..max numeric control in its OWN
//      "Background work" card (the import-scoped control is gone) —
//      bounds seeded from the backend, in-range values passed
//      verbatim, out-of-range clamped to the ceiling before the Set,
//      garbage clamped to 1 (never 0 — it would stall the budget).
//   F. No runtime errors over the whole run.
//   G. Replay loop length: the 1..60 numeric control in its OWN
//      "Replay" card — present with its label, min/max, seeded from the
//      pref read (unset → the default 5), NO write on a plain mount,
//      an in-range value written verbatim, and the clamps (above the
//      ceiling → 60, below the floor → 1, garbage → the default).
//      G runs just BEFORE F's whole-run error check (F stays last —
//      H, I and J sit in front of it too).
//   H. Settings action buttons (w20 icon-wave): the About/Data/
//      Import-dirs/CS2-assets/Audio/Analysis-rules buttons — every
//      label still present WITH its decorative glyph (codicon-sync/
//      trash/folder/discard/download/check/save), its gating (disabled
//      while pristine / no install / defaults in effect / empty demo
//      list) and its title, except the import-dir remove row, which is
//      ICON-ONLY (empty textContent, codicon-trash, the dir aria-label
//      kept, the word surviving verbatim as its title).
//   I. Plugin rows (the pin gap this section closes — ListPlugins was
//      stubbed EMPTY, so a plugin row never rendered): a fixture
//      renders one row — its structure, the enable toggle's TEXT form
//      (aria-pressed + title, exempt from the icon rule), the Remove
//      action now ICON-ONLY (codicon-trash + aria-label + title, empty
//      textContent) — deliberately — and the shared ConfirmDialog flow
//      (cancel removes nothing; confirm calls RemovePlugin with the id
//      and the row leaves).
//   J. The plugin source row: the READ-ONLY path display (no free
//      typing — the placeholder input is gone) and BOTH native pickers
//      (the addendum: no dialog on our platforms mixes files and
//      folders) — Browse… with its search glyph for the bundle
//      directory and the icon-only manifest-file button (codicon-file,
//      aria-label + title) filling the SAME display (one display, one
//      picked path) — with Install handing the shown path to
//      InstallPlugin in each round.
//   K. Build plugin… (w23): the card-header trigger (codicon-export +
//      label riding the .row-between beside the Plugins heading), the
//      dialog's anatomy (the name field with its hint, the 1.0.0
//      version default, both TokenSelect fields with their
//      placeholders/aria), the USER-ORIGIN-ONLY offer (a mixed-origin
//      fixture never offers a built-in or plugin row in either picker),
//      chip picks landing in the fields, the Save gating (a name AND at
//      least one pick; codicon-save leads the label), the
//      BuildPluginBundle hand-off with exactly the picked ids and the
//      version, the native save receiving spectra-plugin.json (a cancel
//      resolving "" is a silent no-op) and the server-failure error
//      line. K runs after J, just before the whole-run error tail.
//
// Backend semantics live in AnalyticsService.SetConfig (the no-bump)
// and RecomputeAll (server-side behind-set resolution) — this covers
// the view wiring only.
//
// jsdom is a declared devDependency of frontend/ — a plain `npm ci`
// there provides it. From frontend/ run:
//   node --test test/settings.dom.mjs
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

// services.js runs against the shared TEST STUBS for its two runtime
// dependencies — same redirection as library.dom.mjs / services-cache
// (hooks are per-process; this file runs in its own process under
// node --test). 'svelte' is pinned to the CLIENT entry so plain
// `node --test` mounts for real.
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
const { fire } = await import('./stubs/wails-runtime.mjs');

// --- Mount-surface no-ops (the pattern from library.dom.mjs) ----------
// Methods Settings calls at mount that the shared stub does not script:
// plain resolves so no error slot fills with a "not a function" TypeError.
bindings.AppService.GetVersion = () => Promise.resolve('test');
bindings.AppService.CheckForUpdateNow = () => Promise.resolve();
bindings.LibraryService.ListJobs = () => Promise.resolve([]);
bindings.LibraryService.GetDemoDirs = () => Promise.resolve({ dirs: ['/demos'], custom: false });
bindings.LibraryService.GetDataInfo = () =>
  Promise.resolve({
    dbPath: '/x/spectra.db', matchesDir: '/x/matches', demosDir: '/x/demos',
    parserVersion: 'v6', demoCount: 0, demoBytes: 0,
  });
bindings.LibraryService.GetDemoCopyOnImport = () => Promise.resolve(true);
// Parallel-work control: scripted {value, max} so the 1..max bounds
// are observable; Set records the exact value the view hands back.
bindings.LibraryService.GetParallelWork = () => Promise.resolve({ value: 1, max: 4 });
bindings.LibraryService.SetParallelWork = (n) => {
  bindings.calls.push({ method: 'SetParallelWork', args: [n] });
  return Promise.resolve();
};
// Plugin fixture (w20 icon-wave): ListPlugins was stubbed EMPTY until
// this wave, so a plugin row never rendered and the row's controls had
// no pins at all. One valid, enabled plugin makes the row observable;
// RemovePlugin empties the fixture so the confirm flow below can pin the
// row actually leaving (the list is re-read after every mutation).
const PLUGIN = {
  manifest: { id: 'demo', name: 'Demo', version: '1.0.0', metrics: [], reportTpls: [] },
  path: '/plugins/demo',
  enabled: true,
  error: '',
};
let pluginList = [PLUGIN];
bindings.PlatformService.ListPlugins = () => Promise.resolve(pluginList);
bindings.PlatformService.RemovePlugin = (id) => {
  bindings.calls.push({ method: 'RemovePlugin', args: [id] });
  pluginList = []; // the real Remove deletes the bundle → the next list is empty
  return Promise.resolve();
};
// The plugin-source picker + install (w20): the browse click hands back
// a picked path, Install echoes it back as a validated install state.
bindings.PlatformService.ChoosePluginSource = () => {
  bindings.calls.push({ method: 'ChoosePluginSource', args: [] });
  return Promise.resolve('/srv/plug');
};
bindings.PlatformService.InstallPlugin = (p) => {
  bindings.calls.push({ method: 'InstallPlugin', args: [p] });
  return Promise.resolve({
    manifest: { id: 'demo', name: 'Demo', version: '1.0.0', metrics: [], reportTpls: [] },
    path: '/plugins/demo',
    enabled: true,
    error: '',
  });
};
// The manifest-file picker (w20 addendum): the icon-only twin of the
// directory picker, filling the SAME read-only display.
bindings.PlatformService.ChoosePluginFile = () => {
  bindings.calls.push({ method: 'ChoosePluginFile', args: [] });
  return Promise.resolve('/srv/spectra-plugin.json');
};
// --- Build plugin… fixture (w23) --------------------------------------------
// Mixed-origin catalogs: the dialog must offer ONLY the user rows in
// both pickers (built-ins are immutable, plugin rows belong to their own
// bundle). The build call records the exact payload the Save button
// hands Go and answers composed JSON; bundleFail flips it to a rejection
// for the server-failure pin. The native save dialog answers a path
// (saveFileResult) so saveText lands the file — "" exercises the cancel
// contract.
const USER_METRIC = {
  id: 11, name: 'my_count', title: 'My count', scope: 'match',
  format: '', doc: '', origin: 'user', expr: 'from events: count()',
  shortName: '', denominator: '', pluginId: '',
};
const BUILTIN_METRIC = {
  id: 1, name: 'trade_rate', title: 'Trade rate', scope: 'match',
  format: 'percent', doc: '', origin: 'builtin', expr: 'from events: count()',
  shortName: '', denominator: '', pluginId: '',
};
const PLUGIN_METRIC = {
  id: 22, name: 'plug_stat', title: 'Plug stat', scope: 'match',
  format: '', doc: '', origin: 'plugin', expr: 'from events: count()',
  shortName: '', denominator: '', pluginId: 'demo',
};
bindings.handlers.ListMetrics = () => [BUILTIN_METRIC, USER_METRIC, PLUGIN_METRIC];
bindings.handlers.ListReportTemplates = () => [
  { id: 'match.md', title: 'Match report', scope: 'match', format: 'md', origin: 'builtin', body: 'x' },
  { id: 'my-report', title: 'My report', scope: 'match', format: 'md', origin: 'user', body: 'y' },
  { id: 'plug-tpl', title: 'Plug tpl', scope: 'match', format: 'md', origin: 'plugin', body: 'z' },
];
let bundleFail = false;
bindings.PlatformService.BuildPluginBundle = (name, version, metricIDs, templateIDs) => {
  bindings.calls.push({ method: 'BuildPluginBundle', args: [name, version, metricIDs, templateIDs] });
  if (bundleFail) return Promise.reject(new Error('the plugin metric "x" would replace a built-in metric'));
  return Promise.resolve('{"id":"my-plugin","name":"My Plugin","version":"1.0.0"}');
};
// The native save dialog + writer (save.js's SaveFile → WriteFile pair).
let saveFileResult = '/out/spectra-plugin.json';
bindings.DialogService.SaveFile = (name, exts) => {
  bindings.calls.push({ method: 'SaveFile', args: [name, exts] });
  return Promise.resolve(saveFileResult);
};
bindings.DialogService.WriteFile = (path, data) => {
  bindings.calls.push({ method: 'WriteFile', args: [path, data] });
  return Promise.resolve();
};
bindings.MapPackService.GetMapPackStatus = () =>
  Promise.resolve({ found: false, path: '', manual: false, maps: [] });
bindings.IconService.GetIconManifest = () => Promise.resolve({ count: 0, note: '' });
bindings.SoundService.GetSoundManifest = () => Promise.resolve({ count: 0, note: '' });

// --- Scripted rules + the background-recompute submission --------------
const RULES = {
  tradeWindowS: 5,
  ecoFullBuy: 20000,
  ecoForce: 10000,
  tradeOppDistance: 1000,
  ruleVersion: 3,
};
// setConfigImpl: section C runs the default (a real bump — the version
// the form loaded is 3, the answer carries 4); section D scripts the
// no-bump answer (the server's current row, version 4 after C's save).
let setConfigImpl = (c) => ({ ...c, ruleVersion: RULES.ruleVersion + 1 });
bindings.handlers.GetConfig = () => ({ ...RULES });
bindings.handlers.SetConfig = (c) => setConfigImpl(c);
// RecomputeAll answers at SUBMISSION (services.js) with the honest
// {submitted, skipped, total}; section C asserts it is kicked exactly
// once and section D that a no-bump save never kicks it.
bindings.handlers.RecomputeAll = () => ({ submitted: 3, skipped: 1, total: 4 });

// --- Compile Settings + its components ---------------------------------
const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'settings');
mkdirSync(dir, { recursive: true });

const svelteCompile = (src, filename, out) => {
  const code = compile(src, { filename, generate: 'client' }).js.code;
  writeFileSync(out, code);
  return out;
};
const fileURL = (p) => pathToFileURL(p).href;

// StatusChip (no imports) → local bundle.
svelteCompile(
  readFileSync('src/lib/components/StatusChip.svelte', 'utf8'),
  'StatusChip.svelte',
  join(dir, 'statuschip.js'),
);
// ConfirmDialog imports Dialog → point at the local bundle; its strings
// catalog import resolves from the real tree (Strings Stage 3 plumbing).
const cdSrc = readFileSync('src/lib/components/ConfirmDialog.svelte', 'utf8')
  .replace("import Dialog from './Dialog.svelte';", "import Dialog from './dialog.js';")
  .replace("from '../strings/index.js'", `from '${fileURL('src/lib/strings/index.js')}'`);
svelteCompile(
  readFileSync('src/lib/components/Dialog.svelte', 'utf8'),
  'Dialog.svelte',
  join(dir, 'dialog.js'),
);
svelteCompile(cdSrc, 'ConfirmDialog.svelte', join(dir, 'confirmdialog.js'));

// HelpButton — the shared header `?` (help-buttons wave, 2026-11-15):
// the header's button is this component; its strings catalog import
// resolves from the real tree like every other ../ module above.
svelteCompile(
  readFileSync('src/lib/components/HelpButton.svelte', 'utf8').replace(
    "from '../strings/index.js'",
    `from '${fileURL('src/lib/strings/index.js')}'`,
  ),
  'HelpButton.svelte',
  join(dir, 'helpbutton.js'),
);

// Build-plugin dialog (w23): Popover is TokenSelect's leaf (compiled
// like reports.dom.mjs), TokenSelect the chip input, and
// PluginBuildDialog the dialog itself — Dialog resolves to the local
// bundle above, everything else (strings, services, save) to the real
// tree so the driver drives the same module instances the view does.
svelteCompile(
  readFileSync('src/lib/components/Popover.svelte', 'utf8'),
  'Popover.svelte',
  join(dir, 'popover.js'),
);
const tokenSelectSrc = readFileSync('src/lib/components/TokenSelect.svelte', 'utf8')
  .replace("from './Popover.svelte'", "from './popover.js'")
  .replace("from '../strings/index.js'", `from '${fileURL('src/lib/strings/index.js')}'`);
svelteCompile(tokenSelectSrc, 'TokenSelect.svelte', join(dir, 'tokenselect.js'));
const buildDlgSrc = readFileSync('src/lib/components/PluginBuildDialog.svelte', 'utf8')
  .replace("from './Dialog.svelte'", "from './dialog.js'")
  .replace("from './TokenSelect.svelte'", "from './tokenselect.js'")
  .replace("from '../services.js'", `from '${fileURL('src/lib/services.js')}'`)
  .replace("from '../save.js'", `from '${fileURL('src/lib/save.js')}'`)
  .replace("from '../strings/index.js'", `from '${fileURL('src/lib/strings/index.js')}'`);
svelteCompile(buildDlgSrc, 'PluginBuildDialog.svelte', join(dir, 'plugindialog.js'));

// Settings → its plain-ESM imports resolve from the real module
// locations (absolute URLs); its components from the local bundles.
// The bindings import ('../../../bindings/github.com/…') is caught by
// the resolve hook (specifier includes 'bindings/github.com') — left as-is.
const rewrite = (src, from, to) => src.split(`from '${from}'`).join(`from '${to}'`);
let settSrc = readFileSync('src/lib/views/Settings.svelte', 'utf8');
for (const rel of [
  'services.js', 'assets.js', 'fmt.js', 'definitions.js', 'theme.js', 'fontsize.js',
  'replay/audio.js', 'replay/sfx.js', 'strings/index.js', 'nav.js',
]) {
  settSrc = rewrite(settSrc, `../${rel}`, fileURL(`src/lib/${rel}`));
}
settSrc = rewrite(settSrc, '../components/StatusChip.svelte', './statuschip.js');
settSrc = rewrite(settSrc, '../components/ConfirmDialog.svelte', './confirmdialog.js');
settSrc = rewrite(settSrc, '../components/HelpButton.svelte', './helpbutton.js');
settSrc = rewrite(settSrc, '../components/PluginBuildDialog.svelte', './plugindialog.js');
svelteCompile(settSrc, 'Settings.svelte', join(dir, 'settings-bundle.js'));

const { mount, unmount } = await import('svelte');
const mod = await import(pathToFileURL(join(dir, 'settings-bundle.js')).href);
const target = document.createElement('div');
document.body.appendChild(target);
let inst = mount(mod.default, {
  target,
  props: { openDocs: (s) => (globalThis.__docs = [...(globalThis.__docs || []), s]) },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(150); // mount + the config read

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}
const $ = (sel) => [...document.querySelectorAll(sel)];
// textContent collapses nothing — template line breaks survive as
// whitespace runs, so match against a single-space-normalized copy.
const body = () => document.body.textContent.replace(/\s+/g, ' ');
const callCount = (m) => bindings.callCount(m);
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const type = (el, value) => {
  el.value = value;
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
};
const saveBtn = () => $('button').find((b) => b.textContent.includes('Save rules'));
const tradeInput = () => document.getElementById('sett-trade');
const rulesCard = () =>
  $('section.panel').find((s) => {
    const h = s.querySelector('h2');
    return h && h.textContent.includes('Analysis rules');
  });

console.log('A. pristine gating + card shape: Save disabled, "No changes", no version display');
{
  const save = saveBtn();
  check('Save present', !!save);
  check('Save disabled while pristine', save && save.disabled, String(save && save.disabled));
  check(
    'honest "No changes" copy shown',
    body().includes('No changes — the rules above are already saved.'),
  );
  {
    // T1 layout pin: a direct panel child would stretch full width, so
    // the status and the button share ONE .row-between — the button
    // sizes to its label and parks right with the status at left.
    const row = save?.closest('.row-between');
    check(
      'Save rides a .row-between with the status slot at left (never full width)',
      !!row && row.lastElementChild === save &&
        [...row.children].length >= 2 &&
        /No changes/.test(row.textContent),
      row ? [...row.children].map((c) => c.className || c.tagName).join(' | ') : 'no row',
    );
  }
  check('no recompute hint while pristine', !body().includes('Saving applies these rules'));
  check('no rules-version display (internal-only)', !body().includes('Rules version'));
  check(
    'the four rule fields are present',
    ['sett-trade', 'sett-full', 'sett-trade-dist', 'sett-force'].every((id) => document.getElementById(id)),
    ['sett-trade', 'sett-full', 'sett-trade-dist', 'sett-force']
      .filter((id) => !document.getElementById(id))
      .join(','),
  );
  {
    const card = rulesCard();
    const btns = card ? [...card.querySelectorAll('button')] : [];
    check(
      'Save is the card\'s only button (one save, no re-run controls)',
      btns.length === 1 && btns[0].textContent.includes('Save rules'),
      btns.map((b) => b.textContent.trim()).join(' | '),
    );
  }

  type(tradeInput(), '7');
  await sleep(10);
  check('edit arms Save', saveBtn() && !saveBtn().disabled);
  check('"No changes" gone after edit', !body().includes('No changes — the rules above'));
  check('no hint appears while dirty', !body().includes('Saving applies these rules'));

  type(tradeInput(), '5'); // back to pristine
  await sleep(10);
  check('revert disarms Save again', saveBtn() && saveBtn().disabled);
  check('"No changes" back after revert', body().includes('No changes — the rules above are already saved.'));
}

console.log('B. the re-run UI and the Stat definitions card are gone — and no behind fetches happen');
{
  check('no "Re-run analysis…" heading', !body().includes('Re-run analysis'));
  check('no Re-run all button', !$('button').some((b) => /Re-run all|Re-running…/.test(b.textContent)));
  check('no per-row re-run list', $('.sett-match-row').length === 0);
  check('no Load more button', !$('button').some((b) => b.textContent.includes('Load more')));
  check('no behind count line', !body().includes('behind the current rules'));
  check('no Stat definitions panel', !body().includes('Stat definitions') && $('.sett-defs').length === 0);
  check(
    'no glossary entries rendered',
    !body().includes('Share of rounds where the player recorded'),
  );
  check('no ListMatchesPage fetch on mount', callCount('ListMatchesPage') === 0, String(callCount('ListMatchesPage')));
  check('no CountMatches fetch on mount', callCount('CountMatches') === 0, String(callCount('CountMatches')));
  check('no RecomputeStates read on mount', callCount('RecomputeStates') === 0, String(callCount('RecomputeStates')));

  // A stamped match no longer drives anything in this view: the event
  // still flushes services' read cache, but the card never re-queries.
  fire('spectra:analysis-done', { matchId: 1, error: '' });
  await sleep(250); // long enough for the old 150 ms debounce + fetch
  check(
    'analysis-done triggers no list re-query',
    callCount('ListMatchesPage') === 0 && callCount('CountMatches') === 0,
    `pages=${callCount('ListMatchesPage')} counts=${callCount('CountMatches')}`,
  );
}

console.log('C. save = recompute: a bumped rules save kicks RecomputeAll in the background');
{
  type(tradeInput(), '11');
  await sleep(10);
  check('edit armed Save', saveBtn() && !saveBtn().disabled);
  click(saveBtn());
  await sleep(50);
  {
    const set = bindings.calls.find((c) => c.method === 'SetConfig');
    check(
      'save submits the edited value',
      !!set && set.args[0].tradeWindowS === 11,
      JSON.stringify(set && set.args[0]),
    );
  }
  check('RecomputeAll kicked exactly once', callCount('RecomputeAll') === 1, String(callCount('RecomputeAll')));
  check(
    'no confirmation dialog — the save kicks the batch itself',
    $('.cf-actions').length === 0,
    String($('.cf-actions').length),
  );
  check(
    'confirmation says the matches are recomputing in the background',
    body().includes('matches behind the new rules recompute in the background'),
  );
  check(
    'never the no-changes claim after a bump',
    !body().includes('No changes — the rules were already saved with these values.'),
  );
  check('Save disarmed after save (pristine re-snapshotted)', saveBtn() && saveBtn().disabled);
  check(
    'no per-match RecomputeAnalysis path',
    callCount('RecomputeAnalysis') === 0,
    String(callCount('RecomputeAnalysis')),
  );
}

console.log('D. save honesty: a no-bump save says "No changes" and kicks no recompute');
{
  // The server judges the values identical: it returns its current row
  // untouched — version 4, the bump C's save landed on.
  setConfigImpl = (c) => ({ ...c, ruleVersion: 4 });
  type(tradeInput(), '9');
  await sleep(10);
  check('edit armed Save for the no-bump save', saveBtn() && !saveBtn().disabled);
  click(saveBtn());
  await sleep(50);
  check(
    'no-bump save says "No changes", never the recompute note',
    body().includes('No changes — the rules were already saved with these values.') &&
      !body().includes('recompute in the background'),
  );
  check(
    'no recompute kicked on a no-bump save',
    callCount('RecomputeAll') === 1,
    String(callCount('RecomputeAll')),
  );
  check('Save disarmed after save (pristine re-snapshotted)', saveBtn() && saveBtn().disabled);
}

console.log('E. parallel work: 1..max numeric control in its own Background work card');
{
  const pwInput = () => document.getElementById('sett-parallel-work');
  const pwSets = () => bindings.calls.filter((c) => c.method === 'SetParallelWork');
  check('control present in the Background work card', !!pwInput());
  check('label names it honestly', body().includes('Parallel work'));
  check('min = 1 (the one-at-a-time floor)', pwInput() && pwInput().min === '1', pwInput() && String(pwInput().min));
  check('max = the backend ceiling (4)', pwInput() && pwInput().max === '4', pwInput() && pwInput().max);
  check('value seeded from the backend read', pwInput() && pwInput().value === '1', pwInput() && pwInput().value);
  check('never-oversubscribes spelled out', body().includes('never runs more at once than your hardware can handle'));
  check('no Set call on plain mount', pwSets().length === 0, String(pwSets().length));
  check('old import-scoped control gone', !document.getElementById('sett-concurrent-imports'));

  // An in-range change reaches the backend verbatim.
  type(pwInput(), '3');
  pwInput().dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await sleep(20);
  check(
    'SetParallelWork(3) for an in-range value',
    pwSets().length === 1 && JSON.stringify(pwSets()[0].args) === '[3]',
    JSON.stringify(pwSets().map((c) => c.args)),
  );

  // An out-of-range value clamps to the ceiling BEFORE it reaches Go,
  // and the input snaps to what was actually stored.
  type(pwInput(), '99');
  pwInput().dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await sleep(20);
  check('99 clamps to max (4)', pwSets().length === 2 && JSON.stringify(pwSets()[1].args) === '[4]', JSON.stringify(pwSets().map((c) => c.args)));
  check('input snaps to the clamped value', pwInput().value === '4', pwInput().value);

  // Garbage (a number input yields "" for it) clamps to the floor —
  // never 0, which would stall every heavy task.
  type(pwInput(), 'banana');
  pwInput().dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await sleep(20);
  check('non-numeric clamps to 1', pwSets().length === 3 && JSON.stringify(pwSets()[2].args) === '[1]', JSON.stringify(pwSets().map((c) => c.args)));
  check('input snaps to 1', pwInput().value === '1', pwInput().value);
}

console.log('F. the header `?` opens the guide at the settings section (help-buttons)');
{
  // The shared HelpButton: Settings' header gained the .spacer it never
  // had, and the `?` is its LAST element — one per view header, primary
  // chrome only.
  const hdr = document.querySelector('.view-header');
  const help = hdr?.querySelector(':scope > button[aria-label="Help for this view"]');
  check(
    'the ? is the header’s LAST element, right of the .spacer, shared labels + question glyph',
    !!help && hdr.lastElementChild === help &&
      !!hdr.querySelector(':scope > .spacer') &&
      help.getAttribute('title') === 'Help for this view' &&
      help.classList.contains('btn') && !!help.querySelector('.codicon-question'),
    hdr ? [...hdr.children].map((c) => c.className || c.tagName).join(' | ') : 'no header',
  );
  const docs0 = (globalThis.__docs || []).length;
  click(help);
  await sleep();
  check(
    'clicking it opens the guide at the settings section (openDocs)',
    (globalThis.__docs || []).length === docs0 + 1 && (globalThis.__docs || []).at(-1) === 'settings',
    JSON.stringify((globalThis.__docs || []).slice(docs0)),
  );
}

console.log('G. replay loop length: the 1..60 numeric control in its own Replay card');
{
  const lsCard = () =>
    $('section.panel').find((s) => {
      const h = s.querySelector('h2');
      return h && h.textContent.trim() === 'Replay';
    });
  const lsInput = () => document.getElementById('sett-loop-secs');
  const lsSets = () => bindings.calls.filter((c) => c.method === 'SetPref' && c.args[0] === 'loop_secs');
  check('the Replay card exists', !!lsCard());
  check('control present in the Replay card', !!lsInput());
  check('label names it', body().includes('Loop length (seconds)'));
  check('min = 1 (the floor)', lsInput() && lsInput().min === '1', lsInput() && String(lsInput().min));
  check('max = 60 (the ceiling)', lsInput() && lsInput().max === '60', lsInput() && lsInput().max);
  check(
    'value seeded from the pref read (unset → the default 5)',
    lsInput() && lsInput().value === '5',
    lsInput() && lsInput().value,
  );
  check('no loop_secs write on a plain mount', lsSets().length === 0, String(lsSets().length));

  // An in-range change reaches the kvstore verbatim.
  type(lsInput(), '12');
  lsInput().dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await sleep(20);
  check(
    'setPref(loop_secs, 12) for an in-range value',
    lsSets().length === 1 && JSON.stringify(lsSets()[0].args) === '["loop_secs",12]',
    JSON.stringify(lsSets().map((c) => c.args)),
  );

  // Above the ceiling clamps to 60 BEFORE the write; the input snaps to
  // what was actually stored.
  type(lsInput(), '99');
  lsInput().dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await sleep(20);
  check('99 clamps to 60', lsSets().length === 2 && JSON.stringify(lsSets()[1].args) === '["loop_secs",60]', JSON.stringify(lsSets().map((c) => c.args)));
  check('input snaps to 60', lsInput().value === '60', lsInput().value);

  // Below the floor clamps to 1 — never 0 (a zero-length loop).
  type(lsInput(), '0');
  lsInput().dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await sleep(20);
  check('0 clamps to 1', lsSets().length === 3 && JSON.stringify(lsSets()[2].args) === '["loop_secs",1]', JSON.stringify(lsSets().map((c) => c.args)));
  check('input snaps to 1', lsInput().value === '1', lsInput().value);

  // Garbage (a number input yields "" for it) lands on the DEFAULT
  // through the same coercer the read path uses — never 0, never
  // out of range.
  type(lsInput(), 'banana');
  lsInput().dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await sleep(20);
  check('non-numeric falls back to the default 5', lsSets().length === 4 && JSON.stringify(lsSets()[3].args) === '["loop_secs",5]', JSON.stringify(lsSets().map((c) => c.args)));
  check('input snaps to 5', lsInput().value === '5', lsInput().value);
}

console.log('H. Settings action buttons (w20 icon-wave: the label keeps its glyph, the remove row goes icon-only)');
{
  const byText = (t) => $('button').find((b) => b.textContent.includes(t));
  const glyph = (btn, name) =>
    !!btn && !!btn.querySelector(`.codicon.codicon-${name}[aria-hidden="true"]`);
  // 16 — About
  const upd = byText('Check for Updates…');
  check(
    'About: Check for Updates… keeps its label and gains codicon-sync',
    !!upd &&
      upd.classList.contains('btn') &&
      !upd.disabled &&
      glyph(upd, 'sync') &&
      upd.textContent.includes('Check for Updates…'),
    upd ? upd.outerHTML.slice(0, 220) : 'missing',
  );
  // 15 — Data
  const free = byText('Free all demo copies');
  check(
    'Data: Free all demo copies keeps its label + codicon-trash, .btn.danger, its title, disabled on an empty list',
    !!free &&
      free.classList.contains('danger') &&
      free.title === 'No demo copies to free' &&
      free.disabled &&
      glyph(free, 'trash') &&
      free.textContent.includes('Free all demo copies'),
    free ? `${free.className} · title=${free.title} · disabled=${free.disabled}` : 'missing',
  );
  // 12 — Import dirs remove row (ICON-ONLY: the word survives as aria-label + title)
  const dirRow = $('.sett-dir-row')[0];
  const dirRm = dirRow && dirRow.querySelector('button');
  check(
    'Import dirs: the row remove is icon-only — codicon-trash, no text, dir aria-label kept, the word as its title',
    !!dirRm &&
      !dirRm.textContent.trim() &&
      glyph(dirRm, 'trash') &&
      dirRm.classList.contains('danger') &&
      dirRm.getAttribute('aria-label') === 'Remove /demos' &&
      dirRm.title === 'Remove',
    dirRm ? dirRm.outerHTML.slice(0, 260) : 'no import-dir row',
  );
  // 13 / 14 — Add folder… / Reset to defaults
  const add = byText('Add folder…');
  check(
    'Import dirs: Add folder… keeps its label and gains codicon-folder',
    !!add && !add.disabled && glyph(add, 'folder') && add.textContent.includes('Add folder…'),
    add ? add.outerHTML.slice(0, 220) : 'missing',
  );
  const reset = byText('Reset to defaults');
  check(
    'Import dirs: Reset to defaults keeps its label + codicon-discard, disabled while the defaults are in effect',
    !!reset && reset.disabled && glyph(reset, 'discard') && reset.textContent.includes('Reset to defaults'),
    reset ? `disabled=${reset.disabled}` : 'missing',
  );
  // 10 / 11 — CS2 assets
  const choose = byText('Choose folder…');
  check(
    'CS2 assets: Choose folder… keeps its label and gains codicon-folder',
    !!choose && !choose.disabled && glyph(choose, 'folder') && choose.textContent.includes('Choose folder…'),
    choose ? choose.outerHTML.slice(0, 220) : 'missing',
  );
  const extract = byText('Extract all CS2 assets');
  check(
    'CS2 assets: Extract all CS2 assets keeps its label + codicon-download (disabled: no install found)',
    !!extract &&
      extract.disabled &&
      glyph(extract, 'download') &&
      extract.textContent.includes('Extract all CS2 assets'),
    extract ? `disabled=${extract.disabled}` : 'missing',
  );
  // 8 — Audio
  const audio = byText('Run audio self-test');
  check(
    'Audio: Run audio self-test keeps its label and gains codicon-check',
    !!audio && !audio.disabled && glyph(audio, 'check') && audio.textContent.includes('Run audio self-test'),
    audio ? audio.outerHTML.slice(0, 220) : 'missing',
  );
  // 7 — Analysis rules (the shared saveBtn() finder is text-based)
  const save = saveBtn();
  check(
    'Analysis rules: Save rules keeps its label + codicon-save (disabled while pristine)',
    !!save && save.disabled && glyph(save, 'save') && save.textContent.includes('Save rules'),
    save ? `disabled=${save.disabled}` : 'missing',
  );
}

console.log('I. plugin rows (the fixture renders them — structure, the text toggle, the icon-only Remove, the confirm flow)');
{
  const rows = $('.plugin-row');
  check('the fixture renders exactly one plugin row', rows.length === 1, String(rows.length));
  const row = rows[0];
  const btns = row ? [...row.querySelectorAll('button')] : [];
  check(
    'the row offers exactly two controls (the enable toggle + the Remove action)',
    btns.length === 2,
    btns.map((b) => b.textContent.trim() || b.getAttribute('aria-label')).join(' | '),
  );
  const toggle = btns[0];
  const rm = btns[1];
  check(
    'the toggle keeps its TEXT form: "Enabled" + aria-pressed + its hint title + .warn',
    !!toggle &&
      toggle.textContent.trim() === 'Enabled' &&
      toggle.getAttribute('aria-pressed') === 'true' &&
      toggle.title === 'Disable plugin' &&
      toggle.classList.contains('warn'),
    toggle ? toggle.outerHTML.slice(0, 240) : 'no toggle',
  );
  check(
    'the row names the plugin and both contributed counts',
    !!row &&
      row.textContent.includes('Demo') &&
      row.textContent.includes('demo · v1.0.0') &&
      row.textContent.includes('0 metrics') &&
      row.textContent.includes('0 templates'),
    row ? row.textContent.replace(/\s+/g, ' ').slice(0, 160) : 'no row',
  );
  check(
    'the Remove action is ICON-ONLY: codicon-trash, empty text, aria-label + title carrying the word',
    !!rm &&
      !rm.textContent.trim() &&
      rm.classList.contains('danger') &&
      !!rm.querySelector('.codicon.codicon-trash[aria-hidden="true"]') &&
      rm.getAttribute('aria-label') === 'Remove plugin' &&
      rm.title === 'Remove this plugin and its bundle from disk',
    rm ? rm.outerHTML.slice(0, 300) : 'no Remove button',
  );

  // The confirm flow (doRemove → the shared ConfirmDialog): dismissal is
  // always cancel; only the confirm button reaches RemovePlugin.
  click(rm);
  await sleep(20);
  const cfBtn = (label) => {
    const bar = $('.cf-actions')[0];
    return bar && [...bar.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
  };
  check(
    'Remove opens the shared ConfirmDialog naming the plugin and its id',
    $('.cf-actions').length === 1 &&
      body().includes('Remove plugin?') &&
      body().includes('(demo)'),
    String($('.cf-actions').length),
  );
  click(cfBtn('Cancel'));
  await sleep(20);
  check(
    'Cancel dismisses the prompt and removes nothing (row intact, no call)',
    $('.cf-actions').length === 0 &&
      callCount('RemovePlugin') === 0 &&
      $('.plugin-row').length === 1,
    `dlg=${$('.cf-actions').length} calls=${callCount('RemovePlugin')} rows=${$('.plugin-row').length}`,
  );
  const rm2 = $('.plugin-row')[0]?.querySelectorAll('button')[1];
  click(rm2);
  await sleep(20);
  const confirmBtn = [...$('.cf-actions')[0].querySelectorAll('button')].find((b) =>
    b.classList.contains('danger'),
  );
  check(
    'the confirm button keeps the caller’s label ("Remove") and the danger class',
    !!confirmBtn && confirmBtn.textContent.trim() === 'Remove',
    confirmBtn ? confirmBtn.outerHTML.slice(0, 160) : 'no confirm button',
  );
  click(confirmBtn);
  await sleep(50);
  const removed = bindings.calls.filter((c) => c.method === 'RemovePlugin');
  check(
    'confirming calls RemovePlugin with the plugin id and the row leaves',
    removed.length === 1 &&
      removed[0].args[0] === 'demo' &&
      $('.plugin-row').length === 0,
    JSON.stringify({ calls: removed.map((c) => c.args), rows: $('.plugin-row').length }),
  );
}

console.log('J. the plugin source row: the read-only display, BOTH pickers and the install flow');
{
  const input = $('.sett-plugin-path')[0];
  check(
    'the source is a READ-ONLY display — no free typing, no placeholder left',
    !!input && input.readOnly && input.placeholder === '',
    input ? input.outerHTML.slice(0, 240) : 'missing',
  );
  const browse = $('button').find((b) => b.textContent.includes('Browse…'));
  check(
    'Browse… carries its label and the codicon-search glyph',
    !!browse &&
      !browse.disabled &&
      !!browse.querySelector('.codicon.codicon-search[aria-hidden="true"]') &&
      browse.textContent.includes('Browse…'),
    browse ? browse.outerHTML.slice(0, 260) : 'missing',
  );
  // The manifest-file picker (w20 addendum): the icon-only twin of
  // Browse… — no native dialog on our platforms mixes files and folders,
  // so each source kind gets its own affordance.
  const fileBtn = $('button').find((b) => b.getAttribute('aria-label') === 'Choose manifest file');
  check(
    'the manifest-file button is icon-only: codicon-file, no text, aria-label + title carrying the word',
    !!fileBtn &&
      !fileBtn.disabled &&
      !fileBtn.textContent.trim() &&
      !!fileBtn.querySelector('.codicon.codicon-file[aria-hidden="true"]') &&
      fileBtn.title === 'Choose a single manifest file instead of a bundle folder',
    fileBtn ? fileBtn.outerHTML.slice(0, 320) : 'missing',
  );
  const install = $('button').find((b) => b.textContent.includes('Install from path'));
  check(
    'Install from path is unchanged and gated on a picked path',
    !!install && install.disabled,
    install ? `disabled=${install.disabled}` : 'missing',
  );

  // Round 1: the directory pick, then the file pick REPLACING it in the
  // same display (one display, one picked path — the two pickers never
  // both run), then the install of whichever path is showing.
  click(browse);
  await sleep(20);
  check(
    'the bundle-directory pick lands in the read-only display and arms Install',
    !!input && input.value === '/srv/plug' && !!install && !install.disabled,
    `value=${input && input.value} disabled=${install && install.disabled}`,
  );
  click(fileBtn);
  await sleep(20);
  check(
    'the file pick REPLACES it in the same display (one display, one picked path) and arms Install',
    !!input &&
      input.value === '/srv/spectra-plugin.json' &&
      !!install &&
      !install.disabled &&
      callCount('ChoosePluginSource') === 1 &&
      callCount('ChoosePluginFile') === 1,
    `value=${input && input.value} dir=${callCount('ChoosePluginSource')} file=${callCount('ChoosePluginFile')}`,
  );
  click(install);
  await sleep(50);
  let installs = bindings.calls.filter((c) => c.method === 'InstallPlugin');
  check(
    'Install hands the manifest-file path to InstallPlugin',
    installs.length === 1 && installs[0].args[0] === '/srv/spectra-plugin.json',
    JSON.stringify(installs.map((c) => c.args)),
  );
  check(
    'the display clears after the install and the status says what landed',
    !!input && input.value === '' && body().includes('Installed demo.'),
    `value=${input && input.value}`,
  );

  // Round 2: the directory picker still drives the same row after a
  // file pick, and its path reaches InstallPlugin too.
  click(browse);
  await sleep(20);
  check(
    'a second bundle-directory pick lands in the same display and re-arms Install',
    !!input && input.value === '/srv/plug' && !!install && !install.disabled,
    `value=${input && input.value}`,
  );
  click(install);
  await sleep(50);
  installs = bindings.calls.filter((c) => c.method === 'InstallPlugin');
  check(
    'the second install hands the bundle path to InstallPlugin',
    installs.length === 2 && installs[1].args[0] === '/srv/plug',
    JSON.stringify(installs.map((c) => c.args)),
  );
}

console.log('K. Build plugin… (w23): the trigger, the dialog anatomy, the user-only offer, the save hand-off');
{
  const dlg = () => document.querySelector('[role="dialog"]');
  const openDialog = async () => {
    const trig = $('button').find((b) => b.textContent.includes('Build plugin…'));
    click(trig);
    await sleep(150); // the dialog mount + both catalog reads
    return dlg();
  };

  // 1/2 — the trigger: label + codicon-export leading it, riding the
  // Plugins card's header row (the .row-between beside the heading),
  // clear of the Browse/file/Install source row.
  const trig = $('button').find((b) => b.textContent.includes('Build plugin…'));
  check(
    'the Build plugin… trigger carries its label with codicon-export leading',
    !!trig &&
      !!trig.querySelector('.codicon.codicon-export[aria-hidden="true"]') &&
      trig.textContent.includes('Build plugin…'),
    trig ? trig.outerHTML.slice(0, 220) : 'missing',
  );
  {
    const headRow = trig && trig.closest('.row-between');
    const card = $('section.panel').find((s) => s.textContent.includes('Install from path'));
    const pathInput = card && card.querySelector('.sett-plugin-path');
    const installRow = pathInput && pathInput.closest('.row-between');
    check(
      'the trigger rides the card header row beside the Plugins heading, not the install row',
      !!headRow &&
        !!headRow.querySelector('h2') &&
        headRow.querySelector('h2').textContent.includes('Plugins') &&
        !!installRow &&
        !installRow.contains(trig),
      headRow ? headRow.textContent.replace(/\s+/g, ' ').slice(0, 80) : 'no header row',
    );
  }

  const d = await openDialog();
  // 3–6 — the anatomy: labelled dialog, the name field with its hint,
  // the 1.0.0 version default, both chip fields with their hints/aria.
  check(
    'the dialog opens with its own accessible name',
    !!d && d.getAttribute('aria-label') === 'Build a plugin to share',
    d ? d.getAttribute('aria-label') : 'no dialog',
  );
  const nameIn = d && d.querySelector('#bp-name');
  check(
    'the name field is present with the verb-like hint',
    !!nameIn && nameIn.placeholder === 'Name this plugin…',
    nameIn ? nameIn.placeholder : 'missing',
  );
  const verIn = d && d.querySelector('#bp-version');
  check('the version field defaults to 1.0.0', !!verIn && verIn.value === '1.0.0', verIn && verIn.value);
  {
    const tpls = d && d.querySelector('#bp-tpls');
    const mets = d && d.querySelector('#bp-metrics');
    check(
      'both chip fields are present with their placeholders and aria labels',
      !!tpls &&
        tpls.placeholder === 'Search report templates…' &&
        tpls.getAttribute('aria-label') === 'Report templates to bundle' &&
        !!mets &&
        mets.placeholder === 'Search metrics…' &&
        mets.getAttribute('aria-label') === 'Metrics to bundle',
      `${tpls && tpls.placeholder} | ${mets && mets.placeholder}`,
    );
  }

  // 7/8 — the USER-ORIGIN-ONLY offer: the mixed fixture carries a
  // built-in and a plugin row in each catalog; neither picker may offer
  // them (built-ins are immutable, plugin rows belong to their bundle).
  const options = async (inputId) => {
    d.querySelector(inputId).dispatchEvent(new dom.window.FocusEvent('focus', { bubbles: false }));
    await sleep(60);
    const pop = document.getElementById(`${inputId.slice(1)}-list`);
    return pop ? [...pop.querySelectorAll('.tk-opt')].map((o) => o.textContent.trim()) : [];
  };
  const tplOpts = await options('#bp-tpls');
  check(
    'the template picker offers ONLY your own templates (built-in + plugin rows absent)',
    tplOpts.includes('My report') &&
      !tplOpts.includes('Match report') &&
      !tplOpts.includes('Plug tpl') &&
      tplOpts.length === 1,
    JSON.stringify(tplOpts),
  );
  const metricOpts = await options('#bp-metrics');
  check(
    'the metric picker offers ONLY your own metrics (built-in + plugin rows absent)',
    metricOpts.includes('My count') &&
      !metricOpts.includes('Trade rate') &&
      !metricOpts.includes('Plug stat') &&
      metricOpts.length === 1,
    JSON.stringify(metricOpts),
  );

  // 9 — Save needs a name AND at least one pick: a name with nothing to
  // bundle stays disarmed.
  const saveBtn = () => [...d.querySelectorAll('button')].find((b) => b.textContent.includes('Save plugin'));
  type(nameIn, 'My Plugin');
  await sleep(20);
  check(
    'Save stays disabled with a name but no picks',
    saveBtn() && saveBtn().disabled,
    saveBtn() ? `disabled=${saveBtn().disabled}` : 'missing',
  );

  // 10/11 — the picks land as chips and arm Save (codicon-save leading).
  const pick = async (inputId, label) => {
    const pop = document.getElementById(`${inputId.slice(1)}-list`);
    const opt = pop && [...pop.querySelectorAll('.tk-opt')].find((o) => o.textContent.trim() === label);
    if (opt) click(opt);
    await sleep(40);
  };
  await pick('#bp-tpls', 'My report');
  await pick('#bp-metrics', 'My count');
  const chips = [...d.querySelectorAll('.tk-tok')].map((c) => c.textContent.replace(/\s+/g, ' ').trim());
  check(
    'picking one of each lands a chip in each field',
    chips.length === 2 && chips.some((c) => c.includes('My report')) && chips.some((c) => c.includes('My count')),
    JSON.stringify(chips),
  );
  check(
    'Save arms on name + picks and the save icon leads its label',
    !!saveBtn() && !saveBtn().disabled &&
      !!saveBtn().querySelector('.codicon.codicon-save[aria-hidden="true"]'),
    saveBtn() ? saveBtn().outerHTML.slice(0, 220) : 'missing',
  );

  // 12–14 — the hand-off: exactly the picked ids reach the server, the
  // native save receives spectra-plugin.json, and the composed text
  // lands on the chosen path with a quiet status line.
  click(saveBtn());
  await sleep(80);
  {
    const builds = bindings.calls.filter((c) => c.method === 'BuildPluginBundle');
    check(
      'Save hands the server exactly the picked set (name, version, metric ids, template ids)',
      builds.length === 1 &&
        JSON.stringify(builds[0].args) === JSON.stringify(['My Plugin', '1.0.0', [11], ['my-report']]),
      JSON.stringify(builds.map((c) => c.args)),
    );
    const saves = bindings.calls.filter((c) => c.method === 'SaveFile');
    check(
      'the native save dialog receives spectra-plugin.json with the json filter',
      saves.length === 1 && saves[0].args[0] === 'spectra-plugin.json' &&
        JSON.stringify(saves[0].args[1]) === '["json"]',
      JSON.stringify(saves.map((c) => c.args)),
    );
    const writes = bindings.calls.filter((c) => c.method === 'WriteFile');
    const landed = writes.length === 1 && Buffer.from(writes[0].args[1], 'base64').toString('utf8');
    check(
      'the file lands with the composed manifest text and a quiet status line says so',
      !!landed && landed.includes('"id":"my-plugin"') &&
        !!d.querySelector('.bp-status[role="status"]') &&
        d.querySelector('.bp-status').textContent.includes('Saved My Plugin to /out/spectra-plugin.json'),
      `${String(landed).slice(0, 60)} | ${d.querySelector('.bp-status') && d.querySelector('.bp-status').textContent}`,
    );
  }

  // 15 — cancel: SaveFile resolving "" is a silent no-op (save.js's
  // contract) — no status, no error.
  saveFileResult = '';
  click(saveBtn());
  await sleep(60);
  check(
    'a cancelled save dialog is silent: no status line and no error',
    !d.querySelector('.bp-status') && !d.querySelector('.error'),
    `status=${!!d.querySelector('.bp-status')} error=${!!d.querySelector('.error')}`,
  );
  saveFileResult = '/out/spectra-plugin.json';

  // 16 — a server-side validation failure surfaces through the dialog's
  // error slot and never reaches the save dialog.
  bundleFail = true;
  click(saveBtn());
  await sleep(60);
  check(
    'a failed build shows the error line and never opens the save dialog',
    !!d.querySelector('.error[role="alert"]') &&
      d.querySelector('.error').textContent.includes('would replace a built-in metric') &&
      bindings.calls.filter((c) => c.method === 'SaveFile').length === 2,
    d.querySelector('.error') ? d.querySelector('.error').textContent : 'no error line',
  );
  bundleFail = false;

  // 17 — the head ✕ closes it (Dialog owns the dismissal machinery).
  const closeBtn = [...d.querySelectorAll('.bp-head button')].find(
    (b) => b.getAttribute('aria-label') === 'Dismiss',
  );
  click(closeBtn);
  await sleep(40);
  check('the head ✕ closes the dialog', !document.querySelector('[role="dialog"]'));
}

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
unmount();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
