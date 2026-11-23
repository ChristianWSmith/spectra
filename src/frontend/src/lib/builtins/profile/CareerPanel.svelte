<script>
  // Career headline cards (builtin profile panel). The profile-scope metrics
  // of the default selection (DEFAULT_CARDS.profile, in the default sequence),
  // one card each. Every value is one metric() read for the context's player.
  // Pinning is retired (owner ruling 33): this panel shows the default set and
  // reads no preference.
  import { listMetrics, getProfile, errText, subscribeMetricProgress, onMetricDone } from '../../services.js';
  import { DEFAULT_CARDS, composedSequence } from '../../metricorder.js';
  import { metricProgressFrac, metricProgressStage } from '../../metricstate.js';
  import { fmtMetric } from '../../fmt.js';
  import StatCard from '../../components/StatCard.svelte';
  import StatusChip from '../../components/StatusChip.svelte';
  import { cell, failedRead } from './shared.js';
  import * as S from '../../strings/index.js';

  let { spectra, context } = $props();
  const steamId = $derived(context.steamId);

  let defs = $state([]);
  let wins = $state(null);
  let reads = $state(new Map());
  let progress = $state(new Map());
  let reload = $state(0);
  let loadError = $state('');

  $effect(() => subscribeMetricProgress((snap) => (progress = snap)));
  $effect(() => onMetricDone(() => (reload += 1)));

  // The cards: the default profile selection, in the default sequence.
  const cardDefs = $derived(
    composedSequence('profile', defs)
      .filter((e) => e.kind === 'metric' && DEFAULT_CARDS.profile.includes(e.name))
      .map((e) => e.def),
  );

  // The player the shown values belong to (plain: it only gates the reset).
  let loadedFor = null;
  $effect(() => {
    reload;
    const sid = steamId;
    const newPlayer = sid !== loadedFor;
    loadedFor = sid;
    let live = true;
    if (newPlayer) reads = new Map();
    if (!sid) return;
    spectra.track(Promise.all([listMetrics(), getProfile(sid)]))
      .then(async ([rows, profile]) => {
        if (!live) return;
        loadError = '';
        defs = rows || [];
        wins = profile ? profile.wins : null;
        const names = composedSequence('profile', defs)
          .filter((e) => e.kind === 'metric' && DEFAULT_CARDS.profile.includes(e.name))
          .map((e) => e.name);
        const results = await Promise.all(names.map((n) => spectra.metric(n).catch((e) => failedRead(e, errText))));
        if (live) reads = new Map(names.map((n, i) => [n, results[i]]));
      })
      .catch((e) => {
        if (live) loadError = errText(e);
      });
    return () => (live = false);
  });
</script>

{#if loadError}
  <p class="error" role="alert">{S.profiles.careerErrorLead}{loadError}</p>
{/if}
<div class="prof-career">
  <div class="stat-grid prof-stats">
    {#each cardDefs as def (def.id)}
      {@const read = reads.get(def.name)}
      {@const pres = cell(def, read, progress, read && read.state === 'fresh' ? read.value : null)}
      <!-- One tile per metric. The cell's own title carries the state; the
           label's title carries the metric's doc. -->
      <StatCard
        label={def.title || def.name}
        labelTitle={def.doc || def.name}
        sub={def.name === 'career_matches' && wins != null ? `${wins} wins` : undefined}
        title={pres.title}
      >
        {#snippet valueSlot()}
          {#if pres.kind === 'value'}
            {fmtMetric(pres.value, def.format)}
          {:else if pres.kind === 'nodata'}
            —
          {:else}
            <StatusChip
              status={pres.state}
              title={pres.title}
              progress={metricProgressFrac(progress, def.id)}
              stage={metricProgressStage(progress, def.id)}
            />
          {/if}
        {/snippet}
      </StatCard>
    {/each}
  </div>
</div>
