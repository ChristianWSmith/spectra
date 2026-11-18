<script>
  import * as S from '../strings/index.js';
  import {
    getEconomy,
    getRounds,
    getMatch,
    getTeamNames,
    getScoreboard,
    getPlayerRounds,
    listMetrics,
    getMetricValuesForMatch,
    errText,
  } from '../services.js';
  import { fmtMoney, fmtMetric } from '../fmt.js';
  import { replayHash, entryLoopSpan } from '../nav.js';
  import { buildHash } from '../router.js';
  import { winnerTeamKey } from '../sideparity.js';
  import { roundStartTick, roundEndTick, separatorFlags } from '../rounds.js';
  import { lossPips } from '../econ.js';
  import { listedPlayers } from '../players.js';
  import { teamNames } from '../teams.js';
  import EconCurve from '../components/EconCurve.svelte';
  import StatCard from '../components/StatCard.svelte';
  import WinnerCell from '../components/WinnerCell.svelte';
  import EventPlay from '../components/EventPlay.svelte';
  import StatusChip from '../components/StatusChip.svelte';

  let { id = 0, nav = () => {} } = $props();

  let rows = $state([]); // models.EconomyRow[]
  let rounds = $state([]); // RoundRow[] (round context)
  // player_round_stats rows for the match (models.PlayerRoundStat — one
  // per player per round, with that round's side sample): the record
  // behind the table's per-round death columns (fold below).
  let playerRounds = $state([]);
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
      getPlayerRounds(id).catch(() => []),
    ])
      .then(([eco, rs, m, tn, sb, prs]) => {
        if (!live) return;
        rows = eco || [];
        rounds = rs || [];
        playerRounds = prs || [];
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

  // The table's per-round death columns (owner, 2026-11-18): CT Deaths
  // / T Deaths — one number per SIDE per ROUND, folded from the
  // per-round player RECORD (player_round_stats, read through the one
  // getPlayerRounds fetch; internal/analytics rounds.go counts those
  // deaths at analyze time). Criterion: ROUND-grain values come from
  // round records; MATCH-grain statistics come from metrics — the
  // metrics system cannot express a round at all (metric rows are
  // addressed per player/team/match subject and partitioned only by
  // side/map/weapon — internal/metrics compile.go Address), so no
  // metric path exists at round grain. A side with no player rows in a
  // round (no side sample / not analyzed) is UNKNOWN — the dash, never
  // a fabricated 0.
  const deathsByRound = $derived.by(() => {
    const out = new Map();
    for (const pr of playerRounds) {
      if (pr.side !== 'ct' && pr.side !== 't') continue;
      let e = out.get(pr.round);
      if (!e) {
        e = { ct: null, t: null };
        out.set(pr.round, e);
      }
      e[pr.side] = (e[pr.side] ?? 0) + (pr.deaths || 0);
    }
    return out;
  });
  const deathsFor = (round, side) => deathsByRound.get(round)?.[side] ?? null;

  // The four summary CARDS read their stored metric rows: pistol/gap
  // (the builtins pistol_hold / avg_equip_gap — plan §8 M8 rows,
  // seeded over the next() round window and the diff() row
  // difference) and force/lost (team_force_wins / team_force_rounds /
  // lost_equip / team_lost_equip — the view-aggregate relocation, ME8
  // exception audit: the last view-computed card numbers). name →
  // {format, rows} or absent when the catalog lacks the seed / no row
  // is fresh / the read fails — the honest dash, never a locally
  // recomputed number (the value computations retired with these
  // migrations; their oracles live in internal/metrics'
  // econ_equivalence_test). THE canonical read pair: listMetrics to
  // resolve the seed names, then the ONE getMetricValuesForMatch call —
  // same pattern as the scoreboard and Reports.
  let cardMetrics = $state({});
  $effect(() => {
    let live = true;
    listMetrics()
      .then((defs) => {
        const byName = new Map((defs || []).map((d) => [d && d.name, d]));
        const wanted = [
          'pistol_hold',
          'avg_equip_gap',
          'team_force_wins',
          'team_force_rounds',
          'lost_equip',
          'team_lost_equip',
        ]
          .map((n) => byName.get(n))
          .filter((d) => d);
        if (!wanted.length) return undefined;
        return getMetricValuesForMatch(id, wanted.map((d) => d.id)).then((values) => {
          if (!live) return;
          const out = {};
          for (const d of wanted) {
            out[d.name] = {
              format: d.format,
              rows: (values || []).filter((v) => v.metricId === d.id),
            };
          }
          cardMetrics = out;
        });
      })
      .catch(() => {
        // A failed read leaves the slots absent → the dash (never a
        // fabricated value); the main load's error banner still owns
        // the view-level failure indication.
      });
    return () => (live = false);
  });

  // One metric's MATCH-subject stored row (subjectKey '') or null — the
  // dash gate every match-subject card value uses.
  function matchRow(name) {
    const m = cardMetrics[name];
    if (!m) return null;
    const row = m.rows.find((v) => v.subjectKey === '');
    return row ? { value: row.value, format: m.format } : null;
  }

  // One metric's TEAM-subject stored values keyed by team key
  // ('ct'/'t'); null unless BOTH teams' rows are present — a
  // half-present pair is unknown, never half-rendered (absent =
  // unknown, never 0).
  function teamValues(name) {
    const m = cardMetrics[name];
    if (!m) return null;
    const out = {};
    for (const row of m.rows) out[row.subjectKey] = row.value;
    return 'ct' in out && 't' in out ? out : null;
  }

  // fmtStored renders one stored row through its format tag — the
  // honest dash when the row is absent.
  const fmtStored = (row) => (row ? fmtMetric(row.value, row.format) : '—');

  // Sides swap at halftime, so a side never names a team: the cards'
  // per-team values read stored rows keyed by the canonical
  // side-parity teamKeyAt stamp (SaveExtracted/Compute write it — the
  // same key the display names and identity colors use; the retired
  // rollups' oracle recomputes it in internal/metrics'
  // econ_equivalence_test). This switch still feeds the curve's era
  // splits and the round winner names below.
  const sideSwitches = $derived(match?.sideSwitches || 0);

  // Side-switch boundary per row (index-aligned with `rows`): the
  // canonical separator gating (lib/rounds.js separatorFlags — cadence +
  // counted-gating + trailing suppression). Row i carries the boundary
  // that follows row i-1 as its `.split-before` class (public/style.css,
  // the table twin of RoundStrip's `.round-split`), so the interleaved
  // econ-why-row stays attached ABOVE the line and the last row can never
  // carry a trailing one. The projection to `{number}` is only the row
  // SHAPE: isCounted/separatorAfter read `number` (a legacy negative
  // ingest number must not shift a marker — see lib/rounds.js), while
  // models.EconomyRow keys its round as `round`. Every stored round is
  // counted since the discard, so the ordinals separatorAfter expects
  // are exactly these round numbers.
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

  // Summary math: ONLY the DRILL anchors live here (which round each
  // button opens — navigation state, not a rendered number: the first
  // decided pistol round, the first force-buy round, the round holding
  // the largest winner gap, the round holding the largest loser equip).
  // Every card VALUE reads its stored metric rows (cardMetrics above —
  // plan §8 M8 seeds for pistol/gap, the view-aggregate relocation for
  // force/lost): the retired view computations survive only as the
  // oracles in internal/metrics' econ_equivalence_test.
  const summary = $derived.by(() => {
    let firstPistol = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.pistolRound) continue;
      const side = r.wonCT ? 'ct' : r.wonT ? 't' : '';
      if (!side) continue;
      if (!firstPistol) firstPistol = r.round;
      break; // drill anchor: the FIRST decided pistol round, nothing more
    }

    let firstForce = 0;
    let gapRound = 0;
    let gapBest = -Infinity;
    let lostRound = 0;
    let lostBest = -Infinity;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!firstForce && (r.classCT === 'force' || r.classT === 'force')) {
        firstForce = r.round; // drill anchor: the FIRST force-buy round
      }
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
      if (gap > gapBest) {
        gapBest = gap;
        gapRound = r.round;
      }
      const loserEquip = loserSide === 'ct' ? r.equipCT || 0 : r.equipT || 0;
      if (loserEquip > lostBest) {
        lostBest = loserEquip;
        lostRound = r.round;
      }
    }

    return { firstPistol, firstForce, gapRound, lostRound };
  });

  // The FORCE card's value/sub compose from the stored per-team COUNT
  // rows (team_force_wins / team_force_rounds — every raw number is a
  // stored row): the headline percent pools both teams' pairs, the
  // sub-line shows each team's own. Composition rationale (the
  // view-aggregate rule): the pooled ratio is pure presentation
  // arithmetic over already-fetched stored rows and its formula rides
  // the card title; a pooled RATIO seed deliberately does not exist
  // because it cannot carry this card's dash — a zero denominator
  // stores 0 beside N, indistinguishable from a real 0%. No rows
  // (unanalyzed / not yet computed) → the honest dash for BOTH slots,
  // never a fabricated 0/0; rows present with zero forces → the dash +
  // "no force buys".
  const forceCard = $derived.by(() => {
    const won = teamValues('team_force_wins');
    const rounds = teamValues('team_force_rounds');
    if (!won || !rounds) return { value: '—', sub: '—' };
    const ct = { won: won.ct, total: rounds.ct };
    const t = { won: won.t, total: rounds.t };
    const total = ct.total + t.total;
    if (!total) return { value: '—', sub: S.economy.noForceBuys };
    return {
      value: Math.round((100 * (ct.won + t.won)) / total) + '%',
      sub: `${names.ct} ${ct.won}/${ct.total} · ${names.t} ${t.won}/${t.total}`,
    };
  });

  // The LOST card reads its stored twins (lost_equip headline total +
  // team_lost_equip per-team halves) — fmtMoney over the stored
  // values, the same rendering the retired sums produced.
  const lostCard = $derived.by(() => {
    const total = matchRow('lost_equip');
    const teams = teamValues('team_lost_equip');
    if (!total || !teams) return { value: '—', sub: '—' };
    return {
      value: fmtStored(total),
      sub: `${names.ct} ${fmtMoney(teams.ct)} · ${names.t} ${fmtMoney(teams.t)}`,
    };
  });

  // Stat-card drill → WATCH the round: ROUND-LEVEL loop (the round IS
  // the sequence — the owner's watch rule: a round-level button loops the
  // round's own start→end span, freeze included, never an event-level pad
  // around its edges, which would bleed into the previous round's end /
  // the next round's freeze). The start tick is stamped as ?tick= (the
  // seek — nav.entrySeekTick) and the span as ?loop= BESIDE it
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

  // Round-detail link from the RD cell: ALWAYS stamped with THIS tab as
  // the ?back= origin (an unstamped back made RoundDetail fall back to
  // the Overview — the same defect the curve's hit rects and winner strip
  // had, fixed in the same wave). buildHash drops nothing here: the
  // origin is exactly the string drill() above uses.
  function openRound(round) {
    nav(buildHash(`/match/${id}/round/${round}`, { back: `match/${id}/economy` }));
  }

  // The loss-bonus pip stack: always FIVE slots (the ladder's rungs),
  // filled up to lossPips(v) — lib/econ.js is the ONE count (never
  // re-derived here). The exact dollar amount stays in the cell title.
  const PIP_SLOTS = [1, 2, 3, 4, 5];

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
    <p class="error" role="alert">
      {error}
      <button class="btn small" aria-label={S.economy.dismissError} onclick={() => (error = '')}>
        <span class="codicon codicon-close"></span>
      </button>
    </p>
  {/if}

  {#if loading}
    <p class="muted" role="status"><StatusChip block detail={S.economy.loadingDetail} /></p>
  {:else}
    <div class="econ-head">
      <span class="muted"
        >{rows.length}{S.economy.roundSuffix}{rows.length === 1 ? '' : 's'}</span
      >
      <span class="spacer"></span>
      <span class="muted econ-head-note"
        >{S.economy.headNote}</span
      >
    </div>

    <EconCurve {rows} {id} {nav} {sideSwitches} matchWinner={matchWinner} {names} />

    <div class="econ-summary stat-grid">
      <StatCard
        label={S.economy.pistolLabel}
        value={fmtStored(matchRow('pistol_hold'))}
        sub={S.economy.pistolSub}
        cls={!summary.firstPistol ? 'no-drill' : ''}
        title={S.fill(S.economy.pistolTitle, { round: summary.firstPistol || '—' })}
        onclick={() => drill(summary.firstPistol)}
      >
        {#snippet badge()}<span class="chip badge-computed">{S.economy.badgeComputed}</span>{/snippet}
      </StatCard>

      <StatCard
        label={S.economy.forceLabel}
        value={forceCard.value}
        sub={forceCard.sub}
        cls={!summary.firstForce ? 'no-drill' : ''}
        title={S.fill(S.economy.forceTitle, { round: summary.firstForce || '—' })}
        onclick={() => drill(summary.firstForce)}
      >
        {#snippet badge()}<span class="chip badge-computed">{S.economy.badgeComputed}</span>{/snippet}
      </StatCard>

      <StatCard
        label={S.economy.gapLabel}
        value={fmtStored(matchRow('avg_equip_gap'))}
        sub={S.economy.gapSub}
        cls={!summary.gapRound ? 'no-drill' : ''}
        title={S.fill(S.economy.gapTitle, { round: summary.gapRound || '—' })}
        onclick={() => drill(summary.gapRound)}
      >
        {#snippet badge()}<span class="chip badge-computed">{S.economy.badgeComputed}</span>{/snippet}
      </StatCard>

      <StatCard
        label={S.economy.lostLabel}
        value={lostCard.value}
        sub={lostCard.sub}
        cls={!summary.lostRound ? 'no-drill' : ''}
        title={S.fill(S.economy.lostTitle, { round: summary.lostRound || '—' })}
        onclick={() => drill(summary.lostRound)}
      >
        {#snippet badge()}<span class="chip badge-inferred">{S.economy.badgeInferred}</span>{/snippet}
      </StatCard>
    </div>

    <section class="panel">
      <h2>{S.economy.roundsHeading}</h2>
      {#if rows.length === 0}
        <p class="muted" role="status">{S.economy.noRounds}</p>
      {:else}
        <div class="table-scroll">
          <table class="data-table econ-table">
            <thead>
              <tr>
                <!-- Far-left watch column (W3a): the canonical ghost ▶
                     cell (EventPlay) → the existing drill() round loop. -->
                <th scope="col"><span class="sr-only">{S.match.colWatch}</span></th>
                <th scope="col" class="num">RD</th>
                <th scope="col">{S.economy.thWinner}</th>
                <th scope="col">{S.economy.thCTBuy}</th>
                <th scope="col">{S.economy.thTBuy}</th>
                <th scope="col" class="num" title={S.economy.deathsTitle}>{S.economy.thDeathsCT}</th>
                <th scope="col" class="num" title={S.economy.deathsTitle}>{S.economy.thDeathsT}</th>
                <th scope="col" class="num">{S.economy.thLossCT}</th>
                <th scope="col" class="num">{S.economy.thLossT}</th>
              </tr>
            </thead>
            <tbody>
              {#each rows as r, ri (r.round)}
                {@const ctc = classChip('ct', r)}
                {@const tc = classChip('t', r)}
                <tr class:split-before={ri > 0 && sepFlags[ri - 1]}>
                  <td>
                    <EventPlay
                      tick={roundStartTick(rounds, r.round)}
                      title={S.fill(S.match.watchRoundTitle, { round: r.round })}
                      label={S.fill(S.match.watchRoundAria, { round: r.round })}
                      onclick={() => drill(r.round)}
                    />
                  </td>
                  <td class="num">
                    <button
                      class="btn small ghost econ-rd"
                      title={S.fill(S.economy.openRound, { round: r.round })}
                      onclick={() => openRound(r.round)}
                      >{r.round}</button
                    >
                  </td>
                  <td>
                    <WinnerCell winner={r.winner} name={winnerName(r)} />
                  </td>
                  <td>
                    <button
                      class="chip econ-cls {ctc.cls}"
                      title={S.fill(S.economy.chipTitle, { why: ctc.why, rule: ctc.rule })}
                      aria-expanded={whyOpen === `${r.round}:ct`}
                      onclick={() => toggleWhy(r, 'ct')}>{ctc.cls}</button
                    >
                  </td>
                  <td>
                    <button
                      class="chip econ-cls {tc.cls}"
                      title={S.fill(S.economy.chipTitle, { why: tc.why, rule: tc.rule })}
                      aria-expanded={whyOpen === `${r.round}:t`}
                      onclick={() => toggleWhy(r, 't')}>{tc.cls}</button
                    >
                  </td>
                  <td class="num">{deathsFor(r.round, 'ct') ?? '—'}</td>
                  <td class="num">{deathsFor(r.round, 't') ?? '—'}</td>
                  <td class="num econ-loss" title={fmtMoney(r.lossBonusCT)}>
                    {#each PIP_SLOTS as pip (pip)}
                      <span class="econ-loss-pip" class:ct={pip <= lossPips(r.lossBonusCT)}></span>
                    {/each}
                  </td>
                  <td class="num econ-loss" title={fmtMoney(r.lossBonusT)}>
                    {#each PIP_SLOTS as pip (pip)}
                      <span class="econ-loss-pip" class:t={pip <= lossPips(r.lossBonusT)}></span>
                    {/each}
                  </td>
                </tr>
                {#if whyOpen.startsWith(`${r.round}:`)}
                  <tr class="econ-why-row">
                    <td colspan="9">
                      <div class="econ-why">
                        <span class="chip econ-cls {whyText?.side === 'ct' ? ctc.cls : tc.cls}">
                          {whyText?.side === 'ct' ? ctc.cls : tc.cls}
                        </span>
                        <span class="econ-why-text"
                          >{whyText?.why || S.economy.noExplanation}</span
                        >
                        <span class="spacer"></span>
                        <span class="econ-why-rules mono"
                          >{S.economy.rulesV}{whyText?.rule ?? r.ruleVersion}</span
                        >
                        <button
                          class="btn small ghost"
                          aria-label={S.economy.closeExplanation}
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
      {/if}
    </section>
  {/if}
</div>
