<script>
  import { onMount, tick as svelteTick } from 'svelte';
  import {
    getReplayMeta,
    getLandmarks,
    getMatch,
    getRounds,
    getVoicePresence,
    getVoicePlayers,
    voiceWavURL,
    setPendingTimelineFilter,
    takePendingSeek,
  } from '../services.js';
  import { createEngine, parsePositions, SPEEDS } from '../replay/engine.js';
  import { createRenderer } from '../replay/renderer.js';
  import { attachReplayInput, snapshot } from '../replay/input.js';
  import { createVoiceEngine, fetchVoicePCM } from '../replay/audio.js';
  import { loadMapPack } from '../components/mapxform.js';

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

  function errText(e) {
    if (e == null) return 'unknown error';
    if (typeof e === 'string') return e;
    return e.message || String(e);
  }

  async function loadPack(map) {
    if (!map) return { pack: null, img: null };
    // Shared loader: extracted pack (local CS2) wins over bundled.
    const p = await loadMapPack(map);
    if (!p || !p.meta) return { pack: null, img: null };
    if (p.meta.radar && p.meta.radar.file) {
      const img = new Image();
      img.src = `${p.base}/${p.meta.radar.file}`;
      try {
        await img.decode();
        return { pack: p.meta, img };
      } catch {
        return { pack: p.meta, img: null };
      }
    }
    return { pack: p.meta, img: null };
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
      // Voice presence gates the controls block; players ride alongside.
      voicePresence = await getVoicePresence(id).catch(() => null);
      if (voicePresence && voicePresence.hasVoice) {
        voicePlayers = (await getVoicePlayers(id).catch(() => [])) || [];
      } else {
        voicePlayers = [];
      }
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
    // M4: wire voice before the pendingSeek hand-off so {play, voice}
    // flags from Timeline's Hear ±10s / lane click can act on it.
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
    // Cross-view hand-off: pendingSeek {tick, play?, voice?} from
    // Match/RoundDetail/Timeline. play/voice are new in M4: Replay starts
    // playback and (gesture-permitting) audio so "Hear ±10s" is audible.
    const seek = takePendingSeek();
    if (seek && Number.isFinite(seek.tick)) engine.seekTick(seek.tick);
    if (seek && seek.voice && voiceEngine) {
      voiceEngine.setEnabled(true).catch(() => {});
    }
    if (seek && seek.play) engine.play();
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
    const tr = meta && meta.tickRate > 0 ? meta.tickRate : 64;
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

  function finishClip() {
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
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `clip-${id}-${recStartTick}.webm`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    recState = 'saved';
    recNote = `${type.replace('video/', '')} · ${(blob.size / 1024).toFixed(0)} KB`;
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

  function openTimeline() {
    if (!engine) return;
    setPendingTimelineFilter({ tick: engine.state.tick });
    nav(`/match/${id}/timeline`);
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
      <button
        class="btn clip-btn"
        class:primary={recState === 'recording'}
        disabled={recState === 'encoding'}
        onclick={toggleRecord}
        title="Record a WebM clip — loop range if set, else 10s from the playhead (video only)"
        >{recState === 'recording' ? '■ Stop clip' : '● Record clip'}</button
      >
      {#if recState !== 'idle'}
        <span
          class="chip clip-state"
          class:recording={recState === 'recording'}
          class:encoding={recState === 'encoding'}
          class:saved={recState === 'saved'}
          class:err={recState === 'error'}
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
          <button class="btn small ghost" onclick={discardClip} title="Dismiss">✕</button>
        {/if}
      {/if}
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

      <span class="muted" title="Space play/pause · , . speed · ←/→ step · Shift ±64 · L loop · F follow · 1-9 select · S snapshot">⌨ hints</span>
    </div>

    {#if voicePresence && voicePresence.hasVoice}
      <div class="voice-bar" role="group" aria-label="Voice controls">
        <button
          class="btn"
          class:primary={!uiVoiceOn}
          onclick={toggleVoice}
          title={uiVoiceErr || (uiVoiceOn ? 'Stop voice playback' : 'Start voice playback (needs one click — browser gesture rule)')}
        >{uiVoiceOn ? '🔊 Voice on' : 'Enable voice'}</button
        >
        <span
          class="chip voice-state"
          class:on={uiVoiceOn}
          class:err={!!uiVoiceErr}
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
                <summary class="btn small ghost" aria-label="Export {p.name} voice" title="Export {p.name}'s track">▾</summary>
                <a
                  class="voice-dl"
                  href={voiceWavURL(id, p.steamId)}
                  download="{p.name || p.steamId}.wav"
                  title="Download full-track WAV for {p.name}">WAV</a
                >
              </details>
            </span>
          {/each}
        </span>
      </div>
    {/if}
  {/if}
</div>
