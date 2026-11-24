<script>
  import { activateOnKey } from '../../keys.js';
  import { economySource } from '../../economysource.svelte.js';
  import * as S from '../../strings/index.js';
  import { fmtMoney, moneyResetIndexes, flipIndexes, eraOf, sideInEra, teamKeyAt, teamStartClass, econColumns, econValue, hashOf, loadEconomy } from '../../builtinhelpers.js';

  // Economy curve: hand-drawn SVG, one line per team, the winner strip under it.
  // Mounted by a composer, the economy comes from it (the props below). Mounted alone (a component preview),
  // the panel loads the match's economy itself, so it shows the real data either way.
  let { spectra, context, back = '', ...given } = $props();
  const src = economySource(() => ({ spectra, context, given }));
  const rows = $derived(src.rows);
  const names = $derived(src.names);
  const sideSwitches = $derived(src.sideSwitches);
  const matchWinner = $derived(src.matchWinner);


  const W = 1000;
  const H = 220;
  const PAD_TOP = 10;
  const PAD_BOTTOM = 10;
  const EQUIP_DEF = S.economy.equipDef;
  const NETWORTH_DEF = S.economy.netWorthDef;

  let metric = $state('equip');
  let hover = $state(-1);

  const n = $derived(rows.length);

  const series = $derived.by(() => {
    const ct = [];
    const tr = [];
    let max = 0;
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      const ctKey = teamKeyAt('ct', i, n, sideSwitches);
      const ctVal = econValue(r, 'ct', metric);
      const tVal = econValue(r, 't', metric);
      const a = ctKey === 'ct' ? ctVal : tVal;
      const b = ctKey === 'ct' ? tVal : ctVal;
      ct.push(a);
      tr.push(b);
      if (a > max) max = a;
      if (b > max) max = b;
    }
    if (max <= 0) max = 1;
    return { ct, tr, max };
  });

  const clsCT = $derived(teamStartClass('ct', sideSwitches));
  const clsT = $derived(teamStartClass('t', sideSwitches));
  const nameCT = $derived(names.ct || S.match.sideCt);
  const nameT = $derived(names.t || S.match.sideT);
  const winnerKnown = $derived(matchWinner === 'ct' || matchWinner === 't');
  const loserCT = $derived(winnerKnown && matchWinner === 't');
  const loserT = $derived(winnerKnown && matchWinner === 'ct');

  const hoverRow = $derived(hover >= 0 ? rows[hover] || null : null);
  const hoverPct = $derived(n > 0 && hover >= 0 ? ((hover + 0.5) / n) * 100 : 50);

  function xAt(i) {
    return n > 0 ? ((i + 0.5) / n) * W : 0;
  }

  function yAt(v) {
    return PAD_TOP + (1 - v / series.max) * (H - PAD_TOP - PAD_BOTTOM);
  }

  function vertex(vals, i) {
    return xAt(i).toFixed(1) + ',' + yAt(vals[i]).toFixed(1);
  }

  function pathOf(points) {
    const pts = points.length === 1 ? [points[0], points[0]] : points;
    return pts.map((p, i) => (i === 0 ? 'M' : 'L') + p).join(' ');
  }

  // One path per team per money era: never drawn across a money reset.
  const segments = $derived.by(() => {
    const flips = flipIndexes(n, sideSwitches);
    const bounds = [0, ...moneyResetIndexes(n), n];
    const out = [];
    for (const key of ['ct', 't']) {
      const vals = key === 'ct' ? series.ct : series.tr;
      const loser = key === 'ct' ? loserCT : loserT;
      for (let j = 0; j + 1 < bounds.length; j++) {
        const from = bounds[j];
        const to = bounds[j + 1] - 1;
        if (from > to) continue;
        const side = sideInEra(key, sideSwitches, eraOf(from, flips));
        const pts = [];
        for (let i = from; i <= to; i++) pts.push(vertex(vals, i));
        out.push({ d: pathOf(pts), cls: 'econ-line ' + (side === 'ct' ? 'side-ct' : 'side-t'), loser });
      }
    }
    return out;
  });

  const gridLines = $derived([0, 0.25, 0.5, 0.75, 1].map((f) => yAt(series.max * f)));

  // The buy-class verdict: the favourite held, the upset, an even buy or no verdict.
  const CLASS_RANK = { full: 2, force: 1 };

  function classRank(c) {
    if (!c || c === 'unknown') return null;
    return CLASS_RANK[c] ?? 0;
  }

  function ranks(r) {
    if (!r.winner) return null;
    return [
      classRank(r.winner === 'ct' ? r.classCT : r.classT),
      classRank(r.winner === 'ct' ? r.classT : r.classCT),
    ];
  }

  function mark(r) {
    const rr = ranks(r);
    if (!rr || rr[0] === null || rr[1] === null) return '·';
    if (rr[0] > rr[1]) return '✓';
    if (rr[0] < rr[1]) return '✗';
    return '=';
  }

  function verdict(r) {
    if (!r.winner) return S.economy.verdictNoWinner;
    const rr = ranks(r);
    if (rr[0] === null || rr[1] === null) return S.economy.verdictUnknown;
    if (rr[0] > rr[1]) return S.economy.verdictFavorite;
    if (rr[0] < rr[1]) return S.economy.verdictUpset;
    return S.economy.verdictEven;
  }

  function cellTitle(r) {
    const w = r.winner ? r.winner.toUpperCase() : '—';
    return S.economy.cellRound + r.round + ' — ' + w + S.economy.cellWinsBuy + (r.classCT || 'unknown') + S.economy.cellBuySep + (r.classT || 'unknown') + ' · ' + verdict(r) + (r.pistolRound ? S.economy.cellPistol : '');
  }

  function openRound(round) {
    spectra.navigate(hashOf('/match/' + context.matchId + '/rounds', { round }));
  }

  function columns(r, key) {
    return econColumns(r, key);
  }

  function onMove(e) {
    if (n <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    hover = Math.min(n - 1, Math.max(0, Math.floor(frac * n)));
  }
</script>

<div class="econ-curve-panel">
  <div class="row-between econ-curve-head">
    <h2>{metric === 'equip' ? S.economy.curveHeadEquip : S.economy.curveHeadNetWorth}</h2>
    <div class="econ-curve-meta">
      {#if n > 0}
        <span class="econ-axis-note mono">0 – {fmtMoney(series.max)}</span>
      {/if}
      <div class="econ-toggle" role="group" aria-label="{S.economy.curveMetricGroup}">
        <button class="econ-toggle-btn" class:active={metric === 'equip'} aria-pressed={metric === 'equip'} title={EQUIP_DEF} onclick={() => (metric = 'equip')}>{S.economy.curveToggleEquip}</button>
        <button class="econ-toggle-btn" class:active={metric === 'networth'} aria-pressed={metric === 'networth'} title={NETWORTH_DEF} onclick={() => (metric = 'networth')}>{S.economy.curveToggleNetWorth}</button>
      </div>
    </div>
  </div>

  {#if n === 0}
    <p class="muted" role="status">{S.economy.noRows}</p>
  {:else}
    <div class="econ-legend" aria-label="{S.economy.curveLegendLabel}">
      <span class="econ-legend-item {clsCT}">
        <span class="econ-legend-line" class:loser={loserCT} aria-hidden="true"></span>
        {nameCT}
      </span>
      <span class="econ-legend-item {clsT}">
        <span class="econ-legend-line" class:loser={loserT} aria-hidden="true"></span>
        {nameT}
      </span>
    </div>

    <div class="econ-chart" onmousemove={onMove} onmouseleave={() => (hover = -1)} role="img"
      aria-label={(metric === 'equip' ? S.economy.curveAriaEquip : S.economy.curveAriaNetWorth) + S.economy.curveAriaSuffix}
    >
      <svg viewBox="0 0 {W} {H}" preserveAspectRatio="none">
        {#each rows as r, i (r.round)}
          {#if r.pistolRound}
            <rect class="econ-pistol-band" x={i * (W / n)} y="0" width={W / n} height={H} />
          {/if}
        {/each}
        {#each gridLines as y, i (i)}
          <line class="econ-grid-line" x1="0" x2={W} y1={y} y2={y} />
        {/each}
        {#each segments as s, i (i)}
          <path class={s.cls} class:loser={s.loser} d={s.d} />
        {/each}
        {#if hover >= 0}
          <line class="econ-guide" x1={xAt(hover)} x2={xAt(hover)} y1="0" y2={H} />
        {/if}
        {#each rows as r, i (r.round)}
          <rect class="econ-hit" x={i * (W / n)} y="0" width={W / n} height={H} role="button" tabindex="0"
            aria-label={S.economy.openRoundAria + r.round}
            onclick={() => openRound(r.round)}
            onkeydown={activateOnKey(() => openRound(r.round))}
          >
            <title>{S.economy.cellRound}{r.round}</title>
          </rect>
        {/each}
      </svg>

      {#if hoverRow}
        {@const ctCols = columns(hoverRow, 'ct')}
        {@const tCols = columns(hoverRow, 't')}
        <div class="econ-tooltip" style="left:{hoverPct}%">
          <div class="econ-tip-head">
            <strong>{S.economy.cellRound}{hoverRow.round}</strong>
            <span class="chip side {hoverRow.winner || 'none'}">{hoverRow.winner ? hoverRow.winner.toUpperCase() : '—'}</span>
            {#if hoverRow.pistolRound}
              <span class="chip econ-cls pistol">{S.economy.chipPistol}</span>
            {/if}
          </div>
          <div class="econ-tip-cols" aria-hidden="true">
            <span class:active={metric === 'equip'}>{S.economy.tipEquip}</span>
            <span class:active={metric === 'networth'}>{S.economy.curveAriaNetWorth}</span>
          </div>
          <div class="econ-tip-row">
            <span class={clsCT}>{nameCT}</span>
            <span class="mono">{fmtMoney(ctCols.equip)}</span>
            <span class="mono">{fmtMoney(ctCols.net)}</span>
          </div>
          <div class="econ-tip-row">
            <span class={clsT}>{nameT}</span>
            <span class="mono">{fmtMoney(tCols.equip)}</span>
            <span class="mono">{fmtMoney(tCols.net)}</span>
          </div>
        </div>
      {/if}
    </div>

    <div class="econ-strip" aria-label="{S.economy.stripLabel}">
      {#each rows as r (r.round)}
        <button class="econ-strip-cell" class:ct={r.winner === 'ct'} class:t={r.winner === 't'} class:pistol={r.pistolRound}
          title={cellTitle(r)} aria-label={S.economy.openRoundAria + r.round} onclick={() => openRound(r.round)}
        >
          <span class="econ-strip-num">{r.round}</span>
          <span class="econ-strip-mark" class:hold={mark(r) === '✓'} class:upset={mark(r) === '✗'}
            >{#if mark(r) === '✓'}<span class="codicon codicon-check"></span>{:else if mark(r) === '✗'}<span class="codicon codicon-error"></span>{:else if mark(r) === '='}<span class="codicon codicon-grabber"></span>{:else}<span class="codicon codicon-circle-small"></span>{/if}</span
          >
        </button>
      {/each}
    </div>
    <p class="econ-strip-note muted">
      <span class="econ-strip-swatch pistol" aria-hidden="true"></span> {S.economy.stripPistol} <span class="codicon codicon-check"></span> {S.economy.stripFavorite} <span class="codicon codicon-error"></span> {S.economy.stripUpset} <span class="codicon codicon-grabber"></span> {S.economy.stripEven} <span class="codicon codicon-circle-small"></span> {S.economy.stripNoVerdict}
    </p>
  {/if}
</div>
