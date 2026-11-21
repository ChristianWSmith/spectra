// jsdom driver for the match-details table consistency pass: the Rounds
// tab table and the Economy buy-types table (the far-left watch columns
// and their round-level ▶ stamping, side-colored TEAM names in the
// Winner cells via sideparity.winnerTeamKey + components/WinnerCell,
// the loss-bonus pip stacks, the `.split-before` side-switch boundary
// row via rounds.separatorFlags, the retired yellow pistol pip) and the
// EconCurve per-money-era stroke colors (one <path> per team per money
// era, GAPped at every money-reset boundary — the line is never drawn
// across one) — plus the Match HEADER row (Watch replay parked far LEFT
// of the meta line, the "first half" segment cut, the half-score wiring
// removed) and the Economy summary stat-card drill's ROUND-LEVEL watch
// loop (tick + nav.entryLoopSpan round span, never an event pad anchor).
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
// The stored-row oracle below resolves per-team keys with the REAL
// side-parity module (the same teamKeyAt the retired view computation
// called and the stored team stamps are written through).
const { teamKeyAt } = await import('../src/lib/sideparity.js');

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

// jsdom ships no ResizeObserver: the Heatmaps tab's HeatmapLayer binds
// clientWidth, which Svelte's size binding observes the moment that tab
// mounts (the help-buttons header-`?` walk visits every match tab).
// Inert — this harness has no layout to report and no check reads a
// size; the observer is only there so the mount does not throw.
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

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
    // the fixtures above only ever script data). A scripted FUNCTION is
    // a live read (args in, value out) — what the pref reads need,
    // since ONE getter serves every kvstore key (getPref('…')).
    lines.push(
      `export const ${n} = (...args) => {\n` +
        `  const raw = has('${n}') ? d().${n} : [];\n` +
        `  const v = typeof raw === 'function' ? raw(...args) : raw;\n` +
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
  Delete: (k) => {
    if (globalThis.__kv) delete globalThis.__kv[k];
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
<Match id={3} routeTab={globalThis.__routeTab} nav={(h) => (globalThis.__nav = (globalThis.__nav || []).concat(h))} openDocs={(s) => (globalThis.__docs = (globalThis.__docs || []).concat(s))} />`;
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
      // Go's RuleVersion is an int (models.EconomyRow) — the side-chip
      // tooltip composes "(rules v{rule})", so the fixture must too.
      ruleVersion: 1,
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

// The per-round player RECORD behind the table's CT Deaths / T Deaths
// columns (player_round_stats — one row per player per round carrying
// that round's side sample; the fold in Economy.svelte sums deaths per
// (round, side)). Hand-shaped so every pinned cell is hand-computed:
// alice dies TWICE in rounds 1 and 13 and once otherwise, bob dies once
// every round. Sides follow the halftime switch (sideSwitches=1 →
// rounds 1-12 alice CT / bob T, round 13 alice T / bob CT), so round
// 13's cells prove the fold keys on the ROUND'S SIDE, never on the
// player's final side.
const playerRoundsFor = (countedN) =>
  Array.from({ length: countedN }, (_, i) => {
    const n = i + 1;
    const aliceSide = n <= 12 ? 'ct' : 't';
    const bobSide = n <= 12 ? 't' : 'ct';
    return [
      { round: n, steamId: 'A', name: 'alice', side: aliceSide, deaths: n === 1 || n === 13 ? 2 : 1 },
      { round: n, steamId: 'B', name: 'bob', side: bobSide, deaths: 1 },
    ];
  }).flat();

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
  // The raw fields the Q2 conversions must NOT read anymore sit beside
  // their metric twins on purpose: bob's raw assists=5 renders as the
  // honest dash because no assists row exists for him.
  // Open K / Open D (the old Opening K/D halves) render from the
  // metrics with no openingKills/openingDeaths fields on the row at
  // all — they are metric columns since w13d.
  {
    steamId: 'A', name: 'alice', side: 'ct', kills: 20, deaths: 12, assists: 4,
    adr: 90, mvps: 3, utilityDamage: 150,
  },
  {
    steamId: 'B', name: 'bob', side: 't', kills: 18, deaths: 13, assists: 5,
    adr: 85, mvps: 2, utilityDamage: 120,
  },
];
const summary = { id: 3, ctName: 'Alpha', tName: 'Beta' };

// The SEEDED fixed cells'/cards' named-slot catalog (owner rulings
// 2026-11-17 and 2026-11-18): the scoreboard K/D/DMG/Util/MVPs cells,
// the roster K/D/A triple + ADR chip and the Overview top cards' NUMBERS
// all read their seed rows, so the default fixture carries the
// definitions those named slots resolve BY NAME. Ids are explicit: the
// 101–105 block predates the card slots, and 106–116 belong to the
// Economy seeds (106/107/113–116) and the identity cards (108–112), so
// the three card slots take 117–119. shortName/format mirror the schema
// seeds (the metric column headers read shortName).
const SEED_FIELDS = Object.freeze({
  kills: ['kills', 101, 'K', 'int'],
  deaths: ['deaths', 102, 'D', 'int'],
  total_damage: ['totalDamage', 103, 'DMG', 'int'],
  utility_damage: ['utilityDamage', 104, 'Util', 'int'],
  mvps: ['mvps', 105, 'MVPs', 'int'],
  assists: ['assists', 117, 'A', 'int'],
  adr: ['adr', 118, 'ADR', 'float1'],
  entry_kills: ['entryKills', 119, 'Open K', 'int'],
});
const SEED_DEFS = Object.entries(SEED_FIELDS).map(([name, [, id, short, format]]) => ({
  id,
  name,
  title: name,
  shortName: short,
  scope: 'match',
  format,
  doc: `Formula: sum(player_stats.${name}) — the ${name} slot's seed`,
}));
// The canonical read over the CURRENT scoreboard fixture: one row per
// requested seed id × player whose raw field the seed sums (equal by
// construction — that very column is the seed's input), keyed by
// subjectKey. A scripted FUNCTION (the stub's live-read shape — the
// call is getMetricValuesForMatch(matchID, ids), so ids is arg 2), so a
// section that swaps getScoreboard gets rows for ITS players without
// re-scripting the read.
const seedValues = (matchID, ids) => {
  const sb = (globalThis.__svc && globalThis.__svc.getScoreboard) || [];
  const nameById = new Map(SEED_DEFS.map((d) => [d.id, d.name]));
  const out = [];
  for (const id of ids || []) {
    const name = nameById.get(id);
    const field = name ? SEED_FIELDS[name]?.[0] : '';
    if (!field) continue;
    for (const p of sb) {
      const v = p[field];
      if (Number.isFinite(v)) out.push({ metricId: id, subjectKey: p.steamId, value: v, n: 13 });
    }
  }
  return out;
};

// The four ECONOMY card seed families' rows (plan §8 M8 rows + the
// view-aggregate relocation, ME8 audit): the card values are stored
// metric rows since their migrations — pistol_hold (percent — the held
// ÷ won RATE the card used to render as "1/2"), avg_equip_gap
// (currency — the mean decided-round winner gap), the force card's
// team_force_wins / team_force_rounds count pairs (its headline
// percent pools them) and the lost card's lost_equip total +
// team_lost_equip halves. The driver computes each value with the SAME
// view aggregate the cards used before the migration (an independent
// in-driver port over economyRows below — the real teamKeyAt for the
// per-team keys) and serves it as the STORED row; exact equivalence
// of the SEEDED expressions to this oracle is pinned in Go
// (internal/metrics econ_equivalence_test.go), the rendered strings in
// section M8. Match-subject rows carry subjectKey ''; team rows the
// team key.
const ECON_SEED_DEFS = Object.freeze([
  {
    id: 106, name: 'pistol_hold', title: 'Pistol \u2192 next round', shortName: '',
    scope: 'match', subject: 'match', format: 'percent',
    doc: 'Formula: pistol rounds held ÷ pistol rounds won — addressed per match',
  },
  {
    id: 107, name: 'avg_equip_gap', title: 'Winner equipment value advantage', shortName: '',
    scope: 'match', subject: 'match', format: 'currency',
    doc: 'Formula: mean winner − loser freeze-end equip — addressed per match',
  },
  {
    id: 113, name: 'team_force_wins', title: 'Force rounds won', shortName: '',
    scope: 'match', subject: 'team', format: 'int',
    doc: 'Formula: count of that team’s force rounds won — addressed per team',
  },
  {
    id: 114, name: 'team_force_rounds', title: 'Force rounds', shortName: '',
    scope: 'match', subject: 'team', format: 'int',
    doc: 'Formula: count of that team’s own force rounds — addressed per team',
  },
  {
    id: 115, name: 'lost_equip', title: 'Lost equipment', shortName: '',
    scope: 'match', subject: 'match', format: 'currency',
    doc: 'Formula: total freeze-end equip lost across decided rounds — addressed per match',
  },
  {
    id: 116, name: 'team_lost_equip', title: 'Team lost equipment', shortName: '',
    scope: 'match', subject: 'team', format: 'currency',
    doc: 'Formula: freeze-end equip that team lost — addressed per team',
  },
]);
const econSeedValues = (ids, countedN, switches) => {
  const rows = economyRows(countedN);
  let held = 0, won = 0, sum = 0, n = 0;
  // The retired force/lost view computation, in-driver: per-team force
  // counts (teamKeyAt per row — a round both teams force-bought counts
  // for each) and the lost-equip halves (the loser's freeze-end equip
  // credits the team behind the loser side).
  const force = { ct: { won: 0, total: 0 }, t: { won: 0, total: 0 } };
  const lost = { ct: 0, t: 0 };
  let lostTotal = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.pistolRound) {
      const side = r.winner === 'ct' ? 'ct' : r.winner === 't' ? 't' : '';
      if (side) {
        won++;
        const next = rows[i + 1];
        if (next && (side === 'ct' ? next.wonCT : next.wonT)) held++;
      }
    }
    let win, lose;
    if (r.winner === 'ct') { win = r.equipCT; lose = r.equipT; }
    else if (r.winner === 't') { win = r.equipT; lose = r.equipCT; }
    else continue;
    sum += (win || 0) - (lose || 0);
    n++;
    for (const side of [r.classCT === 'force' ? 'ct' : '', r.classT === 'force' ? 't' : ''].filter(Boolean)) {
      const key = teamKeyAt(side, i, rows.length, switches);
      if (!key) continue;
      force[key].total++;
      if (side === 'ct' ? r.wonCT : r.wonT) force[key].won++;
    }
    const loserSide = r.winner === 'ct' ? 't' : 'ct';
    const loserEquip = loserSide === 'ct' ? r.equipCT || 0 : r.equipT || 0;
    const loserKey = teamKeyAt(loserSide, i, rows.length, switches);
    if (loserKey) { lost[loserKey] += loserEquip; lostTotal += loserEquip; }
  }
  const out = [];
  for (const id of ids || []) {
    if (id === 106) out.push({ metricId: 106, subjectKey: '', value: won ? held / won : 0, n: rows.length });
    if (id === 107) out.push({ metricId: 107, subjectKey: '', value: n ? sum / n : 0, n: rows.length });
    if (id === 113) for (const k of ['ct', 't']) out.push({ metricId: 113, subjectKey: k, value: force[k].won, n: rows.length });
    if (id === 114) for (const k of ['ct', 't']) out.push({ metricId: 114, subjectKey: k, value: force[k].total, n: rows.length });
    if (id === 115) out.push({ metricId: 115, subjectKey: '', value: lostTotal, n: rows.length * 2 });
    if (id === 116) for (const k of ['ct', 't']) out.push({ metricId: 116, subjectKey: k, value: lost[k], n: rows.length });
  }
  return out;
};

// The five M1 IDENTITY card seeds' FIELD map (plan §8 identity rows):
// each name → the raw column its argmax records over (the ORACLE below
// re-derives the winner from the fixture's scoreboard; the engine reads
// the same column).
const IDENTITY_FIELDS = Object.freeze({
  top_fragger: 'kills',
  best_adr: 'adr',
  most_util: 'utilityDamage',
  entry_opens: 'entryKills',
  most_mvps: 'mvps',
});
// The five M1 IDENTITY card seeds (plan §8 identity rows): the Overview
// top cards read these stored rows since their Phase-7 migration
// (2026-11-18) — the seed picks WHO (valueKey). Since owner item 5 the
// card LABEL comes from the def too (the dialog's overview table lists
// `title`), so the fixture's titles mirror the schema seeds byte for
// byte ('Top fragger' … — never `title: name`). Ids continue the
// 100-series.
const IDENTITY_TITLES = Object.freeze({
  top_fragger: 'Top fragger',
  best_adr: 'Best ADR',
  most_util: 'Most util',
  entry_opens: 'Entry opens',
  most_mvps: 'Most MVPs',
});
const IDENTITY_SEED_DEFS = Object.freeze(
  Object.entries(IDENTITY_FIELDS).map(([name, field], i) => ({
    id: 108 + i,
    name,
    title: IDENTITY_TITLES[name],
    shortName: '',
    scope: 'match',
    subject: 'match',
    format: 'identity',
    doc: `Formula: argmax(player_stats.${field}) — the card's selection; N = the pool`,
  })),
);
// The argmax ORACLE over the CURRENT scoreboard fixture — the engine's
// ratified rule restated in-driver (doc.go "Identity values"): the
// highest value wins and TIES break on the player key ASCENDING. The
// retired card code took the FIRST view row instead (strict `>`), so
// where the two disagree the SEED wins — that is what the migration
// pins. A row whose field is not a finite number sits outside the pool
// (the store always writes the column; a sparse fixture row is not a
// candidate), and an empty pool emits NO row (the empty-set rule —
// never a fabricated winner).
const argmaxIdentity = (sb, field) => {
  const pool = sb.filter((p) => Number.isFinite(p[field]));
  let best = null;
  for (const p of pool) {
    const v = p[field];
    if (!best || v > best.v || (v === best.v && String(p.steamId) < String(best.steam))) {
      best = { steam: p.steamId, v };
    }
  }
  return best ? { ...best, pool: pool.length } : null;
};
const identitySeedValues = (ids) => {
  const sb = (globalThis.__svc && globalThis.__svc.getScoreboard) || [];
  const nameById = new Map(IDENTITY_SEED_DEFS.map((d) => [d.id, d.name]));
  const out = [];
  for (const id of ids || []) {
    const field = IDENTITY_FIELDS[nameById.get(id) || ''];
    if (!field) continue;
    const win = argmaxIdentity(sb, field);
    if (win) out.push({ metricId: id, subjectKey: '', valueKey: win.steam, value: win.v, n: win.pool });
  }
  return out;
};

const dataFor = (countedN, switches = 1) => ({
  getMatch: { ...match, sideSwitches: switches },
  getMatchSummary: summary,
  getRounds: [...preMatch, ...counted(countedN)],
  getScoreboard: scoreboard,
  getVoicePresence: null,
  // The warnings page shape ({messages,total} — the fetch-capped
  // window + the honest full count, models.WarningListPage).
  getWarnings: { messages: [], total: 0 },
  getRoundClasses: [],
  // The pinned-column reads (stored-metrics design §5): the canonical
  // stored-value read + the compute-state read. Defaults = the seeded
  // fixed cells' rows (SEED_DEFS above) + the two Economy card seeds
  // (ECON_SEED_DEFS) and no state landed (a fresh ROW renders its value
  // whatever the state map says); an unscripted name resolves [] through
  // the stub, and a section that scripts its own catalog/read replaces
  // both wholesale (the sections below).
  listMetrics: [...SEED_DEFS, ...ECON_SEED_DEFS, ...IDENTITY_SEED_DEFS],
  getMetricValuesForMatch: (matchID, ids) => [
    ...seedValues(matchID, ids),
    ...econSeedValues(ids, countedN, switches),
    ...identitySeedValues(ids),
  ],
  getMetricComputeState: [],
  getEconomy: economyRows(countedN),
  getPlayerRounds: playerRoundsFor(countedN),
  getTeamNames: { ct: 'Alpha', t: 'Beta' },
  // The kvstore getter: ABSENT keys answer undefined. (The servicesStub
  // defaults an unscripted service to [] — a present-EMPTY pref — which
  // resolvePins would read verbatim as "pin nothing" and blank the
  // overview card set; order/hidden read the same either way: [] and
  // null both resolve their defaults.) Sections that script prefs (N4's
  // hidden set, w25's shape) override this through their spread.
  getPref: () => undefined,
});

// --- Queries ---------------------------------------------------------------
const rowsOf = (table) => [...table.querySelectorAll('tbody tr')];
const headerTexts = (table) =>
  [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
// The Winner cell chip: the `.chip.side` span inside the WINNER column —
// column 4 of the Rounds table (Watch · Cmp · RD · Winner · …), column 3
// of the buy-types table (Watch · RD · Winner · …). Both tables gained
// the far-left watch column (W3a) and the Rounds table lost its Class
// column (W3a), so the column index matters — the Rounds table's
// per-side Class cell is gone entirely (RoundDetail/CompareRounds keep
// the shared .cmp-class palette).
const winnerChips = (table, winnerCol) =>
  rowsOf(table)
    .filter((tr) => !tr.classList.contains('econ-why-row'))
    .map((tr) => tr.querySelector(`td:nth-child(${winnerCol}) .chip.side`));
const splitRows = (table) =>
  rowsOf(table).filter((tr) => tr.classList.contains('split-before'));
// Round number of a round row (its first .econ-rd button, else the RD
// cell — children[2] behind the far-left watch column).
const roundOf = (tr) => (tr.querySelector('.econ-rd') || tr.children[2]).textContent.trim();

// Winner cell chip of the round row whose RD reads `n` (rows render in
// stored order; legacy negative rows render too — lookups are BY ROUND
// NUMBER, never by position).
const chipFor = (table, n) => {
  const tr = rowsOf(table).filter((r) => !r.classList.contains('econ-why-row'))
    .find((r) => roundOf(r) === String(n));
  return tr ? tr.querySelector('td:nth-child(4) .chip.side') : null;
};
const rowFor = (table, n) =>
  rowsOf(table).filter((r) => !r.classList.contains('econ-why-row')).find((r) => roundOf(r) === String(n));

console.log('A. Rounds tab: far-left watch column, RD header, side-colored TEAM winner names, split-before');
let root = await showMatch(dataFor(13), { routeTab: 'Rounds' });
let table = root.querySelector('.data-table');
check('rounds table rendered', !!table);
check(
  'round-number header is RD (the standardized prefix — matches Economy)',
  headerTexts(table).includes('RD') && !headerTexts(table).includes('№'),
  JSON.stringify(headerTexts(table)),
);
// W3a: the far-left watch column — an sr-only Watch header (the
// RoundDetail kill/bomb-table idiom) and one ghost ▶ per row. The ▶
// stamps the ROUND-level watch (start tick + the round's own start→end
// span + THIS tab as the ?back= origin) and the row handler ignores
// button targets, so the SAME click never also opens the round page —
// the two nav paths coexist (lead ruling).
check(
  'the table opens with the far-left watch column (sr-only Watch header + one ghost ▶ per row)',
  headerTexts(table)[0] === 'Watch' &&
    rowsOf(table).length === 16 &&
    rowsOf(table).every((tr) => tr.querySelector('td:first-child button .codicon-play')),
  JSON.stringify([headerTexts(table)[0], rowsOf(table).length]),
);
{
  globalThis.__nav = [];
  // Row 3 is counted round 1 (3 legacy pre-match rows ahead of it).
  rowsOf(table)[3]?.querySelector('td:first-child button')?.dispatchEvent(
    new dom.window.MouseEvent('click', { bubbles: true }),
  );
  await sleep();
  const watchNav = (globalThis.__nav || []).slice();
  check(
    'the row ▶ goes to the replay with tick + the round-span loop + the Rounds-tab back origin (never the round page)',
    watchNav.length === 1 &&
      watchNav[0].includes('/replay/3?') &&
      watchNav[0].includes('tick=1000') &&
      watchNav[0].includes('loop=1000,2900') &&
      watchNav[0].includes('back=match/3/rounds'),
    JSON.stringify(watchNav),
  );
}
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
  rowsOf(table)[0].children[2].textContent.includes('W'),
  rowsOf(table)[0].children[2].textContent,
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
  rowsOf(table)[0].children[2].textContent.includes('W'),
  rowsOf(table)[0].children[2].textContent,
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

// C2 (W3a): the Rounds tab's Class column and its per-side chip pins
// are GONE — the table opens with the far-left watch column instead and
// no longer reads getEconomy at all (the classError alert died with it).
// The shared .cmp-class PALETTE itself STAYS: RoundDetail's Economy card
// and CompareRounds still render it, and the cascade checks below pin it
// exactly as before.
// The Details tab is technicals-only now (owner ruling, 2026-11-15): the
// First blood fact (gameplay-derived) left Key facts. Absence pin, flipped
// IN PLACE (same check count → driver-liveness's 116 stays): no First blood
// term, while two surviving technical facts still render beside it.
root = await showMatch(dataFor(13), { routeTab: 'Details' });
const factDts = [...root.querySelectorAll('dt')].map((d) => d.textContent.trim());
check(
  'the Details Key facts list carries no First blood term (technicals only)',
  !factDts.includes('First blood') && factDts.includes('Server') && factDts.includes('Parser'),
  JSON.stringify(factDts),
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

console.log('D. Economy tab: per-round table — Rounds title, CT/T Deaths columns, watch column, RD header, TEAM names, loss pips');
root = await showMatch(dataFor(13), { routeTab: 'Economy' });
table = root.querySelector('.econ-table');
check('per-round table rendered', !!table);
check(
  'economy header still reads Rd',
  headerTexts(table).includes('RD'),
  JSON.stringify(headerTexts(table)),
);
const chips = winnerChips(table, 3);
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
// W3a: the far-left watch column and the RD cell's return stamp.
check(
  'the buy-types table opens with the far-left watch column (sr-only Watch header + one ghost ▶ per row)',
  headerTexts(table)[0] === 'Watch' &&
    rowsOf(table).filter((tr) => !tr.classList.contains('econ-why-row')).length === 13 &&
    rowsOf(table).every((tr) => tr.querySelector('td:first-child button .codicon-play')),
  JSON.stringify([headerTexts(table)[0], rowsOf(table).length]),
);
{
  globalThis.__nav = [];
  rowsOf(table)[0]
    ?.querySelector('td:first-child button')
    ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await sleep();
  const ecoNav = (globalThis.__nav || []).slice();
  check(
    'the row ▶ drills the ROUND-level loop WITH the Economy back origin',
    ecoNav.length === 1 &&
      ecoNav[0].includes('/replay/3?') &&
      ecoNav[0].includes('tick=1000') &&
      ecoNav[0].includes('loop=1000,2900') &&
      ecoNav[0].includes('back=match/3/economy'),
    JSON.stringify(ecoNav),
  );
}
{
  globalThis.__nav = [];
  rowsOf(table)[0]
    ?.querySelector('.econ-rd')
    ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await sleep();
  const rdNav = (globalThis.__nav || []).slice();
  check(
    'the RD cell opens the round page WITH ?back= (never the unstamped Overview fallback)',
    rdNav.length === 1 &&
      rdNav[0].startsWith('/match/3/round/1?') &&
      rdNav[0].includes('back=match/3/economy'),
    JSON.stringify(rdNav),
  );
}
// W3a loss-bonus pips: five slots per Loss cell, filled to the side's
// stored bonus in that SIDE's colour (fixture: CT 1400 → one filled, T
// 1900 → two), the exact amount kept in the cell title, and the retired
// `econ-pip` class name never resurrected (checked above).
{
  const trs = rowsOf(table).filter((tr) => !tr.classList.contains('econ-why-row'));
  const ctCell = trs[0]?.children[7];
  const tCell = trs[0]?.children[8];
  const filledOf = (cell, cls) =>
    cell ? [...cell.querySelectorAll('.econ-loss-pip')].filter((p) => p.classList.contains(cls)).length : -1;
  check(
    'Loss cells render five pips, filled to the side’s bonus in the side colours (CT 1400 → 1, T 1900 → 2)',
    !!ctCell &&
      !!tCell &&
      ctCell.querySelectorAll('.econ-loss-pip').length === 5 &&
      tCell.querySelectorAll('.econ-loss-pip').length === 5 &&
      filledOf(ctCell, 'ct') === 1 &&
      filledOf(tCell, 't') === 2 &&
      filledOf(ctCell, 't') === 0 &&
      filledOf(tCell, 'ct') === 0,
    `ct=${ctCell?.textContent}/${ctCell?.querySelectorAll('.econ-loss-pip').length} t=${tCell?.textContent}`,
  );
  check(
    'the exact dollar amount stays in the Loss cell title (honesty)',
    ctCell?.getAttribute('title') === '$1,400' && tCell?.getAttribute('title') === '$1,900',
    `${ctCell?.getAttribute('title')} | ${tCell?.getAttribute('title')}`,
  );
}
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

// The panel rename, the column swap, the chip removal and the footer
// cut (owner, 2026-11-18) — plus the death VALUES, hand-computed from
// the playerRoundsFor fixture above: round 1 (sides as finished era 0)
// → alice dies twice ON CT and bob once ON T = 2 / 1; round 13 (after
// the halftime switch) → alice dies twice ON T and bob once ON CT =
// 1 / 2, which is what pins the fold as SIDE-keyed rather than
// player-keyed. The chips removed are THIS panel's inferred markers
// (the two Loss-header badges and the footer badge); the summary
// cards' own provenance badges live in the stat-card region and are
// untouched here.
{
  const panel = table?.closest('section');
  check(
    'the panel title reads Rounds (the Buy types rename, 2026-11-18)',
    panel?.querySelector('h2')?.textContent.trim() === 'Rounds',
    panel?.querySelector('h2')?.textContent.trim(),
  );
  const heads = headerTexts(table);
  check(
    'Equip CT / Equip T were replaced by CT Deaths / T Deaths',
    heads.includes('CT Deaths') &&
      heads.includes('T Deaths') &&
      !heads.some((h) => h.startsWith('Equip')),
    JSON.stringify(heads),
  );
  check(
    'no inferred chip renders anywhere in the table (both Loss-header badges gone)',
    !table.querySelector('.badge-inferred'),
    table.querySelector('.badge-inferred')?.outerHTML || '',
  );
  check(
    'the explanatory footer under the table is gone',
    !panel?.querySelector('.econ-table-note') &&
      !panel?.textContent.includes('five rungs from $1400'),
    panel?.querySelector('.econ-table-note')?.textContent || 'no footer',
  );
  const deathCells = (n) => {
    const tr = rowFor(table, n);
    return tr ? [tr.children[5]?.textContent.trim(), tr.children[6]?.textContent.trim()] : null;
  };
  const d1 = deathCells(1);
  check(
    'round 1 deaths: CT 2 · T 1 (hand-computed from the per-round player rows)',
    !!d1 && d1[0] === '2' && d1[1] === '1',
    JSON.stringify(d1),
  );
  const d13 = deathCells(13);
  check(
    'round 13 deaths: CT 1 · T 2 (side-keyed — the halftime switch swaps the columns, not the players)',
    !!d13 && d13[0] === '1' && d13[1] === '2',
    JSON.stringify(d13),
  );
  const deathTitles = [...table.querySelectorAll('thead th')].filter((th) =>
    /Deaths/.test(th.textContent),
  );
  check(
    'both death headers carry the same hover explaining what is counted',
    deathTitles.length === 2 &&
      deathTitles.every((th) => /Deaths suffered by that side/.test(th.getAttribute('title') || '')),
    JSON.stringify(deathTitles.map((th) => th.getAttribute('title'))),
  );
}

// Open round 12's WHY row: it must stay attached ABOVE the boundary line
// (round row → why row → line → next round row).
console.log("D2. Economy stat-card drill → ROUND-LEVEL loop (the round's own span, never an event pad)");
// The four summary cards are the Economy view's watch buttons: each
// drills to the round it names with the ROUND-LEVEL loop (the round IS
// the sequence — owner's watch rule): tick = the round's start, loop =
// nav.entryLoopSpan(start, end) — the SAME helper RoundDetail's "Watch
// round" and CompareRounds' "Replay start" stamp — never an event-style
// pad anchor and never a filter. Fixture round 1 spans 1000→2900
// (counted(13) above).
globalThis.__nav = [];
const econCards = [...root.querySelectorAll('.econ-summary .stat-cell')];
check('six economy stat cards render (the default set)', econCards.length === 6, String(econCards.length));
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
  // 360 was the ±10 s arithmetic (1000−640); the loop length's default
  // 5 s would read 680 (1000−320) — neither may appear.
  'the round span is NOT an event anchor (no event pad: 1000−320 would read loop=680,…)',
  !!navDrill && !navDrill.includes('loop=680,'),
  navDrill || 'no navigation',
);
check(
  'the drill keeps its Economy return origin',
  !!navDrill && navDrill.includes('back=match/3/economy'),
  navDrill || 'no navigation',
);

// ME0 (metrics-expansion Phase 0, M8 pre-image): the four summary
// cards' VALUES on this fixture — pistol held/won, force-win %,
// avg equip gap (rounded), lost-equip total + per-team split, and
// each card's drill round — pinned as the display strings the view
// renders today (above, only the drill BEHAVIOR was pinned). All four
// values read STORED metric rows since their migrations (pistol/gap —
// plan §8 M8; force/lost — the view-aggregate relocation, ME8 audit);
// the rows are the in-driver ports above, so these strings rest on
// the same aggregate the retired view computation produced.
{
  const sumCards = [...root.querySelectorAll('.econ-summary .stat-cell')];
  const val = (i) => sumCards[i]?.querySelector('.stat-value')?.textContent ?? '';
  const sub = (i) => sumCards[i]?.querySelector('.stat-sub')?.textContent ?? '';
  const ttl = (i) => sumCards[i]?.getAttribute('title') ?? '';
  for (const [i, c] of sumCards.entries()) {
    console.log(`    M8 card${i}: value=${JSON.stringify(val(i))} sub=${JSON.stringify(sub(i))} title=${JSON.stringify(ttl(i))}`);
  }
  // The ECONOMY card set migration (owner, 2026-11-18): the card SET
  // is metricorder's economy placement pref (absent ⇒ DEFAULT_ECONOMY
  // — the shipped six, in that array's order), one card per metric,
  // every value ITS metric's stored row — the composed pooled-force %
  // and lost sub retired with the migration (their inputs' equivalence
  // stays pinned in Go, internal/metrics econ_equivalence_test).
  check('M8: the default economy set renders six cards (pistol, force pair, gap, lost pair)',
    sumCards.length === 6, String(sumCards.length));
  check('M8: labels come from the metric titles',
    ['Pistol \u2192 next round', 'Force rounds won', 'Force rounds',
     'Winner equipment value advantage', 'Lost equipment', 'Team lost equipment']
      .every((t, i) => (sumCards[i]?.querySelector('.field-label')?.textContent || '').includes(t)),
    sumCards.map((c) => c.querySelector('.field-label')?.textContent).join(' | '));
  // M8 re-pin with the card migration (2026-11-17): the pistol card
  // reads its STORED pistol_hold row (plan §8 M8 — the seed over the
  // next() round window) — the SAME held/won number (rounds 1+13 won,
  // only round 1 held → 0.5, asserted exact in Go by internal/metrics'
  // econ_equivalence_test against this fixture's ported view
  // aggregate) rendered through the percent format every rate seed
  // uses. The pre-migration view aggregate displayed the identical
  // number as the fraction notation "1/2"; a stored metric value is a
  // single number, so the card's format tag decides the notation.
  check('M8: pistol held rate = 50% (1/2 — rounds 1+13 won, only round 1 held)', val(0) === '50%', val(0));
  // The force pair reads its stored count rows (team_force_wins /
  // team_force_rounds — the view-aggregate relocation, ME8 audit): six
  // era-0 T-side force rounds attribute to Alpha (final CT), none won;
  // Beta never force-bought. The pooled rate the old card composed
  // from these two rows retires here — the counts are the stats.
  check('M8: force wins = per-team stored counts (Alpha 0, Beta 0)', val(1) === 'Alpha 0 · Beta 0', val(1));
  check('M8: force rounds = per-team stored counts (Alpha 6, Beta 0)', val(2) === 'Alpha 6 · Beta 0', val(2));
  check('M8: avg equip gap = $67 (round(800/12) over 12 decided rounds)', val(3) === '$67', val(3));
  // The lost pair reads lost_equip (total) + team_lost_equip (halves),
  // each as its own card's stored row.
  check('M8: lost-equip total = $53,800 (sum of loser freeze-end equip)', val(4) === '$53,800', val(4));
  check('M8: team lost = per-team split (Alpha = era-0 loser-T 30200; Beta = era-0 loser-CT 18600 + r13 loser-T 5000)', val(5) === 'Alpha $30,200 · Beta $23,600', val(5));
  check('M8: the shipped stats keep their static subs (pistol, gap)',
    sub(0) === 'pistol wins held next round' && sub(3) === 'avg winner \u2212 loser equip per round',
    [sub(0), sub(3)].join(' | '));
  check(
    'M8: every card title carries its Formula doc',
    sumCards.every((c) => (c.getAttribute('title') || '').includes('Formula:')),
    sumCards.map((c) => c.getAttribute('title')).join(' || '),
  );
  check(
    'M8: the inferred badge marks the loss-derived cards only (lost pair)',
    sumCards.map((c) => !!c.querySelector('.badge-inferred')).join(',') === 'false,false,false,false,true,true',
    sumCards.map((c) => !!c.querySelector('.badge-inferred')).join(','),
  );
}

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
check(
  'the open why row spans every column (colspan 9 behind the new watch column)',
  rowsOf(table)
    .find((tr) => tr.classList.contains('econ-why-row'))
    ?.querySelector('td')
    ?.getAttribute('colspan') === '9',
  String(
    rowsOf(table).find((tr) => tr.classList.contains('econ-why-row'))?.querySelector('td')?.getAttribute('colspan'),
  ),
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
// W3a (V5c): BOTH round links out of the curve carry the Economy origin.
{
  globalThis.__nav = [];
  root.querySelectorAll('.econ-hit')[0]?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await sleep();
  const hitNav = (globalThis.__nav || []).slice();
  check(
    'the curve hit-rect opens the round WITH ?back=match/3/economy (the Overview-fallback fix)',
    hitNav.length === 1 &&
      hitNav[0].startsWith('/match/3/round/1?') &&
      hitNav[0].includes('back=match/3/economy'),
    JSON.stringify(hitNav),
  );
}
{
  globalThis.__nav = [];
  root.querySelectorAll('.econ-strip-cell')[0]?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await sleep();
  const stripNav = (globalThis.__nav || []).slice();
  check(
    'the winner-strip button opens the round WITH the same Economy origin',
    stripNav.length === 1 &&
      stripNav[0].startsWith('/match/3/round/1?') &&
      stripNav[0].includes('back=match/3/economy'),
    JSON.stringify(stripNav),
  );
}

console.log('F2. EconCurve n=28 (golden nuke shape, sideSwitches=2): resets-only boundaries');
// Remount the Economy tab with 28 counted rows and TWO recorded side
// switches (flips at indexes 12 and 27): the money resets are
// [12, 24, 27] — a strict superset — so the row structure is
// 1-12 | 13-24 | 25-27 | 28: the round-25 gap carries NO side switch
// (same class both sides), the round-28 gap does.
root = await showMatch(dataFor(28, 2), { routeTab: 'Economy' });
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

console.log("H. Match header: Watch replay is the row's FAR-LEFT cell, first-half copy cut, header ? follows the active tab");
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
// The header `?` (help-buttons wave, 2026-11-15): ONE button in the
// Match header (right of the .spacer), targeting the section of the
// ACTIVE tab — MATCH_TAB_SECTIONS in lib/router.js, the very table
// docslockstep.test.js pins against the registered guide, so the
// button's target and the documented coverage are one spelling.
const hdr = root.querySelector('.match-header');
const help = hdr?.querySelector(':scope > button[aria-label="Help for this view"]');
check(
  'the ? is the header’s LAST element, right of the .spacer, with the shared labels + question glyph',
  !!help && hdr.lastElementChild === help &&
    !!hdr.querySelector(':scope > .spacer') &&
    help.getAttribute('title') === 'Help for this view' &&
    help.classList.contains('btn') && !!help.querySelector('.codicon-question'),
  hdr ? [...hdr.children].map((c) => c.className || c.tagName).join(' | ') : 'no header',
);
const TAB_TARGETS = {
  Overview: 'understanding-a-match',
  Scoreboard: 'understanding-a-match',
  Rounds: 'understanding-a-match',
  Economy: 'match-analysis',
  Utility: 'match-analysis',
  Combat: 'match-analysis',
  Heatmaps: 'match-analysis',
  Reports: 'reports',
  Details: 'understanding-a-match',
};
const docsBefore = (globalThis.__docs || []).length;
const tabWalk = [];
for (const [t, want] of Object.entries(TAB_TARGETS)) {
  const tabBtn = [...root.querySelectorAll('nav.tabs .tab')].find((b) => b.textContent.trim() === t);
  if (!tabBtn) {
    tabWalk.push(`${t}→NO TAB BUTTON`);
    continue;
  }
  tabBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await sleep();
  const b = root.querySelector('.match-header > button[aria-label="Help for this view"]');
  if (!b) {
    tabWalk.push(`${t}→NO ?`);
    continue;
  }
  b.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await sleep();
  tabWalk.push(`${t}→${(globalThis.__docs || []).at(-1)}`);
}
check(
  'every tab’s ? targets its OWN guide section (the per-tab map, all nine tabs)',
  tabWalk.join(' | ') === Object.entries(TAB_TARGETS).map(([t, s]) => `${t}→${s}`).join(' | '),
  tabWalk.join(' | '),
);
check(
  'the walk fired exactly one openDocs call per tab (the ? is the only opener)',
  (globalThis.__docs || []).length - docsBefore === Object.keys(TAB_TARGETS).length,
  `+${(globalThis.__docs || []).length - docsBefore}`,
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
console.log('I. error dismissals: Match top-level, pinned stats, Economy');
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

// (b) metricError ("Pinned stats unavailable") — needs a pinned metric so
// the pins effect actually runs, then a failing ListMetrics. (w22: pins
// are name-keyed — the fixture pins BY NAME.)
{
  localStorage.setItem('spectra:pinned-metrics', '["util_dmg"]');
  const d = { ...dataFor(13), listMetrics: new Error('metrics backend down') };
  root = await showMatch(d, { routeTab: 'Scoreboard' });
  const p = alertP(root, 'Pinned stats unavailable');
  check('pinned-stats failure renders its own alert', !!p && p.textContent.includes('metrics backend down'), p ? p.textContent.trim() : 'no alert');
  const res = await dismissInPlace(root, 'Pinned stats unavailable', (r) => !!r.querySelector('.data-table.scoreboard'));
  check('✕ clears the pinned-stats error in place (scoreboard table intact)', res.gone && res.mounted && res.noNav, JSON.stringify(res));
  localStorage.removeItem('spectra:pinned-metrics');
}

// (c) The Economy TAB's own error (Economy.svelte) — its fetch has no
// in-view re-trigger, so the ✕ is its dismissal. (The Rounds tab's
// classError alert died with its Class column in W3a — the tab no
// longer reads getEconomy at all, so there is nothing to fail.)
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
  // SCORE_COLS must never wear it), the ⓘ widget must stay OUTSIDE the
  // capped .th-sort button (the cap bounds the label text alone) with
  // NO unpin ✕ beside it (C12 — the scoreboard header's unpin affordance
  // is gone; pins live in the Metric builder / Order dialog), and the
  // th's title tooltip must survive untouched.
  // jsdom has no layout, so the cap RULE itself is pinned from the
  // stylesheet source (section G's precedent).
  // w22: pins are name-keyed — the fixture pins BY NAME (id 7's name).
  localStorage.setItem('spectra:pinned-metrics', '["util_dmg"]');
  const d = {
    ...dataFor(13),
    listMetrics: [
      { id: 7, name: 'util_dmg', title: 'Utility damage per round', doc: 'Grenade damage dealt per round' },
    ],
    // The pin reads STORED rows through the canonical read (design §5:
    // N previewMetric calls → one stored read) beside the state read;
    // fresh + rows → the cells render the numbers.
    getMetricValuesForMatch: [
      { metricId: 7, subjectKey: 'A', value: 12.5, n: 13 },
      { metricId: 7, subjectKey: 'B', value: 9.2, n: 13 },
    ],
    getMetricComputeState: [{ metricId: 7, state: 'fresh' }],
  };
  root = await showMatch(d, { routeTab: 'Scoreboard' });
  await sleep();
  const ths = [...root.querySelectorAll('.data-table.scoreboard thead th')];
  const metricTh = ths.find(
    (t) => (t.querySelector('.th-sort')?.textContent || '').includes('Utility damage per round'),
  );
  const staticTh = ths.find((t) => (t.querySelector('.th-sort')?.textContent || '').trim() === 'Score');
  check(
    'metric header wears m5-mth (the cap scope); static SCORE_COLS never do',
    !!metricTh &&
      metricTh.classList.contains('m5-mth') &&
      !!staticTh &&
      !staticTh.classList.contains('m5-mth'),
    metricTh
      ? `metric=${metricTh.className} static=${staticTh ? staticTh.className : 'no Score header'}`
      : 'no metric header rendered',
  );
  const widgetsInButton = metricTh?.querySelector('.th-sort .m5-ib');
  const widgetCount = metricTh ? metricTh.querySelectorAll(':scope > .m5-ib').length : -1;
  check(
    'the cap covers the label button only — the ⓘ stays outside it (the header’s only widget)',
    !!metricTh && !widgetsInButton && widgetCount === 1,
    `outside-widgets=${widgetCount} inside-button=${!!widgetsInButton}`,
  );
  const unpinWidgets = root.querySelectorAll(
    '.data-table.scoreboard .m5-unpin, .data-table.scoreboard [title="Unpin from scoreboard"]',
  );
  check(
    'the unpin ✕ is gone from the metric headers (pins live in the builder / Order dialog)',
    !!metricTh && unpinWidgets.length === 0,
    `unpin-widgets=${unpinWidgets.length}`,
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
  // w22: pins are name-keyed — the fixture pins BY NAME (id 8's name).
  localStorage.setItem('spectra:pinned-metrics', '["util_dmg"]');
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
    getMetricValuesForMatch: [{ metricId: 8, subjectKey: 'A', value: 12.5, n: 13 }],
    getMetricComputeState: [{ metricId: 8, state: 'fresh' }],
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

// (g) Scoreboard metric value slots run THE state machine (design §5):
// every non-fresh state renders its chip and NEVER a number, fresh
// renders the stored value, a covered unit with a player missing a row
// renders the honest dash — and no rendered metric output ever carries
// a version number or a timestamp (the no-version pin).
{
  // w22: pins are name-keyed — the fixture pins the five names below.
  localStorage.setItem(
    'spectra:pinned-metrics',
    '["m_processing","m_failed","m_behind","m_fresh","m_nodata"]',
  );
  const mk = (id, name) => ({ id, name, title: name, doc: `Formula: ${name}` });
  const d = {
    ...dataFor(13),
    listMetrics: [
      mk(91, 'm_processing'),
      mk(92, 'm_failed'),
      mk(93, 'm_behind'),
      mk(94, 'm_fresh'),
      mk(95, 'm_nodata'),
    ],
    // Only metric 94 has a stored row — and only for alice (bob has
    // none while the unit IS covered → the no-data dash).
    getMetricValuesForMatch: [{ metricId: 94, subjectKey: 'A', value: 8, n: 5 }],
    getMetricComputeState: [
      { metricId: 91, state: 'processing' },
      { metricId: 92, state: 'failed', error: 'upstream vanished' },
      { metricId: 93, state: 'behind' },
      { metricId: 94, state: 'fresh' },
      { metricId: 95, state: 'no-data' },
    ],
  };
  root = await showMatch(d, { routeTab: 'Scoreboard' });
  await sleep();
  const ths = [...root.querySelectorAll('.data-table.scoreboard thead th')];
  const idxOf = (label) =>
    ths.findIndex((t) => (t.querySelector('.th-sort')?.textContent || '').includes(label));
  const rowsOfSb = [...root.querySelectorAll('.data-table.scoreboard tbody tr')];
  const cellAt = (label, player) => {
    const i = idxOf(label);
    const row = rowsOfSb.find((r) =>
      (r.querySelector('.name-cell')?.textContent || '').includes(player),
    );
    return i >= 0 && row ? row.children[i] : null;
  };
  const chipIn = (cell) => cell?.querySelector('.chip.status');

  {
    const cell = cellAt('m_processing', 'alice');
    const chip = chipIn(cell);
    check(
      'processing renders the busy chip with its word, never a number',
      !!chip &&
        chip.classList.contains('busy') &&
        chip.textContent.includes('processing') &&
        !/\d/.test(cell.textContent),
      cell ? cell.textContent.trim() : 'no cell',
    );
  }
  {
    const cell = cellAt('m_failed', 'alice');
    const chip = chipIn(cell);
    check(
      'failed renders the bad chip and carries the engine error as its title',
      !!chip &&
        chip.classList.contains('bad') &&
        chip.textContent.trim() === 'failed' &&
        cell.getAttribute('title') === 'upstream vanished',
      cell ? `${chip ? chip.className : 'no chip'} title=${cell.getAttribute('title')}` : 'no cell',
    );
  }
  {
    const cell = cellAt('m_behind', 'alice');
    const chip = chipIn(cell);
    check(
      'behind renders the idle chip with the design copy',
      !!chip &&
        chip.classList.contains('idle') &&
        chip.textContent.trim() === 'behind' &&
        cell.getAttribute('title') === 'value not available yet — recompute pending',
      cell ? `${chip ? chip.className : 'no chip'} title=${cell.getAttribute('title')}` : 'no cell',
    );
  }
  {
    const freshA = cellAt('m_fresh', 'alice');
    const freshB = cellAt('m_fresh', 'bob');
    check(
      'fresh renders the STORED value (never a chip)',
      !!freshA && freshA.textContent.trim() === '8' && !freshA.querySelector('.chip.status'),
      freshA ? freshA.textContent.trim() : 'no cell',
    );
    check(
      'a covered unit with no row for this player renders the honest dash',
      !!freshB &&
        freshB.textContent.trim() === '—' &&
        freshB.getAttribute('title') === 'no data for this player',
      freshB ? `${freshB.textContent.trim()} title=${freshB.getAttribute('title')}` : 'no cell',
    );
  }
  {
    const cell = cellAt('m_nodata', 'alice');
    check(
      'no-data renders the dash with its copy, never a 0',
      !!cell &&
        cell.textContent.trim() === '—' &&
        cell.getAttribute('title') === 'no data for this player',
      cell ? `${cell.textContent.trim()} title=${cell.getAttribute('title')}` : 'no cell',
    );
  }

  // The no-version pin: no stamp, version number or timestamp anywhere
  // in the metric columns' rendered output (titles + chip text). The
  // regex targets version-shaped and date-shaped strings specifically.
  const leakRe = /version|\bv\d+\b|\d{4}-\d{2}-\d{2}|rule stamp|computed at/i;
  const metricThs = ths.filter((t) => t.classList.contains('m5-mth'));
  const leaks = [];
  for (const th of metricThs) {
    const tip = th.getAttribute('title') || '';
    if (leakRe.test(tip)) leaks.push(`th: ${tip}`);
    for (const w of th.querySelectorAll('.m5-ib')) {
      const t = w.getAttribute('title') || '';
      if (leakRe.test(t)) leaks.push(`th widget: ${t}`);
    }
  }
  for (const tr of rowsOfSb) {
    for (const td of tr.querySelectorAll('td.m5-cell')) {
      const tip = td.getAttribute('title') || '';
      if (leakRe.test(tip)) leaks.push(`cell: ${tip}`);
      for (const chip of td.querySelectorAll('.chip')) {
        const text = chip.textContent || '';
        if (leakRe.test(text)) leaks.push(`chip: ${text}`);
      }
    }
  }
  check(
    'no version number or timestamp appears in any metric cell/header output',
    leaks.length === 0,
    leaks.join(' | '),
  );
  localStorage.removeItem('spectra:pinned-metrics');
}

console.log('K. Scoreboard order: the fixed block first, then the fourteen converted metric columns (W2a + w13d)');
{
  // K. Scoreboard order (unification, 2026-11-18): the fixed block is
  // exactly Name/Team/Score, the five unified count columns arrive as
  // PINNED METRIC columns in their FORMER fixed slots (their shorts ARE
  // the old headers — the rendered header order is byte-identical),
  // then the fourteen converted columns in today's relative order.
  // Pins are set EXPLICITLY here (a present key renders the stored
  // selection verbatim — the absent→DEFAULT_PINS rule resolves a fresh
  // install to these same names, pinned in metricorder.test.js; w22:
  // pins are name-keyed, so the fixture pins BY NAME); under the
  // ABSENT order pref the fixed block leads exactly as the old code
  // prefix did (its negative ranks — metricorder.FIXED_RANKS and the
  // unified metrics' DEFAULT_RANKS slots), and the pins never reorder
  // it. w13d removed KDA and Opening K/D from the fixed block: KDA is a
  // metric column now and the compound cell's halves are the Open K /
  // Open D columns. The catalog also carries the fixed named slot the
  // roster triples read PINS-INDEPENDENT (design §6.1) — assists — and
  // the cards' slots; every slot may be a column as well.
  localStorage.setItem(
    'spectra:pinned-metrics',
    JSON.stringify([
      'kills', 'deaths', 'total_damage', 'utility_damage', 'mvps',
      'assists', 'adr', 'kast', 'hs_pct', 'kd', 'kda', 'two_k',
      'three_k', 'four_k', 'five_k', 'entry_kills', 'entry_deaths',
      'trade_kills', 'best_streak',
    ]),
  );
  const mk = (id, name, label, format) => ({
    id, name, title: label, shortName: label, scope: 'match', format,
    doc: `Formula: ${name}`,
  });
  const d = {
    ...dataFor(13),
    listMetrics: [
      mk(1, 'assists', 'A', 'int'),
      mk(2, 'adr', 'ADR', 'float1'),
      mk(3, 'kast', 'KAST%', 'percent'),
      mk(4, 'hs_pct', 'HS%', 'percent'),
      mk(5, 'kd', 'K/D', 'float2'),
      mk(6, 'kda', 'KDA', 'float2'),
      mk(7, 'two_k', '2K', 'int'),
      mk(8, 'three_k', '3K', 'int'),
      mk(9, 'four_k', '4K', 'int'),
      mk(10, 'five_k', '5K', 'int'),
      mk(11, 'entry_kills', 'Open K', 'int'),
      mk(12, 'entry_deaths', 'Open D', 'int'),
      mk(13, 'trade_kills', 'Trade', 'int'),
      mk(14, 'best_streak', 'Streak', 'int'),
      // The five unified count columns (unification 2026-11-18): they
      // are METRIC columns now — shorts K/D/DMG/Util/MVPs mirror the
      // old fixed headers byte-identically — and the same rows feed the
      // roster triple's K/D halves (pins-independent slots).
      mk(15, 'kills', 'K', 'int'),
      mk(16, 'deaths', 'D', 'int'),
      mk(17, 'total_damage', 'DMG', 'int'),
      mk(18, 'utility_damage', 'Util', 'int'),
      mk(19, 'mvps', 'MVPs', 'int'),
    ],
    // Fresh rows for alice only — bob's converted metric cells render
    // the honest dash (the unit IS covered, he just has no row) — plus
    // the roster triple's K/D seed rows for BOTH players (the halves
    // render their stored values; bob's missing assists row keeps
    // dashing his A) and both players' count rows for the unified
    // columns (alice's render, mirroring the raw fixture).
    getMetricValuesForMatch: [
      { metricId: 1, subjectKey: 'A', value: 4, n: 13 },
      { metricId: 2, subjectKey: 'A', value: 90, n: 13 },
      { metricId: 3, subjectKey: 'A', value: 0.71, n: 13 },
      { metricId: 4, subjectKey: 'A', value: 0.5, n: 13 },
      { metricId: 5, subjectKey: 'A', value: 1.67, n: 13 },
      { metricId: 6, subjectKey: 'A', value: 2.33, n: 13 },
      { metricId: 7, subjectKey: 'A', value: 3, n: 13 },
      { metricId: 8, subjectKey: 'A', value: 1, n: 13 },
      { metricId: 9, subjectKey: 'A', value: 0, n: 13 },
      { metricId: 10, subjectKey: 'A', value: 0, n: 13 },
      { metricId: 11, subjectKey: 'A', value: 12, n: 13 },
      { metricId: 12, subjectKey: 'A', value: 9, n: 13 },
      { metricId: 13, subjectKey: 'A', value: 5, n: 13 },
      { metricId: 14, subjectKey: 'A', value: 7, n: 13 },
      { metricId: 15, subjectKey: 'A', value: 20, n: 13 },
      { metricId: 16, subjectKey: 'A', value: 12, n: 13 },
      { metricId: 15, subjectKey: 'B', value: 18, n: 13 },
      { metricId: 16, subjectKey: 'B', value: 13, n: 13 },
      { metricId: 17, subjectKey: 'A', value: 2450, n: 13 },
      { metricId: 18, subjectKey: 'A', value: 150, n: 13 },
      { metricId: 19, subjectKey: 'A', value: 3, n: 13 },
      { metricId: 17, subjectKey: 'B', value: 1980, n: 13 },
      { metricId: 18, subjectKey: 'B', value: 120, n: 13 },
      { metricId: 19, subjectKey: 'B', value: 2, n: 13 },
    ],
    getMetricComputeState: Array.from({ length: 19 }, (_, i) => ({ metricId: i + 1, state: 'fresh' })),
  };
  root = await showMatch(d, { routeTab: 'Scoreboard' });
  await sleep();
  const ths = [...root.querySelectorAll('.data-table.scoreboard thead th')];
  const labelOf = (th) => (th.querySelector('.th-sort')?.textContent || th.textContent || '').trim();
  const labels = ths.map(labelOf);
  const fixed = ['Name', 'Team', 'K', 'D', 'DMG', 'Util', 'MVPs', 'Score'];
  const converted = ['A', 'ADR', 'KAST%', 'HS%', 'K/D', 'KDA', '2K', '3K', '4K', '5K', 'Open K', 'Open D', 'Trade', 'Streak'];
  check(
    'the scoreboard leads with Name/Team/Score and the unified count columns in their FORMER slots (byte-identical header order)',
    JSON.stringify(labels.slice(0, fixed.length)) === JSON.stringify(fixed),
    JSON.stringify(labels),
  );
  check(
    'the fourteen converted columns follow, in today’s relative order',
    JSON.stringify(labels.slice(fixed.length)) === JSON.stringify(converted),
    JSON.stringify(labels.slice(fixed.length)),
  );
  check(
    'the unified count headers wear m5-mth like every metric (positions 2–6), the true statics (Name/Team/Score) never do — nineteen metric headers total (5 unified + 14)',
    ths.filter((t) => t.classList.contains('m5-mth')).length === 19 &&
      !ths[0].classList.contains('m5-mth') &&
      !ths[1].classList.contains('m5-mth') &&
      !ths[7].classList.contains('m5-mth') &&
      ths.slice(2, 7).every((t) => t.classList.contains('m5-mth')),
    `m5=${ths.filter((t) => t.classList.contains('m5-mth')).length} first8=${ths.slice(0, 8).map((t) => `${labelOf(t)}:${t.classList.contains('m5-mth') ? 'y' : 'n'}`).join(',')}`,
  );
  const rowsOfSb = [...root.querySelectorAll('.data-table.scoreboard tbody tr')];
  const alice = rowsOfSb.find((r) => (r.querySelector('.name-cell')?.textContent || '').includes('alice'));
  const bob = rowsOfSb.find((r) => (r.querySelector('.name-cell')?.textContent || '').includes('bob'));
  const cellAt = (i) => (alice ? alice.children[i].textContent.trim() : 'no alice row');
  const first = fixed.length;
  check(
    'the metric cells render through fmtMetric (4 / 90.0 / 71% / 50% / 1.67 / 2.33 / 3 / 1 / 0 / 0 / 12 / 9 / 5 / 7)',
    cellAt(first) === '4' &&
      cellAt(first + 1) === '90.0' &&
      cellAt(first + 2) === '71%' &&
      cellAt(first + 3) === '50%' &&
      cellAt(first + 4) === '1.67' &&
      cellAt(first + 5) === '2.33' &&
      cellAt(first + 6) === '3' &&
      cellAt(first + 7) === '1' &&
      cellAt(first + 8) === '0' &&
      cellAt(first + 9) === '0' &&
      cellAt(first + 10) === '12' &&
      cellAt(first + 11) === '9' &&
      cellAt(first + 12) === '5' &&
      cellAt(first + 13) === '7',
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((i) => cellAt(first + i)).join(' | '),
  );

  // w13d (owner, 2026-11-16): the Opening K/D compound cell is GONE —
  // its halves are ordinary metric columns now (Open K / Open D), so
  // the numbers the compound used to compose (12/9) render as two
  // cells in the metric tail, and a covered player with no metric rows
  // gets the honest dash with the state in the title exactly like
  // every other metric column (the row still carries NO
  // openingKills/openingDeaths fields, so '12'/'9' can only come from
  // the metric read).
  const openKIdx = labels.indexOf('Open K');
  const openDIdx = labels.indexOf('Open D');
  check(
    'w13d: the compound cell is gone — Open K / Open D render as their own metric columns (12 / 9 for alice)',
    openKIdx >= fixed.length &&
      openDIdx >= fixed.length &&
      alice.children[openKIdx].textContent.trim() === '12' &&
      alice.children[openDIdx].textContent.trim() === '9',
    alice && openKIdx >= 0
      ? `${alice.children[openKIdx].textContent.trim()} / ${alice.children[openDIdx].textContent.trim()}`
      : 'no cells',
  );
  check(
    'a covered player with no metric rows gets the honest dash in both halves (—) with the state in the title',
    openKIdx >= 0 &&
      bob.children[openKIdx].textContent.trim() === '—' &&
      bob.children[openKIdx].getAttribute('title') === 'no data for this player' &&
      bob.children[openDIdx].textContent.trim() === '—',
    openKIdx >= 0 && bob
      ? bob.children[openKIdx].textContent.trim() + ' title=' + bob.children[openKIdx].getAttribute('title')
      : 'no cell',
  );

  // Q2 compound cell #2 — the Overview roster triples: ALL THREE
  // halves read their seed rows now (owner ruling 2026-11-17 — the
  // fixture scripts kills/deaths rows beside the raw fields, so the
  // numbers here can only come from the metric read), and bob's raw
  // assists=5 still renders as the dash because no assists row exists
  // for him — the source switch, pinned.
  root = await showMatch(d, { routeTab: 'Overview' });
  await sleep();
  const rosterSections = [...root.querySelectorAll('.roster-grid section')];
  const rosterCell = (sectionIdx, name) => {
    const rows = [...(rosterSections[sectionIdx]?.querySelectorAll('tbody tr') || [])];
    const tr = rows.find((r) => r.textContent.includes(name));
    return tr ? tr.children[1] : null;
  };
  const aliceKda = rosterCell(0, 'alice');
  const bobKda = rosterCell(1, 'bob');
  check(
    'the roster triple renders the seeded K/D + the metric A half (20/12/4), no tooltip while fresh',
    aliceKda?.textContent.trim() === '20/12/4' && !aliceKda.hasAttribute('title'),
    aliceKda ? aliceKda.textContent.trim() : 'no cell',
  );
  check(
    'a roster player with no assists row gets the honest A dash with the state title (raw 5 ignored)',
    bobKda?.textContent.trim() === '18/13/—' &&
      bobKda?.getAttribute('title') === 'no data for this player',
    bobKda ? `${bobKda.textContent.trim()} title=${bobKda.getAttribute('title')}` : 'no cell',
  );

  // N4 wire-through (unification shape, 2026-11-18): the VISIBILITY pref
  // removes a live fixed column from THIS view — the ordering dialog's
  // `metric_hidden_match` written through the same kvstore read
  // (readHidden) — while every other column keeps its position. The
  // fixture also carries the STALE '@K' key (retired with the
  // unification): it must mark NOTHING — K is a metric column now, so
  // it stays exactly where it was (the by-construction drop). Team (the
  // live key) drops. The default (absent key) is the fixed-leads
  // composition the pins above assert.
  root = await showMatch(
    { ...d, getPref: (key) => (key === 'metric_hidden_match' ? ['@K', '@Team'] : undefined) },
    { routeTab: 'Scoreboard' },
  );
  await sleep();
  {
    const hiddenLabels = [...root.querySelectorAll('.data-table.scoreboard thead th')].map(labelOf);
    check(
      'N4: hiding Team drops exactly the Team column; the stale @K key marks nothing (K keeps its slot) — every metric keeps its place',
      !hiddenLabels.includes('Team') &&
        hiddenLabels.includes('K') &&
        JSON.stringify(hiddenLabels.filter((l) => l !== 'Team')) ===
          JSON.stringify(['Name', 'K', 'D', 'DMG', 'Util', 'MVPs', 'Score', ...converted]),
      JSON.stringify(hiddenLabels),
    );
  }
  localStorage.removeItem('spectra:pinned-metrics');
}

console.log('L. Scoreboard frozen player column (CSS-text pins — jsdom has no layout)');
{
  // The freeze (scoreboard-expand, part b; the row expansion itself was
  // removed by C13 — the NAME cell is now the ONE frozen column) is pure
  // CSS: jsdom computes no layout, so the RULES themselves are pinned
  // from the stylesheet — selector text included, because the
  // direct-child scoping IS the guard (it keeps a nested mini table, also
  // .data-table, out of the freeze). No util-grid / container-type pins
  // exist by design — that float-centered expansion never landed.
  const cssSb = readFileSync('public/style.css', 'utf8');
  const ruleOf = (src, sel) => {
    const i = src.indexOf(sel);
    if (i < 0) return null;
    const open = src.indexOf('{', i);
    if (open < 0) return null;
    const close = src.indexOf('}', open);
    return close < 0 ? null : src.slice(open + 1, close);
  };
  const body = (rule) => (rule ? rule.replace(/\s+/g, ' ').trim() : 'rule not found in public/style.css');

  const nameRule = ruleOf(cssSb, '.scoreboard > tbody > tr > td.name-cell {');
  check(
    'the name cell IS the frozen column (sticky, left 0, opaque bg, seam shadow)',
    !!nameRule &&
      /position:\s*sticky/.test(nameRule) &&
      /left:\s*0\b/.test(nameRule) &&
      /background:\s*var\(--bg\)/.test(nameRule) &&
      /box-shadow:/.test(nameRule),
    body(nameRule),
  );

  const headRule = ruleOf(cssSb, '.scoreboard > thead > tr > th:first-child {');
  check(
    'the frozen header cell sticks at the scrollport edge and out-paints the ordinary sticky headers (z-index 2)',
    !!headRule &&
      /position:\s*sticky/.test(headRule) &&
      /z-index:\s*2/.test(headRule) &&
      /left:\s*0\b/.test(headRule),
    body(headRule),
  );

  const hoverRule = ruleOf(cssSb, '.scoreboard > tbody > tr:hover > td.name-cell {');
  check(
    'the row-hover twin lights the frozen cell (the tr’s hover paints under its own background)',
    !!hoverRule && /var\(--list-hover\)/.test(hoverRule),
    body(hoverRule),
  );
}

console.log('M. Scoreboard sort chain + transpose (owner C14)');
{
  // The owner's three scoreboard changes, pinned end to end over ONE
  // ≥3-player fixture:
  //   1. sorts ACCUMULATE — every click folds over the sequence on
  //      screen (the prior order IS the tiebreak), so a damage sort
  //      survives inside the death ties and an all-tied key moves
  //      nothing at all (minimum row swaps);
  //   2. transpose RETAINS the row order and TOGGLES the column sort
  //      marks off — sort → transpose → transpose back keeps the order
  //      with zero `.sorted` anywhere;
  //   3. the transposed shape = players as COLUMNS (retained order,
  //      name + side chip + profile link) and stats as ROWS (the fixed
  //      block minus Name/Team, then the pinned metric sequence), the
  //      transpose button in the (0,0) Name header in BOTH shapes, and
  //      the stat-label column frozen (CSS-text pins at the end).
  // mvps is deliberately IDENTICAL for all three players (the fully-tied
  // key); deaths carries a two-way tie so the tiebreak is observable;
  // the store order for this fixture is kills DESC (GetScoreboard's
  // default) — bob 20, carol 15, alice 10.
  const sb3 = [
    { steamId: '76561198000000002', name: 'bob', side: 't', kills: 20, deaths: 5, totalDamage: 100, utilityDamage: 60, mvps: 1, score: 11 },
    { steamId: '76561198000000003', name: 'carol', side: 'ct', kills: 15, deaths: 3, totalDamage: 200, utilityDamage: 50, mvps: 1, score: 12 },
    { steamId: '76561198000000001', name: 'alice', side: 'ct', kills: 10, deaths: 5, totalDamage: 300, utilityDamage: 40, mvps: 1, score: 13 },
  ];
  localStorage.removeItem('spectra:pinned-metrics');

  const table = () => root.querySelector('.data-table.scoreboard');
  const ths = () => [...table().querySelectorAll('thead th')];
  const sortBtn = (label) =>
    ths()
      .map((th) => th.querySelector('.th-sort'))
      .find((b) => b && b.getAttribute('aria-label') === `Sort by ${label}`);
  const transposeBtn = () => table().querySelector('thead th:first-child .sb-transpose');
  const rowOrder = () =>
    [...table().querySelectorAll('tbody tr')].map(
      (tr) => (tr.querySelector('.name-cell')?.textContent || '').trim(),
    );
  const marks = () =>
    [...table().querySelectorAll('thead th .th-sort.sorted')].map((b) => b.textContent.trim());
  const playerCols = () =>
    [...table().querySelectorAll('thead th.sb-player .name-link')].map((b) => b.textContent.trim());
  const statLabels = () =>
    [...table().querySelectorAll('tbody tr')].map(
      (tr) => (tr.querySelector('th[scope="row"]')?.textContent || '').trim(),
    );
  // One transposed cell: the stat row's label + the named player's column
  // (children[0] is the frozen stat-label header, so the player sits at
  // index +1).
  const cellOf = (label, player) => {
    const tr = [...table().querySelectorAll('tbody tr')].find(
      (r) => (r.querySelector('th[scope="row"]')?.textContent || '').trim() === label,
    );
    const i = playerCols().indexOf(player);
    return tr && i >= 0 ? tr.children[i + 1].textContent.trim() : 'no cell';
  };

  root = await showMatch({ ...dataFor(13), getScoreboard: sb3 }, { routeTab: 'Scoreboard' });
  await sleep();

  check(
    'the seed renders the store order (kills DESC) with the default kills mark',
    JSON.stringify(rowOrder()) === JSON.stringify(['bob', 'carol', 'alice']) &&
      JSON.stringify(marks()) === JSON.stringify(['K']) &&
      !!sortBtn('DMG') &&
      !!sortBtn('D') &&
      !!sortBtn('MVPs'),
    `${rowOrder()} marks=${marks()} dmgs=${!!sortBtn('DMG')}`,
  );

  clickEl(sortBtn('DMG'));
  await sleep();
  check(
    'sorting DMG desc reorders the rows (alice 300, carol 200, bob 100)',
    JSON.stringify(rowOrder()) === JSON.stringify(['alice', 'carol', 'bob']) &&
      JSON.stringify(marks()) === JSON.stringify(['DMG']),
    `${rowOrder()} marks=${marks()}`,
  );

  clickEl(sortBtn('D'));
  await sleep();
  // deaths desc: alice/bob 5 ahead of carol 3 — and inside that 5-tie the
  // PRIOR (damage) order survives: alice 300 before bob 100.
  const dmgIdx = ths().findIndex(
    (th) => th.querySelector('.th-sort')?.getAttribute('aria-label') === 'Sort by DMG',
  );
  const dmgOf = (name) =>
    [...table().querySelectorAll('tbody tr')]
      .find((tr) => (tr.querySelector('.name-cell')?.textContent || '').includes(name))
      ?.children[dmgIdx].textContent.trim();
  check(
    'a second sort folds: the damage order still holds inside the death tie (prior order = tiebreak)',
    JSON.stringify(rowOrder()) === JSON.stringify(['alice', 'bob', 'carol']) &&
      dmgOf('alice') === '300' &&
      dmgOf('bob') === '100',
    `${rowOrder()} dmg alice=${dmgOf('alice')} bob=${dmgOf('bob')}`,
  );
  check(
    'only the newest entry owns the mark (DMG dropped it)',
    JSON.stringify(marks()) === JSON.stringify(['D']),
    JSON.stringify(marks()),
  );

  clickEl(sortBtn('MVPs'));
  await sleep();
  check(
    'a fully-tied key moves nothing (MVPs are 1 for all three) — zero row swaps',
    JSON.stringify(rowOrder()) === JSON.stringify(['alice', 'bob', 'carol']) &&
      JSON.stringify(marks()) === JSON.stringify(['MVPs']),
    `${rowOrder()} marks=${marks()}`,
  );

  {
    const corner = table().querySelector('thead th:first-child');
    const tBtn = corner?.querySelector('.sb-transpose');
    check(
      'the transpose button rides the Name header’s children slot (outside .th-sort, name sorting intact)',
      !!tBtn &&
        !!corner.querySelector('.th-sort') &&
        !corner.querySelector('.th-sort .sb-transpose') &&
        (corner.querySelector('.th-sort')?.getAttribute('aria-label') === 'Sort by Name'),
      corner ? corner.innerHTML.slice(0, 200) : 'no corner',
    );
  }

  clickEl(transposeBtn());
  await sleep();
  check(
    'transposed: the player columns keep the DISPLAYED order (not the store order)',
    table().classList.contains('transposed') &&
      JSON.stringify(playerCols()) === JSON.stringify(['alice', 'bob', 'carol']),
    `${table()?.className} cols=${playerCols()}`,
  );
  check(
    'transposing toggles every column sort mark off',
    marks().length === 0,
    JSON.stringify(marks()),
  );
  {
    const corner = table().querySelector('thead th:first-child');
    check(
      'the transposed corner is still the Name SortTh carrying the transpose button in its children slot',
      !!corner?.querySelector('.th-sort') &&
        corner.querySelector('.th-sort')?.getAttribute('aria-label') === 'Sort by Name' &&
        !!corner.querySelector('.sb-transpose') &&
        !corner.querySelector('.th-sort .sb-transpose') &&
        corner === table().querySelector('thead tr > th:first-child'),
      corner ? corner.innerHTML.slice(0, 200) : 'no corner',
    );
    check(
      'the transpose button wears the arrow-swap glyph (codicon-arrow-swap)',
      !!corner?.querySelector('.sb-transpose .codicon-arrow-swap') &&
        !corner?.querySelector('.sb-transpose .codicon-split-horizontal'),
      corner?.querySelector('.sb-transpose')?.innerHTML.slice(0, 120) || 'no corner',
    );
  }
  check(
    'one row per stat, in the COLUMN order (the unified counts in their former slots + the default-pinned slot metrics; Name/Team excluded)',
    JSON.stringify(statLabels()) ===
      JSON.stringify(['K', 'D', 'DMG', 'Util', 'MVPs', 'Score', 'A', 'ADR', 'Open K']),
    JSON.stringify(statLabels()),
  );
  check(
    'the stat labels are plain row headers — no sort button on this axis (ruling 2)',
    [...table().querySelectorAll('tbody tr')].every(
      (tr) => tr.querySelector('th[scope="row"]') && tr.children[0].tagName === 'TH',
    ) &&
      table().querySelectorAll('tbody .th-sort').length === 0 &&
      table().querySelectorAll('tbody tr').length === 9,
    `rows=${table().querySelectorAll('tbody tr').length} sortbtns=${table().querySelectorAll('tbody .th-sort').length}`,
  );
  check(
    'transposed cells keep their renderers (K 10/20/15 · DMG 300/100/200)',
    cellOf('K', 'alice') === '10' &&
      cellOf('K', 'bob') === '20' &&
      cellOf('K', 'carol') === '15' &&
      cellOf('DMG', 'alice') === '300' &&
      cellOf('DMG', 'bob') === '100' &&
      cellOf('DMG', 'carol') === '200',
    `K=${cellOf('K', 'alice')}/${cellOf('K', 'bob')}/${cellOf('K', 'carol')} DMG=${cellOf('DMG', 'alice')}/${cellOf('DMG', 'bob')}/${cellOf('DMG', 'carol')}`,
  );
  {
    const playerThs = [...table().querySelectorAll('thead th.sb-player')];
    check(
      'the player column headers keep the profile link (ruling 4 — the name-cell affordance)',
      playerThs.length === 3 &&
        playerThs.every((th) => !!th.querySelector('button.name-link')),
      `player-ths=${playerThs.length} links=${playerThs.filter((th) => th.querySelector('button.name-link')).length}`,
    );
    check(
      'the player column headers carry the side chip (ruling 1 — Name/Team move INTO them)',
      playerThs.length === 3 &&
        playerThs.every((th) => {
          const chip = th.querySelector('.chip');
          return (
            !!chip &&
            ['Alpha', 'Beta'].includes(chip.textContent.trim()) &&
            (chip.classList.contains('team-start-ct') || chip.classList.contains('team-start-t'))
          );
        }),
      playerThs.map((th) => `${JSON.stringify(th.querySelector('.chip')?.textContent)} ${th.querySelector('.chip')?.className || 'no chip'}`).join(' | '),
    );
    // W3a: the name BLOCK — the wrapper holds the name (button shape
    // here) and the chip follows it as the next sibling, so a block
    // wrapper drops the chip onto its own line (the stylesheet pin is
    // below; the bare-name shape gets its own mount at the end of M).
    check(
      'the name is wrapped in .sb-name with the side chip as its following sibling (button shape)',
      playerThs.length === 3 &&
        playerThs.every((th) => {
          const name = th.querySelector('.sb-name');
          return !!name && name.nextElementSibling?.classList.contains('chip');
        }),
      playerThs.map((th) => th.innerHTML.slice(0, 90)).join(' | '),
    );
  }
  {
    const navBefore = (globalThis.__nav || []).length;
    const firstCell = table().querySelector('tbody tr')?.children[1];
    if (firstCell) clickEl(firstCell);
    await sleep();
    check(
      'a transposed stat row is not a player row — no row-click → replay (ruling 4)',
      (globalThis.__nav || []).length === navBefore,
      `nav ${(globalThis.__nav || []).length} → ${navBefore}`,
    );
  }

  // The owner's side note, made mechanical: the stat-label column is the
  // frozen leftmost one through the transpose (jsdom has no layout, so
  // the RULES are pinned from the stylesheet — section L's precedent).
  {
    const cssSb = readFileSync('public/style.css', 'utf8');
    const ruleOf = (src, sel) => {
      const i = src.indexOf(sel);
      if (i < 0) return null;
      const open = src.indexOf('{', i);
      if (open < 0) return null;
      const close = src.indexOf('}', open);
      return close < 0 ? null : src.slice(open + 1, close);
    };
    const body = (rule) => (rule ? rule.replace(/\s+/g, ' ').trim() : 'rule not found in public/style.css');

    const labelRule = ruleOf(cssSb, '.scoreboard.transposed > tbody > tr > th:first-child {');
    check(
      'the transposed stat-label column is frozen at left 0 (sticky, opaque, seam, no vertical stick)',
      !!labelRule &&
        /position:\s*sticky/.test(labelRule) &&
        /top:\s*auto/.test(labelRule) &&
        /left:\s*0\b/.test(labelRule) &&
        /background:\s*var\(--bg\)/.test(labelRule) &&
        /box-shadow:/.test(labelRule),
      body(labelRule),
    );

    const hoverRule = ruleOf(cssSb, '.scoreboard.transposed > tbody > tr:hover > th:first-child {');
    check(
      'the row-hover twin lights the frozen stat label (the tr’s hover paints under its own background)',
      !!hoverRule && /var\(--list-hover\)/.test(hoverRule),
      body(hoverRule),
    );

    const playerRule = ruleOf(cssSb, '.scoreboard.transposed > thead > tr > th.sb-player {');
    check(
      'the player headers opt out of the table-header chrome (a name is never uppercased or muted)',
      !!playerRule &&
        /text-transform:\s*none/.test(playerRule) &&
        /letter-spacing:\s*normal/.test(playerRule) &&
        /color:\s*inherit/.test(playerRule),
      body(playerRule),
    );

    const nameRule = ruleOf(
      cssSb,
      '.scoreboard.transposed > thead > tr > th.sb-player .sb-name {',
    );
    check(
      'the name block is display:block — the chip drops to its own line (jsdom has no layout, the rule is the pin)',
      !!nameRule && /display:\s*block/.test(nameRule),
      body(nameRule),
    );
  }

  clickEl(transposeBtn());
  await sleep();
  check(
    'transpose back: the rows keep the displayed order and every mark stays off',
    JSON.stringify(rowOrder()) === JSON.stringify(['alice', 'bob', 'carol']) &&
      marks().length === 0,
    `${rowOrder()} marks=${marks()}`,
  );

  // The owner's literal example: sort by kills → transpose → transpose
  // back ⇒ still kill-ordered, header no longer marked.
  clickEl(sortBtn('K'));
  await sleep();
  check(
    'sorting K marks it again (the chain restarts from the retained order)',
    JSON.stringify(marks()) === JSON.stringify(['K']),
    JSON.stringify(marks()),
  );
  clickEl(transposeBtn());
  await sleep();
  clickEl(transposeBtn());
  await sleep();
  check(
    'sort K → transpose → transpose back: still kill-ordered, ZERO marks',
    JSON.stringify(rowOrder()) === JSON.stringify(['bob', 'carol', 'alice']) &&
      marks().length === 0,
    `${rowOrder()} marks=${marks()}`,
  );

  // Transposed METRIC rows: the same pinned-metric sequence and the same
  // cell renderers (value / honest dash / state chip) on the stat axis.
  // w22: pins are name-keyed — the fixture pins BY NAME (ids 91/92's names).
  localStorage.setItem('spectra:pinned-metrics', '["m_one","m_two"]');
  const mk = (id, name, label) => ({
    id,
    name,
    title: label,
    shortName: label,
    scope: 'match',
    doc: `Formula: ${name}`,
  });
  const d2 = {
    ...dataFor(13),
    getScoreboard: sb3,
    listMetrics: [mk(91, 'm_one', 'One'), mk(92, 'm_two', 'Two')],
    // Fresh row for alice only; metric 92 has NO rows and a behind state.
    getMetricValuesForMatch: [{ metricId: 91, subjectKey: '76561198000000001', value: 7, n: 13 }],
    getMetricComputeState: [
      { metricId: 91, state: 'fresh' },
      { metricId: 92, state: 'behind' },
    ],
  };
  root = await showMatch(d2, { routeTab: 'Scoreboard' });
  await sleep();
  clickEl(transposeBtn());
  await sleep();
  check(
    'the pinned metrics follow the remaining fixed stat row (Score — this fixture\'s catalog carries no count metric) in the metricorder sequence',
    JSON.stringify(statLabels()) === JSON.stringify(['Score', 'One', 'Two']),
    JSON.stringify(statLabels()),
  );
  check(
    'metric stat cells keep their renderers: the stored value for the covered player, the honest dash otherwise',
    cellOf('One', 'alice') === '7' && cellOf('One', 'bob') === '—',
    `One alice=${cellOf('One', 'alice')} bob=${cellOf('One', 'bob')}`,
  );
  {
    const tr = [...table().querySelectorAll('tbody tr')].find(
      (r) => (r.querySelector('th[scope="row"]')?.textContent || '').trim() === 'Two',
    );
    const chip = tr?.children[1].querySelector('.chip.status');
    check(
      'a state chip lands in the transposed metric row exactly as in the normal cell',
      !!chip && chip.classList.contains('idle') && chip.textContent.includes('behind'),
      chip ? `${chip.className} ${chip.textContent.trim()}` : 'no chip',
    );
  }
  // W3a (V1): the OTHER name shape — a player without a Steam id renders
  // its BARE name inside the same block wrapper, so the chip still drops
  // to its own line (one wrapper covers both shapes).
  {
    const sbMixed = [
      ...sb3,
      {
        steamId: 'X', name: 'zed', side: 'ct', kills: 5, deaths: 5,
        totalDamage: 10, utilityDamage: 0, mvps: 0, score: 1,
      },
    ];
    root = await showMatch({ ...dataFor(13), getScoreboard: sbMixed }, { routeTab: 'Scoreboard' });
    await sleep();
    // The transposed shape is registry-owned and match-scoped: the mounts
    // above left it ON, so only flip when the restored shape is the other
    // way (never toggle a shape that is already the one we want).
    if (!table().classList.contains('transposed')) {
      clickEl(transposeBtn());
      await sleep();
    }
    const zedTh = [...table().querySelectorAll('thead th.sb-player')].find(
      (th) => th.querySelector('.sb-name')?.textContent.trim() === 'zed',
    );
    const zedName = zedTh?.querySelector('.sb-name');
    check(
      'the bare-name shape is wrapped too (no profile button, chip still the following sibling)',
      !!zedTh &&
        !!zedName &&
        !zedName.querySelector('button') &&
        zedName.nextElementSibling?.classList.contains('chip'),
      zedTh ? zedTh.innerHTML.slice(0, 160) : 'no zed header',
    );
  }
  localStorage.removeItem('spectra:pinned-metrics');
}

// w25 — the shape pref's SEED side (Match's pref-gated selection seed).
// This driver's registry is never reset anywhere else and the harness id
// is fixed (match:3:selection), so section M's transpose flips are still
// in it — every fresh-registry pin below starts with resetViewState() on
// the SAME instance Match links (combat.dom.mjs's copied-tree import).
const viewstate = await import(pathToFileURL(join(dir, 'viewstate.svelte.js')).href);

console.log('N. the scoreboard-opens-transposed pref (w25): the shape a match opens in, session record wins, default off');
{
  // Scripted through the per-key getPref function (the N4 hidden-column
  // idiom above): absent keys fall through to undefined ⇒ off.
  let prefReads = 0;
  const sbOn = {
    ...dataFor(13),
    getPref: (k) => {
      if (k === 'scoreboard_starts_transposed') {
        prefReads += 1;
        return true;
      }
      return undefined;
    },
  };
  const table = () => root.querySelector('.data-table.scoreboard');
  const tBtn = () => table()?.querySelector('thead th:first-child .sb-transpose');
  const isTransposed = () => !!table() && table().classList.contains('transposed');
  const pressed = () => tBtn()?.getAttribute('aria-pressed');

  // (1) fresh registry + pref ON → the scoreboard opens TRANSPOSED with
  // NO click at all (the pref-gated seed applies the pref default).
  viewstate.resetViewState();
  root = await showMatch(sbOn, { routeTab: 'Scoreboard' });
  await sleep();
  check(
    '(1) pref ON + fresh registry → the scoreboard opens TRANSPOSED with no click (the button reads pressed)',
    isTransposed() && pressed() === 'true' && prefReads >= 1,
    `transposed=${isTransposed()} pressed=${pressed()} prefReads=${prefReads}`,
  );

  // (3) a session RECORD wins over the pref: flip back to player rows
  // (recorded through the write-through), then remount with the pref
  // still ON → it stays player rows. Runs BEFORE (2): the record it
  // asserts must survive from (1), and (2)'s fresh reset would wipe it.
  const readsAfterFirst = prefReads;
  clickEl(tBtn());
  await sleep();
  root = await showMatch(sbOn, { routeTab: 'Scoreboard' });
  await sleep();
  check(
    '(3) a session record wins over the pref — flipped to player rows, remount with the pref still ON stays player rows',
    !isTransposed() && pressed() === 'false' && prefReads > readsAfterFirst,
    `transposed=${isTransposed()} pressed=${pressed()} prefReads=${prefReads} (was ${readsAfterFirst})`,
  );

  // (2) fresh registry + pref ABSENT → player rows (the default is OFF).
  viewstate.resetViewState();
  root = await showMatch(dataFor(13), { routeTab: 'Scoreboard' });
  await sleep();
  check(
    '(2) pref absent + fresh registry → NOT transposed (the default is off)',
    !isTransposed() && pressed() === 'false',
    `transposed=${isTransposed()} pressed=${pressed()}`,
  );
}

console.log('O. ME0/M1: Overview top-card SELECTION (identity seeds: tie-break, reversed order, all-zero set, empty set, behind)');
{
  const labelOf = (c) => c.querySelector('.field-label')?.textContent || '';
  const topCards = (r) =>
    [...r.querySelectorAll('.stat-cell')].filter((c) =>
      ['Top fragger', 'Best ADR', 'Most util', 'Entry opens', 'Most MVPs'].some((l) => labelOf(c).includes(l)),
    );
  const card = (r, label) => topCards(r).find((c) => labelOf(c).includes(label));
  const val = (c) => c?.querySelector('.stat-value')?.textContent ?? '';
  const who = (c) => c?.querySelector('.stat-sub')?.textContent ?? '';

  // (1) Selection over a kills-DESC seed with TIES (kills 10/10, util
  // 50/50) and an ALL-ZERO metric set (entry opens, MVPs all 0).
  // MIGRATED 2026-11-18 (metrics Phase 7): the cards read the five
  // identity seeds' stored rows — the retired maxBy/first-row rule is
  // gone. Here the two WHO rules AGREE (alice's key 'A' < bob's 'B', and
  // alice is also the first view row); scenario (1b) separates them.
  // bob wins Best ADR outright (90 > 80) either way.
  //
  // NUMBER source pin (owner item 4, 2026-11-18): cardSeededRead
  // patches the twins' stored rows so they DELIBERATELY disagree with
  // the raw roster fields behind them (the identity rows still argmax
  // over the raw fixture — WHO is unchanged): a card printing the raw
  // column (10/2/3 · 90.0 · 50 · 0 · 0) fails; the stored metric row
  // (11/3/4 · 91.5 · 55 · 3 · 7) shows. The numbers below ARE that pin.
  const CARD_SEED_PATCH = Object.freeze({
    kills: { A: 11 },
    deaths: { A: 3 },
    assists: { A: 4 },
    adr: { B: 91.5 },
    utility_damage: { A: 55 },
    entry_kills: { A: 3 },
    mvps: { A: 7 },
  });
  const seedNameById = new Map(SEED_DEFS.map((d) => [d.id, d.name]));
  const cardSeededRead = (matchID, ids) =>
    dataFor(13).getMetricValuesForMatch(matchID, ids).map((r) => {
      const v = CARD_SEED_PATCH[seedNameById.get(r.metricId) || '']?.[r.subjectKey];
      return v === undefined ? r : { ...r, value: v };
    });
  const tied = {
    ...dataFor(13),
    getScoreboard: [
      { steamId: 'A', name: 'alice', side: 'ct', kills: 10, deaths: 2, assists: 3, adr: 80, mvps: 0, utilityDamage: 50, entryKills: 0 },
      { steamId: 'B', name: 'bob', side: 't', kills: 10, deaths: 4, assists: 1, adr: 90, mvps: 0, utilityDamage: 50, entryKills: 0 },
      { steamId: 'C', name: 'carol', side: 'ct', kills: 5, deaths: 9, assists: 2, adr: 40, mvps: 0, utilityDamage: 10, entryKills: 0 },
    ],
    getMetricValuesForMatch: cardSeededRead,
  };
  root = await showMatch(tied, { routeTab: '' });
  await sleep();
  check('M1: five top cards render on Overview', topCards(root).length === 5, String(topCards(root).length));
  check(
    'M1: Top fragger tie (10/10) → the identity seed picks alice (key ASC: A < B), K/D/A from her STORED rows (11/3/4 — the raw line 10/2/3 never prints)',
    val(card(root, 'Top fragger')) === '11/3/4' && who(card(root, 'Top fragger')).includes('alice'),
    `${val(card(root, 'Top fragger'))} / ${who(card(root, 'Top fragger'))}`,
  );
  check(
    'M1: Best ADR → the outright max (bob), number from the STORED adr row (91.5 — raw 90.0 never prints)',
    val(card(root, 'Best ADR')) === '91.5' && who(card(root, 'Best ADR')).includes('bob'),
    `${val(card(root, 'Best ADR'))} / ${who(card(root, 'Best ADR'))}`,
  );
  check(
    'M1: Most util tie (50/50) → the identity seed picks alice (key ASC); the number is her STORED row (55 — raw 50 never prints)',
    val(card(root, 'Most util')) === '55' && who(card(root, 'Most util')).includes('alice'),
    `${val(card(root, 'Most util'))} / ${who(card(root, 'Most util'))}`,
  );
  check(
    'M1: all-zero Entry opens / Most MVPs → the identity seed picks alice (key ASC); STORED rows 3 / 7 print (the raw all-zeros never do)',
    val(card(root, 'Entry opens')) === '3' && who(card(root, 'Entry opens')).includes('alice') &&
      val(card(root, 'Most MVPs')) === '7' && who(card(root, 'Most MVPs')).includes('alice'),
    `${val(card(root, 'Entry opens'))}/${val(card(root, 'Most MVPs'))} — ${who(card(root, 'Entry opens'))}/${who(card(root, 'Most MVPs'))}`,
  );

  // (1b) REVERSED VIEW ORDER — the tie-break re-pin (2026-11-18): the
  // same numbers with BOB leading the viewRows order (equal kills, bob
  // listed first). The retired first-row rule would name bob in every
  // tie; the seed's ratified rule is player-key ASC and keys are
  // alice 'A' < bob 'B', so alice wins each tie and each all-zero
  // metric here — the moved expectation IS the pin. Best ADR still
  // goes to the outright max (bob). The stored-row patches ride along:
  // the numbers stay the SEED values (11/3/4 · 91.5 · 55 · 3 · 7).
  const reversed = {
    ...dataFor(13),
    getScoreboard: [
      { steamId: 'B', name: 'bob', side: 't', kills: 10, deaths: 4, assists: 1, adr: 90, mvps: 0, utilityDamage: 50, entryKills: 0 },
      { steamId: 'A', name: 'alice', side: 'ct', kills: 10, deaths: 2, assists: 3, adr: 80, mvps: 0, utilityDamage: 50, entryKills: 0 },
      { steamId: 'C', name: 'carol', side: 'ct', kills: 5, deaths: 9, assists: 2, adr: 40, mvps: 0, utilityDamage: 10, entryKills: 0 },
    ],
    getMetricValuesForMatch: cardSeededRead,
  };
  root = await showMatch(reversed, { routeTab: '' });
  await sleep();
  check(
    'M1: reversed order — Top fragger tie (10/10, bob listed first) → the SEED wins with alice (key A < B), never the first row; her STORED K/D/A prints (11/3/4)',
    val(card(root, 'Top fragger')) === '11/3/4' && who(card(root, 'Top fragger')).includes('alice'),
    `${val(card(root, 'Top fragger'))} / ${who(card(root, 'Top fragger'))}`,
  );
  check(
    'M1: reversed order — Most util / all-zero Entry opens / Most MVPs also pick alice by key, Best ADR stays bob (stored 91.5)',
    val(card(root, 'Most util')) === '55' && who(card(root, 'Most util')).includes('alice') &&
      val(card(root, 'Entry opens')) === '3' && who(card(root, 'Entry opens')).includes('alice') &&
      val(card(root, 'Most MVPs')) === '7' && who(card(root, 'Most MVPs')).includes('alice') &&
      val(card(root, 'Best ADR')) === '91.5' && who(card(root, 'Best ADR')).includes('bob'),
    ['Most util', 'Entry opens', 'Most MVPs', 'Best ADR']
      .map((l) => `${l}=${val(card(root, l))}/${who(card(root, l))}`)
      .join(' · '),
  );

  // (2) EMPTY set: no roster rows → the identity pools are empty →
  // the seeds emit NO row → every card is absent (the §3.3 empty-pool
  // rule; the retired `!viewRows.length` guard is gone with the
  // migration).
  root = await showMatch({ ...dataFor(13), getScoreboard: [] }, { routeTab: '' });
  await sleep();
  check(
    'M1: empty roster → NO top cards (the identity pools are empty — never a fabricated name)',
    topCards(root).length === 0,
    String(topCards(root).length),
  );

  // (3) BEHIND: the seeds exist in the catalog but no stored row has
  // landed — each card wears the established five-state chip in its
  // value slot (identity rows get the same states §9 requires), with
  // NO name beside it (a state names no player).
  const behind = {
    ...dataFor(13),
    getMetricValuesForMatch: (matchID, ids) => [
      ...seedValues(matchID, ids),
      ...econSeedValues(ids, 13),
      // identity rows deliberately dropped
    ],
    getMetricComputeState: IDENTITY_SEED_DEFS.map((d) => ({ metricId: d.id, state: 'behind' })),
  };
  root = await showMatch(behind, { routeTab: '' });
  await sleep();
  const behindCards = topCards(root);
  check(
    'M1: seeds behind → five state cards, each carrying the behind chip and no name',
    behindCards.length === 5 &&
      behindCards.every(
        (c) =>
          !!c.querySelector('.chip.status') &&
          (c.querySelector('.chip.status')?.getAttribute('title') || '').includes('value not available yet') &&
          who(c) === '',
      ),
    `${behindCards.length} cards: ` +
      behindCards
        .map((c) => `${labelOf(c)}=${c.querySelector('.chip.status') ? 'chip' : 'value'}/${JSON.stringify(who(c))}`)
        .join(' · '),
  );
}

console.log('P. ME0/M9: roster ADR chip reads the adr seed — byte-identical to the pinned metric column (owner ruling 2026-11-17)');
{
  const mk = (id, name) => ({ id, name, title: name, doc: `Formula: ${name}`, format: 'float1' });
  const d = {
    ...dataFor(13),
    getScoreboard: [
      { steamId: 'A', name: 'alice', side: 'ct', kills: 10, deaths: 2, assists: 3, adr: 42.56, mvps: 1, utilityDamage: 50, entryKills: 1 },
      { steamId: 'B', name: 'bob', side: 't', kills: 8, deaths: 5, assists: 2, adr: 80, mvps: 0, utilityDamage: 20, entryKills: 0 },
    ],
    listMetrics: [mk(77, 'adr')],
    // M9's agreement fixture: the raw column and the stored metric row
    // carry the SAME value (both are damage ÷ the match's counted rounds
    // since the denominator wave — the Go-side value pin is
    // internal/metrics TestExtractShapedScoreboardEquivalence); the
    // roster chip and the metric column now BOTH read that stored row
    // (the chip left ps.adr with the owner ruling of 2026-11-17), so the
    // two display paths agree by construction — this pins it.
    getMetricValuesForMatch: [{ metricId: 77, subjectKey: 'A', value: 42.56, n: 13 }],
    getMetricComputeState: [{ metricId: 77, state: 'fresh' }],
  };
  localStorage.setItem('spectra:pinned-metrics', '["adr"]');

  // The roster chip (the seed row through fmtMetric's float1 tag).
  root = await showMatch(d, { routeTab: '' });
  await sleep();
  const chipRow = [...root.querySelectorAll('tbody tr')].find(
    (r) => (r.textContent || '').includes('alice') && r.querySelector('.chip.adr'),
  );
  const chipText = chipRow?.querySelector('.chip.adr')?.textContent ?? '';
  check(
    'M9: roster ADR chip renders the stored seed row through float1 (42.56 → 42.6)',
    chipText === '42.6',
    chipText || 'no chip',
  );

  // Metric side: the scoreboard's pinned adr column
  // (fmtMetric(value, "float1") → the SAME fmt1 function).
  root = await showMatch(d, { routeTab: 'Scoreboard' });
  await sleep();
  const ths = [...root.querySelectorAll('.data-table.scoreboard thead th')];
  const adrIdx = ths.findIndex((t) => (t.querySelector('.th-sort')?.textContent || '').includes('adr'));
  const aliceRow = [...root.querySelectorAll('.data-table.scoreboard tbody tr')].find((r) =>
    (r.querySelector('.name-cell')?.textContent || '').includes('alice'),
  );
  const metricText = adrIdx >= 0 && aliceRow ? aliceRow.children[adrIdx].textContent : '';
  check(
    'M9: pinned adr metric cell renders the stored value (float1)',
    metricText === '42.6',
    metricText || `no cell (th idx ${adrIdx})`,
  );
  check(
    'M9: chip and metric AGREE byte-for-byte (both display paths)',
    chipText !== '' && metricText === chipText,
    `${chipText} vs ${metricText}`,
  );
  localStorage.removeItem('spectra:pinned-metrics');
}

// ---------------------------------------------------------------------------
// Section Q: the import-warnings panel's RENDER CAP. The list renders at
// most WARNINGS_RENDER_CAP (200) <li> whatever a fetch hands it (the
// belt-and-braces twin of the store's fetch cap — store.WarningsFetchLimit,
// same value), and the cap line states the TRUE remainder (total − shown)
// so a huge parse is never a silent truncation (the 170k-warning demo
// froze this view on 170k <li> nodes). The panel only opens for a match
// whose warningsCount > 0 (the content guard upstream), so each fixture
// scripts both the match and the page.
console.log('Q. import-warnings render cap: bounded <li> count + honest "and {n} more" line');
{
  const capLine = (r) =>
    [...r.querySelectorAll('.warnings-panel p.muted')]
      .map((p) => p.textContent.trim())
      .find((t) => t.startsWith('and ')) ?? '';

  // (a) Over the cap: the caller passes MORE rows than the fetch
  // contract allows (300) and a total far beyond the window — exactly
  // the cap's rows render, and the line carries the honest remainder.
  const total = 170894;
  root = await showMatch(
    {
      ...dataFor(13),
      getMatch: { ...match, warningsCount: total },
      getWarnings: { messages: Array.from({ length: 300 }, (_, i) => `flood warning ${i}`), total },
    },
    { routeTab: 'Rounds' },
  );
  await sleep();
  const floodLis = root.querySelectorAll('.warnings-panel li');
  check(
    'over the cap: exactly 200 <li> render (never the caller’s 300)',
    floodLis.length === 200,
    String(floodLis.length),
  );
  const more = capLine(root);
  check(
    'over the cap: the cap line states the TRUE remainder (total − shown)',
    more === 'and 170,694 more',
    more || 'no cap line',
  );

  // (b) At/under the fetch cap: every row renders and NO cap line —
  // there is no remainder to state (nothing hidden, nothing invented).
  const few = ['first warning', 'second warning', 'third warning'];
  root = await showMatch(
    {
      ...dataFor(13),
      getMatch: { ...match, warningsCount: 3 },
      getWarnings: { messages: few, total: 3 },
    },
    { routeTab: 'Rounds' },
  );
  await sleep();
  const fewLis = [...root.querySelectorAll('.warnings-panel li')].map((li) => li.textContent);
  check(
    'under the cap: every row renders, in order',
    fewLis.length === 3 && fewLis[0] === 'first warning' && fewLis[2] === 'third warning',
    JSON.stringify(fewLis),
  );
  check('under the cap: NO cap line (no remainder to state)', capLine(root) === '', capLine(root));

  // (c) The loading leg is untouched by the cap: while the capped fetch
  // is in flight (warnings == null) the panel holds the Loading chip;
  // the content guard upstream means content-less matches never reach
  // this view at all.
  root = await showMatch(
    {
      ...dataFor(13),
      getMatch: { ...match, warningsCount: 1 },
      getWarnings: () => new Promise(() => {}), // in flight for the whole mount
    },
    { routeTab: 'Rounds' },
  );
  const chipDetail = root.querySelector('.warnings-panel .chip-detail');
  check(
    'loading leg: the panel shows the Loading chip while the capped fetch is in flight',
    !!chipDetail && chipDetail.textContent.includes('Loading'),
    chipDetail ? chipDetail.textContent : 'no chip-detail inside the warnings panel',
  );
}

// ---------------------------------------------------------------------------
// Section R: the seeded fixed cells (owner ruling, 2026-11-17 — the
// metrics system IS the gameplay-statistics layer): the scoreboard's
// K/D/DMG/Util/MVPs cells and the Overview roster's K/D/A triple + ADR
// chip read their STORED seed rows through the five-state machine —
// never the raw row field. The fixture deliberately carries raw fields
// with NO seed row beside them (alice's kills=20, mvps=3; bob's
// assists=5, adr=85): a cell with no fresh row must show the honest
// dash/state, never the raw number — that is the no-raw-fallback pin.
console.log('R. seeded fixed cells: seed value + Formula title, the five states, no raw fallback, score stays raw');
{
  const mk = (id, name, label, format) => ({
    id, name, title: label, scope: 'match', format,
    doc: `Formula: sum(player_stats.${name}) — the ${label} cell's seed`,
  });
  const catalog = [
    mk(201, 'kills', 'K', 'int'),
    mk(202, 'deaths', 'D', 'int'),
    mk(203, 'total_damage', 'DMG', 'int'),
    mk(204, 'utility_damage', 'Util', 'int'),
    mk(205, 'mvps', 'MVPs', 'int'),
    mk(206, 'assists', 'A', 'int'),
    mk(207, 'adr', 'ADR', 'float1'),
  ];
  const d = {
    ...dataFor(13),
    getScoreboard: [
      {
        steamId: 'A', name: 'alice', side: 'ct', kills: 20, deaths: 12, assists: 4,
        adr: 90, mvps: 3, utilityDamage: 150, totalDamage: 1000, score: 13,
      },
      {
        steamId: 'B', name: 'bob', side: 't', kills: 18, deaths: 13, assists: 5,
        adr: 85, mvps: 2, utilityDamage: 120, totalDamage: 900, score: 11,
      },
    ],
    listMetrics: catalog,
    // Fresh rows only where a value must render; every other subject/
    // metric pair runs the state below (or the plain no-row dash).
    getMetricValuesForMatch: [
      { metricId: 201, subjectKey: 'B', value: 18, n: 13 }, // K: bob fresh
      { metricId: 203, subjectKey: 'A', value: 1000, n: 13 }, // DMG: alice (processing beats it)
      { metricId: 206, subjectKey: 'A', value: 4, n: 13 }, // roster A half
      { metricId: 207, subjectKey: 'A', value: 90, n: 13 }, // roster ADR chip
    ],
    getMetricComputeState: [
      { metricId: 201, state: 'fresh' },
      { metricId: 202, state: 'behind' },
      { metricId: 203, state: 'processing' },
      { metricId: 204, state: 'failed', error: 'engine exploded' },
      { metricId: 205, state: 'no-data' },
      { metricId: 206, state: 'fresh' },
      { metricId: 207, state: 'fresh' },
    ],
  };
  localStorage.removeItem('spectra:pinned-metrics');

  root = await showMatch(d, { routeTab: 'Scoreboard' });
  await sleep();
  const ths = [...root.querySelectorAll('.data-table.scoreboard thead th')];
  const idxOf = (label) =>
    ths.findIndex((t) => (t.querySelector('.th-sort')?.textContent || '').trim() === label);
  const rowsOfSb = [...root.querySelectorAll('.data-table.scoreboard tbody tr')];
  const cellAt = (label, player) => {
    const i = idxOf(label);
    const row = rowsOfSb.find((r) =>
      (r.querySelector('.name-cell')?.textContent || '').includes(player),
    );
    return i >= 0 && row ? row.children[i] : null;
  };
  const chipIn = (cell) => cell?.querySelector('.chip.status');

  {
    const cell = cellAt('K', 'bob');
    const kTh = ths[idxOf('K')];
    check(
      'the unified K column renders the stored seed value (18); the cell wears its metric label as the title and the seed Formula rides the header ⓘ (unification — K is a metric column now)',
      !!cell && cell.textContent.trim() === '18' &&
        cell.getAttribute('title') === 'K' &&
        (kTh?.querySelector('.m5-ib')?.getAttribute('title') || '').startsWith(
          'Formula: sum(player_stats.kills)',
        ),
      cell
        ? `${cell.textContent.trim()} title=${cell.getAttribute('title')} ib=${kTh?.querySelector('.m5-ib')?.getAttribute('title')}`
        : 'no cell',
    );
  }
  {
    const cell = cellAt('K', 'alice');
    check(
      'NO raw fallback: a K cell with no seed row shows the honest dash — never the raw field (20)',
      !!cell && cell.textContent.trim() === '—' &&
        cell.getAttribute('title') === 'no data for this player',
      cell ? `${cell.textContent.trim()} title=${cell.getAttribute('title')}` : 'no cell',
    );
  }
  {
    const cell = cellAt('D', 'alice');
    const chip = chipIn(cell);
    check(
      'behind renders the idle chip with the design copy, never a number',
      !!chip && chip.classList.contains('idle') && chip.textContent.trim() === 'behind' &&
        cell.getAttribute('title') === 'value not available yet — recompute pending' &&
        !/\d/.test(cell.textContent),
      cell ? `${chip ? chip.className : 'no chip'} ${cell.textContent.trim()}` : 'no cell',
    );
  }
  {
    const cell = cellAt('DMG', 'alice');
    const chip = chipIn(cell);
    check(
      'processing renders the busy chip in lieu of the stored number (no digit reaches the cell)',
      !!chip && chip.classList.contains('busy') && chip.textContent.includes('processing') &&
        !/\d/.test(cell.textContent),
      cell ? `${chip ? chip.className : 'no chip'} ${cell.textContent.trim()}` : 'no cell',
    );
  }
  {
    const cell = cellAt('Util', 'alice');
    const chip = chipIn(cell);
    check(
      'failed renders the bad chip and carries the engine error as its title',
      !!chip && chip.classList.contains('bad') && chip.textContent.trim() === 'failed' &&
        cell.getAttribute('title') === 'engine exploded',
      cell ? `${chip ? chip.className : 'no chip'} title=${cell.getAttribute('title')}` : 'no cell',
    );
  }
  {
    const cell = cellAt('MVPs', 'alice');
    check(
      'no-data renders the dash with its copy — the raw field (3) never fabricates a 0',
      !!cell && cell.textContent.trim() === '—' &&
        cell.getAttribute('title') === 'no data for this player',
      cell ? `${cell.textContent.trim()} title=${cell.getAttribute('title')}` : 'no cell',
    );
  }
  {
    const cell = cellAt('Score', 'alice');
    check(
      'score has no seed and keeps its raw field read (13)',
      !!cell && cell.textContent.trim() === '13' && !cell.hasAttribute('title'),
      cell ? `${cell.textContent.trim()} title=${cell.getAttribute('title')}` : 'no cell',
    );
  }

  // The Overview roster: the K/D/A triple composes all three halves
  // from seed rows (a non-value half dashes its slot and puts the state
  // in the title — invariant 9), and the ADR chip reads the adr seed.
  root = await showMatch(d, { routeTab: 'Overview' });
  await sleep();
  const rosterSections = [...root.querySelectorAll('.roster-grid section')];
  const rosterRow = (sectionIdx, name) => {
    const rows = [...(rosterSections[sectionIdx]?.querySelectorAll('tbody tr') || [])];
    return rows.find((r) => r.textContent.includes(name)) || null;
  };
  {
    const tr = rosterRow(0, 'alice');
    const kda = tr ? tr.children[1] : null;
    check(
      'roster triple: seeded K/D halves dash (raw 20/12 ignored) while the fresh A half renders 4',
      !!kda && kda.textContent.trim() === '—/—/4' &&
        kda.getAttribute('title') === 'no data for this player',
      kda ? `${kda.textContent.trim()} title=${kda.getAttribute('title')}` : 'no cell',
    );
  }
  {
    const tr = rosterRow(1, 'bob');
    const kda = tr ? tr.children[1] : null;
    check(
      'roster triple: a fresh K half renders 18, the behind D half dashes with its state in the title',
      !!kda && kda.textContent.trim() === '18/—/—' &&
        kda.getAttribute('title') === 'value not available yet — recompute pending',
      kda ? `${kda.textContent.trim()} title=${kda.getAttribute('title')}` : 'no cell',
    );
  }
  {
    const aliceChip = rosterRow(0, 'alice')?.querySelector('.chip.adr');
    check(
      'roster ADR chip renders the seeded value through float1 (90 → 90.0, byte-identical to the old display)',
      !!aliceChip && aliceChip.textContent.trim() === '90.0',
      aliceChip ? aliceChip.textContent.trim() : 'no chip',
    );
    const bobRow = rosterRow(1, 'bob');
    const bobCell = bobRow ? bobRow.children[2] : null;
    check(
      'NO raw fallback: a roster ADR cell with no seed row dashes — never the raw field (85)',
      !!bobCell && bobCell.textContent.trim() === '—' &&
        !bobCell.querySelector('.chip.adr'),
      bobCell ? bobCell.textContent.trim() : 'no cell',
    );
  }
  localStorage.removeItem('spectra:pinned-metrics');
}

console.log('N. the user-toggled economy set replaces the shipped cards (metric_economy present)');
{
  root = await showMatch(
    { ...dataFor(13), getPref: (key) => (key === 'metric_economy' ? ['pistol_hold', 'kills'] : undefined) },
    { routeTab: 'Economy' },
  );
  await sleep();
  const toggled = [...root.querySelectorAll('.econ-summary .stat-cell')];
  check(
    'a present metric_economy pref replaces the shipped cards (team pair dropped, the added seed shows its dash)',
    toggled.length === 2 &&
      /Pistol/.test(toggled[0]?.textContent || '') &&
      (toggled[1]?.querySelector('.stat-value')?.textContent || '') === '\u2014',
    toggled.map((c) => c.textContent.replace(/\s+/g, ' ').trim()).join(' | '),
  );
}
// ---------------------------------------------------------------------------
// Section S: the death columns' honest fallback (owner, 2026-11-18): the
// record path has no rows for the match (not analyzed / no side samples)
// → BOTH cells read the dash, never a fabricated 0 — the same
// absence-is-unknown rule the rest of the view applies.
console.log('S. per-round death columns: the record path is absent → the honest dash, never 0');
{
  root = await showMatch({ ...dataFor(13), getPlayerRounds: [] }, { routeTab: 'Economy' });
  const tableS = root.querySelector('.econ-table');
  const trS = tableS ? rowFor(tableS, 1) : null;
  check(
    'the table renders with its death columns intact',
    !!tableS &&
      headerTexts(tableS).includes('CT Deaths') &&
      headerTexts(tableS).includes('T Deaths'),
    tableS ? JSON.stringify(headerTexts(tableS)) : 'no .econ-table',
  );
  check(
    'no per-round player rows → both death cells dash (never 0)',
    !!trS && trS.children[5]?.textContent.trim() === '—' && trS.children[6]?.textContent.trim() === '—',
    trS ? `${trS.children[5]?.textContent.trim()} / ${trS.children[6]?.textContent.trim()}` : 'no round-1 row',
  );
}

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
if (inst) unmount(inst);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
