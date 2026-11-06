<script>
  // Replay — the tactical replay AND the app's ONE canonical raw-event
  // browser per match: event discovery, filtering, inspection and
  // navigation all happen here, in the side
  // panel's landmark feed. The feed composes the backend's three
  // source-specific reads (typed events / chat / generic events) through
  // lib/replay/landmarks.js — there is no separate event query, no
  // second categorization, and no competing event browser.
  //
  // State model: the durable event-navigation context (category set,
  // round/player/weapon/tick/dmg/bbox scope, generic name, initial tick,
  // selected landmark, origin path) lives in the ROUTE QUERY
  // (#/replay/:id?cat=…&round=…&back=…) — deep links, refresh and
  // back/forward preserve it by construction. Playback state (engine
  // tick, selection after entry) is local.
  import { onMount, tick as svelteTick } from 'svelte';
  import {
    getReplayMeta,
    getEvents,
    getEvent,
    getBlindDurations,
    getChat,
    getGenericEvents,
    getGenericHistogram,
    getMatch,
    getRounds,
    getTeamNames,
    getVoicePresence,
    getVoicePlayers,
    getVoiceLanes,
    extractIcons,
    listSavedFilters,
    saveFilter,
    deleteSavedFilter,
    getPref,
    setPref,
    errText,
  } from '../services.js';
  import { createEngine, parsePositions, SPEEDS } from '../replay/engine.js';
  import { createRenderer, sideFromFlags, hudTeamNames } from '../replay/renderer.js';
  import {
    CATEGORIES,
    DRAW_KINDS,
    categoryById,
    typedKindsFor,
    enabledSources,
    normalizeEvent,
    normalizeChat,
    normalizeGeneric,
    mergeFeed,
    roundsByNumber,
    parseLandmarkFilter,
    serializeLandmarkFilter,
    defaultFilter,
    applyRoundPref,
    landmarkExportRows,
    scrubberMarkerClass,
  } from '../replay/landmarks.js';
  import { attachReplayInput, snapshot } from '../replay/input.js';
  import { createVoiceEngine, fetchVoicePCM } from '../replay/audio.js';
  import {
    fetchStateMeta,
    loadState,
    slotStateAt,
    stateCapable,
  } from '../replay/state.js';
  import { loadIconManifest, preloadIcons } from '../replay/icons.js';
  import {
    buildSpeakingIndex,
    speakingAt,
  } from '../replay/voiceindex.js';
  // Player colors (the card ring + the renderer's dot rim) are the raw
  // m_iCompTeammateColor the sidecar carries, mapped once here; the live
  // K/D/A + ADR fold feeds the cards' stats row.
  import { colorHexOf, colorSlotsOf } from '../replay/playercolor.js';
  import { liveStats } from '../replay/livestats.js';
  import { loadMapPack } from '../components/mapxform.js';
  import { downloadBlob, downloadText } from '../download.js';
  import { toCSV } from '../csv.js';
  import { chatClock, prettyJson, fmtClock, tickSeconds, normTickRate } from '../fmt.js';
  import { isCounted, roundStartTick, roundIndexLabel, scoreThrough } from '../rounds.js';
  import { isSteam, entrySeekTick } from '../nav.js';
  import { buildHash } from '../router.js';
  import FilterBar from '../components/FilterBar.svelte';
  import LandmarkRow from '../components/LandmarkRow.svelte';
  import EventFlags from '../components/EventFlags.svelte';
  import ProfileLink from '../components/ProfileLink.svelte';
  import PayloadTree from '../components/PayloadTree.svelte';
  import Popover from '../components/Popover.svelte';
  import RoundStrip from '../components/RoundStrip.svelte';
  import TeamColumn from '../components/TeamColumn.svelte';

  let { id = 0, query = {}, nav = () => {} } = $props();

  let meta = $state(null);
  let matchMap = $state('');
  // Round ribbon inputs (spec 13): the match's team names (final sides —
  // RoundStrip colors them by first-half side) and the halftime switch
  // count, both read once in load() alongside the rounds rows.
  let teamNames = $state(null);
  let sideSwitches = $state(0);
  let pack = $state(null); // map pack meta.json or null
  let packTf = null; // makeTransform(meta) from loadMapPack — passed to
  //                    the renderer instead of re-deriving pack fields
  let data = $state(null); // parsed position store
  let rounds = $state([]);
  let loading = $state(true);
  let loadError = $state('');
  let noSidecar = $state(false);

  // The landmark rail's visibility chain is the SAME as the stage's
  // ({#if loadError} → loading → noSidecar → data), so the collapsed
  // toggle (first line of the main column's top bar) appears exactly
  // when the canvas does; the EXPANDED panel stands beside the main
  // column, full height.
  const railVisible = $derived(!loadError && !loading && !noSidecar && !!data);

  // M4 voice: presence gates the voice controls; the engine mirrors live
  // in ui* state via its onStateChange callback. KEPT IN PLACE FOR THE
  // PLAYER-CARD PHASE (the next one mounts per-player mute chips on the
  // cards): voicePresence / voicePlayers (loaded in load()), voiceEngine
  // (built in startEngine), uiVoiceOn, uiVoiceErr + uiVoicePending (the
  // "click anywhere to start voice" gesture hint), the per-player mute
  // map uiVoiceMute + toggleVoiceMute, and uiVoiceMutedAll (the mute-all
  // button below the scrubber). What is GONE with spec 10 (voice lanes +
  // the old voice bar): lanesOpen/laneSeek, uiVoiceCtx, the volume
  // slider, solo, and the WAV export link.
  let voicePresence = $state(null);
  let voicePlayers = $state([]);
  let voiceEngine = null;
  let uiVoiceOn = $state(false);
  let uiVoiceErr = $state('');
  let uiVoicePending = $state(false); // engine parked its one-shot gesture listener
  let uiVoiceMutedAll = $state(false);
  const uiVoiceMute = $state({}); // steamId → bool (per-player mute — card phase)
  const VOICE_MASTER_VOL = 0.8; // the old volume slider's position (no UI now)

  // --- Player-card phase (spec 19–22, 26) -----------------------------------
  // State stream (handoff B): null until load() proves capability. A
  // sidecar that HAS a stateFormatVersion but not the current one (v1,
  // pre-money/helmet) yields stateNote — ONE honest .note-amber telling
  // the user a reprocess gains the card fields; a match that never had
  // the stream (no version key) stays silent and the cards just render
  // their "no state" placeholders.
  let stateIndex = $state(null);
  let stateNote = $state('');
  // Icons (handoff C): the manifest URL map the cards render <img> from
  // directly, plus the preloaded images (cards' `icons` Map and the
  // renderer's setIcons object). iconNote only when extraction failed —
  // cards then fall back to text labels automatically.
  let iconUrls = $state(null);
  let iconMap = $state(null);
  let iconNote = $state('');
  // The renderer wants { name: image } (iconFor does property lookups);
  // the preload gives a Map — one conversion at the push site, derived so
  // a late extraction re-pushes through the same expression.
  const iconObj = $derived(iconMap ? Object.fromEntries(iconMap) : null);
  // Voice metadata (handoff D): colors are a pure map over roster +
  // voice players; the speaking index arrives from getVoiceLanes (~1
  // bucket per second) and fails soft to null (no rings, no crash).
  let speakIdx = $state(null);
  // Per-column voice mute (spec 22) — view-owned like uiVoiceMute: it
  // survives engine rebuilds and is re-applied in startEngine.
  const teamMuted = $state({ left: false, right: false });

  // Transport-bar mirror of the engine state (updated via onChange).
  let uiFrame = $state(0);
  let uiTick = $state(0);
  let uiPlaying = $state(false);
  let uiSpeed = $state(1);
  let uiFollow = $state(null);
  let uiLoopFrom = $state(-1);
  let uiLoopTo = $state(-1);
  let uiLoopOn = $state(false);
  let eventsOpen = $state(false); // a fresh replay opens with the feed collapsed
  // ONE toggle governs every filter surface in the panel (the Filters
  // button): the category chips, the game-events name picker, the
  // FilterBar scope, the saved-preset controls and Reset all show/hide
  // TOGETHER — none of it is piled in the open. Export is not a filter
  // and stays in the toolbar row above the panel.
  let filtersOpen = $state(false);
  let exportEl = $state(null); // the export <details> — menu close target
  // Loop popover (spec 12): the from/to inputs + the loop toggle live in
  // one Popover anchored to the loop-codicon button.
  let loopOpen = $state(false);
  let loopAnchor = $state(null);

  let stageEl = $state(null);
  let canvasEl = $state(null);
  let ready = $state(false); // engine+renderer live (template gate)
  let live = true; // false after unmount — drops late async results
  let engine = null;
  let renderer = null;
  let input = null;
  let ro = null;
  let offChange = null;
  let radarImg = null;

  const frames = $derived(data ? data.frames : (meta?.frames || 0));

  // Scrubber timer (spec 15): OVERALL GAME TIME — elapsed / total,
  // computed from the position stream (data.ticks[0] →
  // data.ticks[frames-1]) at the match tick rate and rendered m:ss /
  // m:ss by the canonical fmt.js fmtClock. The frame/tick detail rides
  // the readout's title tooltip only.
  const scrubTime = $derived.by(() => {
    if (!data || !data.frames || !data.ticks) return '—';
    const tr = normTickRate(meta?.tickRate);
    const t0 = data.ticks[0];
    const t1 = data.ticks[data.frames - 1];
    const cur = data.ticks[Math.min(Math.max(0, uiFrame), data.frames - 1)];
    return `${fmtClock(tickSeconds(cur - t0, tr))} / ${fmtClock(tickSeconds(t1 - t0, tr))}`;
  });

  const packNote = $derived.by(() => {
    if (!matchMap) return 'map name unknown — world-coordinate grid';
    if (!pack) return `map pack missing for ${matchMap} — world-coordinate grid`;
    if (!pack.radar) return `map pack for ${matchMap} has no radar image — grid only`;
    return '';
  });

  // --- Landmark feed ---------------------------------------------------------
  // The route query IS the filter state (single source of truth — the
  // controls navigate, they never keep a second copy).
  const filter = $derived(parseLandmarkFilter(query));
  const filterKey = $derived(JSON.stringify(serializeLandmarkFilter(filter)));
  const backPath = $derived(query.back || '');

  const PAGE = 500; // per-source page size; PAGE+1 probes "there is more"

  let drawRows = $state([]); // drawable-kind anchors, fetched once per match
  // Flash-white overlay rows {slot, tick, ms} — the blind events joined
  // with their narrow flash-duration read in load() (plain let: only
  // startEngine reads it, no rendering depends on it). Empty = no
  // overlay; any fetch failure lands here as [].
  let blindRows = [];
  let typedRows = $state([]); // accumulated raw EventRows (paged)
  let chatRows = $state([]);
  let genPages = $state({}); // generic name → {rows, hasMore, cat}
  let typedHasMore = $state(false);
  let feedLoading = $state(false);
  let feedSettled = $state(false);
  let feedError = $state('');
  let hist = $state([]); // generic-event histogram (game_events scoping)
  let gen = 0; // feed generation — drops stale async results

  let feedF = null; // the filter the loaded feed belongs to (load-more)

  const rbn = $derived(roundsByNumber(rounds));

  // Knife/warmup visibility pref (key: show_knife_warmup_rounds,
  // prefs.go) — read the way Match.svelte reads it (kvstore, default OFF
  // = hide). Applied as an ADDITIONAL feed filter (applyRoundPref in
  // lib/replay/landmarks.js) on top of the category opt-in rules and
  // the ?round= scoping — it never overrides them; Settings writes the
  // key directly and there is no cross-view change event, so the view
  // re-reads it on mount (returning to Replay remounts it).
  let showKnifeWarmup = $state(false);

  $effect(() => {
    let live = true;
    getPref('show_knife_warmup_rounds')
      .then((v) => {
        // kvstore round-trips JSON — Settings writes a real boolean;
        // anything else (unset, null, corrupt) reads as hidden.
        if (live) showKnifeWarmup = v === true;
      })
      .catch(() => {
        if (live) showKnifeWarmup = false; // unreadable store → hidden
      });
    return () => (live = false);
  });

  // The pref can empty an EXPLICITLY round-scoped feed (a deep link to
  // ?round=-2 while the pref hides knife/warmup rounds matches nothing)
  // — the empty state says so instead of the generic "no events" line.
  const prefHidesScope = $derived.by(() => {
    if (showKnifeWarmup || filter.round === -1) return false;
    const r = rbn.get(filter.round);
    return !!r && !isCounted(r);
  });

  // Fetch effect: re-runs only when the SERIALIZED filter changes (the
  // query object identity changes on every route write — the string key
  // keeps unrelated query churn, e.g. sel dropping, from refetching).
  $effect(() => {
    const key = filterKey;
    const f = parseLandmarkFilter(JSON.parse(key));
    const my = ++gen;
    feedF = f;
    typedRows = [];
    chatRows = [];
    genPages = {};
    typedHasMore = false;
    feedError = '';
    feedSettled = false;
    const src = enabledSources(f.cats);
    const jobs = [];
    const fail = (e) => {
      if (my === gen) feedError = errText(e);
    };
    if (src.event) {
      jobs.push(fetchTyped(f, 0, my, false));
    }
    if (src.chat) {
      jobs.push(
        getChat(id, f.round, f.steamId)
          .then((rows) => {
            if (my === gen) chatRows = rows || [];
          })
          .catch(fail),
      );
    }
    // One fetch per distinct generic name (convars + game_events with the
    // same name dedupe to a single source read).
    const names = new Map();
    for (const g of src.generic) {
      const name = g.nameFrom ? f.gname : g.name;
      if (name && !names.has(name)) names.set(name, g.id);
    }
    for (const [name, catId] of names) jobs.push(fetchGeneric(f, name, catId, 0, my, false));
    feedLoading = jobs.length > 0;
    Promise.allSettled(jobs).then(() => {
      if (my === gen) {
        feedLoading = false;
        feedSettled = true;
      }
    });
  });

  function fetchTyped(f, offset, my, append) {
    return getEvents({
      matchId: id,
      kinds: typedKindsFor(f.cats),
      round: f.round,
      steamId: f.steamId,
      weapon: f.weapon,
      tickFrom: f.tickFrom,
      tickTo: f.tickTo,
      dmgMin: f.dmgMin,
      dmgMax: f.dmgMax,
      distanceMax: f.distanceMax,
      headshotOnly: f.headshotOnly,
      bbox: f.bbox || undefined,
      offset,
      limit: PAGE + 1, // probe row → "load more" without silent truncation
    })
      .then((rows) => {
        if (my !== gen) return;
        const page = rows || [];
        typedHasMore = page.length > PAGE;
        typedRows = append ? [...typedRows, ...page.slice(0, PAGE)] : page.slice(0, PAGE);
      })
      .catch((e) => {
        if (my === gen) feedError = errText(e);
      });
  }

  function fetchGeneric(f, name, catId, offset, my, append) {
    return getGenericEvents(id, name, f.round, PAGE + 1, offset)
      .then((rows) => {
        if (my !== gen) return;
        const page = rows || [];
        const prev = genPages[name] || { rows: [], hasMore: false, cat: catId };
        genPages[name] = {
          rows: append ? [...prev.rows, ...page.slice(0, PAGE)] : page.slice(0, PAGE),
          hasMore: page.length > PAGE,
          cat: catId,
        };
      })
      .catch((e) => {
        if (my === gen) feedError = errText(e);
      });
  }

  function loadMore() {
    const f = feedF;
    if (!f) return;
    const my = gen;
    if (typedHasMore) fetchTyped(f, typedRows.length, my, true);
    for (const [name, p] of Object.entries(genPages)) {
      if (p.hasMore) fetchGeneric(f, name, p.cat, p.rows.length, my, true);
    }
  }

  const hasMore = $derived(typedHasMore || Object.values(genPages).some((p) => p.hasMore));

  // The merged, categorized, chronological feed, then the round-
  // visibility pref (knife/warmup rows hidden unless the user opted in)
  // applied as an ADDITIONAL filter — the category opt-in rules and
  // ?round= scoping above it are untouched (applyRoundPref).
  const feedRows = $derived.by(() =>
    applyRoundPref(
      mergeFeed([
        typedRows.map((r) => normalizeEvent(r, { roundsByNumber: rbn })).filter(Boolean),
        chatRows.map((c) => normalizeChat(c)),
        Object.values(genPages).flatMap((p) => p.rows.map((g) => normalizeGeneric(g, p.cat))),
      ]),
      rbn,
      showKnifeWarmup,
    ),
  );

  // The feed count as the rail toggle prints it ("185", "185+" while a
  // page is still loading) — the ONE spelling: the expanded header's
  // number and the collapsed handle's title/aria-label both use it.
  const feedCountLabel = $derived(String(feedRows.length) + (hasMore ? '+' : ''));

  // Draw feed: the drawable-kind anchors, fetched ONCE per match in
  // load() and handed to the renderer — category chips never rebuild the
  // world layers.
  const drawNorm = $derived(drawRows.map((r) => normalizeEvent(r, {})).filter(Boolean));

  // Scrubber markers: the draw feed gated by the ACTIVE category set +
  // round/player scope (the scrubber mirrors the feed's overview;
  // dmg/weapon/distance filters are list concerns and do not move
  // markers). Precomputed buckets — no classification at runtime.
  const markers = $derived.by(() => {
    if (!data || !data.frames || !drawNorm.length) return [];
    const t0 = data.ticks[0];
    const t1 = data.ticks[data.frames - 1];
    const span = Math.max(1, t1 - t0);
    const cats = new Set(filter.cats);
    const out = [];
    // Same round-visibility pref as the feed — the scrubber mirrors the
    // feed's overview, so hidden rounds carry no markers either. (The
    // renderer's WORLD layers stay unfiltered: the map always shows the
    // full spatial context — see the drawNorm comment.)
    const norm = applyRoundPref(drawNorm, rbn, showKnifeWarmup);
    for (const l of norm) {
      if (!cats.has(l.category)) continue;
      const cat = categoryById(l.category);
      if (cat && cat.countedOnly) {
        const r = rbn.get(l.round);
        if (r && !isCounted(r)) continue;
      }
      if (filter.round >= 0 && l.round !== filter.round) continue;
      if (filter.steamId && l.steamId !== filter.steamId) continue;
      // The ONE bucket → marker mapping (landmarks.scrubberMarkerClass —
      // the contract src/lib/landmarks.test.js pins): the typed grenade
      // buckets (smoke/fire/flash/he/decoy) count as 'det' alongside
      // explode/detonation; drop/pickup/damage carry no marker ('').
      const cls = scrubberMarkerClass(l.bucket);
      if (!cls) continue;
      if (l.tick < t0 || l.tick > t1) continue;
      out.push({ cls, pct: ((l.tick - t0) / span) * 100 });
    }
    return out;
  });

  // Generic-event histogram — only the game_events category needs name
  // scoping (high-volume sources are never fetched unrestricted).
  const needHist = $derived(filter.cats.includes('game_events'));
  $effect(() => {
    if (!needHist) return;
    let off = true;
    getGenericHistogram(id)
      .then((h) => {
        if (off) hist = h || [];
      })
      .catch(() => {
        /* the select just stays empty */
      });
    return () => (off = false);
  });

  // --- Selection + detail ----------------------------------------------------
  let selected = $state(null); // normalized landmark row
  let detail = $state(null); // EventDetail payloads (event source only)
  let detailError = $state('');
  let payloadRaw = $state(false);
  let payloadQuery = $state('');
  let copied = $state(false);
  let entrySel = ''; // ?sel= from the entry URL (applied once)
  let entrySelTick = 0; // its tick when it resolves before the engine is up
  // The DEFAULT entry tick when the URL makes no time promise (no ?tick=
  // / no usable ?round=): load() resolves it once, AWAITING the
  // knife/warmup hiding pref (show_knife_warmup_rounds) — pref OFF → the
  // first COUNTED round's start, pref ON → frame 0. It is not reactive
  // on purpose: the pref decides where a replay LAUNCHES, not where an
  // in-session filter change lands (those never re-run startEngine).
  let entryDefaultTick = 0;
  let selApplied = false;

  async function select(row) {
    detailError = '';
    copied = false;
    payloadRaw = false;
    payloadQuery = '';
    selected = row;
    detail = null;
    if (row.source === 'event') {
      try {
        detail = await getEvent(row.id);
      } catch (e) {
        detailError = errText(e);
      }
    }
  }

  function closeDetail() {
    selected = null;
    detail = null;
    detailError = '';
  }

  // Entry selection: a deep link's ?sel= opens the landmark (typed
  // events resolve by id even beyond the loaded pages) and seeks the
  // replay to its tick — "open the intended position AND selection".
  // Selection during the session never seeks (the user's playback
  // context is preserved); ▶ is the explicit seek action.
  $effect(() => {
    if (!entrySel || selApplied) return;
    feedRows;
    if (feedRows.some((r) => r.key === entrySel)) {
      selApplied = true;
      const row = feedRows.find((r) => r.key === entrySel);
      select(row);
      seekEntry(row.tick);
      return;
    }
    if (!feedSettled) return;
    selApplied = true;
    if (entrySel.startsWith('e:')) {
      const n = Number(entrySel.slice(2));
      if (Number.isFinite(n) && n > 0) {
        getEvent(n)
          .then((d) => {
            if (!d) return;
            const row = normalizeEvent(d, {});
            if (row) {
              selected = row;
              detail = d;
              seekEntry(d.tick);
            }
          })
          .catch(() => {});
      }
    }
  });

  // seekEntry applies the entry ?sel= seek now when the engine is up,
  // else remembers it for startEngine: the feed routinely settles BEFORE
  // the position data loads, and an unguarded `engine?.seekTick` would
  // silently no-op there — leaving the replay on the first frame instead
  // of the linked landmark.
  function seekEntry(tick) {
    if (engine) engine.seekTick(tick);
    else entrySelTick = tick;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch (e) {
      detailError = errText(e);
    }
  }

  function copyDetail() {
    if (!detail) return;
    copyText((detail.detailJson || '') + (detail.rawJson ? '\n' + detail.rawJson : ''));
  }

  function copyPayload() {
    if (selected) copyText(selected.payloadJson || '');
  }

  // --- Navigation (URL-backed) ----------------------------------------------
  // Every filter change navigates: serialize + preserve the entry
  // context (tick/back/follow) + write the hash. sel is entry-only — it is not
  // re-pinned on later filter changes (selection stays local).
  // keepFollow=false drops the follow param (the chip's dismiss — see
  // releaseFollow), so a preserved entry context cannot re-arm it.
  function navigateFilter(next, { keepFollow = true } = {}) {
    const q = serializeLandmarkFilter(next);
    if (query.tick) q.tick = query.tick;
    if (query.back) q.back = query.back;
    if (keepFollow && query.follow) q.follow = query.follow;
    const target = buildHash(`/replay/${id}`, q);
    if (location.hash !== '#' + target) nav(target);
  }

  function toggleCat(catId) {
    const cats = filter.cats.includes(catId)
      ? filter.cats.filter((c) => c !== catId)
      : [...filter.cats, catId];
    navigateFilter({ ...filter, cats });
  }

  function setGname(name) {
    navigateFilter({ ...filter, gname: name });
  }

  function resetFilters() {
    navigateFilter(defaultFilter());
  }

  // FilterBar commits its own (typed/scope) subset — cats/gname ride
  // along untouched.
  function onBarFilter(next) {
    navigateFilter({ ...filter, ...next });
  }

  function goBack() {
    nav(backPath ? '/' + backPath : `/match/${id}`);
  }

  // --- Export (native save dialog — lib/save.js) -----------------------------
  // Cancel is a silent no-op by contract; real failures land in console.
  async function download(filename, mime, text) {
    try {
      await downloadText(filename, mime, text);
    } catch (e) {
      console.error('landmark export failed:', e);
    }
  }

  // The single export button's menu (CSV/JSON) closes itself after a
  // pick — canonical path either way: csv.js toCSV → download.js
  // downloadText → save.js native dialog.
  function closeExport() {
    if (exportEl) exportEl.open = false;
  }

  function exportCSV() {
    closeExport();
    return download(
      `match-${id}-events.csv`,
      'text/csv;charset=utf-8',
      toCSV(landmarkExportRows(feedRows)),
    );
  }

  function exportJSON() {
    closeExport();
    return download(`match-${id}-events.json`, 'application/json', JSON.stringify(feedRows, null, 2));
  }

  // Open the filter panel on ENTRY when the deep link already carries a
  // scope filter (round/player/weapon/bbox/tick window) — a scoped link
  // should show the scope it arrived with. In-session changes never
  // force it open (the Filters button owns that). The feed opens WITH it:
  // the panel lives inside the expanded rail, so a collapsed feed would
  // hide the very scope the link promises to show.
  function syncFiltersOpen(f) {
    if (f.round !== -1 || f.steamId || f.weapon || f.bbox || f.tickFrom || f.tickTo) {
      filtersOpen = true;
      eventsOpen = true;
    }
  }

  // --- Saved filter presets (scope "match") ----------------------------------
  let saved = $state([]);
  let savedSel = $state('');
  let savedError = $state('');

  async function refreshSaved() {
    try {
      const rows = await listSavedFilters();
      saved = (rows || []).filter((s) => s.scope === 'match');
      if (savedSel && !saved.some((s) => String(s.id) === savedSel)) savedSel = '';
    } catch (e) {
      savedError = errText(e);
    }
  }

  $effect(() => {
    refreshSaved();
  });

  function applySaved() {
    const s = saved.find((x) => String(x.id) === savedSel);
    if (!s) return;
    try {
      const parsed = JSON.parse(s.filterJson || '{}');
      savedError = '';
      navigateFilter(parseLandmarkFilter(parsed));
    } catch (e) {
      savedError = 'Saved filter is not valid JSON: ' + errText(e);
    }
  }

  async function saveCurrent() {
    const name = prompt('Save current filter as:');
    if (!name) return;
    try {
      const row = await saveFilter(name, 'match', JSON.stringify(serializeLandmarkFilter(filter)));
      await refreshSaved();
      if (row) savedSel = String(row.id);
      savedError = '';
    } catch (e) {
      savedError = errText(e);
    }
  }

  async function removeSaved() {
    const s = saved.find((x) => String(x.id) === savedSel);
    if (!s) return;
    try {
      await deleteSavedFilter(s.id);
      savedSel = '';
      savedError = '';
      await refreshSaved();
    } catch (e) {
      savedError = errText(e);
    }
  }

  // Scrubber/list seek — in-place, no navigation.
  function seekTo(tick) {
    engine?.seekTick(tick);
  }

  // M4 comms-around: seek TO the event with playback + voice on — the
  // audio engine starts from there (in-panel).
  function hearTick(tick) {
    engine?.seekTick(tick);
    if (voiceEngine) voiceEngine.setEnabled(true).catch(() => {});
    engine?.play();
  }

  // --- Round ribbon (spec 13) + HUD score/round context ---------------------
  // The round CONTAINING a tick: rounds arrive in chronological order
  // (= number order), so the last row whose startTick is at/before the
  // tick is the current one; null before the first round.
  function roundContaining(tick) {
    let hit = null;
    for (const r of rounds) {
      if (r && Number.isFinite(r.startTick) && r.startTick <= tick) hit = r;
    }
    return hit;
  }

  const roundAtPlayhead = $derived(roundContaining(uiTick));

  // The ribbon's click: the canonical round → start-tick lookup
  // (lib/rounds.js roundStartTick) — an unknown round keeps the current
  // position instead of jumping to the first frame.
  function onRibbonRound(n) {
    const start = roundStartTick(rounds, n);
    if (start != null && engine) engine.seekTick(start);
  }

  // Round transport (prev/next round buttons): the neighbouring round
  // NUMBER around the playhead. Rounds arrive in chronological (=
  // number) order, so the LAST row below the current number is the
  // previous round and the FIRST row above it is the next one. Null
  // before the first round or at either end disables the button; the
  // seek reuses the ribbon's round→tick rule (roundStartTick), so an
  // unknown number can never jump anywhere.
  const roundNav = $derived.by(() => {
    const cur = roundAtPlayhead ? roundAtPlayhead.number : null;
    let prev = null;
    let next = null;
    if (cur != null) {
      for (const r of rounds) {
        if (!r || !Number.isFinite(r.number)) continue;
        if (r.number < cur) prev = r.number;
        else if (r.number > cur && next == null) next = r.number;
      }
    }
    return { prev, next };
  });

  // Fixed-step transport: ±15 seconds at the match's tick rate —
  // seekTick clamps to the stream, so the buttons can never overshoot
  // (or seek to a negative tick).
  function seekBySeconds(sign) {
    if (!engine) return;
    engine.seekTick(uiTick + sign * 15 * engine.tickRate);
  }

  // hudFor builds the renderer's setHud payload for a playhead tick —
  // plain data, recomputed on every engine change (setHud redraws).
  //   score — cumulative counted wins through the last round that had
  //           ENDED at the playhead (mid-round the current round's result
  //           is not shown: never display a win the round hasn't
  //           produced); rounds.js scoreThrough is the ONE rule.
  //   teamNames — the two SIDES' names at the playhead (getTeamNames'
  //           clan/synthesized names, keyed by the teams' FINAL side —
  //           the extract's end-of-demo snapshot). hudTeamNames re-pairs
  //           them to the columns' CURRENT sides (leftSide/rightSide at
  //           uiFrame): the ct slot must hold the team on CT NOW, or the
  //           HUD paints the wrong team CT-blue after a halftime switch.
  //           The renderer falls back to CT / T when a name is empty.
  //   round — the round containing the playhead (label from the ONE
  //           roundIndexLabel formatter), or null before round 1.
  // The bomb/planted evidence is NOT passed: the renderer already holds
  // it from setLandmarks and applies bomb.js bombEndTick there (no
  // duplicated rule).
  function hudFor(tick) {
    const r = roundContaining(tick);
    let ended = 0;
    for (const x of rounds) {
      if (x && Number.isFinite(x.endTick) && x.endTick > 0 && x.endTick <= tick) {
        ended = x.number; // rows are chronological — the last match wins
      }
    }
    return {
      score: rounds.length ? scoreThrough(rounds, ended) : null,
      teamNames: hudTeamNames(teamNames, leftSide, rightSide),
      round: r
        ? {
            number: r.number,
            label: roundIndexLabel(r),
            startTick: r.startTick,
            freezeEndTick: r.freezeEndTick,
            endTick: r.endTick,
            bombSite: r.bombSite || '',
          }
        : null,
      tickRate: meta?.tickRate,
    };
  }

  const players = $derived(meta?.players || []);

  // Generic-event rows carry only a display name (`who`) — resolve it to a
  // Steam id through the sidecar slot table (meta.players) on an EXACT
  // name match only: a partial match could link the wrong person, so an
  // unresolvable name renders as plain text (ProfileLink's non-steam
  // branch). Used by the detail pane and the landmark feed's generic rows.
  function resolveWho(name) {
    if (!name) return '';
    const hit = players.find((p) => p && p.name === name);
    return hit && isSteam(hit.steamId) ? hit.steamId : '';
  }

  // --- Player-card columns (spec 19–22, 26) --------------------------------
  // Grouping (a stable team identity across halftime — players never
  // change teams): the team that FINISHED ct sits LEFT, the finished-t
  // team RIGHT. A player whose final side is empty falls back to the
  // side their payload carried at its LAST recorded frame (recorded
  // data, never a guess); if that is unknown too they go LEFT — no side
  // is invented for them, and the card renders with the column's side,
  // which is '' (neutral) whenever the column's own side is unknown
  // (TeamColumn's contract: the column side wins over any card value).
  function sideAtLastPayload(slot) {
    const masks = data && data.masks;
    const slotData = data && data.slots && data.slots[slot];
    if (!masks || !slotData || !slotData.flags) return '';
    for (let f = masks.length - 1; f >= 0; f--) {
      if (masks[f] & (1 << slot)) {
        // Exactly ONE frame — the last one carrying payload for this
        // slot; an absent side bit there is "unknown", not a licence to
        // keep scanning for a side we liked better.
        return sideFromFlags(slotData.flags[f]);
      }
    }
    return '';
  }

  const cardGroups = $derived.by(() => {
    const left = [];
    const right = [];
    players.forEach((p, slot) => {
      const side = (p && p.side) || sideAtLastPayload(slot);
      (side === 't' ? right : left).push(slot); // 'ct' AND unknown → left
    });
    return { left, right };
  });

  // Column side = that team's side AT THE PLAYHEAD (it flips at
  // halftime, spec 20/21): any member's CURRENT side from the canonical
  // per-frame rule (renderer sideFromFlags — frame bits first), falling
  // back to the final side only when NO member's frame carries side
  // bits — the renderer's documented fallback (dead frames / unassigned
  // teams report 0, and the final-side table is all there is).
  function columnSideAt(slots, frame) {
    for (const s of slots) {
      const slotData = data && data.slots && data.slots[s];
      if (slotData && slotData.flags && frame >= 0 && frame < slotData.flags.length) {
        const cur = sideFromFlags(slotData.flags[frame]); // bits only
        if (cur) return cur; // a member with payload this frame speaks for the team
      }
    }
    for (const s of slots) {
      const fin = players[s] && players[s].side;
      if (fin) return fin;
    }
    return '';
  }

  const leftSide = $derived(columnSideAt(cardGroups.left, uiFrame));
  const rightSide = $derived(columnSideAt(cardGroups.right, uiFrame));
  // Team names: getTeamNames' clan/synthesized names; a missing name
  // falls back to the bare side (TeamColumn's documented fallback).
  const leftTeamName = $derived((teamNames && teamNames.ct) || 'CT');
  const rightTeamName = $derived((teamNames && teamNames.t) || 'T');

  // Player colors (spec 21, corrected): the CS2 TEAMMATE color out of
  // the sidecar's slot table (meta.players[].color → playercolor.colorHexOf),
  // not a voice fact — every player with a known color gets the ring, a
  // player without one gets none (never a guess). playerColorSlots is the
  // slot-indexed hex array the renderer's setVoices({colors}) consumes
  // (handoff E — the dot's rim); the card columns read the same hex.
  const playerColorSlots = $derived(colorSlotsOf(players));

  // Live K/D/A + ADR at the playhead: ONE $derived that folds the
  // already-fetched drawable events (drawNorm: kill + damage rows) at
  // uiTick through replay/livestats.js — the rules live there, mirroring
  // internal/analytics/rounds.go's fold (counted rounds only, enemy-only
  // kills, cross-team non-flash assists, every death, ALL damage incl.
  // friendly fire) — and hands each card its row.
  // sideAtTick resolves a side from the position store's per-frame flags
  // AT THE EVENT'S TICK (renderer sideFromFlags — the frame's bits only,
  // never the final side: that is post-halftime and would misfile an
  // early-round event); no bits → '' → unknown → permissive, exactly like
  // Go's sameSide.
  function sideAtTick(steamId, tick) {
    const id = String(steamId);
    const slot = players.findIndex((p) => p && p.steamId != null && String(p.steamId) === id);
    const slotData = slot >= 0 && data && data.slots ? data.slots[slot] : null;
    const ticks = data && data.ticks;
    const t = Number(tick);
    if (!slotData || !slotData.flags || !ticks || !ticks.length || !Number.isFinite(t)) return '';
    // Frame at/before the event's tick (ticks are strictly increasing);
    // an event before the first frame has no side evidence → unknown.
    let lo = 0;
    let hi = ticks.length - 1;
    let frame = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ticks[mid] <= t) {
        frame = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (frame < 0 || frame >= slotData.flags.length) return '';
    return sideFromFlags(slotData.flags[frame]);
  }

  const statsBySteam = $derived(
    liveStats(drawNorm, {
      rounds,
      tick: uiTick,
      sideAt: sideAtTick,
      steamIds: players.map((p) => (p && p.steamId != null ? String(p.steamId) : '')),
    }),
  );

  // The renderer's speaking callback — STABLE identity (the renderer
  // holds it for its lifetime) that reads the live $state speakIdx and
  // roster, so a late lanes arrival never needs the closure re-pushed.
  // Null-safe by construction: no index / no roster row → false.
  function speakingFor(slot, tick) {
    const p = players[slot];
    if (!speakIdx || !p || p.steamId == null) return false;
    return speakingAt(speakIdx, String(p.steamId), tick);
  }

  // Aliveness — the engine's lerpAt rule EXACTLY (engine.js: out.alive =
  // !!(data.masks[f] & (1 << slot))): the position store's per-frame
  // mask is the canonical aliveness, so cards and dots can never
  // disagree; never re-derived any other way. An unloaded mask (no
  // position store yet) → alive: DEAD is never shown without evidence.
  function aliveAtFrame(frame, slot) {
    const masks = data && data.masks;
    if (!masks || frame < 0 || frame >= masks.length) return true;
    return !!(masks[frame] & (1 << slot));
  }

  // The first frame each slot EVER carries a payload for — the line
  // between "no data yet" and "the stream is sampling this player".
  // The position stream samples ALIVE slots only (sidecar format doc), so
  // an absent payload means dead… but only once the slot has been seen at
  // least once: the demo's opening frames carry no payload at all, and
  // calling those DEAD would report a death the data never showed. One
  // pass per load (data changes only when a match is parsed).
  const firstPayloadFrame = $derived.by(() => {
    const masks = data && data.masks;
    const n = (data && data.slots && data.slots.length) || 0;
    const first = new Array(n).fill(-1);
    if (!masks) return first;
    let left = n;
    for (let f = 0; f < masks.length && left > 0; f++) {
      const m = masks[f];
      if (!m) continue;
      for (let s = 0; s < n; s++) {
        if (first[s] < 0 && m & (1 << s)) {
          first[s] = f;
          left--;
        }
      }
    }
    return first;
  });

  // Per-player mute handlers with STABLE identity per steamId — a fresh
  // closure every frame would churn every button's onclick for nothing.
  const muteHandlerFor = (() => {
    const noop = () => {};
    const cache = new Map([['', noop]]);
    return (sid) => {
      const key = sid == null ? '' : String(sid);
      let h = cache.get(key);
      if (!h) {
        h = () => toggleVoiceMute(key);
        cache.set(key, h);
      }
      return h;
    };
  })();

  // The steam ids a column's team mute applies to (roster order, one
  // spelling shared by the toggle and startEngine's rebuild re-apply).
  function teamSteamIds(col) {
    return (col === 'left' ? cardGroups.left : cardGroups.right)
      .map((s) => (players[s] && players[s].steamId != null ? String(players[s].steamId) : ''))
      .filter((x) => x);
  }

  // The card prop arrays — ONE derived that reads the playhead (uiFrame
  // / uiTick): every per-frame value (state, alive/dead, follow,
  // speaking, muted) recomputes here, while stable refs (the roster
  // object itself, the icon maps, the memoized mute handlers) keep prop
  // churn to the values that actually changed — Svelte then writes only
  // the text/classes that differ.
  const cardColumns = $derived.by(() => {
    const frame = uiFrame;
    const tick = uiTick;
    const build = (slots, col) =>
      slots.map((slot) => {
        const p = players[slot] || {};
        const alive = aliveAtFrame(frame, slot);
        // Status is only CLAIMED once the stream has sampled this slot
        // (firstPayloadFrame); before that it is unknown — `alive: null`
        // is PlayerCard's "no data" state, which renders neither alive
        // nor DEAD.
        const sampled = (firstPayloadFrame[slot] ?? -1) >= 0 && frame >= firstPayloadFrame[slot];
        const sid = p.steamId != null ? String(p.steamId) : '';
        return {
          player: players[slot] || {},
          playerColor: colorHexOf(p.color),
          speaking: sid && speakIdx ? speakingAt(speakIdx, sid, tick) : false,
          muted: uiVoiceMutedAll || teamMuted[col] || !!(sid && uiVoiceMute[sid]),
          alive: sampled ? alive : null,
          dead: sampled && !alive,
          follow: uiFollow === slot,
          state: stateIndex ? slotStateAt(stateIndex, slot, frame) : null,
          stats: sid ? statsBySteam.get(sid) ?? null : null,
          icons: iconMap,
          iconURLs: iconUrls,
          onToggleMute: muteHandlerFor(sid),
        };
      });
    return { left: build(cardGroups.left, 'left'), right: build(cardGroups.right, 'right') };
  });

  // --- Camera mode (ONE dropdown: 'smart' | 'free' | 'follow') --------------
  // 'smart' (the DEFAULT) keeps every alive player + the active bomb on
  // screen with eased pan/zoom (renderer.js smart camera); 'free' is
  // manual drag/wheel; 'follow' locks onto a player — a SECOND dropdown
  // appears with the player list — and keeps the camera SMOOTH (smart)
  // underneath, because follow is user intent and overrides it (the
  // renderer recenters every frame; smart resumes the moment follow
  // releases).
  //
  // Pref `camera_mode` (frontend-owned kvstore, the same pattern as
  // font_size / show_knife_warmup_rounds) stores ONLY 'smart' | 'free':
  // Follow is NOT persisted — it needs a player and is entry/route state
  // (it rides ?follow=), so the pref keeps the last explicit Smart/Free
  // choice and a session's Follow can never stick across entries. Unset
  // or unknown reads as 'smart'; a stored 'free' is respected as-is.
  //
  // Reconciliation rule (never leave followSlot set with a mode that
  // fights it): whenever the ENGINE's follow state and this dropdown
  // disagree — the F / 1-9 keys and the canvas drag drive follow
  // directly — the dropdown follows the engine (see the onChange mirror
  // in startEngine): following renders 'follow' over the smart camera, a
  // release returns to 'smart'. A manual pan/zoom (renderer onUserCamera)
  // releases follow and drops to 'free' for the SESSION only (the pref
  // keeps whatever the user picked explicitly).
  let camMode = $state('smart');

  // The player Follow last had: the dropdown must never enter Follow
  // with NO player (an empty "Follow player…" selection is an unclear
  // state), so switching back to Follow resumes the player the user was
  // already following. Plain (non-reactive) view state — it is only read
  // inside event handlers, never rendered. Free/Smart release the engine
  // follow but must NOT clear this; the mirror below records every
  // non-null follow the engine reports (F/1-9 keys, canvas drag, the
  // ?follow= entry and the player dropdown all land there).
  let lastFollowed = null;

  // The renderer's own mode: 'follow' is a dropdown concept — the
  // renderer only knows 'smart' | 'free', and follow always rides smart.
  const rendererCam = () => (camMode === 'follow' ? 'smart' : camMode);

  $effect(() => {
    let live = true;
    getPref('camera_mode')
      .then((v) => {
        if (!live) return;
        // Never clobber an active Follow (the pref resolves late on a
        // ?follow= entry; follow wins, the pref applies to the next one).
        if ((v === 'free' || v === 'smart') && camMode !== 'follow') {
          camMode = v;
          renderer?.setCameraMode(v); // the engine may be up already
        }
        // unset / unknown → the 'smart' default stands
      })
      .catch(() => {
        /* unreadable store → smart */
      });
    return () => (live = false);
  });

  function onCamMode(e) {
    const v = e.currentTarget.value;
    if (v === 'follow') {
      // Follow always needs a player: the one last followed wins (it
      // survives a detour through Free/Smart), else the ?follow= entry,
      // else the first player — so the "Follow player…" placeholder can
      // never end up as the selected state. The camera stays smooth
      // (smart).
      camMode = 'follow';
      renderer?.setCameraMode('smart');
      const want =
        lastFollowed != null && players[lastFollowed]
          ? lastFollowed
          : followSlot >= 0
            ? followSlot
            : 0;
      if (players[want]) engine?.setFollow(want);
      return; // the pref keeps its last explicit smart/free choice
    }
    const m = v === 'free' ? 'free' : 'smart';
    camMode = m;
    engine?.setFollow(null); // Smart/Free releases follow (lastFollowed stays)
    renderer?.setCameraMode(m);
    setPref('camera_mode', m).catch(() => {}); // durable explicit choice
  }

  // --- Follow camera (?follow=<steamid17>) -----------------------------------
  // The Match view's "open the replay on this player" hand-off: the
  // contract is a 17-digit steam id in the route query. Resolved against
  // the sidecar slot table — a malformed id or one that is not in this
  // match resolves to -1 and the param is ignored (free camera, no
  // error). Follow itself is engine state (engine.setFollow): the
  // renderer recenters the camera on that slot every frame, across
  // rounds, and the camera dropdown's Follow option / F and 1-9 keys
  // drive the same state.
  const followSlot = $derived.by(() => {
    const sid = String(query.follow || '');
    if (!sid) return -1;
    return players.findIndex((p) => p && p.steamId === sid);
  });

  // Apply the URL-driven slot whenever it changes (or the engine comes
  // up under it). Guarded against redundant emits so a manual transport
  // selection can never be clobbered by an unchanged param.
  $effect(() => {
    const slot = followSlot;
    if (!ready || !engine) return;
    const want = slot >= 0 && players[slot] ? slot : null;
    if (engine.state.followSlot !== want) engine.setFollow(want);
  });

  // Dismiss the follow chip: release the camera AND drop ?follow= from
  // the route (entry context rides the query — navigateFilter preserves
  // it, so the param has to go for the dismissal to stick).
  function releaseFollow() {
    engine?.setFollow(null);
    if (query.follow) navigateFilter(filter, { keepFollow: false });
  }

  onMount(() => {
    load();
    return cleanup;
  });

  // teardown releases the engine/input/observer without marking the view dead
  // (startEngine re-runs it on the live path).
  function teardown() {
    ready = false;
    discardClip();
    if (voiceEngine) voiceEngine.destroy();
    voiceEngine = null;
    uiVoiceOn = false;
    uiVoiceErr = '';
    uiVoicePending = false;
    uiVoiceMutedAll = false; // the new engine starts unmuted
    if (input) input.detach();
    if (ro) ro.disconnect();
    if (offChange) offChange();
    if (engine) engine.destroy();
    if (renderer) renderer.destroy(); // cancels the smart settle loop
    input = ro = offChange = engine = renderer = null;
  }

  function cleanup() {
    live = false;
    teardown();
  }

  async function loadPack(map) {
    if (!map) return { pack: null, transform: null, img: null };
    // Shared loader: extracted pack (local CS2) wins over the bundled
    // metadata-only fallback at /maps/ (no art ships — see
    // frontend/public/maps/README.md; a missing pack = plain grid).
    // The makeTransform() output rides along — the renderer consumes it
    // instead of re-deriving the pack's transform fields.
    const p = await loadMapPack(map);
    if (!p || !p.meta) return { pack: null, transform: null, img: null };
    if (p.meta.radar && p.meta.radar.file) {
      const img = new Image();
      img.src = `${p.base}/${p.meta.radar.file}`;
      try {
        await img.decode();
        return { pack: p.meta, transform: p.transform, img };
      } catch {
        return { pack: p.meta, transform: p.transform, img: null };
      }
    }
    return { pack: p.meta, transform: p.transform, img: null };
  }

  // Icon pipeline (handoff C): read the manifest; when it reports no
  // extraction YET, ask services.extractIcons('') ONCE (it auto-detects
  // the local CS2 install / saved pref and takes a moment), then re-read
  // — the wrapper reset the session memo. On failure every card falls
  // back to text labels automatically (iconUrls stays null) and the
  // manifest's note surfaces ONCE as a .note-amber, same spirit as
  // packNote. Guarded by `live` after every await: a late extraction
  // must not write into an unmounted view.
  async function loadIcons() {
    let m = await loadIconManifest(); // resolves to a manifest on every path
    if (!live) return;
    if (!m.extracted) {
      try {
        await extractIcons('');
      } catch {
        /* auto-detection failed — the re-read below reports the outcome */
      }
      if (!live) return;
      m = await loadIconManifest(); // extractIcons reset the memo → fresh read
    }
    if (m.count > 0) {
      iconUrls = m.icons;
      iconMap = await preloadIcons(Object.keys(m.icons)); // per-name nulls, never rejects
      if (!live) return;
      renderer?.setIcons(iconObj); // late arrival — startEngine pushes it when pre-engine
    }
    if (!m.extracted) {
      iconNote = m.note || 'equipment icons unavailable — player cards fall back to text labels';
    }
  }

  // defaultEntryTick — where a replay starts when the entry URL makes
  // NO time promise (nav.entrySeekTick returned null): the knife/warmup
  // hiding pref decides — OFF (hidden, the default) lands on the FIRST
  // COUNTED round's start so a hidden warmup/knife round is never the
  // opening frame, ON (shown) lands on frame 0. No counted round (or no
  // rounds loaded at all) → frame 0, never a guessed time.
  function defaultEntryTick(showKW) {
    if (showKW) return 0;
    for (const r of rounds) {
      if (isCounted(r) && Number.isFinite(r.startTick)) return r.startTick;
    }
    return 0;
  }

  async function load() {
    loading = true;
    loadError = '';
    entrySel = query.sel || '';
    entrySelTick = 0;
    entryDefaultTick = 0;
    // A linked landmark must be visible on entry — the selection lives in
    // the feed/detail pane, which the collapsed default would hide.
    if (entrySel) eventsOpen = true;
    syncFiltersOpen(filter); // a scoped deep link opens the filter panel
    // Icon pipeline (handoff C) in the BACKGROUND: manifest read, one
    // extractIcons('') attempt when it reports no extraction yet, then
    // preload — a slow CS2 scan must never delay first paint, and the
    // cards stay reactive to the late iconMap either way.
    loadIcons().catch(() => {});
    try {
      const m = await getReplayMeta(id);
      meta = m;
      if (!m || !m.hasSidecar) {
        noSidecar = true;
        return;
      }
      const [match, rs, tn, smeta] = await Promise.all([
        getMatch(id).catch(() => null),
        getRounds(id).catch(() => []),
        getTeamNames(id).catch(() => null), // round ribbon team labels
        fetchStateMeta(id).catch(() => null), // player-state capability (handoff B)
      ]);
      matchMap = (match && match.map) || '';
      sideSwitches = (match && match.sideSwitches) || 0;
      teamNames = tn || null;
      rounds = rs || [];
      // Player-state stream (handoff B): capability lives in the sidecar's
      // meta.json. A sidecar that HAS a stateFormatVersion but not the
      // current one (v1, pre-money/helmet) gets the ONE honest note —
      // reprocessing re-records the stream in the current layout. A match
      // that never had the stream (no version key) stays silent: the
      // cards render "no state" with no reprocess nag. loadState re-reads
      // meta.json itself (the canonical one-stop loader — never forked
      // here); the duplicate read is one tiny local JSON.
      if (stateCapable(smeta)) {
        stateIndex = await loadState(id).catch(() => null);
        renderer?.setStateIndex(stateIndex); // normally pre-engine: startEngine pushes it
      } else if (smeta && smeta.stateFormatVersion != null) {
        stateNote =
          'player state unavailable — reprocess this match to gain HP/weapon/money on the cards';
      }
      // Voice presence gates the controls block; players ride alongside.
      voicePresence = await getVoicePresence(id).catch(() => null);
      if (voicePresence && voicePresence.hasVoice) {
        voicePlayers = (await getVoicePlayers(id).catch(() => [])) || [];
      } else {
        voicePlayers = [];
      }
      const { pack: p, transform: tf, img } = await loadPack(matchMap);
      pack = p;
      packTf = tf;
      radarImg = img;
      const res = await fetch(`/api/sidecar/${id}/positions`);
      if (!res.ok) {
        throw new Error(`position data unavailable (HTTP ${res.status})`);
      }
      const buf = await res.arrayBuffer();
      if (!live) return;
      data = parsePositions(buf, players.length || 10);
      // Voice speaking index (handoff D): ~1 bucket per second of match
      // time (spec 26's talking ring/card outline). BACKGROUND fetch — it
      // must not hold up first paint; whether it lands before or after
      // startEngine, the cards re-derive from the $state and the
      // renderer's setVoices is re-pushed at the assignment. A null lanes
      // result (no voice rows / stubbed service) fails soft to "no
      // speaking ring" — the colors payload is the PLAYER colors either
      // way (startEngine pushed them; they are not a voice fact).
      if (voicePresence && voicePresence.hasVoice) {
        const tr = normTickRate(meta?.tickRate);
        const span = data.ticks[data.frames - 1] - data.ticks[0];
        getVoiceLanes(id, Math.max(1, Math.ceil(span / tr)))
          .then((lanes) => {
            if (!live) return;
            speakIdx = lanes ? buildSpeakingIndex(lanes) : null;
            renderer?.setVoices({
              colors: playerColorSlots,
              speaking: speakIdx ? speakingFor : null,
            });
          })
          .catch(() => {});
      }
      // The drawable anchor set (kills/grenades/bomb/round_end) — one
      // unfiltered source read, awaited before the engine starts so the
      // world layers and scrubber markers are ready on first paint.
      drawRows =
        (await getEvents({
          matchId: id,
          kinds: DRAW_KINDS,
          round: -1,
          offset: 0,
          limit: 0,
        }).catch(() => [])) || [];
      // The DEFAULT entry tick (no explicit ?tick=/?round=): resolve it
      // here with an awaited getPref — the showKnifeWarmup $effect reads
      // the same key asynchronously and could land AFTER startEngine
      // applies the entry seek, which would start the replay on the
      // wrong side of the knife/warmup-hiding pref.
      entryDefaultTick = defaultEntryTick(
        await getPref('show_knife_warmup_rounds')
          .then((v) => v === true)
          .catch(() => false), // unreadable store → hidden (the default)
      );
      // Flash-white overlay: the blind events joined with their narrow
      // flash-duration read — the duration lives on detail_json
      // (EventRow stays payload-free, so it needs its own query; the
      // same side-channel rule as store.GetBlindFlashDetails). Fail-soft
      // by contract: any failure just leaves the overlay off, and rows
      // whose victim resolves to no slot, or whose duration is not
      // positive, are dropped here.
      try {
        const [blinds, durs] = await Promise.all([
          getEvents({ matchId: id, kinds: ['blind'], round: -1, offset: 0, limit: 0 }),
          getBlindDurations(id),
        ]);
        const msBySeq = new Map((durs || []).map((d) => [d.seq, d.ms]));
        const slotBySteam = new Map();
        players.forEach((p, i) => {
          if (p && p.steamId) slotBySteam.set(String(p.steamId), i);
        });
        const rows = [];
        for (const ev of blinds || []) {
          const ms = Number(msBySeq.get(ev.seq));
          const slot = slotBySteam.get(String(ev.victim || ''));
          if (slot == null || !(ms > 0) || !Number.isFinite(ev.tick)) continue;
          rows.push({ slot, tick: ev.tick, ms });
        }
        blindRows = rows;
      } catch {
        blindRows = []; // fail-soft — no overlay, never a load error
      }
      // loading must be false BEFORE the tick, else {#if loading} still hides
      // the {#if data} branch and bind:this never resolves (canvasEl null).
      if (live) loading = false;
      await svelteTick(); // let {#if data} render the canvas first
      if (!live) return;
      startEngine();
    } catch (e) {
      if (live) loadError = errText(e);
    } finally {
      if (live) loading = false;
    }
  }

  function startEngine() {
    teardown();
    if (!canvasEl || !data || !data.frames) return;
    engine = createEngine(data, meta.tickRate);
    renderer = createRenderer(canvasEl, {
      engine,
      data,
      players,
      // Manual pan/zoom: drop to Free for the session (the pref keeps
      // its explicit value; only the selector follows) — and, per spec
      // 17, a drag/zoom while FOLLOWING releases follow too, so the
      // engine can never keep a followSlot under a camera mode that
      // fights it. camMode is written BEFORE setFollow: the onChange
      // mirror below must not read a stale 'follow' and bounce back to
      // smart. A ?follow= entry is dropped as well (releaseFollow's
      // contract), or the next route write would re-arm it.
      onUserCamera: () => {
        camMode = 'free';
        if (engine && engine.state.followSlot != null) engine.setFollow(null);
        if (query.follow) navigateFilter(filter, { keepFollow: false });
      },
    });
    renderer.setPack(pack, radarImg, packTf);
    renderer.setLandmarks(drawNorm);
    renderer.setBlinds(blindRows); // flash-white overlay rows from load()
    // Player-card phase inputs (handoff E): push whatever load() already
    // has alongside pack/landmarks — icons and the voice lanes (the
    // SPEAKING half of setVoices; the colors are the player colors, ready
    // with the meta) may still arrive later and re-push at their
    // assignment sites; every one of these setters is additive and
    // tolerates a repeat call.
    renderer.setIcons(iconObj);
    renderer.setVoices({ colors: playerColorSlots, speaking: speakIdx ? speakingFor : null });
    renderer.setStateIndex(stateIndex);
    renderer.resize();
    renderer.setCameraMode(rendererCam()); // default 'smart' unless the pref says free
    offChange = engine.onChange((st) => {
      uiFrame = st.frame;
      uiTick = st.tick;
      uiPlaying = st.playing;
      uiSpeed = st.speed;
      uiFollow = st.followSlot;
      // Remember the followed player for the camera dropdown: switching
      // away to Free/Smart releases follow (uiFollow → null) but a later
      // switch back to Follow must resume THIS player (see lastFollowed).
      if (st.followSlot != null) lastFollowed = st.followSlot;
      uiLoopFrom = st.loopFrom;
      uiLoopTo = st.loopTo;
      uiLoopOn = st.loopEnabled;
      // Camera reconciliation (spec 17): the F / 1-9 keys and the canvas
      // drag drive engine follow directly, so the dropdown follows the
      // ENGINE — following renders 'follow' over the smooth smart camera,
      // a release returns to smart. Guarded so the explicit Smart/Free
      // choices (which release follow first) never bounce.
      const following = st.followSlot != null;
      if (following !== (camMode === 'follow')) {
        camMode = following ? 'follow' : 'smart';
        renderer.setCameraMode('smart');
      }
      // setHud carries the score/round payload AND redraws (one draw per
      // engine change — it replaces the plain draw() that lived here).
      renderer.setHud(hudFor(st.tick));
      if (recState === 'recording' && recEndFrame >= 0 && st.frame >= recEndFrame) stopClip();
    });
    input = attachReplayInput({
      canvas: canvasEl,
      engine,
      renderer,
      matchId: id,
      slotCount: players.length || 10,
    });
    ro = new ResizeObserver(() => renderer.resize());
    ro.observe(stageEl);
    // M4: voice is ON BY DEFAULT (spec 11). setEnabled(true) parks a
    // one-shot gesture listener until the first user interaction — the
    // engine reports state.pending and the transport shows the "click
    // anywhere to start voice" hint; nothing else is needed. hearTick
    // re-arms the same call from the landmark detail.
    if (voicePresence && voicePresence.hasVoice) {
      voiceEngine = createVoiceEngine({
        engine,
        matchId: id,
        fetchPCM: (steamId, fromTick, toTick) =>
          fetchVoicePCM(id, steamId, fromTick, toTick),
        onError: (msg) => {
          uiVoiceErr = msg;
        },
        onStateChange: (s) => {
          uiVoiceOn = s.enabled;
          uiVoiceErr = s.error;
          uiVoicePending = s.pending;
          uiVoiceMutedAll = s.mutedAll;
        },
      });
      voiceEngine.setPlayers(voicePlayers);
      voiceEngine.setMasterVolume(VOICE_MASTER_VOL);
      // The per-player mute map survives engine rebuilds (the player
      // cards own its UI); the per-column team mutes survive the same
      // way — re-apply each muted column as a set so a rebuilt engine
      // can never disagree with what the cards show.
      for (const p of voicePlayers) {
        if (uiVoiceMute[p.steamId]) voiceEngine.setMuted(p.steamId, true);
      }
      for (const col of ['left', 'right']) {
        if (teamMuted[col]) voiceEngine.setMutedMany(teamSteamIds(col), true);
      }
      voiceEngine.setEnabled(true).catch(() => {});
    }
    // Entry position rides the URL — durable and deep-linkable.
    // entrySeekTick is the ONE resolver: an exact ?tick= wins, else the
    // ?round= feed scope resolves to that round's START tick (a round
    // link is a link to a point in time — never the first frame); it
    // returns null when the URL made NO time promise, and then the
    // pref-decided default (load() awaited the knife/warmup pref: first
    // counted round's start while it hides them, frame 0 while it shows
    // them) applies; a ?sel= landmark that resolved before the engine was
    // up applies in between. Applied once here, after loading — in-session
    // filter changes keep the playback position.
    const tick0 = entrySeekTick(query, rounds);
    if (tick0 != null) engine.seekTick(tick0);
    else if (entrySelTick) engine.seekTick(entrySelTick);
    else if (entryDefaultTick) engine.seekTick(entryDefaultTick);
    renderer.setHud(hudFor(engine.state.tick)); // first HUD paint (redraws)
    ready = true;
    // A replay starts playing as soon as it is ready — startEngine runs
    // ONCE per launch (in-session filter changes never re-run it), so
    // this fires on first launch only; every later seek/filter keeps the
    // playback position.
    engine.play();
  }

  function togglePlay() {
    engine?.toggle();
  }

  function onSpeed(e) {
    engine?.setSpeed(Number(e.currentTarget.value));
  }

  function onScrub(e) {
    engine?.seekFrame(Number(e.currentTarget.value));
  }

  function onLoopInput() {
    engine?.setLoop(uiLoopFrom, uiLoopTo);
  }

  function toggleLoop() {
    engine?.toggleLoop();
  }

  // The Follow player dropdown (spec 17) — only rendered while camMode
  // is 'follow'. Selecting a player keeps the camera smooth (smart);
  // releasing follow itself happens through the chip, the F/1-9 keys or
  // a manual drag (never an empty option that would strand camMode on
  // 'follow' with no followSlot).
  function onFollowPlayer(e) {
    const v = e.currentTarget.value;
    if (v !== '') {
      const slot = Number(v);
      engine?.setFollow(slot);
      lastFollowed = slot; // resume target for the next Follow selection
    }
  }

  function doSnapshot() {
    if (canvasEl && engine) snapshot(canvasEl, id, engine.state.tick);
  }

  // --- Clip recorder ---------------------------------------------------------
  // canvas.captureStream(30) → MediaRecorder WebM. Mimetype fallback list is
  // required: WebKitGTK encoders are gst-plugins-good dependent — without it
  // video/webm may be absent or encoder-less.
  // Audio: mixed when the voice engine is live — its getStreamTap() exposes
  // the AudioContext/master gain for a MediaStreamDestination; otherwise the
  // clip is video-only.
  const CLIP_MIMES = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm',
  ];
  const CLIP_SEC = 10;

  let recState = $state('idle'); // idle|recording|encoding|saved|error
  let recNote = $state('');
  let recEndFrame = -1; // plain local: only read inside the onChange callback
  let recorder = null;
  let recChunks = [];
  let recAudioTap = null;
  let recStartTick = 0;

  function pickClipMime() {
    if (typeof MediaRecorder === 'undefined') return null;
    for (const m of CLIP_MIMES) {
      if (MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
  }

  function toggleRecord() {
    if (recState === 'recording') stopClip();
    else startClip();
  }

  function startClip() {
    if (!canvasEl || !engine || !data || !data.frames) {
      recState = 'error';
      recNote = `clip prerequisites missing (canvas=${!!canvasEl} engine=${!!engine} frames=${data && data.frames})`;
      return;
    }
    try {
    if (typeof MediaRecorder === 'undefined' || !canvasEl.captureStream) {
      recState = 'error';
      recNote =
        'this webview lacks MediaRecorder/captureStream — clips need a WebM encoder (on Linux install gst-plugins-good)';
      return;
    }
    const loopSet = uiLoopFrom >= 0 && uiLoopTo >= uiLoopFrom;
    const startFrame = loopSet ? uiLoopFrom : Math.min(uiFrame, data.frames - 1);
    // engine is non-null above (startClip's guard) and already holds the
    // normalized tick rate (createEngine → normTickRate).
    const tr = engine.tickRate;
    const targetTick = data.ticks[startFrame] + Math.round(CLIP_SEC * tr);
    let endFrame = data.frames - 1;
    for (let f = startFrame; f < data.frames; f++) {
      if (data.ticks[f] >= targetTick) {
        endFrame = f;
        break;
      }
    }
    if (endFrame <= startFrame) endFrame = Math.min(data.frames - 1, startFrame + 1);
    const mime = pickClipMime();
    if (mime === null) {
      recState = 'error';
      recNote = 'MediaRecorder is unavailable in this webview — recording not possible';
      return;
    }
    const stream = canvasEl.captureStream(30);
    // Mixed voice track (acceptance #5): tap the voice engine's master bus
    // when voice is enabled; falls back to video-only otherwise.
    recAudioTap = null;
    const tap = voiceEngine?.getStreamTap?.();
    if (tap) {
      try {
        const dest = tap.ctx.createMediaStreamDestination();
        tap.master.connect(dest);
        for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
        recAudioTap = { ctx: tap.ctx, master: tap.master, dest };
      } catch {
        recAudioTap = null;
      }
    }
    recChunks = [];
    recStartTick = data.ticks[startFrame];
    recEndFrame = endFrame;
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch (e) {
      recState = 'error';
      recNote = `MediaRecorder failed: ${errText(e)} — on Linux install gst-plugins-good for WebM encoders`;
      recEndFrame = -1;
      return;
    }
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) recChunks.push(e.data);
    };
    recorder.onstop = finishClip;
    recorder.start(250);
    recState = 'recording';
    recNote = `${(mime || 'video/webm default').replace('video/', '')} · ${recAudioTap ? 'canvas + voice mix' : 'video only (enable voice for mixed audio)'}`;
    engine.seekTick(data.ticks[startFrame]);
    engine.setSpeed(1);
    engine.play();
    } catch (e) {
      recState = 'error';
      recNote = `clip failed: ${errText(e)}`;
      recEndFrame = -1;
      recChunks = [];
    }

  }

  function stopClip() {
    if (!recorder || recState !== 'recording') return;
    recState = 'encoding';
    engine?.pause();
    try {
      recorder.stop();
    } catch {
      finishClip();
    }
  }

  async function finishClip() {
    const type = (recorder && recorder.mimeType) || 'video/webm';
    const blob = new Blob(recChunks, { type });
    recChunks = [];
    recorder = null;
    if (recAudioTap) {
      try {
        recAudioTap.master.disconnect(recAudioTap.dest);
      } catch {
        /* already torn down */
      }
      for (const t of recAudioTap.dest.stream.getAudioTracks()) t.stop();
      recAudioTap = null;
    }
    recEndFrame = -1;
    if (!blob.size) {
      recState = 'error';
      recNote =
        'recorder produced an empty blob — no WebM encoder available (on Linux install gst-plugins-good)';
      return;
    }
    // Native save dialog (lib/save.js): on cancel the clip is discarded
    // silently, on write failure the error lands in the status chip.
    try {
      const path = await downloadBlob(`clip-${id}-${recStartTick}.webm`, blob);
      if (path) {
        recState = 'saved';
        recNote = `${type.replace('video/', '')} · ${(blob.size / 1024).toFixed(0)} KB`;
      } else {
        // Cancel: the chip renders at idle (hidden), so the UI returns to
        // its pre-record state — a cancel looks like nothing happened.
        recState = 'idle';
        recNote = '';
      }
    } catch (e) {
      recState = 'error';
      recNote = `clip save failed: ${errText(e)}`;
    }
  }

  function discardClip() {
    if (recorder) {
      recorder.onstop = null;
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch {
        /* already stopped */
      }
    }
    recorder = null;
    recChunks = [];
    recEndFrame = -1;
    recState = 'idle';
    recNote = '';
  }

  // --- M4 voice controls (kept for the player-card phase) -------------------
  // Per-player mute: the state + handler survive the voice-bar removal —
  // the next phase mounts the chips on the player cards and reuses these.
  function toggleVoiceMute(steamId) {
    uiVoiceMute[steamId] = !uiVoiceMute[steamId];
    voiceEngine?.setMuted(steamId, !!uiVoiceMute[steamId]);
  }

  // Per-team mute (spec 22): flip the column's flag — the cards derive
  // `muted` from it — and drive the voice engine in ONE setMutedMany.
  // On UNMUTE the individually-muted players are re-applied:
  // setMutedMany(false) cleared their engine flags too, and the card
  // formula (muteAll || team || per-player) must never disagree with
  // what is actually audible.
  function toggleTeamMute(col) {
    const v = !teamMuted[col];
    teamMuted[col] = v;
    const ids = teamSteamIds(col);
    voiceEngine?.setMutedMany(ids, v);
    if (!v) {
      for (const sid of ids) if (uiVoiceMute[sid]) voiceEngine?.setMuted(sid, true);
    }
  }
  // Stable handlers for the two column buttons — a new closure per frame
  // would rewrite both onclick handlers on every playhead tick.
  const toggleLeftTeamMute = () => toggleTeamMute('left');
  const toggleRightTeamMute = () => toggleTeamMute('right');

  // Mute all (spec 18): silences every player's voice under the
  // scrubber. The engine owns the flag — setMutedAll emits and the
  // onStateChange mirror updates uiVoiceMutedAll (aria-pressed/styling),
  // so the button and the engine can never disagree. No voice in this
  // match → the button is disabled (voiceEngine stays null, no-op).
  function toggleVoiceMuteAll() {
    voiceEngine?.setMutedAll(!uiVoiceMutedAll);
  }
</script>

<div class="view replay-view">
  <!-- Main column — the FIRST child of the view (the landmark rail
       joins as its sibling when expanded, so both columns' headers
       share the same top line). Its first line is the top bar: back
       button left (spec 7), the round ribbon in the middle (spec 13,
       the one flex-grow cell — it shrinks before the buttons do), the
       collapsed landmark-rail toggle right (spec 14). Both used to
       float inside the render stage; the stage's corners belong to the
       HUD/canvas now. The toggle keeps the rail-visible gate the
       stage-floated one had (it appears exactly when the canvas does)
       plus the {#if !eventsOpen} gate: when the rail is open its aside
       header owns the toggle instead, at the same height as this bar. -->
  <div class="replay-main">
    <div class="replay-topbar">
      <button class="btn rp-back" aria-label="Back" title="Back" onclick={goBack}>
        <span class="codicon codicon-arrow-left" aria-hidden="true"></span> Back
      </button>
      <div class="rp-ribbon">
        {#if rounds.length}
          <!-- The canonical RoundStrip (Match header / RoundDetail keep
               their navigation behavior; here onselect seeks the replay
               to the round's start tick through the round→tick rule). -->
          <RoundStrip
            {rounds}
            current={roundAtPlayhead ? roundAtPlayhead.number : 0}
            matchId={id}
            teamAbove={teamNames ? teamNames.ct : ''}
            teamBelow={teamNames ? teamNames.t : ''}
            {sideSwitches}
            back={backPath}
            {nav}
            onselect={onRibbonRound}
          />
        {/if}
      </div>
      {#if !eventsOpen && railVisible}
        <button
          class="side-toggle rp-rail-toggle"
          aria-expanded="false"
          aria-label="Landmarks ({feedCountLabel} events)"
          title="Landmarks ({feedCountLabel} events)"
          onclick={() => (eventsOpen = true)}
        >
          <span class="codicon codicon-chevron-left" aria-hidden="true"></span>
        </button>
      {/if}
    </div>
    {#if loadError}
      <p class="error" role="alert">{loadError}</p>
    {/if}

    {#if loading}
      <p class="muted" role="status">Loading replay…</p>
    {:else if noSidecar}
      <div class="panel empty">
        <p class="empty-title" role="status">No replay data for this match</p>
        <p class="muted">
          Positions are recorded during parsing — reprocess to record them, then
          reopen the replay.
        </p>
        <button class="btn primary" onclick={() => nav('/library')}>
          Go to Library
        </button>
      </div>
    {:else if data}
      {#if packNote}
        <p class="note-amber" role="status">{packNote}</p>
      {/if}
      {#if stateNote}
        <!-- v1 sidecar: the ONE reprocess note (handoff B) — shown only
             when the sidecar HAS a stateFormatVersion that isn't the
             current one; a match that never had the stream stays silent. -->
        <p class="note-amber" role="status">{stateNote}</p>
      {/if}
      {#if iconNote}
        <!-- Icon extraction failed after one attempt (handoff C): cards
             already fell back to text labels; this says why, once. -->
        <p class="note-amber" role="status">{iconNote}</p>
      {/if}
      {#if meta && data.frames !== meta.frames}
        <p class="note-amber" role="status">
          frame count mismatch: stream has {data.frames}, meta says {meta.frames}
        </p>
      {/if}
      <div class="replay-body">
        <!-- Player-card columns (spec 19): finished-CT LEFT, finished-T
             RIGHT (the grouping is stable across halftime); each column's
             side — and with it the team name color AND every card tint —
             is that team's side AT THE PLAYHEAD (leftSide/rightSide flip
             at halftime, see columnSideAt). -->
        <TeamColumn
          teamName={leftTeamName}
          side={leftSide}
          players={cardColumns.left}
          teamMuted={teamMuted.left}
          onToggleTeamMute={toggleLeftTeamMute}
        />
        <div class="replay-stage" bind:this={stageEl}>
          <canvas bind:this={canvasEl} aria-label="Replay canvas"></canvas>
          <!-- The back button and the collapsed landmark-rail toggle
               used to float here (top-left / top-right of the stage);
               both now live in the main column's .replay-topbar above —
               the stage's corners are left to the canvas overlays (the
               score box sits top-center, the kill feed top-right). -->
          {#if uiFollow != null && players[uiFollow]}
            <!-- Follow chip: the dismiss surface for the camera-follow
                 state (?follow= entry, the camera dropdown's Follow and
                 the F/1-9 keys all land here). Top-LEFT of the stage —
                 the kill feed owns the top-right, so nothing else
                 claims this corner. -->
            <span class="chip follow-chip" role="status">
              <span class="codicon codicon-eye" aria-hidden="true"></span>
              Following {players[uiFollow].name || `slot ${uiFollow}`}
              <button
                class="btn small ghost"
                aria-label="Stop following {players[uiFollow].name || 'player'}"
                title="Release the follow camera"
                onclick={releaseFollow}
                ><span class="codicon codicon-close"></span></button
              >
            </span>
          {/if}
        </div>
        <TeamColumn
          teamName={rightTeamName}
          side={rightSide}
          players={cardColumns.right}
          teamMuted={teamMuted.right}
          onToggleTeamMute={toggleRightTeamMute}
        />
      </div>

      <!-- Two lines: the scrubber owns the FULL-WIDTH line (round
           markers + the game-time readout ride with it), the centered
           button/control cluster keeps the ONE .toolbar row below it. -->
      <div class="replay-transport" role="group" aria-label="Replay transport">
        <div class="replay-scrub">
          <div class="scrubber-wrap">
            <input
              class="scrubber"
              type="range"
              min="0"
              max={Math.max(0, frames - 1)}
              value={uiFrame}
              oninput={onScrub}
              aria-label="Frame"
            />
            {#each markers as m, i (i)}
              <span class="scrub-marker {m.cls}" style="left:{m.pct}%"></span>
            {/each}
          </div>
          <span class="mono replay-readout" title="frame {uiFrame + 1}/{frames} · tick {uiTick}"
            >{scrubTime}</span
          >
        </div>

        <div class="toolbar">
          <!-- Round transport (prev/next round): flank the play
               cluster — disabled at either end or while the playhead
               round is unknown (before the first round). -->
          <button
            class="btn"
            id="rp-round-prev"
            aria-label="Previous round"
            title="Previous round"
            disabled={!ready || roundNav.prev == null}
            onclick={() => onRibbonRound(roundNav.prev)}
            ><span class="codicon codicon-chevron-left" aria-hidden="true"></span></button
          >
          <button
            class="btn"
            id="rp-seek-back"
            aria-label="Seek −15 seconds"
            title="Seek −15 seconds"
            disabled={!ready}
            onclick={() => seekBySeconds(-1)}
            ><span class="codicon codicon-arrow-small-left" aria-hidden="true"></span></button
          >
          <button
            class="btn primary"
            aria-label={uiPlaying ? 'Pause' : 'Play'}
            title={uiPlaying ? 'Pause (Space)' : 'Play (Space)'}
            onclick={togglePlay}><span class="codicon {uiPlaying ? 'codicon-debug-pause' : 'codicon-play'}"></span></button
          >
          <button
            class="btn"
            id="rp-seek-fwd"
            aria-label="Seek +15 seconds"
            title="Seek +15 seconds"
            disabled={!ready}
            onclick={() => seekBySeconds(1)}
            ><span class="codicon codicon-arrow-small-right" aria-hidden="true"></span></button
          >
          <button
            class="btn"
            id="rp-round-next"
            aria-label="Next round"
            title="Next round"
            disabled={!ready || roundNav.next == null}
            onclick={() => onRibbonRound(roundNav.next)}
            ><span class="codicon codicon-chevron-right" aria-hidden="true"></span></button
          >
          <label class="sr-only" for="rp-speed">Speed</label>
          <select class="input" id="rp-speed" value={uiSpeed} onchange={onSpeed}>
            {#each SPEEDS as s (s)}
              <option value={s}>{s}×</option>
            {/each}
          </select>

          <!-- Loop (spec 12): the from/to inputs + the toggle grouped in
               ONE popover behind a loop-like codicon (sync). Popover is
               the canonical dismissal component (Escape + outside
               click); the panel anchors ABOVE the button because the
               transport sits at the bottom of the column. -->
          <span class="rp-loop" bind:this={loopAnchor}>
            <button
              class="btn"
              class:warn={uiLoopOn}
              aria-pressed={uiLoopOn}
              aria-expanded={loopOpen}
              aria-label="Loop range"
              title="Loop range (L) — set the from/to frames and toggle the loop"
              onclick={() => (loopOpen = !loopOpen)}
              ><span class="codicon codicon-sync" aria-hidden="true"></span></button
            >
            <Popover open={loopOpen} anchor={loopAnchor} onClose={() => (loopOpen = false)}>
              <div class="rp-loop-pop loop-group" role="group" aria-label="Loop range">
                <label class="sr-only" for="rp-loop-from">Loop from frame</label>
                <input
                  class="input mono loop-input"
                  id="rp-loop-from"
                  type="number"
                  min="0"
                  max={Math.max(0, frames - 1)}
                  placeholder="from"
                  value={uiLoopFrom >= 0 ? uiLoopFrom : ''}
                  onchange={(e) => {
                    uiLoopFrom = e.currentTarget.value === '' ? -1 : Number(e.currentTarget.value);
                    onLoopInput();
                  }}
                />
                <span class="muted">–</span>
                <label class="sr-only" for="rp-loop-to">Loop to frame</label>
                <input
                  class="input mono loop-input"
                  id="rp-loop-to"
                  type="number"
                  min="0"
                  max={Math.max(0, frames - 1)}
                  placeholder="to"
                  value={uiLoopTo >= 0 ? uiLoopTo : ''}
                  onchange={(e) => {
                    uiLoopTo = e.currentTarget.value === '' ? -1 : Number(e.currentTarget.value);
                    onLoopInput();
                  }}
                />
                <button
                  class="btn small"
                  class:warn={uiLoopOn}
                  title="Toggle loop (L)"
                  onclick={toggleLoop}>Loop</button
                >
              </div>
            </Popover>
          </span>

          <span class="toolbar-sep" aria-hidden="true"></span>

          <!-- Camera (spec 17): ONE plain dropdown for Smart/Free/Follow
               — the player list appears as a second dropdown only while
               Follow is selected. -->
          <label class="sr-only" for="rp-cam">Camera mode</label>
          <select
            class="input"
            id="rp-cam"
            value={camMode}
            onchange={onCamMode}
            title="Smart keeps every player and the bomb on screen with smooth pan/zoom (drag or wheel takes over → Free); Free is manual; Follow locks the camera onto a player (pick them below) — dragging releases it"
          >
            <option value="smart">Smart</option>
            <option value="free">Free</option>
            <option value="follow">Follow</option>
          </select>

          {#if camMode === 'follow'}
            <label class="sr-only" for="rp-follow">Follow player</label>
            <select
              class="input"
              id="rp-follow"
              value={uiFollow ?? ''}
              onchange={onFollowPlayer}
              title="The player the camera follows — release it from the stage chip, with F, or by dragging"
            >
              <option value="" disabled>Follow player…</option>
              {#each players as p, i (i)}
                <option value={i}>{i + 1}. {p.name || `slot ${i}`}</option>
              {/each}
            </select>
          {/if}

          <!-- Mute all (spec 18): silences every player's voice; the
               engine owns the flag and mirrors it back through
               onStateChange (aria-pressed). Disabled when this match
               has no voice at all. -->
          <button
            class="btn"
            class:warn={uiVoiceMutedAll}
            aria-pressed={uiVoiceMutedAll}
            aria-label="Mute all"
            disabled={!voicePresence || !voicePresence.hasVoice}
            title={uiVoiceMutedAll ? 'Unmute all players' : 'Mute all players'}
            onclick={toggleVoiceMuteAll}
            ><span class="codicon {uiVoiceMutedAll ? 'codicon-mute' : 'codicon-unmute'}" aria-hidden="true"></span></button
          >

          <span class="toolbar-sep" aria-hidden="true"></span>

          {#if uiVoiceErr}
            <span class="error rp-voice-hint" role="alert"
              >{uiVoiceErr} — install <span class="mono">gst-plugins-good</span> (GStreamer) if audio fails to start.</span
            >
          {:else if uiVoicePending}
            <!-- The engine parked its one-shot gesture listener: voice is
                 ON, it just needs the first click to start the context. -->
            <span class="muted rp-voice-hint" role="status">click anywhere to start voice</span>
          {/if}

          {#if ready && data}
            <button
              class="btn"
              aria-label="Snapshot"
              title="Save a PNG snapshot of the current frame (S)"
              onclick={doSnapshot}
              ><span class="codicon codicon-device-camera" aria-hidden="true"></span></button
            >
            <button
              class="btn clip-btn"
              class:primary={recState === 'recording'}
              disabled={recState === 'encoding'}
              onclick={toggleRecord}
              aria-label={recState === 'recording' ? 'Stop clip' : 'Record clip'}
              title="Record a WebM clip — loop range if set, else 10s from the playhead (video only)"
              ><span class="codicon {recState === 'recording' ? 'codicon-debug-stop' : 'codicon-record'}" aria-hidden="true"></span></button
            >
            {#if recState !== 'idle'}
              <span
                class="chip clip-state {recState === 'recording'
                  ? 'recording'
                  : recState === 'encoding'
                    ? 'busy'
                    : recState === 'saved'
                      ? 'ok'
                      : 'bad'}"
                title={recNote}
                role="status"
                >{recState === 'recording'
                  ? `recording · ${recNote}`
                  : recState === 'encoding'
                    ? 'encoding…'
                    : recState === 'saved'
                      ? `saved · ${recNote}`
                      : recNote}</span
              >
              {#if recState === 'saved' || recState === 'error'}
                <button class="btn small ghost" onclick={discardClip} title="Dismiss"><span class="codicon codicon-close"></span></button>
              {/if}
            {/if}
          {/if}

          <span class="toolbar-sep" aria-hidden="true"></span>

          <!-- Keyboard hints — the toolbar's LAST cell (rightmost): one
               codicon, no label, the shortcuts ride the title. Outside
               the ready/data gate so it always shows. -->
          <span class="muted" title="Space play/pause · , . speed · ←/→ step · Shift ±64 · L loop · F follow · 1-9 select · S snapshot"><span class="codicon codicon-keyboard" aria-hidden="true"></span></span>
        </div>
      </div>
    {/if}
  </div>
  {#if railVisible && eventsOpen}
  <aside class="replay-side" aria-label="Landmark events">
    <button
      class="side-toggle"
      aria-expanded="true"
      aria-label="Landmarks ({feedCountLabel} events)"
      title="Landmarks ({feedCountLabel} events)"
      onclick={() => (eventsOpen = false)}
    >
      <h2>Landmarks</h2>
      <span class="spacer"></span>
      <span class="muted num">{feedCountLabel}</span>
      <!-- Hiding the panel points right — matching the collapsed
           stage handle's left-pointing chevron (click to expand). -->
      <span class="muted"><span class="codicon codicon-chevron-right"></span></span>
    </button>
      <!-- The middle of the panel scrolls as a unit (controls →
           filter panel → list); the detail pane pins below it, so a
           long feed can never clip the selected event. -->
      <div class="lm-scroll">
      <!-- Controls row: ONE Filters toggle governs every filter
           surface below it — the chips, name picker, scope bar and
           presets/Reset all show/hide TOGETHER (filtersOpen); export
           is not a filter and stays in this row. -->
      <div class="lm-toolbar" role="group" aria-label="Feed controls">
        <button
          class="btn small"
          class:primary={filtersOpen}
          aria-expanded={filtersOpen}
          onclick={() => (filtersOpen = !filtersOpen)}
          title="Show/hide the category chips and every filter control"
        >
          <span class="codicon codicon-filter" aria-hidden="true"></span> Filters
          <span class="muted lm-filter-count">{filter.cats.length}</span>
        </button>
        <span class="spacer"></span>
        <details class="lm-export" bind:this={exportEl}>
          <summary
            class="btn small"
            aria-label="Export the loaded feed"
            title="Export the loaded feed — CSV or JSON"
            ><span class="codicon codicon-export" aria-hidden="true"></span></summary
          >
          <div class="lm-export-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              class="lm-export-item"
              disabled={!feedRows.length}
              onclick={exportCSV}>CSV</button
            >
            <button
              type="button"
              role="menuitem"
              class="lm-export-item"
              disabled={!feedRows.length}
              onclick={exportJSON}>JSON</button
            >
          </div>
        </details>
      </div>

      {#if filtersOpen}
        <!-- The whole filter surface: category chips → game-events
             name picker → scope bar → saved presets + Reset. -->
        <div class="lm-filter-panel">
          <!-- Category chips: the sparse default (kills + round wins) is
               what a fresh URL carries; everything else is opt-in. -->
          <div class="lm-cats" role="group" aria-label="Event categories">
            {#each CATEGORIES as c (c.id)}
              <button
                class="chip lm-cat-chip"
                class:on={filter.cats.includes(c.id)}
                aria-pressed={filter.cats.includes(c.id)}
                title={c.default ? `${c.label} (on by default)` : `Show ${c.label.toLowerCase()} in the feed`}
                onclick={() => toggleCat(c.id)}>{c.label}</button
              >
            {/each}
          </div>

          {#if needHist}
            <label class="lm-gname" for="lm-gname">
              Game events
              <select
                class="input"
                id="lm-gname"
                value={filter.gname}
                onchange={(e) => setGname(e.currentTarget.value)}
              >
                <option value="">Pick an event name…</option>
                {#each hist as h (h.name)}
                  <option value={h.name}>{h.name} ({h.count})</option>
                {/each}
                {#if filter.gname && !hist.some((h) => h.name === filter.gname)}
                  <option value={filter.gname}>{filter.gname}</option>
                {/if}
              </select>
            </label>
            {#if !filter.gname}
              <p class="muted lm-hint">High-volume sources load by name only — pick one above.</p>
            {/if}
          {/if}

          <FilterBar {id} filter={filter} onchange={onBarFilter} showReset={false} />

          <div class="lm-toolbar" role="group" aria-label="Saved filter presets">
            <select class="input lm-saved" aria-label="Saved filters" value={savedSel} onchange={(e) => (savedSel = e.currentTarget.value)}>
              <option value="">Saved filters…</option>
              {#each saved as s (s.id)}
                <option value={String(s.id)}>{s.name}</option>
              {/each}
            </select>
            <button class="btn small" disabled={!savedSel} onclick={applySaved}>Apply</button>
            <button class="btn small" onclick={saveCurrent} title="Save the current filter as a preset">Save</button>
            <button class="btn small" disabled={!savedSel} title="Delete the selected saved filter" onclick={removeSaved}><span class="codicon codicon-close"></span></button>
            <span class="spacer"></span>
            <button class="btn small" onclick={resetFilters} title="Reset every filter to the sparse default">Reset</button>
          </div>
        </div>
      {/if}
      {#if savedError}
        <p class="error" role="alert">{savedError}</p>
      {/if}
      {#if feedError}
        <p class="error" role="alert">{feedError}</p>
      {/if}

      {#if !selected}
      <ul class="landmark-list" aria-label="Events">
        {#each feedRows as row (row.key)}
          <LandmarkRow
            {row}
            {nav}
            resolveSteam={resolveWho}
            roundByNumber={rbn}
            tickRate={meta?.tickRate}
            selected={selected?.key === row.key}
            onselect={select}
            onseek={(r) => seekTo(r.tick)}
          />
        {:else}
          <li class="muted lm-empty" role="status">
            {#if filter.cats.length === 0}
              No categories enabled — turn some on in Filters.
            {:else if feedLoading}
              Loading events…
            {:else if prefHidesScope}
              Knife/warmup rounds are hidden — show them in Settings, or clear the round filter.
            {:else}
              No events match these filters.
            {/if}
          </li>
        {/each}
      </ul>
      {#if hasMore}
        <button class="btn small lm-more" onclick={loadMore} disabled={feedLoading}>
          {feedLoading ? 'Loading…' : 'Load more…'}
        </button>
      {/if}
      {#if feedLoading && feedRows.length > 0}
        <p class="muted lm-hint" role="status">Loading…</p>
      {/if}
      {/if}
      {#if selected}
        <div class="lm-detail" aria-label="Selected landmark">
          <div class="lm-detail-head">
            <span class="chip kind">{categoryById(selected.category)?.label || selected.category}</span>
            {#if selected.source === 'event'}
              <span class="mono">#{selected.seq}</span>
            {/if}
            <span class="mono muted">tick {selected.tick}</span>
            <span class="chip round-chip">{selected.round >= 1 ? `R${selected.round}` : roundIndexLabel(rbn.get(selected.round) ?? selected.round)}</span>
            <div class="spacer"></div>
            {#if voicePresence && voicePresence.hasVoice}
              <button
                class="btn small"
                title="Open playback at this event with voice on — hear comms around it"
                onclick={() => hearTick(selected.tick)}>Hear ±10s <span class="codicon codicon-play"></span></button
              >
            {/if}
            <button class="btn small ghost" aria-label="Close detail" title="Close detail — back to the list" onclick={closeDetail}><span class="codicon codicon-close"></span></button>
          </div>
          {#if detailError}
            <p class="error" role="alert">{detailError}</p>
          {/if}
          {#if selected.source === 'event'}
            <dl class="facts lm-facts">
              <div>
                <dt>Attacker</dt>
                <dd><ProfileLink steam={selected.attacker} name={selected.attackerName || '—'} {nav} title="Open {selected.attackerName} profile" /></dd>
              </div>
              <div>
                <dt>Victim</dt>
                <dd><ProfileLink steam={selected.victim} name={selected.victimName || '—'} {nav} title="Open {selected.victimName} profile" /></dd>
              </div>
              <div>
                <dt>Assister</dt>
                <dd>
                  <ProfileLink
                    steam={selected.assister}
                    name={selected.assisterName || '—'}
                    {nav}
                    title="Open {selected.assisterName} profile"
                  />
                </dd>
              </div>
              <div>
                <dt>Weapon</dt>
                <dd class="mono">{selected.weapon || '—'}</dd>
              </div>
              <div>
                <dt>Damage</dt>
                <dd class="num">{selected.dmg}</dd>
              </div>
              <div>
                <dt>Distance</dt>
                <dd class="num">{selected.distance ? Math.round(selected.distance) : '—'}</dd>
              </div>
              <div>
                <dt>Hitgroup</dt>
                <dd>{selected.hitgroup || '—'}</dd>
              </div>
              <div>
                <dt>Site</dt>
                <dd>{selected.site || '—'}</dd>
              </div>
              <div class="fact-wide">
                <dt>Flags</dt>
                <dd><EventFlags event={selected} none /></dd>
              </div>
            </dl>
            {#if detail}
              <details class="json-block" open>
                <summary>detail.json</summary>
                <pre class="mono">{prettyJson(detail.detailJson)}</pre>
              </details>
              <details class="json-block">
                <summary>raw.json</summary>
                <pre class="mono">{prettyJson(detail.rawJson)}</pre>
              </details>
              <button class="btn small" onclick={copyDetail}>{copied ? 'Copied' : 'Copy payloads'}</button>
            {:else if !detailError}
              <p class="muted" role="status">Loading payloads…</p>
            {/if}
          {:else if selected.source === 'chat'}
            <dl class="facts lm-facts">
              <div>
                <dt>Time</dt>
                <dd title="tick {selected.tick}">{chatClock(selected, rbn, meta?.tickRate)}</dd>
              </div>
              <div>
                <dt>From</dt>
                <dd><ProfileLink steam={selected.steamId} name={selected.who || '—'} {nav} title="Open {selected.who} profile" /></dd>
              </div>
              <div>
                <dt>Kind</dt>
                <dd>{selected.kind || 'chat'}{selected.decrypted ? ' · decrypted' : ''}</dd>
              </div>
            </dl>
            <p class="lm-chat-text">{selected.text}</p>
          {:else}
            <dl class="facts lm-facts">
              <div>
                <dt>Event</dt>
                <dd class="mono">{selected.name}</dd>
              </div>
              <div>
                <dt>Tick</dt>
                <dd class="num mono">{selected.tick}</dd>
              </div>
              <div>
                <dt>Round</dt>
                <dd class="num">{roundIndexLabel(rbn.get(selected.round) ?? selected.round)}</dd>
              </div>
              {#if selected.who}
                <div>
                  <dt>Player</dt>
                  <dd>
                    <!-- Generic rows carry only a display name — resolve
                         it through the replay meta's player list on an
                         EXACT match only; unresolvable stays plain text. -->
                    <ProfileLink
                      steam={resolveWho(selected.who)}
                      name={selected.who}
                      {nav}
                      title="Open {selected.who} profile"
                    />
                  </dd>
                </div>
              {/if}
              {#if selected.label}
                <div class="fact-wide">
                  <dt>Detail</dt>
                  <dd>{selected.label}</dd>
                </div>
              {/if}
            </dl>
            <div class="lm-payload">
              <div class="row-between">
                <span class="spacer"></span>
                <input
                  class="input"
                  placeholder="Filter keys…"
                  bind:value={payloadQuery}
                  aria-label="Filter payload keys"
                />
                <button
                  class="btn small ghost"
                  aria-pressed={payloadRaw}
                  title="Toggle raw JSON"
                  onclick={() => (payloadRaw = !payloadRaw)}>{payloadRaw ? 'tree' : 'raw'}</button
                >
              </div>
              {#if payloadRaw}
                <pre class="mono">{selected.payloadJson}</pre>
              {:else}
                <PayloadTree json={selected.payloadJson} query={payloadQuery.trim()} />
              {/if}
              <button class="btn small" onclick={copyPayload}>{copied ? 'Copied' : 'Copy'}</button>
            </div>
          {/if}
          <div class="lm-detail-actions">
            <button class="btn small primary" onclick={() => seekTo(selected.tick)}>
              <span class="codicon codicon-play"></span> Seek to event
            </button>
          </div>
        </div>
      {/if}
      </div>
      <!-- /lm-scroll -->
  </aside>
  {/if}
</div>

