<script>
  // Hand-rolled SVG economy curve (no chart lib). Two team lines
  // per round (equip value or money), winner strip beneath, hover readout,
  // click-through to the round detail.
  let { rows = [], id = 0, nav = () => {} } = $props();

  const W = 1000;
  const H = 220;
  const PAD_TOP = 10;
  const PAD_BOTTOM = 10;

  let metric = $state('equip'); // 'equip' | 'money'
  let hover = $state(-1); // hovered index into rows

  const n = $derived(rows.length);

  const series = $derived.by(() => {
    const [ck, tk] =
      metric === 'equip' ? ['equipCT', 'equipT'] : ['moneyCT', 'moneyT'];
    const ct = rows.map((r) => Number(r[ck]) || 0);
    const tr = rows.map((r) => Number(r[tk]) || 0);
    let max = 0;
    for (const v of ct) if (v > max) max = v;
    for (const v of tr) if (v > max) max = v;
    if (max <= 0) max = 1;
    return { ct, tr, max };
  });

  const hoverRow = $derived(hover >= 0 ? rows[hover] || null : null);
  const hoverPct = $derived(n > 0 && hover >= 0 ? ((hover + 0.5) / n) * 100 : 50);

  function xAt(i) {
    return n > 0 ? ((i + 0.5) / n) * W : 0;
  }

  function yAt(v) {
    return PAD_TOP + (1 - v / series.max) * (H - PAD_TOP - PAD_BOTTOM);
  }

  function line(vals) {
    return vals
      .map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`)
      .join(' ');
  }

  const pathCT = $derived(line(series.ct));
  const pathT = $derived(line(series.tr));

  const gridLines = $derived(
    [0, 0.25, 0.5, 0.75, 1].map((f) => yAt(series.max * f)),
  );

  function money(v) {
    return '$' + Math.round(v).toLocaleString();
  }

  // Strip mark: ✓ = the winner also led on freeze-end equip (favorite held),
  // ✗ = upset (lower-equip team won). Equip, not the toggled metric, so the
  // mark is stable across the toggle.
  function mark(r) {
    if (!r.winner) return '·';
    const win = r.winner === 'ct' ? r.equipCT : r.equipT;
    const lose = r.winner === 'ct' ? r.equipT : r.equipCT;
    return win >= lose ? '✓' : '✗';
  }

  function cellTitle(r) {
    const w = r.winner ? r.winner.toUpperCase() : '—';
    const m =
      r.winner === 'ct'
        ? `${money(r.equipCT)} vs ${money(r.equipT)}`
        : `${money(r.equipT)} vs ${money(r.equipCT)}`;
    return `Round ${r.round} — ${w} wins · equip CT ${money(r.equipCT)} / T ${money(r.equipT)} · winner equip ${m} · ${mark(r) === '✗' ? 'upset (lower-equip side won)' : 'favorite held'}${r.pistolRound ? ' · pistol' : ''}`;
  }

  function onMove(e) {
    if (n <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    hover = Math.min(n - 1, Math.max(0, Math.floor(frac * n)));
  }
</script>

<section class="panel econ-curve-panel">
  <div class="row-between econ-curve-head">
    <h2>
      {metric === 'equip' ? 'Equip value per round' : 'Team money per round'}
    </h2>
    <div class="econ-curve-meta">
      {#if n > 0}
        <span class="econ-axis-note mono">0 – {money(series.max)}</span>
      {/if}
      <div class="econ-toggle" role="group" aria-label="Curve metric">
        <button
          class="econ-toggle-btn"
          class:active={metric === 'equip'}
          aria-pressed={metric === 'equip'}
          onclick={() => (metric = 'equip')}>Equip value</button
        >
        <button
          class="econ-toggle-btn"
          class:active={metric === 'money'}
          aria-pressed={metric === 'money'}
          onclick={() => (metric = 'money')}>Money</button
        >
      </div>
    </div>
  </div>

  {#if n === 0}
    <p class="muted">No economy rows for this match.</p>
  {:else}
    <div
      class="econ-chart"
      onmousemove={onMove}
      onmouseleave={() => (hover = -1)}
      role="img"
      aria-label="{metric} per round — hover for values, click a column to open the round"
    >
      <svg viewBox="0 0 {W} {H}" preserveAspectRatio="none">
        {#each rows as r, i (r.round)}
          {#if r.pistolRound}
            <rect
              class="econ-pistol-band"
              x={i * (W / n)}
              y="0"
              width={W / n}
              height={H}
            />
          {/if}
        {/each}
        {#each gridLines as y, i (i)}
          <line class="econ-grid-line" x1="0" x2={W} y1={y} y2={y} />
        {/each}
        <path class="econ-line-ct" d={pathCT} />
        <path class="econ-line-t" d={pathT} />
        {#if hover >= 0}
          <line
            class="econ-guide"
            x1={xAt(hover)}
            x2={xAt(hover)}
            y1="0"
            y2={H}
          />
        {/if}
        {#each rows as r, i (r.round)}
          <rect
            class="econ-hit"
            x={i * (W / n)}
            y="0"
            width={W / n}
            height={H}
            role="button"
            tabindex="0"
            aria-label="Open round {r.round}"
            onclick={() => nav(`/match/${id}/round/${r.round}`)}
            onkeydown={(e) =>
              (e.key === 'Enter' || e.key === ' ') &&
              nav(`/match/${id}/round/${r.round}`)}
          >
            <title>Round {r.round}</title>
          </rect>
        {/each}
      </svg>

      {#if hoverRow}
        <div class="econ-tooltip" style="left:{hoverPct}%">
          <div class="econ-tip-head">
            <strong>Round {hoverRow.round}</strong>
            <span class="chip side {hoverRow.winner || 'none'}">
              {hoverRow.winner ? hoverRow.winner.toUpperCase() : '—'}
            </span>
            {#if hoverRow.pistolRound}
              <span class="chip econ-cls pistol">pistol</span>
            {/if}
          </div>
          <div class="econ-tip-row">
            <span class="ct">CT</span>
            <span class="mono"
              >{money(
                metric === 'equip' ? hoverRow.equipCT : hoverRow.moneyCT,
              )}</span
            >
          </div>
          <div class="econ-tip-row">
            <span class="t">T</span>
            <span class="mono"
              >{money(
                metric === 'equip' ? hoverRow.equipT : hoverRow.moneyT,
              )}</span
            >
          </div>
          <div class="econ-tip-row muted">
            <span>spent CT/T</span>
            <span class="mono">{money(hoverRow.spentCT)} / {money(hoverRow.spentT)}</span>
          </div>
        </div>
      {/if}
    </div>

    <div class="econ-strip" aria-label="Round strip">
      {#each rows as r (r.round)}
        <button
          class="econ-strip-cell"
          class:ct={r.winner === 'ct'}
          class:t={r.winner === 't'}
          class:pistol={r.pistolRound}
          title={cellTitle(r)}
          aria-label="Open round {r.round}"
          onclick={() => nav(`/match/${id}/round/${r.round}`)}
        >
          <span class="econ-strip-num">{r.round}</span>
          <span
            class="econ-strip-mark"
            class:hold={mark(r) === '✓'}
            class:upset={mark(r) === '✗'}>{mark(r)}</span
          >
        </button>
      {/each}
    </div>
    <p class="econ-strip-note muted">
      <span class="econ-strip-swatch pistol" aria-hidden="true"></span>
      pistol round · ✓ favorite (higher equip) held · ✗ upset · click a round
      to open it
    </p>
  {/if}
</section>
