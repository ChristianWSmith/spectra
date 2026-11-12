// jsdom driver for Combat: the Engagements card's column order (round →
// time into round → killer vs victim → distance in metres — no raw-tick
// and no "won by" column), ONE-ROW-PER-KILL merging (a kill's trade +
// untraded facts share one row with both chips — section D — plus the
// opening+untraded pair, the contained-kind filter behaviour and the
// grouping-key precision in E/F) and the Clutches card's won-only scope.
//
// jsdom is intentionally not a project dependency; from frontend/ run:
//   npm i --no-save jsdom
//   node --test test/combat.dom.mjs
// (must be run with frontend/ as the working directory; the same file also
// runs under `node --conditions browser test/combat.dom.mjs` — it pins the
// browser condition itself so `svelte` resolves to the client build)
import { registerHooks } from 'node:module';

// svelte's package exports pick the SERVER build without the `browser`
// condition (mount() then throws "lifecycle_function_unavailable"), so the
// driver adds it for every svelte specifier before anything imports one.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'svelte' || specifier.startsWith('svelte/')) {
      return nextResolve(specifier, {
        ...context,
        conditions: ['browser', ...(context.conditions || [])],
      });
    }
    return nextResolve(specifier, context);
  },
});

const { JSDOM } = await import('jsdom');
const { compile } = await import('svelte/compiler');
const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
const { join } = await import('node:path');
const { pathToFileURL } = await import('node:url');

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

const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'combat');
mkdirSync(join(dir, 'replay'), { recursive: true });
mkdirSync(join(dir, 'components'), { recursive: true });
mkdirSync(join(dir, 'views'), { recursive: true });

const svelteCompile = (src, filename, out) => {
  writeFileSync(out, compile(src, { filename, generate: 'client' }).js.code);
};

// Plain-ESM deps copied verbatim with their relative layout intact
// (fmt → rounds, nav → router + replay/landmarks → rounds, teams →
// sideparity) — the same copy the landmark-row / stat-card drivers do.
for (const rel of ['rounds.js', 'sideparity.js', 'router.js', 'nav.js', 'teams.js', 'definitions.js', 'fmt.js', 'players.js']) {
  writeFileSync(join(dir, rel), readFileSync(join('src/lib', rel), 'utf8'));
}
writeFileSync(
  join(dir, 'replay', 'landmarks.js'),
  readFileSync('src/lib/replay/landmarks.js', 'utf8'),
);

// The view's data source is scripted, never a live Wails backend: the
// driver sets globalThis.__combatData before each mount.
writeFileSync(
  join(dir, 'services.js'),
  `const d = () => globalThis.__combatData || {};
export const getCombatStats = () => Promise.resolve(d().stats || []);
export const getClutches = () => Promise.resolve(d().clutches || []);
export const getEngagements = () => Promise.resolve(d().engagements || []);
export const getPlayerRounds = () => Promise.resolve(d().playerRounds || []);
export const getRounds = () => Promise.resolve(d().rounds || []);
export const getScoreboard = () => Promise.resolve(d().scoreboard || []);
export const getMatch = () => Promise.resolve(d().match || null);
export const errText = (e) => (e == null ? 'unknown error' : String((e && e.message) || e));
`,
);

for (const name of ['Dialog', 'SortTh', 'EventPlay', 'ProfileLink']) {
  svelteCompile(
    readFileSync(`src/lib/components/${name}.svelte`, 'utf8'),
    `${name}.svelte`,
    join(dir, 'components', `${name}.js`),
  );
}

// Combat.svelte → its ../ imports land in dir/ (services.js above, fmt,
// nav, teams, definitions, replay/landmarks are copied there); only the
// .svelte component imports need rewriting to their compiled .js.
const combatSrc = readFileSync('src/lib/views/Combat.svelte', 'utf8').replace(
  /from '\.\.\/components\/(\w+)\.svelte'/g,
  "from '../components/$1.js'",
);
svelteCompile(combatSrc, 'Combat.svelte', join(dir, 'views', 'Combat.js'));

const harnessSrc = `<script>
  import Combat from './views/Combat.js';
</script>
<Combat id={3} nav={(h) => (globalThis.__nav = (globalThis.__nav || []).concat(h))} />`;
const harnessOut = join(dir, 'harness.js');
svelteCompile(harnessSrc, 'harness.svelte', harnessOut);

const { mount } = await import('svelte');
const mod = await import(pathToFileURL(harnessOut).href);

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

// mount renders into a fresh target; scenario C remounts after replacing
// the scripted data, so each scenario gets its own root.
async function render(data) {
  globalThis.__combatData = data;
  const target = document.createElement('div');
  document.body.appendChild(target);
  mount(mod.default, { target });
  await sleep();
  return target;
}

const sections = (root, heading) =>
  [...root.querySelectorAll('section.panel')].filter((s) =>
    s.querySelector('h2')?.textContent.includes(heading),
  );
const headerTexts = (table) => [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
const rows = (table) => [...table.querySelectorAll('tbody tr')];

// Round 7 starts at tick 10000 at 64 tick — the engagement at 10640 is
// 640/64 = 10 s INTO that round ("0:10"), never the match clock.
const base = {
  match: { tickRate: 64, sideSwitches: 0 },
  rounds: [
    { number: 6, startTick: 9040, endTick: 10000 },
    { number: 7, startTick: 10000, endTick: 10960 },
  ],
  scoreboard: [
    { steamId: 'A', name: 'alice', side: 'ct' },
    { steamId: 'B', name: 'bob', side: 't' },
  ],
  stats: [],
  engagements: [
    { tick: 10640, round: 7, kind: 'opening', aSteam: 'A', aName: 'alice', bSteam: 'B', bName: 'bob', distance: 19.4, wonBy: 'ct' },
    { tick: 10704, round: 7, kind: 'untraded', aSteam: 'B', aName: 'bob', bSteam: 'A', bName: 'alice', distance: 0, wonBy: 't' },
  ],
  clutches: [
    { id: 1, round: 7, size: 2, steamId: 'D', name: 'dave', won: false, hpLeft: 1, bombState: 'none', replayAnchorTick: 10500, startTick: 10400, endTick: 10700 },
    // The won clutch carries its own span (analytics ClutchRow) — the ▶
    // keeps the anchor SEEK and stamps start→end as the entry ?loop=.
    { id: 2, round: 7, size: 1, steamId: 'C', name: 'carol', won: true, hpLeft: 42, bombState: 'planted', replayAnchorTick: 10600, startTick: 10480, endTick: 10960 },
  ],
};

console.log('A. engagement columns: round → time into round → killer vs victim → dist (m)');
const root = await render(base);
const eng = sections(root, 'Engagements')[0];
const engTable = eng?.querySelector('table');
check('engagements table rendered', !!engTable);
check(
  'header order',
  JSON.stringify(headerTexts(engTable)) ===
    JSON.stringify(['Replay', 'Round', 'Time', 'Kind', 'Killer', 'versus', 'Victim', 'Dist (m)']),
  JSON.stringify(headerTexts(engTable)),
);
const engRows = rows(engTable);
check('two engagement rows', engRows.length === 2, String(engRows.length));
const first = engRows[0]?.querySelectorAll('td') || [];
// The Round cell is TEXT again (owner ruling: "no round play button
// there" — the round-watch ▶ was removed): R{n} as a plain label, and
// the row's ONLY play button is the event/follow ▶ in the Replay column
// (A5 resolved to ONE play button per row).
check('round cell renders the R{n} text label', first[1]?.textContent.trim() === 'R7', first[1]?.textContent);
check('round cell carries NO button (no round play)', !first[1]?.querySelector('button'), first[1]?.innerHTML);
const engPlayBtn = first[0]?.querySelector('button');
check(
  'A5: ONE play button per row — the event/follow ▶ (killer), no round play',
  first[0]?.querySelectorAll('button').length === 1 &&
    !first[1]?.querySelector('button') &&
    !!engPlayBtn &&
    engPlayBtn.getAttribute('title') === 'Watch this engagement — follow alice (killer)',
  JSON.stringify([engPlayBtn?.getAttribute('title'), first[1]?.innerHTML]),
);
check('time cell is time INTO the round', first[2]?.textContent.trim() === '0:10', first[2]?.textContent);
check('raw tick kept in the cell title', first[2]?.getAttribute('title') === 'tick 10640', first[2]?.getAttribute('title'));
check('kind chip intact', first[3]?.textContent.includes('opening'), first[3]?.textContent);
check('killer column holds the killer', first[4]?.textContent.includes('alice'), first[4]?.textContent);
check('victim column holds the victim', first[6]?.textContent.includes('bob'), first[6]?.textContent);
check('distance rounded in metres', first[7]?.textContent.trim() === '19', first[7]?.textContent);
const second = engRows[1]?.querySelectorAll('td') || [];
check('missing distance renders an em dash', second[7]?.textContent.trim() === '—', second[7]?.textContent);
check(
  'kind filter still offered',
  [...eng.querySelectorAll('.comb-kind')].map((b) => b.textContent.trim()).join(',') === 'all,opening,trade,untraded',
  [...eng.querySelectorAll('.comb-kind')].map((b) => b.textContent.trim()).join(','),
);

// (B) the engagement ▶ keeps its seek tick, stamps the ±10 s entry
// loop (nav.entryLoopAround — 10 s × 64 tick = 640 either side) AND the
// KILLER as the camera follow (the owner's rule for kill rows).
check(
  'engagement ▶ is icon-only play with a follow-aware title',
  !!engPlayBtn && engPlayBtn.textContent.trim() === '' && !!engPlayBtn.querySelector('.codicon-play') &&
    engPlayBtn.getAttribute('title') === 'Watch this engagement — follow alice (killer)',
  engPlayBtn?.getAttribute('title'),
);
click(engPlayBtn);
await sleep();
const navEng = (globalThis.__nav || [])[(globalThis.__nav || []).length - 1];
check(
  'engagement ▶ links tick + a ±10 s loop + follow=the killer, no filter',
  !!navEng &&
    navEng.includes('tick=10640') &&
    navEng.includes('loop=10000,11280') &&
    navEng.includes('follow=A') &&
    !navEng.includes('cat='),
  navEng || 'no navigation',
);

console.log('B. clutches card lists WON clutches only');
const clutchSec = sections(root, 'Clutches')[0];
check('provenance chip states the won-only scope', clutchSec?.querySelector('.provenance')?.textContent.includes('won only'), clutchSec?.querySelector('.provenance')?.textContent);
const clutchRows = rows(clutchSec?.querySelector('table') || document.createElement('table'));
check('one clutch row (the won one)', clutchRows.length === 1, String(clutchRows.length));
check('won clutch shown', clutchSec?.textContent.includes('carol'), '');
check('lost clutch dropped', !clutchSec?.textContent.includes('dave'), '');
check('lost clutch HP-left (1) gone with it', !clutchRows.some((r) => r.textContent.includes('1v2')), '');
check('HP left column kept', clutchRows[0]?.textContent.includes('42'), clutchRows[0]?.textContent);

// (B) the clutch ▶ keeps its anchor SEEK (replayAnchorTick), stamps the
// clutch's own start→end span as the entry ?loop=, and follows the
// CLUTCH's solo (the row actor).
const clutchPlay = clutchRows[0]?.querySelector('td button');
check(
  'clutch ▶ is icon-only play naming the solo it follows',
  !!clutchPlay && clutchPlay.textContent.trim() === '' && !!clutchPlay.querySelector('.codicon-play') &&
    clutchPlay.getAttribute('title') === 'Watch this clutch — follow carol',
  clutchPlay?.getAttribute('title'),
);
click(clutchPlay);
await sleep();
const navClutch = (globalThis.__nav || [])[(globalThis.__nav || []).length - 1];
check(
  'clutch ▶ links tick + the clutch start→end loop + follow=the solo',
  !!navClutch &&
    navClutch.includes('tick=10600') &&
    navClutch.includes('loop=10480,10960') &&
    navClutch.includes('follow=C') &&
    !navClutch.includes('cat='),
  navClutch || 'no navigation',
);
// …and the clutch Round cell is TEXT too: the R{n} label with no round
// play — the clutch ▶ above is the row's only play button.
const clutchCells = clutchRows[0]?.querySelectorAll('td') || [];
check(
  'clutch round cell renders the R{n} text label, no button',
  clutchCells[1]?.textContent.trim() === 'R7' && !clutchCells[1]?.querySelector('button'),
  clutchCells[1]?.textContent,
);
check(
  'clutch row has exactly ONE play button (the event/follow ▶)',
  clutchRows[0].querySelectorAll('button').length === 1,
  String(clutchRows[0].querySelectorAll('button').length),
);

console.log('C. only lost clutches → explicit empty state');
document.body.removeChild(root);
const root2 = await render({ ...base, clutches: [base.clutches[0]] });
const clutchSec2 = sections(root2, 'Clutches')[0];
check(
  'no-won-clutches message',
  clutchSec2?.textContent.includes('No won clutches in this match.'),
  clutchSec2?.textContent.slice(0, 120),
);

// The kind-filter buttons of a given Engagements section (each scenario
// mounts its own root, so the helper is scoped per section).
const kindBtn = (sec, label) =>
  [...sec.querySelectorAll('.comb-kind')].find((b) => b.textContent.trim() === label);

console.log('D. one kill, one row: the same-tick trade+untraded pair merges (the reported bug)');
document.body.removeChild(root2);
// The real seq 30/31 shape: same round, tick, killer, victim AND
// distance in BOTH fetched rows — only Kind differs (two true statements
// about ONE kill — killer-side fact + victim-side fact — not a
// duplicate emission; Go keeps emitting both per-kind rows).
const pairKill = {
  tick: 10640,
  round: 7,
  aSteam: 'A',
  aName: 'alice',
  bSteam: 'B',
  bName: 'bob',
  distance: 7.888,
  wonBy: 'ct',
};
const rootD = await render({
  ...base,
  engagements: [
    { ...pairKill, kind: 'trade' },
    { ...pairKill, kind: 'untraded' },
  ],
});
const engD = sections(rootD, 'Engagements')[0];
const tableD = engD?.querySelector('table');
check('engagements table rendered', !!tableD);
const dRows = rows(tableD);
check('TWO fetched rows render as ONE', dRows.length === 1, String(dRows.length));
const dCells = dRows[0]?.querySelectorAll('td') || [];
check(
  'one distance cell — the shared 7.888 rounds to 8 m exactly once',
  dCells.length === 8 && dCells[7]?.textContent.trim() === '8',
  `${dCells.length} cells / dist="${dCells[7]?.textContent}"`,
);
const dChips = [...(dRows[0]?.querySelectorAll('.comb-kind-chip') || [])];
check(
  'the single row carries BOTH kind chips, side by side',
  JSON.stringify(dChips.map((c) => c.textContent.trim())) === '["trade","untraded"]',
  JSON.stringify(dChips.map((c) => c.textContent.trim())),
);
check(
  'each chip keeps its own perspective-explicit title (killer side / victim side)',
  /killer side/.test(dChips[0]?.getAttribute('title') || '') &&
    /victim side/.test(dChips[1]?.getAttribute('title') || ''),
  JSON.stringify(dChips.map((c) => c.getAttribute('title'))),
);
check(
  'the Kind cell carries an accessible combined label (one kill, both facts)',
  /One kill/.test(dCells[3]?.textContent || '') && /killer side/.test(dCells[3]?.textContent || ''),
  dCells[3]?.textContent,
);
// The A5 ruling holds on the MERGED row too: ONE play button (the
// event/follow ▶) and the Round cell as plain text.
const dPlay = dCells[0]?.querySelector('button');
check(
  'A5 on the merged row: ONE play button (no round play beside it)',
  dRows[0].querySelectorAll('button').length === 1 && !!dPlay && !dCells[1]?.querySelector('button'),
  JSON.stringify([dPlay?.getAttribute('title'), String(dRows[0].querySelectorAll('button').length)]),
);
check(
  'the merged row ▶ still follows the killer',
  dPlay?.getAttribute('title') === 'Watch this engagement — follow alice (killer)',
  dPlay?.getAttribute('title'),
);
check(
  'the merged round cell keeps its R{n} text (no round play)',
  dCells[1]?.textContent.trim() === 'R7' && !dCells[1]?.querySelector('button'),
  dCells[1]?.textContent,
);

// The kind chips FILTER merged rows by CONTAINED kind: the row shows
// under trade AND under untraded, exactly once under "all", and a kind
// the pair does not carry empties the table.
const dMatched = () => !tableD.textContent.includes('No engagements match this filter.');
click(kindBtn(engD, 'trade'));
await sleep();
check('filter trade → the merged row shows', rows(tableD).length === 1 && dMatched(), String(rows(tableD).length));
click(kindBtn(engD, 'untraded'));
await sleep();
check(
  'filter untraded → the SAME row (both chips still on it)',
  rows(tableD).length === 1 && dMatched() &&
    [...tableD.querySelectorAll('.comb-kind-chip')].length === 2,
  String(rows(tableD).length),
);
click(kindBtn(engD, 'opening'));
await sleep();
check(
  'filter opening → no match (the pair carries no opening fact)',
  !dMatched() && tableD.textContent.includes('No engagements match this filter.'),
  tableD.textContent.slice(-90),
);
click(kindBtn(engD, 'all'));
await sleep();
check('filter all → exactly ONE row (never twice)', rows(tableD).length === 1, String(rows(tableD).length));

console.log('E. the real seq 27/28 shape: an opening+untraded pair merges too');
document.body.removeChild(rootD);
const pairKill2 = {
  tick: 10640,
  round: 7,
  aSteam: 'A',
  aName: 'alice',
  bSteam: 'B',
  bName: 'bob',
  distance: 12.5,
  wonBy: 'ct',
};
const rootE = await render({
  ...base,
  engagements: [
    { ...pairKill2, kind: 'opening' },
    { ...pairKill2, kind: 'untraded' },
  ],
});
const engE = sections(rootE, 'Engagements')[0];
const tableE = engE?.querySelector('table');
const eRows = rows(tableE);
check('opening+untraded renders ONE row', eRows.length === 1, String(eRows.length));
const eChips = [...(eRows[0]?.querySelectorAll('.comb-kind-chip') || [])];
check(
  'both chips present, in the fetch (kind) order',
  JSON.stringify(eChips.map((c) => c.textContent.trim())) === '["opening","untraded"]',
  JSON.stringify(eChips.map((c) => c.textContent.trim())),
);
click(kindBtn(engE, 'opening'));
await sleep();
check(
  'filter opening → the merged row shows',
  rows(tableE).length === 1 && !tableE.textContent.includes('No engagements match this filter.'),
  String(rows(tableE).length),
);
click(kindBtn(engE, 'untraded'));
await sleep();
check(
  'filter untraded → the SAME row shows',
  rows(tableE).length === 1 && !tableE.textContent.includes('No engagements match this filter.'),
  String(rows(tableE).length),
);

console.log('F. grouping precision: same tick, DIFFERENT pair stays its own row; fetch order preserved');
document.body.removeChild(rootE);
const rootF = await render({
  ...base,
  engagements: [
    // an EARLIER single-kill row…
    { tick: 10500, round: 7, kind: 'untraded', aSteam: 'B', aName: 'bob', bSteam: 'A', bName: 'alice', distance: 0, wonBy: 't' },
    // …the merged pair (its two rows share round+tick+killer+victim)…
    { ...pairKill, kind: 'trade' },
    { ...pairKill, kind: 'untraded' },
    // …and a DIFFERENT kill at the SAME tick (the other pair): the
    // grouping key carries killer+victim, so it must NOT merge.
    { tick: 10640, round: 7, kind: 'untraded', aSteam: 'B', aName: 'bob', bSteam: 'A', bName: 'alice', distance: 4, wonBy: 't' },
  ],
});
const tableF = sections(rootF, 'Engagements')[0]?.querySelector('table');
const fRows = rows(tableF);
check('three rows: earlier single + merged pair + same-tick other pair', fRows.length === 3, String(fRows.length));
const fCells = (i) => fRows[i]?.querySelectorAll('td') || [];
check(
  'fetch order (round → tick → kind) preserved: merged row sits at its earliest member',
  fCells(0)[2]?.getAttribute('title') === 'tick 10500' &&
    fCells(1)[2]?.getAttribute('title') === 'tick 10640' &&
    fCells(2)[2]?.getAttribute('title') === 'tick 10640',
  [fCells(0)[2], fCells(1)[2], fCells(2)[2]].map((c) => c?.getAttribute('title')).join(' | '),
);
check(
  'the pair merges to one two-chip row…',
  [...fRows[1].querySelectorAll('.comb-kind-chip')].length === 2 &&
    fRows[1].textContent.includes('alice'),
  fRows[1]?.textContent,
);
check(
  '…while the same-tick DIFFERENT pair stays its own one-chip row',
  [...fRows[2].querySelectorAll('.comb-kind-chip')].length === 1 &&
    fRows[2].textContent.includes('bob'),
  fRows[2]?.textContent,
);

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
