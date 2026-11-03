<script>
  // M5 data explorer / developer mode: per-match provenance,
  // entity summary, ConVars, generic-event payload browser (key/value tree)
  // and parser warnings — the raw inspectors M1's Match Raw tab only
  // histograms. Acceptance walkthrough #3.
  import {
    listMatches,
    getProvenance,
    getConVars,
    getEntitySummary,
    getGenericHistogram,
    getGenericEvents,
    getWarnings,
    errText,
  } from '../services.js';
  import { fmtDate, fmtInt } from '../fmt.js';
  import MatchPicker from '../components/MatchPicker.svelte';
  import PayloadTree from '../components/PayloadTree.svelte';

  let { nav = () => {} } = $props();

  let matches = $state([]);
  let matchId = $state(0);
  let loadError = $state('');

  let prov = $state(null);
  let provError = $state('');
  let entities = $state(null);
  let entError = $state('');
  let convars = $state([]);
  let convarsError = $state('');
  let convarFilter = $state('');
  let hist = $state([]);
  let histError = $state('');
  let events = $state([]);
  let eventsError = $state('');
  let eventsLoading = $state(false);
  let eventLimit = $state(100);
  let selectedName = $state('');
  let payloadFilter = $state('');
  let rawOpen = $state({}); // index → bool (raw JSON vs tree)
  let warnings = $state([]);
  let warnError = $state('');

  let gen = 0; // match-switch generation — drops stale async results

  // Reference block: a SHORT static summary of the golden demo's
  // network-message census, not a dump.
  const REF_BULLETS = [
    'UserCommands dominate: 1,367,690 of 1,965,413 total messages (POV input history).',
    'CSVCMsg_VoiceData fires 123,507 times — the Opus chunks M4 voice playback decodes.',
    'CMsgSosStartSoundEvent 25,266 / legacy game events 21,029 — sound + pre-S2 event layers.',
    'Ballistics-adjacent: CMsgTEFireBullets 3,302 + CMsgPlaceDecalEvent 1,514.',
  ];

  $effect(() => {
    listMatches('', 'extracted_at', true)
      .then((rows) => {
        matches = rows || [];
        if (matches.length && !matches.some((m) => m.id === matchId)) {
          matchId = matches[0].id;
        }
      })
      .catch((e) => {
        loadError = errText(e);
      });
  });

  // Reload every inspector when the selected match changes.
  $effect(() => {
    const id = matchId;
    if (!id) return;
    const my = ++gen;
    prov = null;
    entities = null;
    convars = [];
    hist = [];
    events = [];
    warnings = [];
    selectedName = '';
    rawOpen = {};
    eventLimit = 100;
    provError = entError = convarsError = histError = eventsError = warnError = '';

    getProvenance(id)
      .then((p) => {
        if (my === gen) prov = p;
      })
      .catch((e) => {
        if (my === gen) provError = errText(e);
      });
    getEntitySummary(id)
      .then((s) => {
        if (my === gen) entities = s;
      })
      .catch((e) => {
        if (my === gen) entError = errText(e);
      });
    getConVars(id)
      .then((rows) => {
        if (my === gen) convars = rows || [];
      })
      .catch((e) => {
        if (my === gen) convarsError = errText(e);
      });
    getGenericHistogram(id)
      .then((h) => {
        if (my === gen) hist = h || [];
      })
      .catch((e) => {
        if (my === gen) histError = errText(e);
      });
    getWarnings(id)
      .then((w) => {
        if (my === gen) warnings = w || [];
      })
      .catch((e) => {
        if (my === gen) warnError = errText(e);
      });
  });

  function selectEventName(name) {
    selectedName = name;
    events = [];
    rawOpen = {};
    eventLimit = 100;
    loadEvents(100);
  }

  async function loadEvents(limit) {
    const id = matchId;
    const name = selectedName;
    eventsLoading = true;
    eventsError = '';
    try {
      const rows = await getGenericEvents(id, name, limit);
      if (id !== matchId || name !== selectedName) return;
      events = rows || [];
      eventLimit = limit;
    } catch (e) {
      if (id === matchId && name === selectedName) eventsError = errText(e);
    } finally {
      if (id === matchId && name === selectedName) eventsLoading = false;
    }
  }

  const filteredConvars = $derived.by(() => {
    const q = convarFilter.trim().toLowerCase();
    if (!q) return convars;
    return convars.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        String(c.value).toLowerCase().includes(q),
    );
  });

  let histFilter = $state('');
  const filteredHistRows = $derived.by(() => {
    const q = histFilter.trim().toLowerCase();
    if (!q) return hist;
    return hist.filter((h) => h.name.toLowerCase().includes(q));
  });

  // Key/value tree rendering (parse, leaf formatting, filter matching,
  // lazy expansion) lives in components/PayloadTree.svelte + the pure
  // payloadTree.js module — see there. Explorer only feeds it the raw
  // payload JSON and the filter text.

  // Encrypted-message note (presence, never content).
  const encNote = $derived.by(() => {
    if (!prov) return '';
    const n = Number(prov.encMessages) || 0;
    if (!n) return '';
    const notes = (prov.notes || []).join(' · ');
    return (
      `${fmtInt(n)} encrypted network message(s) present in this demo — ` +
      'Spectra records presence, not content' +
      (notes ? ` · key/provenance notes: ${notes}` : ' · no decrypt-key status recorded')
    );
  });
</script>

<div class="view">
  <header class="view-header">
    <h1>Explorer</h1>
    <MatchPicker
      id="expl-match"
      matches={matches}
      value={matchId}
      onselect={(id) => (matchId = id)}
    />
    <span class="muted">Developer-mode inspectors over the stored corpus.</span>
  </header>

  {#if loadError}
    <p class="error" role="alert">{loadError}</p>
  {/if}

  {#if !matchId}
    <div class="panel empty">
      <p class="empty-title">No matches</p>
      <p class="muted">Import a demo in the Library first.</p>
    </div>
  {:else}
    <!-- Provenance: reproducibility panel per match. -->
    <section class="panel">
      <h2>Provenance</h2>
      {#if provError}
        <p class="error" role="alert">{provError}</p>
      {:else if !prov}
        <p class="muted">Loading…</p>
      {:else}
        <dl class="facts">
          <div>
            <dt>Parser version</dt>
            <dd class="mono">{prov.parserVersion || '—'}</dd>
          </div>
          <div>
            <dt>Extracted at</dt>
            <dd>{fmtDate(prov.extractedAt)}</dd>
          </div>
          <div>
            <dt>Parse time</dt>
            <dd class="num">{fmtInt(prov.parseMs)} ms</dd>
          </div>
          <div>
            <dt>Rule version</dt>
            <dd class="num">{prov.ruleVersion}</dd>
          </div>
          <div>
            <dt>Trade window</dt>
            <dd class="num">{prov.tradeWindowS}s</dd>
          </div>
          <div>
            <dt>Position format</dt>
            <dd class="num">v{prov.positionFormat}</dd>
          </div>
          <div>
            <dt>Voice sample rate</dt>
            <dd class="num">{prov.sampleRate ? `${prov.sampleRate} Hz` : '—'}</dd>
          </div>
          <div>
            <dt>Voice chunks</dt>
            <dd class="num">{fmtInt(prov.voiceChunks)}</dd>
          </div>
          <div>
            <dt>Warnings</dt>
            <dd class="num">{fmtInt(prov.warnings)}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd><span class="chip status {prov.status}">{prov.status || '—'}</span></dd>
          </div>
        </dl>
        {#if prov.notes && prov.notes.length}
          <div class="expl-notes">
            {#each prov.notes as n, i (i)}
              <span class="chip expl-note-chip" title="Provenance caveat">{n}</span>
            {/each}
          </div>
        {/if}
        {#if encNote}
          <p class="expl-enc" role="note">{encNote}</p>
        {/if}
      {/if}
    </section>

    <!-- Entity summary -->
    <section class="panel">
      <h2>Entity summary</h2>
      {#if entError}
        <p class="error" role="alert">{entError}</p>
      {:else if !entities}
        <p class="muted">Loading…</p>
      {:else}
        <dl class="facts">
          <div>
            <dt>Server classes</dt>
            <dd class="num">{fmtInt(entities.entityClasses)}</dd>
          </div>
          <div>
            <dt>End entities</dt>
            <dd class="num">{fmtInt(entities.endEntities)}</dd>
          </div>
          <div>
            <dt>Generic event types</dt>
            <dd class="num">{fmtInt(entities.genericTypes)}</dd>
          </div>
          <div>
            <dt>Generic events total</dt>
            <dd class="num">{fmtInt(entities.genericTotal)}</dd>
          </div>
        </dl>
        {#if entities.notes}
          <p class="muted expl-ent-note">{entities.notes}</p>
        {/if}
      {/if}
    </section>

    <!-- ConVars -->
    <section class="panel">
      <h2>ConVars <span class="muted num">{filteredConvars.length}/{convars.length}</span></h2>
      {#if convarsError}
        <p class="error" role="alert">{convarsError}</p>
      {:else}
        <input
          class="input"
          placeholder="Filter by name or value…"
          bind:value={convarFilter}
          aria-label="Filter ConVars"
        />
        {#if convars.length === 0}
          <p class="muted">No server_cvar events recorded for this match.</p>
        {:else if filteredConvars.length === 0}
          <p class="muted">No ConVars match the filter.</p>
        {:else}
          <div class="table-scroll expl-convars">
            <table class="data-table mini">
              <thead>
                <tr><th>Name</th><th>Value</th><th class="num">Round</th><th class="num">Tick</th></tr>
              </thead>
              <tbody>
                {#each filteredConvars as c, i (i)}
                  <tr>
                    <td class="mono name-cell">{c.name}</td>
                    <td class="mono">{c.value}</td>
                    <td class="num muted">{c.round}</td>
                    <td class="num muted">{c.tick}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      {/if}
    </section>

    <!-- Generic payload browser -->
    <section class="panel">
      <h2>Generic payload browser</h2>
      {#if histError}
        <p class="error" role="alert">{histError}</p>
      {/if}
      <div class="expl-grid">
        <div class="expl-hist">
          <input
            class="input"
            placeholder="Filter event names…"
            bind:value={histFilter}
            aria-label="Filter event names"
          />
          <div class="expl-hist-list">
            {#each filteredHistRows as h (h.name)}
              <button
                class="expl-hist-row"
                class:active={selectedName === h.name}
                onclick={() => selectEventName(h.name)}
              >
                <span class="mono expl-hist-name">{h.name}</span>
                <span class="spacer"></span>
                <span class="num muted">{fmtInt(h.count)}</span>
              </button>
            {:else}
              <p class="muted">No generic events stored for this match.</p>
            {/each}
          </div>
        </div>
        <div class="expl-payloads">
          {#if !selectedName}
            <p class="muted">Pick an event name on the left to browse payloads.</p>
          {:else}
            <div class="row-between">
              <span class="chip kind">{selectedName}</span>
              <span class="muted num">{fmtInt(events.length)} loaded</span>
              <input
                class="input"
                placeholder="Filter keys…"
                bind:value={payloadFilter}
                aria-label="Filter payload keys"
              />
            </div>
            {#if eventsError}
              <p class="error" role="alert">{eventsError}</p>
            {/if}
            <!-- Keyed by event name + index: switching events remounts the
                 payload trees (fresh expansion state) while "load 100
                 more" keeps existing rows' state (stable indices). -->
            {#each events as ev, i (selectedName + ':' + i)}
              <div class="payload expl-ev">
                <div class="payload-head">
                  <span class="mono muted">#{i + 1}</span>
                  <span class="chip round-chip">R{ev.round}</span>
                  <span class="mono muted">tick {ev.tick}</span>
                  <span class="spacer"></span>
                  <button
                    class="btn small ghost"
                    aria-pressed={!!rawOpen[i]}
                    onclick={() => (rawOpen = { ...rawOpen, [i]: !rawOpen[i] })}
                    title="Toggle raw JSON"
                    >{rawOpen[i] ? 'tree' : 'raw'}</button
                  >
                </div>
                {#if rawOpen[i]}
                  <pre class="mono">{ev.payloadJson}</pre>
                {:else}
                  <PayloadTree json={ev.payloadJson} query={payloadFilter.trim()} />
                {/if}
              </div>
            {/each}
            {#if eventsLoading}
              <p class="muted" role="status">Loading…</p>
            {:else if events.length >= eventLimit}
              <button class="btn" onclick={() => loadEvents(eventLimit + 100)}
                >Load 100 more…</button
              >
            {/if}
          {/if}
        </div>
      </div>
    </section>

    <!-- Warnings -->
    <section class="panel">
      <h2>Warnings <span class="muted num">{warnings.length}</span></h2>
      {#if warnError}
        <p class="error" role="alert">{warnError}</p>
      {:else if warnings.length === 0}
        <p class="muted">No extraction warnings for this match.</p>
      {:else}
        <ul class="warning-list">
          {#each warnings as w, i (i)}
            <li class="mono">{w}</li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- Static reference block (short pointer, not a dump). -->
    <section class="panel expl-ref">
      <h2>Network message census — reference</h2>
      <p class="muted">
        <strong>639</strong> protobuf network-message types enumerated on the
        golden demo; <strong>39</strong> fire (1,965,413 messages total).
      </p>
      <ul class="expl-ref-list">
        {#each REF_BULLETS as b, i (i)}
          <li>{b}</li>
        {/each}
      </ul>
      {#if prov}
        {#if Number(prov.encMessages) > 0}
          <p class="muted">
            Encrypted messages present ({fmtInt(prov.encMessages)}) —
            <span class="chip flag">enc</span> key status is listed under Provenance
            notes above; content is never stored or shown.
          </p>
        {:else}
          <p class="muted">No encrypted network messages recorded for this match.</p>
        {/if}
      {/if}
    </section>
  {/if}
</div>
