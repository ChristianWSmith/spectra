// lib/replay/preload.js — the Replay view's PRE-EMPTIVE data bundle:
// tier 1 of the loading ladder (PRODUCT.md "### Defaults" — THE
// statement): warm the replay's data the moment the Match screen opens,
// so "Watch replay" usually resolves from memory instead of walking the
// ≥14-stage serial await chain in Replay's load().
//
// WHAT LIVES HERE — the UNcached heavy reads only. Reads already behind
// services.cachedRead (getMatch/getRounds/getTeamNames, voice presence/
// index, sound presence/sounds) are merely PRIMED by the preload — they
// keep their single canonical home and their flush semantics, and
// Replay awaits them as usual (a cache hit). The bundle carries the
// rest: the replay meta, the player-state stream, the radar pack +
// decoded images, the positions FETCH AND parsePositions (the CPU that
// used to sit on the click path), loadWorld (fetch + grenade hydration
// + normalize), and the conn/blind/chat rows. The load-time PREFS are
// deliberately ABSENT (see the note at the bottom): kvstore writes emit
// no flush event, so a pref changed after this preload would be served
// stale — Replay reads them fresh at load time.
//
// WHAT IT IS NOT — deliberately neither viewstate nor URL (AGENTS.md
// "State placement": loading is transient — it never restores, never
// seeds, never becomes a query param) and NOT a second read-cache: this
// memo is keyed by match id alone and holds ONE shaped object, not
// arbitrary reads. services.invalidate() does not reach it, so it
// registers its own flush listeners (mirroring cachedRead's list
// exactly — see below).
//
// MEMORY — parsed positions are ≈28–30 MB per match, so a resolved
// bundle is expensive: at most MAX_BUNDLES resolved bundles are kept
// and the LEAST recently used one is evicted on a new preload (and on
// each settle — Map order is insertion order, and every hit re-inserts
// the entry at the tail to make it most-recent). In-flight entries are
// never evicted; a rejected one holds no bundle and is not counted.
// A dropped entry keeps running to completion — its result is simply
// no longer reachable, the same semantics as a read dropped from
// readCache mid-flight.
//
// Failures are captured into the memo (the stored promise carries a
// no-op handler, so a preload nobody awaits can never surface as an
// unhandled rejection). Within ONE visit Replay awaiting the same
// promise gets the rejection, renders its own loadError — and there is
// no refetch loop, because load() runs once per mount. The moment that
// failure is SURFACED, Replay calls dropRejectedReplayPreload() so a
// LATER visit retries fresh: a transient failure must not be sticky for
// the whole session (there is no retry button). Until it is surfaced,
// the memo keeps the rejection — that window is what makes "surface it
// exactly once" possible at all.
import {
  onEvent,
  subscribeJobProgress,
  getReplayMeta,
  getMatch,
  getRounds,
  getTeamNames,
  getVoicePresence,
  getVoiceIndex,
  getSoundEventPresence,
  getSoundEvents,
  getEvents,
  getBlindDurations,
  getChat,
} from '../services.js';
import { loadState } from './state.js';
import { loadWorld } from './world.js';
import { parsePositions } from './engine.js';
import { voiceWindowTicks } from './voicewindows.js';
import { loadMapPack } from '../components/mapxform.js';
import { normTickRate } from '../fmt.js';

// --- The stage ledger --------------------------------------------------------
// Canonical order = the serial chain Replay's load() would otherwise walk.
// Execution is CONCURRENT (state ‖ pack ‖ positions ‖ events ‖ primes;
// loadWorld waits on stateIndex + data.ticks), but the indicator
// names the EARLIEST stage still running: honest by construction — a stage
// is only ever shown while its own promise is unsettled — and stable as the
// groups finish out of order. Labels are display copy (these are not job
// stages, so StatusChip has no vocabulary for them); the view renders them
// beside the ONE progress widget. The prefs are NOT a stage here: Replay
// reads them fresh at load time (they never ride this ledger).
const STAGES = [
  'meta', // getReplayMeta — gates everything (no sidecar → nothing else)
  'match', // the cachedRead primes (match/rounds/teamNames/voice/sounds)
  'state', // loadState: meta.json + stream fetch + decode + index
  'pack', // radar meta.json + image decode (determinate: i/N images)
  'positions', // positions bytes (determinate: vs Content-Length)
  'parse', // parsePositions — CPU, no honest denominator → indeterminate
  'voice', // getVoiceIndex prime (only a match WITH voice reaches it)
  'world', // loadWorld: anchor read + grenade hydration + normalize
  'events', // conn + blind (+durations) + chat rows
];
const STAGE_LABEL = {
  meta: 'reading replay metadata',
  match: 'reading match rows',
  state: 'reading player state',
  pack: 'loading radar',
  positions: 'reading positions',
  parse: 'parsing positions',
  voice: 'reading voice data',
  world: 'loading world events',
  events: 'reading chat and events',
};

// --- The memo ----------------------------------------------------------------
const memos = new Map(); // String(matchId) -> entry
// Parsed positions ≈28–30 MB/match: keep the current match's bundle plus
// one recently-used (the ceiling of "at most one, max two"), LRU-first.
const MAX_BUNDLES = 2;

function newEntry() {
  const stages = new Map(
    STAGES.map((name) => [name, { name, done: 0, total: 0, unit: '', complete: false }]),
  );
  return {
    promise: null,
    bundle: null, // the resolved bundle (eviction counts these)
    rejected: false,
    stages,
    progress: { stage: STAGE_LABEL.meta, done: 0, total: 0, unit: '' },
    sig: `${STAGE_LABEL.meta}|0||0`,
    subs: new Set(),
  };
}

function headStage(entry) {
  for (const name of STAGES) {
    const st = entry.stages.get(name);
    if (st && !st.complete) return st;
  }
  return null;
}

// publish recomputes the head of the ledger and notifies subscribers — but
// only when something a viewer can SEE changed: the stage, the denominator
// or the PERMILLE bucket. The positions stream arrives in hundreds of
// chunks and subscribers are Svelte state writes, not a firehose.
function publish(entry) {
  const st = headStage(entry);
  const p = {
    stage: st ? STAGE_LABEL[st.name] : '',
    done: st ? st.done : 0,
    total: st ? st.total : 0,
    unit: st ? st.unit : '',
  };
  const bucket = p.total > 0 ? Math.floor((p.done / p.total) * 1000) : 0;
  const sig = `${p.stage}|${p.total}|${p.unit}|${bucket}`;
  if (sig === entry.sig) return;
  entry.sig = sig;
  entry.progress = p;
  for (const cb of Array.from(entry.subs)) {
    try {
      cb(p);
    } catch {
      // a broken subscriber never breaks the load
    }
  }
}

function completeStage(entry, name) {
  const st = entry.stages.get(name);
  if (!st || st.complete) return;
  st.complete = true;
  publish(entry);
}

function updateStage(entry, name, patch) {
  const st = entry.stages.get(name);
  if (!st || st.complete) return;
  Object.assign(st, patch);
  publish(entry);
}

// evictBundles runs the LRU: Map order is insertion order (every hit
// re-inserts at the tail), so the first RESOLVED entry walked is the least
// recently used. In-flight and rejected entries hold no bundle and are
// never eviction candidates.
function evictBundles() {
  let resolved = 0;
  for (const e of memos.values()) if (e.bundle) resolved++;
  while (resolved > MAX_BUNDLES) {
    let oldest = null;
    for (const [k, e] of memos) {
      if (e.bundle) {
        oldest = k;
        break;
      }
    }
    if (!oldest) break;
    memos.delete(oldest);
    resolved--;
  }
}

// --- Invalidation ------------------------------------------------------------
// The SAME four events services.cachedRead flushes on (services.js — the
// data-change list). This memo mirrors that list EXACTLY because
// services.invalidate() clears readCache ONLY and never reaches here: a
// reprocess landing while a bundle is memoized would otherwise serve
// pre-reprocess rows forever. spectra:asset-progress stays out for the same
// reason it is out there (pure progress, no row changes). An in-flight
// preload keeps running — its bundle is simply no longer reachable.
for (const evt of [
  'spectra:library-changed',
  'spectra:job-done',
  'spectra:job-progress',
  'spectra:files-dropped',
]) {
  onEvent(evt, () => memos.clear());
}

// --- The library-job bail-out ------------------------------------------------
// Every spectra:* data event clears services' readCache, and
// spectra:job-progress fires every ~100 ms while a job runs — warming
// cached reads mid-import is systematically wasted. subscribeJobProgress
// (services.js) hands the CURRENT job snapshot to cb SYNCHRONOUSLY, so the
// first call primes the flag without waiting for an event and later
// job-progress/job-done events keep it current. The snapshot knows the
// jobs that have REPORTED progress (a just-enqueued job starts reporting
// within ~100 ms; whatever slips through that first window is dropped by
// the flush listeners above). Only the BACKGROUND start consults it —
// the correctness net does not depend on this check.
let jobsActive = false;
let jobsWatched = false;
function libraryJobsActive() {
  if (!jobsWatched) {
    jobsWatched = true;
    subscribeJobProgress((snap) => {
      jobsActive = !!(snap && snap.size);
    });
  }
  return jobsActive;
}

// preloadReplay starts (or joins) the bundle for one match.
//
//   preloadReplay(id)             — the BACKGROUND start (Match's tier-1
//                                   effect): returns the memoized promise,
//                                   or null while a library job is running
//                                   (nothing to await — callers of this
//                                   form are fire-and-forget).
//   preloadReplay(id, {force})    — the FOREGROUND start (Replay's load):
//                                   the user asked for the replay NOW, so
//                                   the job bail-out never applies; it
//                                   still never RESTARTS an in-flight or
//                                   resolved bundle ("start-if-missing,
//                                   await the same promise").
export function preloadReplay(id, opts) {
  const key = String(id);
  const hit = memos.get(key);
  if (hit) {
    // LRU touch: re-insert at the tail so eviction drops another match.
    memos.delete(key);
    memos.set(key, hit);
    return hit.promise;
  }
  if (!(opts && opts.force) && libraryJobsActive()) return null;
  const entry = newEntry();
  memos.set(key, entry);
  evictBundles();
  // The no-op handler marks the stored promise handled (never an
  // unhandled rejection, even if the user never opens the replay); the
  // .then chain below is what Replay awaits, rejection included.
  entry.promise = buildBundle(id, entry).then(
    (bundle) => {
      entry.bundle = bundle;
      evictBundles();
      return bundle;
    },
    (e) => {
      entry.rejected = true;
      throw e;
    },
  );
  entry.promise.catch(() => {});
  return entry.promise;
}

// onReplayPreloadProgress subscribes cb to the match's stage ledger
// ({stage, done, total, unit} — total 0 = indeterminate, never a
// fabricated percentage) and fires it immediately with the current
// snapshot; returns an unsubscribe ($effect cleanup). No memo for the id
// (never preloaded, already flushed) → a no-op unsubscribe: the caller's
// indicator simply has nothing to report.
export function onReplayPreloadProgress(matchId, cb) {
  const entry = memos.get(String(matchId));
  if (!entry) return () => {};
  entry.subs.add(cb);
  cb(entry.progress);
  return () => entry.subs.delete(cb);
}

// resetReplayPreload drops every memo — the test hook (the
// resetViewState()/resetIconManifest() precedent): jsdom drivers call it
// before each mount so every mount is a FRESH load against its own
// fixtures.
export function resetReplayPreload() {
  memos.clear();
}

// dropRejectedReplayPreload is Replay's "the failure was SURFACED" call:
// the view sets loadError from a bundle rejection, then drops THAT memo
// entry so a later visit retries fresh (within the visit nothing
// re-triggers load(), so the error still surfaces exactly once and there
// is no refetch loop). Guarded on entry.rejected: only a memo currently
// HOLDING a rejection can go — a healthy or in-flight entry is never
// dropped here (an unrelated startEngine failure surfacing through the
// same catch must not evict a good bundle), and dropping some other
// rejected entry would cost at most one extra refetch on the next visit,
// never stale data.
export function dropRejectedReplayPreload(id) {
  const key = String(id);
  const entry = memos.get(key);
  if (entry && entry.rejected) memos.delete(key);
}

// --- The bundle --------------------------------------------------------------

async function buildBundle(id, entry) {
  // Stage 1 — the replay meta: tiny, and it GATES everything (a match
  // imported without position data has nothing else worth loading, so the
  // bundle resolves early with just the meta and Replay renders its
  // noSidecar panel). A rejection here is a hard failure: it propagates
  // into the memo and Replay shows loadError (never re-fetched).
  const meta = await Promise.resolve(getReplayMeta(id)).finally(() => completeStage(entry, 'meta'));
  if (!meta || !meta.hasSidecar) {
    for (const name of STAGES) completeStage(entry, name);
    return { meta };
  }
  const players = meta.players || [];

  // The independent groups, started TOGETHER — the serial chain this
  // replaces walked them one after another:
  //   state ‖ pack(after the match row names the map) ‖ positions ‖
  //   events ‖ the cachedRead prime group.
  // loadWorld below is the one that waits (stateIndex + data.ticks).
  const matchMapP = getMatch(id).catch(() => null);
  const voicePresenceP = getVoicePresence(id).catch(() => null);
  const primeP = (async () => {
    await Promise.all([
      matchMapP,
      getRounds(id).catch(() => []),
      getTeamNames(id).catch(() => null),
      voicePresenceP,
      primeSounds(id),
    ]);
    completeStage(entry, 'match');
  })();
  const stateP = loadState(id)
    .catch(() => null) // absent/corrupt stream → null (Replay's fail-soft contract)
    .finally(() => completeStage(entry, 'state'));
  const packP = matchMapP.then((m) => loadPackStage((m && m.map) || '', entry));
  const positionsP = fetchAndParse(id, meta, entry);
  const eventsP = readEvents(id, entry);
  // The voice index needs BOTH the presence flag and the parsed timeline
  // (its bucket count is span/ tickRate — the args Replay re-derives, so
  // the primed cachedRead key is byte-identical). Never rejects: Replay
  // re-reads the same key with its own .catch.
  const voiceP = (async () => {
    try {
      const presence = await voicePresenceP;
      const data = await positionsP;
      if (presence && presence.hasVoice) {
        const tr = normTickRate(meta.tickRate);
        const span = data.ticks[data.frames - 1] - data.ticks[0];
        await getVoiceIndex(id, Math.max(1, Math.ceil(span / tr)), voiceWindowTicks(tr)).catch(
          () => {},
        );
      }
    } catch {
      /* fail-soft — the view's own read carries the same .catch */
    }
    completeStage(entry, 'voice');
  })();
  // THE one dependency chain: the helmet stamp's binary search and the kit
  // evidence need the state stream AND data.ticks, so loadWorld starts
  // only when both landed (everything above runs beside it).
  const worldP = (async () => {
    const [stateIndex, data] = await Promise.all([stateP, positionsP]);
    const world = await loadWorld({
      matchId: id,
      players,
      stateIndex,
      ticks: data.ticks,
      tickRate: meta.tickRate ?? 0,
    });
    completeStage(entry, 'world');
    return world;
  })();

  const [, stateIndex, packParts, data, world, ev] = await Promise.all([
    primeP,
    stateP,
    packP,
    positionsP,
    worldP,
    eventsP,
    voiceP,
  ]);

  return {
    meta,
    stateIndex,
    pack: packParts.pack,
    packTf: packParts.transform,
    radarImg: packParts.img,
    layerImgs: packParts.layerImgs,
    data,
    world,
    connRows: ev.connRows,
    blinds: ev.blinds,
    chatLines: ev.chatLines,
  };
}

// primeSounds — the sound reads Replay gates the same way (presence first,
// the full cachedRead only when the table has rows): priming both so
// Replay's own await is a cache hit, never a second DB read.
async function primeSounds(id) {
  const pres = await getSoundEventPresence(id).catch(() => null);
  const total = pres && Number.isFinite(pres.total) ? pres.total : 0;
  if (total > 0) await getSoundEvents(id, 0, 0).catch(() => []);
}

// fetchAndParse — the positions FETCH (determinate byte stage) + the
// parsePositions CPU (its own indeterminate stage: a two-pass walk over
// 84k–183k frames has no honest denominator, and we never invent one).
async function fetchAndParse(id, meta, entry) {
  const buf = await fetchPositions(id, entry);
  completeStage(entry, 'positions');
  const data = parsePositions(buf, ((meta && meta.players) || []).length || 10);
  completeStage(entry, 'parse');
  return data;
}

// fetchPositions — the ONE determinate byte denominator in the ladder:
// main.go's sidecar route sets Content-Length (handleSidecar, positions
// case), so done/total is honest. Without a length (or behind a bare
// fetch stub) the stage stays indeterminate — a percentage is never
// fabricated. The body is read as a STREAM when the runtime exposes one
// so the bar moves during the transfer; otherwise it falls back to
// arrayBuffer() with a single report at the end (old behavior).
async function fetchPositions(id, entry) {
  const res = await fetch(`/api/sidecar/${id}/positions`);
  if (!res.ok) throw new Error(`position data unavailable (HTTP ${res.status})`);
  const total =
    res.headers && typeof res.headers.get === 'function'
      ? Number(res.headers.get('content-length')) || 0
      : 0;
  if (total > 0) updateStage(entry, 'positions', { total, unit: 'bytes' });
  const report = (done) => {
    if (total > 0) updateStage(entry, 'positions', { done: Math.min(done, total) });
  };
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      got += value.byteLength;
      report(got);
    }
    const out = new Uint8Array(got);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    report(got);
    return out.buffer;
  }
  const buf = await res.arrayBuffer();
  report(buf.byteLength);
  return buf;
}

// loadPackStage — Replay's pack loader MOVED here (the ONE canonical
// implementation; the view reads the result off the bundle): the
// extracted pack (local CS2) wins over the bundled metadata-only fallback
// at /maps/ (no art ships — see frontend/public/maps/README.md; a missing
// pack = a plain grid). The makeTransform() output rides along — the
// renderer consumes it instead of re-deriving the pack's fields. The
// image set is client-known once meta.json lists the files, so the decode
// phase reports honestly as i/N; the meta.json fetch itself has no
// denominator (indeterminate). A file that fails to decode resolves to
// null — the renderer skips that panel's pixels (the grid shows
// through), never an error.
async function loadPackStage(map, entry) {
  const empty = { pack: null, transform: null, img: null, layerImgs: null };
  if (!map) {
    completeStage(entry, 'pack');
    return empty;
  }
  const p = await loadMapPack(map);
  if (!p || !p.meta) {
    completeStage(entry, 'pack');
    return empty;
  }
  const files = [];
  if (Array.isArray(p.meta.layers) && p.meta.layers.length) {
    for (const l of p.meta.layers) if (l && l.file) files.push(l.file);
  } else if (p.meta.radar && p.meta.radar.file) {
    files.push(p.meta.radar.file);
  }
  if (files.length) updateStage(entry, 'pack', { total: files.length, unit: 'images' });
  let decoded = 0;
  const imgs = await Promise.all(
    files.map(async (file) => {
      const im = new Image();
      im.src = `${p.base}/${file}`;
      let out = im;
      try {
        await im.decode();
      } catch {
        out = null;
      }
      decoded++;
      updateStage(entry, 'pack', { done: decoded });
      return out;
    }),
  );
  completeStage(entry, 'pack');
  return {
    pack: p.meta,
    transform: p.transform,
    img: imgs.length ? imgs[0] : null,
    layerImgs: imgs,
  };
}

// readEvents — the three UNcached row reads Replay's load() used to walk
// serially: the card-visibility connection rows, the flash-white blind
// rows with their narrow duration side channel, and the canvas chat.
// Same fail-soft defaults as the view had (any failure → [] → no overlay,
// no chat, every card visible — never a load error).
async function readEvents(id, entry) {
  const [connRows, blinds, chatLines] = await Promise.all([
    getEvents({
      matchId: id,
      kinds: ['player_connect', 'player_disconnect'],
      offset: 0,
      limit: 0,
    }).catch(() => []),
    (async () => {
      const [rows, durs] = await Promise.all([
        getEvents({ matchId: id, kinds: ['blind'], offset: 0, limit: 0 }).catch(() => []),
        getBlindDurations(id).catch(() => []),
      ]);
      return { rows: rows || [], durs: durs || [] };
    })(),
    getChat(id, -1, '')
      .then((c) => c || [])
      .catch(() => []),
  ]);
  completeStage(entry, 'events');
  return { connRows: connRows || [], blinds, chatLines };
}

// PREFS ARE DELIBERATELY NOT BUNDLED (the load-time reads stay in
// Replay's load()): kvstore writes emit NO flush event, so anything
// memoized here would serve a volume/knife-warmup/skip-freeze change
// made in Settings AFTER this preload — stale, with no refresh path.
// The pre-preload semantics were "read at load time" and they are
// preserved exactly: Replay starts them as ONE Promise.all alongside
// the bundle await, so they stay concurrent with it (never a serialized
// stage of the click path) while always reading the CURRENT store.
// 'prefs' is therefore gone from the ledger — the indicator must only
// ever name work this module is doing.
