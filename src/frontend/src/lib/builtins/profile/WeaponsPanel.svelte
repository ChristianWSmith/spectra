<script>
  import EmptyTableRow from '../../components/EmptyTableRow.svelte';
  import { compareAsc } from '../../sortstate.js';
  import { splitTable } from './splittable.svelte.js';
  // Weapons (builtin profile panel): kills, damage and headshots per weapon,
  // each cell one stored partitioned read for the context's player (the dim
  // is the weapon). Top rows by kills, then damage, then name.
  // Unverified before the wipe: weapon damage is a tick-join builtin (ruling 24).
  import { errText } from '../../services.js';
  import { fmtInt } from '../../fmt.js';
  import MetricTd from '../../components/MetricTd.svelte';
  import { dimsOf } from './shared.js';
  import * as S from '../../strings/index.js';

  let { spectra, context } = $props();
  const steamId = $derived(context.steamId);

  const SEEDS = ['weapon_kills', 'weapon_damage', 'weapon_headshots'];
  const TOP = 8;

  const table = splitTable(() => ({ spectra, steamId, seeds: SEEDS, errText }));
  const sweep = table.sweep;
  const defs = $derived(table.defs);
  const reads = $derived(table.reads);
  const { cellFor, rawValue } = table;

  // Kills desc, then damage desc, then weapon name asc; the top rows only.
  const weapons = $derived(
    dimsOf(reads, SEEDS)
      .map((weapon) => ({
        weapon,
        kills: rawValue('weapon_kills', weapon),
        damage: rawValue('weapon_damage', weapon),
      }))
      .sort(
        (a, b) =>
          (b.kills ?? -1) - (a.kills ?? -1) ||
          (b.damage ?? -1) - (a.damage ?? -1) ||
          compareAsc(a.weapon, b.weapon),
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
            <MetricTd pres={p} format={(v) => fmtInt(v)} chip={sweep.chip(defs.get(name))} />
          {/each}
        </tr>
      {:else}
        <EmptyTableRow colspan={4} {empty} text={S.profiles.noWeapons} chip={sweep.chip(empty?.def)} />
      {/each}
    </tbody>
  </table>
</div>
