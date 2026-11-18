// jsdom driver for the Reports metrics appendix (stored-metrics design
// §5's Reports surface — the appendix SELECTOR: ONE type-to-search
// token field whose picks land as chips with their own ✕, and the save
// that downloads the composed document).
//   A. the item universe behind the field is the raw RECORDED values
//      (the fixed stats' scoreboard counterparts — N5) followed by the
//      flat match-scope METRIC definitions — the groupBy grouping died
//      with the W2 grammar wave (no "by …" group headers, no
//      profile-scope rows: those surface on PlayerProfile);
//   A2. W17 (owner, 2026-11-16): the save button sits at the RIGHT end
//      of the stats-inputs line (the ONE .row-between around the token
//      field) and leads with the SAVE codicon — never play;
//   B. picking a stat (through the field's suggestion) reads the
//      STORED rows through the canonical read (one call carrying the
//      whole picked set + the roster label read) — PreviewMetric is
//      NEVER called for a saved definition — and the pick lands as a
//      chip with a remove button beside its readout line;
//   C. Save report lands the composed document (the export surface) on
//      disk through downloadText — the design copy "per player · N rows
//      · match #id" and the displayed rows ride the file — never "group
//      by …", never a `· N ms` timing line, never a stamp;
//   D. the field offers only the stats you do not hold (no duplicate
//      can form), a non-fresh stat renders its STATE chip in its
//      readout line and an honest "value not computed — <state>" line
//      in the saved file (no table, no fabricated number), and the
//      chip's ✕ removes it;
//   E. the live feed flips a picked stat to processing and metric-done
//      refetches the stored rows (the cache flushed);
//   F. the no-version pin over every rendered metric output (the
//      readout chips/lines AND the saved file);
//   G. the field follows the match ORDER pref (dogfooding design §1)
//      AND the saved document's sections follow the same sequence (the
//      W4 addendum — design §2.5): the selection restores from the
//      registry on remount, chips render in the sequence (not the pick
//      order), Backspace on an empty field drops the last chip, the ✕
//      clears the rest, no chips → no appendix, and a deleted key
//      returns both the list and the file to the default order — the
//      pins array never orders this list;
//   G2. a raw recorded value (N5) is addable WITHOUT a definition: the
//      pick reads the SCOREBOARD (never getMetricValuesForMatch, never
//      PreviewMetric), its readout carries ONE static provenance chip
//      (no state chip, no expression text), and its export section
//      carries the recorded-value meta line + the table with N = the
//      stored round count — never "value not computed", never a
//      Formula:, never a compute-state word (honesty: a recorded value
//      is not a metric), plus the no-version leak scan over both;
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
  .replace("from '../metricstate.js'", `from '${fileURL('src/lib/metricstate.js')}'`)
  // plumbing (Strings Stage 3): the picker imports the strings catalog.
  .replace("from '../strings/index.js'", `from '${fileURL('src/lib/strings/index.js')}'`);
svelteCompile(playerPickerSrc, 'PlayerPicker.svelte', join(dir, 'playerpicker.js'));
// The appendix selector (TokenSelect — the token field over the metric
// catalog): Popover leaf + the strings catalog rebased like every other
// component this driver mounts.
const tokenSelectSrc = readFileSync('src/lib/components/TokenSelect.svelte', 'utf8')
  .replace("from './Popover.svelte'", "from './popover.js'")
  .replace("from '../strings/index.js'", `from '${fileURL('src/lib/strings/index.js')}'`);
svelteCompile(tokenSelectSrc, 'TokenSelect.svelte', join(dir, 'tokenselect.js'));

// HelpButton — the shared header `?` (help-buttons wave, 2026-11-15):
// the view's header button is this component; its strings catalog
// import resolves from the real tree like every other component here.
const helpButtonSrc = readFileSync('src/lib/components/HelpButton.svelte', 'utf8').replace(
  "from '../strings/index.js'",
  `from '${fileURL('src/lib/strings/index.js')}'`,
);
svelteCompile(helpButtonSrc, 'HelpButton.svelte', join(dir, 'helpbutton.js'));

// download.js — the save path the view drives (the ruling: the composed
// document goes through downloadText + the native dialog, NOT
// /api/export). Every helper RECORDS its call in globalThis.__downloads
// and resolves "" (save.js's cancel contract), so a pin can read back
// the exact bytes that would have been written.
writeFileSync(
  join(dir, 'download.js'),
  `export const downloadText = (...a) => {
  globalThis.__downloads = (globalThis.__downloads || []).concat({ kind: 'text', args: a });
  return Promise.resolve('');
};
export const downloadBlob = (...a) => {
  globalThis.__downloads = (globalThis.__downloads || []).concat({ kind: 'blob', args: a });
  return Promise.resolve('');
};
`,
);

// The view: plain-ESM imports resolve from their real module locations
// (services → the stubs, metricorder/players/viewstate absolute), the
// .svelte imports point at the local bundles, download.js at the
// recording stub above.
const repSrc = readFileSync('src/lib/views/Reports.svelte', 'utf8')
  .replace("from '../services.js'", `from '${fileURL('src/lib/services.js')}'`)
  .replace("from '../metricorder.js'", `from '${fileURL('src/lib/metricorder.js')}'`)
  .replace("from '../metricstate.js'", `from '${fileURL('src/lib/metricstate.js')}'`)
  .replace("from '../players.js'", `from '${fileURL('src/lib/players.js')}'`)
  .replace("from '../viewstate.svelte.js'", `from '${fileURL('src/lib/viewstate.svelte.js')}'`)
  .replace("from '../download.js'", "from './download.js'")
  .replace("from '../components/MatchPicker.svelte'", "from './matchpicker.js'")
  .replace("from '../components/PlayerPicker.svelte'", "from './playerpicker.js'")
  .replace("from '../components/TokenSelect.svelte'", "from './tokenselect.js'")
  .replace("from '../components/StatusChip.svelte'", "from './statuschip.js'")
  .replace("from '../components/HelpButton.svelte'", "from './helpbutton.js'")
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

// --- The token field ---------------------------------------------------------
// TokenSelect renders the selection as chips INSIDE the field (.tk-tok,
// each with its .tk-x remove button) and the suggestions as .tk-opt rows
// in the panel that focus/typing opens. The pick lives in the set, so a
// stat is found by its chip's text (an input's value never lands in
// textContent) and a readout line by the stat name it leads with.
const tokens = (root) => [...root.querySelectorAll('.tk-tok')];
const tokenNames = (root) => tokens(root).map((c) => c.textContent.trim());
const removeBtn = (root, name) => {
  const tok = tokens(root).find((c) => c.textContent.trim() === name);
  return tok ? tok.querySelector('.tk-x') : null;
};
const readout = (root, name) =>
  [...root.querySelectorAll('.rep-metric')].find(
    (el) => (el.querySelector('strong')?.textContent || '').trim() === name,
  ) || null;
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
// Focus opens the suggestion panel (TokenSelect's onfocus → open), so
// the options are readable once the panel paints.
const openBox = async (root) => {
  root.querySelector('#rep-stats').dispatchEvent(
    new dom.window.FocusEvent('focus', { bubbles: false }),
  );
  await sleep(60);
  return [...root.querySelectorAll('.tk-opt')];
};
const optLabels = (opts) => opts.map((o) => o.textContent.trim());
// The six raw recorded-value items in their fixed-block order (N5) —
// they LEAD the universe (metricorder.composedSequence's fixed
// positions), so every option-list pin below composes with them.
// W13b (2026-11-16): the raw items carry the label table's FULL names
// (the appendix chips and the exported headings read "Kills"), never
// the bare scoreboard shorts.
// w13d (2026-11-16): KDA left with @KDA — the scoreboard's KDA column
// is the seeded `kda` metric now, so it offers through the metric
// catalog instead (this fixture scripts no `kda` metric).
const RAW_LABELS = ['Kills', 'Deaths', 'Damage', 'Utility damage', 'MVPs', 'Score'];

// --- The save ----------------------------------------------------------------
// The Generate/Save button (its busy shape — {#if rendering}Generating…
// {:else}… — is pinned by progress-presentation.dom.mjs) and the
// recorded downloadText call: [filename, mime, text].
const saveBtn = (root) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent.includes('Save report'));
const saveReport = async (root) => {
  const before = (globalThis.__downloads || []).length;
  click(saveBtn(root));
  await sleep(120);
  const all = globalThis.__downloads || [];
  return all.length > before ? all[all.length - 1] : null;
};
const savedText = (dl) => (dl ? dl.args[2] : '');

// --- The scripted backend ---------------------------------------------------
// One match-scope metric (picked → stored rows) and one profile-scope
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
// The recorded-value read (N5): scripted with the other backend reads
// so ANY section's raw pick finds it (it is a cachedRead, so the
// player-target effect below shares this one backend call). Section H
// re-scripts it for the player scope. `roundsPlayed` is the per-row N
// the raw appendix line reports — the STORED round count, never a
// formula's sample size.
bindings.handlers.GetScoreboard = () => [
  {
    steamId: '76561198000000001', name: 'amy', side: 'ct', isBot: false,
    kills: 20, deaths: 5, totalDamage: 1750, utilityDamage: 120,
    mvps: 3, score: 48, roundsPlayed: 24,
  },
];

// The canonical stored-value read — recorded so the checks can pin the
// args (design §5: no per-toggle query-time run, no PreviewMetric).
const storedCalls = [];
bindings.handlers.GetMetricValuesForMatch = (matchID, metricIDs) => {
  storedCalls.push([matchID, metricIDs]);
  const out = [];
  for (const id of metricIDs || []) {
    if (id === 1) {
      out.push({ metricId: 1, subjectKey: '76561198000000001', value: 4.25, n: 7 });
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
  inst = mount(mod.default, { target: root, props: { nav: () => {}, openDocs: (s) => (globalThis.__docs = [...(globalThis.__docs || []), s]) } });
  await sleep(120); // mount + the template/match/metrics reads
  return root;
}

viewstate.resetViewState();
const r = await mountReports();

console.log('A. the item universe behind the field is the raw recorded values plus the flat match-scope metrics');
{
  const opts = await openBox(r);
  const labels = optLabels(opts);
  // N5: the six raw recorded values lead (the fixed block's
  // positions), then the match-scope metric definitions — a
  // profile-scope metric never enters a per-match appendix. W13b: the
  // raw labels are the table's FULL names. w13d: KDA left with @KDA
  // (it offers as a metric now, and this fixture scripts none).
  check(
    'the raw recorded values AND the match-scope metrics offer themselves (a profile-scope metric never does)',
    JSON.stringify(labels) ===
      JSON.stringify([
        'Kills', 'Deaths', 'Damage', 'Utility damage', 'MVPs', 'Score',
        'Match stat', 'Behind stat',
      ]) &&
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

// W17 (owner, 2026-11-16): the save button left the panel header and
// parks at the RIGHT end of the stats-inputs line — the field whose
// picks it exports and the button that writes the document share ONE
// .row-between. The play glyph died with the move: the save codicon
// LEADS the label now (the busy shape itself is progress-presentation's
// pin). This fixture scripts a template, so the whole appendix block
// ({#if tpl}) — button included — renders.
console.log('A2. W17: the save button sits on the stats-inputs line, save icon leading');
{
  const statsField = r.querySelector('#rep-stats');
  // The input sits INSIDE TokenSelect's .tk root — the line is its
  // nearest .row-between ancestor (the wrapper this wave added).
  const saveRow = statsField?.closest('.row-between');
  const save = saveBtn(r);
  check(
    'the stats field and the save button share ONE .row-between line, button at its right end',
    !!statsField &&
      !!save &&
      saveRow?.classList.contains('row-between') &&
      saveRow.lastElementChild === save &&
      r.querySelectorAll('.row-between').length === 1,
    saveRow
      ? `${saveRow.className} / rows=${r.querySelectorAll('.row-between').length}`
      : 'no #rep-stats',
  );
  check(
    'the button leads with the SAVE codicon (never play) and keeps its label',
    !!save &&
      save.firstElementChild?.classList.contains('codicon-save') &&
      !save.querySelector('.codicon-play') &&
      save.textContent.includes('Save report'),
    save ? save.innerHTML.slice(0, 160) : 'no save button',
  );
}

console.log('B. picking a stat reads the STORED rows (one call) — never PreviewMetric — and lands as a chip');
{
  const previewBefore = bindings.callCount('PreviewMetric');
  storedCalls.length = 0;
  const opts = await openBox(r);
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
  check(
    'the pick lands as a chip carrying the stat name, with its remove button',
    JSON.stringify(tokenNames(r)) === JSON.stringify(['Match stat']) &&
      !!removeBtn(r, 'Match stat'),
    JSON.stringify(tokenNames(r)),
  );
  const line = readout(r, 'Match stat');
  const statusChip = line && line.querySelector('.chip.status');
  const rowsChip =
    line && [...line.querySelectorAll('.chip')].find((c) => /rows$/.test(c.textContent.trim()));
  check(
    'its readout line shows the honest row count (fresh), never a state chip',
    !!line && !statusChip && !!rowsChip && rowsChip.textContent.trim() === '1 rows',
    line ? line.textContent.replace(/\s+/g, ' ') : 'no readout line',
  );
}

console.log('C. Save report lands the composed document — body + appendix, design copy, no timing, no stamp');
{
  const dl = await saveReport(r);
  const text = savedText(dl);
  check(
    'the save goes through downloadText with the template’s filename and mime',
    !!dl && dl.kind === 'text' &&
      dl.args[0] === 'match-summary-match-13.md' &&
      dl.args[1] === 'text/markdown',
    dl ? JSON.stringify(dl.args.slice(0, 2)) : 'no download recorded',
  );
  check(
    'the report body lands in the saved file with the appendix',
    text.includes('REPORT BODY'),
    text.slice(0, 120),
  );
  check(
    'the appendix line is the design §5 copy ("per player · N rows · match #id")',
    text.includes('per player · 1 rows · match #13'),
    text.replace(/\s+/g, ' ').slice(0, 400),
  );
  check(
    'no "group by …" copy and no "· ms" timing line survives',
    !text.includes('group by') && !/\d+\s*ms/.test(text),
    text.replace(/\s+/g, ' ').slice(0, 400),
  );
  check(
    'the saved rows carry the roster label, the value and n',
    text.includes('| 76561198000000001 | amy | 4.25 | 7 |'),
    text.replace(/\s+/g, ' ').slice(0, 400),
  );
}

console.log('D. the field offers only the free stats; a non-fresh stat renders its STATE — line chip, honest file line; the ✕ removes');
{
  const opts = await openBox(r);
  const labels = optLabels(opts);
  check(
    'a picked stat never offers itself again (no duplicate can form) — the raw values still do',
    JSON.stringify(labels) === JSON.stringify([...RAW_LABELS, 'Behind stat']),
    JSON.stringify(labels),
  );
  click(opts.find((o) => o.textContent.includes('Behind stat')));
  await sleep(120);
  const line = readout(r, 'Behind stat');
  const chip = line && line.querySelector('.chip.status');
  check(
    'the behind stat shows the idle chip, never a row count',
    !!chip && chip.classList.contains('idle') && chip.textContent.trim() === 'behind',
    line ? line.textContent.replace(/\s+/g, ' ') : 'no readout line',
  );
  const dl = await saveReport(r);
  const text = savedText(dl);
  check(
    'the saved file carries "value not computed — behind" and no table for it',
    text.includes('value not computed — behind') &&
      !text.includes('Behind stat\n\n|'),
    text.replace(/\s+/g, ' ').slice(0, 500),
  );
  click(removeBtn(r, 'Behind stat'));
  await sleep(60);
  const again = optLabels(await openBox(r));
  check(
    'the chip’s ✕ removes the stat — chip and readout line go, and it becomes pickable again',
    !tokenNames(r).includes('Behind stat') && !readout(r, 'Behind stat') &&
      // "Match stat" is still held (E reads its line) — a held stat is
      // never re-offered, so only the removed one comes back (beside
      // the raw values, which no metric pick ever holds).
      JSON.stringify(again) === JSON.stringify([...RAW_LABELS, 'Behind stat']),
    JSON.stringify({ tokens: tokenNames(r), again }),
  );
}

console.log('E. the live feed flips to processing; metric-done refetches the stored rows');
{
  const line = readout(r, 'Match stat');
  fire('spectra:metric-progress', { metricId: 1, stage: 'compute', done: 2, total: 5 });
  await sleep(60);
  const chip = line.querySelector('.chip.status');
  check(
    'metric-progress flips the picked stat to the busy chip with its k/N bar',
    !!chip && chip.classList.contains('busy') && chip.textContent.includes('processing') &&
      !!chip.querySelector('.chip-bar'),
    line.textContent.replace(/\s+/g, ' '),
  );
  const before = storedCalls.length;
  fire('spectra:metric-done', { ok: true, error: '', metricIds: [1] });
  await sleep(120);
  check(
    'metric-done refetches the stored rows (the cache flushed + the reload)',
    storedCalls.length > before && !line.querySelector('.chip.status.busy'),
    `calls ${before} -> ${storedCalls.length}`,
  );
}

console.log('F. no version number or timestamp in any rendered metric output');
{
  const leakRe = /version|\bv\d+\b|\d{4}-\d{2}-\d{2}|rule stamp|computed at/i;
  const leaks = [];
  // The scan walks the WHOLE readout row now (N5) — a raw item's
  // provenance chip rides the same `.rep-metric` line a metric's does.
  for (const el of r.querySelectorAll('.tk-tok, .rep-metric, .rep-metric [title]')) {
    const tip = el.getAttribute('title') || '';
    if (leakRe.test(tip)) leaks.push(`title: ${tip}`);
    if (leakRe.test(el.textContent || '')) leaks.push(`text: ${el.textContent.trim().slice(0, 80)}`);
  }
  const all = globalThis.__downloads || [];
  const text = all.length ? all[all.length - 1].args[2] : '';
  if (leakRe.test(text)) leaks.push(`saved file: ${text.slice(0, 80)}`);
  check('no version number or timestamp appears anywhere in the appendix output', leaks.length === 0, leaks.join(' | '));
}

console.log('G. the field follows the match ORDER pref (metricorder — the one sequence); chips restore, Backspace/✕ clear, no chips → no appendix');
{
  // Absent pref ⇒ the default sequence, which over this unranks catalog
  // equals catalog order (already pinned by A's default options).
  bindings.handlers.GetPref = (key) =>
    key === 'metric_order_match' ? ['behind_stat', 'match_stat'] : undefined;
  const r2 = await mountReports();
  // B/D wrote the selection (the registry `stats`), so this mount
  // restores the chip — remounted state, not a leftover DOM node.
  check(
    'the selection restores from the registry on remount (chip + readout line back)',
    JSON.stringify(tokenNames(r2)) === JSON.stringify(['Match stat']) &&
      !!readout(r2, 'Match stat'),
    JSON.stringify(tokenNames(r2)),
  );
  // Drop it so the WHOLE sequence is on offer again (the field only ever
  // lists what you do not hold).
  click(removeBtn(r2, 'Match stat'));
  await sleep(60);
  const opts = await openBox(r2);
  const labels = optLabels(opts);
  check(
    'a saved order re-sequences the metric list (behind_stat first) — the raw values keep leading at their fixed positions',
    JSON.stringify(labels) ===
      JSON.stringify([...RAW_LABELS, 'Behind stat', 'Match stat']),
    JSON.stringify(labels),
  );
  // Pick in the OPPOSITE order: the chips still render in the sequence
  // (the exported document's sections follow the same one).
  click(opts.find((o) => o.textContent.includes('Match stat')));
  await sleep(60);
  const opts2 = await openBox(r2);
  click(opts2.find((o) => o.textContent.includes('Behind stat')));
  await sleep(60);
  check(
    'the chips render in the metric-order sequence, not the pick order',
    JSON.stringify(tokenNames(r2)) === JSON.stringify(['Behind stat', 'Match stat']),
    JSON.stringify(tokenNames(r2)),
  );
  const dl = await saveReport(r2);
  const text = savedText(dl);
  {
    const [m, b] = [text.indexOf('### Match stat'), text.indexOf('### Behind stat')];
    check(
      'the saved document orders its sections by the match sequence (behind_stat first)',
      m > -1 && b > -1 && b < m,
      text.replace(/\s+/g, ' ').slice(0, 300),
    );
  }
  // Backspace on the EMPTY field drops the last chip (the keyboard path).
  const input = r2.querySelector('#rep-stats');
  input.dispatchEvent(new dom.window.FocusEvent('focus', { bubbles: false }));
  await sleep(60);
  input.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }),
  );
  await sleep(60);
  check(
    'Backspace on an empty field removes the last chip (sequence order)',
    JSON.stringify(tokenNames(r2)) === JSON.stringify(['Behind stat']),
    JSON.stringify(tokenNames(r2)),
  );
  click(removeBtn(r2, 'Behind stat'));
  await sleep(60);
  check(
    'the remaining chip’s ✕ clears the field',
    tokenNames(r2).length === 0,
    JSON.stringify(tokenNames(r2)),
  );
  const dl2 = await saveReport(r2);
  const text2 = savedText(dl2);
  check(
    'no chips → the saved file carries no appendix section (the body alone)',
    text2.includes('REPORT BODY') && !text2.includes('## Stats appendix'),
    text2.replace(/\s+/g, ' ').slice(0, 300),
  );

  // Reset deletes the key (metricorder.resetOrder → kvstore Delete) —
  // here: the key simply stops resolving, and the default returns.
  delete bindings.handlers.GetPref;
  const r3 = await mountReports();
  const opts3 = await openBox(r3);
  const labels3 = optLabels(opts3);
  check(
    'key gone → the default sequence again (raw values, then the catalog order)',
    JSON.stringify(labels3) === JSON.stringify([...RAW_LABELS, 'Match stat', 'Behind stat']),
    JSON.stringify(labels3),
  );
  click(opts3.find((o) => o.textContent.includes('Match stat')));
  await sleep(60);
  const opts4 = await openBox(r3);
  click(opts4.find((o) => o.textContent.includes('Behind stat')));
  await sleep(60);
  const dl3 = await saveReport(r3);
  const text3 = savedText(dl3);
  {
    const [m, b] = [text3.indexOf('### Match stat'), text3.indexOf('### Behind stat')];
    check(
      'key gone → the saved file returns to the default section order (match_stat first)',
      m > -1 && b > -1 && m < b,
      text3.replace(/\s+/g, ' ').slice(0, 300),
    );
  }
}

console.log('G2. a RAW recorded value (N5): addable without a definition — the scoreboard read, no metric read, honest export');
{
  // The raw leg proves itself on a CLEAN selection: with no metric
  // picked, any metric-value read or PreviewMetric call could only
  // come from the raw item — and the raw item has no definition to
  // compute (it reads the recorded scoreboard instead).
  viewstate.resetViewState();
  const rRaw = await mountReports();
  storedCalls.length = 0;
  const sbBefore = bindings.callCount('GetScoreboard');
  const prevBefore = bindings.callCount('PreviewMetric');
  const opts = await openBox(rRaw);
  check(
    'the raw recorded values are on offer beside the metric definitions (same universe, fixed positions leading)',
    JSON.stringify(optLabels(opts)) ===
      JSON.stringify([...RAW_LABELS, 'Match stat', 'Behind stat']),
    JSON.stringify(optLabels(opts)),
  );
  click(opts.find((o) => o.textContent.trim() === 'Kills'));
  await sleep(150);
  check(
    'picking a raw value reads the SCOREBOARD for this match (the recorded read)',
    bindings.callCount('GetScoreboard') > sbBefore && storedCalls.length === 0,
    `sb ${sbBefore} -> ${bindings.callCount('GetScoreboard')}, metric reads=${storedCalls.length}`,
  );
  check(
    'a raw pick NEVER reaches getMetricValuesForMatch nor PreviewMetric',
    storedCalls.length === 0 && bindings.callCount('PreviewMetric') === prevBefore,
    `stored=${JSON.stringify(storedCalls)} preview=${bindings.callCount('PreviewMetric')}`,
  );
  check(
    'the raw pick lands as its own chip (its namespaced id, the full-name label)',
    JSON.stringify(tokenNames(rRaw)) === JSON.stringify(['Kills']),
    JSON.stringify(tokenNames(rRaw)),
  );
  const rawLine = readout(rRaw, 'Kills');
  const rawChips = rawLine ? [...rawLine.querySelectorAll('.chip')] : [];
  check(
    'its readout carries ONE static provenance chip — no state chip, no expression text, no Formula:',
    !!rawLine &&
      rawChips.length === 1 &&
      rawChips[0].textContent.trim() === 'Recorded value' &&
      !rawChips[0].classList.contains('status') &&
      !rawLine.querySelector('.rep-metric-expr') &&
      !/Formula:/.test(rawLine.textContent),
    rawLine ? rawLine.textContent.replace(/\s+/g, ' ') : 'no readout line',
  );
  const rawDl = await saveReport(rRaw);
  const rawText = savedText(rawDl);
  check(
    'the saved document carries the recorded-value heading, the honest meta line and the table — never "value not computed"',
    rawText.includes('### Kills') &&
      rawText.includes('recorded value · per player · 1 players') &&
      rawText.includes('| 76561198000000001 | amy | 20 | 24 |') &&
      !rawText.includes('value not computed'),
    rawText.replace(/\s+/g, ' ').slice(0, 600),
  );
  check(
    'no formula text and no compute-state word reaches a raw export (a recorded value is not a metric)',
    !/Formula:/.test(rawText) &&
      !/(behind|processing|no-data|failed)/.test(rawText.split('## Stats appendix')[1] || ''),
    rawText.replace(/\s+/g, ' ').slice(0, 400),
  );
  // The leak scan (section F) extended over the raw surface: the readout
  // row AND its export are in scope for version/timestamp leaks too.
  {
    const leakRe = /version|\bv\d+\b|\d{4}-\d{2}-\d{2}|rule stamp|computed at/i;
    const leaks = [];
    for (const el of rRaw.querySelectorAll('.tk-tok, .rep-metric, .rep-metric [title]')) {
      const tip = el.getAttribute('title') || '';
      if (leakRe.test(tip)) leaks.push(`title: ${tip}`);
      if (leakRe.test(el.textContent || '')) leaks.push(`text: ${el.textContent.trim().slice(0, 80)}`);
    }
    if (leakRe.test(rawText)) leaks.push(`saved file: ${rawText.slice(0, 80)}`);
    check(
      'no version number or timestamp reaches the raw value output either',
      leaks.length === 0,
      leaks.join(' | '),
    );
  }
  // Restore the selection for the sections below (H mounts its own
  // player-scoped backend anyway; this keeps the registry honest).
  viewstate.resetViewState();
}

console.log('H. the player picker statline composes per half — every half is a seed row');
{
  // Re-script the backend for a PLAYER-scoped target: one roster player,
  // one scoreboard row whose raw stats (kills 20, deaths 5, assists 9,
  // adr 70.5, roundsPlayed 24) must NEVER render, and the seeded
  // match-scope definitions for all five halves. The picker reads the
  // rows Reports fetches beside sbBySteam — the stored values render,
  // and a half with no fresh row is the dash.
  const KILLS = { id: 1, name: 'kills', title: 'Kills', scope: 'match', format: 'int',
    doc: 'Formula: sum(player_stats.kills)', origin: 'builtin' };
  const DEATHS = { id: 2, name: 'deaths', title: 'Deaths', scope: 'match', format: 'int',
    doc: 'Formula: sum(player_stats.deaths)', origin: 'builtin' };
  const ASSISTS_METRIC = { id: 4, name: 'assists', title: 'Assists', scope: 'match',
    format: 'int', doc: 'Formula: sum(player_stats.assists)', origin: 'builtin',
    expr: 'from player_stats: sum(assists)', shortName: 'A', denominator: '', pluginId: '' };
  const ADR = { id: 5, name: 'adr', title: 'ADR', scope: 'match', format: 'float1',
    doc: 'Formula: ratio(sum(total_damage), sum(rounds_played))', origin: 'builtin' };
  const ROUNDS = { id: 6, name: 'rounds_played', title: 'Rounds played', scope: 'match',
    format: 'int', doc: 'Formula: sum(player_stats.rounds_played)', origin: 'builtin' };
  // The FRESH stored rows per metric id — deliberately different from
  // the raw assists column (9): the stored assists value 7 renders, the
  // raw one never does. A null entry is "no fresh row for that seed".
  const statline = { 1: 20, 2: 5, 4: 7, 5: 70.5, 6: 24 };
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
  bindings.handlers.ListMetrics = () => [KILLS, DEATHS, ASSISTS_METRIC, ADR, ROUNDS];
  bindings.handlers.GetMetricComputeState = () =>
    [KILLS, DEATHS, ASSISTS_METRIC, ADR, ROUNDS].map((d) => ({ metricId: d.id, state: 'fresh' }));
  bindings.handlers.GetMetricValuesForMatch = (matchID, metricIDs) =>
    Object.keys(statline)
      .filter((id) => statline[id] != null && (metricIDs || []).includes(Number(id)))
      .map((id) => ({
        metricId: Number(id),
        subjectKey: '76561198000000001',
        value: statline[id],
        n: 24,
      }));
  // The read-through cache holds the previous handlers' answers — flush
  // it so this section's re-scripted reads are the ones the view gets.
  services.invalidate();
  viewstate.resetViewState();

  const openTriple = async (root) => {
    const trigger = root.querySelector('#rep-player');
    if (!trigger) return null;
    trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await sleep(60);
    return root.querySelector('.pp-opt .pp-kda');
  };

  const r4 = await mountReports();
  const kda = await openTriple(r4);
  check(
    'the triple renders the stored K/D/A seed rows (the raw scoreboard 20/5/9 never renders)',
    !!kda && kda.textContent === '20/5/7',
    kda ? kda.textContent : 'no triple cell',
  );
  check(
    'the fresh compound cell keeps its chrome label (no state word while every half shows a number)',
    kda?.getAttribute('title') === 'K / D / A in this match',
    kda?.getAttribute('title') ?? '',
  );
  {
    // The popover is still open from openTriple above — query in place
    // (clicking the trigger again would TOGGLE it shut).
    const adr = r4.querySelector('.pp-opt .pp-adr');
    const rounds = r4.querySelector('.pp-opt .pp-rounds');
    check(
      'the ADR and rounds halves render their seed values with the SEED Formula as the tooltip',
      adr?.textContent.trim() === '70.5' &&
        (adr?.getAttribute('title') || '').startsWith('Formula: ratio(sum(total_damage)') &&
        rounds?.textContent.trim() === '24r' &&
        (rounds?.getAttribute('title') || '').startsWith('Formula: sum(player_stats.rounds_played)'),
      `adr=${adr?.textContent}/${adr?.getAttribute('title')} rounds=${rounds?.textContent}/${rounds?.getAttribute('title')}`,
    );
  }

  // No fresh row for this match (absent or behind alike — the canonical
  // read serves fresh rows only): the A half dashes, K/D still render.
  statline[4] = null;
  services.invalidate();
  const r5 = await mountReports();
  const kda2 = await openTriple(r5);
  check(
    'an absent assists row renders 20/5/— — never the stored 9, never a 0',
    !!kda2 && kda2.textContent === '20/5/—',
    kda2 ? kda2.textContent : 'no triple cell',
  );
  check(
    'the dash half carries the no-data copy in the title (the state lives in the tooltip, never a chip in a compound cell)',
    kda2?.getAttribute('title') === 'no data for this player',
    kda2?.getAttribute('title') ?? '',
  );

  // NO RAW FALLBACK: with the K and D seeds themselves uncomputed the
  // halves dash — the raw scoreboard fields behind them (20 / 5) never
  // print.
  statline[1] = null;
  statline[2] = null;
  statline[4] = 7; // the A half back on its fresh row — only K/D are gaps
  services.invalidate();
  const r6 = await mountReports();
  const kda3 = await openTriple(r6);
  check(
    'a half with no seed row dashes — the raw kills/deaths columns (20/5) never print',
    !!kda3 && kda3.textContent === '—/—/7',
    kda3 ? kda3.textContent : 'no triple cell',
  );

  // A BEHIND seed: the state word reaches the cell through the title
  // (invariant 9 — never a chip inside a compound cell, never a number).
  // The kills row is ABSENT here — a fresh row would (correctly) win the
  // machine's precedence and render the value.
  statline[1] = null;
  statline[2] = 5; // deaths back on its fresh row — kills is the behind half
  bindings.handlers.GetMetricComputeState = () => [
    { metricId: 1, state: 'behind' },
    { metricId: 2, state: 'fresh' },
    { metricId: 4, state: 'fresh' },
    { metricId: 5, state: 'fresh' },
    { metricId: 6, state: 'fresh' },
  ];
  services.invalidate();
  const r7 = await mountReports();
  const kda4 = await openTriple(r7);
  check(
    'a BEHIND K seed renders the state word in the title and a dash — never the raw 20',
    !!kda4 &&
      kda4.textContent.startsWith('—/') &&
      kda4.getAttribute('title') === 'value not available yet — recompute pending',
    kda4 ? `${kda4.textContent} title=${kda4.getAttribute('title')}` : 'no triple cell',
  );
}

// reports-card (2026-11-15): the view's content consolidated to ONE card —
// the template/target block and the stats appendix now share a single
// `<section class="panel">` (both section headings stay inside it). The
// mount shape is the pin; a second panel would mean a split regressed.
{
  const panels = root.querySelectorAll('section.panel');
  check(
    'exactly ONE section.panel renders (both sections live in the single card)',
    panels.length === 1,
    `${panels.length} panels`,
  );
}

console.log('I. the header `?` opens the guide at the reports section (standalone header only)');
{
  // help-buttons wave (2026-11-15): the shared HelpButton is the
  // standalone header's LAST element, right of the .spacer; embedded
  // (Match's Reports tab) the header does not render at all — Match's
  // own header `?` covers that tab.
  viewstate.resetViewState();
  const rr = await mountReports();
  const hdr = rr.querySelector('.view-header');
  const help = hdr?.querySelector(':scope > button[aria-label="Help for this view"]');
  check(
    'the ? is the standalone header’s LAST element, right of the .spacer, shared labels + question glyph',
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
    'clicking it opens the guide at the reports section (openDocs)',
    (globalThis.__docs || []).length === docs0 + 1 && (globalThis.__docs || []).at(-1) === 'reports',
    JSON.stringify((globalThis.__docs || []).slice(docs0)),
  );
}

// W21 (reports-builder, 2026-11-16): the template CARDS' origin
// surfacing — the Reports builder added user templates to the catalog
// this view consumes, so every origin must show on its card, a card must
// be selectable by click (the save below then renders THAT id), and a
// stored selection naming a template that no longer exists must heal to
// a live one instead of leaving no template at all.
console.log('J. origin surfacing: builtin + user + plugin cards render, select, and a stale tplId heals');
{
  bindings.handlers.ListReportTemplates = () => [
    { id: 'j-builtin', title: 'J builtin', scope: 'match', format: 'md', origin: 'builtin', body: 'builtin body' },
    { id: 'j-user', title: 'J user', scope: 'player', format: 'html', origin: 'user', body: 'user body' },
    { id: 'j-plugin', title: 'J plugin', scope: 'round', format: 'md', origin: 'plugin', body: 'plugin body' },
  ];
  viewstate.resetViewState();
  const jj = await mountReports();
  const cards = [...jj.querySelectorAll('.rep-tpl')];
  check(
    'one card per origin renders (builtin + user + plugin)',
    cards.length === 3,
    `${cards.length} cards: ${cards.map((c) => c.querySelector('.rep-tpl-title')?.textContent.trim()).join(', ')}`,
  );
  const origins = cards.map((c) => c.querySelector('.chip.flag')?.textContent.trim());
  check(
    'every card carries its origin chip — builtin / user / plugin',
    JSON.stringify(origins) === JSON.stringify(['builtin', 'user', 'plugin']),
    JSON.stringify(origins),
  );
  check(
    'every card also states its scope and its format beside the origin',
    cards.every((c) => c.querySelectorAll('.rep-tpl-meta .chip').length === 3),
    cards.map((c) => [...c.querySelectorAll('.rep-tpl-meta .chip')].map((x) => x.textContent.trim()).join('/')).join(' | '),
  );
  const pluginCard = cards.find(
    (c) => c.querySelector('.chip.flag')?.textContent.trim() === 'plugin',
  );
  click(pluginCard);
  await sleep(60);
  check(
    'clicking the plugin card selects it',
    pluginCard.getAttribute('aria-pressed') === 'true' && pluginCard.classList.contains('active'),
    `pressed=${pluginCard.getAttribute('aria-pressed')} active=${pluginCard.classList.contains('active')}`,
  );
  const beforeRenders = bindings.calls.filter((c) => c.method === 'RenderReport').length;
  const dl = await saveReport(jj);
  const renders = bindings.calls.filter((c) => c.method === 'RenderReport');
  check(
    'Save renders THAT selected id (the plugin template) and lands the document',
    renders.length === beforeRenders + 1 && renders.at(-1).args[0] === 'j-plugin' && !!dl,
    JSON.stringify(renders.slice(beforeRenders).map((c) => c.args[0])),
  );

  // A stored selection naming a template that no longer exists (a
  // deleted row, an uninstalled plugin) self-heals to a live one —
  // Reports.svelte's loadTemplates guard, pinned here with the
  // three-origin catalog.
  viewstate.resetViewState();
  viewstate.remember('reports', { tplId: 'vanished-template' });
  const j2 = await mountReports();
  const active2 = [...j2.querySelectorAll('.rep-tpl')].find((c) => c.classList.contains('active'));
  check(
    'a stale stored tplId naming a vanished template self-heals to a live one',
    !!active2 && active2.querySelector('.chip.flag')?.textContent.trim() === 'builtin' &&
      !j2.textContent.includes('vanished-template'),
    active2 ? active2.querySelector('.rep-tpl-title')?.textContent.trim() : 'no active card',
  );
}

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
if (inst) await unmount(inst);
// ---------------------------------------------------------------------------
// Section K: the appendix catalog's match-subject + identity entries
// (metrics expansion Phase 7, 2026-11-18 — the plan's Reports row). The
// scope filter already OFFERS every match-scope definition (subject is
// not a filter dimension), so the Phase-7 work is first-class
// presentation: the meta line names the entry's SUBJECT, a match row's
// label is the match itself, and an identity row renders the recorded
// WINNER as its label beside the stored companion (records show what
// was recorded — every row below is a stored read, never a recompute).
console.log('K. match-subject + identity appendix entries: offered, subject-aware meta line, identity label = the recorded winner');
{
  const MATCH_SUBJECT_METRIC = {
    id: 4, name: 'lost_equip', title: 'Lost equipment', scope: 'match', subject: 'match',
    format: 'currency', doc: 'Formula: sum of lost freeze-end equipment', origin: 'builtin',
    expr: 'from round_economy: sum(equip_value)', shortName: '', denominator: '', pluginId: '',
  };
  const IDENTITY_METRIC = {
    id: 5, name: 'top_fragger', title: 'Top fragger', scope: 'match', subject: 'match',
    format: 'identity', doc: 'Formula: argmax(player_stats.kills) — N = the pool',
    origin: 'builtin', expr: 'from player_stats: argmax(kills)',
    shortName: '', denominator: '', pluginId: '',
  };
  bindings.handlers.ListMetrics = () => [
    MATCH_METRIC, PROFILE_METRIC, BEHIND_METRIC, MATCH_SUBJECT_METRIC, IDENTITY_METRIC,
  ];
  bindings.handlers.GetMetricComputeState = () => [
    { metricId: 1, state: 'fresh' },
    { metricId: 2, state: 'fresh' },
    { metricId: 3, state: 'behind' },
    { metricId: 4, state: 'fresh' },
    { metricId: 5, state: 'fresh' },
  ];
  bindings.handlers.GetMetricValuesForMatch = (matchID, metricIDs) => {
    storedCalls.push([matchID, metricIDs]);
    const out = [];
    for (const id of metricIDs || []) {
      if (id === 1) out.push({ metricId: 1, subjectKey: '76561198000000001', value: 4.25, n: 7 });
      if (id === 4) out.push({ metricId: 4, subjectKey: '', value: 42, n: 13 });
      if (id === 5) out.push({ metricId: 5, subjectKey: '', valueKey: '76561198000000001', value: 20, n: 8 });
      // id 3 (behind) deliberately has NO stored row.
    }
    return out;
  };
  services.invalidate();
  const kr = await mountReports();

  // Start from a clean selection (earlier sections' chips may have
  // restored through the registry). Bounded — a stuck ✕ must never
  // spin: the loop below would otherwise never exit.
  for (let guard = 0; tokenNames(kr).length && guard < 10; guard++) {
    click(removeBtn(kr, tokenNames(kr)[0]));
    await sleep(40);
  }

  const opts = await openBox(kr);
  const labels = optLabels(opts);
  check(
    'the match-subject and identity definitions offer themselves beside the player-subject one (a profile metric still never does)',
    labels.includes('Lost equipment') &&
      labels.includes('Top fragger') &&
      labels.includes('Match stat') &&
      !labels.includes('Career stat'),
    JSON.stringify(labels),
  );
  click(opts.find((o) => o.textContent.includes('Lost equipment')));
  await sleep(120);
  const opts2 = await openBox(kr);
  click(opts2.find((o) => o.textContent.includes('Top fragger')));
  await sleep(120);
  check(
    'both picks land as chips with fresh row counts',
    tokenNames(kr).includes('Lost equipment') &&
      tokenNames(kr).includes('Top fragger') &&
      /1 rows/.test(readout(kr, 'Lost equipment')?.textContent || '') &&
      /1 rows/.test(readout(kr, 'Top fragger')?.textContent || ''),
    JSON.stringify(tokenNames(kr)),
  );

  const dl = await saveReport(kr);
  const text = savedText(dl);
  check(
    'the exported meta line names the SUBJECT — "per match · 1 rows · match #13" for both entries (the player copy stays for player metrics)',
    text.includes('per match · 1 rows · match #13') &&
      (text.match(/per match · 1 rows · match #13/g) || []).length === 2,
    text.replace(/\s+/g, ' ').slice(text.indexOf('## Stats appendix'), text.indexOf('## Stats appendix') + 600),
  );
  check(
    'the match row labels itself (match #13) with the recorded value and its N',
    text.includes('|  | match #13 | 42 | 13 |'),
    text.replace(/\s+/g, ' ').slice(text.indexOf('Lost equipment'), text.indexOf('Lost equipment') + 300),
  );
  check(
    'the identity row renders the recorded WINNER as its label (amy, never a raw id) beside the stored companion',
    text.includes('|  | amy | 20 | 8 |') && !/\|[^|]*76561198000000001[^|]*\|[^|]*20 \|/.test(text),
    text.replace(/\s+/g, ' ').slice(text.indexOf('Top fragger'), text.indexOf('Top fragger') + 300),
  );

  // Leave the shared stubs as the section found them (this is the last
  // section): the base script's handlers.
  bindings.handlers.ListMetrics = () => [MATCH_METRIC, PROFILE_METRIC, BEHIND_METRIC];
  bindings.handlers.GetMetricComputeState = () => [
    { metricId: 1, state: 'fresh' },
    { metricId: 2, state: 'fresh' },
    { metricId: 3, state: 'behind' },
  ];
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
