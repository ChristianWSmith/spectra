// Thin async wrappers over the generated bindings + event glue.
//
// Event subscription: @wailsio/runtime 3.0.0 exposes the event API on the
// `Events` namespace — `Events.On(name, cb)` returns an unsubscribe fn and
// the callback receives a WailsEvent `{name, data}` (the Go payload lives
// in `.data`). There is no `EventsOn`/`EventsOff` in v3.
import { Events } from '@wailsio/runtime';
import {
  AppService,
  LibraryService,
  MatchService,
  ReplayService,
  AnalyticsService,
  ProfileService,
  VoiceService,
} from '../../bindings/github.com/ChristianWSmith/spectra';

// --- AppService ---------------------------------------------------------------

export function getVersion() {
  return AppService.GetVersion();
}

export function saveWindowSize(w, h) {
  return AppService.SaveWindowSize(w, h);
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
// sessionStorage contract: one key holds a JSON filter for Timeline.
// Writers (Match scoreboard row / overview stat cells) set
// {steamId?} or {kind?} just before navigating to #/timeline/:id; Timeline
// reads + clears it on mount and applies it as its initial filter.
export const TIMELINE_PENDING_KEY = 'spectra:timeline-filter';

export function setPendingTimelineFilter(filter) {
  try {
    sessionStorage.setItem(TIMELINE_PENDING_KEY, JSON.stringify(filter));
  } catch (e) {
    console.error(e);
  }
}

export function takePendingTimelineFilter() {
  try {
    const raw = sessionStorage.getItem(TIMELINE_PENDING_KEY);
    sessionStorage.removeItem(TIMELINE_PENDING_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.error(e);
    return null;
  }
}

// Replay-seek hand-off, mirroring the Timeline filter contract above: one
// sessionStorage key holds {tick} (sometimes with extra keys — Replay uses
// tick plus optional play/voice booleans; Timeline ignores what it doesn't
// know). Writers (Match header, RoundDetail kill feed, Timeline rows) set it
// just before navigating to #/replay/:id; Replay reads + clears it on mount
// and seeks to that tick. null clears any stale value without writing one.
export const REPLAY_PENDING_KEY = 'spectra:replay-seek';

export function setPendingSeek(seek) {
  try {
    if (seek == null) sessionStorage.removeItem(REPLAY_PENDING_KEY);
    else sessionStorage.setItem(REPLAY_PENDING_KEY, JSON.stringify(seek));
  } catch (e) {
    console.error(e);
  }
}

export function takePendingSeek() {
  try {
    const raw = sessionStorage.getItem(REPLAY_PENDING_KEY);
    sessionStorage.removeItem(REPLAY_PENDING_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.error(e);
    return null;
  }
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
