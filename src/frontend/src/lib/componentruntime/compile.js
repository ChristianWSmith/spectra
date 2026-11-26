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

// --- built-in helpers ----------------------
// A BUILT-IN panel may import a small, curated set of app helpers. A USER
// component may import no app module (only the public runtime modules in
// RUNTIME_MODULES above; the save gate refuses every other import, at its
// line). Each helper module is listed here by its path from the frontend root, with the NAMES a built-in may take from it and a
// line on what each name is for. A name not listed is refused at save
// (checkComponentSource with a builtin directory). Adding a helper or a name
// is a review: add it here, document it, and the coverage test in
// builtinedits.test.js pins that the name is exported by its module.
//
// The key of a helper is its path from the frontend root (`src/lib/…`), so a
// built-in's relative import (`../../services.js`) resolves to the same key
// from every panel that imports it. `load` is a dynamic import, so the
// helper modules are not loaded until a built-in that uses them mounts.
//
// `names` maps each allowed export to its purpose. `'*'` allows the whole
// namespace (`import * as S`); `'default'` allows a component's default export.
// Two helpers are modules the app loads at startup anyway (services.js and
// workstate.svelte.js). Their helper entries read the module App hands in
// (provideHelperModule) instead of a dynamic import: a dynamic import of a
// module that is also static splits nothing and makes Vite warn, and a static
// import here would drag services.js (and the bindings it links) into every
// node-side import of this file.
const providedHelpers = new Map();
export function provideHelperModule(key, namespace) {
  providedHelpers.set(key, namespace);
}
// Where a helper lives, relative to this file, for callers that never provide
// it (the node and jsdom drivers mount built-ins without App). The app always
// provides both at startup, so this import never runs in the app; the specifier
// is a variable, so the bundler does not try to resolve it.
const HELPER_PATHS = {
  'src/lib/services.js': '../services.js',
  'src/lib/workstate.svelte.js': '../workstate.svelte.js',
};
function providedHelper(key) {
  if (providedHelpers.has(key)) return Promise.resolve(providedHelpers.get(key));
  return import(/* @vite-ignore */ new URL(HELPER_PATHS[key], import.meta.url).href);
}

export const BUILTIN_HELPERS = Object.freeze({
  'src/lib/services.js': {
    load: () => providedHelper('src/lib/services.js'),
    names: {
      errText: 'the one error-text normalizer (a rejection to a sentence)',
      listMetrics: 'the metric definitions (read)',
      listPlayers: 'the player list (read)',
      listReportTemplates: 'the report templates (read)',
      getProfile: 'one player profile (read)',
      getCareerTrend: 'one metric across a player’s matches (read)',
      getMatch: 'one match row (read)',
      getVoicePresence: 'a match’s voice presence (read)',
      evictDemoCopy: 'free Spectra’s own copy of a match’s demo (write, the Free copy button)',
      getScoreboard: 'a match scoreboard (read)',
      getRounds: 'a match’s rounds (read)',
      getHeatmap: 'heatmap points for a match (read)',
      getKillTags: 'a match’s kill tags (read)',
      getClutches: 'a match’s clutches (read)',
      getEntitySummary: 'a diagnostics summary for one entity (read)',
      getProvenance: 'a match’s provenance (read)',
      getPref: 'one stored preference (read)',
      getMetricValuesForMatch: 'stored metric values for a match (read)',
      getMetricComputeState: 'a metric’s compute state (read)',
      getPlayerRefs: 'player references for a report (read)',
      renderReport: 'a report rendered from stored values (read)',
      onMetricDone: 'listen for a metric finishing (event)',
    },
  },
  'src/lib/componentruntime/reads.js': {
    load: () => import('./reads.js'),
    names: {
      metricsByMatch: 'one player’s stored values and states across many matches (read, History)',
    },
  },
  'src/lib/strings/index.js': {
    load: () => import('../strings/index.js'),
    names: { '*': 'the app copy catalog (S.*)' },
  },
  'src/lib/fmt.js': {
    load: () => import('../fmt.js'),
    names: {
      plural: 'the singular or plural word for a count',
      fmt1: 'a number to one decimal',
      fmt2: 'a number to two decimals',
      fmtInt: 'a whole number with grouping',
      fmtPercent: 'a fraction as a percentage',
      fmtDate: 'a timestamp as a date',
      fmtMetric: 'a stored value in its metric format',
      fmtBytes: 'a byte count as a size',
      fmtPatch: 'a game patch label',
      roundClock: 'a round time as a clock',
    },
  },
  'src/lib/metricorder.js': {
    load: () => import('../metricorder.js'),
    names: {
      DEFAULT_CARDS: 'the default card set of the Profile view',
      composedSequence: 'the default metric order, merged with fixed entries',
      inSequence: 'the default metric order (metric entries only)',
      rawItems: 'the recorded-value offers',
      isRawId: 'whether an id is a recorded value',
    },
  },
  'src/lib/metricstate.js': {
    load: () => import('../metricstate.js'),
    names: {
      metricPresentation: 'how a metric state is shown',
      metricStateTitle: 'the hover title of a metric state',
      liveMetricState: 'a metric’s live state',
    },
  },
  'src/lib/teams.js': {
    load: () => import('../teams.js'),
    names: {
      playerSideClassAt: 'the team colour class of a player on a round',
      teamStartClass: 'the team colour class of a side at the start',
    },
  },
  'src/lib/rounds.js': {
    load: () => import('../rounds.js'),
    names: {
      isCounted: 'whether a round counts in the match',
      roundScoreLabel: 'a round’s score label',
    },
  },
  'src/lib/players.js': {
    load: () => import('../players.js'),
    names: { listedPlayers: 'the players a list shows (bots filtered)' },
  },
  'src/lib/viewstate.svelte.js': {
    load: () => import('../viewstate.svelte.js'),
    names: {
      seed: 'a view’s remembered state when it opens (view-local)',
      remember: 'store a view’s state for its next open (view-local)',
      matchKey: 'the key a match’s view state is kept under',
      matchRecord: 'a match panel’s registry record: seeded at init, followed across matches, remembered on change',
    },
  },
  'src/lib/nav.js': {
    load: () => import('../nav.js'),
    names: {
      replayHash: 'the route to a replay at a point',
      entryLoopAround: 'the loop span around a replay entry',
      entryLoopSpanAround: 'the loop span around a replay entry, as a span',
      LOOP_SECS_DEFAULT: 'the default loop length in seconds',
    },
  },
  'src/lib/download.js': {
    load: () => import('../download.js'),
    names: {
      downloadCanvasPNG: 'the user saves a canvas as a PNG (a chosen file)',
      downloadText: 'the user saves text as a file (a chosen file)',
    },
  },
  'src/lib/heatkinds.js': {
    load: () => import('../heatkinds.js'),
    names: {
      HEAT_CORE_KINDS: 'the heatmap event kinds shown by default',
      HEAT_GRENADE_THROW_KINDS: 'the grenade throw kinds',
      HEAT_GRENADE_DET_KINDS: 'the grenade detonation kinds',
      heatKindLabel: 'the label of a heatmap kind',
      heatRegionFilter: 'the region filter of a heatmap kind',
      heatRegionTakesBBox: 'whether a region filter takes a box',
    },
  },
  'src/lib/heatramp.js': {
    load: () => import('../heatramp.js'),
    names: {
      HEAT_STOPS: 'the colour stops of a heatmap',
      DEATH_STOPS: 'the colour stops of a death heatmap',
      rampCss: 'a colour ramp as CSS',
      signedRampCss: 'a signed colour ramp as CSS',
    },
  },
  'src/lib/components/mapxform.js': {
    load: () => import('../components/mapxform.js'),
    names: { loadMapPack: 'the map pack a radar is drawn on (read)' },
  },
  'src/lib/definitions.js': {
    load: () => import('../definitions.js'),
    names: {
      KILL_TAG_DIST_DEF: 'the default kill tag distance',
      KILL_TAG_KIND_TITLES: 'the titles of kill tag kinds',
    },
  },
  'src/lib/replay/landmarks.js': {
    load: () => import('../replay/landmarks.js'),
    names: { roundsByNumber: 'a match’s rounds keyed by number' },
  },
  'src/lib/router.js': {
    load: () => import('../router.js'),
    names: {
      MATCH_TABS: 'the Match view’s tab names, in order',
      matchTabSlug: 'a Match tab’s URL segment (the back path a drill-down returns to)',
    },
  },
  'src/lib/workstate.svelte.js': {
    load: () => providedHelper('src/lib/workstate.svelte.js'),
    names: { runWork: 'run a piece of background work, shown in the work indicator' },
  },
  'src/lib/economysource.svelte.js': {
    load: () => import('../economysource.svelte.js'),
    names: { economySource: 'the economy a panel shows: its own load alone, the composer’s data when given' },
  },
  'src/lib/builtins/match/combatpanel.svelte.js': {
    load: () => import('../builtins/match/combatpanel.svelte.js'),
    names: { combatPanel: 'the data layer of a Combat panel: the match’s list with its side data, the error line, the loop length and the replay a row opens' },
  },
  'src/lib/builtins/profile/splittable.svelte.js': {
    load: () => import('../builtins/profile/splittable.svelte.js'),
    names: { splitTable: 'the data of a profile split table (sides, maps, weapons) for the player, reloaded on change' },
  },
  'src/lib/loopsecs.js': {
    load: () => import('../loopsecs.js'),
    names: { loadLoopSecs: 'the user’s loop length, read once (the default when unset or unreadable)' },
  },
  'src/lib/sortstate.js': {
    load: () => import('../sortstate.js'),
    names: {
      compareAsc: 'the ascending order of two values (-1, 0, 1)',
    },
  },
  'src/lib/keys.js': {
    load: () => import('../keys.js'),
    names: {
      activateOnKey: 'keyboard activation of a clickable row (Enter, and Space unless enterOnly)',
      openRow: 'a clickable row’s handlers (click and keyboard), spread onto the row',
      CONTROL_SELECTOR: 'the selector of the controls inside a row (their clicks are not the row’s)',
    },
  },
  'src/lib/current.js': {
    load: () => import('../current.js'),
    names: {
      whileCurrent: 'run a load for an effect, dropping a result that is out of date',
      whenCurrent: 'a promise callback that runs only while its load is current',
      loadForMatch: 'the effect body of a panel that loads for the match and applies the result while current',
      latestOnly: 'a runner for one kind of load: only the newest load’s result applies',
      loadThen: 'a panel load: the result applies while current, a failure goes to the frame (or its own handler)',
    },
  },
  'src/lib/metricreads.js': {
    load: () => import('../metricreads.js'),
    names: {
      readMetrics: 'read several stored metrics by name, a failed read shown as its own state',
    },
  },
  'src/lib/metricslive.svelte.js': {
    load: () => import('../metricslive.svelte.js'),
    names: { liveMetrics: 'a panel’s metric progress and reload wiring (call once at the top level)' },
  },
  'src/lib/builtins/match/panelhelpers.js': {
    load: () => import('../builtins/match/panelhelpers.js'),
    names: {
      SQL_FACTS: 'the stored facts read of the details panel',
      SQL_ROSTER: 'the match roster read (humans only, the default order)',
      SQL_ROUNDS: 'the rounds read of the rounds panel',
      SQL_SWITCHES: 'the side-switch count read',
      SQL_MATCH_TICK_RATE: 'the match tick rate read',
      SQL_ROUND_MVP_REASON: 'a round’s MVP reason read',
      SQL_ROUND_KILLS: 'a round’s kill rows read',
      SQL_ROUND_BOMBS: 'a round’s bomb rows read',
      SQL_ROUND_ECONOMY: 'a round’s economy rows read',
      SQL_ROUND_SIDE_CLASSES: 'a round’s side class rows read',
      SQL_ROUND_CHAT: 'a round’s chat rows read',
      SQL_TEAMS: 'the team names read',
      STATE_WORD: 'the words of a metric state (calculating, failed, out of date)',
      cellText: 'one stored value as its cell text',
      readFrameBase: 'the base reads of a match panel: roster, team rows, side switches',
      kdaText: 'a player’s kills/deaths/assists line as cell text',
      matchPres: 'one stored value’s cell presentation (value, dash or state)',
      cellValue: 'one stored value, or null when not fresh',
      fill: 'fill a {placeholder} in catalog copy',
      fmtBytes: 'a byte count as a size',
      fmtDate: 'an import time as a date',
      fmtDuration: 'a round duration as a clock',
      numOf: 'a stored value as a number (NaN when absent)',
      parseStamp: 'the stored import time, read as Go wrote it',
      readUnit: 'one metric read for this match, with its state',
      roundLabel: 'a round’s number label',
      roundOf: 'one stored round row, shaped for the panel',
      sortRows: 'the chained sort of the scoreboard',
      startClass: 'the team colour class of a side at the start',
    },
  },
  'src/lib/builtinhelpers.js': {
    load: () => import('../builtinhelpers.js'),
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
    },
  },
  'src/lib/builtins/match/combatdata.js': {
    load: () => import('../builtins/match/combatdata.js'),
    names: { loadCombatSide: 'one side’s combat rows for a match (read)' },
  },
  'src/lib/builtins/match/combatmodel.js': {
    load: () => import('../builtins/match/combatmodel.js'),
    names: {
      KILL_TAG_KINDS: 'the kill tag kinds',
      groupKillTags: 'group kill tags into duels',
      clutchKillTicks: 'the kill ticks of a clutch',
    },
  },
  'src/lib/builtins/profile/shared.js': {
    load: () => import('../builtins/profile/shared.js'),
    names: {
      cell: 'one stored value as a table cell',
      dimValue: 'one dimension value of a breakdown',
      dimsOf: 'the dimensions of a breakdown',
      emptyChip: 'the chip shown for an empty breakdown',
      readCell: 'the cell of a whole-subject read (one value per player)',
      loadSeeds: 'load the profile’s seed values (read)',
      loadSplit: 'load a breakdown’s catalog and its values for the player (read)',
      loadProfile: 'the metric catalog and one player’s profile, read together',
      defaultCardDefs: 'the profile-scope definitions of the default career cards',
    },
  },
  'src/lib/builtins/reports/shared.js': {
    load: () => import('../builtins/reports/shared.js'),
    names: {
      findTemplate: 'find a report template by id',
      reportFilename: 'the file name of a report export',
      targetReady: 'whether a report target is ready to render',
      compositeText: 'the text of a composed report',
    },
  },
  'src/lib/components/StatusChip.svelte': {
    load: () => import('../components/StatusChip.svelte'),
    names: { default: 'the state chip (a component)' },
  },
  'src/lib/components/LoadBox.svelte': {
    load: () => import('../components/LoadBox.svelte'),
    names: { default: 'the loading shell (a component)' },
  },
  'src/lib/components/MetricCell.svelte': {
    load: () => import('../components/MetricCell.svelte'),
    names: { default: 'the body of a stored-value table cell (a value, a dash, or a state as a chip or a word)' },
  },
  'src/lib/components/WinnerCell.svelte': {
    load: () => import('../components/WinnerCell.svelte'),
    names: { default: 'the winner chip of a round: the team name, or the side' },
  },
  'src/lib/components/RetryButton.svelte': {
    load: () => import('../components/RetryButton.svelte'),
    names: { default: 'the button a panel shows beside a failed read, to load it again' },
  },
  'src/lib/components/SortTh.svelte': {
    load: () => import('../components/SortTh.svelte'),
    names: { default: 'a sortable table header cell (the view keeps its own sort state)' },
  },
  'src/lib/components/MetricTd.svelte': {
    load: () => import('../components/MetricTd.svelte'),
    names: { default: 'a numeric table cell that shows one stored value' },
  },
  'src/lib/components/EmptyTableRow.svelte': {
    load: () => import('../components/EmptyTableRow.svelte'),
    names: { default: 'the one row a table shows when it has nothing to list (a state chip, or the text)' },
  },
  'src/lib/components/EmptyNote.svelte': {
    load: () => import('../components/EmptyNote.svelte'),
    names: { default: 'the line a panel shows where there is nothing to show (its text is the children)' },
  },
  'src/lib/components/ErrorBanner.svelte': {
    load: () => import('../components/ErrorBanner.svelte'),
    names: { default: 'the one error line a panel shows (its text is the children)' },
  },
  'src/lib/components/StatCard.svelte': {
    load: () => import('../components/StatCard.svelte'),
    names: { default: 'a stat card (a component)' },
  },
  'src/lib/components/SuggestInput.svelte': {
    load: () => import('../components/SuggestInput.svelte'),
    names: { default: 'a suggestion input (a component)' },
  },
  'src/lib/components/PlayerPicker.svelte': {
    load: () => import('../components/PlayerPicker.svelte'),
    names: { default: 'a player picker (a component)' },
  },
  'src/lib/components/TokenSelect.svelte': {
    load: () => import('../components/TokenSelect.svelte'),
    names: { default: 'a token select (a component)' },
  },
  'src/lib/components/EventPlay.svelte': {
    load: () => import('../components/EventPlay.svelte'),
    names: { default: 'a replay play control for one event (a component)' },
  },
  'src/lib/components/ProfileLink.svelte': {
    load: () => import('../components/ProfileLink.svelte'),
    names: { default: 'a link to a player’s profile (a component)' },
  },
  'src/lib/components/Popover.svelte': {
    // A driver may provide the bundled component (the source-mounting DOM harnesses do); the app imports it.
    load: () =>
      providedHelpers.has('src/lib/components/Popover.svelte')
        ? Promise.resolve(providedHelpers.get('src/lib/components/Popover.svelte'))
        : import('../components/Popover.svelte'),
    names: { default: 'a popover (a component)' },
  },
  'src/lib/components/HeatmapLayer.svelte': {
    load: () => import('../components/HeatmapLayer.svelte'),
    names: { default: 'a heatmap layer (a component)' },
  },
  'bindings/github.com/ChristianWSmith/spectra': {
    load: () => import('../../../bindings/github.com/ChristianWSmith/spectra'),
    names: { AnalyticsService: 'the analytics service the heatmap reads (read)' },
  },
});

// helperKey resolves a built-in's relative import to its helper key: the
// directory of the built-in's source (frontend-relative) joined with the
// import's path, with `.` and `..` folded.
export function helperKey(dir, spec) {
  const parts = [];
  for (const p of `${dir}/${spec}`.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') parts.pop();
    else parts.push(p);
  }
  return parts.join('/');
}

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
export function rewriteModule(js, known = RUNTIME_SPECIFIERS, builtinDir = null) {
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
    // A runtime module is imported by its own specifier. A built-in's
    // relative import is a curated helper (BUILTIN_HELPERS), keyed by the
    // built-in's directory. Anything else is refused.
    let key = spec;
    if (!allowed.has(spec)) {
      key = builtinDir != null && spec.startsWith('.') ? helperKey(builtinDir, spec) : null;
      if (!key || !Object.hasOwn(BUILTIN_HELPERS, key)) {
        const err = new Error('unknown runtime import: ' + spec);
        err.unknownSpecifier = spec;
        throw err;
      }
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
    return { ...rewriteModule(js, RUNTIME_SPECIFIERS, builtinDir), refs: reply.refs || { components: [], metrics: [], untracked: [] } };
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
    // A user component's references must be trackable by name (the store guards renames and
    // deletes with them); a builtin's are curated code, so they pass.
    const [first] = refs.untracked;
    if (first && !builtinDir) return { ok: false, line: first.line, column: first.column, message: first.message };
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

