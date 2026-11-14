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
//      (read off the trend point's own extractedAt), and the x-axis
//      caption names the patch-ordered sequence — the chart must not
//      read as a played-on timeline;
//   I. PlayerProfile's "Career metrics" panel (stored-metrics design
//      §1a/§5): the profile-scope pins (spectra:pinned-profile-metrics)
//      read the STORED career rows through the canonical read — fresh
//      renders the value with its n, a non-fresh state renders the chip
//      and never a number, a match-scope metric never surfaces here, and
//      no rendered output carries a version number.
//   J. dogfooding W3: the profile surface after the card conversion —
//      exactly 4 fixed cards (Matches, Win%, Opening duels, Clutches
//      count) followed by the Career metrics panel rendering the nine
//      DEFAULT pins in DEFAULT order over a reversed catalog, and the
//      Profiles list's ADR column reading the stored `career_adr` bucket
//      row (value, honest gap, behind chip, metric-value sort).
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
    winPct: 50,
    adrAvg: 37.5,
    adrStd: 3.5,
    kd: 1.1,
    hsPct: 40,
    kastPct: 70,
    openingRate: 50,
    tradeRate: 30,
    trades: 3,
    tradeOpps: 10,
    clutches: 1,
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
        matchId: 2, extractedAt: '2026-03-01T10:00:00Z', map: 'de_mirage', win: false,
        scoreCT: 10, scoreT: 13, startSide: 't', kills: 5, deaths: 12, assists: 1,
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
bindings.ProfileService.GetCareerTrend = () =>
  Promise.resolve([
    { matchId: 1, seq: 0, value: 35, patch: 14089, extractedAt: '2025-07-28T09:00:00Z' },
    { matchId: 2, seq: 1, value: 40, patch: 14113, extractedAt: '2026-03-01T10:00:00Z' },
  ]);

const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'profiles');
mkdirSync(dir, { recursive: true });
const fileURL = (p) => pathToFileURL(p).href;
const svelteCompile = (src, filename, out) => {
  writeFileSync(out, compile(src, { filename, generate: 'client' }).js.code);
};

// Leaf components (no imports) → local bundles. The names match the
// view's `../components/<Name>.svelte` specifiers after the rewrite
// below, so the bundles keep their component names.
for (const name of ['SortTh', 'Popover', 'StatCard', 'StatusChip']) {
  svelteCompile(
    readFileSync(`src/lib/components/${name}.svelte`, 'utf8'),
    `${name}.svelte`,
    join(dir, `${name}.js`),
  );
}

// SuggestInput imports Popover, the plain-ESM fmt helper and services
// (the career ADR metric read) → local bundle + absolute module URLs
// (its compiled file sits in dir/, not in src/lib/components/).
const siSrc = readFileSync('src/lib/components/SuggestInput.svelte', 'utf8')
  .replace("from './Popover.svelte'", "from './Popover.js'")
  .replace("from '../fmt.js'", `from '${fileURL('src/lib/fmt.js')}'`)
  .replace("from '../services.js'", `from '${fileURL('src/lib/services.js')}'`);
svelteCompile(siSrc, 'SuggestInput.svelte', join(dir, 'SuggestInput.js'));

// The views: plain-ESM imports resolve from their real module locations
// (the shared graph — services → stubs, nav → router/landmarks, …), the
// .svelte imports point at the local bundles.
const bundleView = (name, out) => {
  const src = readFileSync(`src/lib/views/${name}.svelte`, 'utf8')
    .replace(/from '\.\.\/components\/(\w+)\.svelte'/g, "from './$1.js'")
    .replace(/from '\.\.\/([\w.]+)'/g, (_m, p) => `from '${fileURL(`src/lib/${p}`)}'`);
  svelteCompile(src, `${name}.svelte`, join(dir, out));
};
bundleView('Profiles', 'profiles-bundle.js');
bundleView('PlayerProfile', 'playerprofile-bundle.js');

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
const { invalidate } = await import(pathToFileURL('src/lib/services.js').href);
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
  check(
    'PlayerProfile mid-load: block spinner + "Loading…" underneath',
    !!h2.querySelector('.chip-block .chip-spin') &&
      h2.querySelector('.chip-detail')?.textContent.trim() === 'Loading…' &&
      !h2.querySelector('.chip-ring') &&
      !h2.querySelector('.chip-pct'),
    h2.querySelector('.chip-block')?.outerHTML.slice(0, 160) ?? 'missing',
  );
  document.body.removeChild(h2);
  bindings.ProfileService.GetProfile = prevGetProfile;
  invalidate();
}

console.log('I. PlayerProfile Career metrics: profile pins read STORED career rows with state chips');
{
  // The profile-scope pin key (design §3's scope-routed pin — Builder's
  // single button writes it) plus the stored career rows and the state
  // read. Only amy's profile is mounted; only HER row may render even
  // though the read is the whole career bucket (other players' rows are
  // this unit's coverage, never displayed).
  localStorage.setItem('spectra:pinned-profile-metrics', '[51,52]');
  bindings.MetricsService.ListMetrics = () =>
    Promise.resolve([
      {
        id: 51, name: 'career_kd', title: 'Career K/D', scope: 'profile',
        format: 'float1', doc: 'Formula: kills / deaths', origin: 'user',
      },
      {
        id: 52, name: 'career_avg', title: 'Career avg', scope: 'profile',
        format: '', doc: 'Formula: avg dmg', origin: 'user',
      },
      {
        id: 53, name: 'match_only', title: 'Match only', scope: 'match',
        format: '', doc: 'Formula: x', origin: 'user',
      },
    ]);
  bindings.MetricsService.GetMetricValuesForPlayer = () =>
    Promise.resolve([
      { metricId: 51, steamId: '76561198000000001', value: 1.5, n: 40 },
      { metricId: 51, steamId: '76561198000000002', value: 2.5, n: 99 },
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

  const panel = [...iTarget.querySelectorAll('section.panel')].find((s) =>
    s.textContent.includes('Career metrics'),
  );
  check('the Career metrics panel renders for the profile pins', !!panel, 'no panel');
  const rows = panel ? [...panel.querySelectorAll('tbody tr')] : [];
  check(
    'exactly the two profile-scope pins list (a match-scope metric never surfaces here)',
    rows.length === 2 &&
      rows[0].textContent.includes('Career K/D') &&
      rows[1].textContent.includes('Career avg'),
    JSON.stringify(rows.map((r) => r.textContent.trim())),
  );
  {
    const cell = rows[0]?.children[1];
    check(
      'fresh renders the STORED value with n in the tooltip',
      !!cell && cell.textContent.trim() === '1.5' && !cell.querySelector('.chip.status') &&
        (cell.getAttribute('title') || '').includes('sample size n=40'),
      cell ? `${cell.textContent.trim()} title=${cell.getAttribute('title')}` : 'no cell',
    );
  }
  {
    const cell = rows[1]?.children[1];
    const chip = cell?.querySelector('.chip.status');
    check(
      'behind renders the chip with the design copy, never a number',
      !!chip &&
        chip.classList.contains('idle') &&
        chip.textContent.trim() === 'behind' &&
        cell.getAttribute('title') === 'value not available yet — recompute pending' &&
        !/\d/.test(cell.textContent),
      cell ? `${chip ? chip.className : 'no chip'} "${cell.textContent.trim()}"` : 'no cell',
    );
  }
  check(
    "another player's bucket row never renders on this profile",
    !panel?.textContent.includes('2.5'),
    panel?.textContent.replace(/\s+/g, ' ').slice(0, 200),
  );
  {
    const leaks = [];
    const re = /version|\bv\d+\b|\d{4}-\d{2}-\d{2}|rule stamp|computed at/i;
    for (const el of panel ? panel.querySelectorAll('.chip, td[title]') : []) {
      const tip = el.getAttribute('title') || '';
      if (re.test(tip)) leaks.push(`title: ${tip}`);
      if (re.test(el.textContent || '')) leaks.push(`text: ${el.textContent.trim()}`);
    }
    check(
      'no version number or timestamp appears in the Career metrics output',
      leaks.length === 0,
      leaks.join(' | '),
    );
  }

  localStorage.removeItem('spectra:pinned-profile-metrics');
  document.body.removeChild(iTarget);
}

console.log(
  'J. dogfooding W3: 4 fixed cards + the nine default-pinned metric rows, and the Profiles ADR column is metric-backed',
);
{
  // The profile-scope catalog in REVERSE default order (plus an
  // unpinned profile metric and a match-scope one): the rendered row
  // order must come from metricorder's DEFAULT sequence under the
  // ABSENT pins key — never from the catalog order, never from an id
  // list. Titles/short_name/format mirror the real builtin seeds.
  const CATALOG = [
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
    {
      id: 66, name: 'career_trade_rate', title: 'Trade rate', scope: 'profile',
      format: 'percent', doc: 'Formula: ratio(sum(trade_kills), sum(opps))', origin: 'builtin',
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
  const NINE = [69, 68, 67, 66, 65, 64, 63, 62, 61]; // CATALOG order
  // amy's career rows for all nine (the profile under test), plus bob's
  // and zoe's `career_adr` for the Profiles list column — dan gets NO
  // row, which is the honest gap that must render '—'.
  const ROWS = [
    { metricId: 61, steamId: '76561198000000001', value: 63.5, n: 42 },
    { metricId: 61, steamId: '76561198000000002', value: 55, n: 7 },
    { metricId: 61, steamId: '76561198000000003', value: 40, n: 9 },
    { metricId: 62, steamId: '76561198000000001', value: 12.5, n: 42 },
    { metricId: 63, steamId: '76561198000000001', value: 1.42, n: 42 },
    { metricId: 64, steamId: '76561198000000001', value: 0.41, n: 42 },
    { metricId: 65, steamId: '76561198000000001', value: 0.7, n: 42 },
    { metricId: 66, steamId: '76561198000000001', value: 0.666, n: 42 },
    { metricId: 67, steamId: '76561198000000001', value: 0.5, n: 42 },
    { metricId: 68, steamId: '76561198000000001', value: 3.2, n: 42 },
    { metricId: 69, steamId: '76561198000000001', value: 88.9, n: 42 },
  ];
  bindings.MetricsService.ListMetrics = () => Promise.resolve(CATALOG);
  // Deliberately WIDER than asked: the real read narrows server-side,
  // but a stub that honours the id filter would hide a view that forgot
  // to key its rows by metric. Both views must filter to their own
  // metric before rendering.
  bindings.MetricsService.GetMetricValuesForPlayer = () => Promise.resolve(ROWS);
  bindings.MetricsService.GetMetricComputeState = () =>
    Promise.resolve(NINE.map((id) => ({ metricId: id, state: 'fresh' })));

  // --- J1: the profile surface = 4 fixed cards + 9 default-pinned rows
  invalidate(); // flush section I's stubs (same read-cache keys)
  const j1 = document.createElement('div');
  document.body.appendChild(j1);
  mount(profileMod.default, {
    target: j1,
    props: { steamId: '76561198000000001', nav: () => {} },
  });
  await sleep(140); // mount + getProfile + listMetrics + the career read

  const grid = j1.querySelector('.stat-grid');
  const cardLabels = grid
    ? [...grid.querySelectorAll('.stat-cell .field-label')].map((e) => e.textContent.trim())
    : [];
  check(
    'the fixed block is exactly Matches, Win%, Opening duels, Clutches (the nine converted cards left it)',
    JSON.stringify(cardLabels) ===
      JSON.stringify(['Matches', 'Win%', 'Opening duels', 'Clutches']),
    JSON.stringify(cardLabels),
  );
  {
    const cells = grid ? [...grid.querySelectorAll('.stat-cell')] : [];
    const clutches = cells.find((c) => c.querySelector('.field-label')?.textContent.trim() === 'Clutches');
    check(
      'the Clutches card keeps its COUNT and lost "and the share won"',
      !!clutches &&
        clutches.querySelector('.stat-value')?.textContent.trim() === '1' &&
        /1vN/.test(clutches.getAttribute('title') || '') &&
        !/share won/.test(clutches.getAttribute('title') || ''),
      clutches ? `value=${clutches.querySelector('.stat-value')?.textContent} title=${clutches.getAttribute('title')}` : 'no card',
    );
    for (const gone of ['ADR ± σ', 'Trade rate', 'Avg enemies flashed', 'Avg util damage']) {
      check(`the converted card "${gone}" is gone from the grid`, !cardLabels.includes(gone));
    }
  }

  const j1Panel = [...j1.querySelectorAll('section.panel')].find((s) =>
    s.textContent.includes('Career metrics'),
  );
  const j1Rows = j1Panel ? [...j1Panel.querySelectorAll('tbody tr')] : [];
  const j1Titles = j1Rows.map(
    (r) => r.children[0]?.textContent.trim(),
  );
  check(
    'the Career metrics panel renders the nine default pins in DEFAULT order (catalog order is reversed above)',
    JSON.stringify(j1Titles) ===
      JSON.stringify([
        'ADR', 'ADR σ', 'K/D', 'HS%', 'KAST%', 'Trade rate',
        'Clutch win %', 'Avg enemies flashed', 'Avg util damage',
      ]),
    JSON.stringify(j1Titles),
  );
  check(
    'the unpinned profile metric and the match-scope metric never render',
    !j1Panel?.textContent.includes('Career bonus'),
    j1Panel?.textContent.replace(/\s+/g, ' ').slice(0, 240) ?? 'no panel',
  );
  {
    const cell = j1Rows[0]?.children[1];
    check(
      'the ADR row renders amy\'s STORED value with n in the tooltip',
      !!cell && cell.textContent.trim() === '63.5' &&
        (cell.getAttribute('title') || '').includes('sample size n=42'),
      cell ? `${cell.textContent.trim()} title=${cell.getAttribute('title')}` : 'no cell',
    );
    check(
      "another player's bucket row never renders on this profile",
      !j1Panel?.textContent.includes('55.0') && !j1Panel?.textContent.includes('40.0'),
      j1Panel?.textContent.replace(/\s+/g, ' ').slice(0, 240) ?? 'no panel',
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
}

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
