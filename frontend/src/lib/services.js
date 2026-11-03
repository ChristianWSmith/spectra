// Thin async wrappers over the generated bindings + event glue.
//
// Event subscription: @wailsio/runtime 3.0.0 exposes the event API on the
// `Events` namespace — `Events.On(name, cb)` returns an unsubscribe fn and
// the callback receives a WailsEvent `{name, data}` (the Go payload lives
// in `.data`). There is no `EventsOn`/`EventsOff` in v3.
import { Events } from '@wailsio/runtime';
import {
  AppService,
  MetricsService,
  QueryService,
  PlatformService,
  LibraryService,
  MatchService,
  ReplayService,
  AnalyticsService,
  ProfileService,
  VoiceService,
  MapPackService,
  DialogService,
} from '../../bindings/github.com/ChristianWSmith/spectra';
import { KVStoreService } from '../../bindings/github.com/wailsapp/wails/v3/pkg/services/kvstore';
import { HANDOFF_KEYS, setHandoff, takeHandoff } from './handoff.js';

// --- Error text ---------------------------------------------------------------
// The one errText: normalizes a Go/binding rejection (Error, string, null)
// into the short message every view shows in its error slot. Views used to
// each carry a byte-identical copy — import this instead.

export function errText(e) {
  if (e == null) return 'unknown error';
  if (typeof e === 'string') return e;
  return e.message || String(e);
}

// --- AppService ---------------------------------------------------------------

export function getVersion() {
  return AppService.GetVersion();
}

export function saveWindowSize(w, h) {
  return AppService.SaveWindowSize(w, h);
}

// Immediate update check (Settings → About → Check for Updates). Unlike the
// silent startup check this always reports an outcome — the framework's
// update window opens even when already up to date.
export function checkForUpdateNow() {
  return AppService.CheckForUpdateNow();
}

// --- LibraryService -----------------------------------------------------------

export function importDialog() {
  return LibraryService.ImportDialog();
}

export function importPaths(paths) {
  return LibraryService.ImportPaths(paths);
}

export function listMatches(query, sortKey, desc) {
  return LibraryService.ListMatches(query, sortKey, desc);
}

export function deleteMatch(id, deleteOriginal) {
  return LibraryService.DeleteMatch(id, deleteOriginal);
}

export function reprocess(id) {
  return LibraryService.Reprocess(id);
}

export function cancelJob(id) {
  return LibraryService.CancelJob(id);
}

export function listJobs() {
  return LibraryService.ListJobs();
}

export function getGenericHistogram(id) {
  return LibraryService.GetGenericHistogram(id);
}

export function getWarnings(id) {
  return LibraryService.GetWarnings(id);
}

export function getGenericEvents(id, name, limit) {
  return LibraryService.GetGenericEvents(id, name, limit);
}

export function getDataInfo() {
  return LibraryService.GetDataInfo();
}

// --- MatchService -------------------------------------------------------------

export function getMatch(id) {
  return MatchService.GetMatch(id);
}

export function getScoreboard(id, sortKey, desc) {
  return MatchService.GetScoreboard(id, sortKey, desc);
}

export function getRounds(id) {
  return MatchService.GetRounds(id);
}

export function getRoundDetail(id, round) {
  return MatchService.GetRoundDetail(id, round);
}

// round must be -1 for "all rounds" (0 means round zero); kind/steamId ""
// = all; limit 0 = up to the store's 50k hard cap.
export function getEvents(filter) {
  return MatchService.GetEvents(filter);
}

export function getEvent(id) {
  return MatchService.GetEvent(id);
}

// round -1 = all rounds.
export function getChat(matchId, round) {
  return MatchService.GetChat(matchId, round);
}

// --- ReplayService ------------------------------------------------------------
// Bulk position bytes do NOT ride the bindings (base64-inflated); the Replay
// view fetches them from HTTP /api/sidecar/<matchId>/positions directly.

export function getReplayMeta(id) {
  return ReplayService.GetReplayMeta(id);
}

export function getLandmarks(id) {
  return ReplayService.GetLandmarks(id);
}

// --- Events -------------------------------------------------------------------

// onEvent subscribes to a Wails event; returns an unsubscribe fn (safe to
// return from a Svelte $effect cleanup).
export function onEvent(name, callback) {
  return Events.On(name, (ev) => callback(ev && ev.data));
}

// --- Job-progress store -------------------------------------------------------
// Tiny store the Library subscribes to: keyed by jobId, holds the latest
// {jobId, stage, progress, matchId} from spectra:job-progress. job-done
// removes the entry. Views read it via subscribeJobProgress.

const jobProgress = new Map(); // jobId -> payload
const jobSubs = new Set();
let jobEventsOn = false;

function emitJobs() {
  const snapshot = new Map(jobProgress);
  for (const fn of jobSubs) fn(snapshot);
}

function ensureJobEvents() {
  if (jobEventsOn) return;
  jobEventsOn = true;
  Events.On('spectra:job-progress', (ev) => {
    const d = ev && ev.data;
    if (d && d.jobId != null) {
      jobProgress.set(d.jobId, d);
      emitJobs();
    }
  });
  Events.On('spectra:job-done', (ev) => {
    const d = ev && ev.data;
    if (d && d.jobId != null) {
      jobProgress.delete(d.jobId);
      emitJobs();
    }
  });
}

// subscribeJobProgress registers cb with the current snapshot immediately and
// on every change; returns an unsubscribe fn ($effect cleanup).
export function subscribeJobProgress(cb) {
  ensureJobEvents();
  jobSubs.add(cb);
  cb(new Map(jobProgress));
  return () => jobSubs.delete(cb);
}

// onJobDone / onLibraryChanged / onFilesDropped are the refresh triggers.
export function onJobDone(callback) {
  return onEvent('spectra:job-done', callback);
}

export function onLibraryChanged(callback) {
  return onEvent('spectra:library-changed', callback);
}

// files-dropped payload: {files: string[]} — only reaches JS when the
// pointer is over an element with data-file-drop-target (or a descendant).
export function onFilesDropped(callback) {
  return onEvent('spectra:files-dropped', callback);
}

// --- Cross-view hand-off ------------------------------------------------------
// The one-shot sessionStorage contract lives in lib/handoff.js (key table,
// read-once semantics and every writer/reader). These are the named
// wrappers the views call; both swallow storage failures — a hand-off that
// could not be written simply arrives empty at the receiver.

export function setPendingTimelineFilter(filter) {
  try {
    setHandoff(HANDOFF_KEYS.timelineFilter, filter);
  } catch (e) {
    console.error(e);
  }
}

export function takePendingTimelineFilter() {
  return takeHandoff(HANDOFF_KEYS.timelineFilter);
}

// Replay-seek hand-off: {tick} (Replay also honours optional play/voice
// booleans; the other readers ignore what they don't know). Writers set it
// just before navigating to #/replay/:id; Replay reads + clears it on
// mount and seeks to that tick. null clears any stale value without
// writing one.
export function setPendingSeek(seek) {
  try {
    setHandoff(HANDOFF_KEYS.replaySeek, seek);
  } catch (e) {
    console.error(e);
  }
}

export function takePendingSeek() {
  return takeHandoff(HANDOFF_KEYS.replaySeek);
}

// --- AnalyticsService (M3) ---------------------------------------------------

export function getAnalysisConfig() { return AnalyticsService.GetConfig(); }
export function setAnalysisConfig(cfg) { return AnalyticsService.SetConfig(cfg); }
export function recomputeAnalysis(matchId) { return AnalyticsService.RecomputeAnalysis(matchId); }
export function getEconomy(matchId) { return AnalyticsService.GetEconomy(matchId); }
export function getRoundClasses(matchId) { return AnalyticsService.GetRoundClasses(matchId); }
export function getPlayerRounds(matchId, steamId) { return AnalyticsService.GetPlayerRounds(matchId, steamId || ''); }
export function getClutches(matchId) { return AnalyticsService.GetClutches(matchId); }
export function getEngagements(matchId, kind) { return AnalyticsService.GetEngagements(matchId, kind || ''); }
export function getUtility(matchId) { return AnalyticsService.GetUtility(matchId); }
export function getCombatStats(matchId) { return AnalyticsService.GetCombatStats(matchId); }
export function getHeatmap(matchId, kind, filter) { return AnalyticsService.GetHeatmap(matchId, kind, filter || {}); }
export function listSavedFilters() { return AnalyticsService.ListSavedFilters(); }
export function saveFilter(name, scope, filterJson) { return AnalyticsService.SaveFilter(name, scope, filterJson); }
export function deleteSavedFilter(id) { return AnalyticsService.DeleteSavedFilter(id); }

// --- VoiceService (M4) -------------------------------------------------------
// Bulk PCM/WAV audio does NOT ride the bindings — it is fetched from the
// HTTP routes /api/sidecar/<id>/voice/pcm|wav (see replay/audio.js).

export function getVoicePresence(id) { return VoiceService.GetVoicePresence(id); }
export function getVoicePlayers(id) { return VoiceService.GetVoicePlayers(id); }
export function getVoiceLanes(id, buckets) { return VoiceService.GetVoiceLanes(id, buckets || 180); }

// voiceWavURL is the per-player full-track download link (anchor `download`).
export function voiceWavURL(matchId, steamId) {
  return `/api/sidecar/${matchId}/voice/wav?steamId=${encodeURIComponent(steamId)}`;
}

// --- ProfileService (M3) -----------------------------------------------------

export function getProfile(steamId) { return ProfileService.GetProfile(steamId); }
export function listPlayers(query) { return ProfileService.ListPlayers(query || ''); }
export function getCareerTrend(steamId, metric) { return ProfileService.GetCareerTrend(steamId, metric); }

// M3 pending-filter contract: setPendingTimelineFilter() accepts the extended
// EventFilter shape too — {kind, steamId, round, weapon, tickFrom, tickTo,
// dmgMin, dmgMax, distanceMax, headshotOnly, bbox:{minX,minY,maxX,maxY}} —
// Timeline applies any subset. Heatmap click → setPendingTimelineFilter({bbox}).

// --- MetricsService (M5) -----------------------------------------------------

export function listMetrics() { return MetricsService.ListMetrics(); }
export function getMetric(id) { return MetricsService.GetMetric(id); }
export function saveMetric(m) { return MetricsService.SaveMetric(m); }
export function deleteMetric(id) { return MetricsService.DeleteMetric(id); }
export function previewMetric(id, expr, groupBy, scope, limit) {
  return MetricsService.PreviewMetric(id, expr || '', groupBy || '', scope || '', limit || 200);
}
export function validateExpr(expr, groupBy) { return MetricsService.ValidateExpr(expr, groupBy || ''); }

// --- QueryService (M5) -------------------------------------------------------

export function runQuery(sql, limit, timeoutMS) { return QueryService.Run(sql, limit || 0, timeoutMS || 0); }
export function getSchema() { return QueryService.GetSchema(); }
export function listSavedQueries() { return QueryService.ListSavedQueries(); }
export function saveQuery(name, sql) { return QueryService.SaveQuery(name, sql); }
export function deleteQuery(id) { return QueryService.DeleteQuery(id); }
export function listQueryHistory(limit) { return QueryService.ListHistory(limit || 50); }
export function clearQueryHistory() { return QueryService.ClearHistory(); }

// --- PlatformService (M5) ----------------------------------------------------

export function getProvenance(matchId) { return PlatformService.GetProvenance(matchId); }
export function getConVars(matchId) { return PlatformService.GetConVars(matchId); }
export function getEntitySummary(matchId) { return PlatformService.GetEntitySummary(matchId); }
export function getSpatialSeries(matchId, kind, buckets) {
  return PlatformService.GetSpatialSeries(matchId, kind, buckets || 120);
}
export function listPlugins() { return PlatformService.ListPlugins(); }
export function installPlugin(path) { return PlatformService.InstallPlugin(path); }
export function setPluginEnabled(id, enabled) { return PlatformService.SetPluginEnabled(id, enabled); }
export function removePlugin(id) { return PlatformService.RemovePlugin(id); }
export function listReportTemplates() { return PlatformService.ListReportTemplates(); }
export function renderReport(templateId, matchId, steamId, round) {
  return PlatformService.RenderReport(templateId, matchId || 0, steamId || '', round || 0);
}
// Report file downloads + DB copy ride HTTP: /api/export/<matchId>/report?template=&format=md|html
export function reportDownloadURL(matchId, templateId, format) {
  return `/api/export/${matchId}/report?template=${encodeURIComponent(templateId)}&format=${format}`;
}

// --- MapPackService -----------------------------------------------------------
// Radar extraction from the user's local CS2 install (Valve IP stays
// local — see internal/mappack). Packs load through loadMapPack().

export function getMapPackStatus() { return MapPackService.GetMapPackStatus(); }
export function extractMapPacks(cs2Dir) { return MapPackService.ExtractMapPacks(cs2Dir || ''); }
export function setMapPackPromptState(state, path) {
  return MapPackService.SetMapPackPromptState(state || '', path || '');
}
export function chooseCS2Dir() { return MapPackService.ChooseCS2Dir(); }

// --- DialogService (native file dialogs) --------------------------------------
// The webview can't open OS dialogs or write files; save.js wraps these into
// the saveText/saveBlob/saveExportURL helpers every download path uses.

// SaveFile opens the native save dialog; resolves to the absolute path or
// "" when the user cancels.
export function saveFile(defaultName, extensions) {
  return DialogService.SaveFile(defaultName, extensions);
}

// writeFile lands bytes on path (0o644). data rides as a standard base64
// string (encoding/json decodes it into []byte).
export function writeFile(path, data) {
  return DialogService.WriteFile(path, data);
}

// saveExport picks a path via the native dialog, then has Go fetch urlPath
// (path + query, e.g. "/api/export/library.db") through the app's own HTTP
// routes and stream it to the file — for URL-served payloads too large to
// round-trip the bindings (library.db, full-match WAVs, raw reports).
// Resolves to "" on cancel.
export function saveExport(urlPath, defaultName, extensions) {
  return DialogService.SaveExport(urlPath, defaultName, extensions);
}

// --- KVStore prefs --------------------------------------------------------------
// Durable preference storage (AutoSave — every write is on disk immediately;
// prefs.go holds the Go-side key constants). localStorage is only the
// pre-paint cache for font_size (see fontsize.js).

export function getPref(key) { return KVStoreService.Get(key); }
export function setPref(key, value) { return KVStoreService.Set(key, value); }
