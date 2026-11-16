<script>
  import * as S from '../strings/index.js';
  // Explorer — the demo-file DIAGNOSTICS surface: per-match provenance,
  // entity summary and the static network-census reference (the last one
  // STANDALONE only — the embedded Details tab drops it). Warnings
  // live on the Match view, and the one ConVar parser is eventlabels.go
  // on the Go side (the FE filter surface is gameplay-only since Q3a —
  // generic event records are no longer a feed category). Standalone (#/explorer/:id) the picker
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

  // One generation per inspector read — each drops its own stale async
  // results when the match changes mid-flight (or a Retry supersedes
  // them), without the two reads cancelling each other.
  let provGen = 0;
  let entGen = 0;

  // Reference block: a SHORT static summary of the golden demo's
  // network-message census, not a dump.
  const REF_BULLETS = [
    'UserCommands dominate: 1,367,690 of 1,965,413 total messages (POV input history).',
    'CSVCMsg_VoiceData fires 123,507 times — the Opus chunks voice playback decodes.',
    'CMsgSosStartSoundEvent 25,266 / legacy game events 21,029 — sound + pre-S2 event layers.',
    'Ballistics-adjacent: CMsgTEFireBullets 3,302 + CMsgPlaceDecalEvent 1,514.',
  ];

  // The match list read (mount AND loadError's Retry): the error clears
  // only when the read lands, so a retry never flashes the "No matches"
  // empty state while the list is still unknown.
  async function loadMatches() {
    try {
      const rows = await listMatches('', 'extracted_at', true);
      matches = rows || [];
      // Default to the newest match only while nothing is selected —
      // a route context id (seeded above) wins over it, and embedded
      // (the Details tab) never defaults: the passed id is authoritative.
      if (!embedded && !matchId && matches.length) matchId = matches[0].id;
      loadError = '';
    } catch (e) {
      loadError = errText(e);
    }
  }

  // One inspector read (match switch AND its error's Retry): a plain ✕
  // would strand the panel on "Loading…" forever (the data never
  // arrives), so dismissing means actually re-fetching.
  function loadProv(id) {
    const my = ++provGen;
    prov = null;
    provError = '';
    getProvenance(id)
      .then((p) => {
        if (my === provGen) prov = p;
      })
      .catch((e) => {
        if (my === provGen) provError = errText(e);
      });
  }

  function loadEnt(id) {
    const my = ++entGen;
    entities = null;
    entError = '';
    getEntitySummary(id)
      .then((s) => {
        if (my === entGen) entities = s;
      })
      .catch((e) => {
        if (my === entGen) entError = errText(e);
      });
  }

  $effect(() => {
    loadMatches();
  });

  // Reload every inspector when the selected match changes.
  $effect(() => {
    const id = matchId;
    if (!id) return;
    loadProv(id);
    loadEnt(id);
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
      <h1>{S.library.explorerTitle}</h1>
      <MatchPicker
        id="expl-match"
        matches={matches}
        value={matchId}
        onselect={(id) => (matchId = id)}
      />
      <span class="muted">{S.library.explorerSubtitle}</span>
    </header>
  {/if}

  {#if loadError}
    <p class="error" role="alert">
      {loadError}
      <button class="btn small" onclick={loadMatches}>{S.library.retry}</button>
    </p>
  {/if}

  {#if !matchId}
    {#if !loadError}
      <!-- Gated on loadError: a failed match-list read is UNKNOWN, never
           "no matches" — the alert above carries it (and its Retry). -->
      <div class="panel empty">
        <p class="empty-title" role="status">{S.library.noMatches}</p>
        <p class="muted">{S.library.noMatchesHint}</p>
      </div>
    {/if}
  {:else}
    <!-- Provenance: reproducibility panel per match. -->
    <section class="panel">
      <h2>{S.library.importDetails}</h2>
      {#if provError}
        <p class="error" role="alert">
          {provError}
          <button class="btn small" onclick={() => loadProv(matchId)}>{S.library.retry}</button>
        </p>
      {:else if !prov}
        <p class="muted" role="status"><StatusChip block detail="Loading…" /></p>
      {:else}
        <dl class="facts">
          <div>
            <dt>{S.library.dtParserVersion}</dt>
            <dd class="mono">{prov.parserVersion || '—'}</dd>
          </div>
          <div>
            <dt>{S.library.dtImported}</dt>
            <dd>{fmtDate(prov.extractedAt)}</dd>
          </div>
          <div>
            <dt>{S.library.dtParseTime}</dt>
            <dd class="num">{fmtInt(prov.parseMs)} ms</dd>
          </div>
          <div>
            <dt>{S.library.dtVoiceSampleRate}</dt>
            <dd class="num">{prov.sampleRate ? `${prov.sampleRate} Hz` : '—'}</dd>
          </div>
          <div>
            <dt>{S.library.dtVoiceChunks}</dt>
            <dd class="num">{fmtInt(prov.voiceChunks)}</dd>
          </div>
          <div>
            <dt>{S.library.dtWarnings}</dt>
            <dd class="num">{fmtInt(prov.warnings)}</dd>
          </div>
          <div>
            <dt>{S.library.dtStatus}</dt>
            <dd><StatusChip status={prov.status} /></dd>
          </div>
        </dl>
        {#if prov.notes && prov.notes.length}
          <div class="expl-notes">
            {#each prov.notes as n, i (i)}
              <span class="chip expl-note-chip" title={S.library.noteChipTitle}>{n}</span>
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
      <h2>{S.library.advancedDiagnostics}</h2>
      {#if entError}
        <p class="error" role="alert">
          {entError}
          <button class="btn small" onclick={() => loadEnt(matchId)}>{S.library.retry}</button>
        </p>
      {:else if !entities}
        <p class="muted" role="status"><StatusChip block detail="Loading…" /></p>
      {:else}
        <dl class="facts">
          <div>
            <dt>{S.library.dtEntityTypes}</dt>
            <dd class="num">{fmtInt(entities.entityClasses)}</dd>
          </div>
          <div>
            <dt>{S.library.dtEntitiesAtEnd}</dt>
            <dd class="num">{fmtInt(entities.endEntities)}</dd>
          </div>
          <div>
            <dt>{S.library.dtGenericEventTypes}</dt>
            <dd class="num">{fmtInt(entities.genericTypes)}</dd>
          </div>
          <div>
            <dt>{S.library.dtGenericEventsTotal}</dt>
            <dd class="num">{fmtInt(entities.genericTotal)}</dd>
          </div>
        </dl>
        {#if entities.notes}
          <p class="muted expl-ent-note">{entities.notes}</p>
        {/if}
      {/if}
    </section>

    <!-- Static reference block (short pointer, not a dump) — the
         STANDALONE (#/explorer) page only. The match view's Details tab
         mounts this view embedded, and the golden demo's network census
         is not this match's data: embedded, the card goes (it stays
         behind `{#if !embedded}` so Library keeps it). REF_BULLETS and
         the encryption note are Library copy too — the note lives in the
         import-details section above, which embedded keeps. -->
    {#if !embedded}
    <section class="panel expl-ref">
      <h2>{S.library.networkMessages}</h2>
      <p class="muted">
        <strong>639</strong>{S.library.protobufTypes}
        <strong>39</strong>{S.library.goldenDemoShare}
      </p>
      <ul class="expl-ref-list">
        {#each REF_BULLETS as b, i (i)}
          <li>{b}</li>
        {/each}
      </ul>
      {#if prov}
        {#if Number(prov.encMessages) > 0}
          <p class="muted">
            {S.library.encPresentPrefix}{fmtInt(prov.encMessages)}) —
            <span class="chip flag">{S.library.encChip}</span>{S.library.encKeyStatus}
          </p>
        {:else}
          <p class="muted" role="status">{S.library.encNone}</p>
        {/if}
      {/if}
    </section>
    {/if}
  {/if}
</div>
