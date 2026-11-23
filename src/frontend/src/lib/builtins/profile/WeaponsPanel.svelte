<script>
  // Weapons (builtin profile panel): kills, damage and headshots per weapon,
  // each cell one stored partitioned read for the context's player (the dim
  // is the weapon). Top rows by kills, then damage, then name.
  // Unverified before the wipe: weapon damage is a tick-join builtin (ruling 24).
  import { listMetrics, errText, subscribeMetricProgress, onMetricDone } from '../../services.js';
  import { metricProgressFrac, metricProgressStage, metricStateTitle } from '../../metricstate.js';
  import { fmtInt } from '../../fmt.js';
  import StatusChip from '../../components/StatusChip.svelte';
  import { cell, dimValue, dimsOf, emptyChip, loadSeeds } from './shared.js';
  import * as S from '../../strings/index.js';

  let { spectra, context } = $props();
  const steamId = $derived(context.steamId);

  const SEEDS = ['weapon_kills', 'weapon_damage', 'weapon_headshots'];
  const TOP = 8;

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
  const empty = $derived(emptyChip(defs, reads, progress, SEEDS));
</script>

<section class="panel">
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
              {#if p.kind === 'value'}
                {fmtInt(p.value)}
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
              {S.profiles.noWeapons}
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</section>
