<script>
  import {
    getEconomy,
    getRounds,
    getMatch,
    getTeamNames,
    getScoreboard,
    errText,
  } from '../services.js';
  import { fmtInt, fmtMoney } from '../fmt.js';
  import { replayHash, entryLoopSpan } from '../nav.js';
  import { teamKeyAt, winnerTeamKey } from '../sideparity.js';
  import { roundStartTick, roundEndTick, separatorFlags } from '../rounds.js';
  import { listedPlayers } from '../players.js';
  import { teamNames } from '../teams.js';
  import { EQUIP_DEF } from '../definitions.js';
  import EconCurve from '../components/EconCurve.svelte';
  import StatCard from '../components/StatCard.svelte';
  import WinnerCell from '../components/WinnerCell.svelte';

  let { id = 0, nav = () => {} } = $props();

  let rows = $state([]); // non-warmup models.EconomyRow[]
  let rounds = $state([]); // RoundRow[] (warmup counts / context)
  let match = $state(null); // models.Match — side switches + final score
  let names = $state({ ct: 'CT', t: 'T' }); // team names, final-side keyed
  let loading = $state(true);
  let error = $state('');
  let whyOpen = $state(''); // `${round}:${side}` — expanded classWhy cell

  $effect(() => {
    let live = true;
    Promise.all([
      getEconomy(id),
      getRounds(id),
      getMatch(id).catch(() => null),
      getTeamNames(id).catch(() => null),
      getScoreboard(id, 'kills', true).catch(() => []),
    ])
      .then(([eco, rs, m, tn, sb]) => {
        if (!live) return;
        rows = (eco || []).filter((r) => !r.warmup);
        rounds = rs || [];
        match = m;
        // Team display names, keyed by each team's FINAL side — demo clan
        // name → synthesized team_<player> → bare side (lib/teams.js).
        names = teamNames({
          ctName: tn?.ct || '',
          tName: tn?.t || '',
          players: listedPlayers(sb) || [],
        });
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

  // Loss-bonus values are never read from the demo — the store
  // reconstructs them from round results (store.GetEconomy →
  // applyLossBonuses), so EVERY row is inferred. The fact/inference badge
  // therefore sits once per loss-bonus column header, not once per cell.
  const lossInferredCT = $derived(rows.some((r) => r.inferredCT));
  const lossInferredT = $derived(rows.some((r) => r.inferredT));

  // Sides swap at halftime, so a side never names a team: every per-team
  // rollup below resolves each round's side through the canonical
  // side-parity helper (teamKeyAt), keyed by the team's final side —
  // the same key the display names and identity colors use.
  const sideSwitches = $derived(match?.sideSwitches || 0);

  // Side-switch boundary per row (index-aligned with `rows`): the
  // canonical separator gating (lib/rounds.js separatorFlags — cadence +
  // counted-gating + trailing suppression). Row i carries the boundary
  // that follows row i-1 as its `.split-before` class (public/style.css,
  // the table twin of RoundStrip's `.round-split`), so the interleaved
  // econ-why-row stays attached ABOVE the line and the last row can never
  // carry a trailing one. The projection to `{number}` is only the row
  // SHAPE: isCounted/separatorAfter read `number` (extract's renumber —
  // see lib/rounds.js), while models.EconomyRow keys its round as
  // `round`. `rows` is counted-only (the store's SQL), so the ordinals
  // separatorAfter expects are exactly these round numbers.
  const sepFlags = $derived(separatorFlags(rows.map((r) => ({ number: r.round }))));

  // Winner cell label for ONE buy-types row: the TEAM that won that
  // round, resolved by the canonical round-number parity
  // (sideparity.winnerTeamKey) and looked up in `names` (keyed by final
  // side — teamNames above). Unknown → '' so WinnerCell falls back to
  // the bare side chip, never a guessed name.
  function winnerName(r) {
    const key = winnerTeamKey(rounds, sideSwitches, r.round, r.winner);
    return key ? names[key] : '';
  }

  // Winner of the WHOLE match, keyed by final side (the final score is
  // already keyed by final side); a tie or unfinished match has none.
  const matchWinner = $derived.by(() => {
    if (!match) return '';
    const ct = match.scoreCT || 0;
    const t = match.scoreT || 0;
    return ct === t ? '' : ct > t ? 'ct' : 't';
  });

  // Summary math (all deterministic sums/ratios over the stored rows —
  // badges per PRD §6.1; formulas live in each card's title).
  const summary = $derived.by(() => {
    const counted = rows.length;
    const sw = sideSwitches;

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

    // Force buys, per TEAM: a side's force-buy round is a force-buy round
    // of whichever team played that side in that round (a round both
    // teams force-bought counts for each of them).
    const force = { ct: { won: 0, total: 0 }, t: { won: 0, total: 0 } };
    let firstForce = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const forceSides = [];
      if (r.classCT === 'force') forceSides.push('ct');
      if (r.classT === 'force') forceSides.push('t');
      for (const side of forceSides) {
        const key = teamKeyAt(side, i, counted, sw);
        if (!key) continue; // unknown side → no guessed team
        force[key].total++;
        if (side === 'ct' ? r.wonCT : r.wonT) force[key].won++;
        if (!firstForce) firstForce = r.round;
      }
    }

    // Winner advantage + lost equipment: both compare the round's two
    // SIDES (winner vs loser that round), while the lost equipment is
    // credited to the TEAM that lost it.
    let gapSum = 0;
    let gapN = 0;
    let gapRound = 0;
    let gapBest = -Infinity;
    const lost = { ct: 0, t: 0 };
    let lostRound = 0;
    let lostBest = -Infinity;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      let win;
      let lose;
      let loserSide;
      if (r.winner === 'ct') {
        win = r.equipCT;
        lose = r.equipT;
        loserSide = 't';
      } else if (r.winner === 't') {
        win = r.equipT;
        lose = r.equipCT;
        loserSide = 'ct';
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
      const loserEquip = loserSide === 'ct' ? r.equipCT || 0 : r.equipT || 0;
      const loserKey = teamKeyAt(loserSide, i, counted, sw);
      if (loserKey) lost[loserKey] += loserEquip;
      if (loserEquip > lostBest) {
        lostBest = loserEquip;
        lostRound = r.round;
      }
    }

    return {
      pistolWon,
      held,
      firstPistol,
      force,
      forceTotal: force.ct.total + force.t.total,
      forceWon: force.ct.won + force.t.won,
      firstForce,
      avgGap: gapN ? Math.round(gapSum / gapN) : null,
      gapRound,
      lost,
      lostTotal: lost.ct + lost.t,
      lostRound,
    };
  });

  // Stat-card drill → WATCH the round: ROUND-LEVEL loop (the round IS
  // the sequence — the owner's watch rule: a round-level button loops the
  // round's own start→end span, freeze included, never ±10 s around its
  // edges, which would bleed into the previous round's end / the next
  // round's freeze). The start tick is stamped as ?tick= (the seek —
  // nav.entrySeekTick) and the span as ?loop= BESIDE it
  // (nav.entryLoopSpan — the SAME helper RoundDetail's "Watch round" and
  // CompareRounds' "Replay start" stamp, so the three agree byte for
  // byte). No landmark FILTER: outside the replay, buttons seek.
  function drill(round) {
    if (!round) return;
    const start = roundStartTick(rounds, round);
    // An unknown end (round not loaded / row without a usable end tick)
    // stamps NO loop rather than a guessed bound — entryLoopSpan yields
    // undefined and buildHash drops it; the seek still lands.
    const end = roundEndTick(rounds, round);
    nav(
      replayHash(
        id,
        {},
        { tick: start, loop: entryLoopSpan(start, end), back: `match/${id}/economy` },
      ),
    );
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

<div class="view econ-view">
  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if loading}
    <p class="muted" role="status">Loading economy…</p>
  {:else}
    <div class="econ-head">
      <span class="muted"
        >{rows.length} round{rows.length === 1 ? '' : 's'}
        {#if warmupSkipped > 0}· {warmupSkipped} warmup skipped{/if}</span
      >
      <span class="spacer"></span>
      <span class="muted econ-head-note"
        >buy types follow saved rules — click a chip for the reason</span
      >
    </div>

    <EconCurve {rows} {id} {nav} {sideSwitches} matchWinner={matchWinner} {names} />

    <div class="econ-summary stat-grid">
      <StatCard
        label="Pistol → next round"
        value={summary.pistolWon ? `${summary.held}/${summary.pistolWon}` : '—'}
        sub="pistol wins held next round"
        cls={!summary.firstPistol ? 'no-drill' : ''}
        title="Formula: pistol rounds won by a side where that side also won the immediately following round ÷ pistol rounds won. Click: watch round {summary.firstPistol || '—'} in the replay (the round's own span, start→end)."
        onclick={() => drill(summary.firstPistol)}
      >
        {#snippet badge()}<span class="chip badge-computed">computed</span>{/snippet}
      </StatCard>

      <StatCard
        label="Force-buy win rate"
        value={summary.forceTotal
          ? Math.round((100 * summary.forceWon) / summary.forceTotal) + '%'
          : '—'}
        sub={summary.forceTotal
          ? `${names.ct} ${summary.force.ct.won}/${summary.force.ct.total} · ${names.t} ${summary.force.t.won}/${summary.force.t.total}`
          : 'no force buys'}
        cls={!summary.firstForce ? 'no-drill' : ''}
        title="Formula: force-buy rounds won by the force-buying TEAM ÷ that team's own force-buy rounds, attributed per team across the halftime side switch (a round both teams force-bought counts once for each). Click: watch round {summary.firstForce || '—'} in the replay (the round's own span, start→end)."
        onclick={() => drill(summary.firstForce)}
      >
        {#snippet badge()}<span class="chip badge-computed">computed</span>{/snippet}
      </StatCard>

      <StatCard
        label="Winner equipment value advantage"
        value={summary.avgGap == null ? '—' : fmtMoney(summary.avgGap)}
        sub="avg winner − loser equip per round"
        cls={!summary.gapRound ? 'no-drill' : ''}
        title="Formula: average across decided rounds of (winner equipment value − loser equipment value) at freeze time end — the value of the gear each side actually holds (weapons carried over from earlier rounds included), never this round's spend. Click: watch round {summary.gapRound || '—'} (largest gap) in the replay (the round's own span, start→end)."
        onclick={() => drill(summary.gapRound)}
      >
        {#snippet badge()}<span class="chip badge-computed">computed</span>{/snippet}
      </StatCard>

      <StatCard
        label="Lost equipment"
        value={fmtMoney(summary.lostTotal)}
        sub={`${names.ct} ${fmtMoney(summary.lost.ct)} · ${names.t} ${fmtMoney(summary.lost.t)}`}
        cls={!summary.lostRound ? 'no-drill' : ''}
        title="Formula: total across decided rounds of the losing team's freeze-end equipment value, credited to the team that lost it rather than the side it played — inferred: assumes all losing-side equipment is destroyed. Click: watch round {summary.lostRound || '—'} (largest loss) in the replay (the round's own span, start→end)."
        onclick={() => drill(summary.lostRound)}
      >
        {#snippet badge()}<span class="chip badge-inferred">inferred</span>{/snippet}
      </StatCard>
    </div>

    <section class="panel">
      <h2>Buy types</h2>
      {#if rows.length === 0}
        <p class="muted" role="status">No buy types recorded yet.</p>
      {:else}
        <div class="table-scroll">
          <table class="data-table econ-table">
            <thead>
              <tr>
                <th scope="col" class="num">RD</th>
                <th scope="col">Winner</th>
                <th scope="col">CT buy</th>
                <th scope="col">T buy</th>
                <th scope="col" class="num" title={EQUIP_DEF}>Equip CT</th>
                <th scope="col" class="num" title={EQUIP_DEF}>Equip T</th>
                <th scope="col" class="num">
                  Loss CT
                  {#if lossInferredCT}
                    <span
                      class="chip badge-inferred"
                      title="calculated from the round results"
                      >inferred</span
                    >
                  {/if}
                </th>
                <th scope="col" class="num">
                  Loss T
                  {#if lossInferredT}
                    <span
                      class="chip badge-inferred"
                      title="calculated from the round results"
                      >inferred</span
                    >
                  {/if}
                </th>
              </tr>
            </thead>
            <tbody>
              {#each rows as r, ri (r.round)}
                {@const ctc = classChip('ct', r)}
                {@const tc = classChip('t', r)}
                <tr class:split-before={ri > 0 && sepFlags[ri - 1]}>
                  <td class="num">
                    <button
                      class="btn small ghost econ-rd"
                      title="Open round {r.round}"
                      onclick={() => nav(`/match/${id}/round/${r.round}`)}
                      >{r.round}</button
                    >
                  </td>
                  <td>
                    <WinnerCell winner={r.winner} name={winnerName(r)} />
                  </td>
                  <td>
                    <button
                      class="chip econ-cls {ctc.cls}"
                      title="{ctc.why} (rules v{ctc.rule}) — click for full text"
                      aria-expanded={whyOpen === `${r.round}:ct`}
                      onclick={() => toggleWhy(r, 'ct')}>{ctc.cls}</button
                    >
                  </td>
                  <td>
                    <button
                      class="chip econ-cls {tc.cls}"
                      title="{tc.why} (rules v{tc.rule}) — click for full text"
                      aria-expanded={whyOpen === `${r.round}:t`}
                      onclick={() => toggleWhy(r, 't')}>{tc.cls}</button
                    >
                  </td>
                  <td class="num">{fmtMoney(r.equipCT)}</td>
                  <td class="num">{fmtMoney(r.equipT)}</td>
                  <td class="num econ-loss">{fmtInt(r.lossBonusCT)}</td>
                  <td class="num econ-loss">{fmtInt(r.lossBonusT)}</td>
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
                          >rules v{whyText?.rule ?? r.ruleVersion}</span
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
          Equip CT/T = that side's equipment value at freeze time end — the
          value of the gear its players actually hold (weapons picked up and
          carried over from earlier rounds included), never this round's
          spend; the chart's Net worth = that equipment value + the side's
          unspent money at the same instant, so it is never below equipment
          value (the glossary's Net worth entry has the full rule); Loss CT/T =
          the round loss bonus that side would collect by losing
          this round — CS2's ladder runs $1400 → $3400 in $500 steps: a loss
          steps it up, a win steps it down (never a full reset), and every
          half starts one level up (a pistol loss pays $1900);
          <span class="chip badge-inferred">inferred</span> on the Loss headers
          marks those values as calculated from the round results rather than
          recorded.
        </p>
      {/if}
    </section>
  {/if}
</div>
