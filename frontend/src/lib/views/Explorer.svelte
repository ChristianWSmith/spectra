<script>
  // Explorer — the demo-file DIAGNOSTICS surface: per-match provenance,
  // entity summary and the static network-census reference. Event records
  // are browsed in Replay's landmark feed (game_events/convars
  // categories), warnings live on the Match view, and the one ConVar
  // parser is eventlabels.go on the Go side. Standalone (#/explorer/:id) the picker
  // picks the match; embedded (the match view's Details tab) the passed
  // routeId is authoritative — no picker, no newest-match default.
  import { listMatches, getProvenance, getEntitySummary, errText } from '../services.js';
  import { fmtDate, fmtInt } from '../fmt.js';
  import MatchPicker from '../components/MatchPicker.svelte';
  import StatusChip from '../components/StatusChip.svelte';

  let { nav = () => {}, routeId = 0, embedded = false } = $props();

  let matches = $state([]);
  let matchId = $state(0);
  let loadError = $state('');

  // Route context (#/explorer/:id, or the host view's match id when
  // embedded): authoritative — it seeds the picker (and re-seeds if the
  // route id changes while this view stays mounted; App's if-branch only
  // remounts on a route NAME change). The list effect below only defaults
  // to the newest match while nothing is selected, so a context id is
  // never swapped out; embedded never defaults at all.
  $effect(() => {
    const rid = routeId;
    if (rid) matchId = rid;
  });

  let prov = $state(null);
  let provError = $state('');
  let entities = $state(null);
  let entError = $state('');

  let gen = 0; // match-switch generation — drops stale async results

  // Reference block: a SHORT static summary of the golden demo's
  // network-message census, not a dump.
  const REF_BULLETS = [
    'UserCommands dominate: 1,367,690 of 1,965,413 total messages (POV input history).',
    'CSVCMsg_VoiceData fires 123,507 times — the Opus chunks voice playback decodes.',
    'CMsgSosStartSoundEvent 25,266 / legacy game events 21,029 — sound + pre-S2 event layers.',
    'Ballistics-adjacent: CMsgTEFireBullets 3,302 + CMsgPlaceDecalEvent 1,514.',
  ];

  $effect(() => {
    listMatches('', 'extracted_at', true)
      .then((rows) => {
        matches = rows || [];
        // Default to the newest match only while nothing is selected —
        // a route context id (seeded above) wins over it, and embedded
        // (the Details tab) never defaults: the passed id is authoritative.
        if (!embedded && !matchId && matches.length) matchId = matches[0].id;
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
    provError = entError = '';

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
  });

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
  {#if !embedded}
    <header class="view-header">
      <h1>Explorer</h1>
      <MatchPicker
        id="expl-match"
        matches={matches}
        value={matchId}
        onselect={(id) => (matchId = id)}
      />
      <span class="muted">Demo-file diagnostics over the stored corpus.</span>
    </header>
  {/if}

  {#if loadError}
    <p class="error" role="alert">{loadError}</p>
  {/if}

  {#if !matchId}
    <div class="panel empty">
      <p class="empty-title" role="status">No matches</p>
      <p class="muted">Import a demo in the Library first.</p>
    </div>
  {:else}
    <!-- Provenance: reproducibility panel per match. -->
    <section class="panel">
      <h2>Provenance</h2>
      {#if provError}
        <p class="error" role="alert">{provError}</p>
      {:else if !prov}
        <p class="muted" role="status">Loading…</p>
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
            <dd><StatusChip status={prov.status} /></dd>
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
          <p class="note-amber" role="note">{encNote}</p>
        {/if}
      {/if}
    </section>

    <!-- Entity summary -->
    <section class="panel">
      <h2>Entity summary</h2>
      {#if entError}
        <p class="error" role="alert">{entError}</p>
      {:else if !entities}
        <p class="muted" role="status">Loading…</p>
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
          <p class="muted" role="status">No encrypted network messages recorded for this match.</p>
        {/if}
      {/if}
    </section>
  {/if}
</div>
