<script>
  import { fmt1, fmt2, fmtPercent, S } from '../../builtinhelpers.js';
  import EmptyTableRow from '../../components/EmptyTableRow.svelte';
  import { splitTable } from './splittable.svelte.js';
  // CT / T breakdown (builtin profile panel): rounds, round win %, ADR, KAST %
  // and K/D per side, each cell one stored partitioned read for the context's
  // player (the dim is the side).
  import MetricTd from '../../components/MetricTd.svelte';

  let { spectra, context } = $props();
  const steamId = $derived(context.steamId);

  const SEEDS = ['side_rounds', 'side_win_pct', 'side_adr', 'side_kast', 'side_kd'];

  const table = splitTable(() => ({ spectra, steamId, seeds: SEEDS }));
  const sweep = table.sweep;
  const defs = $derived(table.defs);
  const reads = $derived(table.reads);
  const { cellFor } = table;

  const hasDim = (dim) => SEEDS.some((n) => reads.get(n)?.rows?.some((r) => r.dim === dim));
  const sideRows = $derived(['ct', 't'].filter(hasDim));
  const empty = $derived(table.empty);
</script>

<div class="prof-sides">
  <h2>{S.profiles.sidesHeading}</h2>
  <table class="data-table">
    <thead>
      <tr>
        <th scope="col">{S.profiles.thSide}</th>
        <th scope="col" class="num" title={defs.get('side_rounds')?.doc}>{S.profiles.thRounds}</th>
        <th scope="col" class="num" title={defs.get('side_win_pct')?.doc}>{S.profiles.thWinPct}</th>
        <th scope="col" class="num" title={defs.get('side_adr')?.doc}>{S.profiles.thAdr}</th>
        <th scope="col" class="num" title={defs.get('side_kast')?.doc}>{S.profiles.thKast}</th>
        <th scope="col" class="num" title={defs.get('side_kd')?.doc}>{S.profiles.colKdHead}</th>
      </tr>
    </thead>
    <tbody>
      {#each sideRows as side (side)}
        {@const c = (name) => cellFor(name, side)}
        <tr>
          <td><span class="chip side {side}">{side.toUpperCase()}</span></td>
          {#each [['side_rounds', (v) => v], ['side_win_pct', fmtPercent], ['side_adr', fmt1], ['side_kast', fmtPercent], ['side_kd', fmt2]] as [name, fmt] (name)}
            {@const p = c(name)}
            <MetricTd pres={p} format={(v) => fmt(v)} chip={sweep.chip(defs.get(name))} />
          {/each}
        </tr>
      {:else}
        <EmptyTableRow colspan={6} {empty} text={S.profiles.noSides} chip={sweep.chip(empty?.def)} />
      {/each}
    </tbody>
  </table>
</div>
