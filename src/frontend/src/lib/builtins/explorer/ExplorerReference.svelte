<script>
  // Explorer's static reference card (builtin, standalone only: ExplorerView
  // does not mount it in the Match view's Details tab). A SHORT summary of the
  // golden demo's network-message census, not a dump, and the encryption line
  // for the match in the context.
  import * as S from '../../strings/index.js';
  import { getProvenance } from '../../services.js';
  import { fmtInt } from '../../fmt.js';

  let { context } = $props();

  const REF_BULLETS = [
    'UserCommands dominate: 1,367,690 of 1,965,413 total messages (POV input history).',
    'CSVCMsg_VoiceData fires 123,507 times — the Opus chunks voice playback decodes.',
    'CMsgSosStartSoundEvent 25,266 / legacy game events 21,029 — sound + pre-S2 event layers.',
    'Ballistics-adjacent: CMsgTEFireBullets 3,302 + CMsgPlaceDecalEvent 1,514.',
  ];

  let prov = $state(null);
  let provGen = 0;

  $effect(() => {
    const id = context.matchId;
    if (!id) return;
    const my = ++provGen;
    prov = null;
    getProvenance(id)
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
