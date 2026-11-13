// jsdom driver for the match-details table consistency pass: the Rounds
// tab table and the Economy buy-types table (side-colored TEAM names in
// the Winner cells via sideparity.winnerTeamKey + components/WinnerCell,
// the `.split-before` side-switch boundary row via rounds.separatorFlags,
// the retired yellow pistol pip) and the EconCurve per-money-era stroke
// colors (one <path> per team per money era, GAPped at every money-reset
// boundary — the line is never drawn across one) — plus the
// Match HEADER row (Watch replay parked far LEFT of the meta line, the
// "first half" segment cut, the half-score wiring removed) and the
// Economy summary stat-card drill's ROUND-LEVEL watch loop (tick +
// nav.entryLoopSpan round span, never an event ±10 s anchor).
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
    // A scripted Error is the FAILURE sentinel: that getter returns a
    // rejected promise (section I drives the views' error indications;
    // the fixtures above only ever script data).
    lines.push(
      `export const ${n} = () => {\n` +
        `  const v = has('${n}') ? d().${n} : [];\n` +
        `  return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);\n` +
        `};`,
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
// The shape both tables see: 3 LEGACY pre-match rows (two warmups + the
// knife — the negative indices a pre-reprocess match still carries; the
// row flags themselves died with the discard) ahead of 13 counted rounds
// — MR12 regulation with the halftime side switch REACHED (sideSwitches=1
// lands after counted round 12), so round 13 is era 1. Team names are
// keyed by FINAL side: Alpha finished CT, Beta finished T.
const preMatch = [
  { number: -3, winner: 'ct', reason: 'CTWin' },
  { number: -2, winner: 't', reason: 'TerroristsWin' },
  { number: -1, winner: 'ct', reason: 'CTWin' },
];
const WINNERS = { 5: '' }; // one undecided round → bare chip fallback
const counted = (n) =>
  Array.from({ length: n }, (_, i) => {
    const number = i + 1;
    const winner = WINNERS[number] ?? (number === 1 || number === 13 ? 'ct' : number % 2 ? 't' : 'ct');
    return {
      number,
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
  patchVersion: 14089, // the flattened demo-header value (1.40.8.9)
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
// column 3 of the Rounds table (Cmp · RD · Winner · …), column 2 of the
// buy-types table (RD · Winner · …). The Rounds table's Equip CT/T cells
// also carry `.chip side ct|t` chips, so the column index matters.
const winnerChips = (table, winnerCol) =>
  rowsOf(table)
    .filter((tr) => !tr.classList.contains('econ-why-row'))
    .map((tr) => tr.querySelector(`td:nth-child(${winnerCol}) .chip.side`));
const splitRows = (table) =>
  rowsOf(table).filter((tr) => tr.classList.contains('split-before'));
// Round number of a round row (its first .econ-rd button, else the first cell).
const roundOf = (tr) => (tr.querySelector('.econ-rd') || tr.children[1]).textContent.trim();

// Winner cell chip of the round row whose RD reads `n` (rows render in
// stored order; legacy negative rows render too — lookups are BY ROUND
// NUMBER, never by position).
const chipFor = (table, n) => {
  const tr = rowsOf(table).filter((r) => !r.classList.contains('econ-why-row'))
    .find((r) => roundOf(r) === String(n));
  return tr ? tr.querySelector('td:nth-child(3) .chip.side') : null;
};
const rowFor = (table, n) =>
  rowsOf(table).filter((r) => !r.classList.contains('econ-why-row')).find((r) => roundOf(r) === String(n));

console.log('A. Rounds tab: RD header, side-colored TEAM winner names, split-before');
let root = await showMatch(dataFor(13), { routeTab: 'Rounds' });
let table = root.querySelector('.data-table');
check('rounds table rendered', !!table);
check(
  'round-number header is RD (the standardized prefix — matches Economy)',
  headerTexts(table).includes('RD') && !headerTexts(table).includes('№'),
  JSON.stringify(headerTexts(table)),
);
// BEHAVIOR RE-PIN, labeled (knife/warmup discard, Phase 3): the
// show_knife_warmup_rounds pref is retired — the Rounds tab renders
// EVERY stored row (the fixture's 3 legacy pre-match rows included;
// there is no filter left to apply), and the boundary is pinned by round
// number so the legacy rows cannot shift it.
check(
  'every stored row renders (16 = 3 legacy pre-match + 13 counted, no pref)',
  rowsOf(table).length === 16,
  String(rowsOf(table).length),
);
check(
  'first row is a legacy pre-match round (canonical W label in the Rd cell)',
  rowsOf(table)[0].children[1].textContent.includes('W'),
  rowsOf(table)[0].children[1].textContent,
);
// Round 1: era 0 — the final-CT team (Alpha) played T, so a round-1 CT
// win belongs to the final-T team (Beta): the chip keeps the winning
// SIDE's class (ct) but spells the TEAM's name.
const chip1 = chipFor(table, 1);
check(
  'round 1 winner = final-T team name (Beta) in the side-ct chip',
  !!chip1 && chip1.classList.contains('side') && chip1.classList.contains('ct') && chip1.textContent.trim() === 'Beta',
  chip1 ? chip1.className + ' "' + chip1.textContent.trim() + '"' : 'missing chip',
);
// Round 5: no winner recorded → today's bare chip, never a guessed name.
const chip5 = chipFor(table, 5);
check(
  'round 5 (no winner) falls back to the neutral bare chip',
  !!chip5 && chip5.classList.contains('none') && chip5.textContent.trim() === '—',
  chip5 ? chip5.className + ' "' + chip5.textContent.trim() + '"' : 'missing',
);
// Round 12 (era 0, winner 'ct') → the final-T team (Beta); round 13
// (era 1, same winning side 'ct') → the final-CT team (Alpha) — the SAME
// side, two different teams across the halftime switch.
const chip12 = chipFor(table, 12);
const chip13 = chipFor(table, 13);
check(
  'round 12 winner = Beta (era 0 flips the mapping)',
  !!chip12 && chip12.classList.contains('ct') && chip12.textContent.trim() === 'Beta',
  chip12 ? chip12.className + ' "' + chip12.textContent.trim() + '"' : 'missing',
);
check(
  'round 13 winner = Alpha (era 1, sides back to final)',
  !!chip13 && chip13.classList.contains('ct') && chip13.textContent.trim() === 'Alpha',
  chip13 ? chip13.className + ' "' + chip13.textContent.trim() + '"' : 'missing',
);
check(
  'split-before sits on the round-13 row only (legacy rows never shift it)',
  splitRows(table).length === 1 && roundOf(splitRows(table)[0]) === '13',
  JSON.stringify(splitRows(table).map(roundOf)),
);
check(
  'round 12 carries no line (the boundary is BELOW it)',
  !rowFor(table, 12)?.classList.contains('split-before'),
);

console.log('B. legacy rows never shift the boundary (the retired pref is gone — no kv scenario)');
root = await showMatch(dataFor(13), { routeTab: 'Rounds' });
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
check('15 rows render (3 legacy + 12 counted)', rowsOf(table).length === 15, String(rowsOf(table).length));
check('no split-before row exists', splitRows(table).length === 0, JSON.stringify(splitRows(table).map(roundOf)));

console.log('C2. Rounds tab: the buy-class chip wears THE palette (raw key as class, shared CSS)');
// The four .cmp-class sites (this tab, RoundDetail, Compare ×2) render the
// RAW classification label as an extra class — and the raw value IS the
// palette key (models.RoundClassification.label: pistol|eco|force|full|save;
// empty → `unknown`, the same `|| 'unknown'` idiom Economy's classChip
// uses). style-m3a.css's THE buy-class palette covers `.cmp-class.<key>`
// at specificity (0,2,0), which beats m3b's flat `.cmp-class` accent
// (0,1,0) — by specificity, NOT load order (m3b loads last), so the
// palette value always shows and is never forked.
const classRows = [
  { round: 1, label: 'pistol', confidence: 1, ruleVersion: 1, explanation: 'half start' },
  { round: 2, label: 'force', confidence: 1, ruleVersion: 1, explanation: 'equip over threshold' },
  { round: 3, label: '', confidence: 1, ruleVersion: 1, explanation: 'nothing recorded' },
];
const roundsData = dataFor(13);
const classedData = {
  ...roundsData,
  getRoundClasses: classRows,
  // Round 1 opens the match's first blood — the Details-tab fact spells
  // its round with the RD prefix too.
  getRounds: roundsData.getRounds.map((r) =>
    r.number === 1
      ? { ...r, firstKillName: 'alice', firstKillSteam: 'A', firstDeathName: 'bob', firstDeathSteam: 'B' }
      : r,
  ),
};
root = await showMatch(classedData, { routeTab: 'Rounds' });
table = root.querySelector('.data-table');
const clsChips = [...table.querySelectorAll('.chip.cmp-class')];
check(
  'classified rounds render exactly one chip each (rounds 1–3)',
  clsChips.length === 3,
  String(clsChips.length),
);
check(
  'round 1 chip carries the RAW palette key as a class',
  !!clsChips[0] && clsChips[0].classList.contains('pistol') && clsChips[0].textContent.trim() === 'pistol',
  clsChips[0] ? clsChips[0].className : 'missing',
);
check(
  'round 2 chip carries the RAW palette key as a class',
  !!clsChips[1] && clsChips[1].classList.contains('force') && clsChips[1].textContent.trim() === 'force',
  clsChips[1] ? clsChips[1].className : 'missing',
);
check(
  'empty label falls back to the `unknown` key (the dashed one)',
  !!clsChips[2] && clsChips[2].classList.contains('unknown') && clsChips[2].textContent.trim() === 'unknown',
  clsChips[2] ? clsChips[2].className : 'missing',
);
check(
  'the explanation + rules-version + confidence tooltip is intact',
  clsChips[0]?.getAttribute('title') === 'half start (rules v1 — 100% sure)' &&
    clsChips[1]?.getAttribute('title') === 'equip over threshold (rules v1 — 100% sure)',
  clsChips[0]?.getAttribute('title'),
);
check(
  'a round with no classification row still reads — (never a guessed chip)',
  rowsOf(table)[6]?.children[3]?.textContent.trim() === '—',
  rowsOf(table)[6]?.children[3]?.textContent.trim(),
);
// The First blood fact lives in the DETAILS tab's Key facts list — mount
// it with the same data (the Rounds mount above cannot show it).
root = await showMatch(classedData, { routeTab: 'Details' });
const fbDd = [...root.querySelectorAll('dt')]
  .find((dt) => dt.textContent.trim() === 'First blood')
  ?.nextElementSibling;
check(
  'the Details-tab First blood fact spells its round with the RD prefix (RD1)',
  /\(RD1\)/.test(fbDd?.textContent || ''),
  fbDd ? fbDd.textContent.trim() : 'First blood fact missing',
);
// jsdom has no cascade — the rules are the pins (same idiom as the
// stylesheet pins below). The palette must live ONCE, cover every key
// through `.cmp-class.<key>`, and leave m3b with no per-class value.
const m3a = readFileSync('public/style-m3a.css', 'utf8');
const m3b = readFileSync('public/style-m3b.css', 'utf8');
const paletteRule = (src, sel) => {
  const i = src.indexOf(sel);
  if (i < 0) return null;
  const open = src.indexOf('{', i);
  if (open < 0) return null;
  const close = src.indexOf('}', open);
  return close < 0 ? null : src.slice(open + 1, close);
};
const PALETTE = {
  full: 'var(--accent)',
  force: '#e8833a',
  eco: 'var(--success)',
  save: 'var(--muted)',
  pistol: '#f2c94c',
  'anti-eco': '#4cc9c0',
  bonus: '#b48ce8',
  unknown: 'var(--muted)',
};
for (const [key, color] of Object.entries(PALETTE)) {
  const body = paletteRule(m3a, `.cmp-class.${key} {`);
  check(
    `palette value for ${key} lives at .econ-cls.${key} / .cmp-class.${key} in m3a`,
    !!body && body.includes(color) && m3a.includes(`.econ-cls.${key},`),
    String(body),
  );
}
check(
  'unknown wears the dashed muted chip border (border-color reset to the .chip default)',
  /border-style:\s*dashed/.test(paletteRule(m3a, '.cmp-class.unknown {') || '') &&
    /border-color:\s*var\(--border\)/.test(paletteRule(m3a, '.cmp-class.unknown {') || ''),
  String(paletteRule(m3a, '.cmp-class.unknown {')),
);
check(
  'cascade: the palette selectors are compound (0,2,0) over m3b flat .cmp-class (0,1,0) — palette wins, load order irrelevant',
  /\.cmp-class\.(full|force|eco|save|pistol|anti-eco|bonus|unknown)\s*\{/.test(m3a) &&
    /\.cmp-class\s*\{/.test(m3b) &&
    !/\.cmp-class\.[a-z]/.test(m3b),
  'm3a palette selector or m3b flat rule missing/overridden',
);

console.log('D. Economy tab: buy-types table — RD header, TEAM names, pip retired');
root = await showMatch(dataFor(13), { routeTab: 'Economy' });
table = root.querySelector('.econ-table');
check('buy-types table rendered', !!table);
check(
  'economy header still reads Rd',
  headerTexts(table).includes('RD'),
  JSON.stringify(headerTexts(table)),
);
const chips = winnerChips(table, 2);
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
console.log("D2. Economy stat-card drill → ROUND-LEVEL loop (the round's own span, never ±10 s)");
// The four summary cards are the Economy view's watch buttons: each
// drills to the round it names with the ROUND-LEVEL loop (the round IS
// the sequence — owner's watch rule): tick = the round's start, loop =
// nav.entryLoopSpan(start, end) — the SAME helper RoundDetail's "Watch
// round" and CompareRounds' "Replay start" stamp — never an event-style
// ±10 s anchor and never a filter. Fixture round 1 spans 1000→2900
// (counted(13) above).
globalThis.__nav = [];
const econCards = [...root.querySelectorAll('.econ-summary .stat-cell')];
check('four drillable stat cards render', econCards.length === 4, String(econCards.length));
check(
  'first card is the pistol drill',
  /Pistol/.test(econCards[0]?.textContent || ''),
  (econCards[0]?.textContent || '').slice(0, 60),
);
econCards[0]?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
await sleep();
const navDrill = (globalThis.__nav || []).at(-1);
const { entryLoopSpan } = await import('../src/lib/nav.js');
const r1 = counted(13).find((r) => r.number === 1);
check(
  'card click seeks to the round start WITH the round-span loop (entryLoopSpan), no filter',
  !!navDrill &&
    navDrill.includes('tick=1000') &&
    navDrill.includes('loop=' + entryLoopSpan(r1.startTick, r1.endTick)) &&
    navDrill.includes('loop=1000,2900') &&
    !navDrill.includes('cat=') &&
    !navDrill.includes('roundFrom'),
  navDrill || 'no navigation',
);
check(
  'the round span is NOT an event anchor (no ±10 s pad: 1000−640 would read loop=360,…)',
  !!navDrill && !navDrill.includes('loop=360,'),
  navDrill || 'no navigation',
);
check(
  'the drill keeps its Economy return origin',
  !!navDrill && navDrill.includes('back=match/3/economy'),
  navDrill || 'no navigation',
);

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

console.log("H. Match header: Watch replay is the row's FAR-LEFT cell, first-half copy cut");
root = await showMatch(dataFor(13), { routeTab: 'Rounds' });
const sub = root.querySelector('.match-sub');
check('the header meta row renders', !!sub, 'no .match-sub');
const firstCell = sub?.children[0];
check(
  "Watch replay is the row's FIRST element (details follow to its right)",
  !!firstCell && firstCell.classList.contains('match-replay') && [...sub.children].indexOf(firstCell) === 0,
  sub ? [...sub.children].map((c) => c.className || c.tagName).join(' | ') : 'no .match-sub',
);
const subText = (sub?.textContent || '').replace(/\s+/g, ' ').trim();
check(
  'the details text follows the button (map reads AFTER "Watch replay")',
  subText.indexOf('Watch replay') >= 0 && subText.indexOf('de_mirage') > subText.indexOf('Watch replay'),
  subText.slice(0, 160),
);
check(
  'the button STAYS LABELED with the play glyph (it launches at no tick)',
  !!firstCell && /Watch replay/.test(firstCell.textContent) && !!firstCell.querySelector('.codicon-play'),
  firstCell?.textContent,
);
check('"first half" is gone from the details line', !/first half/i.test(subText), subText.slice(0, 160));
check(
  'the remaining facts survive (map · duration · patch · status)',
  subText.includes('de_mirage') && subText.includes('40m00s') && subText.includes('patch 1.40.8.9') && !!sub.querySelector('.status, .chip'),
  subText.slice(0, 200),
);
// Source pins (jsdom applies no CSS): the component-scoped override that
// zeroes the global .match-replay auto-margin (which parks it RIGHT), and
// the removed half-score wiring.
const matchSrc = readFileSync('src/lib/views/Match.svelte', 'utf8');
check(
  'component-scoped style zeroes the auto-margin (the button parks LEFT)',
  /\.match-sub\s+\.match-replay\s*\{[^}]*margin-left:\s*0/.test(matchSrc),
  'no .match-sub .match-replay { margin-left: 0 } rule in Match.svelte',
);
check(
  'the half-score wiring is fully gone (no dead halfScore/displayHalfScore)',
  !matchSrc.includes('halfScore') && !matchSrc.includes('displayHalfScore'),
  '',
);
// The rung-3 loading lines in Match (owner ruling — a bare "Loading…"
// becomes the canonical centered spinner + details underneath). Match's
// DOM harness never HOLDS a loading window (its reads resolve at once),
// so these are source pins over the view; the widget itself is pinned
// mounted in library.dom.mjs Section G.
check(
  'Match’s two loading lines render the block spinner (warnings + body)',
  (matchSrc.match(/<StatusChip block detail="Loading…" \/>/g) || []).length === 2 &&
    !/role="status">Loading…<\/p>/.test(matchSrc),
  String((matchSrc.match(/<StatusChip block detail="Loading…" \/>/g) || []).length),
);

// ---------------------------------------------------------------------------
// Section I: every error indication in the Match view tree is dismissible
// IN PLACE (PRODUCT.md "### Defaults": an error may gate an action, but the
// user must always be able to clear it without navigating elsewhere). The
// ✕ is the canonical idiom (Match's import-warnings panel): a `btn small`
// with `codicon-close` INSIDE the `p.error[role="alert"]`, clearing the
// state variable. Each sub-check asserts the view stays mounted (its own
// content still rendered) and no navigation happened.
console.log('I. error dismissals: Match top-level, KAST%, pinned stats, round types, Economy');
const clickEl = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const alertP = (r, needle) =>
  [...r.querySelectorAll('p.error[role="alert"]')].find((p) => p.textContent.includes(needle));
const dismissInPlace = async (r, needle, stillThere) => {
  const p = alertP(r, needle);
  if (!p) return { found: false, detail: 'no alert with "' + needle + '"' };
  const navBefore = (globalThis.__nav || []).length;
  const btn = p.querySelector('button.btn.small .codicon-close')?.closest('button');
  if (!btn) return { found: true, detail: 'no .btn.small dismiss inside the alert' };
  clickEl(btn);
  await sleep();
  const gone = !alertP(r, needle);
  const mounted = stillThere(r);
  const noNav = (globalThis.__nav || []).length === navBefore;
  return { found: true, gone, mounted, noNav, detail: '' };
};

// (a) Match's TOP-LEVEL error: the warnings read fails after the header
// has landed (match.warningsCount > 0 → the warnings effect runs), so the
// header proves the view is still mounted when the ✕ clears the message.
{
  const d = {
    ...dataFor(13),
    getMatch: { ...match, warningsCount: 1 },
    getWarnings: new Error('warnings backend down'),
  };
  root = await showMatch(d, { routeTab: 'Rounds' });
  const p = alertP(root, 'warnings backend down');
  check('top-level failure renders the alert with its message', !!p, 'no top-level alert');
  check('the ✕ rides INSIDE the alert', !!p?.querySelector('button.btn.small .codicon-close'), p ? p.innerHTML.slice(0, 160) : '');
  check('the match header is still rendered (nothing unmounted)', !!root.querySelector('.match-sub'), '');
  const res = await dismissInPlace(root, 'warnings backend down', (r) => !!r.querySelector('.match-sub'));
  check(
    '✕ clears the top-level error in place (header intact, no navigation)',
    res.gone && res.mounted && res.noNav,
    JSON.stringify(res),
  );
}

// (b) combatError on the Scoreboard tab ("KAST% unavailable").
{
  const d = { ...dataFor(13), getCombatStats: new Error('kast backend down') };
  root = await showMatch(d, { routeTab: 'Scoreboard' });
  const p = alertP(root, 'KAST% unavailable');
  check('KAST% failure renders its own alert', !!p && p.textContent.includes('kast backend down'), p ? p.textContent.trim() : 'no alert');
  check('the ✕ rides INSIDE the KAST% alert', !!p?.querySelector('button.btn.small .codicon-close'), '');
  const res = await dismissInPlace(root, 'KAST% unavailable', (r) => !!r.querySelector('.data-table.scoreboard'));
  check('✕ clears the KAST% error in place (scoreboard table intact)', res.gone && res.mounted && res.noNav, JSON.stringify(res));
}

// (c) metricError ("Pinned stats unavailable") — needs a pinned metric so
// the pins effect actually runs, then a failing ListMetrics.
{
  localStorage.setItem('spectra:pinned-metrics', '[7]');
  const d = { ...dataFor(13), listMetrics: new Error('metrics backend down') };
  root = await showMatch(d, { routeTab: 'Scoreboard' });
  const p = alertP(root, 'Pinned stats unavailable');
  check('pinned-stats failure renders its own alert', !!p && p.textContent.includes('metrics backend down'), p ? p.textContent.trim() : 'no alert');
  const res = await dismissInPlace(root, 'Pinned stats unavailable', (r) => !!r.querySelector('.data-table.scoreboard'));
  check('✕ clears the pinned-stats error in place (scoreboard table intact)', res.gone && res.mounted && res.noNav, JSON.stringify(res));
  localStorage.removeItem('spectra:pinned-metrics');
}

// (d) classError on the Rounds tab ("Round types unavailable").
{
  const d = { ...dataFor(13), getRoundClasses: new Error('class backend down') };
  root = await showMatch(d, { routeTab: 'Rounds' });
  const p = alertP(root, 'Round types unavailable');
  check('round-types failure renders its own alert', !!p && p.textContent.includes('class backend down'), p ? p.textContent.trim() : 'no alert');
  const res = await dismissInPlace(root, 'Round types unavailable', (r) => !!r.querySelector('.view .data-table'));
  check('✕ clears the round-types error in place (rounds table intact)', res.gone && res.mounted && res.noNav, JSON.stringify(res));
}

// (e) The Economy TAB's own error (Economy.svelte) — its fetch has no
// in-view re-trigger, so the ✕ is its dismissal.
{
  const d = { ...dataFor(13), getEconomy: new Error('eco backend down') };
  root = await showMatch(d, { routeTab: 'Economy' });
  const p = alertP(root, 'eco backend down');
  check('Economy failure renders its own alert', !!p, 'no Economy alert');
  check('the ✕ rides INSIDE the Economy alert', !!p?.querySelector('button.btn.small .codicon-close'), '');
  const res = await dismissInPlace(root, 'eco backend down', (r) => !!r.querySelector('.econ-head'));
  check('✕ clears the Economy error in place (its head row intact)', res.gone && res.mounted && res.noNav, JSON.stringify(res));
}

console.log('J. Scoreboard metric header: m5-mth cap scope, tooltip survives, source pin');
{
  // One pinned metric so the METRIC SortTh actually renders: the width
  // cap is a class Match puts on the metric header only (static
  // SCORE_COLS must never wear it), the ⓘ / (n) / unpin widgets must
  // stay OUTSIDE the capped .th-sort button (the cap bounds the label
  // text alone), and the th's title tooltip must survive untouched.
  // jsdom has no layout, so the cap RULE itself is pinned from the
  // stylesheet source (section G's precedent).
  localStorage.setItem('spectra:pinned-metrics', '[7]');
  const d = {
    ...dataFor(13),
    listMetrics: [
      { id: 7, name: 'util_dmg', title: 'Utility damage per round', doc: 'Grenade damage dealt per round' },
    ],
    previewMetric: {
      rows: [
        { group: 'A', value: 12.5, n: 13 },
        { group: 'B', value: 9.2, n: 13 },
      ],
    },
  };
  root = await showMatch(d, { routeTab: 'Scoreboard' });
  await sleep();
  const ths = [...root.querySelectorAll('.data-table.scoreboard thead th')];
  const metricTh = ths.find(
    (t) => (t.querySelector('.th-sort')?.textContent || '').includes('Utility damage per round'),
  );
  const staticTh = ths.find((t) => (t.querySelector('.th-sort')?.textContent || '').trim() === 'K');
  check(
    'metric header wears m5-mth (the cap scope); static SCORE_COLS never do',
    !!metricTh &&
      metricTh.classList.contains('m5-mth') &&
      !!staticTh &&
      !staticTh.classList.contains('m5-mth'),
    metricTh
      ? `metric=${metricTh.className} static=${staticTh ? staticTh.className : 'no K header'}`
      : 'no metric header rendered',
  );
  const widgetsInButton = metricTh?.querySelector('.th-sort .m5-ib, .th-sort .m5-n, .th-sort .m5-unpin');
  const widgetCount = metricTh
    ? metricTh.querySelectorAll(':scope > .m5-ib, :scope > .m5-n, :scope > .m5-unpin').length
    : -1;
  check(
    'the cap covers the label button only — ⓘ / (n) / unpin stay outside it',
    !!metricTh && !widgetsInButton && widgetCount === 3,
    `outside-widgets=${widgetCount} inside-button=${!!widgetsInButton}`,
  );
  check(
    'the metric th still carries its title tooltip (SortTh untouched)',
    !!metricTh && metricTh.getAttribute('title') === 'Grenade damage dealt per round',
    metricTh ? JSON.stringify(metricTh.getAttribute('title')) : 'no metric header',
  );
  const cssM3a = readFileSync('public/style-m3a.css', 'utf8');
  const ruleOf = (src, sel) => {
    const i = src.indexOf(sel);
    if (i < 0) return null;
    const open = src.indexOf('{', i);
    if (open < 0) return null;
    const close = src.indexOf('}', open);
    return close < 0 ? null : src.slice(open + 1, close);
  };
  const capRule = ruleOf(cssM3a, '.m5-mth .th-sort {');
  check(
    'the metric-header cap rule still bounds the label (max-width + ellipsis + nowrap)',
    !!capRule &&
      /max-width:\s*260px/.test(capRule) &&
      /text-overflow:\s*ellipsis/.test(capRule) &&
      /white-space:\s*nowrap/.test(capRule),
    capRule ? capRule.trim() : 'rule .m5-mth .th-sort not found in public/style-m3a.css',
  );
  localStorage.removeItem('spectra:pinned-metrics');
}

// (f) The short_name display criterion at its ONLY site: a width-
// constrained metric header renders short || title || name (the short
// name wins), while the metric CELL keeps title || name (the tooltip
// below is the cell's own title attribute — the criterion partitions by
// the medium, not by a table whitelist).
{
  localStorage.setItem('spectra:pinned-metrics', '[8]');
  const d = {
    ...dataFor(13),
    listMetrics: [
      {
        id: 8,
        name: 'util_dmg',
        title: 'Utility damage per round',
        shortName: 'UD',
        doc: 'Grenade damage dealt per round',
      },
    ],
    previewMetric: { rows: [{ group: 'A', value: 12.5, n: 13 }] },
  };
  root = await showMatch(d, { routeTab: 'Scoreboard' });
  await sleep();
  const mth = [...root.querySelectorAll('.data-table.scoreboard thead th')].find((t) =>
    t.classList.contains('m5-mth'),
  );
  const label = (mth?.querySelector('.th-sort')?.textContent || '').trim();
  check(
    'the width-constrained metric header renders short_name (criterion: short || title || name)',
    label === 'UD',
    JSON.stringify(label),
  );
  const cellTitle = root.querySelector('.data-table.scoreboard tbody td.m5-cell')?.getAttribute('title') || '';
  check(
    'the metric cell keeps title || name in its tooltip (never the short name)',
    cellTitle.includes('Utility damage per round') && !cellTitle.includes('UD'),
    JSON.stringify(cellTitle),
  );
  localStorage.removeItem('spectra:pinned-metrics');
}

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
if (inst) unmount(inst);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
