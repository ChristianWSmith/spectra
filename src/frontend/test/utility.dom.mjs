import { warm, compileIdle } from './compile-worker-node.mjs';
await warm();
// jsdom driver for Utility: the damage bars' design-language channels
// (COLOR = the side each team held IN THAT round via sideparity.sideAtRound,
// with the era flip visible across the halftime switch; PATTERN = team
// identity — one team's rects carry the SVG stripe overlay and its legend
// dot the CSS twin), the blind-time chart's TWIN channels and its honest
// label (C8), the owner's zero → em-dash rule (damage / affected / blind
// time read "—" at 0 while the throw-log count stays numeric), the
// coordinate carve-out over the THROW origin (dashes only when BOTH
// components are 0 — an unpaired row has no origin and dashes), the
// throw-based cells (a paired row's clock/tooltip/▶ stamp/labels show the
// PAIRED THROW's tick, an unpaired row falls back to the detonation's —
// never an interpolated throw time), the dead site column's removal
// (markup + CSS), the retired events button, the icon-only throw ▶ as the
// row's LEADING cell (tick + the loop-length loop — the `loop_secs` pref,
// default 5 s — + the thrower as the camera follow — never a filter), the
// C9 hint-line removal, and the C7 consolidation: ONE card carrying the
// filters + count — W17 (owner, 2026-11-16) moved it to the FRONT of
// the view (reversing C7's bottom-card ruling) and made the two summary
// charts hide themselves when the filter leaves them nothing to draw —
// with the round scope in ONE <select> that preselects the first round
// with throws and offers "All rounds" (owner answer Q1, 2026-11-16 — it
// replaced the per-round toggle row) whose throw lists render for
// exactly the round(s) in scope.
//
// jsdom is a declared devDependency; from frontend/ run:
//   node --test test/utility.dom.mjs
// (must be run with frontend/ as the working directory; the same file also
// runs under `node --conditions browser test/utility.dom.mjs` — it pins the
// browser condition itself so `svelte` resolves to the client build)
import { reachesSvelte } from './bundle-reach.mjs';
import { registerHooks } from 'node:module';

// svelte's package exports pick the SERVER build without the `browser`
// condition (mount() then throws "lifecycle_function_unavailable"), so the
// driver adds it for every svelte specifier before anything imports one.
const stub = (name) => pathToFileURL(join('test', 'stubs', name)).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'svelte' || specifier.startsWith('svelte/')) {
      return nextResolve(specifier, {
        ...context,
        conditions: ['browser', ...(context.conditions || [])],
      });
    }
    if (specifier === '@wailsio/runtime') return { url: stub('wails-runtime.mjs'), shortCircuit: true };
    if (specifier.includes('bindings/github.com')) return { url: stub('bindings.mjs'), shortCircuit: true };
    return nextResolve(specifier, context);
  },
  // A built-in reaches its curated helpers by dynamic import (compile.js BUILTIN_HELPERS),
  // which loads the real files in node: a rune module (*.svelte.js) and a .svelte file must
  // be compiled first, as the bundler compiles them. Only app sources under src/.
  load(url, context, nextLoad) {
    const filename = url.startsWith('file:') ? new URL(url).pathname : '';
    const inSrc = filename.startsWith(process.cwd() + '/src/');
    if (inSrc && url.endsWith('.svelte.js')) {
      const source = compileModule(readFileSync(filename, 'utf8'), { filename, generate: 'client' }).js.code;
      return { format: 'module', source, shortCircuit: true };
    }
    if (inSrc && url.endsWith('.svelte')) {
      const source = compile(readFileSync(filename, 'utf8'), { filename, generate: 'client', css: 'injected', runes: true }).js.code;
      return { format: 'module', source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { JSDOM } = await import('jsdom');
const { compile, compileModule } = await import('svelte/compiler');
const { readFileSync, writeFileSync, mkdirSync, realpathSync } = await import('node:fs');
const { dirname, join, resolve } = await import('node:path');
const { pathToFileURL } = await import('node:url');
const { DatabaseSync } = await import('node:sqlite');

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
});
for (const k of [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement',
  'HTMLButtonElement', 'HTMLMediaElement', 'HTMLVideoElement', 'HTMLAnchorElement',
  'HTMLSelectElement', 'SVGElement', 'SVGSVGElement', 'Element', 'Node', 'Text', 'Comment', 'DocumentFragment',
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

// --- bundling (as econ-util-panels.dom.mjs): the ComponentFrame mount ---------
const cacheDir = join('node_modules', '.cache', 'spectra-dom-tests', 'utility');
mkdirSync(cacheDir, { recursive: true });
const panelStub = join(cacheDir, 'panels-stub.js');
writeFileSync(panelStub, 'export function builtinPanelById() { return null; }\n');
const compiled = new Map();
let seq = 0;
function bundle(absPath) {
  if (compiled.has(absPath)) return compiled.get(absPath);
  const out = join(cacheDir, `${String(++seq).padStart(2, '0')}-${absPath.split('/').pop()}.js`);
  compiled.set(absPath, out);
  const src = readFileSync(absPath, 'utf8').replace(/from '(\.{1,2}\/[^']+)'/g, (whole, rel) => {
    const target = resolve(dirname(absPath), rel);
    if (target.endsWith('.svelte')) return `from '${pathToFileURL(bundle(target)).href}'`;
    if (target.endsWith('.svelte.js')) return `from '${pathToFileURL(bundle(target)).href}'`;
    if (target.endsWith('builtins/panels.js')) return `from '${pathToFileURL(panelStub).href}'`;
    // A .js that reaches the stubbed registry through its own imports (resolve.js) is
    // bundled too, so its import of the registry is rewritten.
    if (target.endsWith('.js') && reachesSvelte(target)) return `from '${pathToFileURL(bundle(target)).href}'`;
    return `from '${pathToFileURL(target).href}'`;
  });
  writeFileSync(out, absPath.endsWith('.svelte') ? compile(src, { filename: absPath, generate: 'client' }).js.code
    : /\.svelte\.js$/.test(absPath) ? compileModule(src, { filename: absPath, generate: 'client' }).js.code : src);
  return out;
}
const harnessBundle = bundle(resolve('test/match-panels.harness.svelte'));
const { mount, unmount, flushSync } = await import('svelte');
// The Utility composer is a Svelte builtin: its source is the .svelte file.
const utilpanels = { UTILITY_SOURCE: readFileSync(resolve('src/lib/builtins/util/Utility.svelte'), 'utf8') };
const Harness = (await import(pathToFileURL(harnessBundle).href)).default;
const viewstate = await import(pathToFileURL(bundle(resolve('src/lib/viewstate.svelte.js'))).href); // the panels' copy: one instance

// --- the data: an in-memory database built from the store's own DDL ----------
// The view reads through componentQuery (the same SQL the Go store runs), so the
// fixture below is stored as rows and the SQL answers from them.
const DDL = readFileSync(resolve(realpathSync(import.meta.dirname), '..', '..', 'internal', 'store', 'schema.sql'), 'utf8');
const TABLES = ['matches', 'rounds', 'players', 'player_stats', 'teams', 'utility_events', 'events', 'round_player_sides'];
function openDb() {
  const db = new DatabaseSync(':memory:');
  for (const t of TABLES) {
    const m = new RegExp('CREATE TABLE IF NOT EXISTS ' + t + ' \\([\\s\\S]*?\\n\\);').exec(DDL);
    if (!m) throw new Error('no DDL for ' + t);
    db.exec(m[0]);
  }
  return db;
}
function answerSql(db, sql) {
  const objs = db.prepare(sql).all();
  return { columns: objs.length ? Object.keys(objs[0]) : [], rows: objs.map((o) => Object.values(o)) };
}
const reads = {
  listMetrics: async () => [],
  getMetricValuesForMatch: async () => [],
  getMetricValuesForRound: async () => [],
  getMetricValuesForPlayer: async () => [],
  getMetricComputeState: async () => [],
  getMetricStates: async () => [],
  // __utilityError (section I) makes the data read FAIL — the load-failure path
  // the frame's dismissible error is pinned against; unset it for plain reads.
  componentQuery: async (sql) =>
    globalThis.__utilityError ? { err: String(globalThis.__utilityError) } : answerSql(globalThis.__utilityDb, sql),
};
let evSeq = 0;
function buildDb() {
  const db = openDb();
  evSeq = 0;
  db.prepare("INSERT INTO matches (id, sha256, tick_rate, side_switches) VALUES (?, 'fixture', ?, ?)").run(match.id, match.tickRate, match.sideSwitches);
  for (const r of rounds) {
    db.prepare('INSERT INTO rounds (match_id, number, winner, start_tick, end_tick) VALUES (?, ?, ?, ?, ?)').run(match.id, r.number, r.winner, r.startTick, r.endTick);
  }
  for (const p of scoreboard) {
    db.prepare('INSERT INTO players (match_id, steam_id, name, side, is_bot) VALUES (?, ?, ?, ?, 0)').run(match.id, p.steamId, p.name, p.side);
    db.prepare('INSERT INTO player_stats (match_id, steam_id, name, side, score) VALUES (?, ?, ?, ?, 0)').run(match.id, p.steamId, p.name, p.side);
    // The roster orders by kill events (the fold columns are gone): one kill
    // event per kill the fixture gives the player.
    for (let k = 0; k < p.kills; k++) {
      evSeq += 1;
      db.prepare("INSERT INTO events (match_id, seq, round, kind, attacker, victim) VALUES (?, ?, 1, 'kill', ?, '')").run(match.id, evSeq, p.steamId);
    }
  }
  db.prepare('INSERT INTO teams (match_id, side, name) VALUES (?, ?, ?)').run(match.id, 'ct', teams.ct);
  db.prepare('INSERT INTO teams (match_id, side, name) VALUES (?, ?, ?)').run(match.id, 't', teams.t);
  for (const r of rows) {
    db.prepare(
      'INSERT INTO utility_events (match_id, seq, tick, throw_tick, round, thrower, thrower_name, kind, throw_x, throw_y, det_x, det_y, damage, flash_ms, affected, site, trajectory_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      match.id, r.seq, r.tick, r.throwTick, r.round, r.thrower, r.throwerName, r.kind,
      r.throwX, r.throwY, r.detX, r.detY, r.damage, r.flashMsTotal, r.affected, r.site || '', '',
    );
  }
  return db;
}


const sleep = async (ms = 40) => {
  await new Promise((r) => setTimeout(r, ms));
  await compileIdle();
};

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
// Utility rows (AnalyticsService.UtilityRow over models.UtilityEvent):
// `site` is carried on purpose — the extractor never writes it and the
// column is retired, so the field must be IGNORED (no .util-site cell
// renders). Every row carries its THROW-side facts in the store's row
// order (effective throw tick within a round): row 1 is the UNPAIRED
// fallback (throwTick 0 + zeroed throw coordinates — exactly what the
// service sends when no throw paired: its tick cells fall back to the
// detonation tick and its place cell dashes, never an interpolated throw
// time). The paired rows' detX/detY deliberately DIFFER from their
// throwX/throwY, so a pin over the rendered cell proves the THROW
// position is what shows and the stored detonation coordinates never do.
const rows = [
  // round 1 — era 0: Alpha (final CT) on T, Beta (final T) on CT.
  // UNPAIRED: detonation facts only (its stored det (5, 12) is not shown).
  { seq: 1, tick: 1500, round: 1, thrower: 'A', throwerName: 'alice', kind: 'he', throwTick: 0, throwX: 0, throwY: 0, detX: 5, detY: 12, damage: 40, flashMsTotal: 0, affected: '["B"]', site: 'A' },
  // Paired flash: its throw (1650) LEADS its detonation (1700), so every
  // throw-based cell must read 1650, never 1700. Its 1500 ms is also the
  // ONE non-zero value behind the blind-time chart (section K).
  { seq: 2, tick: 1700, round: 1, thrower: 'A', throwerName: 'alice', kind: 'flash', throwTick: 1650, throwX: 8, throwY: 15, detX: 10, detY: 20, damage: 0, flashMsTotal: 1500, affected: '', site: '' },
  // zero damage + zero affected + the both-zero coordinate carve-out,
  // on the THROW coordinates (0, 0 dashes).
  { seq: 3, tick: 2000, round: 1, thrower: 'A', throwerName: 'alice', kind: 'he', throwTick: 1960, throwX: 0, throwY: 0, detX: 0, detY: 0, damage: 0, flashMsTotal: 0, affected: '', site: 'A' },
  // round 13 — era 1: sides back to the final sides.
  { seq: 4, tick: 25500, round: 13, thrower: 'B', throwerName: 'bob', kind: 'smoke', throwTick: 25410, throwX: -95, throwY: 295, detX: -100, detY: 300, damage: 30, flashMsTotal: 0, affected: '["A","B"]', site: '' },
];
const match = { id: 3, tickRate: 64, sideSwitches: 1 };
const teams = { ct: 'Alpha', t: 'Beta' };

async function settle(n = 12) {
  for (let i = 0; i < n; i++) {
    await sleep(25);
    flushSync();
  }
}
let inst = null;
async function show() {
  if (inst) {
    unmount(inst);
    inst = null;
  }
  globalThis.__utilityDb = buildDb();
  viewstate.resetViewState();
  const target = document.createElement('div');
  document.body.appendChild(target);
  inst = mount(Harness, {
    target,
    props: {
      source: utilpanels.UTILITY_SOURCE,
      builtinDir: 'src/lib/builtins/util',
      context: { matchId: match.id, steamId: null, round: null },
      props: { back: 'match/3/utility', loopSecs: 5 },
      reads,
      nav: (h) => (globalThis.__nav = (globalThis.__nav || []).concat(h)),
    },
  });
  await settle();
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

// --- C7 as revised by W17: the consolidation ----------------------------
// The throw-log card (filters, count, ONE round selector) now LEADS the
// view — owner, 2026-11-16, reversing the 2026-11-15 C7 bottom-card
// ruling — and the two summary charts follow it, each hiding itself
// when the filter leaves it nothing to draw. This section pins the new
// chrome AND doubles as the preamble for every row check below: the
// selector preselects the first round with throws (the owner's Q1
// answer), so the driver switches it to "All rounds" before E…K read
// every row.
console.log('D. C7/W17 structure: throw log FIRST, charts follow, filters + round selector inside, first throwing round preselected');
// The kind filter is a popover multi-select: open its trigger, check the kinds wanted, then close it.
const setKinds = async (kinds) => {
  const trig = $('.util-kind-host > button');
  if (!$('.util-kind-pop')) trig.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep();
  for (const cb of $$('.util-kind-pop input[type=checkbox]')) {
    const want = kinds.includes(cb.parentElement.textContent.trim());
    if (cb.checked !== want) cb.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  }
  await sleep();
};
const setSel = async (el, value) => {
  el.value = value;
  el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await sleep();
};
const panels = $$('.frame-panel:not(.frame-composer)');
check(
  'exactly three panels: the throw log + two summary charts',
  panels.length === 3,
  panels.map((p) => p.className).join(' | '),
);
check(
  'the consolidated throw log is the FIRST card of the view (W17 — the owner moved it)',
  panels[0]?.querySelector('.util-throwlog') &&
    panels[1]?.querySelector('.util-card-damage') &&
    panels[2]?.querySelector('.util-card-blind'),
  panels.map((p) => p.className).join(' | ') || 'no panels',
);
check(
  'the kind, thrower AND round selectors moved INTO the card',
  !!$('.util-throwlog .util-kind-host') && !!$('.util-throwlog #util-thrower') && !!$('.util-throwlog #util-round'),
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

console.log('F. coordinates: the THROW origin renders, dash only when both components are 0');
const coords = nadeCells('.util-coord');
check(
  'throw coordinates (8, 15) / (-95, 295) render; the unpaired row and the both-zero throw dash — the stored det coords never show',
  JSON.stringify(coords) === JSON.stringify(['—', '(8, 15)', '—', '(-95, 295)']),
  JSON.stringify(coords),
);

console.log('G. the dead site column is gone (markup + CSS)');
check('no .util-site cell renders (the fixture even carries site values)', !$('.util-site'));
// The ▶ LEADS the row (owner ruling): .util-actions is the row's FIRST
// child, before the kind chip — the class stays, so every selector over
// it still resolves.
const leadNade = $('.util-nade');
check(
  "the actions cell is the row's FIRST child (▶ precedes the kind chip)",
  !!leadNade &&
    leadNade.firstElementChild?.classList.contains('util-actions') &&
    !!leadNade.querySelector('.util-actions button') &&
    leadNade.children[1]?.classList.contains('util-kind'),
  leadNade ? [...leadNade.children].map((c) => c.className).join(' | ') : 'no .util-nade row',
);
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
// The FIRST row is the UNPAIRED fixture row (throwTick 0): its stamp
// therefore reads the detonation tick — the honest fallback, never an
// interpolated throw time (the paired row's own cells are pinned in H2).
const throwBtn = $('.util-nade .util-actions button');
check('a throw ▶ rendered', !!throwBtn, 'no .util-actions button');
check(
  'throw ▶ icon-only play with the follow-aware title',
  !!throwBtn && throwBtn.textContent.trim() === '' && !!throwBtn.querySelector('.codicon-play') &&
    throwBtn.getAttribute('title') === 'Watch this throw — follow alice',
  throwBtn?.getAttribute('title'),
);
check(
  'throw ▶ carries an aria-label naming the event + follow (no tick — labels identify the event)',
  throwBtn?.getAttribute('aria-label') === 'Watch this throw — follow alice',
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

console.log('H2. throw-based cells: a paired row shows its THROW tick, an unpaired row falls back to the detonation’s');
const cellRow = (i) => $$('.util-nade')[i];
// The flash row pairs throw 1650 with detonation 1700 — every throw-based
// cell must read 1650, and the clock discriminates (0:26 vs 0:27).
const pairedTick = cellRow(1)?.querySelector('.util-tick');
check(
  'paired row: clock + tooltip read the THROW tick (0:26 / "tick 1650 …"), not the detonation’s 1700',
  pairedTick?.textContent.trim() === '0:26' &&
    pairedTick?.getAttribute('title') === 'tick 1650 — time into round 1',
  `${pairedTick?.textContent} [${pairedTick?.getAttribute('title')}]`,
);
const pairedBtn = cellRow(1)?.querySelector('.util-actions button');
check(
  'paired row: the ▶ title + aria-label keep the shipped event-identifying wording (no tick)',
  pairedBtn?.getAttribute('title') === 'Watch this throw — follow alice' &&
    pairedBtn?.getAttribute('aria-label') === 'Watch this throw — follow alice',
  `${pairedBtn?.getAttribute('title')} / ${pairedBtn?.getAttribute('aria-label')}`,
);
pairedBtn?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
await sleep();
const navPaired = (globalThis.__nav || [])[(globalThis.__nav || []).length - 1];
check(
  'paired row: ▶ stamps tick=1650 with the loop around IT (1330,1970) + follow — never the detonation tick',
  !!navPaired &&
    navPaired.includes('tick=1650') &&
    navPaired.includes('loop=1330,1970') &&
    navPaired.includes('follow=A') &&
    !navPaired.includes('tick=1700'),
  navPaired || 'no navigation',
);
// The unpaired row's own clock/tooltip (its stamp + loop are the H pins
// above): the detonation tick stays, no throw time is invented.
const unpairedTick = cellRow(0)?.querySelector('.util-tick');
check(
  'unpaired row (no throw tick): clock + tooltip keep the detonation tick (0:23 / "tick 1500 …")',
  unpairedTick?.textContent.trim() === '0:23' &&
    unpairedTick?.getAttribute('title') === 'tick 1500 — time into round 1',
  `${unpairedTick?.textContent} [${unpairedTick?.getAttribute('title')}]`,
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
// Empty state (W17, owner 2026-11-16): a filter with no blind time
// HIDES the whole blind card — no placeholder line, no chart of
// zero-height bars — while the damage chart keeps drawing (kind=he
// carries damage, so damageBars.any stays true).
await setKinds(['he']);
check(
  'no blind time in the filter → the blind card hides entirely (no placeholder line) while the damage chart still draws',
  !$('.util-card-blind') &&
    !root.textContent.includes('No blind time in this selection.') &&
    $$('.util-card-damage .util-bar').length > 0,
  `blind=${!!$('.util-card-blind')} damageBars=${$$('.util-card-damage .util-bar').length}`,
);
await setKinds([]);
check(
  'clearing the filter brings the card back (4 bars)',
  !!$('.util-card-blind') && $$('.util-card-blind .util-bar').length === 4,
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
// selection can empty the list on its own. W17 (owner, 2026-11-16): a
// filter with nothing to plot hides BOTH summary cards entirely (no
// drawable data = damageBars.any / flashBars.any false) — this is the
// damage card's hide case, the kind=he case above being the blind
// card's.
throwerSel.value = 'C';
throwerSel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await sleep();
check(
  'no grenades in the filter → its own line, both summary cards hide, and the retired "Turn on a round" copy never renders',
  ($('.util-throwlog')?.textContent || '').includes('No grenades match the current filters.') &&
    $$('.util-nade').length === 0 &&
    !$('.util-card-damage') &&
    !$('.util-card-blind') &&
    !($('.util-throwlog')?.textContent || '').includes('Turn on a round'),
  ($('.util-throwlog')?.textContent || '').replace(/\s+/g, ' ').slice(0, 160),
);
throwerSel.value = '';
throwerSel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await sleep();
check(
  'clearing the filter restores the selector’s options AND both summary cards (data is back)',
  !!roundSel &&
    [...roundSel.options].length === 3 &&
    roundSel.value === '1' &&
    !!$('.util-card-damage') &&
    !!$('.util-card-blind'),
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
  "the .util-nade grid LEADS with the fixed play track (▶ first, kind second)",
  /grid-template-columns:\s*34px\s+74px\s+minmax\(90px,\s*1fr\)/.test(ruleBody('.util-nade {') || ''),
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
