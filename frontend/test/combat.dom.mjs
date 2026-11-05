// jsdom driver for Combat: the Engagements card's column order (round →
// time into round → killer vs victim → distance in metres — no raw-tick
// and no "won by" column) and the Clutches card's won-only scope.
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
for (const rel of ['rounds.js', 'sideparity.js', 'router.js', 'nav.js', 'teams.js', 'definitions.js', 'fmt.js']) {
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
    { id: 1, round: 7, size: 2, steamId: 'D', name: 'dave', won: false, hpLeft: 1, bombState: 'none', replayAnchorTick: 10500 },
    { id: 2, round: 7, size: 1, steamId: 'C', name: 'carol', won: true, hpLeft: 42, bombState: 'planted', replayAnchorTick: 10600 },
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
check('round chip is the first data cell', first[1]?.textContent.trim() === 'R7', first[1]?.textContent);
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

console.log('B. clutches card lists WON clutches only');
const clutchSec = sections(root, 'Clutches')[0];
check('provenance chip states the won-only scope', clutchSec?.querySelector('.provenance')?.textContent.includes('won only'), clutchSec?.querySelector('.provenance')?.textContent);
const clutchRows = rows(clutchSec?.querySelector('table') || document.createElement('table'));
check('one clutch row (the won one)', clutchRows.length === 1, String(clutchRows.length));
check('won clutch shown', clutchSec?.textContent.includes('carol'), '');
check('lost clutch dropped', !clutchSec?.textContent.includes('dave'), '');
check('lost clutch HP-left (1) gone with it', !clutchRows.some((r) => r.textContent.includes('1v2')), '');
check('HP left column kept', clutchRows[0]?.textContent.includes('42'), clutchRows[0]?.textContent);

console.log('C. only lost clutches → explicit empty state');
document.body.removeChild(root);
const root2 = await render({ ...base, clutches: [base.clutches[0]] });
const clutchSec2 = sections(root2, 'Clutches')[0];
check(
  'no-won-clutches message',
  clutchSec2?.textContent.includes('No won clutches in this match.'),
  clutchSec2?.textContent.slice(0, 120),
);

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
