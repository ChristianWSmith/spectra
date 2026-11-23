<script>
  // Explorer's static reference card (builtin, standalone only: ExplorerView
  // does not mount it in the Match view's Details tab). A SHORT summary of the
  // golden demo's network-message census, not a dump, and the encryption line
  // for the match in the context.
  import * as S from '../../strings/index.js';
  import { getProvenance } from '../../services.js';
  import { fmtInt } from '../../fmt.js';

  let { spectra, context } = $props();

  const REF_BULLETS = [
    S.library.refUserCommands,
    S.library.refVoiceData,
    S.library.refSosSounds,
    S.library.refBallistics,
  ];

  let prov = $state(null);
  let provGen = 0;

  $effect(() => {
    const id = context.matchId;
    if (!id) return;
    const my = ++provGen;
    spectra.track(getProvenance(id))
      .then((p) => {
        if (my === provGen) prov = p;
      })
      .catch(() => {
        // The import-details panel shows a failed provenance read; this card
        // simply shows no encryption line.
        if (my === provGen) prov = null;
      });
  });
</script>

<section class="panel expl-ref" class:builtin-busy={spectra.busy} aria-busy={spectra.busy}>
  <span class="builtin-throbber" aria-hidden="true"></span>
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
