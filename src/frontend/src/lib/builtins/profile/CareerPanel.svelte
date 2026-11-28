<script>
  import { loadThen, whileCurrent, liveMetrics, fmtMetric } from 'spectra/helpers';
  // Career headline cards (builtin profile panel). The profile-scope metrics
  // of the default selection (DEFAULT_CARDS.profile, in the default sequence),
  // one card each. Every value is one metric() read for the context's player.
  // Pinning is retired (owner ruling 33): this panel shows the default set and
  // reads no preference.
  import { StatCard } from 'spectra/helpers';
  import { MetricCell } from 'spectra/helpers';
  import { loadProfile, readCell, defaultCardDefs } from 'spectra/helpers';

  let { spectra, context } = $props();
  const steamId = $derived(context.steamId);

  let defs = $state([]);
  let wins = $state(null);
  let reads = $state(new Map());
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
      loadThen(
        isCurrent,
        loadProfile(spectra, sid),
        async ([rows, profile]) => {
          if (!isCurrent()) return;
          defs = rows || [];
          wins = profile ? profile.wins : null;
          const names = defaultCardDefs(defs).map((d) => d.name);
          const next = await spectra.readMetrics(names);
          if (isCurrent()) reads = next;
        },
        (e) => spectra.report(e),
      );
    }),
  );
</script>

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
