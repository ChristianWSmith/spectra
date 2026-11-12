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
//      read as a played-on timeline.
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
  'DOMParser',
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
  { steamId: '76561198000000001', name: 'amy', matches: 1, adrAvg: 40.5, lastSeen: '2026-03-03' },
  { steamId: '76561198000000002', name: 'zoe', matches: 5, adrAvg: 81.25, lastSeen: '2026-03-02' },
  { steamId: '76561198000000003', name: 'bob', matches: 5, adrAvg: 60, lastSeen: '2026-03-01' },
  // No import date at all → the cell renders the '—' fallback and the
  // column's ascending sort puts '' first.
  { steamId: '76561198000000004', name: 'dan', matches: 3, adrAvg: 0, lastSeen: '' },
  // The pre-rule bot shape: 9 matches would win every default sort if
  // the canonical client-side filter (lib/players.js) ever leaked it.
  { steamId: '18374686479671623692', name: 'Crew', matches: 9, adrAvg: 99, lastSeen: '2026-03-04' },
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
for (const name of ['SortTh', 'Popover', 'StatCard']) {
  svelteCompile(
    readFileSync(`src/lib/components/${name}.svelte`, 'utf8'),
    `${name}.svelte`,
    join(dir, `${name}.js`),
  );
}

// SuggestInput imports Popover + the plain-ESM fmt helper → local bundle
// + absolute module URL (its compiled file sits in dir/, not in
// src/lib/components/).
const siSrc = readFileSync('src/lib/components/SuggestInput.svelte', 'utf8')
  .replace("from './Popover.svelte'", "from './Popover.js'")
  .replace("from '../fmt.js'", `from '${fileURL('src/lib/fmt.js')}'`);
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

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
