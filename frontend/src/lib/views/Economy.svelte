<script>
  import {
    getEconomy,
    getRounds,
    setPendingTimelineFilter,
    errText,
  } from '../services.js';
  import { fmtInt, fmtMoney } from '../fmt.js';
  import EconCurve from '../components/EconCurve.svelte';

  let { id = 0, nav = () => {} } = $props();

  let rows = $state([]); // non-warmup RoundEconomyRow[]
  let rounds = $state([]); // RoundRow[] (warmup counts / context)
  let loading = $state(true);
  let error = $state('');
  let whyOpen = $state(''); // `${round}:${side}` — expanded classWhy cell

  $effect(() => {
    let live = true;
    Promise.all([getEconomy(id), getRounds(id)])
      .then(([eco, rs]) => {
        if (!live) return;
        rows = (eco || []).filter((r) => !r.warmup);
        rounds = rs || [];
        loading = false;
        error = '';
      })
      .catch((e) => {
        if (live) {
          error = errText(e);
          loading = false;
        }
      });
    return () => (live = false);
  });

  const warmupSkipped = $derived(rounds.filter((r) => r.warmup).length);

  // Summary math (all deterministic sums/ratios over the stored rows —
  // badges per PRD §6.1; formulas live in each card's title).
  const summary = $derived.by(() => {
    let pistolWon = 0;
    let held = 0;
    let firstPistol = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.pistolRound) continue;
      const side = r.wonCT ? 'ct' : r.wonT ? 't' : '';
      if (!side) continue;
      if (!firstPistol) firstPistol = r.round;
      pistolWon++;
      const next = rows[i + 1]; // immediately following round in display order
      if (next && (side === 'ct' ? next.wonCT : next.wonT)) held++;
    }

    let forceTotal = 0;
    let forceWon = 0;
    let forceCT = 0;
    let forceCTT = 0;
    let forceT = 0;
    let forceTT = 0;
    let firstForce = 0;
    for (const r of rows) {
      if (r.classCT === 'force') {
        forceTotal++;
        forceCTT++;
        if (!firstForce) firstForce = r.round;
        if (r.wonCT) {
          forceWon++;
          forceCT++;
        }
      }
      if (r.classT === 'force') {
        forceTotal++;
        forceTT++;
        if (!firstForce) firstForce = r.round;
        if (r.wonT) {
          forceWon++;
          forceT++;
        }
      }
    }

    let gapSum = 0;
    let gapN = 0;
    let gapRound = 0;
    let gapBest = -Infinity;
    let lostCT = 0;
    let lostT = 0;
    let lostRound = 0;
    let lostBest = -Infinity;
    for (const r of rows) {
      let win;
      let lose;
      let loserIsCT;
      if (r.winner === 'ct') {
        win = r.spentCT;
        lose = r.spentT;
        loserIsCT = false;
      } else if (r.winner === 't') {
        win = r.spentT;
        lose = r.spentCT;
        loserIsCT = true;
      } else {
        continue;
      }
      const gap = (win || 0) - (lose || 0);
      gapSum += gap;
      gapN++;
      if (gap > gapBest) {
        gapBest = gap;
        gapRound = r.round;
      }
      const loserEquip = loserIsCT ? r.equipCT || 0 : r.equipT || 0;
      if (loserIsCT) lostCT += loserEquip;
      else lostT += loserEquip;
      if (loserEquip > lostBest) {
        lostBest = loserEquip;
        lostRound = r.round;
      }
    }

    return {
      pistolWon,
      held,
      firstPistol,
      forceTotal,
      forceWon,
      forceCT,
      forceCTT,
      forceT,
      forceTT,
      firstForce,
      avgGap: gapN ? Math.round(gapSum / gapN) : null,
      gapRound,
      lostCT,
      lostT,
      lostTotal: lostCT + lostT,
      lostRound,
    };
  });

  function drill(round) {
    if (!round) return;
    setPendingTimelineFilter({ round });
    nav(`/match/${id}/timeline`);
  }

  function toggleWhy(r, side) {
    const key = `${r.round}:${side}`;
    whyOpen = whyOpen === key ? '' : key;
  }

  const whyText = $derived.by(() => {
    if (!whyOpen) return null;
    const [rs, side] = whyOpen.split(':');
    const r = rows.find((x) => String(x.round) === rs);
    if (!r) return null;
    return {
      side,
      why: side === 'ct' ? r.classWhyCT : r.classWhyT,
      rule: r.ruleVersion,
    };
  });

  function classChip(side, r) {
    const cls = side === 'ct' ? r.classCT : r.classT;
    const why = side === 'ct' ? r.classWhyCT : r.classWhyT;
    return { cls: cls || 'unknown', why: why || 'no explanation recorded', rule: r.ruleVersion };
  }
</script>

<div class="econ-view">
  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if loading}
    <p class="muted">Loading economy…</p>
  {:else}
    <div class="econ-head">
      <span class="muted"
        >{rows.length} round{rows.length === 1 ? '' : 's'}
        {#if warmupSkipped > 0}· {warmupSkipped} warmup skipped{/if}</span
      >
      <span class="spacer"></span>
      <span class="muted econ-head-note"
        >buy classes are versioned rules — click a chip for the why</span
      >
    </div>

    <EconCurve {rows} {id} {nav} />

    <div class="econ-summary stat-grid">
      <button
        class="stat-cell"
        title="Formula: pistol rounds won by a side where that side also won the immediately following round ÷ pistol rounds won. Click: open timeline filtered to round {summary.firstPistol || '—'}."
        class:no-drill={!summary.firstPistol}
        onclick={() => drill(summary.firstPistol)}
      >
        <span class="stat-label"
          >Pistol → next round
          <span class="chip econ-badge-computed">computed</span></span
        >
        <span class="stat-value"
          >{summary.pistolWon ? `${summary.held}/${summary.pistolWon}` : '—'}</span
        >
        <span class="stat-sub">pistol wins held next round</span>
      </button>

      <button
        class="stat-cell"
        title="Formula: force-buy rounds won by the force-buying side ÷ all force-buy rounds (per side). Click: open timeline filtered to round {summary.firstForce || '—'}."
        class:no-drill={!summary.firstForce}
        onclick={() => drill(summary.firstForce)}
      >
        <span class="stat-label"
          >Force-buy win rate
          <span class="chip econ-badge-computed">computed</span></span
        >
        <span class="stat-value"
          >{summary.forceTotal
            ? Math.round((100 * summary.forceWon) / summary.forceTotal) + '%'
            : '—'}</span
        >
        <span class="stat-sub"
          >{summary.forceTotal
            ? `${summary.forceWon}/${summary.forceTotal} · CT ${summary.forceCT}/${summary.forceCTT} · T ${summary.forceT}/${summary.forceTT}`
            : 'no force buys'}</span
        >
      </button>

      <button
        class="stat-cell"
        title="Formula: mean over decided rounds of (winner spent − loser spent). Click: open timeline filtered to round {summary.gapRound || '—'} (largest gap)."
        class:no-drill={!summary.gapRound}
        onclick={() => drill(summary.gapRound)}
      >
        <span class="stat-label"
          >Winner spend advantage
          <span class="chip econ-badge-computed">computed</span></span
        >
        <span class="stat-value"
          >{summary.avgGap == null ? '—' : fmtMoney(summary.avgGap)}</span
        >
        <span class="stat-sub">avg winner − loser spend per round</span>
      </button>

      <button
        class="stat-cell"
        title="Formula: Σ losing side's freeze-end equipment value over decided rounds — inferred: assumes all losing-side equipment is destroyed (PRD §6.1). Click: open timeline filtered to round {summary.lostRound || '—'} (largest loss)."
        class:no-drill={!summary.lostRound}
        onclick={() => drill(summary.lostRound)}
      >
        <span class="stat-label"
          >Lost equipment
          <span class="chip econ-badge-inferred">inferred</span></span
        >
        <span class="stat-value">{fmtMoney(summary.lostTotal)}</span>
        <span class="stat-sub"
          >CT {fmtMoney(summary.lostCT)} · T {fmtMoney(summary.lostT)}</span
        >
      </button>
    </div>

    <section class="panel">
      <h2>Buy classification</h2>
      {#if rows.length === 0}
        <p class="muted">No classification rows.</p>
      {:else}
        <div class="table-scroll">
          <table class="data-table econ-table">
            <thead>
              <tr>
                <th scope="col" class="num">Rd</th>
                <th scope="col">Winner</th>
                <th scope="col">CT buy</th>
                <th scope="col">T buy</th>
                <th scope="col" class="num">Spent CT</th>
                <th scope="col" class="num">Spent T</th>
                <th scope="col" class="num">Loss CT</th>
                <th scope="col" class="num">Loss T</th>
              </tr>
            </thead>
            <tbody>
              {#each rows as r (r.round)}
                {@const ctc = classChip('ct', r)}
                {@const tc = classChip('t', r)}
                <tr>
                  <td class="num">
                    <button
                      class="btn small ghost econ-rd"
                      title="Open round {r.round}"
                      onclick={() => nav(`/match/${id}/round/${r.round}`)}
                      >{r.round}</button
                    >
                    {#if r.pistolRound}
                      <span
                        class="econ-pip pistol"
                        title="pistol round"></span>
                    {/if}
                  </td>
                  <td>
                    <span class="chip side {r.winner || 'none'}">
                      {r.winner ? r.winner.toUpperCase() : '—'}
                    </span>
                  </td>
                  <td>
                    <button
                      class="chip econ-cls {ctc.cls}"
                      title="{ctc.why} (rule v{ctc.rule}) — click for full text"
                      aria-expanded={whyOpen === `${r.round}:ct`}
                      onclick={() => toggleWhy(r, 'ct')}>{ctc.cls}</button
                    >
                  </td>
                  <td>
                    <button
                      class="chip econ-cls {tc.cls}"
                      title="{tc.why} (rule v{tc.rule}) — click for full text"
                      aria-expanded={whyOpen === `${r.round}:t`}
                      onclick={() => toggleWhy(r, 't')}>{tc.cls}</button
                    >
                  </td>
                  <td class="num">{fmtMoney(r.spentCT)}</td>
                  <td class="num">{fmtMoney(r.spentT)}</td>
                  <td class="num econ-loss">
                    {fmtInt(r.lossBonusCT)}
                    {#if r.inferredCT}
                      <span
                        class="chip econ-badge-inferred"
                        title="reconstructed from round results — inferred"
                        >inferred</span
                      >
                    {/if}
                  </td>
                  <td class="num econ-loss">
                    {fmtInt(r.lossBonusT)}
                    {#if r.inferredT}
                      <span
                        class="chip econ-badge-inferred"
                        title="reconstructed from round results — inferred"
                        >inferred</span
                      >
                    {/if}
                  </td>
                </tr>
                {#if whyOpen.startsWith(`${r.round}:`)}
                  <tr class="econ-why-row">
                    <td colspan="8">
                      <div class="econ-why">
                        <span class="chip econ-cls {whyText?.side === 'ct' ? ctc.cls : tc.cls}">
                          {whyText?.side === 'ct' ? ctc.cls : tc.cls}
                        </span>
                        <span class="econ-why-text"
                          >{whyText?.why || 'no explanation recorded'}</span
                        >
                        <span class="spacer"></span>
                        <span class="econ-why-rules mono"
                          >rule v{whyText?.rule ?? r.ruleVersion}</span
                        >
                        <button
                          class="btn small ghost"
                          aria-label="Close explanation"
                          onclick={() => (whyOpen = '')}><span class="codicon codicon-close"></span></button
                        >
                      </div>
                    </td>
                  </tr>
                {/if}
              {/each}
            </tbody>
          </table>
        </div>
        <p class="econ-table-note muted">
          Loss CT/T = the round loss bonus that side would collect by losing
          this round — CS2's ladder runs $1400 → $3400 in $500 steps: a loss
          steps it up, a win steps it down (never a full reset), and every
          half starts one level up (a pistol loss pays $1900);
          <span class="chip econ-badge-inferred">inferred</span> marks rows
          reconstructed from round results rather than recorded.
        </p>
      {/if}
    </section>
  {/if}
</div>
