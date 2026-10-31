<script>
  import { onMount, tick as svelteTick } from 'svelte';
  import {
    getReplayMeta,
    getLandmarks,
    getMatch,
    getRounds,
    setPendingTimelineFilter,
    takePendingSeek,
  } from '../services.js';
  import { createEngine, parsePositions, SPEEDS } from '../replay/engine.js';
  import { createRenderer } from '../replay/renderer.js';
  import { attachReplayInput, snapshot } from '../replay/input.js';

  let { id = 0, nav = () => {} } = $props();

  let meta = $state(null);
  let matchMap = $state('');
  let pack = $state(null); // map pack meta.json or null
  let data = $state(null); // parsed position store
  let landmarks = $state([]);
  let rounds = $state([]);
  let loading = $state(true);
  let loadError = $state('');
  let noSidecar = $state(false);

  // Transport-bar mirror of the engine state (updated via onChange).
  let uiFrame = $state(0);
  let uiTick = $state(0);
  let uiPlaying = $state(false);
  let uiSpeed = $state(1);
  let uiFollow = $state(null);
  let uiLoopFrom = $state(-1);
  let uiLoopTo = $state(-1);
  let uiLoopOn = $state(false);
  let eventsOpen = $state(false);
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

  // Scrubber event markers: kills = small gray, plants/defuses = amber,
  // detonations = red; positioned by tick over the whole-match tick span.
  const markers = $derived.by(() => {
    if (!data || !data.frames || !landmarks.length) return [];
    const t0 = data.ticks[0];
    const t1 = data.ticks[data.frames - 1];
    const span = Math.max(1, t1 - t0);
    const out = [];
    for (const l of landmarks) {
      const k = String(l.kind || '').toLowerCase();
      let cls = '';
      if (k === 'kill') cls = 'kill';
      else if (k === 'bomb_plant' || k === 'bomb_defuse') cls = 'plant';
      else if (k === 'bomb_explode' || k === 'grenade') cls = 'det';
      else continue;
      if (l.tick < t0 || l.tick > t1) continue;
      out.push({ cls, pct: ((l.tick - t0) / span) * 100 });
    }
    return out;
  });

  const eventList = $derived(
    [...landmarks].sort((a, b) => b.tick - a.tick).slice(0, 50),
  );

  const players = $derived(meta?.players || []);

  onMount(() => {
    load();
    return cleanup;
  });

  // teardown releases the engine/input/observer without marking the view dead
  // (startEngine re-runs it on the live path).
  function teardown() {
    ready = false;
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

  function errText(e) {
    if (e == null) return 'unknown error';
    if (typeof e === 'string') return e;
    return e.message || String(e);
  }

  async function loadPack(map) {
    if (!map) return { pack: null, img: null };
    try {
      const res = await fetch(`/maps/${encodeURIComponent(map)}/meta.json`);
      if (!res.ok) return { pack: null, img: null };
      const p = await res.json();
      if (p && p.radar && p.radar.file) {
        const img = new Image();
        img.src = `/maps/${encodeURIComponent(map)}/${p.radar.file}`;
        try {
          await img.decode();
          return { pack: p, img };
        } catch {
          return { pack: p, img: null };
        }
      }
      return { pack: p, img: null };
    } catch {
      return { pack: null, img: null };
    }
  }

  async function load() {
    loading = true;
    loadError = '';
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
      const { pack: p, img } = await loadPack(matchMap);
      pack = p;
      radarImg = img;
      const res = await fetch(`/api/sidecar/${id}/positions`);
      if (!res.ok) {
        throw new Error(`position data unavailable (HTTP ${res.status})`);
      }
      const buf = await res.arrayBuffer();
      if (!live) return;
      data = parsePositions(buf, players.length || 10);
      landmarks = (await getLandmarks(id).catch(() => [])) || [];
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
    renderer.setPack(pack, radarImg);
    renderer.setLandmarks(landmarks);
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
    // Cross-view hand-off: pendingSeek {tick} from Match/RoundDetail/Timeline.
    const seek = takePendingSeek();
    if (seek && Number.isFinite(seek.tick)) engine.seekTick(seek.tick);
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

  function openTimeline() {
    if (!engine) return;
    setPendingTimelineFilter({ tick: engine.state.tick });
    nav(`/timeline/${id}`);
  }
</script>

<div class="view replay-view">
  <header class="view-header">
    <button class="btn" onclick={() => nav(`/match/${id}`)}>← Match</button>
    <h1>Replay</h1>
    {#if matchMap}<span class="chip">{matchMap}</span>{/if}
    {#if meta && !noSidecar}
      <span class="chip round-chip">{players.length} slots</span>
    {/if}
    <div class="spacer"></div>
    {#if ready && data}
      <span class="mono muted replay-readout">tick {uiTick}</span>
      <button class="btn" onclick={openTimeline}>Open timeline at tick</button>
      <button class="btn" onclick={doSnapshot}>Snapshot</button>
    {/if}
  </header>

  {#if loadError}
    <p class="error" role="alert">{loadError}</p>
  {/if}

  {#if loading}
    <p class="muted">Loading replay…</p>
  {:else if noSidecar}
    <div class="panel empty">
      <p class="empty-title">No replay data for this match</p>
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
      <p class="replay-note" role="status">{packNote}</p>
    {/if}
    {#if meta && data.frames !== meta.frames}
      <p class="replay-note" role="status">
        frame count mismatch: stream has {data.frames}, meta says {meta.frames}
      </p>
    {/if}
    <div class="replay-body">
      <div class="replay-stage" bind:this={stageEl}>
        <canvas bind:this={canvasEl} aria-label="Replay canvas"></canvas>
      </div>
      <aside class="replay-side" aria-label="Landmark events">
        <button
          class="side-toggle"
          aria-expanded={eventsOpen}
          onclick={() => (eventsOpen = !eventsOpen)}
        >
          <h2>Landmarks</h2>
          <span class="spacer"></span>
          <span class="muted num">{landmarks.length}</span>
          <span class="muted">{eventsOpen ? '▾' : '▸'}</span>
        </button>
        {#if eventsOpen}
          <ul class="landmark-list">
            {#each eventList as l, i (i)}
              <li>
                <span class="mono muted">{l.tick}</span>
                <span class="chip kind">{l.kind}</span>
                {#if l.weapon}<span class="mono muted">{l.weapon}</span>{/if}
                <span class="spacer"></span>
                <button
                  class="btn small ghost"
                  title="Seek replay to tick {l.tick}"
                  aria-label="Seek to tick {l.tick}"
                  onclick={() => engine?.seekTick(l.tick)}>▶</button
                >
              </li>
            {:else}
              <li class="muted">No landmarks recorded.</li>
            {/each}
          </ul>
        {/if}
      </aside>
    </div>

    <div class="replay-transport" role="group" aria-label="Replay transport">
      <button
        class="btn primary"
        aria-label={uiPlaying ? 'Pause' : 'Play'}
        title={uiPlaying ? 'Pause (Space)' : 'Play (Space)'}
        onclick={togglePlay}>{uiPlaying ? '⏸' : '▶'}</button
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
            R{r.number}{r.warmup ? ' (wu)' : ''}{r.bombSite ? ` · ${r.bombSite}` : ''}
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

      <span class="muted" title="Space play/pause · , . speed · ←/→ step · Shift ±64 · L loop · F follow · 1-9 select · S snapshot">⌨ hints</span>
    </div>
  {/if}
</div>
