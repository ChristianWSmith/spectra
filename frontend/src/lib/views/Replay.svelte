<script>
  // Replay — the tactical replay AND the app's ONE canonical raw-event
  // browser per match (the landmark consolidation): event discovery,
  // filtering, inspection and navigation all happen here, in the side
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
    getChat,
    getGenericEvents,
    getGenericHistogram,
    getMatch,
    getRounds,
    getVoicePresence,
    getVoicePlayers,
    voiceWavURL,
    listSavedFilters,
    saveFilter,
    deleteSavedFilter,
    errText,
  } from '../services.js';
  import { createEngine, parsePositions, SPEEDS } from '../replay/engine.js';
  import { createRenderer } from '../replay/renderer.js';
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
    landmarkExportRows,
  } from '../replay/landmarks.js';
  import { attachReplayInput, snapshot } from '../replay/input.js';
  import { createVoiceEngine, fetchVoicePCM } from '../replay/audio.js';
  import { loadMapPack } from '../components/mapxform.js';
  import { saveExportURL } from '../save.js';
  import { downloadBlob, downloadText } from '../download.js';
  import { toCSV } from '../csv.js';
  import { chatClock, prettyJson } from '../fmt.js';
  import { isCounted } from '../rounds.js';
  import { buildHash } from '../router.js';
  import FilterBar from '../components/FilterBar.svelte';
  import LandmarkRow from '../components/LandmarkRow.svelte';
  import VoiceLanes from '../components/VoiceLanes.svelte';
  import EventFlags from '../components/EventFlags.svelte';
  import ProfileLink from '../components/ProfileLink.svelte';
  import PayloadTree from '../components/PayloadTree.svelte';

  let { id = 0, query = {}, nav = () => {} } = $props();

  let meta = $state(null);
  let matchMap = $state('');
  let pack = $state(null); // map pack meta.json or null
  let packTf = null; // makeTransform(meta) from loadMapPack — passed to
  //                    the renderer instead of re-deriving pack fields
  let data = $state(null); // parsed position store
  let rounds = $state([]);
  let loading = $state(true);
  let loadError = $state('');
  let noSidecar = $state(false);

  // M4 voice: presence gates the whole controls block; players feed mute/
  // solo chips; the voice engine mirrors live in ui* state via callbacks.
  let voicePresence = $state(null);
  let voicePlayers = $state([]);
  let voiceEngine = null;
  let uiVoiceOn = $state(false);
  let uiVoiceCtx = $state('none');
  let uiVoiceErr = $state('');
  let uiVoiceVol = $state(0.8);
  const uiVoiceMute = $state({}); // steamId → bool
  const uiVoiceSolo = $state({}); // steamId → bool

  // Transport-bar mirror of the engine state (updated via onChange).
  let uiFrame = $state(0);
  let uiTick = $state(0);
  let uiPlaying = $state(false);
  let uiSpeed = $state(1);
  let uiFollow = $state(null);
  let uiLoopFrom = $state(-1);
  let uiLoopTo = $state(-1);
  let uiLoopOn = $state(false);
  let eventsOpen = $state(true); // the canonical feed is visible by default
  // The voice-lanes strip needs ~190px of vertical space — show it by
  // default only when the window has room for it (short windows would
  // otherwise leave the landmark list with a single visible row); the
  // voice bar's Lanes toggle always overrides.
  let lanesOpen = $state(typeof window === 'undefined' || window.innerHeight >= 820);
  let jumpRound = $state('');

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

  // The merged, categorized, chronological feed (counted-round policy
  // applied for the sparse round categories).
  const feedRows = $derived.by(() =>
    mergeFeed([
      typedRows.map((r) => normalizeEvent(r, { roundsByNumber: rbn })).filter(Boolean),
      chatRows.map((c) => normalizeChat(c)),
      Object.values(genPages).flatMap((p) => p.rows.map((g) => normalizeGeneric(g, p.cat))),
    ]),
  );

  // Draw feed: the drawable-kind anchors, fetched ONCE per match in
  // load() and handed to the renderer — category chips never rebuild the
  // world layers (spec §8).
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
    for (const l of drawNorm) {
      if (!cats.has(l.category)) continue;
      const cat = categoryById(l.category);
      if (cat && cat.countedOnly) {
        const r = rbn.get(l.round);
        if (r && !isCounted(r)) continue;
      }
      if (filter.round >= 0 && l.round !== filter.round) continue;
      if (filter.steamId && l.steamId !== filter.steamId) continue;
      let cls = '';
      if (l.bucket === 'kill') cls = 'kill';
      else if (l.bucket === 'plant' || l.bucket === 'defuse') cls = 'plant';
      else if (l.bucket === 'explode' || l.bucket === 'detonation') cls = 'det';
      else if (l.bucket === 'round') cls = 'round';
      else continue;
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
      engine?.seekTick(row.tick);
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
              engine?.seekTick(d.tick);
            }
          })
          .catch(() => {});
      }
    }
  });

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

  // Filter the feed to ±5s around the playhead (the retired header
  // button's promise, now canonical feed behavior).
  function eventsAtTick() {
    const tr = meta && meta.tickRate > 0 ? meta.tickRate : 64;
    const half = Math.round(5 * tr);
    eventsOpen = true;
    navigateFilter({ ...filter, tickFrom: Math.max(0, uiTick - half), tickTo: uiTick + half });
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

  function exportCSV() {
    return download(
      `match-${id}-events.csv`,
      'text/csv;charset=utf-8',
      toCSV(landmarkExportRows(feedRows)),
    );
  }

  function exportJSON() {
    return download(`match-${id}-events.json`, 'application/json', JSON.stringify(feedRows, null, 2));
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
  // audio engine starts from there (the old Timeline Hear ±10s contract,
  // now in-panel).
  function hearTick(tick) {
    engine?.seekTick(tick);
    if (voiceEngine) voiceEngine.setEnabled(true).catch(() => {});
    engine?.play();
  }

  // Voice-lanes click → same exit path (index-only, audio follows).
  function laneSeek(tick) {
    hearTick(tick);
  }

  const players = $derived(meta?.players || []);

  // --- Follow camera (?follow=<steamid17>) -----------------------------------
  // The Match view's "open the replay on this player" hand-off: the
  // contract is a 17-digit steam id in the route query. Resolved against
  // the sidecar slot table — a malformed id or one that is not in this
  // match resolves to -1 and the param is ignored (free camera, no
  // error). Follow itself is engine state (engine.setFollow): the
  // renderer recenters the camera on that slot every frame, across
  // rounds, and the transport select / F and 1-9 keys drive the same
  // state.
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
    if (input) input.detach();
    if (ro) ro.disconnect();
    if (offChange) offChange();
    if (engine) engine.destroy();
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

  async function load() {
    loading = true;
    loadError = '';
    entrySel = query.sel || '';
    try {
      const m = await getReplayMeta(id);
      meta = m;
      if (!m || !m.hasSidecar) {
        noSidecar = true;
        return;
      }
      const [match, rs] = await Promise.all([
        getMatch(id).catch(() => null),
        getRounds(id).catch(() => []),
      ]);
      matchMap = (match && match.map) || '';
      rounds = rs || [];
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
    renderer = createRenderer(canvasEl, { engine, data, players });
    renderer.setPack(pack, radarImg, packTf);
    renderer.setLandmarks(drawNorm);
    renderer.resize();
    offChange = engine.onChange((st) => {
      uiFrame = st.frame;
      uiTick = st.tick;
      uiPlaying = st.playing;
      uiSpeed = st.speed;
      uiFollow = st.followSlot;
      uiLoopFrom = st.loopFrom;
      uiLoopTo = st.loopTo;
      uiLoopOn = st.loopEnabled;
      renderer.draw();
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
    // M4: wire voice so the lanes strip and Hear ±10s can drive it.
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
          uiVoiceCtx = s.ctxState;
          uiVoiceErr = s.error;
        },
      });
      voiceEngine.setPlayers(voicePlayers);
      voiceEngine.setMasterVolume(uiVoiceVol);
      for (const p of voicePlayers) {
        if (uiVoiceMute[p.steamId]) voiceEngine.setMuted(p.steamId, true);
        if (uiVoiceSolo[p.steamId]) voiceEngine.setSolo(p.steamId, true);
      }
    }
    // Entry position rides the URL (?tick=) — the durable replacement
    // for the retired replay-seek hand-off. No autoplay: contextual
    // links seek, they never hijack playback.
    const tick0 = Number(query.tick) || 0;
    if (tick0) engine.seekTick(tick0);
    renderer.draw();
    ready = true;
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

  function onJumpRound(e) {
    const n = Number(e.currentTarget.value);
    jumpRound = '';
    const r = rounds.find((x) => x.number === n);
    if (r && engine) engine.seekTick(r.startTick || 0);
  }

  function onFollow(e) {
    const v = e.currentTarget.value;
    engine?.setFollow(v === '' ? null : Number(v));
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

  // Per-player full-track WAV: rides SaveExport — the native dialog picks
  // the path, then Go serves the sidecar route straight to the file (full
  // matches are tens of MB, so they never cross the bindings). Cancel = "".
  async function exportWav(p) {
    try {
      await saveExportURL(voiceWavURL(id, p.steamId), `${p.name || p.steamId}.wav`, 'wav');
    } catch (e) {
      console.error('voice WAV save failed:', e);
    }
  }

  // --- M4 voice controls ------------------------------------------------------
  async function toggleVoice() {
    if (!voiceEngine) return;
    await voiceEngine.setEnabled(!uiVoiceOn);
  }

  function onVoiceVol(e) {
    uiVoiceVol = Number(e.currentTarget.value);
    voiceEngine?.setMasterVolume(uiVoiceVol);
  }

  function toggleVoiceMute(steamId) {
    uiVoiceMute[steamId] = !uiVoiceMute[steamId];
    voiceEngine?.setMuted(steamId, !!uiVoiceMute[steamId]);
  }

  function toggleVoiceSolo(steamId) {
    uiVoiceSolo[steamId] = !uiVoiceSolo[steamId];
    voiceEngine?.setSolo(steamId, !!uiVoiceSolo[steamId]);
  }
</script>

<div class="view replay-view">
  <header class="view-header">
    <button class="btn" onclick={goBack}><span class="codicon codicon-arrow-left"></span> Back</button>
    <h1>Replay</h1>
    {#if matchMap}<span class="chip">{matchMap}</span>{/if}
    {#if meta && !noSidecar}
      <span class="chip round-chip">{players.length} slots</span>
    {/if}
    <div class="spacer"></div>
    {#if ready && data}
      <span class="mono muted replay-readout">tick {uiTick}</span>
      <button
        class="btn"
        onclick={eventsAtTick}
        title="Filter the landmark feed to ±5s around the playhead"
        >Events at tick</button
      >
      <button class="btn" onclick={doSnapshot}>Snapshot</button>
      <button
        class="btn clip-btn"
        class:primary={recState === 'recording'}
        disabled={recState === 'encoding'}
        onclick={toggleRecord}
        title="Record a WebM clip — loop range if set, else 10s from the playhead (video only)"
        ><span class="codicon {recState === 'recording' ? 'codicon-debug-stop' : 'codicon-record'}"></span>
          {recState === 'recording' ? 'Stop clip' : 'Record clip'}</button
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
  </header>

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
    {#if meta && data.frames !== meta.frames}
      <p class="note-amber" role="status">
        frame count mismatch: stream has {data.frames}, meta says {meta.frames}
      </p>
    {/if}
    <div class="replay-body">
      <div class="replay-stage" bind:this={stageEl}>
        <canvas bind:this={canvasEl} aria-label="Replay canvas"></canvas>
        {#if uiFollow != null && players[uiFollow]}
          <!-- Follow chip: the dismiss surface for the camera-follow
               state (?follow= entry, the transport select and the F/1-9
               keys all land here). -->
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
      <aside class="replay-side" aria-label="Landmark events">
        <button
          class="side-toggle"
          aria-expanded={eventsOpen}
          onclick={() => (eventsOpen = !eventsOpen)}
        >
          <h2>Landmarks</h2>
          <span class="spacer"></span>
          <span class="muted num">{feedRows.length}{hasMore ? '+' : ''}</span>
          <span class="muted"><span class="codicon {eventsOpen ? 'codicon-chevron-down' : 'codicon-chevron-right'}"></span></span>
        </button>
        {#if eventsOpen}
          <!-- The middle of the panel scrolls as a unit (cats → filters →
               toolbar → list); the detail pane pins below it, so a long
               feed can never clip the selected event. -->
          <div class="lm-scroll">
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

          <details class="lm-filters" open={filter.round !== -1 || !!filter.steamId || !!filter.weapon || !!filter.bbox || !!filter.tickFrom || !!filter.tickTo}>
            <summary>Filters</summary>
            <FilterBar {id} filter={filter} onchange={onBarFilter} showReset={false} />
          </details>

          <div class="lm-toolbar" role="group" aria-label="Feed actions">
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
            <button class="btn small" onclick={exportCSV} disabled={!feedRows.length} title="Export the loaded feed as CSV">CSV</button>
            <button class="btn small" onclick={exportJSON} disabled={!feedRows.length} title="Export the loaded feed as JSON">JSON</button>
            <button class="btn small" onclick={resetFilters} title="Reset every filter to the sparse default">Reset</button>
          </div>
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
                selected={selected?.key === row.key}
                onselect={select}
                onseek={(r) => seekTo(r.tick)}
              />
            {:else}
              <li class="muted lm-empty" role="status">
                {#if filter.cats.length === 0}
                  No categories enabled — turn some on above.
                {:else if feedLoading}
                  Loading events…
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
                <span class="chip round-chip">R{selected.round}</span>
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
                    <dd>{selected.assisterName || '—'}</dd>
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
                    <dd class="num">{selected.round}</dd>
                  </div>
                  {#if selected.who}
                    <div>
                      <dt>Player</dt>
                      <dd>{selected.who}</dd>
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
        {/if}
      </aside>
    </div>

    {#if lanesOpen && voicePresence && voicePresence.hasVoice}
      <div class="voice-lanes-wrap">
        <VoiceLanes matchId={id} onSeek={laneSeek} />
      </div>
    {/if}

    <div class="toolbar replay-transport" role="group" aria-label="Replay transport">
      <button
        class="btn primary"
        aria-label={uiPlaying ? 'Pause' : 'Play'}
        title={uiPlaying ? 'Pause (Space)' : 'Play (Space)'}
        onclick={togglePlay}><span class="codicon {uiPlaying ? 'codicon-debug-pause' : 'codicon-play'}"></span></button
      >
      <label class="sr-only" for="rp-speed">Speed</label>
      <select class="input" id="rp-speed" value={uiSpeed} onchange={onSpeed}>
        {#each SPEEDS as s (s)}
          <option value={s}>{s}×</option>
        {/each}
      </select>

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
      <span class="mono replay-readout"
        >f{uiFrame + 1}/{frames} · {uiTick}</span
      >

      <span class="loop-group">
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
      </span>

      <label class="sr-only" for="rp-round">Jump to round</label>
      <select class="input" id="rp-round" value={jumpRound} onchange={onJumpRound}>
        <option value="">Jump to round…</option>
        {#each rounds as r (r.number)}
          <option value={r.number}>
            R{r.number}{r.warmup ? ' (wu)' : ''}{r.pregame ? ' (knife)' : ''}{r.bombSite ? ` · ${r.bombSite}` : ''}
          </option>
        {/each}
      </select>

      <label class="sr-only" for="rp-follow">Follow player</label>
      <select class="input" id="rp-follow" value={uiFollow ?? ''} onchange={onFollow}>
        <option value="">Free camera</option>
        {#each players as p, i (i)}
          <option value={i}>{i + 1}. {p.name || `slot ${i}`}</option>
        {/each}
      </select>

      <span class="muted" title="Space play/pause · , . speed · ←/→ step · Shift ±64 · L loop · F follow · 1-9 select · S snapshot"><span class="codicon codicon-keyboard"></span> hints</span>
    </div>

    {#if voicePresence && voicePresence.hasVoice}
      <div class="toolbar voice-bar" role="group" aria-label="Voice controls">
        <button
          class="btn"
          class:primary={lanesOpen}
          aria-pressed={lanesOpen}
          title="Show/hide the per-player voice density lanes (click a lane to play from there)"
          onclick={() => (lanesOpen = !lanesOpen)}
        >Lanes</button>
        <button
          class="btn"
          class:primary={!uiVoiceOn}
          onclick={toggleVoice}
          title={uiVoiceErr || (uiVoiceOn ? 'Stop voice playback' : 'Start voice playback (needs one click — browser gesture rule)')}
        >{#if uiVoiceOn}<span class="codicon codicon-unmute"></span> Voice on{:else}Enable voice{/if}</button
        >
        <span
          class="chip voice-state {uiVoiceErr ? 'bad' : uiVoiceOn ? 'ok' : 'idle'}"
          title={uiVoiceErr ? `AudioContext: ${uiVoiceCtx} — ${uiVoiceErr}` : `AudioContext: ${uiVoiceCtx}`}
        >{uiVoiceErr ? 'error' : uiVoiceOn ? `on · ${uiVoiceCtx}` : 'off'}</span>
        {#if uiVoiceErr}
          <span class="voice-hint" role="alert"
            >{uiVoiceErr} — install <span class="mono">gst-plugins-good</span> (GStreamer) if audio fails to start.</span
          >
        {/if}
        <label class="sr-only" for="rp-vol">Voice volume</label>
        <input
          class="voice-vol"
          id="rp-vol"
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={uiVoiceVol}
          oninput={onVoiceVol}
        />
        <span class="voice-players">
          {#each voicePlayers as p (p.steamId)}
            <span class="voice-player" title="{p.name} — {p.chunks.toLocaleString()} chunks, {Math.round(p.seconds)}s of voice">
              <span class="voice-name">{p.name}</span>
              <button
                class="btn small ghost voice-ms"
                class:warn={!!uiVoiceMute[p.steamId]}
                aria-pressed={!!uiVoiceMute[p.steamId]}
                aria-label="Mute {p.name}"
                title="Mute {p.name}"
                onclick={() => toggleVoiceMute(p.steamId)}>M</button
              >
              <button
                class="btn small ghost voice-ms"
                class:warn={!!uiVoiceSolo[p.steamId]}
                aria-pressed={!!uiVoiceSolo[p.steamId]}
                aria-label="Solo {p.name}"
                title="Solo {p.name} (overrides mutes)"
                onclick={() => toggleVoiceSolo(p.steamId)}>S</button
              >
              <details class="voice-export">
                <summary class="btn small ghost" aria-label="Export {p.name} voice" title="Export {p.name}'s track"><span class="codicon codicon-chevron-down"></span></summary>
                <button
                  type="button"
                  class="voice-dl"
                  title="Download full-track WAV for {p.name}"
                  onclick={() => exportWav(p)}>WAV</button
                >
              </details>
            </span>
          {/each}
        </span>
      </div>
    {/if}
  {/if}
</div>

<style>
  /* The WAV control is a real button now (it opens the native save dialog
     rather than navigating), so it needs the pointer cursor the old anchor
     got from the UA stylesheet. */
  .voice-dl {
    cursor: pointer;
  }
</style>
