// jsdom driver for Utility: the damage bars' design-language channels
// (COLOR = the side each team held IN THAT round via sideparity.sideAtRound,
// with the era flip visible across the halftime switch; PATTERN = team
// identity — one team's rects carry the SVG stripe overlay and its legend
// dot the CSS twin), the blind-time chart's TWIN channels and its honest
// label (C8), the owner's zero → em-dash rule (damage / affected / blind
// time read "—" at 0 while the throw-log count stays numeric), the
// coordinate carve-out (dashes only when BOTH components are 0), the dead
// site column's removal (markup + CSS), the retired events button, the
// icon-only throw ▶ (tick + the loop-length loop — the `loop_secs` pref,
// default 5 s — + the thrower as the camera follow — never a filter), the
// C9 hint-line removal, and the C7 consolidation: ONE bottom card
// carrying the filters + count, with the round scope in ONE <select> that
// preselects the first round with throws and offers "All rounds" (owner
// answer Q1, 2026-11-16 — it replaced the per-round toggle row) whose
// throw lists render for exactly the round(s) in scope.
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
// __utilityError (section I) makes the data read REJECT — the load-failure
// path the dismissible alert is pinned against; unset it for plain reads.
export const getUtility = () =>
  globalThis.__utilityError
    ? Promise.reject(new Error(globalThis.__utilityError))
    : Promise.resolve(d().rows || []);
export const getRounds = () => Promise.resolve(d().rounds || []);
export const getScoreboard = () => Promise.resolve(d().scoreboard || []);
export const getMatch = () => Promise.resolve(d().match || null);
export const getTeamNames = () => Promise.resolve(d().teams || null);
// The one pref read at mount (the loop length) — unset, so the view
// seeds LOOP_SECS_DEFAULT; a link-level getPref is a link error without.
export const getPref = () => Promise.resolve(undefined);
export const errText = (e) => (e == null ? 'unknown error' : String((e && e.message) || e));
export const warmProfile = () => {};
`,
);

for (const name of ['ProfileLink', 'StatusChip']) {
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
const utilSrc = readFileSync('src/lib/views/Utility.svelte', 'utf8')
  .replace(
    /from '\.\.\/components\/(\w+)\.svelte'/g,
    "from '../components/$1.js'",
  )
  // plumbing (Strings Stage 3): the view imports the strings catalog —
  // resolve it from the real tree, like every other ../ module here.
  .replace(
    "from '../strings/index.js'",
    `from '${pathToFileURL('src/lib/strings/index.js').href}'`,
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
// The view-state registry Utility links (the copied file → same
// instance): reset in EVERY mount's setup — the jsdom cross-talk rule in
// viewstate.svelte.js' header. The kind/thrower filters and the round
// scope are registry state, so a fresh mount must never inherit an
// earlier section's filter or round choice (and the preselect the Q1
// pins rest on is only pristine after a reset).
const viewstate = await import(pathToFileURL(join(dir, 'viewstate.svelte.js')).href);

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
// must show. carol throws nothing (the throw-log count's 0-match case).
const rounds = Array.from({ length: 13 }, (_, i) => ({
  number: i + 1,
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
  // flash row: blind time dashes are the precedent (kept); its 1500 ms is
  // also the ONE non-zero value behind the blind-time chart (section K).
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
  viewstate.resetViewState();
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
// Scoped to the damage card: the blind-time chart (C8) carries its own
// .util-bar rects and .util-dot legend, addressed in its own section.
const bars = $$('.util-card-damage .util-bar');
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
// The bar title is one SVG <title> text node; Svelte drops a whitespace-
// only text node between expressions inside SVG, so the team↔value space
// is expression-borne ({" "}) — without it the tooltip reads "Alpha40".
check(
  'bar titles keep the team↔value space ("Round 1 — Alpha 40 damage")',
  titleOf(alpha1) === 'Round 1 — Alpha 40 damage' &&
    titleOf(beta13) === 'Round 13 — Beta 30 damage',
  `${titleOf(alpha1)} | ${titleOf(beta13)}`,
);

console.log('B. damage bars: PATTERN = team identity (stripe overlay + defs)');
const pattern = $('.util-card-damage #util-stripe');
check('the SVG <pattern> def exists', !!pattern);
check(
  'patternUnits="userSpaceOnUse" (tile in bar units despite the viewBox stretch)',
  pattern?.getAttribute('patternUnits') === 'userSpaceOnUse',
  pattern?.getAttribute('patternUnits') || 'missing',
);
const stripes = $$('.util-card-damage .util-bar-stripe');
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
const dots = $$('.util-card-damage .util-dot');
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
  !$('.util-card-damage .util-legend').querySelector('u, s, strike, del'),
);

// --- C7: the consolidation ---------------------------------------------
// The view is now two summary charts on top and ONE throw-log card at the
// bottom carrying the filters, the count and the ONE round selector. This
// section pins the new chrome AND doubles as the preamble for every row
// check below: the selector preselects the first round with throws (the
// owner's Q1 answer), so the driver switches it to "All rounds" before
// E…K read every row.
console.log('D. C7 structure: ONE bottom card, filters + round selector inside, first throwing round preselected');
const setSel = async (el, value) => {
  el.value = value;
  el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await sleep();
};
const panels = $$('section.panel');
check(
  'exactly three panels: two summary charts + the throw log',
  panels.length === 3,
  panels.map((p) => p.className).join(' | '),
);
check(
  'the consolidated throw log is the LAST card of the view',
  panels[panels.length - 1]?.classList.contains('util-throwlog'),
  panels[panels.length - 1]?.className || 'no panels',
);
check(
  'the kind, thrower AND round selectors moved INTO the card',
  !!$('.util-throwlog #util-kind') && !!$('.util-throwlog #util-thrower') && !!$('.util-throwlog #util-round'),
);
check(
  'the live count rides with them (one .util-filters, inside the card)',
  $$('.util-filters').length === 1 && !!$('.util-throwlog .util-filters .muted'),
);
check(
  'the per-round group cards are gone (no .util-group / .util-groups)',
  !$('.util-group') && !$('.util-groups'),
);
const roundSel = $('#util-round');
check(
  'the round selector offers "All rounds" plus one option per round with throws, in the canonical RD | score labels',
  !!roundSel &&
    [...roundSel.options].map((o) => o.textContent.trim()).join(',') ===
      'All rounds,RD1 | 1-0,RD13 | 13-0',
  roundSel ? [...roundSel.options].map((o) => o.textContent.trim()).join(',') : 'no #util-round',
);
check(
  'it PRESELECTS the first round with throws (round 1 — the owner’s Q1 default)',
  roundSel?.value === '1',
  roundSel?.value || 'missing',
);
check(
  'the preselected round’s throws render (round 1 only: one list, three rows)',
  $$('.util-lists ul.util-nades').length === 1 && $$('.util-nade').length === 3,
  `${$$('.util-lists ul.util-nades').length} lists / ${$$('.util-nade').length} rows`,
);
// Preamble: switch to "All rounds" so the row-level checks below (E…K)
// have every row to read — the state the old always-open cards shipped
// with.
await setSel(roundSel, 'all');
check(
  '"All rounds" renders every throw (4 rows across 2 lists)',
  $$('.util-lists ul.util-nades').length === 2 && $$('.util-nade').length === 4,
  `${$$('.util-lists ul.util-nades').length} lists / ${$$('.util-nade').length} rows`,
);

console.log('E. zero → em dash: damage / affected / blind-time cells (value cells only)');
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
check(
  'the blind-time precedent still dashes its own 0s',
  nadeCells('[title="total blind time"]').some((t) => t === '—') &&
    nadeCells('[title="total blind time"]').includes('1.5s'),
  JSON.stringify(nadeCells('[title="total blind time"]')),
);

console.log('F. coordinates: dash ONLY when both components are 0');
const coords = nadeCells('.util-coord');
check(
  'coordinates (5, 12) / (10, 20) / (-100, 300) render, (0, 0) dashes',
  JSON.stringify(coords) === JSON.stringify(['(5, 12)', '—', '(10, 20)', '(-100, 300)']),
  JSON.stringify(coords),
);

console.log('G. the dead site column is gone (markup + CSS)');
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

console.log("H. the throw ▶ seeks + follows the THROWER (icon-only, no filter)");
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
  'throw ▶ stamps tick + the loop-length loop + follow=thrower, no filter',
  !!navThrow &&
    navThrow.includes('tick=1500') &&
    navThrow.includes('loop=1180,1820') &&
    navThrow.includes('follow=A') &&
    !navThrow.includes('cat=') &&
    !navThrow.includes('roundFrom'),
  navThrow || 'no navigation',
);

console.log('I. the throw-log count stays NUMERIC when nothing matches (the table’s N)');
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
// Restore the filter: sections K/L run over the full data set (and the
// count's own restore is a pin — the card must come back, not stick).
throwerSel.value = '';
throwerSel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await sleep();
check(
  'clearing the filter restores "4 of 4 grenades"',
  /^4 of 4 grenades$/.test($('.util-filters .muted')?.textContent.trim() || ''),
  $('.util-filters .muted')?.textContent.trim() || 'missing',
);

console.log('J. C9: the "▶ seeks to the throw" hint line is deleted');
check(
  'no hint text renders anywhere in the view',
  !root.textContent.includes('seeks to the throw'),
  root.textContent.replace(/\s+/g, ' ').slice(0, 160),
);
check('no .util-hint element is left', !$('.util-hint'));

// --- C8: the blind-time chart ------------------------------------------
// The flash-effectiveness totals card is gone; its replacement is the
// damage chart's comparative twin over the stored per-throw blind
// milliseconds — same geometry, same color/stripe channels, and an
// honest label (total blind time from this team's flashes, NOT an
// enemy-only figure).
console.log('K. C8: the blind-time chart replaces the flash-effectiveness card');
const blindCard = $('.util-card-blind');
check(
  'the card exists under its own heading',
  !!blindCard && blindCard.querySelector('h2')?.textContent.trim() === 'Blind time per round',
  blindCard ? blindCard.querySelector('h2')?.textContent.trim() : 'no card',
);
const fbars = $$('.util-card-blind .util-bar');
check(
  'one bar pair per round (4), every title carrying "blind time"',
  fbars.length === 4 && fbars.every((b) => titleOf(b).endsWith('blind time')),
  fbars.map((b) => titleOf(b)).join(' | '),
);
const fA1 = fbars.find((r) => titleOf(r).includes('Round 1 — Alpha'));
check(
  'the recorded flash renders its real duration (Round 1 — Alpha 1.5s blind time)',
  titleOf(fA1) === 'Round 1 — Alpha 1.5s blind time',
  titleOf(fA1) || 'not found',
);
check(
  'its bars carry the same era flip: round 1 Alpha = side-t, round 13 = side-ct',
  !!fA1?.classList.contains('side-t') &&
    !!fbars.find((r) => titleOf(r).includes('Round 13 — Alpha'))?.classList.contains('side-ct'),
  fA1 ? cls(fA1) : 'not found',
);
check(
  'its own pattern id — never a shared one',
  !!$('.util-card-blind #util-stripe-blind') && !!$('.util-card-damage #util-stripe'),
);
const fstripes = $$('.util-card-blind .util-bar-stripe');
check(
  'the striped team gets one overlay per slot = 2, filling ITS pattern',
  fstripes.length === 2 && fstripes.every((s) => s.getAttribute('fill') === 'url(#util-stripe-blind)'),
  fstripes.map((s) => s.getAttribute('fill')).join(','),
);
const fdots = $$('.util-card-blind .util-dot');
check(
  'legend: two identity dots + the inferred badge',
  fdots.length === 2 && fdots.every((d) => d.className.includes('team-start-')) &&
    !!$('.util-card-blind .badge-inferred'),
  fdots.map((d) => d.className).join(' | '),
);
const fmax = $('.util-card-blind .util-legend .muted');
check(
  'the legend states the honest label with its formula tooltip',
  (fmax?.getAttribute('title') || '').includes('total blind time from this team') &&
    (fmax?.textContent || '').includes('max 1.5s blind/round'),
  `${fmax?.getAttribute('title')} :: ${fmax?.textContent}`,
);
// Empty state: a filter with no flashes must say so instead of drawing a
// chart of zero-height bars — while the damage chart keeps drawing.
const kindSel = $('#util-kind');
kindSel.value = 'he';
kindSel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await sleep();
check(
  'no blind time in the filter → "No blind time…" while the damage chart still draws',
  ($('.util-card-blind')?.textContent || '').includes('No blind time in this selection.') &&
    $$('.util-card-damage .util-bar').length > 0,
  ($('.util-card-blind')?.textContent || '').replace(/\s+/g, ' ').slice(0, 120),
);
kindSel.value = '';
kindSel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await sleep();
check(
  'clearing the filter brings the chart back (4 bars)',
  $$('.util-card-blind .util-bar').length === 4,
  String($$('.util-card-blind .util-bar').length),
);

// --- C7, the lists half --------------------------------------------------
console.log('L. round scope: "All rounds" lists every round, one round narrows to it (one empty state)');
check(
  'All rounds → two lists, four rows',
  $$('.util-lists ul.util-nades').length === 2 && $$('.util-nade').length === 4,
  `${$$('.util-lists ul.util-nades').length} lists / ${$$('.util-nade').length} rows`,
);
await setSel(roundSel, '13');
check(
  'round 13 selected → only its list (one row) and the control reads the choice back',
  $$('.util-lists ul.util-nades').length === 1 &&
    $$('.util-nade').length === 1 &&
    roundSel.value === '13',
  `${$$('.util-lists ul.util-nades').length} lists / ${$$('.util-nade').length} rows / value=${roundSel.value}`,
);
await setSel(roundSel, '1');
check(
  'round 1 selected → its three rows',
  $$('.util-lists ul.util-nades').length === 1 && $$('.util-nade').length === 3,
  `${$$('.util-lists ul.util-nades').length} lists / ${$$('.util-nade').length} rows`,
);
// The ONE empty state: a filter matching nothing. The "turn on a round"
// line died with the per-round toggle row (owner answer Q1) — the
// selector's own option list only ever carries throwing rounds, so no
// selection can empty the list on its own.
throwerSel.value = 'C';
throwerSel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await sleep();
check(
  'no grenades in the filter → its own line, and the retired "Turn on a round" copy never renders',
  ($('.util-throwlog')?.textContent || '').includes('No grenades match the current filters.') &&
    $$('.util-nade').length === 0 &&
    !($('.util-throwlog')?.textContent || '').includes('Turn on a round'),
  ($('.util-throwlog')?.textContent || '').replace(/\s+/g, ' ').slice(0, 160),
);
throwerSel.value = '';
throwerSel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await sleep();
check(
  'clearing the filter restores the selector’s options (All rounds + both throwing rounds)',
  !!roundSel && [...roundSel.options].length === 3 && roundSel.value === '1',
  roundSel ? `${[...roundSel.options].length} options / value=${roundSel.value}` : 'missing',
);

console.log('M. stylesheet pins (jsdom has no layout — the rules are the pins)');
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
check(
  'the summary charts stack: ONE .util-summary rule, one column (the 2-col layout is gone)',
  (css.match(/\.util-summary\b/g) || []).length === 1 &&
    /grid-template-columns:\s*1fr/.test(ruleBody('.util-summary {') || ''),
  `occurrences: ${(css.match(/\.util-summary\b/g) || []).length}`,
);
// Comments may NAME a retired rule (the throw-log block explains that
// .util-group* and the .util-toggle* row died) — the checks below are
// over the rules themselves.
const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, '');
check(
  'the retired toggle rules are gone (.util-toggles / .util-toggle* — the round selector replaced them)',
  !cssRules.includes('.util-toggles') &&
    !cssRules.includes('.util-toggle') &&
    !cssRules.includes('.util-toggle-label'),
  'a per-round toggle rule survived in public/style-m3a.css',
);
check(
  'the retired rules are gone (.util-hint, .util-group*, .util-flash-*)',
  !cssRules.includes('.util-hint') &&
    !cssRules.includes('.util-group') &&
    !cssRules.includes('.util-flash'),
);

// ---------------------------------------------------------------------------
// Section N: a failed load is dismissible IN PLACE (PRODUCT.md "Every
// error indication is dismissible"). The ✕ is the canonical idiom — a
// `btn small` with `codicon-close` INSIDE the `p.error[role="alert"]`,
// clearing the state variable — and the view keeps rendering (its
// throw-log card, filters and count stay mounted): no navigation, no
// remount.
console.log('N. failed load: the error is dismissible in place (✕ clears it, view stays)');
{
  globalThis.__utilityError = 'utility backend down';
  const errRoot = await show(); // fresh mount with the failing read
  const errP = errRoot.querySelector('p.error[role="alert"]');
  check(
    'failure renders the alert with its message',
    !!errP && errP.textContent.includes('utility backend down'),
    errP ? errP.textContent.trim() : 'no p.error',
  );
  check(
    'the ✕ rides INSIDE the alert (btn small + codicon-close)',
    !!errP?.querySelector('button.btn.small .codicon-close'),
    errP ? errP.innerHTML.slice(0, 160) : '',
  );
  check(
    'the throw-log card still renders (filters + count inside, nothing unmounted)',
    !!errRoot.querySelector('.util-throwlog .util-filters'),
    errRoot.textContent.replace(/\s+/g, ' ').slice(0, 120),
  );
  errP
    .querySelector('button.btn.small')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await sleep();
  check(
    '✕ clears the error in place (view + throw log still mounted)',
    !errRoot.querySelector('p.error[role="alert"]') && !!errRoot.querySelector('.util-throwlog .util-filters'),
    errRoot.textContent.replace(/\s+/g, ' ').slice(0, 120),
  );
  globalThis.__utilityError = 0;
}

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
if (inst) unmount(inst);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
