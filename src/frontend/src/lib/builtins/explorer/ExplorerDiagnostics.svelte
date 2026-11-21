<script>
  // Explorer's advanced-diagnostics panel (builtin, composed by ExplorerView):
  // the entity summary of one match. The match is the context's.
  import * as S from '../../strings/index.js';
  import { getEntitySummary, errText } from '../../services.js';
  import { fmtInt } from '../../fmt.js';
  import StatusChip from '../../components/StatusChip.svelte';

  let { context } = $props();

  let entities = $state(null);
  let entError = $state('');
  let entGen = 0;

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
    const id = context.matchId;
    if (!id) return;
    loadEnt(id);
  });
</script>

<section class="panel">
  <h2>{S.library.advancedDiagnostics}</h2>
  {#if entError}
    <p class="error" role="alert">
      {entError}
      <button class="btn small" onclick={() => loadEnt(context.matchId)}>{S.library.retry}</button>
    </p>
  {:else if !entities}
    <p class="muted" role="status"><StatusChip block detail={S.library.loadingDetail} /></p>
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
