// jsdom driver for Utility: the damage bars' design-language channels
// (COLOR = the side each team held IN THAT round via sideparity.sideAtRound,
// with the era flip visible across the halftime switch; PATTERN = team
// identity — one team's rects carry the SVG stripe overlay and its legend
// dot the CSS twin), the owner's zero → em-dash rule (damage / affected /
// group-header summary read "—" at 0 while the toolbar's row counts stay
// numeric and the Flash-effectiveness card stays out of scope), the
// coordinate carve-out (dashes only when BOTH components are 0), the dead
// site column's removal (markup + CSS), the retired events button and the
// icon-only throw ▶ (tick + ±10 s loop + the thrower as the camera
// follow — never a filter).
//
// jsdom is a declared devDependency; from frontend/ run:
//   node --test test/utility.dom.mjs
// (must be run with frontend/ as the working directory; the same file also
// runs under `node --conditions browser test/utility.dom.mjs` — it pins the
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

const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'utility');
mkdirSync(join(dir, 'replay'), { recursive: true });
mkdirSync(join(dir, 'components'), { recursive: true });
mkdirSync(join(dir, 'views'), { recursive: true });

const svelteCompile = (src, filename, out) => {
  writeFileSync(out, compile(src, { filename, generate: 'client' }).js.code);
};

// Plain-ESM deps copied verbatim with their relative layout intact
// (fmt → rounds; nav → router + replay/landmarks → rounds/fmt/teams;
// teams → sideparity; landmarks → rounds/fmt/teams) — the same copy the
// combat / round-detail drivers do. viewstate.svelte.js is Utility's
// view-state registry (match-scoped seed/remember — see its header;
// plain JS, copied raw).
for (const rel of [
  'rounds.js', 'sideparity.js', 'router.js', 'nav.js', 'teams.js',
  'fmt.js', 'players.js', 'viewstate.svelte.js',
]) {
  writeFileSync(join(dir, rel), readFileSync(join('src/lib', rel), 'utf8'));
}
writeFileSync(
  join(dir, 'replay', 'landmarks.js'),
  readFileSync('src/lib/replay/landmarks.js', 'utf8'),
);

// The view's data source is scripted, never a live Wails backend: the
// driver sets globalThis.__utility before each mount.
writeFileSync(
  join(dir, 'services.js'),
  `const d = () => globalThis.__utility || {};
export const getUtility = () => Promise.resolve(d().rows || []);
export const getRounds = () => Promise.resolve(d().rounds || []);
export const getScoreboard = () => Promise.resolve(d().scoreboard || []);
export const getMatch = () => Promise.resolve(d().match || null);
export const getTeamNames = () => Promise.resolve(d().teams || null);
export const errText = (e) => (e == null ? 'unknown error' : String((e && e.message) || e));
export const warmProfile = () => {};
`,
);

for (const name of ['ProfileLink']) {
  svelteCompile(
    readFileSync(`src/lib/components/${name}.svelte`, 'utf8'),
    `${name}.svelte`,
    join(dir, 'components', `${name}.js`),
  );
}

// Utility.svelte → its ../ imports land in dir/ (services.js above,
// fmt/nav/rounds/sideparity/teams/players/replay-landmarks are copied
// there); only the .svelte component imports need rewriting to their
// compiled .js.
const utilSrc = readFileSync('src/lib/views/Utility.svelte', 'utf8').replace(
  /from '\.\.\/components\/(\w+)\.svelte'/g,
  "from '../components/$1.js'",
);
svelteCompile(utilSrc, 'Utility.svelte', join(dir, 'views', 'Utility.js'));

const harnessSrc = `<script>
  import Utility from './views/Utility.js';
</script>
<Utility id={3} nav={(h) => (globalThis.__nav = (globalThis.__nav || []).concat(h))} />`;
const harnessOut = join(dir, 'harness.js');
svelteCompile(harnessSrc, 'harness.svelte', harnessOut);

const { mount, unmount } = await import('svelte');
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

// --- Fixture ----------------------------------------------------------------
// 13 counted rounds, sideSwitches=1 → the switch lands AFTER round 12, so
// round 1 is era 0 (Alpha, the final-CT team, played T) and round 13 is
// era 1 (sides back to the final sides) — the era flip the bar colors
// must show. carol throws nothing (the toolbar's 0-match case).
const rounds = Array.from({ length: 13 }, (_, i) => ({
  number: i + 1,
  warmup: false,
  pregame: false,
  winner: 'ct',
  reason: 'CTWin',
  startTick: i * 2000,
  endTick: (i + 1) * 2000 - 500,
  freezeEndTick: i * 2000 + 160,
}));
const scoreboard = [
  { steamId: 'A', name: 'alice', side: 'ct', kills: 1 },
  { steamId: 'B', name: 'bob', side: 't', kills: 1 },
  { steamId: 'C', name: 'carol', side: 'ct', kills: 1 },
];
// UtilityEvent rows (models.UtilityEvent): `site` is carried on purpose —
// the extractor never writes it and the column is retired, so the field
// must be IGNORED (no .util-site cell renders).
const rows = [
  // round 1 — era 0: Alpha (final CT) on T, Beta (final T) on CT.
  { seq: 1, tick: 1500, round: 1, thrower: 'A', throwerName: 'alice', kind: 'he', detX: 5, detY: 12, damage: 40, flashMsTotal: 0, affected: '["B"]', site: 'A' },
  // zero damage + zero affected + the both-zero coordinate carve-out.
  { seq: 2, tick: 2000, round: 1, thrower: 'A', throwerName: 'alice', kind: 'he', detX: 0, detY: 0, damage: 0, flashMsTotal: 0, affected: '', site: 'A' },
  // flash row: blind time dashes are the precedent (kept), the FLASH card
  // is out of scope — it must stay NUMERIC even at 0 affected.
  { seq: 3, tick: 1700, round: 1, thrower: 'A', throwerName: 'alice', kind: 'flash', detX: 10, detY: 20, damage: 0, flashMsTotal: 1500, affected: '', site: '' },
  // round 13 — era 1: sides back to the final sides.
  { seq: 4, tick: 25500, round: 13, thrower: 'B', throwerName: 'bob', kind: 'smoke', detX: -100, detY: 300, damage: 30, flashMsTotal: 0, affected: '["A","B"]', site: '' },
];
const match = { id: 3, tickRate: 64, sideSwitches: 1 };
const teams = { ct: 'Alpha', t: 'Beta' };

let inst = null;
async function show() {
  if (inst) {
    unmount(inst);
    inst = null;
  }
  globalThis.__utility = { rows, rounds, scoreboard, match, teams };
  const target = document.createElement('div');
  document.body.appendChild(target);
  inst = mount(mod.default, { target });
  await sleep();
  return target;
}

const root = await show();
const $ = (sel) => root.querySelector(sel);
const $$ = (sel) => [...root.querySelectorAll(sel)];
const titleOf = (rect) => rect.querySelector('title')?.textContent || '';
// SVG elements expose className as SVGAnimatedString, not a string.
const cls = (el) => (el ? el.getAttribute('class') || '' : '');

console.log('A. damage bars: COLOR = side at that round (era flip across halftime)');
const bars = $$('.util-bar');
check('two rounds × two team bars = 4 rects', bars.length === 4, String(bars.length));
const byTitle = (needle) => bars.find((r) => titleOf(r).includes(needle));
const alpha1 = byTitle('Round 1 — Alpha');
const beta1 = byTitle('Round 1 — Beta');
const alpha13 = byTitle('Round 13 — Alpha');
const beta13 = byTitle('Round 13 — Beta');
check('all four bars located by their titles', !!alpha1 && !!beta1 && !!alpha13 && !!beta13);
// Era 0 (rounds 1-12): the final-CT team played T, the final-T team CT.
check(
  'round 1: Alpha (final CT) hue = side-t, Beta = side-ct',
  alpha1?.classList.contains('side-t') && !alpha1.classList.contains('side-ct') &&
    beta1?.classList.contains('side-ct') && !beta1.classList.contains('side-t'),
  `alpha1=${cls(alpha1)} beta1=${cls(beta1)}`,
);
// Era 1 (round 13): sides are back to the final sides — the SAME two
// teams swapped hues, which is the era flip the color channel must show.
check(
  'round 13: Alpha hue = side-ct, Beta = side-t (the flip)',
  alpha13?.classList.contains('side-ct') && beta13?.classList.contains('side-t'),
  `alpha13=${cls(alpha13)} beta13=${cls(beta13)}`,
);
check(
  'no team-identity class left on the bars (identity moved to the pattern)',
  bars.every((r) => !cls(r).includes('team-start')),
  bars.map(cls).join(' | '),
);

console.log('B. damage bars: PATTERN = team identity (stripe overlay + defs)');
const pattern = $('#util-stripe');
check('the SVG <pattern> def exists', !!pattern);
check(
  'patternUnits="userSpaceOnUse" (tile in bar units despite the viewBox stretch)',
  pattern?.getAttribute('patternUnits') === 'userSpaceOnUse',
  pattern?.getAttribute('patternUnits') || 'missing',
);
const stripes = $$('.util-bar-stripe');
check('the striped team (final T) gets one overlay per slot = 2', stripes.length === 2, String(stripes.length));
check(
  'every overlay fills url(#util-stripe)',
  stripes.every((s) => s.getAttribute('fill') === 'url(#util-stripe)'),
  stripes.map((s) => s.getAttribute('fill')).join(','),
);
check(
  "each overlay sits exactly on the Beta (final-T) bar of its slot",
  stripes.every((s, i) => s.getAttribute('x') === [beta1, beta13][i]?.getAttribute('x') &&
    s.getAttribute('width') === [beta1, beta13][i]?.getAttribute('width')),
  stripes.map((s) => s.getAttribute('x')).join(',') + ' vs ' + [beta1, beta13].map((b) => b?.getAttribute('x')).join(','),
);
check(
  'overlays are click-through (the bar <title> tooltip stays reachable)',
  stripes.every((s) => s.getAttribute('pointer-events') === 'none'),
);

console.log('C. legend: identity-colored dots, the striped team carries the stripe');
const dots = $$('.util-dot');
check('two legend dots', dots.length === 2, String(dots.length));
check(
  'both dots keep the team-identity classes',
  dots.every((d) => d.className.includes('team-start-')),
  dots.map((d) => d.className).join(' | '),
);
check(
  'Alpha (solid) not striped, Beta (striped team) striped',
  dots[0] && !dots[0].classList.contains('striped') && dots[1]?.classList.contains('striped'),
  dots.map((d) => d.className).join(' | '),
);
check(
  'legend labels stay plain text (no patterned text)',
  !$('.util-legend').querySelector('u, s, strike, del'),
);

console.log('D. zero → em dash: damage / affected / group headers (value cells only)');
const nadeCells = (sel) => $$('.util-nade ' + sel).map((el) => el.textContent.trim());
const dmgCells = nadeCells('[title="damage dealt"]');
const affCells = nadeCells('[title^="affected players"]');
check(
  'damage cells: "40 dmg"/"30 dmg" stay, 0s read —',
  JSON.stringify(dmgCells) === JSON.stringify(['40 dmg', '—', '—', '30 dmg']),
  JSON.stringify(dmgCells),
);
check(
  'affected cells: 1 aff / 2 aff stay, 0s read —',
  JSON.stringify(affCells) === JSON.stringify(['1 aff', '—', '—', '2 aff']),
  JSON.stringify(affCells),
);
const headers = $$('.util-group-head .mono').map((el) => el.textContent.trim());
check(
  'group header summary applies the helper (… · Beta — dmg / Alpha — · …)',
  JSON.stringify(headers) === JSON.stringify(['Alpha 40 · Beta — dmg', 'Alpha — · Beta 30 dmg']),
  JSON.stringify(headers),
);
check(
  'the blind-time precedent still dashes its own 0s',
  nadeCells('[title="total blind time"]').some((t) => t === '—') &&
    nadeCells('[title="total blind time"]').includes('1.5s'),
  JSON.stringify(nadeCells('[title="total blind time"]')),
);
// The Flash-effectiveness card is OUT of scope (a summary card, not a
// table): its counts stay numeric even at zero.
const flashText = [...root.querySelectorAll('.util-flash-cell')].map((c) => c.textContent);
check(
  'flash card stays numeric at 0 affected (out of scope, by the owner)',
  flashText.some((t) => t.includes('0 affected')) && flashText.every((t) => !t.includes('— affected')),
  flashText.join(' | '),
);

console.log('E. coordinates: dash ONLY when both components are 0');
const coords = nadeCells('.util-coord');
check(
  'coordinates (5, 12) / (10, 20) / (-100, 300) render, (0, 0) dashes',
  JSON.stringify(coords) === JSON.stringify(['(5, 12)', '—', '(10, 20)', '(-100, 300)']),
  JSON.stringify(coords),
);

console.log('F. the dead site column is gone (markup + CSS)');
check('no .util-site cell renders (the fixture even carries site values)', !$('.util-site'));
check(
  'no button says "events" (retired with "buttons seek, never filter")',
  !$$('button').some((b) => /events/i.test(b.textContent)),
  $$('button').map((b) => b.textContent.trim()).join(' | '),
);
check(
  'the throw ▶ is still there — icon-only play (its "replay" label text is gone)',
  !!$$('.util-actions button').length &&
    $$('.util-actions button').every(
      (b) => b.textContent.trim() === '' && !!b.querySelector('.codicon-play'),
    ) &&
    $$('.util-actions button').every((b) => (b.getAttribute('title') || '').startsWith('Watch this throw')),
  $$('.util-actions button').map((b) => `${b.textContent.trim()}[${b.getAttribute('title')}]`).join(' | '),
);

console.log("G1. the throw ▶ seeks + follows the THROWER (icon-only, no filter)");
const throwBtn = $('.util-nade .util-actions button');
check('a throw ▶ rendered', !!throwBtn, 'no .util-actions button');
check(
  'throw ▶ icon-only play with the follow-aware title',
  !!throwBtn && throwBtn.textContent.trim() === '' && !!throwBtn.querySelector('.codicon-play') &&
    throwBtn.getAttribute('title') === 'Watch this throw — follow alice',
  throwBtn?.getAttribute('title'),
);
check(
  'throw ▶ carries an aria-label with the tick + follow',
  throwBtn?.getAttribute('aria-label') === 'Watch this throw at tick 1500 — follow alice',
  throwBtn?.getAttribute('aria-label'),
);
throwBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
await sleep();
const navThrow = (globalThis.__nav || [])[(globalThis.__nav || []).length - 1];
check(
  'throw ▶ stamps tick + ±10 s loop + follow=thrower, no filter',
  !!navThrow &&
    navThrow.includes('tick=1500') &&
    navThrow.includes('loop=860,2140') &&
    navThrow.includes('follow=A') &&
    !navThrow.includes('cat=') &&
    !navThrow.includes('roundFrom'),
  navThrow || 'no navigation',
);

console.log('G. toolbar counts stay NUMERIC when nothing matches (the table’s N)');
const before = $('.util-filters .muted')?.textContent.trim();
check('initially "4 of 4 grenades"', /^4 of 4 grenades$/.test(before || ''), before || 'missing');
const throwerSel = $('#util-thrower');
throwerSel.value = 'C'; // carol threw nothing
throwerSel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await sleep();
const after = $('.util-filters .muted')?.textContent.trim();
check(
  'filtered to 0 matches → "0 of 4 grenades" (0 NOT dashed)',
  /^0 of 4 grenades$/.test(after || ''),
  after || 'missing',
);

console.log('H. stylesheet pins (jsdom has no layout — the rules are the pins)');
const css = readFileSync('public/style-m3a.css', 'utf8');
const ruleBody = (sel) => {
  const i = css.indexOf(sel);
  if (i < 0) return null;
  const open = css.indexOf('{', i);
  if (open < 0) return null;
  const close = css.indexOf('}', open);
  return close < 0 ? null : css.slice(open + 1, close);
};
check(
  '.util-bar.side-ct/.side-t fill the side tokens (the color channel)',
  /fill:\s*var\(--ct\)/.test(ruleBody('.util-bar.side-ct {') || '') &&
    /fill:\s*var\(--t\)/.test(ruleBody('.util-bar.side-t {') || ''),
  'side-color fill rules missing',
);
check(
  '.util-bar stays neutral (the unresolvable-round fallback)',
  /fill:\s*var\(--muted\)/.test(ruleBody('.util-bar {') || ''),
  'neutral fallback missing',
);
check(
  'the legend stripe is the CSS twin of the SVG pattern (shared token)',
  /repeating-linear-gradient/.test(ruleBody('.util-dot.striped {') || '') &&
    /--util-stripe/.test(ruleBody('.util-dot.striped {') || '') &&
    /--util-stripe:\s*rgba\(14, 17, 22, 0\.45\)/.test(ruleBody('.util-view {') || ''),
  'stripe twin / token missing',
);
check(
  'the .util-site rule and the 44px grid track are gone',
  !css.includes('.util-site') &&
    !/44px/.test(ruleBody('.util-nade {') || ''),
  ruleBody('.util-nade {') || 'no .util-nade rule',
);

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
if (inst) unmount(inst);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
