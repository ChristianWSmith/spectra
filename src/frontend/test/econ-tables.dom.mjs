import { warm, compileIdle } from './compile-worker-node.mjs';
await warm();
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
const { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, realpathSync } = await import('node:fs');
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
      else if (/\.(js|svelte)$/.test(f) && !p.includes('/generated/')) {
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
  // The build's generated panel sources are TEXT (their imports are data, not
  // edges of this graph): copied as they are.
  if (rel.includes('generated/')) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), src);
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

// The STORED round-grain deaths behind the table's CT Deaths / T Deaths
// columns (ruling 41: builtin raw_player_round_deaths, bound :match_id and
// :round — one row per player per round, dim = the side the player was
// sampled on). The view sums those rows per side. Hand-shaped so every
// pinned cell is hand-computed: alice dies TWICE in rounds 1 and 13 and
// once otherwise, bob dies once every round. Sides follow the halftime
// switch (sideSwitches=1 → rounds 1-12 alice CT / bob T, round 13 alice
// T / bob CT), so round 13's cells prove the sum keys on the ROUND'S
// SIDE, never on the player's final side.
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
// The stored round read's rows for one round: the metric's shape (subject
// = steam id, dim = side, value = deaths), from the fixture above.
const DEATHS_DEF_ID = 120;
const roundDeathRows = (round, countedN) =>
  playerRoundsFor(countedN)
    .filter((r) => r.round === round)
    .map((r) => ({ metricId: DEATHS_DEF_ID, subjectKey: r.steamId, dim: r.side, value: r.deaths, valueKey: '' }));
const DEATHS_DEF = Object.freeze({
  id: DEATHS_DEF_ID,
  name: 'raw_player_round_deaths',
  title: 'Deaths per round by side (raw SQL)',
  shortName: '',
  scope: 'match',
  subject: 'player',
  format: 'int',
  doc: 'Formula: count(kill events whose victim is the player, in the round) — addressed per player, keyed by side.',
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

// The component queries the Economy and Utility builtins run are answered from
// an in-memory database built from the same fixture rows, with the store's own
// DDL (the store's schema.sql), so the SQL the builtins send is the SQL that runs.
const { DatabaseSync } = await import('node:sqlite');
const STORE_DDL = readFileSync(join(realpathSync(import.meta.dirname), '..', '..', 'internal', 'store', 'schema.sql'), 'utf8');
function econDb(countedN, switches) {
  const tables = ['matches', 'rounds', 'round_economy', 'round_classifications', 'round_side_classes', 'round_player_sides', 'players', 'player_stats', 'teams', 'events'];
  const db = new DatabaseSync(':memory:');
  for (const t of tables) {
    const m = new RegExp('CREATE TABLE IF NOT EXISTS ' + t + ' \\([\\s\\S]*?\\n\\);').exec(STORE_DDL);
    if (!m) throw new Error('no DDL for ' + t);
    db.exec(m[0]);
  }
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  run("INSERT INTO matches (id, sha256, tick_rate, score_ct, score_t, side_switches) VALUES (3, 'fixture', 64, 13, 11, ?)", switches);
  const eco = economyRows(countedN);
  const cnt = counted(countedN);
  cnt.forEach((r, i) => {
    run('INSERT INTO rounds (match_id, number, winner, start_tick, end_tick, equip_ct, equip_t) VALUES (3, ?, ?, ?, ?, ?, ?)', r.number, r.winner, r.startTick, r.endTick, r.equipCT, r.equipT);
    const e = eco[i];
    run("INSERT INTO round_economy (match_id, round, side, equip_value, money_sampled_sum, spent, free_pistol_value) VALUES (3, ?, 'ct', ?, ?, 0, 0)", r.number, e.equipCT, e.moneyCT);
    run("INSERT INTO round_economy (match_id, round, side, equip_value, money_sampled_sum, spent, free_pistol_value) VALUES (3, ?, 't', ?, ?, 0, 0)", r.number, e.equipT, e.moneyT);
    run('INSERT INTO round_classifications (match_id, round, label, explanation, rule_version) VALUES (3, ?, ?, ?, ?)', r.number, e.pistolRound ? 'pistol' : '', e.classWhyCT, e.ruleVersion);
    run("INSERT INTO round_side_classes (match_id, round, side, class, why) VALUES (3, ?, 'ct', ?, ?)", r.number, e.classCT, e.classWhyCT);
    run("INSERT INTO round_side_classes (match_id, round, side, class, why) VALUES (3, ?, 't', ?, ?)", r.number, e.classT, e.classWhyT);
  });
  let seq = 0;
  for (const p of scoreboard) {
    run('INSERT INTO players (match_id, steam_id, name, side, is_bot) VALUES (3, ?, ?, ?, 0)', p.steamId, p.name, p.side);
    run('INSERT INTO player_stats (match_id, steam_id, name, side, score) VALUES (3, ?, ?, ?, 0)', p.steamId, p.name, p.side);
    for (let k = 0; k < p.kills; k++) {
      seq += 1;
      run("INSERT INTO events (match_id, seq, round, kind, attacker, victim) VALUES (3, ?, 1, 'kill', ?, '')", seq, p.steamId);
    }
  }
  run("INSERT INTO teams (match_id, side, name) VALUES (3, 'ct', 'Alpha')");
  run("INSERT INTO teams (match_id, side, name) VALUES (3, 't', 'Beta')");
  return db;
}
const dbCache = new Map();
const econDbCached = (countedN, switches) => {
  const key = countedN + ':' + switches;
  if (!dbCache.has(key)) dbCache.set(key, econDb(countedN, switches));
  return dbCache.get(key);
};
const answerSql = (db, sql) => {
  const objs = db.prepare(sql).all();
  return { columns: objs.length ? Object.keys(objs[0]) : [], rows: objs.map((o) => Object.values(o)) };
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
  listMetrics: [...SEED_DEFS, ...ECON_SEED_DEFS, ...IDENTITY_SEED_DEFS, DEATHS_DEF],
  getMetricValuesForMatch: (matchID, ids) => [
    ...seedValues(matchID, ids),
    ...econSeedValues(ids, countedN, switches),
    ...identitySeedValues(ids),
  ],
  getMetricComputeState: [],
  getEconomy: economyRows(countedN),
  // The Economy deaths read is the stored round metric (ruling 41), so the
  // record read is EMPTY here: a view that still read player_round_stats
  // would show dashes and fail the CT/T Deaths cells below.
  getPlayerRounds: [],
  componentQuery: (sql) => answerSql(econDbCached(countedN, switches), sql),
  getMetricValuesForRound: (matchID, round, ids) =>
    (ids || []).includes(DEATHS_DEF_ID) ? roundDeathRows(round, countedN) : [],
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
// The far-left watch column, the ▶ nav, the Winner chips and the separator
// on this tab are covered by test/match-rounds.dom.mjs (sections A–C,
// ruling 42 port: pre-match W/K labels, neutral no-winner chip, era-flip
// winners, split after round 12 on match 9). Dropped here as stale.
console.log('B. legacy rows never shift the boundary (the retired pref is gone — no kv scenario)');
root = await showMatch(dataFor(13), { routeTab: 'Rounds' });
table = root.querySelector('.data-table');

console.log('C. Rounds tab: 12 counted rounds → trailing suppression (no line at all)');
root = await showMatch(dataFor(12), { routeTab: 'Rounds' });
table = root.querySelector('.data-table');
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
// The Key facts list (no First blood term) is pinned by match-rounds.dom.mjs
// (its Details section compares the eight stored facts in order).
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
    'the RD cell opens the Rounds tab with that round expanded',
    rdNav.length === 1 && rdNav[0] === '/match/3/rounds?round=1',
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
    'Loss cells render five pips, filled to the side’s bonus in the side colours (CT 1900 → 2, T 1900 → 2; derived from the round winners)',
    !!ctCell &&
      !!tCell &&
      ctCell.querySelectorAll('.econ-loss-pip').length === 5 &&
      tCell.querySelectorAll('.econ-loss-pip').length === 5 &&
      filledOf(ctCell, 'ct') === 2 &&
      filledOf(tCell, 't') === 2 &&
      filledOf(ctCell, 't') === 0 &&
      filledOf(tCell, 'ct') === 0,
    `ct=${ctCell?.textContent}/${ctCell?.querySelectorAll('.econ-loss-pip').length} t=${tCell?.textContent}`,
  );
  check(
    'the exact dollar amount stays in the Loss cell title (honesty)',
    ctCell?.getAttribute('title') === '$1,900' && tCell?.getAttribute('title') === '$1,900',
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
    'the curve hit-rect opens the Rounds tab with that round expanded',
    hitNav.length === 1 && hitNav[0] === '/match/3/rounds?round=1',
    JSON.stringify(hitNav),
  );
}
{
  globalThis.__nav = [];
  root.querySelectorAll('.econ-strip-cell')[0]?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await sleep();
  const stripNav = (globalThis.__nav || []).slice();
  check(
    'the winner-strip button opens the Rounds tab with that round expanded',
    stripNav.length === 1 && stripNav[0] === '/match/3/rounds?round=1',
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
console.log('I. error dismissals: Match top-level, Economy');
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

// (c) The Economy TAB's own error (Economy.svelte) — its fetch has no
// in-view re-trigger, so the ✕ is its dismissal. (The Rounds tab's
// classError alert died with its Class column in W3a — the tab no
// longer reads getEconomy at all, so there is nothing to fail.)
{
  const d = { ...dataFor(13), componentQuery: new Error('eco backend down') };
  root = await showMatch(d, { routeTab: 'Economy' });
  const p = alertP(root, 'eco backend down');
  check('Economy failure renders its own alert', !!p, 'no Economy alert');
  check('the ✕ rides INSIDE the Economy alert', !!p?.querySelector('button.btn.small .codicon-close'), '');
  const res = await dismissInPlace(root, 'eco backend down', (r) => !!r.querySelector('.econ-head'));
  check('✕ clears the Economy error in place (its head row intact)', res.gone && res.mounted && res.noNav, JSON.stringify(res));
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
// Section S: the death columns' honest fallback (ruling 41): the stored
// round metric has no rows for the match (not analyzed / no side samples),
// or only NULL values → BOTH cells read the dash, never a fabricated 0 —
// the same absence-is-unknown rule the rest of the view applies.
console.log('S. per-round death columns: no stored round rows (or NULL values) → the honest dash, never 0');
{
  for (const [label, read] of [
    ['no stored round rows', () => []],
    [
      'NULL stored values',
      (matchID, round, ids) =>
        (ids || []).includes(DEATHS_DEF_ID)
          ? [
              { metricId: DEATHS_DEF_ID, subjectKey: 'A', dim: 'ct', value: null, valueKey: '' },
              { metricId: DEATHS_DEF_ID, subjectKey: 'B', dim: 't', value: null, valueKey: '' },
            ]
          : [],
    ],
  ]) {
    root = await showMatch({ ...dataFor(13), getMetricValuesForRound: read }, { routeTab: 'Economy' });
    const tableS = root.querySelector('.econ-table');
    const trS = tableS ? rowFor(tableS, 1) : null;
    check(
      `${label}: the table renders with its death columns intact`,
      !!tableS && headerTexts(tableS).includes('CT Deaths') && headerTexts(tableS).includes('T Deaths'),
      tableS ? JSON.stringify(headerTexts(tableS)) : 'no .econ-table',
    );
    check(
      `${label}: both death cells dash (never 0)`,
      !!trS && trS.children[5]?.textContent.trim() === '—' && trS.children[6]?.textContent.trim() === '—',
      trS ? `${trS.children[5]?.textContent.trim()} / ${trS.children[6]?.textContent.trim()}` : 'no round-1 row',
    );
  }
}

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
if (inst) unmount(inst);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
