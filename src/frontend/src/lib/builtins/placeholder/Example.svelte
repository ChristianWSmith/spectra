<script>
  import * as S from '../../strings/index.js';
  // A small example: the rounds of the chosen match, or the chosen player.
  let { spectra, context } = $props();

  const matchId = $derived(context.matchId);
  const steamId = $derived(context.steamId);

  const rounds = $derived(
    matchId == null
      ? null
      : spectra.query('SELECT number, winner FROM rounds WHERE match_id = :match_id ORDER BY number'),
  );
</script>

<section class="example" class:builtin-busy={spectra.busy} aria-busy={spectra.busy}>
  {#if matchId != null}
    {#await rounds then r}
      <p>{S.componentbuilder.exampleRounds}{r.rows.length}</p>
      <ol>
        {#each r.rows as [number, winner] (number)}
          <li>{S.componentbuilder.exampleRound}{number}: {winner || '-'}</li>
        {/each}
      </ol>
    {:catch}
      <p>-</p>
    {/await}
  {:else if steamId}
    <p>{S.componentbuilder.examplePlayer}{steamId}</p>
  {:else}
    <p>{S.componentbuilder.exampleChoose}</p>
  {/if}
</section>

<style>
  .example ol {
    margin: 0;
    padding-left: 1.4em;
  }
</style>
