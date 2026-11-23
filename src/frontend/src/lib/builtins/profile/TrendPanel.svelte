<script>
  // Career trend (builtin profile panel): one match-scope metric across the
  // context's player's matches, as a sparkline. The picker offers every
  // match-scope metric in the default sequence and sends the metric NAME to
  // the series read. The picked metric is this panel's own view state.
  import { listMetrics, getCareerTrend, errText } from '../../services.js';
  import { inSequence } from '../../metricorder.js';
  import { fmtMetric, fmtPercent, fmtDate, fmtPatch } from '../../fmt.js';
  import { seed, remember } from '../../viewstate.svelte.js';
  import SuggestInput from '../../components/SuggestInput.svelte';
  import * as S from '../../strings/index.js';

  let { spectra, context } = $props();
  const steamId = $derived(context.steamId);

  const picked = seed('player-trend', { trend: 'adr' });
  // `metric` IS the metric NAME the series read takes.
  let metric = $state(picked.trend || 'adr');
  $effect(() => remember('player-trend', { trend: metric }));

  let trend = $state([]);
  let trendError = $state('');
  let trendDefs = $state([]);
  let trendText = $state('');
  // A plain counter (not state): the read's generation, so a stale result drops.
  let trendGen = 0;

  $effect(() => {
    let live = true;
    spectra.track(listMetrics())
      .then((defs) => {
        if (live) trendDefs = defs || [];
      })
      .catch(() => {
        if (live) trendDefs = []; // a failed catalog read offers nothing — never a guess
      });
    return () => (live = false);
  });

  // The default sequence over the match scope (no order preference is read).
  const trendItems = $derived(inSequence('match', trendDefs));

  // A selection the loaded catalog no longer carries falls back to the
  // default, but only from a non-default selection.
  $effect(() => {
    if (trendDefs.length === 0) return;
    if (metric !== 'adr' && !trendItems.some((d) => d.name === metric)) metric = 'adr';
  });

  const trendLabel = $derived.by(() => {
    const def = trendItems.find((d) => d.name === metric);
    if (def) return def.title || def.name;
    return metric === 'adr' ? S.profiles.thAdr : metric;
  });
  $effect(() => (trendText = trendLabel));

  // The picked metric's format tag: the trend formatter's input.
  const trendFormat = $derived(trendItems.find((d) => d.name === metric)?.format || '');

  // The trend read: mount, metric switch and Retry. The error clears only
  // when the read lands, so "No trend data" never stands in for a failed read.
  function loadTrend() {
    const sid = steamId;
    const m = metric;
    const my = ++trendGen;
    trendError = '';
    if (!sid) return;
    getCareerTrend(sid, m)
      .then((rows) => {
        if (my !== trendGen) return;
        trend = rows || [];
        trendError = '';
      })
      .catch((e) => {
        if (my === trendGen) trendError = errText(e);
      });
  }

  $effect(() => {
    loadTrend();
  });

  // The trend serves values at display scale already (percent 0..100), so
  // percent is the one divergence from the shared fmtMetric.
  function fmtTrendValue(v, format) {
    if (format === 'percent') return Number.isFinite(v) ? fmtPercent(v) : '—';
    return fmtMetric(v, format);
  }

  // Hand-rolled sparkline: x = Seq (the trend's patch order), y = Value. Each
  // dot's tooltip carries the patch and the honest import date, read off the
  // trend point itself.
  const spark = $derived.by(() => {
    const pts = trend;
    if (pts.length < 2) return null;
    const W = 640;
    const H = 130;
    const P = 10;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      if (p.seq < minX) minX = p.seq;
      if (p.seq > maxX) maxX = p.seq;
      if (p.value < minY) minY = p.value;
      if (p.value > maxY) maxY = p.value;
    }
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    const X = (x) => P + ((x - minX) / spanX) * (W - 2 * P);
    const Y = (y) => H - P - ((y - minY) / spanY) * (H - 2 * P);
    return {
      W,
      H,
      min: minY,
      max: maxY,
      line: pts.map((p) => `${X(p.seq).toFixed(1)},${Y(p.value).toFixed(1)}`).join(' '),
      dots: pts.map((p) => ({
        x: X(p.seq),
        y: Y(p.value),
        value: p.value,
        matchId: p.matchId,
        title: S.fill(S.profiles.trendImportedTitle, { patch: fmtPatch(p.patch), date: fmtDate(p.extractedAt), value: fmtTrendValue(p.value, trendFormat) }),
      })),
    };
  });
</script>

<section class="panel" class:builtin-busy={spectra.busy} aria-busy={spectra.busy}>
  <span class="builtin-throbber" aria-hidden="true"></span>
  <div class="row-between">
    <h2>{S.profiles.trendHeading}</h2>
    <!-- The trend's metric picker: ANY match-scope metric the catalog carries,
         offered through the one suggestion dropdown. -->
    <SuggestInput
      id="prof-trend"
      wrapClass="prof-trend-pick"
      kind="text"
      items={trendItems}
      text={(d) => d.title || d.name}
      placeholder={S.profiles.trendMetricSearch}
      ariaLabel={S.profiles.trendMetricAria}
      align="end"
      bind:value={trendText}
      onselect={(d) => {
        metric = d.name;
        trendText = d.title || d.name;
      }}
    />
  </div>
  {#if trendError}
    <p class="error" role="alert">
      {trendError}
      <button class="btn small" onclick={loadTrend}>{S.profiles.retry}</button>
    </p>
  {:else if spark}
    <svg
      class="prof-spark"
      viewBox="0 0 {spark.W} {spark.H}"
      role="img"
      aria-label="{trendLabel}{S.profiles.trendAriaLead}{trend.length}{S.profiles.trendAriaTail}"
    >
      <polyline points={spark.line} fill="none" stroke="var(--accent)" stroke-width="2" />
      {#each spark.dots as d, i (i)}
        <circle
          cx={d.x}
          cy={d.y}
          r="3.5"
          role="button"
          tabindex="0"
          aria-label={S.fill(S.profiles.openMatchDot, { title: d.title })}
          onclick={() => d.matchId && spectra.navigate(`/match/${d.matchId}`)}
          onkeydown={(e) =>
            (e.key === 'Enter' || e.key === ' ') &&
            (e.preventDefault(), d.matchId && spectra.navigate(`/match/${d.matchId}`))}
        >
          <title>{d.title}</title>
        </circle>
      {/each}
    </svg>
    <p class="muted prof-spark-cap">
      {trend.length}{S.profiles.sparkMinLead}{fmtTrendValue(spark.min, trendFormat)}{S.profiles.sparkMaxLead}{fmtTrendValue(spark.max, trendFormat)}
      {S.profiles.sparkFootnote}
    </p>
  {:else if trend.length === 1}
    <p class="muted" role="status">{S.profiles.onlyOneMatch}</p>
  {:else}
    <p class="muted" role="status">{S.profiles.noTrendData}</p>
  {/if}
</section>
