<script>
  // Per-map breakdown (builtin profile panel): matches, wins and ADR per map,
  // each cell one stored partitioned read for the context's player (the dim
  // is the map). A row opens the Library filtered to this player and map.
  import { listMetrics, errText, subscribeMetricProgress, onMetricDone } from '../../services.js';
  import { metricProgressFrac, metricProgressStage, metricStateTitle } from '../../metricstate.js';
  import { fmt1 } from '../../fmt.js';
  import StatusChip from '../../components/StatusChip.svelte';
  import { cell, dimValue, dimsOf, emptyChip, loadSeeds } from './shared.js';
  import * as S from '../../strings/index.js';

  let { spectra, context } = $props();
  const steamId = $derived(context.steamId);

  const SEEDS = ['map_matches', 'map_wins', 'map_adr'];

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

  const cellFor = (name, dim) => cell(defs.get(name), reads.get(name), progress, dimValue(defs.get(name), reads.get(name), dim));
  const rawValue = (name, dim) => dimValue(defs.get(name), reads.get(name), dim);

  // Most matches first, then the map name.
  const maps = $derived(
    dimsOf(reads, SEEDS)
      .map((map) => ({ map, matches: rawValue('map_matches', map) }))
      .sort((a, b) => (b.matches ?? -1) - (a.matches ?? -1) || (a.map < b.map ? -1 : a.map > b.map ? 1 : 0)),
  );
  const empty = $derived(emptyChip(defs, reads, progress, SEEDS));

  // Opens the Library filtered to this player's matches on that map (the
  // route query is the Library's receiving contract).
  function openMapInLibrary(map) {
    if (!map || !steamId) return;
    spectra.navigate({ path: '/library', query: { map, player: steamId } });
  }
</script>

<section class="panel">
  <h2>{S.profiles.mapsHeading}</h2>
  <table class="data-table">
    <thead>
      <tr>
        <th scope="col">{S.profiles.thMap}</th>
        <th scope="col" class="num" title={defs.get('map_matches')?.doc}>{S.profiles.thMatches}</th>
        <th scope="col" class="num" title={defs.get('map_wins')?.doc}>{S.profiles.thWins}</th>
        <th scope="col" class="num" title={defs.get('map_adr')?.doc}>{S.profiles.thAdr}</th>
      </tr>
    </thead>
    <tbody>
      {#each maps as m (m.map)}
        <tr
          class="clickable"
          tabindex="0"
          title={S.fill(S.profiles.openMapTitle, { map: m.map || '—' })}
          onclick={() => openMapInLibrary(m.map)}
          onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), openMapInLibrary(m.map))}
        >
          <td>{m.map || '—'}</td>
          {#each [['map_matches', (v) => v], ['map_wins', (v) => v], ['map_adr', fmt1]] as [name, fmt] (name)}
            {@const p = cellFor(name, m.map)}
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
          <td colspan="4" class="muted">
            {#if empty}
              <StatusChip status={empty.state} title={metricStateTitle(empty.state, empty.read?.error)} progress={metricProgressFrac(progress, empty.def?.id)} stage={metricProgressStage(progress, empty.def?.id)} />
            {:else}
              {S.profiles.noMaps}
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</section>
