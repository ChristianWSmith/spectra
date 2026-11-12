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
  IconService,
  SoundService,
  DialogService,
} from '../../bindings/github.com/ChristianWSmith/spectra';
import { KVStoreService } from '../../bindings/github.com/wailsapp/wails/v3/pkg/services/kvstore';
import { resetIconManifest } from './replay/icons.js';
import { resetSoundManifest } from './replay/sfx.js';

// --- Error text ---------------------------------------------------------------
// The one errText: normalizes a Go/binding rejection (Error, string, null)
// into the short message every view shows in its error slot. Import this
// instead of writing a local copy.

export function errText(e) {
  if (e == null) return 'unknown error';
  if (typeof e === 'string') return e;
  return e.message || String(e);
}

// --- Read-through cache (transparent) ---------------------------------------
// One canonical cache for the repeated single-match/library reads:
// getMatch, getRounds, getScoreboard, listMatches, getMatchSummary,
// getTeamNames. Views call the exported functions as usual —
// the cache lives inside them, keyed by (method, args), so per-argument
// freshness falls out of the key (Match's sort-driven GetScoreboard
// refetches pass different args -> different entries) and fetch-on-
// activate laziness is unchanged (a cache hit just resolves faster).
//
// Invalidation: EVERY spectra:* event that carries a DATA change flushes
// the whole cache (the payloads never change what we key on, so a full
// flush is the safe, simple rule):
//   spectra:library-changed - any view backed by the matches/jobs tables
//   spectra:job-done        - import/reprocess/cancel outcome
//   spectra:job-progress    - parse/store progress (data lands mid-stream)
//   spectra:files-dropped   - import kickoff (its own events may lag the
//                             call site's refetch)
// The one exception: spectra:asset-progress (Settings' CS2-asset
// extraction) is pure progress — it changes no row — so it is NOT in the
// listener list below; its only subscriber is onAssetProgress, which
// drives a progress bar.
// Mutating wrappers (deleteMatch/importPaths/reprocess/
// recomputeAnalysis) also invalidate on success: DeleteMatch and
// RecomputeAnalysis emit no event at all, and the event round-trip for
// the others can land AFTER the call site's own refetch - invalidating
// inside the wrapper closes that race without any call-site change.
// Exported for the explicit cases a view knows about before refetching.
const readCache = new Map(); // "Method:JSON(args)" -> in-flight/resolved promise
const READ_CACHE_MAX = 256; // bounded: library search spawns one entry per query

export function invalidate() {
  readCache.clear();
}

function cachedRead(method, args, fn) {
  const key = method + ':' + JSON.stringify(args);
  const hit = readCache.get(key);
  if (hit) return hit;
  let p;
  try {
    p = Promise.resolve(fn());
  } catch (e) {
    p = Promise.reject(e);
  }
  readCache.set(key, p);
  // Bounded FIFO: drop the oldest entry (Map preserves insertion order).
  if (readCache.size > READ_CACHE_MAX) readCache.delete(readCache.keys().next().value);
  // Failed reads are not cached - the next call retries. Attaching the
  // handler also marks the shared promise handled for both callers.
  p.catch(() => {
    if (readCache.get(key) === p) readCache.delete(key);
  });
  return p;
}

// The invalidation listeners register once per process (module load);
// Events.On returns an unsubscribe we intentionally keep for the app's
// lifetime - services.js is a singleton.
for (const evt of [
  'spectra:library-changed',
  'spectra:job-done',
  'spectra:job-progress',
  'spectra:files-dropped',
]) {
  Events.On(evt, () => invalidate());
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
  return LibraryService.ImportPaths(paths).then((r) => {
    invalidate();
    return r;
  });
}

// filter is the structured facet object ({map, player}) the store's
// MatchListFilter takes — ANDed with each other and with the free-text
// query server-side. The Library UI exposes ONLY the facets now (the
// free-text box was removed), so the view passes query '' — the
// parameter stays here so the binding/API keeps its shape. Normalized to
// both keys so equivalent filters share one cache entry; callers that
// only want the plain list pass nothing.
export function listMatches(query, sortKey, desc, filter) {
  const f = { map: (filter && filter.map) || '', player: (filter && filter.player) || '' };
  return cachedRead('ListMatches', [query, sortKey, desc, f], () =>
    LibraryService.ListMatches(query, sortKey, desc, f),
  );
}

// listMatchesPage is the Library list's keyset window ("Load more"): the
// same query/sortKey/desc/filter contract as listMatches, but ONE window
// of `limit` rows strictly after `afterID` (0 = the first window),
// returned as {rows, hasNext, rosters}. `rosters` carries the per-match
// human players the Matchup column synthesizes `team_<player>` names from
// (rows whose extract recorded no clan name), so a list load is ONE IPC
// call — the pre-pagination view fetched a scoreboard PER such row. The
// whole window is one read-cache entry (no per-row keys), flushed with
// the rest on every spectra:* data event; listMatches stays unbounded
// for its whole-library readers (import dedupe, MatchPicker, Settings).
export function listMatchesPage(query, sortKey, desc, afterID, limit, filter) {
  const f = { map: (filter && filter.map) || '', player: (filter && filter.player) || '' };
  return cachedRead('ListMatchesPage', [query, sortKey, desc, afterID, limit, f], () =>
    LibraryService.ListMatchesPage(query, sortKey, desc, afterID, limit, f),
  );
}

// listMapNames returns the distinct map names present in the library
// (A→Z, blanks omitted) — the suggestion source for the Library's map
// facet (store.ListMapNames). Read-cached like listMatches: a fresh
// import flushes the cache through the spectra:* listeners above.
export function listMapNames() {
  return cachedRead('ListMapNames', [], () => LibraryService.ListMapNames());
}

// deleteMatch removes a match's extracted data; deleteDemo also removes
// Spectra's OWN copy of the demo file (a user's original is never deleted).
// Resolves to whether a demo file was actually removed from disk.
export function deleteMatch(id, deleteDemo) {
  return LibraryService.DeleteMatch(id, deleteDemo).then((r) => {
    invalidate();
    return r;
  });
}

// evictDemoCopy frees Spectra's own copy of a match's demo — the Library
// row's "Free copy" / the Match view's copy line — and resolves to the
// bytes reclaimed (0 when there was no copy: evicting twice is not an
// error). The match, its sidecars and the stored source file are never
// touched, so nothing about the saved data changes; the row's copyState
// re-derives from the filesystem on the next list load.
export function evictDemoCopy(id) {
  return LibraryService.EvictDemoCopy(id).then((r) => {
    invalidate();
    return r;
  });
}

export function reprocess(id) {
  return LibraryService.Reprocess(id).then((r) => {
    invalidate();
    return r;
  });
}

// cancelJob cancels a queued or running job — the Library row action
// (Cancel on a running parse, Remove on a queued one; Go decides which
// via store.CancelJob + the worker's skip). It emits spectra:job-done /
// spectra:library-changed itself, so a refetch follows either way; the
// wrapper invalidates like the other mutators to close the same race.
export function cancelJob(id) {
  return LibraryService.CancelJob(id).then((r) => {
    invalidate();
    return r;
  });
}

export function listJobs() {
  return LibraryService.ListJobs();
}

// --- Import dirs (Settings → "Import dirs") --------------------------------
// The Library lists .dem/.dem.zst files under these import dirs with a
// one-click Import. Deliberately NOT read-cached: an import-dir edit in
// Settings must show up on the next scan (the expensive part — hashing
// demo files — is cached Go-side by path+size+mtime, so a repeat scan
// costs a walk of stats).

export function getDemoDirs() {
  return LibraryService.GetDemoDirs();
}

export function setDemoDirs(dirs) {
  return LibraryService.SetDemoDirs(dirs);
}

export function resetDemoDirs() {
  return LibraryService.ResetDemoDirs();
}

// chooseDemoDir opens the native folder picker; resolves to "" on cancel.
export function chooseDemoDir() {
  return LibraryService.ChooseDemoDir();
}

// getDemoCopyOnImport is the "copy demos into Spectra's data folder on
// import" toggle (Settings → Import dirs). Unset/corrupt reads as ON —
// copying is the default. Go decides per job (library.Options.CopyEnabled),
// so the setting applies to queued jobs too.
export function getDemoCopyOnImport() {
  return LibraryService.GetDemoCopyOnImport();
}

export function setDemoCopyOnImport(copy) {
  return LibraryService.SetDemoCopyOnImport(copy);
}

// listDemoFiles scans the configured import dirs; rows are demos NOT
// already in the library (recognised imports are omitted, newest first),
// so deleting the match brings its file back on the next scan.
export function listDemoFiles() {
  return LibraryService.ListDemoFiles();
}

// deleteDemoFile removes a demo file from disk — the import-dir row's
// "Delete from disk" action, always behind a confirmation dialog. The
// backend refuses anything that is not a .dem/.dem.zst file under a
// configured import dir (never the app's data dir, never a match's stored
// path), so this cannot delete an arbitrary path.
export function deleteDemoFile(path) {
  return LibraryService.DeleteDemoFile(path);
}

export function getWarnings(id) {
  return LibraryService.GetWarnings(id);
}

// round < 0 = all rounds, offset pages in rowid order (limit + 1 detects
// "more rows" without silent truncation). Rows come back with Who/Label
// pre-parsed by the one Go labeler (eventlabels.go).
export function getGenericEvents(id, name, round, limit, offset) {
  return LibraryService.GetGenericEvents(id, name, round, limit, offset || 0);
}

export function getDataInfo() {
  return LibraryService.GetDataInfo();
}

// freeAllDemoCopies sweeps Spectra's managed copy dir (Settings → Data's
// "Free all demo copies") and resolves to the bytes reclaimed. Callers
// gate on pending jobs first — an import mid-copy would land its file
// after the sweep — and confirm before calling; matches, sidecars and
// your original files are never in scope.
export function freeAllDemoCopies() {
  return LibraryService.FreeAllDemoCopies().then((r) => {
    invalidate();
    return r;
  });
}

// --- MatchService -------------------------------------------------------------

export function getMatch(id) {
  return cachedRead('GetMatch', [id], () => MatchService.GetMatch(id));
}

export function getScoreboard(id, sortKey, desc) {
  return cachedRead('GetScoreboard', [id, sortKey, desc], () =>
    MatchService.GetScoreboard(id, sortKey, desc),
  );
}

export function getRounds(id) {
  return cachedRead('GetRounds', [id], () => MatchService.GetRounds(id));
}

// getMatchSummary returns ONE match's summary row — the same JSON shape
// as one element of ListMatches (models.MatchSummary) — so a view that
// only needs one match's header/team names never pulls the whole
// library list.
export function getMatchSummary(id) {
  return cachedRead('GetMatchSummary', [id], () => MatchService.GetMatchSummary(id));
}

// getTeamNames returns {ct, t} for one match — the demo's clan names
// when recorded, else the synthesized team_<player> fallbacks (Go side;
// the JS twin is lib/teams.js).
export function getTeamNames(id) {
  return cachedRead('GetTeamNames', [id], () => MatchService.GetTeamNames(id));
}

export function getRoundDetail(id, round) {
  return MatchService.GetRoundDetail(id, round);
}

// The round bounds (roundFrom/roundTo) are an inclusive, PARTIAL range
// over the round number: 0/absent = open on that side (both unset = all
// rounds; round 0 never exists, so 0 can only mean "unset"); kind/
// steamId "" = all; kinds (optional) is the multi-kind IN form the
// landmark feed's categories use; limit 0 = up to the store's 50k hard
// cap. The distance bounds (distanceMin/distanceMax) follow the same
// partial-range rule.
export function getEvents(filter) {
  return MatchService.GetEvents(filter);
}

export function getEvent(id) {
  return MatchService.GetEvent(id);
}

// getEventKeys returns the id/tick/kind of EVERY event matching the SAME
// filter as getEvents — the replay's scrubber-marker answer (the store
// shares one clause builder between the two reads, and this read is
// UNPAGED: the marker set is the whole answer, never a page of it).
// Read-cached on the whole filter object — marker answers re-query per
// filter change, and every spectra:* data event flushes the cache like
// the rest of the reads here.
export function getEventKeys(filter) {
  return cachedRead('GetEventKeys', [filter], () => MatchService.GetEventKeys(filter));
}

// getBlindDurations returns [{seq, ms}] — the extractor's flash length
// per blind event (the payload-side channel: models.EventRow stays
// payload-free, so the duration needs this narrow read — the same rule
// as store.GetBlindFlashDetails). The replay's flash-white overlay
// joins it with the blind rows by seq; an empty array just means no
// overlay.
export function getBlindDurations(matchId) {
  return MatchService.GetBlindDurations(matchId);
}

// getDropDetails returns [{seq, cat, mag, reserve}] — the death-drop
// payload side channel (the SAME rule as getBlindDurations: models.
// EventRow stays payload-free): the stored gun|util classification
// (extract stamps it from models.IsUtilityWeapon — this module and the
// renderer NEVER re-derive the util rule) plus the dropped gun's
// mag/reserve at death. The replay's drop layer joins it onto the
// DRAW_KINDS rows by seq; an empty array (or a failed read) just means
// no drop markers are drawn.
export function getDropDetails(matchId) {
  return MatchService.GetDropDetails(matchId);
}

// round -1 = all rounds; player "" = all senders (exact steam_id match).
export function getChat(matchId, round, player) {
  return MatchService.GetChat(matchId, round, player || '');
}

// getSoundEvents returns the match's player sounds (footsteps/lands/jumps/
// fall damage — sound_events) in an INCLUSIVE tick window; either bound
// <= 0 is open on that side, so (0, 0) reads the whole match. Read-cached
// like the other single-match reads (flushed with the rest on every
// spectra:* data event); kind/steam filtering happens in the caller over
// the returned window. TWO callers share this one read: the sfx engine's
// footstep cue rows (Replay, (0, 0)) and the feed's `footsteps` source
// (feed.js — the SAME (0, 0) key, so a match with footsteps does one DB
// read for both).
export function getSoundEvents(matchId, fromTick, toTick) {
  return cachedRead('GetSoundEvents', [matchId, fromTick, toTick], () =>
    MatchService.GetSoundEvents(matchId, fromTick, toTick),
  );
}

// getSoundEventPresence returns {matchId, total, byKind} — the "does this
// match have footstep data" signal (total 0 = none; byKind omits kinds
// with no rows). Also read-cached: a reprocess replaces the rows and the
// spectra:* flush makes the next read fresh.
export function getSoundEventPresence(matchId) {
  return cachedRead('GetSoundEventPresence', [matchId], () =>
    MatchService.GetSoundEventPresence(matchId),
  );
}

// --- ReplayService ------------------------------------------------------------
// Bulk position bytes do NOT ride the bindings (base64-inflated); the Replay
// view fetches them from HTTP /api/sidecar/<matchId>/positions directly.

export function getReplayMeta(id) {
  return ReplayService.GetReplayMeta(id);
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

// onAssetProgress: per-item progress of the CS2 asset extractors —
// {family, stage, done, total} (family: 'map-packs' | 'icons' | 'sounds';
// all three are emitted from Go through the one shared emitter in
// mappackservice.go, gated per step by lib/assets.js assetFamilyForStep).
// Progress only: it flushes nothing, so it stays out of the read-cache
// invalidation list at the top of this file.
export function onAssetProgress(callback) {
  return onEvent('spectra:asset-progress', callback);
}

// --- Cross-view navigation ---------------------------------------------------
// Durable event-navigation context (filters, scope, selected landmark,
// initial tick) rides the ROUTE QUERY — see lib/router.js and
// lib/replay/landmarks.js parseLandmarkFilter/serializeLandmarkFilter.
// Every writer navigates with query params, so deep links, refresh and
// back/forward all preserve context by construction.

// --- AnalyticsService (M3) ---------------------------------------------------

export function getAnalysisConfig() { return AnalyticsService.GetConfig(); }
export function setAnalysisConfig(cfg) { return AnalyticsService.SetConfig(cfg); }
// Recompute rebuilds a match's derived rows and emits no event — flush
// the read cache so the next read (and the call site's refetch) is fresh.
export function recomputeAnalysis(matchId) {
  return AnalyticsService.RecomputeAnalysis(matchId).then((r) => {
    invalidate();
    return r;
  });
}
// The per-match ANALYTICS family is read-cached like every other repeated
// read (Match warms all six from its mount effect — services' KAST column
// and round chips then share ONE entry with the Combat/Utility/Economy
// tabs, and Match/RoundDetail/CompareRounds collapse onto one
// getRoundClasses entry; flush comes free from the listeners above).
// getPlayerRounds/getHeatmap stay uncached: per-player/per-filter reads
// with no repeated mount site.
export function getEconomy(matchId) {
  return cachedRead('GetEconomy', [matchId], () => AnalyticsService.GetEconomy(matchId));
}
export function getRoundClasses(matchId) {
  return cachedRead('GetRoundClasses', [matchId], () => AnalyticsService.GetRoundClasses(matchId));
}
export function getPlayerRounds(matchId, steamId) { return AnalyticsService.GetPlayerRounds(matchId, steamId || ''); }
export function getClutches(matchId) {
  return cachedRead('GetClutches', [matchId], () => AnalyticsService.GetClutches(matchId));
}
export function getEngagements(matchId, kind) {
  const k = kind || '';
  return cachedRead('GetEngagements', [matchId, k], () => AnalyticsService.GetEngagements(matchId, k));
}
export function getUtility(matchId) {
  return cachedRead('GetUtility', [matchId], () => AnalyticsService.GetUtility(matchId));
}
export function getCombatStats(matchId) {
  return cachedRead('GetCombatStats', [matchId], () => AnalyticsService.GetCombatStats(matchId));
}
export function getHeatmap(matchId, kind, filter) { return AnalyticsService.GetHeatmap(matchId, kind, filter || {}); }
export function listSavedFilters() { return AnalyticsService.ListSavedFilters(); }
export function saveFilter(name, scope, filterJson) { return AnalyticsService.SaveFilter(name, scope, filterJson); }
export function deleteSavedFilter(id) { return AnalyticsService.DeleteSavedFilter(id); }

// --- VoiceService (M4) -------------------------------------------------------
// Bulk PCM/WAV audio does NOT ride the bindings — it is fetched from the
// HTTP routes /api/sidecar/<id>/voice/pcm|wav (see replay/audio.js).
// The index reads are cachedRead like the sound-event reads: every
// spectra:* data event (import/reprocess) flushes them, so a reprocessed
// match never serves a stale listing or window map.

export function getVoicePresence(id) {
  return cachedRead('GetVoicePresence', [id], () => VoiceService.GetVoicePresence(id));
}

export function getVoicePlayers(id) {
  return cachedRead('GetVoicePlayers', [id], () => VoiceService.GetVoicePlayers(id));
}

export function getVoiceLanes(id, buckets) {
  const b = buckets || 180;
  return cachedRead('GetVoiceLanes', [id, b], () => VoiceService.GetVoiceLanes(id, b));
}

// getVoiceIndex is the ONE match-load voice read: players + lane buckets +
// the engine's server-exact sparse-window map from a single index pass
// (buckets ≤ 0 → the Go default; windowTicks is the caller's window width
// — voiceWindowTicks, the engine's own).
export function getVoiceIndex(id, buckets, windowTicks) {
  return cachedRead('GetVoiceIndex', [id, buckets, windowTicks], () =>
    VoiceService.GetVoiceIndex(id, buckets, windowTicks),
  );
}

// voiceWavURL is the per-player full-track download link (anchor `download`).
export function voiceWavURL(matchId, steamId) {
  return `/api/sidecar/${matchId}/voice/wav?steamId=${encodeURIComponent(steamId)}`;
}

// --- ProfileService (M3) -----------------------------------------------------

// Profile reads are read-cached too (item: profile cache): getProfile is
// the hover-warmed cheap read below, getCareerTrend's (steamId, metric)
// args become part of the key automatically — it stays CLICK-driven (only
// getProfile is prefetched on hover). listPlayers is the library-wide
// career list — per-query entries (CommandPalette's typed queries), same
// bounded-FIFO handling as the library-search entries above.
export function getProfile(steamId) {
  return cachedRead('GetProfile', [steamId], () => ProfileService.GetProfile(steamId));
}
export function listPlayers(query) {
  const q = query || '';
  return cachedRead('ListPlayers', [q], () => ProfileService.ListPlayers(q));
}
export function getCareerTrend(steamId, metric) {
  return cachedRead('GetCareerTrend', [steamId, metric], () =>
    ProfileService.GetCareerTrend(steamId, metric),
  );
}

// warmProfile — ProfileLink's HOVER prefetch: fire-and-forget getProfile
// so the click finds the entry warm (tier 1 of the loading ladder). The
// warm itself is THROTTLED per steamId — a re-hover inside the window is
// a no-op, so pointer jitter / enter-leave cycling never refires it;
// past the window it warms again, which is exactly when a spectra:*
// flush may have dropped the entry. Warming is KBs and auto-flushes, so
// a wasted warm is cheap — deliberately NO job bail-out here (unlike
// Match's analytics warm). Failures are swallowed: the click path reads
// through getProfile and reports its own error. nowMs is injectable for
// the test.
const WARM_PROFILE_TTL_MS = 30_000;
const WARM_PROFILE_MAX = 256; // bounded FIFO like readCache (hovered ids)
const profileWarmedAt = new Map(); // steamId -> last warm (ms)
export function warmProfile(steamId, nowMs) {
  if (!steamId) return;
  const now = nowMs == null ? Date.now() : nowMs;
  const last = profileWarmedAt.get(steamId);
  if (last != null && now - last < WARM_PROFILE_TTL_MS) return;
  profileWarmedAt.set(steamId, now);
  if (profileWarmedAt.size > WARM_PROFILE_MAX)
    profileWarmedAt.delete(profileWarmedAt.keys().next().value);
  getProfile(steamId).catch(() => {});
}

// The landmark feed's filter state lives in the route query
// (lib/replay/landmarks.js parseLandmarkFilter — {cats, roundFrom,
// roundTo, steamId, side, team, weapon, distMin, distMax, headshotOnly,
// bbox}). Heatmap click →
// nav(buildHash('/replay/'+id, serializeLandmarkFilter({bbox}))).

// --- MetricsService (M5) -----------------------------------------------------

// listMetrics is the library-wide metric-definition list (Builder's
// dropdowns, Match's pinned columns, Reports, CommandPalette) — refetched
// on every mount/tab switch before this; one read-cached entry now, like
// listMapNames.
export function listMetrics() {
  return cachedRead('ListMetrics', [], () => MetricsService.ListMetrics());
}
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
export function getEntitySummary(matchId) { return PlatformService.GetEntitySummary(matchId); }
export function listPlugins() { return PlatformService.ListPlugins(); }
export function installPlugin(path) { return PlatformService.InstallPlugin(path); }
export function setPluginEnabled(id, enabled) { return PlatformService.SetPluginEnabled(id, enabled); }
export function removePlugin(id) { return PlatformService.RemovePlugin(id); }
export function listReportTemplates() { return PlatformService.ListReportTemplates(); }
export function renderReport(templateId, matchId, steamId, round) {
  return PlatformService.RenderReport(templateId, matchId || 0, steamId || '', round || 0);
}

// --- MapPackService -----------------------------------------------------------
// Radar extraction from the user's local CS2 install (Valve IP stays
// local — see internal/mappack). Packs load through loadMapPack().

export function getMapPackStatus() { return MapPackService.GetMapPackStatus(); }
export function extractMapPacks(cs2Dir) { return MapPackService.ExtractMapPacks(cs2Dir || ''); }
// setCS2Dir validates + persists a manually chosen CS2 folder — the
// second half of chooseCS2Dir, used by both "Choose folder…" buttons.
// (The old setMapPackPromptState(state, path) is gone with the retired
// prompt-state pref: the launch prompt is presence-driven.)
export function setCS2Dir(path) {
  return MapPackService.SetCS2Dir(path || '');
}
export function chooseCS2Dir() { return MapPackService.ChooseCS2Dir(); }

// --- IconService ---------------------------------------------------------------
// Equipment-icon extraction from the same local CS2 install (weapons,
// utility, armor, bomb → SVG silhouettes in the app data dir, served at
// /api/icons/…). Lookups go through lib/replay/icons.js (loadIconManifest
// + iconURL); the manifest routes those reads, so a successful extraction
// resets the frontend's session memo — like the mutating wrappers above,
// invalidating inside the wrapper closes the refetch race.
// NOTE: bindings must be regenerated for IconService to exist (build step).

export function getIconManifest() { return IconService.GetIconManifest(); }
export function extractIcons(cs2Dir) {
  return IconService.ExtractIcons(cs2Dir || '').then((r) => {
    resetIconManifest();
    return r;
  });
}

// --- SoundService ------------------------------------------------------------
// Weapon/utility sound extraction from the same local CS2 install (fire +
// detonation samples → .wav/.mp3 in the app data dir, served at
// /api/sounds/…). Lookups go through lib/replay/sfx.js
// (loadSoundManifest); a successful extraction resets the frontend's
// session memo inside the wrapper — like the mutating wrappers above,
// invalidating inside the wrapper closes the refetch race.
// NOTE: bindings must be regenerated for SoundService to exist (build step).

export function getSoundManifest() { return SoundService.GetSoundManifest(); }
export function extractSounds(cs2Dir) {
  return SoundService.ExtractSounds(cs2Dir || '').then((r) => {
    resetSoundManifest();
    return r;
  });
}

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
// round-trip the bindings (Replay's full-match WAVs; the /api/export
// routes also cover the library DB and rendered reports). Resolves to ""
// on cancel.
export function saveExport(urlPath, defaultName, extensions) {
  return DialogService.SaveExport(urlPath, defaultName, extensions);
}

// --- KVStore prefs --------------------------------------------------------------
// Durable preference storage (AutoSave — every write is on disk immediately;
// prefs.go holds the Go-side key constants). localStorage is only the
// pre-paint cache for font_size (see fontsize.js).

export function getPref(key) { return KVStoreService.Get(key); }
export function setPref(key, value) { return KVStoreService.Set(key, value); }
