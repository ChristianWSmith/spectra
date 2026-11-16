// jsdom driver for the Settings view — the analysis-rules card's save
// flow (save = recompute, the metrics-save precedent) and the surfaces
// this wave removed:
//   A. Pristine gating + card shape: with the loaded rules unchanged,
//      Save is disabled and the status slot reads "No changes" (never a
//      recompute note); any edit of the four fields arms Save; reverting
//      disarms again. The four fields are present, Save is the card's
//      only button, and the card renders NO rules-version display
//      (internal-only since 2026-11-15) and no dirty-state hint.
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
//      G runs just BEFORE F's whole-run error check (F stays last).
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
bindings.PlatformService.ListPlugins = () => Promise.resolve([]);
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
svelteCompile(settSrc, 'Settings.svelte', join(dir, 'settings-bundle.js'));

const { mount, unmount } = await import('svelte');
const mod = await import(pathToFileURL(join(dir, 'settings-bundle.js')).href);
const target = document.createElement('div');
document.body.appendChild(target);
let inst = mount(mod.default, { target });

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

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
unmount();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
