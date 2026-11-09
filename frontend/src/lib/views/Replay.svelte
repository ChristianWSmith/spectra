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
  // round-range/player/weapon/distance/bbox scope, generic name, initial
  // tick, selected landmark, origin path) lives in the ROUTE QUERY
  // (#/replay/:id?cat=…&roundFrom=…&back=…) — deep links, refresh and
  // back/forward preserve it by construction. Playback state (engine
  // tick, selection after entry) is local.
  import { onMount, tick as svelteTick } from 'svelte';
  import {
    getReplayMeta,
    getEvents,
    getEvent,
    getBlindDurations,
    getDropDetails,
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
    loadState,
    slotStateAt,
  } from '../replay/state.js';
  import { deriveBullets } from '../replay/bullets.js';
  import { buildDecoyPlan } from '../replay/decoy.js';
  import { loadIconManifest, preloadIcons } from '../replay/icons.js';
  import {
    AUDIO_VOL_DEFAULT,
    createSfxEngine,
    loadSoundManifest,
    prefVolume,
  } from '../replay/sfx.js';
  import {
    buildSpeakingIndex,
    speakingAt,
  } from '../replay/voiceindex.js';
  // Player colors (the card ring + the renderer's dot rim) are the raw
  // m_iCompTeammateColor the sidecar carries, mapped once here; the live
  // K/D/A + ADR fold feeds the cards' stats row.
  import { colorHexOf, colorSlotsOf } from '../replay/playercolor.js';
  import { liveStats } from '../replay/livestats.js';
  // Card presence (player_connect / player_disconnect): which roster
  // slots are IN the match at the playhead — the ONE rule that decides
  // which player cards exist (the card columns' filter below) — plus the
  // reload ring's fill (the ONE reload-progress formula).
  import { presentAt, indexConnections, reloadProgress } from '../replay/playercard.js';
  import { loadMapPack } from '../components/mapxform.js';
  import { downloadBlob, downloadText } from '../download.js';
  import { toCSV } from '../csv.js';
  import { chatClock, prettyJson, fmtClock, parseClock, tickSeconds, normTickRate } from '../fmt.js';
  import { isCounted, roundStartTick, roundIndexLabel, scoreThrough } from '../rounds.js';
  import { isSteam, entrySeekTick, entryLoopRange } from '../nav.js';
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
  // (built in startEngine), uiVoiceOn, uiVoiceErr, the per-player mute
  // map uiVoiceMute + toggleVoiceMute, and uiVoiceMutedAll (the Voice
  // row's mute in the volume popover under the scrubber — the player
  // cards' `muted` formula consumes it). What is GONE with spec 10
  // (voice lanes + the old voice bar): lanesOpen/laneSeek, uiVoiceCtx,
  // solo, and the WAV export link. Voice starts BY ITSELF (audio.js
  // silent-retry contract — no gesture-pending hint anymore).
  let voicePresence = $state(null);
  let voicePlayers = $state([]);
  let voiceEngine = null;
  let uiVoiceOn = $state(false);
  let uiVoiceErr = $state('');
  let uiVoiceMutedAll = $state(false);
  const uiVoiceMute = $state({}); // steamId → bool (per-player mute — card phase)

  // --- Replay audio (voice + guns + utility + C4) ---------------------------
  // The volume popover under the scrubber drives FOUR independent
  // faders: voice (the voice engine's master), guns, utility and C4 (the
  // sfx engine's three gain buckets — C4 carries the planted bomb's
  // beeps and its explosion). The levels persist in the kvstore
  // (voice_volume / guns_volume / utility_volume / c4_volume — prefs.go;
  // frontend-only keys), read in load() and applied on every input; the
  // VOICE mute is uiVoiceMutedAll (engine-owned, cards consume it) while
  // the guns/utility/C4 mutes are session-only on the sfx engine. sfx
  // itself is null until startEngine proves the sounds manifest is
  // non-empty.
  let uiVoiceVol = $state(AUDIO_VOL_DEFAULT);
  let uiGunsVol = $state(AUDIO_VOL_DEFAULT);
  let uiUtilVol = $state(AUDIO_VOL_DEFAULT);
  let uiC4Vol = $state(AUDIO_VOL_DEFAULT);
  let uiGunsMuted = $state(false);
  let uiUtilMuted = $state(false);
  let uiC4Muted = $state(false);
  let sfx = null;
  let sfxErr = $state('');
  // The volume popover: one Popover anchored to the unmute-codicon
  // button, exactly like the loop control below.
  let volOpen = $state(false);
  let volAnchor = $state(null);

  // --- Player-card phase (spec 19–22, 26) -----------------------------------
  // State stream (handoff B): null until load() proves the match carries
  // one. An absent stream keeps it null — the cards render their "no
  // state" placeholders silently, exactly like a match that never had a
  // stream (no note, no nag).
  let stateIndex = $state(null);
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
  // button): the category dropdown, the game-events name picker, the
  // FilterBar scope, the saved-preset controls and Reset all show/hide
  // TOGETHER — none of it is piled in the open. Export is not a filter
  // and stays in the toolbar row above the panel.
  let filtersOpen = $state(false);
  let exportEl = $state(null); // the export <details> — menu close target
  // Category multi-select: the ONE dropdown in the filter panel (its
  // trigger is the Popover anchor, like the loop control below).
  let catsOpen = $state(false);
  let catsAnchor = $state(null);
  // Loop popover (spec 12): the from/to inputs + the loop toggle live in
  // one Popover anchored to the loop-codicon button.
  let loopOpen = $state(false);
  let loopAnchor = $state(null);
  // Speed + camera popovers: the SAME floating-popover pattern as the
  // loop control — the native <select>s read as foreign objects among
  // the icon buttons, so both became a trigger button + Popover with the
  // option buttons inside (they call the very same onSpeed / onCamMode
  // handlers the selects did).
  let speedOpen = $state(false);
  let speedAnchor = $state(null);
  let camOpen = $state(false);
  let camAnchor = $state(null);
  // The drop-layer popover (between the camera selector and the volume):
  // the SAME .rp-pop-host / Popover / .rp-pop pattern as the camera pop,
  // but MULTI-select — checkboxes over exactly Guns / Utility (the
  // Categories .lm-cat-item checkbox rows are the row reference).
  // dropGuns/dropUtil gate renderer.setDropLayers; BOTH are OFF by
  // default (an unset pref = the feature is invisible), persisted in one
  // kvstore pref (drop_layers — a comma list, the frontend-owned
  // camera_mode pattern).
  let dropsOpen = $state(false);
  let dropsAnchor = $state(null);
  let dropGuns = $state(false);
  let dropUtil = $state(false);
  const DROP_LAYERS = [
    { key: 'guns', label: 'Guns' },
    { key: 'util', label: 'Utility' },
  ];
  const dropLayerCount = $derived((dropGuns ? 1 : 0) + (dropUtil ? 1 : 0));

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
  // Decoded per-layer images (multi-floor packs), parallel to
  // meta.layers — []/null for a single-layer pack (setPack falls back
  // to radarImg for panel 0). Plain let, like radarImg: only the
  // renderer reads it.
  let layerImgs = null;

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

  // Loop bounds are typed as TIME, not frames: the popover's inputs and
  // the renderer's `loop:` readout both speak OVERALL MATCH TIME — fmt.js
  // fmtClock over tickSeconds measured from the stream's first tick, the
  // SAME basis as scrubTime above (a "1:00" here is the minute the
  // scrubber shows "1:00"). The engine keeps FRAMES (uiLoopFrom/uiLoopTo
  // stay the mirror of engine.state.loopFrom/loopTo — the clip recorder
  // and the wrap logic consume those); these two derive the DISPLAYED
  // strings from that mirror, so any engine-side change (toggleLoop's
  // default interval, a setLoop from elsewhere) re-renders them.
  const loopClockOf = (frame) => {
    if (!data || !data.frames || !data.ticks || frame < 0) return '';
    const t0 = data.ticks[0];
    const i = Math.min(Math.max(0, frame), data.frames - 1);
    return fmtClock(tickSeconds(data.ticks[i] - t0, normTickRate(meta?.tickRate)));
  };
  const loopFromText = $derived(loopClockOf(uiLoopFrom));
  const loopToText = $derived(loopClockOf(uiLoopTo));

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
  // Connection rows (player_connect / player_disconnect), fetched once
  // per match beside drawRows: the roster keeps a slot for a player who
  // disconnects mid-demo AND for a bot that joins late, so without them
  // the columns grow a phantom card (the nuke demo's sixth CT) — and for
  // a BOT these rows are the only evidence that it is covering a
  // disconnected human (playercard.js presentAt). Fail-soft like
  // drawRows: any failure lands [] and every HUMAN card stays visible;
  // a bot card then stays hidden, because the replay exception needs
  // positive evidence (bots fail toward NOT listed).
  let connRows = $state([]);
  const connIndex = $derived(indexConnections(connRows));
  // Flash-white overlay rows {slot, tick, ms} — the blind events joined
  // with their narrow flash-duration read in load() (plain let: only
  // startEngine reads it, no rendering depends on it). Empty = no
  // overlay; any fetch failure lands here as [].
  let blindRows = [];
  // In-game chat lines for the canvas readout (fetch: round -1 = ALL
  // rounds; the renderer scopes them per round at the playhead). Plain
  // let like blindRows: only startEngine reads it — empty = no chat,
  // any fetch failure lands here as [] (fail-soft, never a load error).
  let chatLines = [];
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
  // the ?roundFrom/?roundTo scoping — it never overrides them; Settings
  // writes the key directly and there is no cross-view change event, so
  // the view re-reads it on mount (returning to Replay remounts it).
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
  // ?roundFrom=-2&roundTo=-1 while the pref hides knife/warmup rounds
  // matches nothing) — the empty state says so instead of the generic
  // "no events" line. Only a scope whose KNOWN rounds are all hidden is
  // blamed on the pref: a range that reaches a counted round, or names
  // rounds the lookup does not know, is never the explanation (defensive,
  // never invented — the same convention as normalizeEvent).
  const prefHidesScope = $derived.by(() => {
    if (showKnifeWarmup) return false;
    const { roundFrom, roundTo } = filter;
    if (roundFrom === 0 && roundTo === 0) return false;
    const inScope = [];
    for (const r of rbn.values()) {
      if (roundFrom !== 0 && r.number < roundFrom) continue;
      if (roundTo !== 0 && r.number > roundTo) continue;
      inScope.push(r);
    }
    return inScope.length > 0 && inScope.every((r) => !isCounted(r));
  });

  // The chat and generic sources read ONE exact round (their Go
  // signatures — MatchService.GetChat / LibraryService.GetGenericEvents —
  // are unchanged), so they scope when the range names exactly one round
  // and stay match-wide for any wider range; the typed events carry the
  // inclusive range (fetchTyped below).
  const srcRound = (f) => (f.roundFrom !== 0 && f.roundFrom === f.roundTo ? f.roundFrom : -1);

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
        getChat(id, srcRound(f), f.steamId)
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
      roundFrom: f.roundFrom,
      roundTo: f.roundTo,
      steamId: f.steamId,
      weapon: f.weapon,
      // The filter's distMin/distMax map onto the Go EventFilter's
      // distanceMin/distanceMax JSON fields (models.EventFilter).
      distanceMin: f.distMin,
      distanceMax: f.distMax,
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
    return getGenericEvents(id, name, srcRound(f), PAGE + 1, offset)
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
  // the round-range scoping above it are untouched (applyRoundPref).
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
  // load() and handed to the renderer — the category selection never
  // rebuilds the world layers.
  const drawNorm = $derived(drawRows.map((r) => normalizeEvent(r, {})).filter(Boolean));

  // Scrubber markers: the draw feed gated by the ACTIVE category set +
  // round/player scope (the scrubber mirrors the feed's overview;
  // weapon/distance filters are list concerns and do not move
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
      if (filter.roundFrom !== 0 && l.round < filter.roundFrom) continue;
      if (filter.roundTo !== 0 && l.round > filter.roundTo) continue;
      if (filter.steamId && l.steamId !== filter.steamId) continue;
      // The ONE bucket → marker mapping (landmarks.scrubberMarkerClass —
      // the contract src/lib/landmarks.test.js pins): the typed grenade
      // buckets (smoke/fire/flash/he) count as 'det' alongside
      // explode/detonation; drop/pickup/damage and 'land' (a grenade
      // ACTIVATION — its explosion carries the det marker) carry no
      // marker ('').
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
  // / no usable round scope): load() resolves it once, AWAITING the
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
  // context (tick/loop/back/follow) + write the hash. sel is entry-only — it is not
  // re-pinned on later filter changes (selection stays local).
  // keepFollow=false drops the follow param (the chip's dismiss — see
  // releaseFollow), so a preserved entry context cannot re-arm it.
  // keepLoop=false drops the loop param instead (the range-edit rule —
  // see onLoopTime): after the user edits a bound the URL must mirror
  // the ENGINE's loop, never resurrect the pre-edit entry range.
  function navigateFilter(next, { keepFollow = true, keepLoop = true } = {}) {
    const q = serializeLandmarkFilter(next);
    if (query.tick) q.tick = query.tick;
    if (keepLoop && query.loop) q.loop = query.loop;
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
  // scope filter (round range/player/weapon/bbox/distance window) — a
  // scoped link should show the scope it arrived with. In-session changes
  // never force it open (the Filters button owns that). The feed opens
  // WITH it: the panel lives inside the expanded rail, so a collapsed
  // feed would hide the very scope the link promises to show.
  function syncFiltersOpen(f) {
    if (f.roundFrom || f.roundTo || f.steamId || f.weapon || f.bbox || f.distMin || f.distMax) {
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
  // it from setLandmarks and applies bomb.js bombEndTick there — the
  // same terminators as the death markers (round_end, plus the next
  // round's round_start — the killEndTick fix) — so no rule is ever
  // duplicated here.
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
  //
  // cardGroups is the UNFILTERED grouping — team identity (the column's
  // side) and the team-mute's steam-id list are team facts that must not
  // change when someone disconnects (see teamSteamIds below). A player
  // out of the match at the playhead is dropped one step LATER, in
  // cardColumns, so only the CARD goes away.
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

  // playerConnected(slot, tick) — the ONE card-presence question: is
  // this roster slot's player IN the match at `tick`? Delegated entirely
  // to playercard.js presentAt — humans run connectedAt's rule, a BOT
  // slot runs the replay exception (a bot is listed only while it covers
  // a disconnected same-side human, so a missing/empty read hides it —
  // bots fail toward NOT listed, humans never do). A human slot with no
  // steam id, no roster row or no rows stays visible. Reads uiTick
  // through the caller, so scrubbing back before a disconnect re-shows
  // the card and scrubbing forward hides it again.
  function playerConnected(slot, tick) {
    return presentAt(connIndex, players, slot, tick);
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

  // decoyPlanFor — THE one decoy-plan derivation (lib/replay/decoy.js):
  // the drawable rows (drawNorm — same source the renderer's landmark
  // layers and the sfx cues get) + rounds + the state stream → the
  // decoy's rest-to-explosion rows ({landTick, detTick, x, y, side,
  // weapon, shots}) that BOTH the renderer (rest icon + noise pulses)
  // and the sfx engine (the same shots as fake gunshots) consume — the
  // bullets.js one-derivation-two-consumers pattern, pushed at the same
  // three sites deriveBullets is.
  //   - resolveFrame: the ENGINE's frame search (engine exists by the
  //     startEngine pushes; the load-time push has none → null → the
  //     plan carries no shots, never a guessed weapon — startEngine
  //     re-pushes the real one);
  //   - sideAt: sideAtTick's frame bits, then the final-side table — the
  //     SAME fallback the renderer's throwerSideAt/sideAtFrame applies
  //     (sideFromFlags(bits, finalSide)), so the icon tint and the
  //     flight tint can never disagree.
  function decoyPlanFor() {
    return buildDecoyPlan(drawNorm, rounds, {
      stateIndex,
      resolveFrame: engine ? (t) => engine.frameForTick(Math.max(engine.firstTick, t)) : null,
      sideAt: (steamId, tick) => {
        const bits = sideAtTick(steamId, tick);
        if (bits) return bits;
        const id = String(steamId || '');
        const p = players.find((q) => q && q.steamId != null && String(q.steamId) === id);
        return (p && p.side) || '';
      },
      players,
      tickRate: meta?.tickRate,
    });
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
  // Deliberately over the UNFILTERED cardGroups: muting a team is a
  // durable voice setting, so a player who is out of the match at this
  // playhead still gets the flag — otherwise a reconnect would land on a
  // card that reads `muted` while the engine never heard of it (the
  // exact disagreement this list exists to prevent).
  function teamSteamIds(col) {
    return (col === 'left' ? cardGroups.left : cardGroups.right)
      .map((s) => (players[s] && players[s].steamId != null ? String(players[s].steamId) : ''))
      .filter((x) => x);
  }

  // The card prop arrays — ONE derived that reads the playhead (uiFrame
  // / uiTick): every per-frame value (state, reload ring, alive/dead,
  // follow, speaking, muted) recomputes here, while stable refs (the
  // roster object itself, the icon maps, the memoized mute handlers) keep
  // prop churn to the values that actually changed — Svelte then writes
  // only the text/classes that differ. A player who is OUT of the match
  // at this playhead (disconnected, not yet connected) contributes NO
  // card: the slot is filtered before the props are built, so
  // TeamColumn's keyed each-block simply renders one card fewer (and one
  // more on a reconnect) — no placeholder card, no unmounted-then-
  // remounted row.
  const cardColumns = $derived.by(() => {
    const frame = uiFrame;
    const tick = uiTick;
    const build = (slots, col) =>
      slots
        .filter((slot) => playerConnected(slot, tick))
        .map((slot) => {
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
            // The gun icon's reload ring: 0..1 fill, or null (no state
            // stream / not reloading / unknown) which hides it. The
            // formula — run start, look-ahead end, clamp — lives in
            // playercard.js; here we only fetch the slot's series.
            reloadProgress: stateIndex
              ? reloadProgress(stateIndex.slots[slot]?.reloading, frame)
              : null,
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
  // The camera popover's option list — the old <select>'s three entries
  // (labels included; the trigger button renders the ACTIVE one).
  const CAM_MODES = [
    { value: 'smart', label: 'Smart' },
    { value: 'free', label: 'Free' },
    { value: 'follow', label: 'Follow' },
  ];
  const camLabel = $derived(
    (CAM_MODES.find((m) => m.value === camMode) || CAM_MODES[0]).label,
  );

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

  // Pref `drop_layers` (frontend-owned kvstore, the camera_mode pattern):
  // a comma list of the ON layers ("guns", "util", "guns,util"); unset /
  // unreadable / unknown tokens → both OFF (the default — the drop layer
  // is opt-in). Applied once on entry like camera_mode; the renderer may
  // not exist yet (startEngine pushes the current state too).
  $effect(() => {
    let live = true;
    getPref('drop_layers')
      .then((v) => {
        if (!live) return;
        const on = String(v || '').split(',').filter(Boolean);
        dropGuns = on.includes('guns');
        dropUtil = on.includes('util');
        renderer?.setDropLayers({ guns: dropGuns, util: dropUtil });
      })
      .catch(() => {
        /* unreadable store → both off */
      });
    return () => (live = false);
  });

  // toggleDropLayer — one checkbox of the multi-select: flip the layer,
  // push it to the renderer (pure visibility — the rows stay loaded) and
  // persist the durable pair (the pref is the whole toggle state, so a
  // reload restores exactly this).
  function toggleDropLayer(key) {
    if (key === 'guns') dropGuns = !dropGuns;
    else dropUtil = !dropUtil;
    renderer?.setDropLayers({ guns: dropGuns, util: dropUtil });
    const on = [];
    if (dropGuns) on.push('guns');
    if (dropUtil) on.push('util');
    setPref('drop_layers', on.join(',')).catch(() => {});
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
    if (sfx) sfx.destroy();
    sfx = null;
    uiVoiceOn = false;
    uiVoiceErr = '';
    uiVoiceMutedAll = false; // the new engine starts unmuted
    uiGunsMuted = false; // …including the sfx bucket mutes (session-only)
    uiUtilMuted = false;
    sfxErr = '';
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
    if (!map) return { pack: null, transform: null, img: null, layerImgs: null };
    // Shared loader: extracted pack (local CS2) wins over the bundled
    // metadata-only fallback at /maps/ (no art ships — see
    // frontend/public/maps/README.md; a missing pack = plain grid).
    // The makeTransform() output rides along — the renderer consumes it
    // instead of re-deriving the pack's transform fields.
    const p = await loadMapPack(map);
    if (!p || !p.meta) return { pack: null, transform: null, img: null, layerImgs: null };
    // One image per radar file: every meta.layers[i].file for a
    // multi-floor pack (side-by-side panels), else the single
    // meta.radar.file (today's one image). A file that fails to decode
    // resolves to null — the renderer skips that panel's pixels (the
    // grid shows through), never an error.
    const files = [];
    if (Array.isArray(p.meta.layers) && p.meta.layers.length) {
      for (const l of p.meta.layers) if (l && l.file) files.push(l.file);
    } else if (p.meta.radar && p.meta.radar.file) {
      files.push(p.meta.radar.file);
    }
    const imgs = await Promise.all(
      files.map(async (file) => {
        const im = new Image();
        im.src = `${p.base}/${file}`;
        try {
          await im.decode();
          return im;
        } catch {
          return null;
        }
      }),
    );
    return {
      pack: p.meta,
      transform: p.transform,
      img: imgs.length ? imgs[0] : null,
      layerImgs: imgs,
    };
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
      const [match, rs, tn] = await Promise.all([
        getMatch(id).catch(() => null),
        getRounds(id).catch(() => []),
        getTeamNames(id).catch(() => null), // round ribbon team labels
      ]);
      matchMap = (match && match.map) || '';
      sideSwitches = (match && match.sideSwitches) || 0;
      teamNames = tn || null;
      rounds = rs || [];
      // Player-state stream (handoff B): loadState re-reads meta.json
      // itself (the canonical one-stop loader — never forked here) and
      // fails soft to null for every absence mode (no meta.json, a 404
      // on /state, a transport error), so a match without the stream
      // renders exactly like one that never had it: the cards show their
      // "no state" placeholders with no note. A corrupt stream is loud
      // in the parser, never rendered as garbage.
      stateIndex = await loadState(id).catch(() => null);
      renderer?.setStateIndex(stateIndex); // normally pre-engine: startEngine pushes it
      // Tracer rows + gun-cue rows for the same state stream (both
      // mirrors of the setStateIndex push — same null-guard): ONE
      // derivation, both consumers. `data` may not be parsed yet on a
      // fresh load (deriveBullets fails soft to [] without ticks);
      // startEngine pushes the real rows once data is in.
      renderer?.setBullets(
        deriveBullets(stateIndex, { ticks: data?.ticks, rounds, tickRate: meta?.tickRate }),
      );
      sfx?.setBullets(
        deriveBullets(stateIndex, { ticks: data?.ticks, rounds, tickRate: meta?.tickRate }),
      );
      // Decoy plan: same guard/push shape as the bullets above (the
      // rows may not be fetched yet — startEngine re-pushes the real
      // plan once drawRows/data are in; a null engine here means no
      // resolveFrame → shots: [], never a guessed weapon).
      renderer?.setDecoyPlan(decoyPlanFor());
      sfx?.setDecoyPlan(decoyPlanFor());
      sfx?.setRounds(rounds); // freeze gate for the util/knife cue lists
      // Voice presence gates the controls block; players ride alongside.
      voicePresence = await getVoicePresence(id).catch(() => null);
      if (voicePresence && voicePresence.hasVoice) {
        voicePlayers = (await getVoicePlayers(id).catch(() => [])) || [];
      } else {
        voicePlayers = [];
      }
      const { pack: p, transform: tf, img, layerImgs: lims } = await loadPack(matchMap);
      pack = p;
      packTf = tf;
      radarImg = img;
      layerImgs = lims;
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
      // The drawable anchor set (kills/grenades/bomb/drops/round_end) —
      // one unfiltered source read, awaited before the engine starts so
      // the world layers and scrubber markers are ready on first paint.
      // The death-drop payload projection (getDropDetails — cat + the
      // gun's mag/reserve, joined by seq: models.EventRow stays
      // payload-free) rides the SAME await, and every weapon_drop row
      // that matches gets dropCat/dropAmmo stamped on it BEFORE
      // normalization — the renderer's layer gate reads those, never a
      // re-derived classification. Fail-soft like drawRows (a failed
      // side channel → no stamps → drawDrops draws nothing).
      {
        const [rows, dropDetails] = await Promise.all([
          getEvents({
            matchId: id,
            kinds: DRAW_KINDS,
            offset: 0,
            limit: 0,
          }).catch(() => []),
          getDropDetails(id).catch(() => []),
        ]);
        const dropsBySeq = new Map((dropDetails || []).map((d) => [d.seq, d]));
        drawRows = (rows || []).map((r) => {
          const d = dropsBySeq.get(r.seq);
          return d ? { ...r, dropCat: d.cat, dropAmmo: { mag: d.mag, reserve: d.reserve } } : r;
        });
      }
      // Connection events for the card-visibility rule (the SAME narrow
      // read shape as the blind rows below): one pass over the match's
      // player_connect / player_disconnect rows — EventRow.attacker is
      // the roster's steamId spelling, so indexConnections keys it
      // straight onto meta.players. Fetched BEFORE the engine starts so
      // the columns never paint a phantom card on first paint; fail-soft
      // like drawRows (any failure → [] → every card visible).
      connRows =
        (await getEvents({
          matchId: id,
          kinds: ['player_connect', 'player_disconnect'],
          offset: 0,
          limit: 0,
        }).catch(() => [])) || [];
      // The DEFAULT entry tick (no explicit ?tick= / round scope): resolve
      // it here with an awaited getPref — the showKnifeWarmup $effect
      // reads the same key asynchronously and could land AFTER startEngine
      // applies the entry seek, which would start the replay on the
      // wrong side of the knife/warmup-hiding pref.
      entryDefaultTick = defaultEntryTick(
        await getPref('show_knife_warmup_rounds')
          .then((v) => v === true)
          .catch(() => false), // unreadable store → hidden (the default)
      );
      // Replay-audio faders: the four persisted levels (voice/guns/
      // utility/C4) are read here — before startEngine applies them to
      // the voice master and (once the sounds manifest proves non-empty)
      // the sfx engine. One Promise.all, fail-soft to the 0.8 default
      // like every other pref read in load().
      {
        const [vv, gv, uv, cv] = await Promise.all([
          getPref('voice_volume').catch(() => null),
          getPref('guns_volume').catch(() => null),
          getPref('utility_volume').catch(() => null),
          getPref('c4_volume').catch(() => null),
        ]);
        uiVoiceVol = prefVolume(vv);
        uiGunsVol = prefVolume(gv);
        uiUtilVol = prefVolume(uv);
        uiC4Vol = prefVolume(cv);
      }
      // Flash-white overlay: the blind events joined with their narrow
      // flash-duration read — the duration lives on detail_json
      // (EventRow stays payload-free, so it needs its own query; the
      // same side-channel rule as store.GetBlindFlashDetails). Fail-soft
      // by contract: any failure just leaves the overlay off, and rows
      // whose victim resolves to no slot, or whose duration is not
      // positive, are dropped here.
      try {
        const [blinds, durs] = await Promise.all([
          getEvents({ matchId: id, kinds: ['blind'], offset: 0, limit: 0 }),
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
      // In-game chat for the canvas readout (drawChat): ALL rounds —
      // round -1, the same match-wide read the landmark feed's chat
      // source uses — fetched raw ({tick, round, steamId, name, text};
      // the renderer resolves each speaker's side itself). Fail-soft by
      // contract like the blind overlay: any failure just leaves the
      // chat off, never a load error.
      try {
        chatLines = (await getChat(id, -1, '')) || [];
      } catch {
        chatLines = [];
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
    renderer.setPack(pack, radarImg, packTf, layerImgs);
    renderer.setLandmarks(drawNorm);
    renderer.setBlinds(blindRows); // flash-white overlay rows from load()
    renderer.setChat(chatLines); // raw chat rows from load() (round -1)
    // Player-card phase inputs (handoff E): push whatever load() already
    // has alongside pack/landmarks — icons and the voice lanes (the
    // SPEAKING half of setVoices; the colors are the player colors, ready
    // with the meta) may still arrive later and re-push at their
    // assignment sites; every one of these setters is additive and
    // tolerates a repeat call.
    renderer.setIcons(iconObj);
    renderer.setVoices({ colors: playerColorSlots, speaking: speakIdx ? speakingFor : null });
    renderer.setStateIndex(stateIndex);
    // Tracer rows: the ONE bullet derivation (lib/replay/bullets.js —
    // gun-only, freeze-filtered, `draw` picks the lines) over the
    // position ticks + rounds already loaded. deriveBullets(null, …)
    // yields [] — always push, so a match without a state stream clears
    // any rows from a previous push. The sfx engine gets the SAME rows.
    renderer.setBullets(
      deriveBullets(stateIndex, { ticks: data.ticks, rounds, tickRate: meta?.tickRate }),
    );
    // Decoy plan: the SAME derivation for both consumers (the renderer's
    // rest icon + noise pulses, the sfx engine's fake gunshots) — the
    // engine exists now, so resolveFrame resolves and the schedule is
    // generated. Always push: like deriveBullets(null, …) → [], a match
    // without decoys/state clears any rows from a previous push.
    renderer.setDecoyPlan(decoyPlanFor());
    renderer.resize();
    renderer.setCameraMode(rendererCam()); // default 'smart' unless the pref says free
    // Drop-layer visibility (both off unless the pref said otherwise —
    // the pref effect may have run before the renderer existed, so the
    // CURRENT state is pushed here like every other setter).
    renderer.setDropLayers({ guns: dropGuns, util: dropUtil });
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
    // M4: voice is ON BY DEFAULT (spec 11). setEnabled(true) starts it
    // by itself — where the platform allows it immediately, otherwise
    // silently on the first interaction (audio.js's retry listeners);
    // there is no gesture hint. hearTick re-arms the same call from the
    // landmark detail.
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
          uiVoiceMutedAll = s.mutedAll;
        },
      });
      voiceEngine.setPlayers(voicePlayers);
      voiceEngine.setMasterVolume(uiVoiceVol); // the popover's Voice fader
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
    // Sound effects (guns + utility + C4 — the sound half of the
    // replay): the manifest read is MEMOIZED (one fetch per page load;
    // load() ran it first), and an EMPTY manifest — sounds never
    // extracted — skips creation entirely: no AudioContext, no retry
    // listener, silent cues. The engine then takes the same inputs the
    // renderer gets (drawNorm, the bullets.js rows + the rounds freeze
    // gate) and the popover's persisted fader levels. Construction is
    // deferred to the microtask, so the entry seek below has already
    // happened and the engine's first change seeds instead of replaying
    // it.
    const startedEngine = engine;
    loadSoundManifest().then((sm) => {
      if (!live || engine !== startedEngine || sfx || !sm || !sm.count) return;
      sfx = createSfxEngine({
        engine: startedEngine,
        matchId: id,
        onError: (msg) => {
          sfxErr = msg;
        },
      });
      sfx.setRounds(rounds); // freeze gate for the util/knife cue lists
      sfx.setLandmarks(drawNorm); // rebuilds them under it
      // Gun cues: bullets.js' ONE derivation of the state stream (the
      // renderer's tracers read the same rows) — guns-only and
      // freeze-filtered upstream, so the sound engine just plays them.
      sfx.setBullets(
        deriveBullets(stateIndex, { ticks: data.ticks, rounds, tickRate: meta?.tickRate }),
      );
      // Decoy plan — the SAME rows the renderer just got: one
      // derivation, both consumers (a pulse and its gunshot can never
      // disagree).
      sfx.setDecoyPlan(decoyPlanFor());
      sfx.setVolume(uiGunsVol);
      sfx.setUtilityVolume(uiUtilVol);
      sfx.setC4Volume(uiC4Vol);
      sfx.setMuted('guns', uiGunsMuted);
      sfx.setMuted('utility', uiUtilMuted);
      sfx.setMuted('c4', uiC4Muted);
    });
    // Entry position rides the URL — durable and deep-linkable.
    // entrySeekTick is the ONE resolver: an exact ?tick= wins, else the
    // round scope (?roundFrom=, else ?roundTo=) resolves to that round's
    // START tick (a round link is a link to a point in time — never the
    // first frame); it returns null when the URL made NO time promise,
    // and then the pref-decided default (load() awaited the knife/warmup
    // pref: first counted round's start while it hides them, frame 0
    // while it shows them) applies; a ?sel= landmark that resolved before
    // the engine was up applies in between. Applied once here, after
    // loading — in-session filter changes keep the playback position.
    const tick0 = entrySeekTick(query, rounds);
    if (tick0 != null) engine.seekTick(tick0);
    else if (entrySelTick) engine.seekTick(entrySelTick);
    else if (entryDefaultTick) engine.seekTick(entryDefaultTick);
    // Entry loop — the URL's SECOND entry promise (nav.entryLoopRange;
    // the seek above is the first): bounds first, then arm (setLoop
    // never enables, setLoopEnabled never arms an invalid range).
    // Applied ONCE here, right after the seek: startEngine runs once per
    // mount, so in-session query churn can neither re-apply nor cancel a
    // loop — and the range-edit rule (onLoopTime) owns every later
    // change, stripping ?loop= from the URL as it goes.
    const loop0 = entryLoopRange(query, rounds);
    if (loop0) {
      engine.setLoop(engine.frameForTick(loop0.from), engine.frameForTick(loop0.to));
      engine.setLoopEnabled(true);
    }
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

  // onLoopTime resolves a typed TIME to a frame: parseClock (fmt.js —
  // the inverse of the displayed fmtClock, same grammar), clamp the
  // seconds to the match range (0 → the stream's last tick), then the
  // engine's exact-frame binary search (frameForTick) lands on the first
  // frame at/after that instant, clamped to the stream. An empty field
  // CLEARS the bound (−1 — the engine's "unset"); anything unparseable
  // restores the displayed value instead, so no state changes and the
  // field snaps back to what it showed rather than a NaN reaching the
  // loop.
  //
  // RANGE-EDIT RULE: an edit that actually CHANGES a bound turns the
  // loop OFF — the user is defining a NEW range and gets one click to
  // start it (the Loop toggle), not stop-then-start. Hooked ONLY on
  // this handler's two success paths (clear + parsed commit): a parse
  // failure changes nothing and must not flip, and an $effect over the
  // bounds would also fire on the mount-time ?loop= apply (startEngine
  // below) and cancel it — the EDIT is the trigger, so it lives in the
  // handler. The entry ?loop= is dropped from the URL with it (URL ≈
  // engine state): a refresh after an edit must not resurrect the
  // pre-edit range.
  function loopBoundEdited(changed) {
    if (!changed) return;
    // setLoop (onLoopInput) may already have disabled it — clearing a
    // bound makes the interval invalid — so this is a guarded no-op
    // then, and never toggleLoop's enable-while-off trap.
    engine?.setLoopEnabled(false);
    // Only URLs that carry the promise rewrite it; a session without
    // ?loop= keeps its hash byte-identical (sel/tick/back untouched).
    if (query.loop) navigateFilter(filter, { keepLoop: false });
  }

  function onLoopTime(which, e) {
    const input = e.currentTarget;
    const shown = which === 'from' ? loopFromText : loopToText;
    const raw = String(input.value ?? '').trim();
    const prev = which === 'from' ? uiLoopFrom : uiLoopTo;
    if (raw === '') {
      const changed = prev !== -1; // clearing an already-empty bound changes nothing
      if (which === 'from') uiLoopFrom = -1;
      else uiLoopTo = -1;
      onLoopInput();
      loopBoundEdited(changed);
      return;
    }
    const sec = parseClock(raw);
    const tr = normTickRate(meta?.tickRate); // the same basis loopClockOf displays
    if (Number.isNaN(sec) || !data || !data.frames || !data.ticks || !engine) {
      input.value = shown;
      return;
    }
    const t0 = data.ticks[0];
    const total = tickSeconds(data.ticks[data.frames - 1] - t0, tr);
    const at = t0 + Math.min(Math.max(0, sec), total) * tr;
    const frame = Math.min(engine.frameForTick(at), data.frames - 1);
    const changed = frame !== prev;
    if (which === 'from') uiLoopFrom = frame;
    else uiLoopTo = frame;
    onLoopInput();
    loopBoundEdited(changed);
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

  // Mute all (spec 18) — now the VOICE row's mute inside the volume
  // popover. The engine owns the flag — setMutedAll emits and the
  // onStateChange mirror updates uiVoiceMutedAll (aria-pressed/styling),
  // so the control and the engine can never disagree. No voice in this
  // match → the row's controls are disabled (voiceEngine stays null,
  // no-op); the guns/utility/C4 rows keep working either way.
  function toggleVoiceMuteAll() {
    voiceEngine?.setMutedAll(!uiVoiceMutedAll);
  }

  // Volume popover faders: `input` applies live (the engine gains follow
  // immediately), `change` persists the level to the kvstore key the
  // Settings tab reads back — one key per category, shared default.
  const VOL_KEYS = {
    voice: 'voice_volume',
    guns: 'guns_volume',
    utility: 'utility_volume',
    c4: 'c4_volume',
  };

  function onVolInput(bucket, e) {
    const v = Math.max(0, Math.min(1, Number(e.currentTarget.value) / 100));
    if (bucket === 'voice') {
      uiVoiceVol = v;
      voiceEngine?.setMasterVolume(v);
    } else if (bucket === 'guns') {
      uiGunsVol = v;
      sfx?.setVolume(v);
    } else if (bucket === 'c4') {
      // Explicit, never the fall-through: the C4 fader owns its own
      // bus (beeps + explosion) — routing it to utility would move the
      // wrong gain.
      uiC4Vol = v;
      sfx?.setC4Volume(v);
    } else {
      uiUtilVol = v;
      sfx?.setUtilityVolume(v);
    }
  }

  function onVolChange(bucket) {
    const level =
      bucket === 'voice'
        ? uiVoiceVol
        : bucket === 'guns'
          ? uiGunsVol
          : bucket === 'c4'
            ? uiC4Vol
            : uiUtilVol;
    setPref(VOL_KEYS[bucket], level).catch((e) => (sfxErr = errText(e)));
  }

  // Guns/utility/C4 mutes are session-only (unlike the faders): they
  // live on the sfx engine and reset with it.
  function toggleGunsMute() {
    uiGunsMuted = !uiGunsMuted;
    sfx?.setMuted('guns', uiGunsMuted);
  }

  function toggleUtilMute() {
    uiUtilMuted = !uiUtilMuted;
    sfx?.setMuted('utility', uiUtilMuted);
  }

  function toggleC4Mute() {
    uiC4Muted = !uiC4Muted;
    sfx?.setMuted('c4', uiC4Muted);
  }

  // The trigger reads "warn" only when EVERY audible category is muted —
  // without voice in the match the audible set is guns + utility + C4.
  const audioAllMuted = $derived(
    (!voicePresence || !voicePresence.hasVoice || uiVoiceMutedAll) &&
      uiGunsMuted &&
      uiUtilMuted &&
      uiC4Muted,
  );
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
          <!-- Speed: the transport ladder as a floating popover (the
               same pattern as the loop control below — a native
               <select> read as a foreign object among the icon
               buttons). The option button carries `value`, so the SAME
               onSpeed handler the select used runs unchanged; the
               trigger shows the current step in the select's own
               "1×" label format. -->
          <span class="rp-pop-host" id="rp-speed" bind:this={speedAnchor}>
            <button
              class="btn"
              aria-label={`Speed ${uiSpeed}×`}
              title="Playback speed"
              aria-expanded={speedOpen}
              onclick={() => (speedOpen = !speedOpen)}>{uiSpeed}×</button
            >
            <Popover open={speedOpen} anchor={speedAnchor} onClose={() => (speedOpen = false)}>
              <div class="rp-pop rp-speed-pop" role="group" aria-label="Playback speed">
                {#each SPEEDS as s (s)}
                  <button
                    class="btn small"
                    class:primary={uiSpeed === s}
                    value={s}
                    onclick={(e) => {
                      onSpeed(e);
                      speedOpen = false;
                    }}>{s}×</button
                  >
                {/each}
              </div>
            </Popover>
          </span>

          <!-- Loop (spec 12): the from/to TIME inputs + the toggle grouped
               in ONE popover behind a loop-like codicon (sync). Popover
               is the canonical dismissal component (Escape + outside
               click); the panel anchors ABOVE the button because the
               transport sits at the bottom of the column. The inputs are
               text and speak overall match time ("1:00"), not frames —
               onLoopTime parses them back (fmt.js parseClock). -->
          <span class="rp-loop rp-pop-host" bind:this={loopAnchor}>
            <button
              class="btn"
              class:warn={uiLoopOn}
              aria-pressed={uiLoopOn}
              aria-expanded={loopOpen}
              aria-label="Loop range"
              title="Loop range (L) — set the from/to times and toggle the loop"
              onclick={() => (loopOpen = !loopOpen)}
              ><span class="codicon codicon-sync" aria-hidden="true"></span></button
            >
            <Popover open={loopOpen} anchor={loopAnchor} onClose={() => (loopOpen = false)}>
              <div class="rp-pop rp-loop-pop loop-group" role="group" aria-label="Loop range">
                <label class="sr-only" for="rp-loop-from">Loop from time</label>
                <input
                  class="input mono loop-input"
                  id="rp-loop-from"
                  type="text"
                  placeholder="from"
                  value={loopFromText}
                  onchange={(e) => onLoopTime('from', e)}
                />
                <span class="muted">–</span>
                <label class="sr-only" for="rp-loop-to">Loop to time</label>
                <input
                  class="input mono loop-input"
                  id="rp-loop-to"
                  type="text"
                  placeholder="to"
                  value={loopToText}
                  onchange={(e) => onLoopTime('to', e)}
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

          <!-- Camera (spec 17): Smart/Free/Follow as a popover — the
               player list appears as a second (native) dropdown only
               while Follow is selected. The option button carries
               `value`, so the SAME onCamMode handler the select used
               runs unchanged (it persists the camera_mode pref for
               Smart/Free; Follow stays session state). -->
          <span class="rp-pop-host" id="rp-cam" bind:this={camAnchor}>
            <button
              class="btn"
              aria-label={`Camera mode: ${camLabel}`}
              aria-expanded={camOpen}
              title="Smart keeps every player and the bomb on screen with smooth pan/zoom (drag or wheel takes over → Free); Free is manual; Follow locks the camera onto a player (pick them below) — dragging releases it"
              onclick={() => (camOpen = !camOpen)}>{camLabel}</button
            >
            <Popover open={camOpen} anchor={camAnchor} onClose={() => (camOpen = false)}>
              <div class="rp-pop rp-cam-pop" role="group" aria-label="Camera mode">
                {#each CAM_MODES as m (m.value)}
                  <button
                    class="btn small"
                    class:primary={camMode === m.value}
                    value={m.value}
                    onclick={(e) => {
                      onCamMode(e);
                      camOpen = false;
                    }}>{m.label}</button
                  >
                {/each}
              </div>
            </Popover>
          </span>

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
                <!-- Only players IN the match at the playhead are followable —
                     a disconnected slot has no position for the camera to
                     track (the same filter the card columns apply). -->
                {#if playerConnected(i, uiTick)}
                  <option value={i}>{i + 1}. {p.name || `slot ${i}`}</option>
                {/if}
              {/each}
            </select>
          {/if}

          <!-- Drops (spec: dropped guns/util on the map): a MULTI-select
               popover between the camera selector and the volume — the
               camera pop's .rp-pop-host/.rp-pop family, but checkbox
               rows (the Categories .lm-cat-item rows are the reference)
               over exactly Guns / Utility. Both OFF by default (the
               unset drop_layers pref); each toggle persists the pref and
               pushes renderer.setDropLayers. The trigger shows the label
               + chevron and the live on-count. -->
          <span class="rp-pop-host" id="rp-drops" bind:this={dropsAnchor}>
            <button
              class="btn"
              aria-expanded={dropsOpen}
              aria-haspopup="true"
              aria-label="Drop markers"
              title="Show dropped guns and utility on the map (off by default)"
              onclick={() => (dropsOpen = !dropsOpen)}
            >
              Drops
              <span class="muted rp-drops-count">{dropLayerCount}</span>
              <span class="codicon codicon-chevron-down" aria-hidden="true"></span>
            </button>
            <Popover open={dropsOpen} anchor={dropsAnchor} onClose={() => (dropsOpen = false)}>
              <div class="rp-pop rp-drops-pop" role="group" aria-label="Drop markers">
                {#each DROP_LAYERS as l (l.key)}
                  <label class="rp-drop-item" title={`Show dropped ${l.label.toLowerCase()} on the map`}>
                    <input
                      type="checkbox"
                      checked={l.key === 'guns' ? dropGuns : dropUtil}
                      onchange={() => toggleDropLayer(l.key)}
                    />
                    {l.label}
                  </label>
                {/each}
              </div>
            </Popover>
          </span>

          <!-- Volume (the old mute-all button, repurposed): ONE popover
               with the four replay-audio faders — Voice / Guns /
               Utility / C4 — anchored exactly like the loop control
               above. The trigger is NEVER disabled: voice is just one
               row of four (its row goes disabled when the match has no
               voice, while guns/utility/C4 always work). The engine
               owns the voice mute flag and mirrors it through
               onStateChange. -->
          <span class="rp-pop-host rp-vol" bind:this={volAnchor}>
            <button
              class="btn"
              class:warn={audioAllMuted}
              aria-expanded={volOpen}
              aria-label="Volume"
              title="Volume — voice, guns, utility and C4"
              onclick={() => (volOpen = !volOpen)}
              ><span class="codicon codicon-unmute" aria-hidden="true"></span></button
            >
            <Popover open={volOpen} anchor={volAnchor} onClose={() => (volOpen = false)}>
              <div class="rp-pop rp-vol-pop" role="group" aria-label="Volume">
                <div class="rp-vol-row">
                  <label class="field-label" for="rp-vol-voice">Voice</label>
                  <input
                    class="rp-vol-range"
                    id="rp-vol-voice"
                    type="range"
                    min="0"
                    max="100"
                    value={Math.round(uiVoiceVol * 100)}
                    disabled={!voicePresence || !voicePresence.hasVoice}
                    oninput={(e) => onVolInput('voice', e)}
                    onchange={() => onVolChange('voice')}
                    aria-label="Voice volume"
                  />
                  <button
                    class="btn small"
                    class:warn={uiVoiceMutedAll}
                    aria-pressed={uiVoiceMutedAll}
                    aria-label="Mute voice"
                    title={uiVoiceMutedAll ? 'Unmute voice' : 'Mute voice'}
                    disabled={!voicePresence || !voicePresence.hasVoice}
                    onclick={toggleVoiceMuteAll}
                    ><span class="codicon {uiVoiceMutedAll ? 'codicon-mute' : 'codicon-unmute'}" aria-hidden="true"></span></button
                  >
                </div>
                <div class="rp-vol-row">
                  <label class="field-label" for="rp-vol-guns">Guns</label>
                  <input
                    class="rp-vol-range"
                    id="rp-vol-guns"
                    type="range"
                    min="0"
                    max="100"
                    value={Math.round(uiGunsVol * 100)}
                    oninput={(e) => onVolInput('guns', e)}
                    onchange={() => onVolChange('guns')}
                    aria-label="Guns volume"
                  />
                  <button
                    class="btn small"
                    class:warn={uiGunsMuted}
                    aria-pressed={uiGunsMuted}
                    aria-label="Mute guns"
                    title={uiGunsMuted ? 'Unmute guns' : 'Mute guns'}
                    onclick={toggleGunsMute}
                    ><span class="codicon {uiGunsMuted ? 'codicon-mute' : 'codicon-unmute'}" aria-hidden="true"></span></button
                  >
                </div>
                <div class="rp-vol-row">
                  <label class="field-label" for="rp-vol-utility">Utility</label>
                  <input
                    class="rp-vol-range"
                    id="rp-vol-utility"
                    type="range"
                    min="0"
                    max="100"
                    value={Math.round(uiUtilVol * 100)}
                    oninput={(e) => onVolInput('utility', e)}
                    onchange={() => onVolChange('utility')}
                    aria-label="Utility volume"
                  />
                  <button
                    class="btn small"
                    class:warn={uiUtilMuted}
                    aria-pressed={uiUtilMuted}
                    aria-label="Mute utility"
                    title={uiUtilMuted ? 'Unmute utility' : 'Mute utility'}
                    onclick={toggleUtilMute}
                    ><span class="codicon {uiUtilMuted ? 'codicon-mute' : 'codicon-unmute'}" aria-hidden="true"></span></button
                  >
                </div>
                <div class="rp-vol-row">
                  <label class="field-label" for="rp-vol-c4">C4</label>
                  <input
                    class="rp-vol-range"
                    id="rp-vol-c4"
                    type="range"
                    min="0"
                    max="100"
                    value={Math.round(uiC4Vol * 100)}
                    oninput={(e) => onVolInput('c4', e)}
                    onchange={() => onVolChange('c4')}
                    aria-label="C4 volume"
                  />
                  <button
                    class="btn small"
                    class:warn={uiC4Muted}
                    aria-pressed={uiC4Muted}
                    aria-label="Mute c4"
                    title={uiC4Muted ? 'Unmute C4' : 'Mute C4'}
                    onclick={toggleC4Mute}
                    ><span class="codicon {uiC4Muted ? 'codicon-mute' : 'codicon-unmute'}" aria-hidden="true"></span></button
                  >
                </div>
              </div>
            </Popover>
          </span>

          <span class="toolbar-sep" aria-hidden="true"></span>

          {#if uiVoiceErr}
            <span class="error rp-voice-hint" role="alert"
              >{uiVoiceErr} — install <span class="mono">gst-plugins-good</span> (GStreamer) if audio fails to start.</span
            >
          {:else if sfxErr}
            <!-- The sound-effect engine's own device failure (its message
                 already carries the GStreamer hint — no doubling). -->
            <span class="error rp-voice-hint" role="alert">{sfxErr}</span>
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
           surface below it — the category dropdown, name picker, scope
           bar and presets/Reset all show/hide TOGETHER (filtersOpen);
           export is not a filter and stays in this row. -->
      <div class="lm-toolbar" role="group" aria-label="Feed controls">
        <button
          class="btn small"
          class:primary={filtersOpen}
          aria-expanded={filtersOpen}
          onclick={() => (filtersOpen = !filtersOpen)}
          title="Show/hide the category dropdown and every filter control"
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
        <!-- The whole filter surface: the category multi-select →
             game-events name picker → scope bar → saved presets + Reset. -->
        <div class="lm-filter-panel">
          <!-- Categories: ONE dropdown whose panel is a checkbox list
               (multi-select) instead of a wall of pills. The sparse
               default (round starts) is what a fresh URL carries;
               everything else is opt-in. -->
          <span class="lm-cats" bind:this={catsAnchor}>
            <button
              class="btn small"
              aria-expanded={catsOpen}
              aria-haspopup="true"
              title="Choose which event categories the feed shows"
              onclick={() => (catsOpen = !catsOpen)}
            >
              Categories
              <span class="muted lm-filter-count">{filter.cats.length}</span>
              <span class="codicon codicon-chevron-down" aria-hidden="true"></span>
            </button>
            <Popover open={catsOpen} anchor={catsAnchor} onClose={() => (catsOpen = false)}>
              <div class="lm-cat-menu" role="group" aria-label="Event categories">
                {#each CATEGORIES as c (c.id)}
                  <label
                    class="lm-cat-item"
                    title={c.default ? `${c.label} (on by default)` : `Show ${c.label.toLowerCase()} in the feed`}
                  >
                    <input
                      type="checkbox"
                      checked={filter.cats.includes(c.id)}
                      onchange={() => toggleCat(c.id)}
                    />
                    {c.label}
                  </label>
                {/each}
              </div>
            </Popover>
          </span>

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
              Knife/warmup rounds are hidden — show them in Settings, or clear the round range.
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

