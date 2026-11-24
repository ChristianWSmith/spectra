<script>
  import { splitTable } from './splittable.svelte.js';
  // Weapons (builtin profile panel): kills, damage and headshots per weapon,
  // each cell one stored partitioned read for the context's player (the dim
  // is the weapon). Top rows by kills, then damage, then name.
  // Unverified before the wipe: weapon damage is a tick-join builtin (ruling 24).
  import { errText } from '../../services.js';
  import { liveMetrics } from '../../metricslive.svelte.js';
    import { fmtInt } from '../../fmt.js';
  import MetricCell from '../../components/MetricCell.svelte';
  import StatusChip from '../../components/StatusChip.svelte';
  import { dimsOf } from './shared.js';
  import * as S from '../../strings/index.js';

  let { spectra, context } = $props();
  const steamId = $derived(context.steamId);

  const SEEDS = ['weapon_kills', 'weapon_damage', 'weapon_headshots'];
  const TOP = 8;

  const sweep = liveMetrics();

  const table = splitTable(() => ({ spectra, steamId, seeds: SEEDS, errText, reload: sweep.reload, progress: sweep.progress }));
  const defs = $derived(table.defs);
  const reads = $derived(table.reads);
  const { cellFor, rawValue } = table;


  // Kills desc, then damage desc, then weapon name asc; the top rows only.
  const weapons = $derived(
    dimsOf(reads, SEEDS)
      .map((weapon) => ({ weapon, kills: rawValue('weapon_kills', weapon), damage: rawValue('weapon_damage', weapon) }))
      .sort(
        (a, b) =>
          (b.kills ?? -1) - (a.kills ?? -1) ||
          (b.damage ?? -1) - (a.damage ?? -1) ||
          (a.weapon < b.weapon ? -1 : a.weapon > b.weapon ? 1 : 0),
      )
      .slice(0, TOP),
  );
  const empty = $derived(table.empty);
</script>

<div>
  <h2>{S.profiles.weaponsPrefix}<span class="muted">{S.profiles.topPrefix}{weapons.length})</span></h2>
  <table class="data-table">
    <thead>
      <tr>
        <th scope="col">{S.profiles.thWeapon}</th>
        <th scope="col" class="num" title={defs.get('weapon_kills')?.doc}>{S.profiles.thKills}</th>
        <th scope="col" class="num" title={defs.get('weapon_damage')?.doc}>{S.profiles.thDamage}</th>
        <th scope="col" class="num" title={defs.get('weapon_headshots')?.doc}>{S.profiles.colHsHead}</th>
      </tr>
    </thead>
    <tbody>
      {#each weapons as w (w.weapon)}
        <tr>
          <td class="mono">{w.weapon}</td>
          {#each SEEDS as name (name)}
            {@const p = cellFor(name, w.weapon)}
            <td class="num" title={p.title}>
              <MetricCell pres={p} format={(v) => fmtInt(v)} chip={sweep.chip(defs.get(name))} />
            </td>
          {/each}
        </tr>
      {:else}
        <tr>
          <td colspan="4" class="muted">
            {#if empty}
              <StatusChip status={empty.state} title={empty.title} {...sweep.chip(empty.def)} />
            {:else}
              {S.profiles.noWeapons}
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
