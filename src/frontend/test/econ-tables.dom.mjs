// jsdom driver for the match-details table consistency pass: the Rounds
// tab table and the Economy buy-types table (side-colored TEAM names in
// the Winner cells via sideparity.winnerTeamKey + components/WinnerCell,
// the `.split-before` side-switch boundary row via rounds.separatorFlags,
// the retired yellow pistol pip) and the EconCurve per-money-era stroke
// colors (one <path> per team per money era, GAPped at every money-reset
// boundary — the line is never drawn across one).
//
// The driver builds a SELF-CONTAINED mirror of src/lib (every transitive
// .js copied, every transitive .svelte compiled, services.js + the Wails
// bindings stubbed, scripted through globalThis.__svc / __kv), then mounts
// the REAL Match.svelte with routeTab — the cheapest honest harness that
// covers both tables: Match hosts them as tabs.
//
// jsdom is a declared devDependency; from frontend/ run:
//   node --test test/econ-tables.dom.mjs
// (must be run with frontend/ as the working directory)
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
const { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } = await import('node:fs');
const { dirname, join, normalize, relative } = await import('node:path');
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

const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'econ-tables');
const LIB = 'src/lib';

// --- The self-contained mirror of src/lib ----------------------------------

const svelteCompile = (src, filename, out) => {
  writeFileSync(out, compile(src, { filename, generate: 'client' }).js.code);
};

// Binding specifiers resolve to one stub module; `.svelte` specifiers to
// their compiled `.js` sibling in the mirror. Applied to compiled .svelte
// output AND copied .js sources.
function rebase(content, outRel) {
  const outPath = join(dir, outRel);
  return content
    .replace(/(['"])([^'"]*bindings\/[^'"]*)\1/g, (q, quote) => {
      let rel = relative(dirname(outPath), join(dir, 'wails-bindings.js'));
      if (!rel.startsWith('.')) rel = './' + rel;
      return quote + rel + quote;
    })
    .replace(/(['"])([^'"]+)\.svelte\1/g, (q, quote, base) => quote + base + '.js' + quote);
}

// The union of every name the lib imports from services.js — the stub
// must export them all statically (ESM link errors otherwise). Every
// getter resolves scripted data (globalThis.__svc) or [] — the views
// all guard their rows with `(x || [])`.
function serviceNames() {
  const names = new Set();
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(js|svelte)$/.test(f)) {
        const s = readFileSync(p, 'utf8');
        for (const m of s.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[^']*services\.js'/g)) {
          m[1].split(',').forEach((x) => {
            x = x.trim().split(/\s+as\s+/)[0].trim();
            if (x) names.add(x);
          });
        }
      }
    }
  };
  walk(LIB);
  return [...names].sort();
}

function servicesStub() {
  const names = serviceNames().filter((n) => n !== 'errText');
  const lines = [
    'const d = () => globalThis.__svc || {};',
    'const has = (k) => Object.prototype.hasOwnProperty.call(d(), k);',
    "export const errText = (e) => (e == null ? 'unknown error' : String((e && e.message) || e));",
  ];
  for (const n of names) {
    lines.push(
      `export const ${n} = () => Promise.resolve(has('${n}') ? d().${n} : []);`,
    );
  }
  return lines.join('\n') + '\n';
}

const bindingsStub = `
export const KVStoreService = {
  Get: (k) => Promise.resolve(globalThis.__kv ? globalThis.__kv[k] : undefined),
  Set: (k, v) => {
    if (globalThis.__kv) globalThis.__kv[k] = v;
    return Promise.resolve();
  },
};
// Only Heatmaps calls into it, and never during a mount here; a Proxy
// keeps any method linkable without enumerating them.
export const AnalyticsService = new Proxy({}, { get: () => () => Promise.resolve(null) });
`;

const built = new Set();
function build(rel) {
  if (built.has(rel)) return;
  built.add(rel);
  const abs = join(LIB, rel);
  const src = readFileSync(abs, 'utf8');
  if (rel === 'services.js') {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), servicesStub());
    return;
  }
  const imports = [];
  for (const m of src.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) imports.push(m[1]);
  if (rel.endsWith('.svelte')) {
    const outRel = rel.replace(/\.svelte$/, '.js');
    mkdirSync(dirname(join(dir, outRel)), { recursive: true });
    const code = compile(src, { filename: rel, generate: 'client' }).js.code;
    writeFileSync(join(dir, outRel), rebase(code, outRel));
  } else {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), rebase(src, rel));
  }
  for (const spec of imports) {
    if (!spec.startsWith('.')) continue; // 'svelte…', '@wailsio/runtime'
    const target = normalize(join(dirname(rel), spec));
    if (!target.startsWith('..')) build(target);
  }
}

mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'wails-bindings.js'), bindingsStub);
build('views/Match.svelte'); // hosts both tables as tabs (Rounds / Economy)

const harnessSrc = `<script>
  import Match from './views/Match.js';
</script>
<Match id={3} routeTab={globalThis.__routeTab} nav={(h) => (globalThis.__nav = (globalThis.__nav || []).concat(h))} />`;
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

let inst = null;
async function showMatch(data, { routeTab = 'Rounds', kv = {} } = {}) {
  if (inst) {
    unmount(inst);
    inst = null;
  }
  globalThis.__svc = data;
  globalThis.__kv = kv;
  globalThis.__routeTab = routeTab;
  const target = document.createElement('div');
  document.body.appendChild(target);
  inst = mount(mod.default, { target });
  await sleep();
  return target;
}

// --- Fixture ---------------------------------------------------------------
// The shape both tables see: 3 pre-match rows (two warmups + knife, the
// negative renumbering) ahead of 13 counted rounds — MR12 regulation with
// the halftime side switch REACHED (sideSwitches=1 lands after counted
// round 12), so round 13 is era 1. Team names are keyed by FINAL side:
// Alpha finished CT, Beta finished T.
const preMatch = [
  { number: -3, warmup: true, pregame: false, winner: 'ct', reason: 'CTWin' },
  { number: -2, warmup: false, pregame: true, winner: 't', reason: 'TerroristsWin' },
  { number: -1, warmup: true, pregame: false, winner: 'ct', reason: 'CTWin' },
];
const WINNERS = { 5: '' }; // one undecided round → bare chip fallback
const counted = (n) =>
  Array.from({ length: n }, (_, i) => {
    const number = i + 1;
    const winner = WINNERS[number] ?? (number === 1 || number === 13 ? 'ct' : number % 2 ? 't' : 'ct');
    return {
      number,
      warmup: false,
      pregame: false,
      winner,
      reason: winner === 'ct' ? 'CTWin' : winner === 't' ? 'TerroristsWin' : '',
      durationS: 95,
      bombSite: '',
      mvp: '',
      mvpName: '',
      equipCT: 4000 + i * 100,
      equipT: 3800 + i * 100,
      firstKillSteam: '',
      firstKillName: '',
      firstDeathSteam: '',
      firstDeathName: '',
      kills: 10,
      startTick: 1000 + i * 2000,
      endTick: 2900 + i * 2000,
      freezeEndTick: 1160 + i * 2000,
    };
  });

const economyRows = (n) =>
  Array.from({ length: n }, (_, i) => {
    const number = i + 1;
    const winner = WINNERS[number] ?? (number === 1 || number === 13 ? 'ct' : number % 2 ? 't' : 'ct');
    return {
      round: number,
      warmup: false,
      winner,
      wonCT: winner === 'ct',
      wonT: winner === 't',
      classCT: number % 2 ? 'full' : 'eco',
      classT: number % 2 ? 'eco' : 'force',
      classWhyCT: 'two rifles held over',
      classWhyT: 'low buy after a loss',
      ruleVersion: 'v1',
      equipCT: 4000 + i * 100,
      equipT: 3800 + i * 100,
      moneyCT: 1500,
      moneyT: 2000,
      lossBonusCT: 1400,
      lossBonusT: 1900,
      inferredCT: true,
      inferredT: true,
      pistolRound: number === 1 || number === 13,
    };
  });

const match = {
  id: 3,
  map: 'de_mirage',
  tickRate: 64,
  scoreCT: 13,
  scoreT: 11,
  halfCT: 8,
  halfT: 4,
  sideSwitches: 1,
  warningsCount: 0,
  status: 'ready',
  playbackTimeS: 2400,
  patchVersion: '1.40',
  frames: 150000,
  size: 1000000,
  encryptedMessages: 0,
};
const scoreboard = [
  { steamId: 'A', name: 'alice', side: 'ct', kills: 20, deaths: 12, assists: 4, adr: 90, mvps: 3 },
  { steamId: 'B', name: 'bob', side: 't', kills: 18, deaths: 13, assists: 5, adr: 85, mvps: 2 },
];
const summary = { id: 3, ctName: 'Alpha', tName: 'Beta' };

const dataFor = (countedN) => ({
  getMatch: match,
  getMatchSummary: summary,
  getRounds: [...preMatch, ...counted(countedN)],
  getScoreboard: scoreboard,
  getVoicePresence: null,
  getWarnings: [],
  getCombatStats: [],
  getRoundClasses: [],
  listMetrics: [],
  previewMetric: null,
  getEconomy: economyRows(countedN),
  getTeamNames: { ct: 'Alpha', t: 'Beta' },
});

// --- Queries ---------------------------------------------------------------
const rowsOf = (table) => [...table.querySelectorAll('tbody tr')];
const headerTexts = (table) =>
  [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
// The Winner cell chip: the `.chip.side` span inside the WINNER column —
// column 3 of the Rounds table (Cmp · Rd · Winner · …), column 2 of the
// buy-types table (Rd · Winner · …). The Rounds table's Equip CT/T cells
// also carry `.chip side ct|t` chips, so the column index matters.
const winnerChips = (table, winnerCol) =>
  rowsOf(table)
    .filter((tr) => !tr.classList.contains('econ-why-row'))
    .map((tr) => tr.querySelector(`td:nth-child(${winnerCol}) .chip.side`));
const splitRows = (table) =>
  rowsOf(table).filter((tr) => tr.classList.contains('split-before'));
// Round number of a round row (its first .econ-rd button, else the first cell).
const roundOf = (tr) => (tr.querySelector('.econ-rd') || tr.children[1]).textContent.trim();

console.log('A. Rounds tab: Rd header, side-colored TEAM winner names, split-before');
let root = await showMatch(dataFor(13), { routeTab: 'Rounds' });
let table = root.querySelector('.data-table');
check('rounds table rendered', !!table);
check(
  'round-number header is Rd (uppercase → "RD" matches Economy)',
  headerTexts(table).includes('Rd') && !headerTexts(table).includes('№'),
  JSON.stringify(headerTexts(table)),
);
check('pref-off renders the 13 counted rows only', rowsOf(table).length === 13, String(rowsOf(table).length));
let chips = winnerChips(table, 3);
// Round 1: era 0 — the final-CT team (Alpha) played T, so a round-1 CT
// win belongs to the final-T team (Beta): the chip keeps the winning
// SIDE's class (ct) but spells the TEAM's name.
check(
  'round 1 winner = final-T team name (Beta) in the side-ct chip',
  chips[0].classList.contains('side') && chips[0].classList.contains('ct') && chips[0].textContent.trim() === 'Beta',
  chips[0] ? chips[0].className + ' "' + chips[0].textContent.trim() + '"' : 'missing chip',
);
// Round 5: no winner recorded → today's bare chip, never a guessed name.
check(
  'round 5 (no winner) falls back to the neutral bare chip',
  chips[4].classList.contains('none') && chips[4].textContent.trim() === '—',
  chips[4] ? chips[4].className + ' "' + chips[4].textContent.trim() + '"' : 'missing',
);
// Round 12 (era 0, winner 'ct') → the final-T team (Beta); round 13
// (era 1, same winning side 'ct') → the final-CT team (Alpha) — the SAME
// side, two different teams across the halftime switch.
check(
  'round 12 winner = Beta (era 0 flips the mapping)',
  chips[11].classList.contains('ct') && chips[11].textContent.trim() === 'Beta',
  chips[11].className + ' "' + chips[11].textContent.trim() + '"',
);
check(
  'round 13 winner = Alpha (era 1, sides back to final)',
  chips[12].classList.contains('ct') && chips[12].textContent.trim() === 'Alpha',
  chips[12].className + ' "' + chips[12].textContent.trim() + '"',
);
check(
  'split-before sits on the round-13 row only',
  splitRows(table).length === 1 && roundOf(splitRows(table)[0]) === '13',
  JSON.stringify(splitRows(table).map(roundOf)),
);
check(
  'round 12 carries no line (the boundary is BELOW it)',
  !rowsOf(table)[11].classList.contains('split-before'),
);

console.log('B. Rounds tab pref ON: negative rows never shift the boundary');
root = await showMatch(dataFor(13), { routeTab: 'Rounds', kv: { show_knife_warmup_rounds: true } });
table = root.querySelector('.data-table');
check('16 rows render (3 pre-match + 13 counted)', rowsOf(table).length === 16, String(rowsOf(table).length));
check(
  'first row is a pre-match round (canonical W label in the Rd cell)',
  rowsOf(table)[0].children[1].textContent.includes('W'),
  rowsOf(table)[0].children[1].textContent,
);
check(
  'boundary still rides round 13 (index 14), not shifted by the negatives',
  splitRows(table).length === 1 && roundOf(splitRows(table)[0]) === '13',
  JSON.stringify(splitRows(table).map(roundOf)),
);

console.log('C. Rounds tab: 12 counted rounds → trailing suppression (no line at all)');
root = await showMatch(dataFor(12), { routeTab: 'Rounds' });
table = root.querySelector('.data-table');
check('12 rows render', rowsOf(table).length === 12, String(rowsOf(table).length));
check('no split-before row exists', splitRows(table).length === 0, JSON.stringify(splitRows(table).map(roundOf)));

console.log('D. Economy tab: buy-types table — Rd header, TEAM names, pip retired');
root = await showMatch(dataFor(13), { routeTab: 'Economy' });
table = root.querySelector('.econ-table');
check('buy-types table rendered', !!table);
check(
  'economy header still reads Rd',
  headerTexts(table).includes('Rd'),
  JSON.stringify(headerTexts(table)),
);
chips = winnerChips(table, 2);
check(
  'economy round 1 winner = Beta (side-ct chip, era 0)',
  chips[0].classList.contains('ct') && chips[0].textContent.trim() === 'Beta',
  chips[0].className + ' "' + chips[0].textContent.trim() + '"',
);
check(
  'economy round 13 winner = Alpha (side-ct chip)',
  chips[12].classList.contains('ct') && chips[12].textContent.trim() === 'Alpha',
  chips[12].className + ' "' + chips[12].textContent.trim() + '"',
);
check(
  'economy round 5 (no winner) → neutral bare chip',
  chips[4].classList.contains('none') && chips[4].textContent.trim() === '—',
  chips[4] ? chips[4].textContent.trim() : 'missing',
);
check('yellow pistol pip is gone from the table', !root.querySelector('.econ-pip'));
check(
  'boundary rides the round-13 row',
  splitRows(table).length === 1 && roundOf(splitRows(table)[0]) === '13',
  JSON.stringify(splitRows(table).map(roundOf)),
);
check(
  'r.pistolRound still drives the strip / curve indicators',
  root.querySelectorAll('.econ-pistol-band').length === 2 &&
    root.querySelectorAll('.econ-strip-cell.pistol').length === 2,
  `bands=${root.querySelectorAll('.econ-pistol-band').length} cells=${root.querySelectorAll('.econ-strip-cell.pistol').length}`,
);

// Open round 12's WHY row: it must stay attached ABOVE the boundary line
// (round row → why row → line → next round row).
console.log('E. Economy tab: an open econ-why-row stays above the split-before line');
const whyBtn = rowsOf(table)[11].querySelector('.econ-cls');
check('round 12 has a class chip button', !!whyBtn);
whyBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
await sleep();
let order = rowsOf(table).map((tr) =>
  tr.classList.contains('econ-why-row') ? 'why' : roundOf(tr),
);
const wantOrder = [...Array.from({ length: 12 }, (_, i) => String(i + 1)), 'why', '13'];
check(
  'order: … 11 → 12 → why → 13(split-before)',
  order.join(',') === wantOrder.join(','),
  order.join(','),
);
check(
  'the split-before line sits on the row AFTER the why row',
  rowsOf(table).findIndex((tr) => tr.classList.contains('split-before')) === 13,
  String(rowsOf(table).findIndex((tr) => tr.classList.contains('split-before'))),
);

console.log('F. EconCurve: one path per team per MONEY era — gaps at resets, one side color each');
const paths = [...root.querySelectorAll('.econ-line')];
check('13 rows × one money reset → 2 teams × 2 eras = 4 paths', paths.length === 4, String(paths.length));
const sides = paths.map((p) => (p.classList.contains('side-ct') ? 'ct' : p.classList.contains('side-t') ? 't' : '?'));
check(
  'stroke side classes: team-ct era0 side-t → era1 side-ct; team-t era0 side-ct → era1 side-t',
  JSON.stringify(sides) === JSON.stringify(['t', 'ct', 'ct', 't']),
  JSON.stringify(sides),
);
check(
  'dash follows the TEAM (Beta finished T and lost 11-13 → only its two segments dash)',
  !paths[0].classList.contains('loser') && !paths[1].classList.contains('loser') &&
    paths[2].classList.contains('loser') && paths[3].classList.contains('loser'),
  paths.map((p) => p.getAttribute('class')).join(' | '),
);
// GAP geometry: the money reset at index 12 (round 13) splits the rows
// into two segments with NO shared point — each ends on its own last
// column center, the next starts one column pitch later, so the line is
// never drawn across the reset. W and the row count are EconCurve's own
// chart constants for this fixture (viewBox 1000 wide, 13 rows).
const coord = (tok) => tok.replace(/^[ML]/, '');
const tokens = (p) => p.getAttribute('d').trim().split(/\s+/);
const W = 1000;
const NROWS = 13;
const xAt = (i) => ((i + 0.5) / NROWS) * W; // the column CENTER of row i
const xsOf = (p) => tokens(p).map((t) => Number(coord(t).split(',')[0]));
const seg1 = tokens(paths[0]);
const seg2 = tokens(paths[1]);
check(
  'team-ct: seg1 = rows 1-12 (12 pts), seg2 = the lone row 13 as a DOT (M + zero-length L)',
  seg1.length === 12 &&
    seg2.length === 2 &&
    coord(seg2[0]) === coord(seg2[1]) &&
    seg2[0].startsWith('M') &&
    seg2[1].startsWith('L'),
  `seg1=${seg1.length} pts, seg2=${seg2.join(' ')}`,
);
check(
  'team-ct: a GAP, not a shared point — round 12 ends seg1, round 13 opens seg2',
  Math.abs(Math.max(...xsOf(paths[0])) - xAt(11)) < 0.05 &&
    Math.abs(Math.min(...xsOf(paths[1])) - xAt(12)) < 0.05 &&
    Math.max(...xsOf(paths[0])) < Math.min(...xsOf(paths[1])) &&
    coord(seg1.at(-1)) !== coord(seg2[0]),
  `max0=${Math.max(...xsOf(paths[0]))} min1=${Math.min(...xsOf(paths[1]))} xAt(11)=${xAt(11)} xAt(12)=${xAt(12)}`,
);
check(
  'team-t: same gap + lone-row dot (12 + 2 tokens, no shared point)',
  tokens(paths[2]).length === 12 &&
    tokens(paths[3]).length === 2 &&
    coord(tokens(paths[3])[0]) === coord(tokens(paths[3])[1]) &&
    Math.max(...xsOf(paths[2])) < Math.min(...xsOf(paths[3])) &&
    coord(tokens(paths[2]).at(-1)) !== coord(tokens(paths[3])[0]),
  `seg1=${tokens(paths[2]).length} pts, seg2=${tokens(paths[3]).join(' ')}`,
);
check(
  'legend keeps the two identity-colored items (Alpha, Beta)',
  [...root.querySelectorAll('.econ-legend-item')].map((e) => e.textContent.trim()).join(',') === 'Alpha,Beta',
  [...root.querySelectorAll('.econ-legend-item')].map((e) => e.textContent.trim()).join(','),
);
check(
  'legend hint text (solid = match winner …) is gone',
  !root.textContent.includes('solid = match winner') &&
    !root.textContent.includes('match winner undecided'),
);

console.log('F2. EconCurve n=28 (golden nuke shape, sideSwitches=2): resets-only boundaries');
// Remount the Economy tab with 28 counted rows and TWO recorded side
// switches (flips at indexes 12 and 27): the money resets are
// [12, 24, 27] — a strict superset — so the row structure is
// 1-12 | 13-24 | 25-27 | 28: the round-25 gap carries NO side switch
// (same class both sides), the round-28 gap does.
root = await showMatch({ ...dataFor(28), getMatch: { ...match, sideSwitches: 2 } }, { routeTab: 'Economy' });
const paths28 = [...root.querySelectorAll('.econ-line')];
check('28 rows × 4 money resets → 2 teams × 4 eras = 8 paths', paths28.length === 8, String(paths28.length));
const cls28 = (p) => (p.classList.contains('side-ct') ? 'ct' : p.classList.contains('side-t') ? 't' : '?');
const classes28 = paths28.map(cls28);
check(
  "side classes: team-ct ['ct','t','t','ct'], team-t ['t','ct','ct','t'] — one color per money era",
  JSON.stringify(classes28) === JSON.stringify(['ct', 't', 't', 'ct', 't', 'ct', 'ct', 't']),
  JSON.stringify(classes28),
);
check(
  'round-25 boundary: SAME class on both sides (resets ⊋ flips — no switch at OT start)',
  classes28[1] === classes28[2],
  `${classes28[1]} vs ${classes28[2]}`,
);
check(
  'round-28 boundary: the class CHANGES (a side switch, which is also a reset)',
  classes28[2] !== classes28[3],
  `${classes28[2]} vs ${classes28[3]}`,
);
const counts28 = paths28.slice(0, 4).map((p) => tokens(p).length);
const counts28t = paths28.slice(4, 8).map((p) => tokens(p).length);
check(
  'segment structure …1-12 | 13-24 | 25-27 | 28 (token counts 12,12,3,2 per team)',
  JSON.stringify(counts28) === JSON.stringify([12, 12, 3, 2]) &&
    JSON.stringify(counts28t) === JSON.stringify([12, 12, 3, 2]),
  `ct=${JSON.stringify(counts28)} t=${JSON.stringify(counts28t)}`,
);
check(
  'every adjacent pair is a strictly increasing gap (the line never crosses a reset)',
  paths28.slice(0, 4).every((p, i, a) => i === 0 || Math.max(...xsOf(a[i - 1])) < Math.min(...xsOf(p))) &&
    paths28.slice(4, 8).every((p, i, a) => i === 0 || Math.max(...xsOf(a[i - 1])) < Math.min(...xsOf(p))),
);
check(
  'the lone round-28 segment paints as a dot (M + zero-length L)',
  tokens(paths28[3]).length === 2 &&
    coord(tokens(paths28[3])[0]) === coord(tokens(paths28[3])[1]) &&
    tokens(paths28[3])[0].startsWith('M'),
  tokens(paths28[3]).join(' '),
);
check(
  'loser dash on every segment of the losing team (4 dashed), winner solid',
  paths28.slice(4).every((p) => p.classList.contains('loser')) &&
    paths28.slice(0, 4).every((p) => !p.classList.contains('loser')),
  paths28.map((p) => p.getAttribute('class')).join(' | '),
);

console.log('G. style pin: replay opts OUT of the .view 1400px cap (source pin — jsdom has no layout)');
// The app-dock.dom.mjs precedent: jsdom has no layout, so the rule IS
// the pin. Reads the stylesheet from frontend/ (the driver's cwd).
const css = readFileSync('public/style.css', 'utf8');
const ruleBody = (sel) => {
  const i = css.indexOf(sel);
  if (i < 0) return null;
  const open = css.indexOf('{', i);
  if (open < 0) return null;
  const close = css.indexOf('}', open);
  return close < 0 ? null : css.slice(open + 1, close);
};
const baseView = ruleBody('\n.view {');
check(
  'the shared .view cap stays for every other view (1400px centered)',
  !!baseView && /max-width:\s*1400px/.test(baseView) && /margin:\s*0 auto/.test(baseView),
  baseView ? baseView.trim() : '.view rule not found',
);
const replayView = ruleBody('\n.replay-view {');
check(
  '.replay-view carries max-width: none (the one exemption, same rule as its row layout)',
  !!replayView && /max-width:\s*none/.test(replayView) && /height:\s*calc\(100vh - 32px\)/.test(replayView),
  replayView ? replayView.trim() : '.replay-view rule not found',
);
const miniView = ruleBody('.rp-keepalive-mini .replay-view {');
check(
  'the dock override still fixes the collapsed panel (220px / 100% / margin 0)',
  !!miniView &&
    /height:\s*220px/.test(miniView) &&
    /width:\s*100%/.test(miniView) &&
    /margin:\s*0/.test(miniView),
  miniView ? miniView.trim() : 'dock rule not found',
);
check(
  'the dock wrapper still fixes the 320px box the 100% resolves against',
  /width:\s*320px/.test(ruleBody('.rp-keepalive.rp-keepalive-mini {') || ''),
  'no width:320px on .rp-keepalive.rp-keepalive-mini',
);
const mediaBlock = /@media \(max-width: 1000px\) \{[\s\S]*?\.replay-view \{[^}]*\}/.exec(css);
check(
  'the ≤1000px media rule still flips .replay-view to a column',
  !!mediaBlock && /flex-direction:\s*column/.test(mediaBlock[0]),
  mediaBlock ? mediaBlock[0] : 'media block not found',
);
check(
  'the nested-.view margin rule is untouched',
  /margin-inline:\s*0/.test(ruleBody('\n.view > .view {') || ''),
  '.view > .view rule not found or changed',
);

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
if (inst) unmount(inst);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
