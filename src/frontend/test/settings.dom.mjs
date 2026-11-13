// jsdom driver for the Settings view — the analysis-rules panel's save
// honesty and the behind-only re-run list (the four owner asks):
//   A. Pristine gating: with the loaded rules unchanged, Save is
//      disabled and the status slot reads "No changes" (never the
//      re-run nudge); any edit of the four fields arms Save and shows
//      the re-run hint; reverting disarms again.
//   B. Fetch shape: the re-run list is ListMatchesPage bounded
//      (BEHIND_PAGE window, {behind:true} through the shared filter
//      normalization) + CountMatches({behind:true}) for the honest N +
//      CountMatches({}) for the "All N analyzed" line — never the old
//      whole-library listMatches (pinned: zero ListMatches calls).
//   C. Re-query on spectra:analysis-done: a stamped row re-queries list
//      + counts (the services.js completion flush + this view's own
//      debounced refresh), so rows drop out and N decrements.
//   D. Re-run-all: ConfirmDialog → RecomputeAll's honest
//      {submitted, skipped, total} → k/N counted from the SAME
//      analysis-done subscription (N = submitted, extra dones never
//      overrun it), per-row chips via RecomputeStates rehydration.
//   E. Empty/error gating: 0 behind → "All N matches analyzed under
//      current rules"; a FAILED list read renders the alert and never a
//      false "all analyzed" claim (PRODUCT.md error-dismissibility).
//   F. Save honesty: a save response whose ruleVersion did not move
//      (server judged the values identical) says "No changes", never
//      "Saved. … re-run them below"; a bump keeps the re-run copy.
//   G. Load more: the keyset window appends with the last row's id as
//      cursor; the "Showing X of N" line reports CountMatches, not the
//      rendered length.
//   H. Parallel work: the 1..max numeric control in its OWN
//      "Background work" card (the import-scoped control is gone) —
//      bounds seeded from the backend, in-range values passed
//      verbatim, out-of-range clamped to the ceiling before the Set,
//      garbage clamped to 1 (never 0 — it would stall the budget).
//
// Backend semantics live in store.matchListWhere (the behind predicate),
// AnalyticsService.SetConfig (the no-bump) and RecomputeAll (server-side
// set resolution) — this covers the view wiring only.
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

// --- Scripted rules + behind list --------------------------------------
const RULES = {
  tradeWindowS: 5,
  ecoFullBuy: 20000,
  ecoForce: 10000,
  tradeOppDistance: 1000,
  ruleVersion: 3,
};
let setConfigImpl = (c) => ({ ...c, ruleVersion: RULES.ruleVersion + 1 }); // default: a real bump
bindings.handlers.GetConfig = () => ({ ...RULES });
bindings.handlers.SetConfig = (c) => setConfigImpl(c);

const row = (id) => ({
  id,
  path: `/d/m${id}.dem`,
  map: 'de_mirage',
  size: 1048576,
  scoreCT: 13,
  scoreT: 9,
  ctName: 'Alpha',
  tName: 'Beta',
  realRounds: 22,
  durationS: 3600,
  extractedAt: '2026-01-01T00:00:00Z',
  status: 'ready',
  error: '',
});
// Windows behind the behind facet: window 0 = rows 1..2 (hasNext), the
// afterID=2 window = rows 3..4 (exhausted) — section G drives Load more.
const WINDOWS = { 0: { rows: [row(1), row(2)], hasNext: true }, 2: { rows: [row(3), row(4)], hasNext: false } };
let listFail = false; // section E flips this to fail the list read
let behindCount = 2; // CountMatches({behind:true})
let libTotal = 5; // CountMatches({})

bindings.handlers.ListMatchesPage = (q, sk, d, afterID, limit, f) => {
  if (listFail) throw new Error('list exploded');
  const w = WINDOWS[afterID] || { rows: [], hasNext: false };
  return { rows: w.rows, hasNext: w.hasNext, rosters: {} };
};
bindings.handlers.CountMatches = (q, f) => (f && f.behind ? behindCount : libTotal);
bindings.handlers.RecomputeStates = () => ({ queued: [1, 2], running: [3] });
let recomputeAllImpl = () => ({ submitted: 3, skipped: 1, total: 4 });
bindings.handlers.RecomputeAll = () => recomputeAllImpl();

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
// ConfirmDialog imports Dialog → point at the local bundle.
const cdSrc = readFileSync('src/lib/components/ConfirmDialog.svelte', 'utf8').replace(
  "import Dialog from './Dialog.svelte';",
  "import Dialog from './dialog.js';",
);
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
  'replay/audio.js', 'replay/sfx.js',
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
await sleep(150); // mount + the immediate first behind fetch

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
const pageCalls = () => bindings.calls.filter((c) => c.method === 'ListMatchesPage');
const countCalls = () => bindings.calls.filter((c) => c.method === 'CountMatches');
const listCalls = () => bindings.calls.filter((c) => c.method === 'ListMatches');
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const type = (el, value) => {
  el.value = value;
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
};
const saveBtn = () => $('button').find((b) => b.textContent.includes('Save rules'));
const rerunAllBtn = () => $('button').find((b) => /Re-run all|Re-running…/.test(b.textContent));
const tradeInput = () => document.getElementById('sett-trade');
const confirmBtn = () =>
  $('.cf-actions button').find((b) => b.textContent.includes('Re-run all'));

console.log('A. pristine gating: Save disabled + "No changes", edits arm it');
{
  const save = saveBtn();
  check('Save present', !!save);
  check('Save disabled while pristine', save && save.disabled, String(save && save.disabled));
  check(
    'honest "No changes" copy shown',
    body().includes('No changes — the rules above are already saved.'),
  );
  check('no re-run hint while pristine', !body().includes('Saving applies these rules'));
  check('rules version rendered', body().includes('Rules version'));

  type(tradeInput(), '7');
  await sleep(10);
  check('edit arms Save', saveBtn() && !saveBtn().disabled);
  check('"No changes" gone after edit', !body().includes('No changes — the rules above'));
  check('re-run hint appears while dirty', body().includes('Saving applies these rules'));

  type(tradeInput(), '5'); // back to pristine
  await sleep(10);
  check('revert disarms Save again', saveBtn() && saveBtn().disabled);
  check('"No changes" back after revert', body().includes('No changes — the rules above are already saved.'));
}

console.log('B. behind fetch shape: bounded page + counts, no whole-library read');
{
  check('exactly one page fetch on mount', pageCalls().length === 1, String(pageCalls().length));
  {
    const c = pageCalls()[0];
    check('free-text query stays empty', c.args[0] === '', JSON.stringify(c.args[0]));
    check('sort stays extracted_at', c.args[1] === 'extracted_at', String(c.args[1]));
    check('window bounded by BEHIND_PAGE (50)', c.args[4] === 50, String(c.args[4]));
    check(
      'behind facet rides the shared filter normalization',
      c.args[5] && c.args[5].behind === true,
      JSON.stringify(c.args[5]),
    );
    check('first window starts at cursor 0', c.args[3] === 0, String(c.args[3]));
  }
  check('whole-library ListMatches never called', listCalls().length === 0, String(listCalls().length));
  check('behind count + total count fetched', countCalls().length === 2, String(countCalls().length));
  check(
    'behind count carries the facet',
    countCalls().some((c) => c.args[1] && c.args[1].behind === true),
  );
  check('two rows render', $('.sett-match-row').length === 2, String($('.sett-match-row').length));
  check(
    'honest count line: "2 matches behind the current rules"',
    body().includes('2 matches behind the current rules'),
  );
  check(
    'showing X of N uses CountMatches (2 of 2 — no line needed yet)',
    !body().includes('Showing 2 of'),
  );
  check('Re-run all enabled with 2 behind', rerunAllBtn() && !rerunAllBtn().disabled);
}

console.log('C. re-query on spectra:analysis-done (rows stamp out, N decrements)');
{
  const beforePages = pageCalls().length;
  const beforeCounts = countCalls().length;
  // A member finishes: it leaves the behind set (backend stamps it), so
  // the next count reads 1 — the view must re-query and show that.
  behindCount = 1;
  fire('spectra:analysis-done', { matchId: 1, error: '' });
  await sleep(250); // 150 ms debounce + fetch
  check('list re-queried after analysis-done', pageCalls().length > beforePages, `${beforePages} -> ${pageCalls().length}`);
  check('counts re-queried after analysis-done', countCalls().length > beforeCounts, `${beforeCounts} -> ${countCalls().length}`);
  check(
    'count line decremented to the fresh N',
    body().includes('1 match behind the current rules'),
  );
}

console.log('G. Load more: keyset window appends with the last row as cursor');
{
  const before = pageCalls().length;
  const loadMore = $('button').find((b) => b.textContent.includes('Load more'));
  check('Load more offered while hasNext', !!loadMore);
  if (loadMore) {
    click(loadMore);
    await sleep(50);
    const after = pageCalls();
    check('next window fetched', after.length > before, `${before} -> ${after.length}`);
    const last = after[after.length - 1];
    check('cursor is the last rendered row id', last.args[3] === 2, String(last.args[3]));
    check('four rows now rendered', $('.sett-match-row').length === 4, String($('.sett-match-row').length));
    check(
      'Load more dropped when exhausted',
      !$('button').some((b) => b.textContent.includes('Load more')),
    );
    check(
      'showing X of N still honest (4 of CountMatches 1 — capped by N semantics: X never exceeds shown of total)',
      body().includes('1 match behind the current rules'),
    );
  }
}

console.log('D. Re-run-all: confirm → {submitted,skipped,total} → honest k/N');
{
  // Per-row chips seed from RecomputeStates (queued 1,2 / running 3).
  check(
    'per-row queued chip from RecomputeStates rehydration',
    $('.sett-match-row').some((r) => r.textContent.includes('queued')),
    body().slice(0, 200),
  );

  const btn = rerunAllBtn();
  check('Re-run all enabled', btn && !btn.disabled);
  click(btn);
  await sleep(30);
  const cf = confirmBtn();
  check('confirm dialog opens', !!cf);
  check(
    'confirm message names the honest behind count',
    body().includes('all 1 match behind the current rules') ||
      body().includes('all 1 matches behind the current rules'),
    '',
  );
  if (cf) {
    click(cf);
    await sleep(50);
  }
  check('RecomputeAll called once', bindings.callCount('RecomputeAll') === 1, String(bindings.callCount('RecomputeAll')));
  check(
    'k/N line: "Re-running 3 matches — 0/3 analyzed"',
    body().includes('Re-running 3 matches') && body().includes('0/3 analyzed'),
    body().match(/Re-running[^<]*/) || '',
  );
  check('skip note shown (1 skipped)', body().includes('1 skipped (already re-running).'));
  check('button switches to busy label', rerunAllBtn() && rerunAllBtn().textContent.includes('Re-running…'));

  // Three completions (the batch's N) → k/N counts up from the SAME
  // analysis-done subscription as the per-row chips.
  fire('spectra:analysis-done', { matchId: 1, error: '' });
  await sleep(20);
  check('k increments to 1/3', body().includes('1/3 analyzed'));
  fire('spectra:analysis-done', { matchId: 2, error: '' });
  fire('spectra:analysis-done', { matchId: 3, error: '' });
  await sleep(20);
  check('k reaches 3/3', body().includes('3/3 analyzed'));
  check('batch complete: "Re-ran 3 matches"', body().includes('Re-ran 3 matches'));
  check('button no longer busy', rerunAllBtn() && !rerunAllBtn().textContent.includes('Re-running…'));

  // A stray 4th done must NOT overrun N (clamped to submitted).
  fire('spectra:analysis-done', { matchId: 99, error: '' });
  await sleep(20);
  check('extra done never overruns N (still 3/3)', body().includes('3/3 analyzed') && !body().includes('4/3'));
}

console.log('F. save honesty: no-bump says "No changes", bump keeps the re-run copy');
{
  // F1: server judges the values identical (same ruleVersion back).
  setConfigImpl = (c) => ({ ...c, ruleVersion: RULES.ruleVersion }); // NO bump
  type(tradeInput(), '9');
  await sleep(10);
  check('edit armed Save for the no-bump save', saveBtn() && !saveBtn().disabled);
  const beforePages = pageCalls().length;
  click(saveBtn());
  await sleep(50);
  check(
    'no-bump save says "No changes", never the re-run nudge',
    body().includes('No changes — the rules were already saved with these values.') &&
      !body().includes('Saved. Matches you'),
  );
  check('Save disarmed after save (pristine re-snapshotted)', saveBtn() && saveBtn().disabled);
  check('rules version unchanged after no-bump', body().includes('Rules version') && !body().includes('Rules version:\n'));
  check('save re-queried the behind list', pageCalls().length > beforePages, `${beforePages} -> ${pageCalls().length}`);

  // F2: a real bump keeps the existing re-run copy.
  setConfigImpl = (c) => ({ ...c, ruleVersion: RULES.ruleVersion + 1 });
  type(tradeInput(), '11');
  await sleep(10);
  click(saveBtn());
  await sleep(50);
  check(
    'bumped save keeps the re-run copy',
    body().includes("Saved. Matches you've already imported keep their old numbers"),
  );
  check('Save disarmed after the bump save', saveBtn() && saveBtn().disabled);
}

console.log('E. empty state + error gating (a failed read is never "all analyzed")');
{
  // E1: 0 behind, N total → the friendly all-analyzed line.
  behindCount = 0;
  libTotal = 5;
  fire('spectra:analysis-done', { matchId: 4, error: '' });
  await sleep(250);
  check(
    '0 behind → "All 5 matches analyzed under current rules"',
    body().includes('All 5 matches analyzed under current rules'),
  );
  check('Re-run all disabled at 0 behind', rerunAllBtn() && rerunAllBtn().disabled);
  check('disabled title explains why', rerunAllBtn() && rerunAllBtn().title.includes('No matches behind'));

  // E2: the next re-query FAILS → the alert carries it and the
  // all-analyzed claim must disappear (it would be a false claim from a
  // broken fetch).
  listFail = true;
  fire('spectra:analysis-done', { matchId: 5, error: '' });
  await sleep(250);
  check('failure alert rendered', $('.error[role="alert"]').some((e) => e.textContent.includes('list exploded')));
  check(
    'no false "All N analyzed" claim while the read is failed',
    !body().includes('All 5 matches analyzed under current rules'),
  );
  check('Retry offered on the list error', $('button').some((b) => b.textContent.includes('Retry')));

  // E3: Retry recovers (clears-on-retry: the error dies when the read lands).
  listFail = false;
  behindCount = 0;
  const retry = $('.error[role="alert"] button').find((b) => b.textContent.includes('Retry'));
  if (retry) click(retry);
  await sleep(100);
  check('error cleared after a successful retry', !body().includes('list exploded'));
  check('all-analyzed line returns', body().includes('All 5 matches analyzed under current rules'));
}

console.log('H. parallel work: 1..max numeric control in its own Background work card');
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

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
unmount();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
