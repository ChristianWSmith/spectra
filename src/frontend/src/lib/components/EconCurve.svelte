<script>
  // Hand-rolled SVG economy curve (no chart lib). Two TEAM lines per
  // round (equip value or net worth), winner strip beneath, hover readout,
  // click-through to the round detail.
  //
  // The lines follow the TEAMS, not the sides: each round's side is mapped
  // onto the team that played it with the canonical side-parity helper
  // (../sideparity.js teamKeyAt), so a side swap at halftime must not
  // change which line is which — the match winner's line is solid, the
  // match loser's dashed, so who-is-who stays readable after the switch.
  // The STROKE COLOR, in contrast, is a SIDE property: each team's line is
  // drawn as one <path> per SIDE era, recolored at every side switch
  // (.econ-line.side-ct/.side-t in public/style-m3a.css — the side colors
  // --ct/--t), because the color says which side that team held in those
  // rounds.
  import { fmtMoney } from '../fmt.js';
  import { teamKeyAt, flipIndexes, sideInEra } from '../sideparity.js';
  import { teamStartClass } from '../teams.js';
  import { econColumns, econValue } from '../econ.js';
  import { EQUIP_DEF, NETWORTH_DEF } from '../definitions.js';

  let {
    rows = [],
    id = 0,
    nav = () => {},
    sideSwitches = 0,
    matchWinner = '', // winner of the whole match, keyed by final side
    names = {}, // {ct, t} team display names, keyed by final side
  } = $props();

  const W = 1000;
  const H = 220;
  const PAD_TOP = 10;
  const PAD_BOTTOM = 10;

  let metric = $state('equip'); // 'equip' | 'networth'
  let hover = $state(-1); // hovered index into rows

  const n = $derived(rows.length);

  // Per-team value for one round, for the metric the toggle selects —
  // both series come from the canonical formulas in ../econ.js (equipment
  // value; net worth = equipment value + the side's unspent money at the
  // same freeze end, so net worth is never below equipment value).
  function valueOf(r, key) {
    return econValue(r, key, metric);
  }

  // Both columns of the hover tooltip, per team — the chart plots one of
  // them at a time.
  function columns(r, key) {
    return econColumns(r, key);
  }

  const series = $derived.by(() => {
    const ct = [];
    const tr = [];
    let max = 0;
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      // Which team played the CT side this round? Everything else is
      // keyed by the team's FINAL side, the key lib/teams.js names and
      // colors by, so each line stays one team across the switch.
      const ctKey = teamKeyAt('ct', i, n, sideSwitches);
      const ctVal = valueOf(r, 'ct');
      const tVal = valueOf(r, 't');
      const a = ctKey === 'ct' ? ctVal : tVal; // team that finished CT
      const b = ctKey === 'ct' ? tVal : ctVal; // team that finished T
      ct.push(a);
      tr.push(b);
      if (a > max) max = a;
      if (b > max) max = b;
    }
    if (max <= 0) max = 1;
    return { ct, tr, max };
  });

  // Team identity colors (started CT → indigo, started T → orange) and
  // display names, both keyed by the team's final side — these color the
  // LEGEND and the tooltip rows only; the chart strokes take their color
  // from the side (segments below). Unresolved side → '' class (no
  // guessed color); missing name → the bare side label.
  const clsCT = $derived(teamStartClass('ct', sideSwitches));
  const clsT = $derived(teamStartClass('t', sideSwitches));
  const nameCT = $derived(names.ct || 'CT');
  const nameT = $derived(names.t || 'T');
  const winnerKnown = $derived(matchWinner === 'ct' || matchWinner === 't');
  // The loser's line is the dashed one (every era segment of it); a match
  // with no decided winner (tie/abandoned) keeps both lines solid — and
  // with the legend hint retired, only the two legend swatches themselves
  // still read solid vs dashed (they stay identity-colored).
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

  // One polyline slice, index `from`..`to` INCLUSIVE: adjacent era
  // segments overlap on ONE vertex (the flip's predecessor — the segment
  // before ENDS there, the segment after STARTS there), so the two
  // <path>s share that point EXACTLY, the edge leading into the new
  // era's first round is drawn in the new era's color, and the drawn
  // line stays continuous where the color flips (the round linecap in
  // style-m3a.css closes the joint, so the shared vertex cannot show an
  // antialiasing seam between the two colors).
  function pathOver(vals, from, to) {
    let d = '';
    for (let i = from; i <= to; i++) {
      d += `${i === from ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(vals[i]).toFixed(1)}`;
      if (i < to) d += ' ';
    }
    return d;
  }

  // One <path> per TEAM per SIDE era. The stroke color follows the SIDE
  // the team held in that era (.econ-line.side-ct/.side-t — the side
  // colors --ct/--t), swapping at every side switch (era boundary); the
  // solid/dashed style follows the TEAM (loser → dashed on all of its
  // segments). Era edges are the counted-index flips (flipIndexes) —
  // rows here ARE the counted rounds index-for-index (store.GetEconomy's
  // SQL) — so era j spans from the predecessor of its OPENING flip (row
  // 0 for era 0) to the predecessor of its CLOSING flip (the final row
  // for the last era): the vertex just before each flip is the one the
  // two adjacent segments share (see pathOver above). Side unknown can't
  // happen for a 'ct'/'t' key (sideInEra only rejects a non-side), so
  // every segment gets exactly one side class.
  const segments = $derived.by(() => {
    const flips = flipIndexes(n, sideSwitches);
    const starts = [0, ...flips.map((f) => f - 1)];
    const ends = [...flips.map((f) => f - 1), n - 1];
    const out = [];
    for (const key of ['ct', 't']) {
      const vals = key === 'ct' ? series.ct : series.tr;
      const loser = key === 'ct' ? loserCT : loserT;
      for (let j = 0; j < starts.length; j++) {
        const side = sideInEra(key, sideSwitches, j);
        out.push({
          d: pathOver(vals, starts[j], ends[j]),
          cls: `econ-line ${side === 'ct' ? 'side-ct' : 'side-t'}`,
          loser,
        });
      }
    }
    return out;
  });

  const gridLines = $derived(
    [0, 0.25, 0.5, 0.75, 1].map((f) => yAt(series.max * f)),
  );

  // Strip mark: coarse BUY-CLASS comparison — equipment value is not
  // compared (a $100 equip difference says nothing), the buy type is.
  // Rank is full > force > everything else (eco/save/pistol/… all rank
  // equal — the label set mirrors internal/analytics/classify.go:
  // pistol|full|force|save|eco, unknown → null); missing/unknown on
  // either side stays neutral. ✓ = the winner bought the stronger class
  // (favorite held), ✗ = the cheaper-buys side won (upset), = (grabber
  // codicon) = even buy (toss-up), a codicon circle = no verdict
  // (unknown class or no winner). Class, not the toggled metric, so the
  // mark is stable across the toggle. The ✓/✗ values double as the
  // class:hold / class:upset sentinels below — only the RENDERED glyphs
  // differ from them.
  const CLASS_RANK = { full: 2, force: 1 };

  function classRank(c) {
    if (!c || c === 'unknown') return null; // unknown → neutral
    return CLASS_RANK[c] ?? 0;
  }

  // ranks is [winner class rank, loser class rank] for a decided round,
  // null when the round has no winner (both consumers map that to their
  // own neutral text).
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

  // verdict spells mark() out for the tooltip title (the legend carries
  // the same phrases).
  function verdict(r) {
    if (!r.winner) return 'no winner recorded';
    const rr = ranks(r);
    if (rr[0] === null || rr[1] === null) return 'unknown buy type — neutral';
    if (rr[0] > rr[1]) return 'favorite (higher buy type) held';
    if (rr[0] < rr[1]) return 'upset (lower buy type won)';
    return 'toss-up (even buy)';
  }

  function cellTitle(r) {
    const w = r.winner ? r.winner.toUpperCase() : '—';
    return `Round ${r.round} — ${w} wins · buy CT ${r.classCT || 'unknown'} / T ${r.classT || 'unknown'} · ${verdict(r)}${r.pistolRound ? ' · pistol' : ''}`;
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
      {metric === 'equip' ? 'Equip value per round' : 'Team net worth per round'}
    </h2>
    <div class="econ-curve-meta">
      {#if n > 0}
        <span class="econ-axis-note mono">0 – {fmtMoney(series.max)}</span>
      {/if}
      <div class="econ-toggle" role="group" aria-label="Curve metric">
        <button
          class="econ-toggle-btn"
          class:active={metric === 'equip'}
          aria-pressed={metric === 'equip'}
          title={EQUIP_DEF}
          onclick={() => (metric = 'equip')}>Equip value</button
        >
        <button
          class="econ-toggle-btn"
          class:active={metric === 'networth'}
          aria-pressed={metric === 'networth'}
          title={NETWORTH_DEF}
          onclick={() => (metric = 'networth')}>Net worth</button
        >
      </div>
    </div>
  </div>

  {#if n === 0}
    <p class="muted" role="status">No economy rows for this match.</p>
  {:else}
    <div class="econ-legend" aria-label="Team lines">
      <span class="econ-legend-item {clsCT}">
        <span class="econ-legend-line" class:loser={loserCT} aria-hidden="true"></span>
        {nameCT}
      </span>
      <span class="econ-legend-item {clsT}">
        <span class="econ-legend-line" class:loser={loserT} aria-hidden="true"></span>
        {nameT}
      </span>
    </div>

    <div
      class="econ-chart"
      onmousemove={onMove}
      onmouseleave={() => (hover = -1)}
      role="img"
      aria-label="{metric === 'equip' ? 'equipment value' : 'net worth'} per round, one line per team — hover for values, click a column to open the round"
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
        {#each segments as s, i (i)}
          <path class={s.cls} class:loser={s.loser} d={s.d} />
        {/each}
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
        {@const ctCols = columns(hoverRow, 'ct')}
        {@const tCols = columns(hoverRow, 't')}
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
          <div class="econ-tip-cols" aria-hidden="true">
            <span class:active={metric === 'equip'}>equip</span>
            <span class:active={metric === 'networth'}>net worth</span>
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
            class:upset={mark(r) === '✗'}
            >{#if mark(r) === '✓'}<span class="codicon codicon-check"></span>{:else if mark(r) === '✗'}<span class="codicon codicon-error"></span>{:else if mark(r) === '='}<span class="codicon codicon-grabber"></span>{:else}<span class="codicon codicon-circle-small"></span>{/if}</span
          >
        </button>
      {/each}
    </div>
    <p class="econ-strip-note muted">
      <span class="econ-strip-swatch pistol" aria-hidden="true"></span>
      pistol round · <span class="codicon codicon-check"></span> favorite (higher buy
      type) held · <span class="codicon codicon-error"></span> upset (lower buy type
      won) · <span class="codicon codicon-grabber"></span> even buy (toss-up) · <span
        class="codicon codicon-circle-small"></span> no verdict · click a round to open
      it
    </p>
  {/if}
</section>
