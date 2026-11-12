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
export const MetricsService = {};
export const QueryService = {};
export const PlatformService = {};
export const LibraryService = {
  ImportDialog: rec('ImportDialog'),
  ListMatches: rec('ListMatches'),
  ListMatchesPage: rec('ListMatchesPage'),
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
};
export const MatchService = {
  GetMatch: rec('GetMatch'),
  GetScoreboard: rec('GetScoreboard'),
  GetRounds: rec('GetRounds'),
  // Player sounds (sound_events): the windowed read + the presence count.
  GetSoundEvents: rec('GetSoundEvents'),
  GetSoundEventPresence: rec('GetSoundEventPresence'),
};
export const ReplayService = {};
export const AnalyticsService = {};
export const ProfileService = {};
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
