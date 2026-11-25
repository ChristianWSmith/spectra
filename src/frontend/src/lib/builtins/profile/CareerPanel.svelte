<script>
  import { whenCurrent, whileCurrent } from '../../current.js';
  import ErrorBanner from '../../components/ErrorBanner.svelte';
  // Career headline cards (builtin profile panel). The profile-scope metrics
  // of the default selection (DEFAULT_CARDS.profile, in the default sequence),
  // one card each. Every value is one metric() read for the context's player.
  // Pinning is retired (owner ruling 33): this panel shows the default set and
  // reads no preference.
  import { errText } from '../../services.js';
  import { liveMetrics } from '../../metricslive.svelte.js';
  import { fmtMetric } from '../../fmt.js';
  import StatCard from '../../components/StatCard.svelte';
  import MetricCell from '../../components/MetricCell.svelte';
  import { loadProfile, readCell, defaultCardDefs } from './shared.js';
  import { readMetrics } from '../../metricreads.js';
  import * as S from '../../strings/index.js';

  let { spectra, context } = $props();
  const steamId = $derived(context.steamId);

  let defs = $state([]);
  let wins = $state(null);
  let reads = $state(new Map());
  let loadError = $state('');
  const sweep = liveMetrics();

  // The cards: the default profile selection, in the default sequence.
  const cardDefs = $derived(defaultCardDefs(defs));

  // The player the shown values belong to (plain: it only gates the reset).
  let loadedFor = null;
  $effect(() =>
    whileCurrent((isCurrent) => {
      sweep.reload;
      const sid = steamId;
      const newPlayer = sid !== loadedFor;
      loadedFor = sid;
      if (newPlayer) reads = new Map();
      if (!sid) return;
      loadProfile(spectra, sid)
        .then(async ([rows, profile]) => {
          if (!isCurrent()) return;
          loadError = '';
          defs = rows || [];
          wins = profile ? profile.wins : null;
          const names = defaultCardDefs(defs).map((d) => d.name);
          const next = await readMetrics(spectra, names, errText);
          if (isCurrent()) reads = next;
        })
        .catch(
          whenCurrent(isCurrent, (e) => {
            loadError = errText(e);
          }),
        );
    }),
  );
</script>

{#if loadError}
  <ErrorBanner>{S.profiles.careerErrorLead}{loadError}</ErrorBanner>
{/if}
<div class="prof-career">
  <div class="stat-grid prof-stats">
    {#each cardDefs as def (def.id)}
      {@const read = reads.get(def.name)}
      {@const pres = readCell(def, read, sweep.progress)}
      <!-- One tile per metric. The cell's own title carries the state; the
           label's title carries the metric's doc. -->
      <StatCard
        label={def.title || def.name}
        labelTitle={def.doc || def.name}
        sub={def.name === 'career_matches' && wins != null ? `${wins} wins` : undefined}
        title={pres.title}
      >
        {#snippet valueSlot()}
          <MetricCell {pres} format={(v) => fmtMetric(v, def.format)} chip={sweep.chip(def)} />
        {/snippet}
      </StatCard>
    {/each}
  </div>
</div>
