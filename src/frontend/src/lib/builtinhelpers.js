// The one surface a component imports from (AGENTS.md "Helper surface"), as
// 'spectra/helpers'. The helper definitions are in helperdefs.js; this file adds the
// shared display components and the built-ins' own helper modules. Every name here is
// listed in BUILTIN_HELPERS (componentruntime/compile.js).
export * from './helperdefs.js';
// the shared display components, and the built-ins' own helper modules. A user component
// reaches it as 'spectra/helpers'; a built-in reaches it the same way. Every name here is
// listed in BUILTIN_HELPERS (componentruntime/compile.js); a name not listed is not importable.
export { getPref, onMetricDone } from './services.js';
export { metricsByMatch } from './componentruntime/reads.js';
export { replayHash } from './nav.js';
export { combatPanel } from './builtins/match/combatpanel.svelte.js';
export { splitTable } from './builtins/profile/splittable.svelte.js';
export { activateOnKey } from './keys.js';
export { whenCurrent } from './current.js';
export { readMetrics } from './metricreads.js';
export { SQL_FACTS, SQL_ROUNDS, SQL_SWITCHES, SQL_MATCH_TICK_RATE, SQL_ROUND_MVP_REASON, SQL_ROUND_KILLS, SQL_ROUND_BOMBS, SQL_ROUND_ECONOMY, SQL_ROUND_SIDE_CLASSES, SQL_ROUND_CHAT, STATE_WORD, cellText, readFrameBase, kdaText, matchPres, cellValue, fill, numOf, parseStamp, readUnit, roundLabel, roundOf, sortRows, startClass } from './builtins/match/panelhelpers.js';
export { loadCombatSide } from './builtins/match/combatdata.js';
export { KILL_TAG_KINDS, groupKillTags, clutchKillTicks } from './builtins/match/combatmodel.js';
export { cell, dimValue, dimsOf, emptyChip, readCell, loadSeeds, loadSplit, loadProfile, defaultCardDefs } from './builtins/profile/shared.js';
export { findTemplate, reportFilename, targetReady, compositeText } from './builtins/reports/shared.js';
export { default as StatusChip } from './components/StatusChip.svelte';
export { default as LoadBox } from './components/LoadBox.svelte';
export { default as MetricCell } from './components/MetricCell.svelte';
export { default as WinnerCell } from './components/WinnerCell.svelte';
export { default as RetryButton } from './components/RetryButton.svelte';
export { default as SortTh } from './components/SortTh.svelte';
export { default as MetricTd } from './components/MetricTd.svelte';
export { default as EmptyTableRow } from './components/EmptyTableRow.svelte';
export { default as EmptyNote } from './components/EmptyNote.svelte';
export { default as ErrorBanner } from './components/ErrorBanner.svelte';
export { default as StatCard } from './components/StatCard.svelte';
export { default as SuggestInput } from './components/SuggestInput.svelte';
export { default as PlayerPicker } from './components/PlayerPicker.svelte';
export { default as TokenSelect } from './components/TokenSelect.svelte';
export { default as EventPlay } from './components/EventPlay.svelte';
export { default as ProfileLink } from './components/ProfileLink.svelte';
export { default as Popover } from './components/Popover.svelte';
export { default as HeatmapLayer } from './components/HeatmapLayer.svelte';
