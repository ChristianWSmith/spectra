import './compile-worker-node.mjs';
// jsdom driver for the Profiles view (Part 1: every column sortable,
// default = matches DESC) and for the honest date labels (Part 2: the
// demo-date ruling — a CS2 demo carries no played-at timestamp, so every
// date shown is the match's IMPORT time and the label says so).
//
// Section coverage:
//   A. the default row order is matches DESC (ties keep the SERVICE
//      order — stable-sort fallback), the bot row never lists, and the
//      four headers are the SortTh set with "Last import" (the Part-2
//      relabel) carrying its honesty tooltip;
//   B. first click on Player → A→Z (NOT Z→A — Library's per-column
//      natural-default map, not Combat's blanket desc:true), second
//      click flips direction + the active arrow, and hopping back to
//      Matches re-applies the map's DESC default;
//   C. sort composes with the search filter: the filter narrows first,
//      the sort orders what survives (and the count line follows);
//   D. the search box's suggestion list keeps the SERVICE order — the
//      sort is view-local and never reorders `players`;
//   E. PlayerProfile's match-history column header reads "Imported"
//      (never "Date"), the career-trend dot tooltip leads with the
//      match's patch (fmtPatch) followed by the honest "Imported" date
//      (read off the trend point's own extractedAt), the x-axis
//      caption names the patch-ordered sequence — the chart must not
//      read as a played-on timeline — and the K/D/A cell composes per
//      half (raw K/D, metric-backed assists, null → the honest dash);
//   I. PlayerProfile's headline block (stored-metrics design §1a/§5,
//      the Career-metrics panel dissolved into it by P1): the
//      profile-scope tile set (the default set; no retired key) reads the
//      STORED career rows through the canonical read — fresh renders the
//      value with its n, a non-fresh state renders the chip and never a
//      number, a match-scope metric never surfaces here, and no
//      rendered output carries a version number.
//   J. inferred-conversion W3a: the profile surface after BOTH card
//      conversions — ONE `.stat-grid.prof-stats` block whose fixed pair
//      (Matches, Win%) LEADS the eleven DEFAULT-pinned metric tiles
//      (the Opening-duels rate and the Clutches count among them) in
//      DEFAULT order over a reversed catalog, and the Profiles list's
//      ADR column reading the stored `career_adr` bucket row (value,
//      honest gap, behind chip, metric-value sort).
//   K. PlayerProfile's trend picker: the four-button stat set is gone —
//      the card offers EVERY match-scope metric (never a profile-scope
//      one) through the shared SuggestInput in metricorder sequence,
//      puts the picked metric's TITLE in the field and sends its NAME
//      to the series read (the picker's hint is THE verb hint).
//
// Backend semantics are out of scope here: ListPlayers' ORDER BY
// (last-seen DESC, steam_id ASC) lives in store.ListPlayers
// (internal/store/analytics.go) and GetTrend's patch-ordered seq in
// store.GetTrend — this pins the VIEW's wiring only.
//
// jsdom is a declared devDependency of frontend/ — a plain `npm ci`
// there provides it (never `npm i --no-save`, which makes the next
// `npm ci` prune it). From frontend/ run:
//   node --test test/profiles.dom.mjs
// (must be run with frontend/ as the working directory; the same file
// also runs under `node --conditions browser test/profiles.dom.mjs`)
import { reachesSvelte } from './bundle-reach.mjs';
import { JSDOM } from 'jsdom';
import { compile } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
// The scoped state read answers from the same per-metric states the harness
// sets on GetMetricComputeState, so every player reads the same word here.
bindings.MetricsService.GetMetricStates = (scope, id) => bindings.MetricsService.GetMetricComputeState(scope, id);

// The history row's stored cells (K/D/A, ADR, KAST) are one metric() read per
// match (a match-bound read of the player's stored value). The sections below
// script the player's match-grain values once, through GetMetricSeries; this
// bridge serves the per-match read from the same script, so both reads agree.
const HISTORY_STEAM = '76561198000000001';
const matchValueReads = []; // [matchId, ids] — one entry per history match read
bindings.MetricsService.GetMetricValuesForMatch = async (matchId, ids) => {
  matchValueReads.push([matchId, ids]);
  const rows = (await bindings.MetricsService.GetMetricSeries(HISTORY_STEAM, ids)) || [];
  return rows
    .filter((r) => r.matchId === matchId && ids.includes(r.metricId))
    .map((r) => ({
      metricId: r.metricId, matchId, subjectKey: HISTORY_STEAM, dim: '',
      value: r.value, valueKey: '', n: r.n,
    }));
};

// The one list read both views consume, in SERVICE order (last-seen
// DESC, steam_id ASC — store.ListPlayers): amy, zoe, bob, dan, plus a
// BOT row (20-digit synthetic id) that listedPlayers must drop. The
// service order is deliberately NOT the matches order, so a table that
// silently rendered the service order (or a filter that reordered
// `players`) fails the checks below.
const PLAYERS = [
  { steamId: '76561198000000001', name: 'amy', matches: 1, lastSeen: '2026-03-03' },
  { steamId: '76561198000000002', name: 'zoe', matches: 5, lastSeen: '2026-03-02' },
  { steamId: '76561198000000003', name: 'bob', matches: 5, lastSeen: '2026-03-01' },
  // No import date at all → the cell renders the '—' fallback and the
  // column's ascending sort puts '' first.
  { steamId: '76561198000000004', name: 'dan', matches: 3, lastSeen: '' },
  // The pre-rule bot shape: 9 matches would win every default sort if
  // the canonical client-side filter (lib/players.js) ever leaked it.
  { steamId: '18374686479671623692', name: 'Crew', matches: 9, lastSeen: '2026-03-04' },
];
bindings.ProfileService.ListPlayers = () => Promise.resolve(PLAYERS);

// PlayerProfile's reads (Part 2): one career trend of two points (the
// sparkline needs ≥2) and a two-row match history, each row carrying an
// extractedAt (an IMPORT time).
bindings.ProfileService.GetProfile = () =>
  Promise.resolve({
    steamId: '76561198000000001',
    name: 'amy',
    matches: 2,
    wins: 1,
    adrAvg: 37.5,
    adrStd: 3.5,
    kd: 1.1,
    hsPct: 40,
    kastPct: 70,
    tradeRate: 30,
    trades: 3,
    tradeOpps: 10,
    clutchWinPct: 100,
    avgEnemiesFlashed: 2.1,
    avgUtilDamage: 45.5,
    sides: [],
    maps: [],
    weapons: [],
    history: [
      {
        matchId: 1, extractedAt: '2026-03-03T10:00:00Z', map: 'de_cache', win: true,
        scoreCT: 13, scoreT: 8, startSide: 'ct', kills: 10, deaths: 5, assists: 2,
        adr: 40, kastPct: 70,
      },
      {
        // assists: null is W3a's honest gap — the A half of the K/D/A
        // triple is a stored `assists` metric row now, and this match
        // carries no fresh one (never a fabricated 0).
        matchId: 2, extractedAt: '2026-03-01T10:00:00Z', map: 'de_mirage', win: false,
        scoreCT: 10, scoreT: 13, startSide: 't', kills: 5, deaths: 12, assists: null,
        adr: 35, kastPct: 60,
      },
    ],
  });
// The trend points carry their OWN patch + extractedAt (the tooltip
// reads them straight off the point, never the history join): match 1's
// history row above says 2026-03-03 while this point says 2025-07-28 —
// the import time of the 1.40.8.9 patch — so a tooltip showing 2025
// pins the trend point as the date's source. Patches ascend with seq
// (GetTrend's row order); the history table keeps its own import order.
// Every call is recorded as [steamId, metric] — section K asserts the
// picker sends the metric NAME (never a button key or a display title).
const trendCalls = [];
bindings.ProfileService.GetCareerTrend = (sid, metric) => {
  trendCalls.push([sid, metric]);
  return Promise.resolve([
    { matchId: 1, seq: 0, value: 35, patch: 14089, extractedAt: '2025-07-28T09:00:00Z' },
    { matchId: 2, seq: 1, value: 40, patch: 14113, extractedAt: '2026-03-01T10:00:00Z' },
  ]);
};

const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'profiles');
mkdirSync(dir, { recursive: true });
const fileURL = (p) => pathToFileURL(p).href;
const svelteCompile = (src, filename, out) => {
  writeFileSync(out, compile(src, { filename, generate: 'client' }).js.code);
};

// Every .svelte the view reaches (the view, its shell components and the
// builtin Profile panels) is compiled into the cache dir, recursively: a
// relative .svelte import becomes the bundle of that file; every .js import
// resolves to its real module (the shared graph). Same scheme as
// component-context.dom.mjs.
const bundled = new Map();
let bundleSeq = 0;
// A .js module that imports a .svelte file (the builtin panel registry) is
// bundled too: node cannot load a .svelte specifier itself. Every other .js
// stays where it is, so the shared module graph keeps one instance.
const importsSvelte = (file) => reachesSvelte(file);
function bundleSvelte(absPath, outName = null) {
  if (bundled.has(absPath)) return bundled.get(absPath);
  const out = outName
    ? join(dir, outName)
    : join(dir, `${String(++bundleSeq).padStart(3, '0')}-${absPath.split('/').pop()}.js`);
  bundled.set(absPath, out);
  const src = readFileSync(absPath, 'utf8').replace(/from '(\.{1,2}\/[^']+)'/g, (whole, rel) => {
    const target = resolve(dirname(absPath), rel);
    if (target.endsWith('.svelte')) return `from '${fileURL(bundleSvelte(target))}'`;
    if (target.endsWith('.js') && importsSvelte(target)) return `from '${fileURL(bundleSvelte(target))}'`;
    return `from '${fileURL(target)}'`;
  });
  if (absPath.endsWith('.svelte')) svelteCompile(src, absPath, out);
  else writeFileSync(out, src);
  return out;
}
bundleSvelte(resolve('src/lib/views/Profiles.svelte'), 'profiles-bundle.js');
bundleSvelte(resolve('src/lib/views/PlayerProfile.svelte'), 'playerprofile-bundle.js');

const { mount } = await import('svelte');
const profilesMod = await import(pathToFileURL(join(dir, 'profiles-bundle.js')).href);
const profileMod = await import(pathToFileURL(join(dir, 'playerprofile-bundle.js')).href);

const sleep = (ms = 40) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const focus = (el) => el.dispatchEvent(new dom.window.FocusEvent('focus', { bubbles: false }));
const type = (el, value) => {
  el.value = value;
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
};

async function renderProfiles() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mount(profilesMod.default, { target, props: { nav: () => {} } });
  await sleep(100); // mount + the one listPlayers fetch
  return target;
}

const table = (root) => root.querySelector('table.data-table');
const headers = (root) =>
  [...table(root).querySelectorAll('thead th')].map((th) => th.textContent.trim());
const rowNames = (root) =>
  [...table(root).querySelectorAll('tbody tr')].map(
    (tr) => tr.querySelector('.pf-name').textContent.trim(),
  );
const headerBtn = (root, label) =>
  [...table(root).querySelectorAll('thead th')].find((th) =>
    th.textContent.includes(label),
  )?.querySelector('button');
const arrow = (btn) =>
  btn?.querySelector('.codicon-arrow-down') ? 'down' : btn?.querySelector('.codicon-arrow-up') ? 'up' : '';

console.log('A. default order = matches DESC; SortTh headers; the Part-2 "Last import" label');
const root = await renderProfiles();
check(
  'headers are the sortable set with the honest date label',
  JSON.stringify(headers(root)) === JSON.stringify(['Player', 'Matches', 'ADR', 'Last import']),
  JSON.stringify(headers(root)),
);
check(
  'default rows: matches DESC, ties in service order (zoe before bob)',
  JSON.stringify(rowNames(root)) === JSON.stringify(['zoe', 'bob', 'dan', 'amy']),
  JSON.stringify(rowNames(root)),
);
{
  const bot = [...table(root).querySelectorAll('tbody tr')].find((tr) =>
    tr.textContent.includes('Crew'),
  );
  check('the bot row never lists', !bot, bot ? bot.textContent : '');
}
{
  const matchBtn = headerBtn(root, 'Matches');
  const playerBtn = headerBtn(root, 'Player');
  check(
    'Matches wears the active sort + the DESC arrow on entry',
    matchBtn.classList.contains('sorted') && arrow(matchBtn) === 'down',
    `sorted=${matchBtn.classList.contains('sorted')} arrow=${arrow(matchBtn)}`,
  );
  check('the other headers start inactive', !playerBtn.classList.contains('sorted'));
}
{
  const th = [...table(root).querySelectorAll('thead th')].find((t) =>
    t.textContent.includes('Last import'),
  );
  check(
    'the date header says "import" and explains demos carry no played time',
    /import date/.test(th.getAttribute('title') || '') &&
      /no played time/.test(th.getAttribute('title') || ''),
    th.getAttribute('title'),
  );
}
check('count line reads the full list', root.querySelector('.pf-count').textContent.includes('4 of 4 players'));
// The standard player-search hint (owner ruling): Profiles and Library
// wear the identical byte string, sourced from SuggestInput's
// kind="player" default — pinned here mounted, in library.dom.mjs A for
// the facet, and by source in player-search-hint.dom.mjs for the
// PlayerProfile finder (no harness mounts that view).
check(
  'the search box wears THE standard hint (Search players...)',
  root.querySelector('#pf-search')?.placeholder === 'Search players...',
  root.querySelector('#pf-search')?.placeholder,
);

console.log('B. first click on Player → A→Z (never Z→A); second click flips; the map re-apply');
click(headerBtn(root, 'Player'));
await sleep(20);
{
  const playerBtn = headerBtn(root, 'Player');
  check(
    'FIRST click on Player sorts A→Z',
    JSON.stringify(rowNames(root)) === JSON.stringify(['amy', 'bob', 'dan', 'zoe']),
    JSON.stringify(rowNames(root)),
  );
  check(
    'Player is now active with the ASC arrow',
    playerBtn.classList.contains('sorted') && arrow(playerBtn) === 'up',
    `sorted=${playerBtn.classList.contains('sorted')} arrow=${arrow(playerBtn)}`,
  );
}
click(headerBtn(root, 'Player'));
await sleep(20);
check(
  'second click flips to Z→A with the DESC arrow',
  JSON.stringify(rowNames(root)) === JSON.stringify(['zoe', 'dan', 'bob', 'amy']) &&
    arrow(headerBtn(root, 'Player')) === 'down',
  JSON.stringify(rowNames(root)) + ' arrow=' + arrow(headerBtn(root, 'Player')),
);
click(headerBtn(root, 'Matches'));
await sleep(20);
check(
  'hopping back to Matches re-applies the map default (DESC, arrow down)',
  JSON.stringify(rowNames(root)) === JSON.stringify(['zoe', 'bob', 'dan', 'amy']) &&
    arrow(headerBtn(root, 'Matches')) === 'down',
  JSON.stringify(rowNames(root)) + ' arrow=' + arrow(headerBtn(root, 'Matches')),
);

console.log('C. sort composes with the search filter (filter first, then sort)');
type(root.querySelector('#pf-search'), 'a');
await sleep(60);
check(
  'the filter narrows to amy + dan…',
  JSON.stringify(rowNames(root)) === JSON.stringify(['dan', 'amy']),
  JSON.stringify(rowNames(root)),
);
check(
  '…and the SURVIVORS are sorted (dan 3 > amy 1 — not the service order)',
  rowNames(root)[0] === 'dan',
  JSON.stringify(rowNames(root)),
);
check('count line follows the filter', root.querySelector('.pf-count').textContent.includes('2 of 4 players'));
type(root.querySelector('#pf-search'), '');
await sleep(60);
check(
  'clearing the query restores the default order over the full list',
  JSON.stringify(rowNames(root)) === JSON.stringify(['zoe', 'bob', 'dan', 'amy']),
  JSON.stringify(rowNames(root)),
);

console.log('D. the suggestion list keeps the SERVICE order (the sort never touches `players`)');
focus(root.querySelector('#pf-search'));
await sleep(40);
{
  const opts = [...root.querySelectorAll('#pf-search-list .sg-opt')].map((b) =>
    b.querySelector('strong').textContent.trim(),
  );
  check(
    'suggestions list the service order, unsorted',
    JSON.stringify(opts) === JSON.stringify(['amy', 'zoe', 'bob', 'dan']),
    JSON.stringify(opts),
  );
}

console.log('E. PlayerProfile: "Imported" history header + patch-first trend tooltips');
document.body.removeChild(root);
// The read-cache flush the sections below drive (services.invalidate —
// every cachedRead key) — declared HERE because E's series/catalog
// stubs must land before its mount.
const { invalidate } = await import(pathToFileURL('src/lib/services.js').href);
// The K/D/A halves read the match-grain SERIES now (the owner ruling of
// 2026-11-17 — the metrics system IS the gameplay-statistics layer), so
// the catalog and the series read must be in place BEFORE this mount:
// sections A–D already cached a null catalog answer, so flush first.
// The series values are deliberately NOT the raw ps.kills / ps.deaths
// columns behind the DTO (10/5 and 5/12): a cell that prints 17/4 is
// proof the seed row — not the stored column — is the source.
bindings.MetricsService.ListMetrics = () =>
  Promise.resolve([
    { id: 5, name: 'kills', title: 'Kills', scope: 'match', format: 'int',
      doc: 'Formula: sum(player_stats.kills)', origin: 'builtin' },
    { id: 6, name: 'deaths', title: 'Deaths', scope: 'match', format: 'int',
      doc: 'Formula: sum(player_stats.deaths)', origin: 'builtin' },
    { id: 7, name: 'assists', title: 'Assists', scope: 'match', format: 'int',
      doc: 'Formula: sum(player_stats.assists)', origin: 'builtin' },
    // The profile-scope DEFAULT pins' head (unification, 2026-11-18):
    // Matches and Win% are metric entries now (career_matches /
    // win_pct), so a default (absent-key) pins read resolves them
    // through the catalog exactly like every other card — G1/G2's
    // "profile content still renders" checks ride on this.
    { id: 82, name: 'career_matches', title: 'Matches played', scope: 'profile', format: 'int',
      doc: 'Formula: count(player_stats) over the library', origin: 'builtin' },
    { id: 83, name: 'win_pct', title: 'Win %', scope: 'profile', format: 'percent',
      doc: 'Formula: sum(player_stats.won) / count()', origin: 'builtin' },
  ]);
bindings.MetricsService.GetMetricSeries = () =>
  Promise.resolve([
    { metricId: 5, matchId: 1, value: 17, n: 24 },
    { metricId: 6, matchId: 1, value: 4, n: 24 },
    { metricId: 7, matchId: 1, value: 2, n: 24 },
    { metricId: 5, matchId: 2, value: 3, n: 22 },
    { metricId: 6, matchId: 2, value: 9, n: 22 },
  ]);
bindings.MetricsService.GetMetricComputeState = () =>
  Promise.resolve([
    { metricId: 5, state: 'fresh' },
    { metricId: 6, state: 'fresh' },
    { metricId: 7, state: 'fresh' },
  ]);
invalidate();
const pTarget = document.createElement('div');
document.body.appendChild(pTarget);
mount(profileMod.default, {
  target: pTarget,
  props: { steamId: '76561198000000001', nav: () => {} },
});
await sleep(100); // mount + getProfile + getCareerTrend + listPlayers
{
  const histTable = [...pTarget.querySelectorAll('table.data-table')].find((t) =>
    t.textContent.includes('KAST%'),
  );
  const head = [...histTable.querySelectorAll('thead th')].map((th) => th.textContent.trim());
  check(
    'match-history column header reads "Imported", never "Date"',
    head[0] === 'Imported' && !head.includes('Date'),
    JSON.stringify(head),
  );
  check(
    'the header tooltip names the import date + the no-played-time rule',
    /Import date/.test(histTable.querySelector('thead th').getAttribute('title') || '') &&
      /no played time/.test(histTable.querySelector('thead th').getAttribute('title') || ''),
    histTable.querySelector('thead th').getAttribute('title'),
  );
  check(
    'the history cell still renders a date (fmtDate of extractedAt)',
    /2026/.test(histTable.querySelector('tbody tr td').textContent),
    histTable.querySelector('tbody tr td').textContent,
  );
  {
    // The per-half triple after the seed conversion: K and D read the
    // match-grain SERIES rows (values 17/4 and 3/9 — the raw ps.kills /
    // ps.deaths columns behind the DTO are 10/5 and 5/12 and must never
    // print), the A half is the stored `assists` metric row — the first
    // history row has one, the second carries none and must render the
    // honest dash (never 0).
    const kda = [...histTable.querySelectorAll('tbody tr')].map(
      (tr) => tr.querySelectorAll('td')[5]?.textContent.trim(),
    );
    check(
      'the K/D/A cell renders the stored SERIES K/D with the metric-backed assists value (never the raw columns)',
      kda[0] === '17/4/2',
      JSON.stringify(kda),
    );
    check(
      'a match with no fresh assists row renders the honest dash, never a 0 (the series K/D still renders)',
      kda[1] === '3/9/—',
      JSON.stringify(kda),
    );
  }

  const dotTitles = [...pTarget.querySelectorAll('.prof-spark circle title')].map(
    (t) => t.textContent.trim(),
  );
  check('the sparkline rendered its dots', dotTitles.length === 2, JSON.stringify(dotTitles));
  check(
    'every trend tooltip leads with the patch (fmtPatch), then the honest "Imported" date',
    dotTitles.length === 2 &&
      dotTitles[0].startsWith('1.40.8.9 · Imported ') &&
      dotTitles[1].startsWith('1.41.1.3 · Imported '),
    JSON.stringify(dotTitles),
  );
  check(
    'the tooltip date is the trend point\'s own extractedAt (2025), not the history join (2026-03-03)',
    dotTitles.length === 2 && dotTitles[0].includes('2025'),
    JSON.stringify(dotTitles),
  );
  const caption = pTarget.querySelector('.prof-spark-cap')?.textContent || '';
  check(
    'the x-axis caption says patch order, with import order as the within-patch tiebreaker',
    caption.includes('x = sequence (patch order → import order within a patch)'),
    caption,
  );
}

console.log('F. Profiles: a failed list read gates the empty state and Retries in place');
document.body.removeChild(pTarget);
// Fail the read: the alert must stand INSTEAD of "No players yet" (the
// empty copy is gated on the error), and Retry must actually re-fetch.
// listPlayers is read-cached (services.js cachedRead) — flush first or
// sections A–E's successful read would answer in the stub's place.
bindings.ProfileService.ListPlayers = () => Promise.reject(new Error('players read failed'));
invalidate();
const fTarget = document.createElement('div');
document.body.appendChild(fTarget);
mount(profilesMod.default, { target: fTarget, props: { nav: () => {} } });
await sleep(100);
const fErr = () => fTarget.querySelector('p.error[role="alert"]');
check('error renders in p.error[role="alert"]', !!fErr(), 'no error line');
check(
  'error carries a Retry that re-invokes the list read',
  !!fErr() && [...fErr().querySelectorAll('button')].some((b) => b.textContent.trim() === 'Retry'),
  fErr()?.textContent,
);
check(
  '"No players yet" gated on the error (a failed read is UNKNOWN, not none)',
  !fTarget.textContent.includes('No players yet'),
  fTarget.textContent.replace(/\s+/g, ' ').slice(0, 160),
);
check('the view did not unmount (toolbar still there)', !!fTarget.querySelector('#pf-search'));
// Retry with the read restored: the message clears IN PLACE — same root,
// no remount — and the table renders.
bindings.ProfileService.ListPlayers = () => Promise.resolve(PLAYERS);
click([...fErr().querySelectorAll('button')].find((b) => b.textContent.trim() === 'Retry'));
await sleep(100);
check('error cleared in place', !fErr(), fErr()?.textContent);
check(
  'the table renders in the SAME root after Retry',
  JSON.stringify(rowNames(fTarget)) === JSON.stringify(['zoe', 'bob', 'dan', 'amy']),
  JSON.stringify(fTarget.querySelector('table.data-table') ? rowNames(fTarget) : []),
);
document.body.removeChild(fTarget);

console.log('G. PlayerProfile: profile + trend failures each carry a Retry that clears in place');
const goodGetProfile = bindings.ProfileService.GetProfile;
const goodGetTrend = bindings.ProfileService.GetCareerTrend;

// G1: the profile read fails — the alert stands INSTEAD of a stuck
// "Loading…" (that copy is gated on the error), and Retry re-fetches
// into the same root.
bindings.ProfileService.GetProfile = () => Promise.reject(new Error('profile read failed'));
invalidate(); // both reads are read-cached — flush so the failure lands
const g1 = document.createElement('div');
document.body.appendChild(g1);
mount(profileMod.default, { target: g1, props: { steamId: '76561198000000001', nav: () => {} } });
await sleep(100);
const g1Err = () => g1.querySelector('p.error[role="alert"]');
check('profile alert renders in p.error[role="alert"]', !!g1Err(), 'no error line');
check(
  'profile alert offers Retry that re-invokes getProfile',
  !!g1Err() && [...g1Err().querySelectorAll('button')].some((b) => b.textContent.trim() === 'Retry'),
  g1Err()?.textContent,
);
check(
  'no stuck "Loading…" behind the failure (gated on the error)',
  !g1.textContent.includes('Loading…'),
  g1.textContent.replace(/\s+/g, ' ').slice(0, 160),
);
check('no profile content behind the failure', !g1.querySelector('.stat-grid'));
bindings.ProfileService.GetProfile = goodGetProfile;
click([...g1Err().querySelectorAll('button')].find((b) => b.textContent.trim() === 'Retry'));
await sleep(100);
check('profile error cleared in place (same root, no remount)', !g1Err(), g1Err()?.textContent);
check('profile content rendered after Retry', !!g1.querySelector('.stat-grid'));
document.body.removeChild(g1);

// G2: the trend read fails while the profile is fine — the alert stands
// INSTEAD of the false "No trend data for this stat yet." claim, and
// Retry re-fetches into the same root.
bindings.ProfileService.GetCareerTrend = () => Promise.reject(new Error('trend read failed'));
invalidate();
const g2 = document.createElement('div');
document.body.appendChild(g2);
mount(profileMod.default, { target: g2, props: { steamId: '76561198000000001', nav: () => {} } });
await sleep(100);
const g2Err = () => g2.querySelector('p.error[role="alert"]');
check('trend alert renders in p.error[role="alert"]', !!g2Err(), 'no error line');
check(
  'trend alert offers Retry that re-invokes getCareerTrend',
  !!g2Err() && [...g2Err().querySelectorAll('button')].some((b) => b.textContent.trim() === 'Retry'),
  g2Err()?.textContent,
);
check(
  '"No trend data for this stat yet." gated on the error (a failed read is UNKNOWN)',
  !g2.textContent.includes('No trend data'),
  g2.textContent.replace(/\s+/g, ' ').slice(0, 200),
);
check('the failure is local to the trend — profile content still renders', !!g2.querySelector('.stat-grid'));
bindings.ProfileService.GetCareerTrend = goodGetTrend;
click([...g2Err().querySelectorAll('button')].find((b) => b.textContent.trim() === 'Retry'));
await sleep(100);
check('trend error cleared in place (same root, no remount)', !g2Err(), g2Err()?.textContent);
check(
  'trend sparkline rendered after Retry',
  g2.querySelectorAll('.prof-spark circle').length === 2,
  String(g2.querySelectorAll('.prof-spark circle').length),
);
document.body.removeChild(g2);

console.log('H. rung-3 loading lines render the canonical block spinner (never a number)');
{
  // The Profiles list read held open: the panel's loading line must be
  // the block spinner with its details text underneath (owner ruling —
  // a bare "Loading…" line converts to a centered spinner + details).
  const prevListPlayers = bindings.ProfileService.ListPlayers;
  bindings.ProfileService.ListPlayers = () => new Promise(() => {});
  invalidate();
  const hTarget = document.createElement('div');
  document.body.appendChild(hTarget);
  mount(profilesMod.default, { target: hTarget, props: { nav: () => {} } });
  await sleep(80);
  check(
    'Profiles mid-load: block spinner + "Loading players…" underneath',
    !!hTarget.querySelector('.chip-block .chip-spin') &&
      hTarget.querySelector('.chip-detail')?.textContent.trim() === 'Loading players…' &&
      !hTarget.querySelector('.chip-ring') &&
      !hTarget.querySelector('.chip-pct'),
    hTarget.querySelector('.chip-block')?.outerHTML.slice(0, 160) ?? 'missing',
  );
  document.body.removeChild(hTarget);
  bindings.ProfileService.ListPlayers = prevListPlayers;
  invalidate();

  // The PlayerProfile read held open: same shape, same honesty (no
  // ring, no percentage — there is no denominator to show).
  const prevGetProfile = bindings.ProfileService.GetProfile;
  bindings.ProfileService.GetProfile = () => new Promise(() => {});
  invalidate();
  const h2 = document.createElement('div');
  document.body.appendChild(h2);
  mount(profileMod.default, {
    target: h2,
    props: { steamId: '76561198000000001', nav: () => {} },
  });
  await sleep(80);
  // The profile panels mount with the player: while the read is held, they show
  // their own loading state (the busy frame state, a throbber on each panel), and
  // no percentage.
  check(
    'PlayerProfile mid-load: the panels are mounted and busy, never a %',
    h2.querySelectorAll('.builtin-busy').length > 0 &&
      !h2.querySelector('.chip-ring') &&
      !h2.querySelector('.chip-pct'),
    h2.innerHTML.slice(0, 160),
  );
  document.body.removeChild(h2);
  bindings.ProfileService.GetProfile = prevGetProfile;
  invalidate();
}

console.log('I. PlayerProfile headline block: profile pins read STORED career rows with state chips');
{
  // The profile-scope pin key (design §3's scope-routed pin — Builder's
  // single button writes it) plus the stored career rows and the state
  // read. Only amy's profile is mounted; only HER row may render even
  // though the read is the whole career bucket (other players' rows are
  // this unit's coverage, never displayed).
  //
  // w22 (2026-11-16) — DROP, NEVER MIGRATE, pinned FIRST (the reader is
  // read-only, so this is the pure read half of the contract): an OLD
  // id-array under the profile key reads through the SAME path as
  // current names — the numeric entry drops at read (an id can never be
  // a metric name), so the block selects NOTHING …
  bindings.MetricsService.ListMetrics = () =>
    Promise.resolve([
      {
        id: 51, name: 'career_kd', title: 'Career K/D', scope: 'profile',
        format: 'float1', doc: 'Formula: kills / deaths', origin: 'user',
      },
    ]);
  invalidate();
  const w22Target = document.createElement('div');
  document.body.appendChild(w22Target);
  // C5d (owner ruling 33): pinning is retired, so the panel must not read or
  // write any pin key. Spy on the Storage methods for the mount only; a
  // positive control proves the spy sees a pin-key access before the check
  // is trusted, and nothing is seeded, so the default set is what renders.
  const pinTouches = [];
  const storageProto = Object.getPrototypeOf(localStorage);
  const realGet = storageProto.getItem;
  const realSet = storageProto.setItem;
  const realRemove = storageProto.removeItem;
  const noteKey = (k) => {
    if (String(k).startsWith('spectra:pinned')) pinTouches.push(String(k));
  };
  storageProto.getItem = function (k) { noteKey(k); return realGet.call(this, k); };
  storageProto.setItem = function (k, v) { noteKey(k); return realSet.call(this, k, v); };
  storageProto.removeItem = function (k) { noteKey(k); return realRemove.call(this, k); };
  let w22Control;
  try {
    localStorage.getItem('spectra:pinned-control');
    w22Control = pinTouches.length;
    pinTouches.length = 0;
    mount(profileMod.default, {
      target: w22Target,
      props: { steamId: '76561198000000001', nav: () => {} },
    });
    await sleep(120);
  } finally {
    storageProto.getItem = realGet;
    storageProto.setItem = realSet;
    storageProto.removeItem = realRemove;
  }
  check(
    'w22: the spy sees a pin-key read (positive control)',
    w22Control === 1,
    `control=${w22Control}`,
  );
  const w22Grid = w22Target.querySelector('.stat-grid.prof-stats');
  const w22Cells = w22Grid ? [...w22Grid.querySelectorAll('.stat-cell')] : [];
  // …the block renders NO cards at all (the unification of 2026-11-18
  // took the fixed pair away: every card is a pinned metric tile, an
  // empty selection is an empty surface — never a guessed tile, never
  // a raw pair standing in) …
  // C5d (owner ruling 33): pinning is retired and the panel reads no pin
  // key, so the old bytes are ignored and the DEFAULT profile set shows. The
  // one default metric in this catalog is K/D.
  check(
    'w22: an old id-array under the retired pins key is ignored — the default card set renders',
    w22Cells.length === 1 && w22Cells[0].textContent.includes('K/D'),
    `cells=${JSON.stringify(w22Cells.map((c) => c.textContent.trim()))}`,
  );
  // …and the panel touches no retired pin key at all (no read, no write).
  check(
    'w22: the panel reads and writes no retired pin key',
    pinTouches.length === 0,
    pinTouches.join(' | '),
  );
  document.body.removeChild(w22Target);
  localStorage.removeItem('spectra:pinned-profile-metrics');
  // The section proper, re-pinned for the name-keyed format (w22 —
  // old '[51,52]' → the two fixture names, ids 51/52).
  localStorage.setItem('spectra:pinned-profile-metrics', '["career_kd","career_avg"]');
  bindings.MetricsService.ListMetrics = () =>
    Promise.resolve([
      {
        id: 51, name: 'career_kd', title: 'Career K/D', scope: 'profile',
        format: 'float1', doc: 'Formula: kills / deaths', origin: 'user',
      },
      {
        id: 52, name: 'career_adr', title: 'ADR', scope: 'profile',
        format: '', doc: 'Formula: avg dmg', origin: 'user',
      },
      {
        id: 53, name: 'match_only', title: 'Match only', scope: 'match',
        format: '', doc: 'Formula: x', origin: 'user',
      },
    ]);
  bindings.MetricsService.GetMetricValuesForPlayer = () =>
    Promise.resolve([
      { metricId: 51, subjectKey: '76561198000000001', value: 1.5, n: 40 },
      { metricId: 51, subjectKey: '76561198000000002', value: 2.5, n: 99 },
    ]);
  bindings.MetricsService.GetMetricComputeState = () =>
    Promise.resolve([
      { metricId: 51, state: 'fresh' },
      { metricId: 52, state: 'behind' },
      { metricId: 53, state: 'fresh' },
    ]);
  invalidate();
  const iTarget = document.createElement('div');
  document.body.appendChild(iTarget);
  mount(profileMod.default, {
    target: iTarget,
    props: { steamId: '76561198000000001', nav: () => {} },
  });
  await sleep(120);

  // The Career-metrics PANEL dissolved into the headline block (P1,
  // 2026-11-16): ONE `.stat-grid.prof-stats` container holds every card
  // as a pinned metric TILE (rendered through the canonical StatCard —
  // children[0] the label with its own doc tooltip, children[1] the
  // value slot running the state machine, the cell's own `title`
  // carrying n=/state). Since the unification of 2026-11-18 there is no
  // fixed pair ahead of them — Matches and Win% are tiles too — so the
  // pins ARE the cells.
  const grid = iTarget.querySelector('.stat-grid.prof-stats');
  check('the merged headline block renders the profile pins', !!grid, 'no .stat-grid.prof-stats');
  const rows = grid ? [...grid.querySelectorAll('.stat-cell')] : [];
  // The default profile set, in the default sequence (ADR before K/D): the two
  // defaults this catalog carries. The match-scope metric never surfaces here.
  check(
    'exactly the two default profile-scope cards (a match-scope metric never surfaces here)',
    rows.length === 2 && rows[0].textContent.includes('ADR') && rows[1].textContent.includes('K/D'),
    JSON.stringify(rows.map((r) => r.textContent.trim())),
  );
  {
    const tile = rows[1];
    const cell = tile?.children[1];
    check(
      'fresh renders the STORED value with its label as the tooltip (no sample size)',
      !!cell && cell.textContent.trim() === '1.5' && !cell.querySelector('.chip.status') &&
        (tile.getAttribute('title') || '') === 'Career K/D',
      cell ? `${cell.textContent.trim()} title=${tile.getAttribute('title')}` : 'no cell',
    );
  }
  {
    const tile = rows[0];
    const cell = tile?.children[1];
    const chip = cell?.querySelector('.chip.status');
    check(
      'behind renders the chip with the design copy, never a number',
      !!chip &&
        chip.classList.contains('idle') &&
        chip.textContent.trim() === 'behind' &&
        tile.getAttribute('title') === 'value not available yet — recompute pending' &&
        !/\d/.test(cell.textContent),
      cell ? `${chip ? chip.className : 'no chip'} "${cell.textContent.trim()}"` : 'no cell',
    );
  }
  check(
    "another player's bucket row never renders on this profile",
    !grid?.textContent.includes('2.5'),
    grid?.textContent.replace(/\s+/g, ' ').slice(0, 200),
  );
  {
    const leaks = [];
    const re = /version|\bv\d+\b|\d{4}-\d{2}-\d{2}|rule stamp|computed at/i;
    // `[title]` (was `td[title]`): the career tiles are card elements —
    // scanning every titled element in the block, not just table cells.
    for (const el of grid ? grid.querySelectorAll('.chip, [title]') : []) {
      const tip = el.getAttribute('title') || '';
      if (re.test(tip)) leaks.push(`title: ${tip}`);
      if (re.test(el.textContent || '')) leaks.push(`text: ${el.textContent.trim()}`);
    }
    check(
      'no version number or timestamp appears in the headline block\'s metric output',
      leaks.length === 0,
      leaks.join(' | '),
    );
  }

  localStorage.removeItem('spectra:pinned-profile-metrics');
  document.body.removeChild(iTarget);
}

console.log(
  'J. inferred W3a: the merged block — 2 fixed cards + the eleven default-pinned metric tiles, and the Profiles ADR column is metric-backed',
);
{
  // The profile-scope catalog in REVERSE default order (plus an
  // unpinned profile metric and a match-scope one): the rendered row
  // order must come from metricorder's DEFAULT sequence under the
  // ABSENT pins key — never from the catalog order, never from an id
  // list. Titles/short_name/format mirror the real builtin seeds.
  const CATALOG = [
    // The unified head pair (unification, 2026-11-18): the former
    // fixed cards as their metric entries — titles mirror the schema
    // seeds ('Matches played' / 'Win %'), and their negative DEFAULT
    // ranks lead the sequence exactly where the fixed pair led it.
    {
      id: 57, name: 'career_matches', title: 'Matches played', scope: 'profile',
      format: 'int', doc: 'Formula: count(player_stats) over the library', origin: 'builtin',
    },
    {
      id: 58, name: 'win_pct', title: 'Win %', scope: 'profile',
      format: 'percent', doc: 'Formula: sum(player_stats.won) / count()', origin: 'builtin',
    },
    {
      id: 69, name: 'career_avg_util_damage', title: 'Avg util damage', scope: 'profile',
      format: 'float1', doc: 'Formula: avg(player_stats.utility_damage)', origin: 'builtin',
    },
    {
      id: 68, name: 'career_avg_enemies_flashed', title: 'Avg enemies flashed', scope: 'profile',
      format: 'float1', doc: 'Formula: avg(player_stats.enemies_flashed)', origin: 'builtin',
    },
    {
      id: 67, name: 'career_clutch_win_rate', title: 'Clutch win %', scope: 'profile',
      format: 'percent', doc: 'Formula: avg(clutches.won)', origin: 'builtin',
    },
    // W3a: the two cards that became rows — the Clutches COUNT (rank 8)
    // and the Opening-duels rate (rank 6). Their stubs mirror the
    // schema-seeded titles; `profile.clutches`/`profile.openingRate` left
    // the Profile DTO with the cards.
    {
      id: 70, name: 'career_clutches', title: 'Clutches', scope: 'profile',
      format: 'int', doc: 'Formula: count(clutches) over the whole library', origin: 'builtin',
    },
    {
      id: 66, name: 'career_trade_rate', title: 'Trade rate', scope: 'profile',
      format: 'percent', doc: 'Formula: ratio(sum(trade_kills), sum(opps))', origin: 'builtin',
    },
    {
      id: 71, name: 'career_opening_rate', title: 'Opening kill tags', scope: 'profile',
      format: 'percent', doc: 'Formula: ratio(sum(entry_kills), sum(entry_kills + entry_deaths))', origin: 'builtin',
    },
    {
      id: 65, name: 'career_kast', title: 'KAST%', scope: 'profile',
      format: 'percent', doc: 'Formula: avg(player_round_stats.kast)', origin: 'builtin',
    },
    {
      id: 64, name: 'career_hs_pct', title: 'HS%', scope: 'profile',
      format: 'percent', doc: 'Formula: ratio(sum(headshots), sum(kills))', origin: 'builtin',
    },
    {
      id: 63, name: 'career_kd', title: 'K/D', scope: 'profile',
      format: 'float2', doc: 'Formula: ratio(sum(kills), sum(deaths))', origin: 'builtin',
    },
    {
      id: 62, name: 'career_adr_sigma', title: 'ADR σ', scope: 'profile',
      format: 'float1', doc: 'Formula: stddev(player_stats.adr)', origin: 'builtin',
    },
    {
      id: 61, name: 'career_adr', title: 'ADR', scope: 'profile',
      format: 'float1', doc: 'Formula: avg(player_stats.adr)', origin: 'builtin',
    },
    // NOT in DEFAULT_PINS → an absent pins key must never render it.
    {
      id: 60, name: 'career_bonus', title: 'Career bonus', scope: 'profile',
      format: 'float1', doc: 'Formula: avg(player_stats.score)', origin: 'user',
    },
    // Wrong scope → never on the profile surface.
    {
      id: 59, name: 'adr', title: 'ADR', scope: 'match',
      format: 'float1', doc: 'Formula: ratio(sum(total_damage), sum(rounds_played))', origin: 'builtin',
    },
  ];
  const ELEVEN = [69, 68, 67, 70, 66, 71, 65, 64, 63, 62, 61]; // CATALOG order
  const HEAD = [57, 58]; // the unified head pair (career_matches / win_pct)
  // amy's career rows for all eleven (the profile under test), plus bob's
  // and zoe's `career_adr` for the Profiles list column — dan gets NO
  // row, which is the honest gap that must render '—'. The head pair's
  // rows are deliberately NOT the raw profile fields behind the DTO
  // (matches 2 / winPct 80): the seed row is THE source.
  const ROWS = [
    { metricId: 57, subjectKey: '76561198000000001', value: 7, n: 42 },
    { metricId: 58, subjectKey: '76561198000000001', value: 0.6, n: 42 },
    { metricId: 61, subjectKey: '76561198000000001', value: 63.5, n: 42 },
    { metricId: 61, subjectKey: '76561198000000002', value: 55, n: 7 },
    { metricId: 61, subjectKey: '76561198000000003', value: 40, n: 9 },
    { metricId: 62, subjectKey: '76561198000000001', value: 12.5, n: 42 },
    { metricId: 63, subjectKey: '76561198000000001', value: 1.42, n: 42 },
    { metricId: 64, subjectKey: '76561198000000001', value: 0.41, n: 42 },
    { metricId: 65, subjectKey: '76561198000000001', value: 0.7, n: 42 },
    { metricId: 66, subjectKey: '76561198000000001', value: 0.666, n: 42 },
    { metricId: 71, subjectKey: '76561198000000001', value: 0.5, n: 42 },
    { metricId: 67, subjectKey: '76561198000000001', value: 0.5, n: 42 },
    { metricId: 70, subjectKey: '76561198000000001', value: 1, n: 42 },
    { metricId: 68, subjectKey: '76561198000000001', value: 3.2, n: 42 },
    { metricId: 69, subjectKey: '76561198000000001', value: 88.9, n: 42 },
  ];
  bindings.MetricsService.ListMetrics = () => Promise.resolve(CATALOG);
  // Deliberately WIDER than asked: the real read narrows server-side,
  // but a stub that honours the id filter would hide a view that forgot
  // to key its rows by metric. Both views must filter to their own
  // metric before rendering.
  bindings.MetricsService.GetMetricValuesForPlayer = () => Promise.resolve(ROWS);
  bindings.MetricsService.GetMetricComputeState = () =>
    Promise.resolve([...HEAD, ...ELEVEN].map((id) => ({ metricId: id, state: 'fresh' })));

  // --- J1: the profile surface = 2 fixed cards + 11 default-pinned tiles
  invalidate(); // flush section I's stubs (same read-cache keys)
  const j1 = document.createElement('div');
  document.body.appendChild(j1);
  mount(profileMod.default, {
    target: j1,
    props: { steamId: '76561198000000001', nav: () => {} },
  });
  await sleep(140); // mount + getProfile + listMetrics + the career read

  // P1 (2026-11-16), N4 (2026-11-16), unification (2026-11-18): every
  // card is a pinned metric tile in ONE `.stat-grid.prof-stats` block
  // over THE composed sequence (metricorder.composedSequence) — under
  // the DEFAULT prefs the two unified head cards LEAD (their negative
  // ranks held the fixed pair's slots), then the eleven
  // metricorder-composed tiles.
  const grid = j1.querySelector('.stat-grid.prof-stats');
  const cardLabels = grid
    ? [...grid.querySelectorAll('.stat-cell .field-label')].map((e) => e.textContent.trim())
    : [];
  const headLabels = cardLabels.slice(0, 2);
  check(
    'the composed sequence leads with the unified head pair (Matches played, Win % first — the pinned metric tiles follow it)',
    JSON.stringify(headLabels) === JSON.stringify(['Matches played', 'Win %']) &&
      cardLabels.length === 2 + 11,
    JSON.stringify(cardLabels),
  );
  {
    // The head pair reads its SEED rows, never the raw profile fields
    // behind the DTO (matches 2 / winPct 80): a tile printing 7 or 60%
    // is proof the seed row is the source (unification, 2026-11-18).
    const headCells = grid
      ? [...grid.querySelectorAll('.stat-cell')].slice(0, 2).map((c) => c.children[1]?.textContent.trim())
      : [];
    check(
      'the unified head pair renders the STORED seed values (7 / 60%), never the raw profile fields',
      headCells[0] === '7' && headCells[1] === '60%',
      JSON.stringify(headCells),
    );
  }
  {
    // W3a's swap: the Opening duels and Clutches cards left the FIXED
    // block — their numbers live as metric tiles (checked below), so no
    // stat may render twice (head card AND metric tile).
    for (const gone of [
      'ADR ± σ', 'Trade rate', 'Avg enemies flashed', 'Avg util damage',
      'Opening kill tags', 'Clutches',
    ]) {
      check(
        `the converted card "${gone}" never renders twice (head card AND metric tile)`,
        !headLabels.includes(gone) && cardLabels.filter((l) => l === gone).length <= 1,
        JSON.stringify(cardLabels),
      );
    }
  }

  const j1Rows = grid ? [...grid.querySelectorAll('.stat-cell')].slice(2) : [];
  const j1Titles = j1Rows.map(
    (r) => r.children[0]?.textContent.trim(),
  );
  check(
    'the metric tiles render the eleven default pins in DEFAULT order (catalog order is reversed above)',
    JSON.stringify(j1Titles) ===
      JSON.stringify([
        'ADR', 'ADR σ', 'K/D', 'HS%', 'KAST%', 'Opening kill tags', 'Trade rate',
        'Clutches', 'Clutch win %', 'Avg enemies flashed', 'Avg util damage',
      ]),
    JSON.stringify(j1Titles),
  );
  check(
    'the two converted cards render their numbers as tiles (the count and the rate)',
    j1Rows[5]?.children[1]?.textContent.trim() === '50%' &&
      j1Rows[7]?.children[1]?.textContent.trim() === '1',
    JSON.stringify(j1Titles.map((t, i) => [t, j1Rows[i]?.children[1]?.textContent.trim()])),
  );
  check(
    'the unpinned profile metric and the match-scope metric never render',
    !grid?.textContent.includes('Career bonus'),
    grid?.textContent.replace(/\s+/g, ' ').slice(0, 240) ?? 'no block',
  );
  {
    const tile = j1Rows[0];
    const cell = tile?.children[1];
    check(
      'the ADR tile renders amy\'s STORED value with its label as the tooltip (no sample size)',
      !!cell && cell.textContent.trim() === '63.5' &&
        (tile.getAttribute('title') || '') === 'ADR',
      cell ? `${cell.textContent.trim()} title=${tile.getAttribute('title')}` : 'no cell',
    );
    check(
      "another player's bucket row never renders on this profile",
      !grid?.textContent.includes('55.0') && !grid?.textContent.includes('40.0'),
      grid?.textContent.replace(/\s+/g, ' ').slice(0, 240) ?? 'no block',
    );
  }
  document.body.removeChild(j1);

  // --- J2: the Profiles ADR column reads the career bucket row --------
  const j2 = document.createElement('div');
  document.body.appendChild(j2);
  mount(profilesMod.default, { target: j2, props: { nav: () => {} } });
  await sleep(120); // mount + listPlayers + the metric read

  const j2Cells = () => {
    const rows = [...j2.querySelectorAll('table.data-table tbody tr')];
    return new Map(
      rows.map((tr) => [
        tr.querySelector('.pf-name')?.textContent.trim(),
        tr.children[2]?.textContent.trim() ?? '',
      ]),
    );
  };
  {
    const cells = j2Cells();
    check(
      'the ADR cell renders the STORED metric value, never ListPlayers\' adrAvg',
      cells.get('amy') === '63.5' && cells.get('zoe') === '55.0' && cells.get('bob') === '40.0',
      JSON.stringify([...cells]),
    );
    check(
      'a player with no fresh row renders the honest dash (never a fabricated 0)',
      cells.get('dan') === '—',
      JSON.stringify([...cells]),
    );
    check(
      'a fresh cell never wears a state chip',
      ![...j2.querySelectorAll('table.data-table tbody tr')].some((tr) =>
        tr.children[2]?.querySelector('.chip.status'),
      ),
      'a chip appeared beside a fresh value',
    );
  }
  // ADR sorts on the METRIC value, gaps last in both directions.
  click(headerBtn(j2, 'ADR'));
  await sleep(40);
  check(
    'first click on ADR sorts the stored values DESC with the gap last',
    JSON.stringify(rowNames(j2)) === JSON.stringify(['amy', 'zoe', 'bob', 'dan']),
    JSON.stringify(rowNames(j2)),
  );
  click(headerBtn(j2, 'ADR'));
  await sleep(40);
  check(
    'second click sorts ASC and the gap STILL sorts last (a gap is not a zero)',
    JSON.stringify(rowNames(j2)) === JSON.stringify(['bob', 'zoe', 'amy', 'dan']),
    JSON.stringify(rowNames(j2)),
  );
  document.body.removeChild(j2);

  // --- J3: a BEHIND metric renders the state chip, never a number -----
  bindings.MetricsService.GetMetricValuesForPlayer = () => Promise.resolve([]);
  // No rows at all → behind wins over the absent row (design §5).
  bindings.MetricsService.GetMetricComputeState = () =>
    Promise.resolve([{ metricId: 61, state: 'behind' }]);
  invalidate();
  const j3 = document.createElement('div');
  document.body.appendChild(j3);
  mount(profilesMod.default, { target: j3, props: { nav: () => {} } });
  await sleep(120);
  {
    const cells = [...j3.querySelectorAll('table.data-table tbody tr')].map(
      (tr) => tr.children[2],
    );
    const chips = cells.map((c) => c?.querySelector('.chip.status'));
    check(
      'a BEHIND career_adr renders the state chip in every ADR cell, never a number',
      cells.length === 4 &&
        chips.every((c) => c && c.textContent.trim() === 'behind') &&
        cells.every((c) => !/\d/.test(c.textContent)),
      JSON.stringify(cells.map((c) => c?.textContent.trim())),
    );
  }
  document.body.removeChild(j3);

  // --- J4 (N4): the fixed cards are SEQUENCE entries — orderable AND hideable
  // J1 above pins the default composition (fixed leads). These two
  // mounts prove the prefs actually WIRE THROUGH: a stored order with
  // Win% first reorders the fixed pair, and a stored hidden set removes
  // the named fixed card from the VIEW (it stays listed in the ordering
  // dialog — visibility is view-display only, never this surface's
  // business). The metric reads go back to the full rows first, so the
  // composition is the only thing these mounts change.
  bindings.MetricsService.GetMetricValuesForPlayer = () => Promise.resolve(ROWS);
  bindings.MetricsService.GetMetricComputeState = () =>
    Promise.resolve([...HEAD, ...ELEVEN].map((id) => ({ metricId: id, state: 'fresh' })));
  // A WHOLE stored sequence (the writer persists every entry on the
  // first move — a partial pref would re-insert the missing entries at
  // their default ranks). Post-unification shape: the unified head pair
  // as metric names (win_pct deliberately BEFORE career_matches — the
  // stored position wins over the default ranks), the eleven after it.
  const FULL_PROFILE_ORDER = [
    'win_pct', 'career_matches', 'career_trade_rate', 'career_adr', 'career_adr_sigma',
    'career_kd', 'career_hs_pct', 'career_kast', 'career_opening_rate',
    'career_clutches', 'career_clutch_win_rate', 'career_avg_enemies_flashed',
    'career_avg_util_damage',
  ];
  const mountProfile = async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    mount(profileMod.default, {
      target: el,
      props: { steamId: '76561198000000001', nav: () => {} },
    });
    await sleep(140); // mount + getProfile + listMetrics + the career read
    const g = el.querySelector('.stat-grid.prof-stats');
    const labels = g
      ? [...g.querySelectorAll('.stat-cell .field-label')].map((e) => e.textContent.trim())
      : [];
    return { el, labels };
  };

  bindings.handlers.GetPref = (key) =>
    key === 'metric_order_profile' ? FULL_PROFILE_ORDER : undefined;
  invalidate();
  const j4 = await mountProfile();
  // C5d (owner ruling 33): the order pref is retired and no panel reads it,
  // so the stored order is ignored — the default sequence leads.
  check(
    'N4 (C5d): a stored order pref is ignored — the default sequence leads (Matches played, Win %), thirteen cards',
    j4.labels[0] === 'Matches played' && j4.labels[1] === 'Win %' && j4.labels.length === 13,
    JSON.stringify(j4.labels),
  );
  document.body.removeChild(j4.el);

  // Since the unification the profile scope has NO fixed entries, so a
  // stale stored hidden key marks nothing (its rows are pin-driven now)
  // — the same by-construction drop stale '@K'-style keys get on the
  // match scope. All thirteen cards render.
  bindings.handlers.GetPref = (key) =>
    key === 'metric_hidden_profile' ? ['@Matches'] : undefined;
  invalidate();
  const j5 = await mountProfile();
  check(
    'N4: a stale profile hidden key marks nothing — every card is pin-driven now (13 tiles, head pair intact)',
    !j5.labels.includes('undefined') &&
      j5.labels[0] === 'Matches played' &&
      j5.labels.length === 13 &&
      JSON.stringify(j5.labels.slice(2, 5)) === JSON.stringify(['ADR', 'ADR σ', 'K/D']),
    JSON.stringify(j5.labels),
  );
  document.body.removeChild(j5.el);
  delete bindings.handlers.GetPref;
  invalidate();
}

console.log('K. PlayerProfile trend: the picker offers ANY match-scope metric and reads it by NAME');
{
  // A match-scope catalog in a deliberate non-default order, plus a
  // profile-scope metric the trend card must never offer (the series
  // read is match-grain — match_id > 0 only).
  bindings.MetricsService.ListMetrics = () =>
    Promise.resolve([
      {
        id: 81, name: 'kast', title: 'KAST%', scope: 'match', format: 'percent',
        doc: 'Formula: avg(player_round_stats.kast)', origin: 'builtin',
      },
      {
        id: 82, name: 'hs_pct', title: 'HS%', scope: 'match', format: 'percent',
        doc: 'Formula: ratio(sum(headshots), sum(kills))', origin: 'builtin',
      },
      {
        id: 83, name: 'adr', title: 'ADR', scope: 'match', format: 'float1',
        doc: 'Formula: ratio(sum(total_damage), sum(rounds_played))', origin: 'builtin',
      },
      {
        id: 84, name: 'career_kd', title: 'Career K/D', scope: 'profile', format: 'float2',
        doc: 'Formula: ratio(sum(kills), sum(deaths))', origin: 'builtin',
      },
    ]);
  invalidate(); // the trend + catalog reads are read-cached — flush before mounting
  const k = document.createElement('div');
  document.body.appendChild(k);
  mount(profileMod.default, { target: k, props: { steamId: '76561198000000001', nav: () => {} } });
  await sleep(160); // mount + getProfile + listMetrics + getCareerTrend

  const input = k.querySelector('#prof-trend');
  check('the trend card offers a metric picker', !!input, 'no #prof-trend input');
  check(
    'the picker wears THE verb hint (Search metrics…) and its aria label',
    input?.placeholder === 'Search metrics…' && input?.getAttribute('aria-label') === 'Trend metric',
    `${input?.placeholder} / ${input?.getAttribute('aria-label')}`,
  );
  check(
    'the mount read went out with the default metric NAME',
    trendCalls.some(([sid, m]) => sid === '76561198000000001' && m === 'adr'),
    JSON.stringify(trendCalls),
  );

  // An empty field lists the WHOLE sequence (a non-empty value filters
  // the suggestions down to the substring matches).
  type(input, '');
  await sleep(40);
  {
    const opts = [...k.querySelectorAll('#prof-trend-list .sg-opt')].map((b) =>
      b.textContent.trim(),
    );
    check(
      'suggestions list the match-scope metrics in metricorder sequence (absent pref ⇒ default)',
      JSON.stringify(opts) === JSON.stringify(['ADR', 'KAST%', 'HS%']),
      JSON.stringify(opts),
    );
    check(
      'a profile-scope metric is never offered on the trend card',
      !k.querySelector('#prof-trend-list')?.textContent.includes('Career K/D'),
      k.querySelector('#prof-trend-list')?.textContent ?? 'no list',
    );
  }
  {
    const hs = [...k.querySelectorAll('#prof-trend-list .sg-opt')].find(
      (b) => b.textContent.trim() === 'HS%',
    );
    if (hs) click(hs);
    await sleep(80);
    check(
      'picking a metric puts its TITLE in the field',
      k.querySelector('#prof-trend')?.value === 'HS%',
      k.querySelector('#prof-trend')?.value,
    );
    check(
      'the series read goes out with the metric NAME (hs_pct — never the title, never a button key)',
      trendCalls.some(([, m]) => m === 'hs_pct'),
      JSON.stringify(trendCalls),
    );
    check(
      'the sparkline names the picked metric, not a raw name key',
      (k.querySelector('.prof-spark')?.getAttribute('aria-label') || '').startsWith(
        'HS% trend across',
      ),
      k.querySelector('.prof-spark')?.getAttribute('aria-label') ?? 'no sparkline',
    );
  }
  document.body.removeChild(k);
}

// ---------------------------------------------------------------------------
// Section L: the Matches card's VALUE is the `career_matches`
// seed row (owner ruling, 2026-11-17 — the count seeds' profile twin;
// the card itself became a metric tile in the unification of
// 2026-11-18): fresh → the stored count with the seed's Formula/n
// tooltip, no row → the honest state — NEVER profile.matches behind it
// (the fixture's profile carries matches: 2, so a raw fallback prints 2
// where the seed says 7). The card's sub line keeps the raw wins count
// (R4 of the unification wave: wins has no seed — a residual for the
// docs sync), and the Win% card is the `win_pct` SEED tile now (the
// old "no winPct seed" note here was overtaken by the count addendum).
console.log('L. the Matches card reads the career_matches seed row (never profile.matches)');
{
  // The card is a pinned metric tile now (unification 2026-11-18): the
  // absent pins key resolves DEFAULT_PINS through THIS catalog, which
  // carries career_matches (and no win_pct — the resolved selection
  // drops the unresolvable name, the design §1.6 rule). The stale
  // "Win% has no seed" note this section used to carry is gone: the
  // count addendum seeded win_pct the NEXT day (schema.sql).
  localStorage.removeItem('spectra:pinned-profile-metrics');
  bindings.MetricsService.ListMetrics = () =>
    Promise.resolve([
      {
        id: 81, name: 'career_matches', title: 'Matches played', scope: 'profile',
        format: 'int', doc: 'Formula: count(player_stats) over the library', origin: 'builtin',
      },
    ]);
  bindings.MetricsService.GetMetricValuesForPlayer = () =>
    Promise.resolve([{ metricId: 81, subjectKey: '76561198000000001', value: 7, n: 7 }]);
  bindings.MetricsService.GetMetricComputeState = () =>
    Promise.resolve([{ metricId: 81, state: 'fresh' }]);
  invalidate();
  const mountProfile = async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    mount(profileMod.default, {
      target,
      props: { steamId: '76561198000000001', nav: () => {} },
    });
    await sleep(140); // mount + getProfile + listMetrics + the career read
    return target;
  };
  const cardOf = (target) =>
    [...target.querySelectorAll('.stat-grid.prof-stats .stat-cell')].find(
      (c) =>
        // Since the unification the card IS the metric tile: its label
        // is the seed's own title ('Matches played', schema — the
        // former FIXED_BLOCK label 'Matches' retired with the entry).
        c.querySelector('.field-label')?.textContent.trim() === 'Matches played',
    );

  const fresh = await mountProfile();
  const freshCard = cardOf(fresh);
  const freshValue = freshCard?.querySelector('.stat-value');
  check(
    'the Matches card renders the STORED career_matches value (7) — profile.matches (2) never prints',
    !!freshValue && freshValue.textContent.trim() === '7',
    freshValue ? freshValue.textContent.trim() : 'no Matches card',
  );
  check(
    'the card carries the seed Formula on its label and its metric label on the cell',
    (freshCard?.querySelector('.field-label')?.getAttribute('title') || '').startsWith(
      'Formula: count(player_stats)',
    ) &&
      (freshCard?.getAttribute('title') || '') === 'Matches played',
    `label=${freshCard?.querySelector('.field-label')?.getAttribute('title')} cell=${freshCard?.getAttribute('title')}`,
  );
  document.body.removeChild(fresh);

  // No fresh row for the subject → the state, never the raw number.
  bindings.MetricsService.GetMetricValuesForPlayer = () => Promise.resolve([]);
  bindings.MetricsService.GetMetricComputeState = () =>
    Promise.resolve([{ metricId: 81, state: 'behind' }]);
  invalidate();
  const behind = await mountProfile();
  const behindCard = cardOf(behind);
  const behindChip = behindCard?.querySelector('.stat-value .chip.status');
  check(
    'NO raw fallback: without a seed row the card shows the behind chip — never profile.matches (2)',
    !!behindChip &&
      behindChip.classList.contains('idle') &&
      behindChip.textContent.trim() === 'behind' &&
      !behindCard?.querySelector('.stat-value')?.textContent.includes('2'),
    behindCard ? behindCard.querySelector('.stat-value')?.textContent.trim() : 'no Matches card',
  );
  document.body.removeChild(behind);
  localStorage.removeItem('spectra:pinned-profile-metrics');
}

// ---------------------------------------------------------------------------
// Section M: the two statlines w36 left on raw columns — the list's
// Matches column (owner ruling, 2026-11-17: the metrics system IS the
// gameplay-statistics layer) and the history table's K/D halves. Both
// read their SEED rows through a canonical read (the batched career
// bucket read / the match-grain series read): the raw counts behind
// them (the list read's `matches`, ps.kills / ps.deaths) are the
// characterization these pins prove gone.
console.log('M. the Profiles Matches column and the history K/D halves read their seed rows');
{
  const CATALOG = [
    { id: 61, name: 'career_adr', title: 'ADR', scope: 'profile', format: 'float1',
      doc: 'Formula: avg(player_stats.adr)', origin: 'builtin' },
    { id: 81, name: 'career_matches', title: 'Matches played', scope: 'profile', format: 'int',
      doc: 'Formula: count(player_stats) over the library', origin: 'builtin' },
    { id: 5, name: 'kills', title: 'Kills', scope: 'match', format: 'int',
      doc: 'Formula: sum(player_stats.kills)', origin: 'builtin' },
    { id: 6, name: 'deaths', title: 'Deaths', scope: 'match', format: 'int',
      doc: 'Formula: sum(player_stats.deaths)', origin: 'builtin' },
    { id: 7, name: 'assists', title: 'Assists', scope: 'match', format: 'int',
      doc: 'Formula: sum(player_stats.assists)', origin: 'builtin' },
  ];
  // amy's seed counts DIFFER from the list read's own `matches` field
  // (amy: seed 7 vs list 1) so a raw fallback prints the wrong number;
  // dan gets NO row — the honest gap (never a fabricated 0).
  const CAREER_ROWS = [
    { metricId: 61, subjectKey: '76561198000000001', value: 63.5, n: 42 },
    { metricId: 81, subjectKey: '76561198000000001', value: 7, n: 7 },
    { metricId: 81, subjectKey: '76561198000000002', value: 5, n: 5 },
    { metricId: 81, subjectKey: '76561198000000003', value: 5, n: 5 },
  ];
  bindings.ProfileService.ListPlayers = () => Promise.resolve(PLAYERS);
  bindings.MetricsService.ListMetrics = () => Promise.resolve(CATALOG);
  let bucketReads = 0; // calls with the WHOLE career bucket (steam "")
  let perPlayerReads = 0; // calls narrowed to ONE player — an N+1 storm
  bindings.MetricsService.GetMetricValuesForPlayer = (steam, ids) => {
    if (steam) perPlayerReads++;
    else if ((ids || []).includes(81)) bucketReads++;
    return Promise.resolve(CAREER_ROWS);
  };
  bindings.MetricsService.GetMetricComputeState = () =>
    Promise.resolve([
      { metricId: 61, state: 'fresh' },
      { metricId: 81, state: 'fresh' },
      { metricId: 5, state: 'fresh' },
      { metricId: 6, state: 'fresh' },
      { metricId: 7, state: 'fresh' },
    ]);
  let seriesReads = [];
  bindings.MetricsService.GetMetricSeries = (steam, ids) => {
    seriesReads.push([steam, ids]);
    return Promise.resolve([
      { metricId: 5, matchId: 1, value: 17, n: 24 },
      { metricId: 6, matchId: 1, value: 4, n: 24 },
    ]);
  };
  invalidate(); // flush sections A–L's stubs (same read-cache keys)

  const cellOf = (target, name, idx) => {
    const row = [...target.querySelectorAll('table.data-table tbody tr')].find(
      (tr) => tr.querySelector('.pf-name')?.textContent.trim() === name,
    );
    return row ? row.children[idx] : null;
  };

  // --- M1: the list's Matches column -----------------------------------
  const m1 = document.createElement('div');
  document.body.appendChild(m1);
  mount(profilesMod.default, { target: m1, props: { nav: () => {} } });
  await sleep(160); // mount + listPlayers + the catalog + the ONE career read
  {
    const matches = cellOf(m1, 'amy', 1);
    check(
      'the Matches cell renders the STORED career_matches row (7) — the list read\'s own count (1) never prints',
      !!matches && matches.textContent.trim() === '7',
      matches ? matches.textContent.trim() : 'no Matches cell',
    );
    check(
      'the fresh cell carries the SEED Formula as its tooltip',
      (matches?.getAttribute('title') || '').startsWith('Formula: count(player_stats)'),
      matches?.getAttribute('title') ?? '',
    );
    const dan = cellOf(m1, 'dan', 1);
    check(
      'a player with no fresh row renders the honest dash (never a fabricated 0, never the raw count)',
      !!dan && dan.textContent.trim() === '—',
      dan ? dan.textContent.trim() : 'no cell',
    );
    check(
      'ONE batched bucket read serves the whole list — never a per-player call',
      bucketReads === 1 && perPlayerReads === 0,
      `bucket=${bucketReads} perPlayer=${perPlayerReads}`,
    );
    check(
      'the ADR column keeps reading its own seed out of the same read',
      cellOf(m1, 'amy', 2)?.textContent.trim() === '63.5',
      cellOf(m1, 'amy', 2)?.textContent.trim(),
    );
  }
  // A BEHIND career_matches: the state WORD in the cell, never a number
  // (the list read's raw count stays behind it, unrendered).
  bindings.MetricsService.GetMetricValuesForPlayer = () => Promise.resolve([]);
  bindings.MetricsService.GetMetricComputeState = () =>
    Promise.resolve([{ metricId: 61, state: 'fresh' }, { metricId: 81, state: 'behind' }]);
  invalidate();
  const m1b = document.createElement('div');
  document.body.appendChild(m1b);
  mount(profilesMod.default, { target: m1b, props: { nav: () => {} } });
  await sleep(160);
  {
    const cells = [...m1b.querySelectorAll('table.data-table tbody tr')].map(
      (tr) => tr.children[1],
    );
    const chips = cells.map((c) => c?.querySelector('.chip.status'));
    check(
      'a BEHIND career_matches renders the state word in every Matches cell, never a number',
      cells.length === 4 &&
        chips.every((c) => c && c.textContent.trim() === 'behind') &&
        cells.every((c) => !/\d/.test(c.textContent)),
      JSON.stringify(cells.map((c) => c?.textContent.trim())),
    );
  }
  document.body.removeChild(m1b);
  document.body.removeChild(m1);

  // --- M2: the history table's K/D halves read the SERIES read ---------
  bindings.MetricsService.GetMetricValuesForPlayer = () => Promise.resolve(CAREER_ROWS);
  bindings.MetricsService.GetMetricComputeState = () =>
    Promise.resolve([
      { metricId: 81, state: 'fresh' },
      { metricId: 5, state: 'fresh' },
      { metricId: 6, state: 'fresh' },
      { metricId: 7, state: 'fresh' },
    ]);
  seriesReads = [];
  matchValueReads.length = 0;
  invalidate();
  const m2 = document.createElement('div');
  document.body.appendChild(m2);
  mount(profileMod.default, {
    target: m2,
    props: { steamId: '76561198000000001', nav: () => {} },
  });
  await sleep(180); // mount + getProfile + catalog + the ONE series read
  const histCells = () => {
    const table = [...m2.querySelectorAll('table.data-table')].find((t) =>
      t.textContent.includes('KAST%'),
    );
    return table ? [...table.querySelectorAll('tbody tr')].map((tr) => tr.children[5]) : [];
  };
  {
    const cells = histCells();
    // S13: the history's stored cells are ONE batched series read for all its
    // matches (metricsByMatch), asking for the kills, deaths and assists seeds.
    check(
      'the history reads the seed ids for all its matches in one batched series read (kills, deaths, assists)',
      seriesReads.some(([, ids]) => [5, 6, 7].every((x) => ids.includes(x))),
      JSON.stringify(seriesReads),
    );
    check(
      'the history K/D halves render the stored values (raw ps.kills/ps.deaths 10/5 never prints); no assists row is a dash',
      cells[0]?.textContent.trim() === '17/4/—',
      cells[0]?.textContent.trim(),
    );
    check(
      'a match with no fresh series row renders the honest dash for both halves (raw 5/12 never prints)',
      cells[1]?.textContent.trim() === '—/—/—',
      cells[1]?.textContent.trim(),
    );
    check(
      'a dash half carries the no-data copy in the title (the state lives in the tooltip, never a chip in a compound cell)',
      cells[1]?.getAttribute('title') === 'no data for this player',
      cells[1]?.getAttribute('title') ?? '',
    );
  }
  document.body.removeChild(m2);

  // A BEHIND K/D seed: the state word reaches the cell through the
  // title — the raw columns behind the DTO never surface.
  seriesReads = [];
  // Only the assists row is stored; kills and deaths are behind.
  bindings.MetricsService.GetMetricSeries = () => Promise.resolve([{ metricId: 7, matchId: 1, value: 2, n: 24 }]);
  bindings.MetricsService.GetMetricComputeState = () =>
    Promise.resolve([
      { metricId: 81, state: 'fresh' },
      { metricId: 5, state: 'behind' },
      { metricId: 6, state: 'behind' },
      { metricId: 7, state: 'fresh' },
    ]);
  invalidate();
  const m3 = document.createElement('div');
  document.body.appendChild(m3);
  mount(profileMod.default, {
    target: m3,
    props: { steamId: '76561198000000001', nav: () => {} },
  });
  await sleep(180);
  {
    const cells = [...m3.querySelectorAll('table.data-table')]
      .find((t) => t.textContent.includes('KAST%'))
      ?.querySelectorAll('tbody tr');
    const first = cells ? cells[0]?.children[5] : null;
    check(
      'a BEHIND K/D seed renders the state word in the title and a dash — never the raw 10/5',
      !!first &&
        first.textContent.trim() === '—/—/2' &&
        first.getAttribute('title') === 'value not available yet — recompute pending',
      first ? `${first.textContent.trim()} title=${first.getAttribute('title')}` : 'no cell',
    );
  }
  document.body.removeChild(m3);
}

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
// ---------------------------------------------------------------------------
// Section N: the split tables' FIVE-STATE cells (ME6 deviation 6, closed
// 2026-11-18) — the Sides/Maps/Weapons tables were the last metric
// surface rendering plain dashes/empty text where the design demands
// state chips. The fixture stages the WHOLE vocabulary across the
// tables: fresh rows with byte-identical numbers beside behind /
// processing cells in the SAME row, and fully-empty tables whose empty
// branch carries the live state instead of the plain text (failed beats
// behind in the Weapons branch, and its title keeps the engine error).
console.log('N. the split tables render the five-state cells — fresh numbers beside behind/processing chips, state in the empty branches');
{
  localStorage.removeItem('spectra:pinned-profile-metrics');
  const def = (id, name, format) => ({
    id, name, title: name, scope: 'profile', format,
    doc: `Formula: ${name} seed`, origin: 'builtin',
  });
  const CATALOG = [
    def(201, 'side_rounds', 'int'),
    def(202, 'side_win_pct', 'percent'),
    def(203, 'side_adr', 'float1'),
    def(204, 'side_kast', 'percent'),
    def(205, 'side_kd', 'float2'),
    def(206, 'map_matches', 'int'),
    def(207, 'map_wins', 'int'),
    def(208, 'map_adr', 'float1'),
    def(209, 'weapon_kills', 'int'),
    def(210, 'weapon_damage', 'int'),
    def(211, 'weapon_headshots', 'int'),
    // CAREER_SLOTS' one fixed seed — its resolution is what makes the
    // career effect issue the compute-state read the split cells share
    // (an empty id list returns before it).
    def(81, 'career_matches', 'int'),
  ];
  bindings.MetricsService.ListMetrics = () => Promise.resolve(CATALOG);
  bindings.MetricsService.GetMetricValuesForPlayer = () =>
    Promise.resolve([
      { metricId: 81, subjectKey: '76561198000000001', value: 7, n: 7 },
      { metricId: 201, subjectKey: '76561198000000001', dim: 'ct', value: 65, n: 13 },
      { metricId: 201, subjectKey: '76561198000000001', dim: 't', value: 61, n: 12 },
      { metricId: 203, subjectKey: '76561198000000001', dim: 'ct', value: 42.56, n: 13 },
      { metricId: 203, subjectKey: '76561198000000001', dim: 't', value: 38.2, n: 12 },
    ]);
  bindings.MetricsService.GetMetricComputeState = () =>
    Promise.resolve([
      { metricId: 81, state: 'fresh' },
      { metricId: 201, state: 'fresh' },
      { metricId: 203, state: 'fresh' },
      { metricId: 202, state: 'behind' },
      { metricId: 204, state: 'behind' },
      { metricId: 205, state: 'processing' },
      { metricId: 206, state: 'behind' },
      { metricId: 207, state: 'behind' },
      { metricId: 208, state: 'behind' },
      { metricId: 209, state: 'behind' },
      { metricId: 210, state: 'behind' },
      { metricId: 211, state: 'failed', error: 'engine exploded' },
    ]);
  invalidate();
  const target = document.createElement('div');
  document.body.appendChild(target);
  mount(profileMod.default, { target, props: { steamId: '76561198000000001', nav: () => {} } });
  await sleep(140);

  const tableOf = (needle) =>
    [...target.querySelectorAll('.prof-splits section')].find((s) =>
      (s.querySelector('h2')?.textContent || '').includes(needle),
    )?.querySelector('table');
  const rowWith = (table, text) =>
    [...(table?.querySelectorAll('tbody tr') || [])].find((tr) => tr.textContent.includes(text));

  const sides = tableOf('Sides');
  const sideRow = (code) =>
    [...(sides?.querySelectorAll('tbody tr') || [])].find(
      (tr) => tr.querySelector('.chip.side')?.textContent.trim() === code,
    );
  const ctRow = sideRow('CT');
  const tRow = sideRow('T');
  check(
    'sides: fresh rows still render (ct + t) with byte-identical numbers — rounds 65 raw, ADR 42.6 through fmt1',
    sides?.querySelectorAll('tbody tr').length === 2 &&
      ctRow?.children[1]?.textContent.trim() === '65' &&
      ctRow?.children[3]?.textContent.trim() === '42.6' &&
      tRow?.children[1]?.textContent.trim() === '61',
    `rows=${sides?.querySelectorAll('tbody tr').length} ct=[${[...(ctRow?.children || [])]
      .map((c) => c.textContent.trim())
      .join(',')}]`,
  );
  const behindCell = ctRow?.children[2]?.querySelector('.chip.status');
  check(
    'sides: a BEHIND seed in a fresh row wears the behind chip (idle, design copy) — never a plain dash',
    !!behindCell &&
      behindCell.classList.contains('idle') &&
      (behindCell.getAttribute('title') || '') === 'value not available yet — recompute pending',
    behindCell ? `class=${behindCell.className} title=${behindCell.getAttribute('title')}` : 'no chip in the Win% cell',
  );
  const busyCell = ctRow?.children[5]?.querySelector('.chip.status');
  check(
    'sides: a PROCESSING seed wears the busy chip in the K/D cell (its number is withheld, never stale)',
    !!busyCell && busyCell.classList.contains('busy'),
    busyCell ? `class=${busyCell.className}` : 'no chip in the K/D cell',
  );
  const kastChip = ctRow?.children[4]?.querySelector('.chip.status');
  check(
    'sides: every state cell carries the state title (Win% and KAST behind — both chips, no bare dashes)',
    !!kastChip && kastChip.classList.contains('idle'),
    kastChip ? `class=${kastChip.className}` : 'no chip in the KAST cell',
  );

  const maps = tableOf('Maps');
  const mapsCell = maps?.querySelector('tbody tr td');
  check(
    'maps: with nothing stored anywhere the empty branch carries the BEHIND chip — the plain empty text stays for the up-to-date case only',
    maps?.querySelectorAll('tbody tr').length === 1 &&
      !!mapsCell?.querySelector('.chip.status') &&
      mapsCell.querySelector('.chip.status').classList.contains('idle'),
    `rows=${maps?.querySelectorAll('tbody tr').length} cell=${mapsCell?.textContent.trim()}`,
  );

  const weapons = tableOf('Weapons');
  const weaponsCell = weapons?.querySelector('tbody tr td');
  check(
    'weapons: the empty branch shows FAILED (bad chip) over behind by precedence, and its title keeps the engine error',
    !!weaponsCell?.querySelector('.chip.status') &&
      weaponsCell.querySelector('.chip.status').classList.contains('bad') &&
      (weaponsCell.querySelector('.chip.status').getAttribute('title') || '') === 'engine exploded',
    weaponsCell ? `cell=${weaponsCell.textContent.trim()} title=${weaponsCell.querySelector('.chip.status')?.getAttribute('title')}` : 'no weapons cell',
  );

  document.body.removeChild(target);
  // Leave the shared stubs for any later section (this is the last):
  bindings.MetricsService.GetMetricComputeState = () => Promise.resolve([]);
  localStorage.removeItem('spectra:pinned-profile-metrics');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
