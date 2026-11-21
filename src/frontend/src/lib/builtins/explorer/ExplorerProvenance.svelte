<script>
  // Explorer's import-details panel (builtin, composed by ExplorerView): the
  // reproducibility facts of one match (parser, import time, voice, warnings,
  // status) and the encrypted-message note. The match is the context's.
  import * as S from '../../strings/index.js';
  import { getProvenance, errText } from '../../services.js';
  import { fmtDate, fmtInt } from '../../fmt.js';
  import StatusChip from '../../components/StatusChip.svelte';

  let { context } = $props();

  let prov = $state(null);
  let provError = $state('');
  // One generation per read: a stale reply (a match switch, a Retry) is dropped.
  let provGen = 0;

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

  $effect(() => {
    const id = context.matchId;
    if (!id) return;
    loadProv(id);
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

<section class="panel">
  <h2>{S.library.importDetails}</h2>
  {#if provError}
    <p class="error" role="alert">
      {provError}
      <button class="btn small" onclick={() => loadProv(context.matchId)}>{S.library.retry}</button>
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
