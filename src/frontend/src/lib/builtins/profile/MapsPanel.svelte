<script>
  import EmptyTableRow from '../../components/EmptyTableRow.svelte';
  import { compareAsc } from '../../sortstate.js';
  import { DASH } from '../../builtinhelpers.js';
  import { openRow } from '../../keys.js';
  import { splitTable } from './splittable.svelte.js';
  // Per-map breakdown (builtin profile panel): matches, wins and ADR per map,
  // each cell one stored partitioned read for the context's player (the dim
  // is the map). A row opens the Library filtered to this player and map.
  import { errText } from '../../services.js';
  import { fmt1 } from '../../fmt.js';
  import MetricTd from '../../components/MetricTd.svelte';
  import { dimsOf } from './shared.js';
  import * as S from '../../strings/index.js';

  let { spectra, context } = $props();
  const steamId = $derived(context.steamId);

  const SEEDS = ['map_matches', 'map_wins', 'map_adr'];

  const table = splitTable(() => ({ spectra, steamId, seeds: SEEDS, errText }));
  const sweep = table.sweep;
  const defs = $derived(table.defs);
  const reads = $derived(table.reads);
  const { cellFor, rawValue } = table;

  // Most matches first, then the map name.
  const maps = $derived(
    dimsOf(reads, SEEDS)
      .map((map) => ({ map, matches: rawValue('map_matches', map) }))
      .sort((a, b) => (b.matches ?? -1) - (a.matches ?? -1) || compareAsc(a.map, b.map)),
  );
  const empty = $derived(table.empty);

  // Opens the Library filtered to this player's matches on that map (the
  // route query is the Library's receiving contract).
  function openMapInLibrary(map) {
    if (!map || !steamId) return;
    spectra.navigate({ path: '/library', query: { map, player: steamId } });
  }
</script>

<div>
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
          title={S.fill(S.profiles.openMapTitle, { map: m.map || DASH })}
          {...openRow(() => openMapInLibrary(m.map))}
        >
          <td>{m.map || DASH}</td>
          {#each [['map_matches', (v) => v], ['map_wins', (v) => v], ['map_adr', fmt1]] as [name, fmt] (name)}
            {@const p = cellFor(name, m.map)}
            <MetricTd pres={p} format={(v) => fmt(v)} chip={sweep.chip(defs.get(name))} />
          {/each}
        </tr>
      {:else}
        <EmptyTableRow colspan={4} {empty} text={S.profiles.noMaps} chip={sweep.chip(empty?.def)} />
      {/each}
    </tbody>
  </table>
</div>
