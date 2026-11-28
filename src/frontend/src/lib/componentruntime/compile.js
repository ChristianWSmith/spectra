// The user-component compiler: Svelte 5 source → a mountable component,
// in the webview, lazily.
//
// - The compile itself runs in a Web Worker (ruling 47): compileclient.js
//   sends the source to compile.worker.js, which holds svelte/compiler and
//   loads it on the first compile, never at launch. This module does the
//   rest on the calling thread: the import rewrite, the refusal wording and
//   the cache. Nothing else in src/ may import svelte/compiler statically
//   (componentcompile.test.js pins that).
// - The compiler's output imports Svelte's runtime by bare specifier,
//   which a module evaluated from a string cannot resolve. rewriteModule
//   turns every import into a lookup in ONE registry (RUNTIME_MODULES)
//   that hands back the app's OWN runtime instance, so user and app
//   components share reactivity, context and the scheduler. The registry
//   loaders are dynamic imports too: a flags module (`flags/legacy`,
//   `flags/async`) flips a runtime flag when evaluated, so it is evaluated
//   only when a compiled module actually imports it — the same moment
//   ESM would have evaluated it.
// - Compiled modules are cached in memory, keyed by a hash of the source
//   (the entry keeps the source and a hit compares it, so a collision can
//   never mount the wrong component). Only source is ever stored.
// - checkComponentSource is the save-time check: compile + rewrite, no
//   evaluation, the answer {ok, line, column, message}. Runtime failures
//   are the frame's job (ComponentFrame.svelte), not this module's.
//
// Builtin components are app source compiled by the bundler; they never
// pass through here.

import * as S from '../strings/index.js';
import { compileWork, compileRequested } from './compileclient.js';

// The registry: every specifier a compiled user module may import. The
// runes-only compile emits client and disclose-version (flags/async only
// in async mode); flags/legacy is kept for the legacy-mode runtime but no
// runes output imports it. The public svelte modules are what a user's
// own <script> may import. Anything else is refused at check time.
const RUNTIME_MODULES = {
  'svelte/internal/client': () => import('svelte/internal/client'),
  'svelte/internal/disclose-version': () => import('svelte/internal/disclose-version'),
  'svelte/internal/flags/legacy': () => import('svelte/internal/flags/legacy'),
  'svelte/internal/flags/async': () => import('svelte/internal/flags/async'),
  svelte: () => import('svelte'),
  'svelte/animate': () => import('svelte/animate'),
  'svelte/easing': () => import('svelte/easing'),
  'svelte/events': () => import('svelte/events'),
  'svelte/motion': () => import('svelte/motion'),
  'svelte/reactivity': () => import('svelte/reactivity'),
  'svelte/store': () => import('svelte/store'),
  'svelte/transition': () => import('svelte/transition'),
};

export const RUNTIME_SPECIFIERS = Object.freeze(Object.keys(RUNTIME_MODULES));

// --- the helper surface -----------------------------------------------------
// BUILTIN_HELPERS is THE surface a component imports from, whether it is built
// in or user-written (AGENTS.md "Helper surface"). A component imports it as
// HELPERS_SPECIFIER ('spectra/helpers'); the only other specifiers a component
// may import are the Svelte runtime modules in RUNTIME_MODULES above. Every export
// a component may take is listed in `names` with a line on what it is for; a name
// not listed is refused at save. The module lives in builtinhelpers.js, the one
// barrel for app helpers, shared components and the built-ins' own helpers.
// The list has no writes: stored data changes only through the spectra prop
// (ReadApi), never through an import. builtinedits.test.js pins that every
// listed name is exported by the barrel.
export const HELPERS_SPECIFIER = 'spectra/helpers';
// provideHelperModule is a test seam: a node driver whose services are scripted hands in
// the namespace the surface should resolve to (its bundled copy), so the built-ins read the
// script. The app never calls it.
const providedHelpers = new Map();
export function provideHelperModule(key, namespace) {
  providedHelpers.set(key, namespace);
}
const HELPERS_KEY = 'src/lib/builtinhelpers.js';
export const BUILTIN_HELPERS = Object.freeze({
  [HELPERS_KEY]: {
    load: () => (providedHelpers.has(HELPERS_KEY) ? Promise.resolve(providedHelpers.get(HELPERS_KEY)) : import('../builtinhelpers.js')),
    names: {
    rowOf: 'one result row shaped into an object by a column spec',
    indexBy: 'a list of records keyed by one of their fields',
    bySide: 'a value of a pair, by side (ct or t)',
    groupBy: 'a list grouped into a Map by a key function, in list order',
    sideBySteam: 'each roster steam id to its side',
    matchPath: 'the route of a match',
    matchTab: 'the route of a match tab',
    roundsTabHash: 'the route of a match’s rounds tab at a round',
    openRoundsTab: 'open a match’s rounds tab at a round',
    openReplay: 'open a match’s replay with its route extras (tick, loop, follow, back)',
    openMatch: 'open a match’s view',
    SQL_ROUND_SPANS: 'the match rounds read (number, winner and span of each round)',
    roundsOf: 'the round objects of a rounds read',
    rosterOf: 'the roster objects of a roster read',
    namesOf: 'the team names of a teams read over a roster',
    sideSwitchesOf: 'the side switch count of a match read',
    sideClassOf: 'the side colour class (side-ct / side-t), or empty',
    asTick: 'a tick read strictly: absent values are NaN, never zero',
    buildEconRows: 'the economy rows of a match from the economy query',
    loadEconomy: 'the economy of one match, read for a panel mounted alone (rows, rounds, names, side switches, winner)',
    DASH: 'the one dash a missing cell shows',
    econColumns: 'one side’s equip and net value of an economy row',
    econValue: 'one economy value of an economy row, by metric',
    entryLoopAround: 'the loop span around a replay entry',
    entryLoopSpan: 'the loop span between two ticks',
    eraOf: 'the side era of a round index',
    flipIndexes: 'the side-switch rounds of a match',
    fmt1: 'a number to one decimal',
    fmtInt: 'a whole number with grouping',
    fmtMoney: 'money with its sign',
    fmtMs: 'milliseconds as seconds',
    fmtZeroDash: 'a count of nothing as a dash',
    followPlayer: 'open the replay following a player',
    SQL_ROSTER: 'the match roster read (humans only, the default order)',
    SQL_TEAMS: 'the team names read',
    chatClock: 'a chat line’s clock, RD-prefixed in a round',
    chatTag: 'a chat line’s speaker tag ([ALL], [CT], [T])',
    hashOf: 'a route hash from a path and its query',
    isSteam: 'a SteamID64 (17 digits): a link target, else not one',
    scoreThrough: 'the scoreline through a round',
    sideAtRound: 'the side a team held in a round',
    lossPips: 'the loss-bonus pips of an equip value',
    moneyResetIndexes: 'the money-reset rounds of a match',
    openPlayer: 'open a player’s profile',
    playerSideClassAt: 'the team colour class of a player on a round',
    roundSideClassOf: 'a panel’s round colour class of a player, bound to its match data',
    roundWinnerName: 'the team name of a round’s winner side (empty when the round cannot place it)',
    roundClock: 'a round time as a clock',
    roundEndTick: 'the end tick of a round',
    roundIndexLabel: 'a round’s number label',
    roundsByNumber: 'a match’s rounds keyed by number',
    roundScoreLabel: 'a round’s score label',
    roundStartTick: 'the start tick of a round',
    separatorFlags: 'where a half or overtime separator falls',
    sideInEra: 'the side a team held in an era',
    teamKeyAt: 'the team (final side) on the CT side at a round',
    teamNames: 'the team display names',
    teamStartClass: 'the team colour class of a side at the start',
    winnerTeamKey: 'the team that won a round',
    compareAsc: 'from sortstate.js',
    latestOnly: 'from current.js',
    loadForMatch: 'from current.js',
    loadThen: 'from current.js',
    whileCurrent: 'from current.js',
    errText: 'from services.js',
    getCareerTrend: 'from services.js',
    getClutches: 'from services.js',
    getEntitySummary: 'from services.js',
    getHeatmap: 'from services.js',
    getKillTags: 'from services.js',
    getMatch: 'from services.js',
    getMetricComputeState: 'from services.js',
    getMetricValuesForMatch: 'from services.js',
    getPlayerRefs: 'from services.js',
    getProfile: 'from services.js',
    getProvenance: 'from services.js',
    getRounds: 'from services.js',
    getScoreboard: 'from services.js',
    getVoicePresence: 'from services.js',
    listMetrics: 'from services.js',
    listPlayers: 'from services.js',
    listReportTemplates: 'from services.js',
    renderReport: 'from services.js',
    listedPlayers: 'from players.js',
    matchKey: 'from viewstate.svelte.js',
    matchRecord: 'from viewstate.svelte.js',
    remember: 'from viewstate.svelte.js',
    seed: 'from viewstate.svelte.js',
    DEFAULT_CARDS: 'from metricorder.js',
    composedSequence: 'from metricorder.js',
    inSequence: 'from metricorder.js',
    isRawId: 'from metricorder.js',
    rawItems: 'from metricorder.js',
    liveMetricState: 'from metricstate.js',
    metricPresentation: 'from metricstate.js',
    metricStateTitle: 'from metricstate.js',
    liveMetrics: 'from metricslive.svelte.js',
    economySource: 'from economysource.svelte.js',
    fmtBytes: 'from fmt.js',
    fmtDate: 'from fmt.js',
    fmtDuration: 'from fmt.js',
    fmtMetric: 'from fmt.js',
    fmtPatch: 'from fmt.js',
    fmtPercent: 'from fmt.js',
    plural: 'from fmt.js',
    CONTROL_SELECTOR: 'from keys.js',
    openRow: 'from keys.js',
    HEAT_CORE_KINDS: 'from heatkinds.js',
    HEAT_GRENADE_DET_KINDS: 'from heatkinds.js',
    HEAT_GRENADE_THROW_KINDS: 'from heatkinds.js',
    heatKindLabel: 'from heatkinds.js',
    heatRegionFilter: 'from heatkinds.js',
    heatRegionTakesBBox: 'from heatkinds.js',
    DEATH_STOPS: 'from heatramp.js',
    HEAT_STOPS: 'from heatramp.js',
    rampCss: 'from heatramp.js',
    signedRampCss: 'from heatramp.js',
    loadMapPack: 'from components/mapxform.js',
    runWork: 'from workstate.svelte.js',
    loadLoopSecs: 'from loopsecs.js',
    LOOP_SECS_DEFAULT: 'from nav.js',
    entryLoopSpanAround: 'from nav.js',
    KILL_TAG_DIST_DEF: 'from definitions.js',
    KILL_TAG_KIND_TITLES: 'from definitions.js',
    MATCH_TABS: 'from router.js',
    matchTabSlug: 'from router.js',
    S: 'the strings catalog (S.area.key), the one copy every built-in reads',
    isCounted: 'a helper a built-in takes from spectra/helpers',
    fmt2: 'a helper a built-in takes from spectra/helpers',
    getHeatmapKD: 'a helper a built-in takes from spectra/helpers',
    getPref: 'one stored preference (read)',
    onMetricDone: 'listen for a metric finishing (event)',
    metricsByMatch: 'one player’s stored values and states across many matches (read, History)',
    replayHash: 'the route to a replay at a point',
    combatPanel: 'the data layer of a Combat panel: the match’s list with its side data, the error line, the loop length and the replay a row opens',
    splitTable: 'the data of a profile split table (sides, maps, weapons) for the player, reloaded on change',
    activateOnKey: 'keyboard activation of a clickable row (Enter, and Space unless enterOnly)',
    whenCurrent: 'a promise callback that runs only while its load is current',
    readMetrics: 'read several stored metrics by name, a failed read shown as its own state',
    SQL_FACTS: 'the stored facts read of the details panel',
    SQL_ROUNDS: 'the rounds read of the rounds panel',
    SQL_SWITCHES: 'the side-switch count read',
    SQL_MATCH_TICK_RATE: 'the match tick rate read',
    SQL_ROUND_MVP_REASON: 'a round’s MVP reason read',
    SQL_ROUND_KILLS: 'a round’s kill rows read',
    SQL_ROUND_BOMBS: 'a round’s bomb rows read',
    SQL_ROUND_ECONOMY: 'a round’s economy rows read',
    SQL_ROUND_SIDE_CLASSES: 'a round’s side class rows read',
    SQL_ROUND_CHAT: 'a round’s chat rows read',
    STATE_WORD: 'the words of a metric state (calculating, failed, out of date)',
    cellText: 'one stored value as its cell text',
    readFrameBase: 'the base reads of a match panel: roster, team rows, side switches',
    kdaText: 'a player’s kills/deaths/assists line as cell text',
    matchPres: 'one stored value’s cell presentation (value, dash or state)',
    cellValue: 'one stored value, or null when not fresh',
    fill: 'fill a {placeholder} in catalog copy',
    numOf: 'a stored value as a number (NaN when absent)',
    parseStamp: 'the stored import time, read as Go wrote it',
    readUnit: 'one metric read for this match, with its state',
    roundLabel: 'a round’s number label',
    roundOf: 'one stored round row, shaped for the panel',
    sortRows: 'the chained sort of the scoreboard',
    startClass: 'the team colour class of a side at the start',
    loadCombatSide: 'one side’s combat rows for a match (read)',
    KILL_TAG_KINDS: 'the kill tag kinds',
    groupKillTags: 'group kill tags into duels',
    clutchKillTicks: 'the kill ticks of a clutch',
    cell: 'one stored value as a table cell',
    dimValue: 'one dimension value of a breakdown',
    dimsOf: 'the dimensions of a breakdown',
    emptyChip: 'the chip shown for an empty breakdown',
    readCell: 'the cell of a whole-subject read (one value per player)',
    loadSeeds: 'load the profile’s seed values (read)',
    loadSplit: 'load a breakdown’s catalog and its values for the player (read)',
    loadProfile: 'the metric catalog and one player’s profile, read together',
    defaultCardDefs: 'the profile-scope definitions of the default career cards',
    findTemplate: 'find a report template by id',
    reportFilename: 'the file name of a report export',
    targetReady: 'whether a report target is ready to render',
    compositeText: 'the text of a composed report',
    StatusChip: 'the state chip (a component)',
    LoadBox: 'the loading shell (a component)',
    MetricCell: 'the body of a stored-value table cell (a value, a dash, or a state as a chip or a word)',
    WinnerCell: 'the winner chip of a round: the team name, or the side',
    RetryButton: 'the button a panel shows beside a failed read, to load it again',
    SortTh: 'a sortable table header cell (the view keeps its own sort state)',
    MetricTd: 'a numeric table cell that shows one stored value',
    EmptyTableRow: 'the one row a table shows when it has nothing to list (a state chip, or the text)',
    EmptyNote: 'the line a panel shows where there is nothing to show (its text is the children)',
    ErrorBanner: 'the one error line a panel shows (its text is the children)',
    StatCard: 'a stat card (a component)',
    SuggestInput: 'a suggestion input (a component)',
    PlayerPicker: 'a player picker (a component)',
    TokenSelect: 'a token select (a component)',
    EventPlay: 'a replay play control for one event (a component)',
    ProfileLink: 'a link to a player’s profile (a component)',
    Popover: 'a popover (a component)',
    HeatmapLayer: 'a heatmap layer (a component)',
    },
  },
});

// loadRuntimeModule gives the module object one import reads: a runtime
// module as it is, a helper as only its listed names (or the whole namespace
// when `'*'` is listed).
async function loadRuntimeModule(key) {
  if (Object.hasOwn(RUNTIME_MODULES, key)) return RUNTIME_MODULES[key]();
  const h = BUILTIN_HELPERS[key];
  const m = await h.load();
  if (Object.hasOwn(h.names, '*')) return m;
  const out = {};
  for (const n of Object.keys(h.names)) out[n] = m[n];
  return out;
}

// compilerRequested reports whether a compile has been asked for in this
// process — false until the first user-component compile (the "not loaded
// at launch" pin reads it).
export function compilerRequested() {
  return compileRequested();
}

// --- errors -----------------------------------------------------------------

// CompileCancelledError: the author stopped the compile (the Cancel button,
// ruling 47). Nothing was written; the message is the catalog's sentence.
export class CompileCancelledError extends Error {
  constructor() {
    super(S.components.compileCancelled);
    this.name = 'CompileCancelledError';
  }
}

// ComponentSourceError is a refusal of the SOURCE (a compile error or an
// import the registry cannot provide), positioned by 1-based line/column
// (0 when the position is unknown). Its message is already user-facing.
export class ComponentSourceError extends Error {
  constructor(message, line, column) {
    super(line > 0 ? S.fill(S.components.sourceAtLine, { line, err: message }) : message);
    this.name = 'ComponentSourceError';
    this.detail = message;
    this.line = line;
    this.column = column;
  }
}

// The compiler's message carries a trailing documentation link line —
// keep the sentence only.
function compilerMessage(e) {
  return String((e && e.message) || e).split('\n')[0].trim();
}

// Position of the first occurrence of a quoted specifier in the source,
// so an import refusal points at its own line.
function specifierPosition(source, spec) {
  for (const q of ["'", '"']) {
    const i = source.indexOf(q + spec + q);
    if (i >= 0) {
      const before = source.slice(0, i);
      const line = before.split('\n').length;
      return { line, column: i - before.lastIndexOf('\n') - 1 };
    }
  }
  return { line: 0, column: 0 };
}

// --- the rewrite (pure) ------------------------------------------------------

// rewriteModule turns the compiler's ESM output into a function body that
// takes `__runtime` (specifier → module namespace) and returns the
// component. Returns {body, specs} with specs in import order, or throws
// {unknownSpecifier} for an import outside the registry. Only the leading
// import block is rewritten (the compiler hoists every import there), so
// markup text that happens to start a line with "import" is never touched.
export function rewriteModule(js, known = RUNTIME_SPECIFIERS) {
  const allowed = new Set(known);
  const specs = [];
  const head = [];
  let rest = js;
  // Leading import statements, one at a time (a statement may wrap lines).
  // A clause never contains a quote or a semicolon, so a match can never
  // run on into the next statement.
  const BARE = /^\s*import\s*(['"])([^'"]+)\1\s*;?[ \t]*(?:\r?\n|$)/;
  const FROM = /^\s*import\s*([^'";]*?)\s*from\s*(['"])([^'"]+)\2\s*;?[ \t]*(?:\r?\n|$)/;
  for (;;) {
    let whole;
    let clause = '';
    let spec;
    const bare = rest.match(BARE);
    const from = bare ? null : rest.match(FROM);
    if (bare) [whole, , spec] = bare;
    else if (from) [whole, clause, , spec] = from;
    else break;
    // A component imports the helper surface as HELPERS_SPECIFIER and the
    // Svelte runtime by its own specifier. Anything else (a relative path,
    // an app module, a package) is refused. Built-ins and user components
    // share this rule.
    let key = spec;
    if (spec === HELPERS_SPECIFIER) key = HELPERS_KEY;
    else if (!allowed.has(spec)) {
      const err = new Error('unknown runtime import: ' + spec);
      err.unknownSpecifier = spec;
      throw err;
    }
    if (clause && Object.hasOwn(BUILTIN_HELPERS, key)) checkHelperNames(key, spec, clause);
    if (!specs.includes(key)) specs.push(key);
    const ref = `__runtime[${JSON.stringify(key)}]`;
    if (clause) head.push(importBinding(clause.trim(), ref));
    rest = rest.slice(whole.length);
  }
  let body = rest
    .replace(/^export\s+default\s+function\b/m, 'const __default = function')
    .replace(/^export\s+(?=(?:async\s+)?function\b|const\b|let\b|var\b|class\b)/gm, '')
    .replace(/^export\s*\{[^}]*\}\s*;?[ \t]*$/gm, '');
  if (!/const __default = function/.test(body)) {
    throw new Error('compiled module has no default component export');
  }
  body = head.join('\n') + '\n' + body + '\nreturn __default;\n';
  return { body, specs };
}

// checkHelperNames refuses a built-in's import of a name the helper does not
// list (ruling 45): a default, a namespace, or each named binding must be in
// the helper's `names`. The error carries the name and the module specifier.
function checkHelperNames(key, spec, clause) {
  const names = BUILTIN_HELPERS[key].names;
  const refuse = (name) => {
    const err = new Error('helper name not listed: ' + name);
    err.unknownName = name;
    err.unknownSpecifier = spec;
    throw err;
  };
  let c = clause.trim();
  const def = c.match(/^([\w$]+)\s*(?:,\s*|$)/);
  if (def) {
    if (!Object.hasOwn(names, 'default')) refuse('default');
    c = c.slice(def[0].length).trim();
  }
  if (c.startsWith('*')) {
    if (!Object.hasOwn(names, '*')) refuse('*');
  } else if (c.startsWith('{')) {
    for (const part of c.replace(/^\{|\}$/g, '').split(',')) {
      const p = part.trim();
      if (!p) continue;
      const m = p.match(/^([\w$]+)(?:\s+as\s+[\w$]+)?$/);
      if (!m) throw new Error('unsupported import clause: ' + clause);
      if (!Object.hasOwn(names, m[1])) refuse(m[1]);
    }
  }
}

// importBinding renders one import clause as a const over the registry
// entry: `* as $`, `{ a, b as c }`, `def`, and `def, { a }` / `def, * as ns`.
function importBinding(clause, ref) {
  const out = [];
  let c = clause;
  const def = c.match(/^([\w$]+)\s*(?:,\s*|$)/);
  if (def) {
    out.push(`const ${def[1]} = ${ref}.default;`);
    c = c.slice(def[0].length).trim();
  }
  if (c.startsWith('*')) {
    const ns = c.match(/^\*\s*as\s+([\w$]+)$/);
    if (!ns) throw new Error('unsupported import clause: ' + clause);
    out.push(`const ${ns[1]} = ${ref};`);
  } else if (c.startsWith('{')) {
    const inner = c.replace(/^\{|\}$/g, '').trim();
    const parts = inner
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const m = p.match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
        if (!m) throw new Error('unsupported import clause: ' + clause);
        return m[2] ? `${m[1]}: ${m[2]}` : m[1];
      });
    out.push(`const { ${parts.join(', ')} } = ${ref};`);
  } else if (c) {
    throw new Error('unsupported import clause: ' + clause);
  }
  return out.join('\n');
}

// --- compile + check ---------------------------------------------------------

// legacyRefusal words a legacy-syntax refusal (a compile reply, compileclient
// → compilecore.js) through the catalog.
function legacyRefusal(reply) {
  return new ComponentSourceError(S.fill(S.components.legacyRefused, { err: reply.message }), reply.line, reply.column);
}

// compileSource compiles in the worker, then rewrites on this thread; throws
// ComponentSourceError for anything the author must fix, and
// CompileCancelledError when the author stopped the compile.
async function compileSource(source, filename, builtinDir = null, opts = {}) {
  const reply = await compileWork(String(source), filename, opts);
  if (reply.cancelled) throw new CompileCancelledError();
  if (!reply.ok) {
    if (reply.legacy) throw legacyRefusal(reply);
    throw new ComponentSourceError(reply.message, reply.line, reply.column);
  }
  const js = reply.js;
  try {
    return { ...rewriteModule(js, RUNTIME_SPECIFIERS), refs: reply.refs || { components: [], metrics: [], untracked: [] } };
  } catch (e) {
    if (e && e.unknownName) {
      const pos = specifierPosition(String(source), e.unknownSpecifier);
      throw new ComponentSourceError(
        S.fill(S.components.helperNameRefused, { name: e.unknownName, module: e.unknownSpecifier }),
        pos.line,
        pos.column,
      );
    }
    if (e && e.unknownSpecifier) {
      const pos = specifierPosition(String(source), e.unknownSpecifier);
      throw new ComponentSourceError(
        S.fill(S.components.importRefused, { name: e.unknownSpecifier }),
        pos.line,
        pos.column,
      );
    }
    throw new ComponentSourceError(compilerMessage(e), 0, 0);
  }
}

// checkComponentSource is the save-time syntax check: compile + rewrite
// without evaluating anything. {ok: true} or {ok: false, line, column,
// message} (line/column 1-based, 0 when unknown; message is the bare
// reason — the caller positions it).
export async function checkComponentSource(source, filename = 'Component.svelte', builtinDir = null, opts = {}) {
  try {
    const { refs } = await compileSource(source, filename, builtinDir, opts);
    // Every component's references must be trackable by name (the store guards renames and
    // deletes with them). Built-ins get no exemption: the same rule applies to both.
    const [first] = refs.untracked;
    if (first) return { ok: false, line: first.line, column: first.column, message: first.message };
    return { ok: true, refs };
  } catch (e) {
    if (e instanceof ComponentSourceError) {
      return { ok: false, line: e.line, column: e.column, message: e.detail };
    }
    throw e;
  }
}

// --- load + cache ------------------------------------------------------------

// sourceHash: two independent 32-bit FNV-1a lanes + the length — a cache
// KEY, not an integrity check (the entry's source is compared on a hit).
export function sourceHash(source) {
  const s = String(source);
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0') + s.length.toString(16);
}

const cache = new Map(); // hash -> {source, promise}

// loadComponent resolves to the mountable component for `source`
// (compiled once per distinct source per process). A source refusal
// rejects with ComponentSourceError; a module-evaluation error rejects
// with the thrown error. Source refusals stay cached (the same source
// fails the same way); any other failure (the compiler chunk did not
// load, the module threw while evaluating) is dropped so the next mount
// retries.
export function loadComponent(source, filename = 'Component.svelte', builtinDir = null) {
  // A built-in (builtinDir set) and a user component with the same source
  // compile differently (only a built-in may import helpers), so the key
  // carries the directory.
  const key = sourceHash(source) + '|' + (builtinDir || '');
  const hit = cache.get(key);
  if (hit && hit.source === source) return hit.promise;
  const promise = (async () => {
    const { body, specs } = await compileSource(source, filename, builtinDir);
    const runtime = {};
    // Sequential, in import order: evaluation order matters for the
    // flag modules exactly as it would under ESM.
    for (const spec of specs) runtime[spec] = await loadRuntimeModule(spec);
    return new Function('__runtime', body)(runtime);
  })();
  cache.set(key, { source, promise });
  promise.catch((e) => {
    if (e instanceof ComponentSourceError) return;
    const entry = cache.get(key);
    if (entry && entry.promise === promise) cache.delete(key);
  });
  return promise;
}

