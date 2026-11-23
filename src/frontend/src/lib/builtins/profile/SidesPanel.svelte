<script>
  // CT / T breakdown (builtin profile panel): rounds, round win %, ADR, KAST %
  // and K/D per side, each cell one stored partitioned read for the context's
  // player (the dim is the side).
  import { listMetrics, errText, subscribeMetricProgress, onMetricDone } from '../../services.js';
  import { metricProgressFrac, metricProgressStage, metricStateTitle } from '../../metricstate.js';
  import { fmt1, fmt2, fmtPercent } from '../../fmt.js';
  import StatusChip from '../../components/StatusChip.svelte';
  import { cell, dimValue, emptyChip, loadSeeds } from './shared.js';
  import * as S from '../../strings/index.js';

  let { spectra, context } = $props();
  const steamId = $derived(context.steamId);

  const SEEDS = ['side_rounds', 'side_win_pct', 'side_adr', 'side_kast', 'side_kd'];

  let defs = $state(new Map());
  let reads = $state(new Map());
  let progress = $state(new Map());
  let reload = $state(0);

  $effect(() => subscribeMetricProgress((snap) => (progress = snap)));
  $effect(() => onMetricDone(() => (reload += 1)));

  // The player the shown values belong to (plain: it only gates the reset).
  let loadedFor = null;
  $effect(() => {
    reload;
    const sid = steamId;
    const newPlayer = sid !== loadedFor;
    loadedFor = sid;
    let live = true;
    if (newPlayer) defs = new Map();
    if (newPlayer) reads = new Map();
    if (!sid) return;
    listMetrics()
      .then((rows) => loadSeeds(spectra, SEEDS, rows || [], errText))
      .then((loaded) => {
        if (live) {
          defs = loaded.defs;
          reads = loaded.reads;
        }
      })
      .catch(() => {});
    return () => (live = false);
  });

  const hasDim = (dim) => SEEDS.some((n) => reads.get(n)?.rows?.some((r) => r.dim === dim));
  const sideRows = $derived(['ct', 't'].filter(hasDim));
  const cellFor = (name, dim) => cell(defs.get(name), reads.get(name), progress, dimValue(defs.get(name), reads.get(name), dim));
  const empty = $derived(emptyChip(defs, reads, progress, SEEDS));
</script>

<section class="panel prof-sides">
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
            <td class="num" title={p.title}>
              {#if p.kind === 'value'}
                {fmt(p.value)}
              {:else if p.kind === 'nodata'}
                —
              {:else}
                <StatusChip status={p.state} title={p.title} progress={metricProgressFrac(progress, defs.get(name)?.id)} stage={metricProgressStage(progress, defs.get(name)?.id)} />
              {/if}
            </td>
          {/each}
        </tr>
      {:else}
        <tr>
          <td colspan="6" class="muted">
            {#if empty}
              <StatusChip status={empty.state} title={metricStateTitle(empty.state, empty.read?.error)} progress={metricProgressFrac(progress, empty.def?.id)} stage={metricProgressStage(progress, empty.def?.id)} />
            {:else}
              {S.profiles.noSides}
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</section>
