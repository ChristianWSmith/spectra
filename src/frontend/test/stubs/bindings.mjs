// Test stand-in for the generated bindings (frontend/bindings) — used by
// src/lib/services-cache.test.js, which must not depend on a live Wails
// backend (or on the yet-to-land GetMatchSummary/GetTeamNames methods).
// services.js imports EVERY service namespace by name at link time, so
// all of them must be exported here; only the methods the cache tests
// drive are implemented. Every call is recorded on `calls` (order +
// args), and `handlers[method]` can script a return/rejection.

export const calls = []; // {method, args}
export const handlers = {}; // method -> (...args) => value | Promise

function rec(method) {
  return (...args) => {
    calls.push({ method, args });
    const h = handlers[method];
    return h ? Promise.resolve(h(...args)) : Promise.resolve(null);
  };
}

export function callCount(method) {
  return calls.filter((c) => c.method === method).length;
}

export function resetCalls() {
  calls.length = 0;
}

// Only the methods the cache tests invoke need real entries; the rest of
// services.js references them lazily inside function bodies.
export const AppService = { GetVersion: rec('GetVersion'), SaveWindowSize: rec('SaveWindowSize') };
export const MetricsService = {
  // Library-wide metric definitions (listMetrics — the read-cache tests).
  ListMetrics: rec('ListMetrics'),
  // The Builder list's keyset window (listMetricsPage) + the two metric
  // mutators whose wrappers must invalidate on success.
  ListMetricsPage: rec('ListMetricsPage'),
  SaveMetric: rec('SaveMetric'),
  DeleteMetric: rec('DeleteMetric'),
  // The Builder form's reads (builder.dom.mjs drives them): the live
  // expression check and the row play's preview.
  ValidateExpr: rec('ValidateExpr'),
  PreviewMetric: rec('PreviewMetric'),
  // The canonical STORED-value reads + the compute-state read
  // (stored-metrics design §5 — the read-path tests drive these; the
  // value reads are cachedRead, the state read deliberately is not).
  GetMetricValuesForMatch: rec('GetMetricValuesForMatch'),
  GetMetricValuesForPlayer: rec('GetMetricValuesForPlayer'),
  GetMetricComputeState: rec('GetMetricComputeState'),
  // The no-execution Compile (provenance for a clean-saved preview) +
  // the one-definition read the scope-routed pin resolves through.
  CompileMetric: rec('CompileMetric'),
  GetMetric: rec('GetMetric'),
};
export const QueryService = {};
// PlatformService: ListPlugins is the Builder mount's fire-and-forget
// plugin-state read (a missing method would throw at mount); the two
// report reads drive test/reports.dom.mjs.
export const PlatformService = {
  ListPlugins: rec('ListPlugins'),
  ListReportTemplates: rec('ListReportTemplates'),
  RenderReport: rec('RenderReport'),
};
export const LibraryService = {
  ImportDialog: rec('ImportDialog'),
  ListMatches: rec('ListMatches'),
  ListMatchesPage: rec('ListMatchesPage'),
  // Honest "N behind" / "N total" count beside the Settings re-run list —
  // same store.MatchListFilter as the list/page (services-cache pins the
  // wrapper's filter normalization + flush).
  CountMatches: rec('CountMatches'),
  ImportPaths: rec('ImportPaths'),
  DeleteMatch: rec('DeleteMatch'),
  Reprocess: rec('Reprocess'),
  CancelJob: rec('CancelJob'),
  // Demo-copy surface (evictable copies + the copy-on-import toggle).
  EvictDemoCopy: rec('EvictDemoCopy'),
  FreeAllDemoCopies: rec('FreeAllDemoCopies'),
  GetDemoCopyOnImport: rec('GetDemoCopyOnImport'),
  SetDemoCopyOnImport: rec('SetDemoCopyOnImport'),
  GetDataInfo: rec('GetDataInfo'),
  // The buytime_ended boundary read loadWorld pulls for the kit evidence.
  GetGenericEvents: rec('GetGenericEvents'),
};
export const MatchService = {
  GetMatch: rec('GetMatch'),
  GetScoreboard: rec('GetScoreboard'),
  GetRounds: rec('GetRounds'),
  // The Match-header read set: getMatch/getRounds/getMatchSummary are the
  // cached reads the Library's hover / job-done warm exercises
  // (library.dom.mjs section M).
  GetMatchSummary: rec('GetMatchSummary'),
  // Event reads the replay world/feed drive (world-hydration.test.js):
  // the anchor list, the per-row detail read and its BULK twin.
  GetEvents: rec('GetEvents'),
  GetEvent: rec('GetEvent'),
  GetEventDetails: rec('GetEventDetails'),
  GetDropDetails: rec('GetDropDetails'),
  // The roster read model: Reports' metrics appendix labels the stored
  // metric_values rows of one match through it (design §5).
  GetPlayerRefs: rec('GetPlayerRefs'),
  // Player sounds (sound_events): the windowed read + the presence count.
  GetSoundEvents: rec('GetSoundEvents'),
  GetSoundEventPresence: rec('GetSoundEventPresence'),
};
export const ReplayService = {};
export const AnalyticsService = {
  // Background recompute (the cache tests pin its completion-driven flush).
  RecomputeAnalysis: rec('RecomputeAnalysis'),
  // The BULK twin: resolves the behind set server-side, answers
  // {submitted, skipped, total} — Settings' Re-run-all button.
  RecomputeAll: rec('RecomputeAll'),
  // In-flight run rehydration for the Settings recompute chips.
  RecomputeStates: rec('RecomputeStates'),
  // Analysis rules: GetConfig seeds the form (and its pristine snapshot),
  // SetConfig is the mutating wrapper the flush pin drives.
  GetConfig: rec('GetConfig'),
  SetConfig: rec('SetConfig'),
  // The per-match analytics family (the six read-cached wrappers).
  GetEconomy: rec('GetEconomy'),
  GetRoundClasses: rec('GetRoundClasses'),
  GetCombatStats: rec('GetCombatStats'),
  GetClutches: rec('GetClutches'),
  GetEngagements: rec('GetEngagements'),
  GetUtility: rec('GetUtility'),
};
export const ProfileService = {
  // Profile reads + the library-wide player list (cached wrappers).
  GetProfile: rec('GetProfile'),
  ListPlayers: rec('ListPlayers'),
  GetCareerTrend: rec('GetCareerTrend'),
};
export const VoiceService = {
  // Voice index reads (the read-cache tests drive these).
  GetVoicePresence: rec('GetVoicePresence'),
  GetVoicePlayers: rec('GetVoicePlayers'),
  GetVoiceLanes: rec('GetVoiceLanes'),
  GetVoiceIndex: rec('GetVoiceIndex'),
};
export const MapPackService = {
  // Radar extraction (lib/assets.test.js drives the three-family run).
  ExtractMapPacks: rec('ExtractMapPacks'),
};
export const IconService = {
  ExtractIcons: rec('ExtractIcons'),
};
export const SoundService = {
  ExtractSounds: rec('ExtractSounds'),
};
export const DialogService = {};
export const KVStoreService = { Get: rec('GetPref'), Set: rec('SetPref') };
