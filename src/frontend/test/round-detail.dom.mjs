// jsdom driver for RoundDetail: the round SUMMARY view's header cuts
// (owner-named: reason / kill count / start–stop seconds / winner chip /
// equip CT-T pair are gone; duration, bomb site, classification chip and
// the MVP line stay), the retired "Events in Replay" filter button (a
// Watch round seek link is the header's only replay entry), the centered
// icon-only round-transport ribbon, and the ERA-AWARE team names — the
// economy card's side column and the Round result card's winner both
// resolve a round side through sideparity.sideAtRound (teams is keyed by
// FINAL side, the round's winner/side are the sides played IN THAT
// ROUND), so a first-half round names a different team than a second-half
// round with the same winner side.
//
// jsdom is intentionally not a project dependency; from frontend/ run:
//   npm i --no-save jsdom
//   node --test test/round-detail.dom.mjs
// (must be run with frontend/ as the working directory; the same file also
// runs under `node --conditions browser test/round-detail.dom.mjs` — it
// pins the browser condition itself so `svelte` resolves to the client
// build)
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

const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'round-detail');
mkdirSync(join(dir, 'replay'), { recursive: true });
mkdirSync(join(dir, 'components'), { recursive: true });
mkdirSync(join(dir, 'views'), { recursive: true });

const svelteCompile = (src, filename, out) => {
  writeFileSync(out, compile(src, { filename, generate: 'client' }).js.code);
};

// Plain-ESM deps copied verbatim with their relative layout intact
// (fmt → rounds, nav → router + replay/landmarks → rounds/teams, teams →
// sideparity) — the same copy the combat driver does.
for (const rel of ['rounds.js', 'sideparity.js', 'router.js', 'nav.js', 'teams.js', 'definitions.js', 'fmt.js', 'players.js']) {
  writeFileSync(join(dir, rel), readFileSync(join('src/lib', rel), 'utf8'));
}
writeFileSync(
  join(dir, 'replay', 'landmarks.js'),
  readFileSync('src/lib/replay/landmarks.js', 'utf8'),
);

// kvstore stand-in: RoundStrip reads show_knife_warmup_rounds on mount
// (the round-strip driver's same stand-in, resolved from components/ via
// the rewritten binding path below).
writeFileSync(
  join(dir, 'kvstore.js'),
  'export const KVStoreService = { Get: () => Promise.resolve(globalThis.__showKnifeWarmup) };\n',
);

// The view's data source is scripted, never a live Wails backend: the
// driver sets globalThis.__roundDetail before each mount.
writeFileSync(
  join(dir, 'services.js'),
  `const d = () => globalThis.__roundDetail || {};
export const getRoundDetail = (id, round) => Promise.resolve((d().details || {})[round] || null);
export const getRounds = () => Promise.resolve(d().rounds || []);
export const getMatch = () => Promise.resolve(d().match || null);
export const getScoreboard = () => Promise.resolve(d().scoreboard || []);
export const getRoundClasses = () => Promise.resolve(d().classes || []);
export const getTeamNames = () => Promise.resolve(d().teams || null);
export const errText = (e) => (e == null ? 'unknown error' : String((e && e.message) || e));
`,
);

for (const name of ['EventFlags', 'ProfileLink', 'RoundStrip']) {
  const src = readFileSync(`src/lib/components/${name}.svelte`, 'utf8').replace(
    // RoundStrip's generated kvstore binding path is written for
    // src/lib/components/ — at dir/components/ it would escape the cache.
    "from '../../../bindings/github.com/wailsapp/wails/v3/pkg/services/kvstore'",
    "from '../kvstore.js'",
  );
  svelteCompile(src, `${name}.svelte`, join(dir, 'components', `${name}.js`));
}

// RoundDetail.svelte → its ../ imports land in dir/ (services.js above,
// fmt/nav/rounds/sideparity/teams/players/router/replay-landmarks are
// copied there); only the .svelte component imports need rewriting to
// their compiled .js.
const rdSrc = readFileSync('src/lib/views/RoundDetail.svelte', 'utf8').replace(
  /from '\.\.\/components\/(\w+)\.svelte'/g,
  "from '../components/$1.js'",
);
svelteCompile(rdSrc, 'RoundDetail.svelte', join(dir, 'views', 'RoundDetail.js'));

const harnessSrc = `<script>
  import RoundDetail from './views/RoundDetail.js';
</script>
<RoundDetail
  id={3}
  round={globalThis.__round}
  query={{ back: 'match/3' }}
  nav={(h) => (globalThis.__nav = (globalThis.__nav || []).concat(h))}
/>`;
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

// mount renders into a fresh target; each scenario remounts after
// replacing the scripted data.
async function render(data, round) {
  globalThis.__roundDetail = data;
  globalThis.__round = round;
  globalThis.__nav = [];
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

// --- Fixture ---------------------------------------------------------------
// sideSwitches 1 with 15 COUNTED rounds → the flip lands after counted
// index 12 (round 13): rounds 1-12 are era 0, 13-15 era 1 (sideparity's
// cadence). So in round 5 the team that FINISHED ct played t, and the
// team that played ct finished t — the era-aware resolution must flip
// names there while round 15 (last era) reads straight.
const TEAM = { ct: 'Alpha', t: 'Bravo' };
const ROUNDS = [];
for (let n = 1; n <= 15; n++) {
  ROUNDS.push({
    number: n,
    winner: n % 2 === 1 ? 'ct' : 't',
    reason: n === 5 ? 'target bombed' : 'bomb defused',
    durationS: 105,
    warmup: false,
    pregame: false,
    bombSite: 'A',
    startTick: (n - 1) * 2000,
    endTick: n * 2000 - 1,
  });
}
const roundRow = (n) => ROUNDS.find((r) => r.number === n);
const detailFor = (n, extra = {}) => ({
  round: {
    ...roundRow(n),
    mvp: '76561198012345678',
    mvpName: 'donk',
    mvpReason: 'killed 3',
    equipCT: 4200,
    equipT: 3800,
    kills: 5,
    firstKillSteam: '76561198012345678',
    firstKillName: 'donk',
    firstDeathSteam: '76561198012345679',
    firstDeathName: 'zweih',
    freezeEndTick: (n - 1) * 2000 + 1500,
    ...extra,
  },
  economy: [
    { round: n, side: 'ct', equipValue: 4200, moneySampledSum: 16000, moneySamples: 4 },
    { round: n, side: 't', equipValue: 3800, moneySampledSum: 12000, moneySamples: 4 },
  ],
  events: [
    { id: 1, seq: 1, tick: (n - 1) * 2000 + 100, round: n, kind: 'kill', attacker: '76561198012345678', attackerName: 'donk', victim: '76561198012345679', victimName: 'zweih', weapon: 'ak47', headshot: true },
    { id: 2, seq: 2, tick: (n - 1) * 2000 + 900, round: n, kind: 'kill', attacker: '76561198012345679', attackerName: 'zweih', victim: '76561198012345678', victimName: 'donk', weapon: 'awp' },
    // The plant records NO actor (the bomb entity) — its ▶ must stamp no
    // follow; the defuse records its defuser — its ▶ must stamp one.
    { id: 3, seq: 3, tick: (n - 1) * 2000 + 1200, round: n, kind: 'bomb_plant', attacker: '', attackerName: '', site: 'A' },
    { id: 4, seq: 4, tick: (n - 1) * 2000 + 1500, round: n, kind: 'bomb_defuse', attacker: '76561198012345679', attackerName: 'zweih', site: 'A' },
  ],
  chat: [],
  ...extra,
});
const base = {
  details: { 5: detailFor(5), 15: detailFor(15) },
  rounds: ROUNDS,
  match: { tickRate: 64, sideSwitches: 1 },
  scoreboard: [
    { steamId: '76561198012345678', name: 'donk', side: 'ct' },
    { steamId: '76561198012345679', name: 'zweih', side: 't' },
  ],
  classes: [
    { round: 5, label: 'full', confidence: 0.9, ruleVersion: 1, explanation: 'both teams full buy' },
    { round: 15, label: 'force', confidence: 0.8, ruleVersion: 1, explanation: 'force buy' },
  ],
  teams: TEAM,
};

console.log('A. header keeps ONLY the named fields (reason/kills/start–stop/winner chip/equip cut)');
const root = await render(base, 5);
const header = root.querySelector('header.view-header');
check('header rendered', !!header);
const htext = header?.textContent || '';
check('round label kept', htext.includes('Round 5'), htext.slice(0, 160));
check('duration kept', htext.includes('1m45s'), htext.slice(0, 200));
check('bomb site kept', htext.includes('site A'), htext.slice(0, 200));
check('MVP name + reason kept', htext.includes('donk') && htext.includes('(killed 3)'), htext.slice(0, 240));
check('classification chip kept', !!header?.querySelector('h1 .chip.cmp-class'), htext.slice(0, 200));
// Buy-class chips wear the shared palette: the RAW label is the palette
// key (fixture round 5 → `full`) carried as a class, so
// style-m3a.css's `.cmp-class.full` (0,2,0) paints it.
const rdChip = header?.querySelector('h1 .chip.cmp-class');
check(
  'classification chip carries the RAW palette key as a class',
  !!rdChip && rdChip.classList.contains('full') && rdChip.textContent.trim() === 'full',
  rdChip ? rdChip.className : 'missing',
);
check(
  'classification chip keeps its explanation + rules-version + confidence tooltip',
  rdChip?.getAttribute('title') === 'both teams full buy (rules v1 — 90% sure)',
  rdChip?.getAttribute('title'),
);
check('reason CUT from the header', !htext.includes('target bombed'), htext.slice(0, 240));
check('kill count CUT from the header', !/5 kills/.test(htext), htext.slice(0, 240));
check('start/stop seconds CUT from the header', !htext.includes('125.0s') && !htext.includes('156.2s'), htext.slice(0, 240));
check('equip pair CUT from the header', !htext.includes('4200') && !htext.includes('3800'), htext.slice(0, 240));
check('winner chip CUT from the <h1>', !header?.querySelector('h1 .chip.side'), (header?.querySelector('h1') || {}).outerHTML);
// The cuts live in their CARDS, not the view: reason + score + first kill
// in Round result, equip in the Economy card.
const result = sections(root, 'Round result')[0];
check('Round result card still carries the reason', result?.textContent.includes('target bombed'), result?.textContent.slice(0, 200));
check('Economy card still carries equip', sections(root, 'Economy')[0]?.textContent.includes('4200'), '');

console.log('B. "Events in Replay" is gone; every tick link is an icon-only play (follow where a row has an actor)');
check('no Events-in-Replay button', !/Events in Replay/.test(root.textContent), root.querySelector('header')?.textContent.slice(0, 200));
check('no landmark-feed filter button anywhere', !/landmark feed/.test(root.textContent), '');
const headerBtns = [...(header?.querySelectorAll('button') || [])];
const watch = headerBtns.find((b) => (b.getAttribute('title') || '').startsWith('Watch round 5'));
check('Watch round present (found by TITLE — it has no visible text now)', !!watch);
check('Watch round is icon-only', !!watch && watch.textContent.trim() === '', watch?.textContent);
check('Watch round carries the canonical play glyph', !!watch?.querySelector('.codicon-play'), watch?.innerHTML);
check(
  'Watch round has an aria-label',
  watch?.getAttribute('aria-label') === 'Watch round 5',
  watch?.getAttribute('aria-label'),
);
click(watch);
await sleep();
const navWatch = (globalThis.__nav || []).at(-1);
check(
  'Watch round stamps the round tick + span loop, no filter, NO follow (round-level)',
  !!navWatch &&
    navWatch.includes('tick=8000') &&
    navWatch.includes('loop=8000,9999') &&
    !navWatch.includes('roundFrom') &&
    !navWatch.includes('cat=') &&
    !navWatch.includes('follow='),
  navWatch || 'no navigation',
);
// Round-span EQUALITY pin (watch-audit): the stamped loop is exactly
// nav.entryLoopSpan(round.startTick, round.endTick) — the canonical
// round-level stamper CompareRounds' "Replay start" uses TOO (its driver
// pins the same helper with its own fixture), so the two round-level
// buttons cannot drift apart. The fixture's round 5 spans 8000→9999 and
// its freeze ends at 9500: the loop covers the WHOLE round INCLUDING the
// freeze (it starts at startTick, never at freezeEndTick) — the round IS
// the sequence (owner's watch rule).
const { entryLoopSpan } = await import('../src/lib/nav.js');
check(
  "Watch round loop = nav.entryLoopSpan(startTick, endTick) — the ONE round-level stamper",
  !!navWatch && navWatch.includes('loop=' + entryLoopSpan(roundRow(5).startTick, roundRow(5).endTick)),
  navWatch || 'no navigation',
);
check(
  'the round span starts at the round start (freeze INCLUDED, not skipped to freezeEnd)',
  !!navWatch && navWatch.includes('loop=8000,') && !navWatch.includes('loop=9500'),
  navWatch || 'no navigation',
);
// Cross-view source pin: CompareRounds' round-level button stamps the
// SAME helper over the SAME bounds (the equality half lives in the
// compare-rounds driver for the other direction).
const cmpSrc = readFileSync('src/lib/views/CompareRounds.svelte', 'utf8');
check(
  'CompareRounds "Replay start" uses the same entryLoopSpan(start, end) (round-span equality)',
  cmpSrc.includes('loop: entryLoopSpan(start, end)'),
  'replayStart no longer stamps entryLoopSpan(start, end)',
);
const killBtn = [...root.querySelectorAll('button')].find((b) =>
  (b.getAttribute('title') || '').startsWith('Watch from this kill — follow'),
);
check('kill-feed ▶ rows kept, icon-only, follow-aware title', !!killBtn && killBtn.textContent.trim() === '' && !!killBtn.querySelector('.codicon-play'), killBtn?.getAttribute('title'));
check(
  'kill ▶ title names the KILLER it follows',
  killBtn?.getAttribute('title') === 'Watch from this kill — follow donk (killer)',
  killBtn?.getAttribute('title'),
);
click(killBtn);
await sleep();
const navKill = (globalThis.__nav || []).at(-1);
check(
  'kill ▶ seeks with a ±10 s loop AND follows the killer, no filter',
  !!navKill &&
    navKill.includes('tick=8100') &&
    navKill.includes('loop=7460,8740') &&
    navKill.includes('follow=76561198012345678') &&
    !navKill.includes('cat='),
  navKill || 'no navigation',
);
// Bomb rows: the plant records no actor (the bomb entity) → no follow;
// the defuse records its defuser → follow.
const bombSection = sections(root, 'Bomb')[0];
const bombBtns = [...(bombSection?.querySelectorAll('tbody button') || [])];
const plantBtn = bombBtns.find((b) => b.getAttribute('title') === 'Watch this bomb event in the replay');
check('bomb plant (actor-less) keeps the neutral title + no follow claim', !!plantBtn, bombBtns.map((b) => b.getAttribute('title')).join(' | '));
click(plantBtn);
await sleep();
const navPlant = (globalThis.__nav || []).at(-1);
check('bomb plant ▶ seeks with NO follow', !!navPlant && navPlant.includes('tick=9200') && !navPlant.includes('follow='), navPlant || 'no navigation');
const defuseBtn = bombBtns.find((b) => (b.getAttribute('title') || '').startsWith('Watch this bomb event — follow'));
check('bomb defuse ▶ names the defuser it follows', defuseBtn?.getAttribute('title') === 'Watch this bomb event — follow zweih (defuser)', defuseBtn?.getAttribute('title'));
click(defuseBtn);
await sleep();
const navDefuse = (globalThis.__nav || []).at(-1);
check('bomb defuse ▶ seeks AND follows the defuser', !!navDefuse && navDefuse.includes('tick=9500') && navDefuse.includes('follow=76561198012345679'), navDefuse || 'no navigation');

console.log('C. ribbon: centered row, icon-only chevron transport');
const nav2 = root.querySelector('.round-nav');
check('.round-nav rendered', !!nav2);
const css = readFileSync('public/style.css', 'utf8');
const rnBlock = (css.match(/\.round-nav\s*\{[^}]*\}/) || [''])[0];
check('.round-nav carries justify-content: center', rnBlock.includes('justify-content: center'), rnBlock);
check(
  'centering NOT moved onto the shared .round-strip-wrap rule',
  !(/\.round-strip-wrap\s*\{[^}]*justify-content/.test(css)),
  '',
);
check(
  'the shared .view/.rp-ribbon centering rule untouched',
  /\.view > \.round-strip-wrap,\s*\.rp-ribbon > \.round-strip-wrap\s*\{\s*margin-inline: auto;/.test(css),
  '',
);
const strip = nav2?.querySelector('.round-strip');
check('ribbon strip renders', !!strip && strip.querySelectorAll('.round-cell').length === 15, String(strip?.querySelectorAll('.round-cell').length));
check('current round highlighted', !!nav2?.querySelector('.round-cell[aria-current="true"][title^="Round 5"]'), '');
const prev = nav2?.querySelector('button[title="Previous round"]');
const next = nav2?.querySelector('button[title="Next round"]');
check('prev/next present with transport titles', !!prev && !!next);
check('prev is icon-only (no text label)', !!prev && prev.textContent.trim() === '', prev?.textContent);
check('next is icon-only (no text label)', !!next && next.textContent.trim() === '', next?.textContent);
check('prev uses the chevron glyph', !!prev?.querySelector('.codicon-chevron-left'), prev?.outerHTML);
check('next uses the chevron glyph', !!next?.querySelector('.codicon-chevron-right'), next?.outerHTML);
check('no arrow-* glyph on the round transport', !prev?.querySelector('[class*="codicon-arrow-"]') && !next?.querySelector('[class*="codicon-arrow-"]'), '');
check('prev/next carry aria-labels', prev?.getAttribute('aria-label') === 'Previous round' && next?.getAttribute('aria-label') === 'Next round');
click(prev);
await sleep();
check('prev navigates to round 4 keeping ?back=', (globalThis.__nav || []).at(-1) === '/match/3/round/4?back=match/3', JSON.stringify(globalThis.__nav));

console.log('D. economy card side column = era-aware team names (round 5, era 0)');
const ecoRows = [...(sections(root, 'Economy')[0]?.querySelectorAll('tbody tr') || [])];
check('two economy rows', ecoRows.length === 2, String(ecoRows.length));
const ecoCells = ecoRows.map((r) => r.querySelector('td .chip'));
check(
  'round-5 ct/t chips name the teams that PLAYED those sides (final-side flip)',
  ecoCells[0]?.textContent === 'Bravo' && ecoCells[1]?.textContent === 'Alpha',
  ecoCells.map((c) => c?.textContent).join(','),
);
check('chips keep their SIDE color classes', ecoCells[0]?.className.includes('side ct') && ecoCells[1]?.className.includes('side t'), ecoCells[0]?.className);

console.log('E. Round result winner = the team that WON the round (era-aware)');
const winnerDd = result?.querySelector('dl.facts div dd .chip');
check('result card shows a team name', winnerDd?.textContent === 'Bravo', winnerDd?.textContent);
check('never the final-side-keyed team for this round', winnerDd?.textContent !== 'Alpha', winnerDd?.textContent);

document.body.removeChild(root);

console.log('F. post-switch round (era 1, sideSwitches 1): the OTHER resolution');
const root2 = await render(base, 15);
const result2 = sections(root2, 'Round result')[0];
const winner2 = result2?.querySelector('dl.facts div dd .chip');
check(
  'round 15 winner ct → the team that finished ct (last era reads straight)',
  winner2?.textContent === 'Alpha',
  winner2?.textContent,
);
const ecoRows2 = [...(sections(root2, 'Economy')[0]?.querySelectorAll('tbody tr') || [])];
const eco2 = ecoRows2.map((r) => r.querySelector('td .chip')?.textContent);
check('round 15 economy names straight through', eco2[0] === 'Alpha' && eco2[1] === 'Bravo', eco2.join(','));
check('header label for round 15', /Round 15/.test(root2.querySelector('header.view-header')?.textContent || ''), '');
const prev2 = root2.querySelector('.round-nav button[title="Previous round"]');
check(
  'round 15 is the last row → prev offered, next gone (index walk, not ±1)',
  !!prev2 && !root2.querySelector('.round-nav button[title="Next round"]'),
  JSON.stringify([!!prev2, !!root2.querySelector('.round-nav button[title="Next round"]')]),
);

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
