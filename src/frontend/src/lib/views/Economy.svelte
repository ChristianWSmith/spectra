<script>
  import * as S from '../strings/index.js';
  import {
    getEconomy,
    getRounds,
    getMatch,
    getTeamNames,
    getScoreboard,
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
  import { EQUIP_DEF } from '../definitions.js';
  import { readEconomyPins, resolvePins } from '../metricorder.js';
  import EconCurve from '../components/EconCurve.svelte';
  import StatCard from '../components/StatCard.svelte';
  import WinnerCell from '../components/WinnerCell.svelte';
  import EventPlay from '../components/EventPlay.svelte';
  import StatusChip from '../components/StatusChip.svelte';

  let { id = 0, nav = () => {} } = $props();

  let rows = $state([]); // models.EconomyRow[]
  let rounds = $state([]); // RoundRow[] (round context)
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
        rows = eco || [];
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

  // Loss-bonus values are never read from the demo — the store
  // reconstructs them from round results (store.GetEconomy →
  // applyLossBonuses), so EVERY row is inferred. The fact/inference badge
  // therefore sits once per loss-bonus column header, not once per cell.
  const lossInferredCT = $derived(rows.some((r) => r.inferredCT));
  const lossInferredT = $derived(rows.some((r) => r.inferredT));

  // The summary CARDS read their stored metric rows through the ONE
  // economy card set (owner, 2026-11-18): which stats the tab shows
  // comes from metricorder's economy placement pref (metric_economy —
  // absent ⇒ DEFAULT_ECONOMY, the shipped set; present ⇒ verbatim),
  // resolved over the catalog and sequenced by the match order. Each
  // card renders ITS metric's stored row (matchRow/teamValues below) —
  // the composed pooled-force % and lost sub retired with this
  // migration; their inputs' equivalence lives in internal/metrics'
  // econ_equivalence_test (the oracles for every default-set stat).
  // name → {format, rows} or absent when the catalog lacks the seed /
  // no row is fresh / the read fails — the honest dash, never a locally
  // recomputed number. The canonical read pair: listMetrics to resolve
  // the set, then the ONE getMetricValuesForMatch call — same pattern
  // as the scoreboard and Reports.
  let cardMetrics = $state({});
  let econDefs = $state([]); // the resolved card set, in match-sequence order
  $effect(() => {
    let live = true;
    Promise.all([listMetrics(), readEconomyPins()])
      .then(([defs, stored]) => {
        const rows = defs || [];
        // Absent ⇒ DEFAULT_ECONOMY by name; present ⇒ verbatim (the
        // resolvePins rule — the ONE absent-vs-present reader). Card
        // order follows THAT array (the shipped set's order), not the
        // scoreboard sequence: placement is the pref's, not the
        // sequence's.
        const wanted = resolvePins('economy', stored, rows)
          .map((n) => rows.find((d) => d && d.name === n))
          .filter((d) => d);
        econDefs = wanted;
        if (!wanted.length) {
          cardMetrics = {};
          return undefined;
        }
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

  // Per-card composition over the economy set: the DRILL anchor (a
  // navigation fact, view-local by precedent — which round each shipped
  // stat opens), the static sub hint two shipped stats carry, and the
  // inferred badge (loss-bonus-derived stats). Everything else comes
  // from the metric: its title is the label, its doc the tooltip, its
  // stored row the value — a user-toggled metric needs no entry here.
  const CARD_DRILL = Object.freeze({
    pistol_hold: 'firstPistol',
    team_force_wins: 'firstForce',
    team_force_rounds: 'firstForce',
    avg_equip_gap: 'gapRound',
    lost_equip: 'lostRound',
    team_lost_equip: 'lostRound',
  });
  const CARD_SUB = Object.freeze({
    pistol_hold: S.economy.pistolSub,
    avg_equip_gap: S.economy.gapSub,
  });
  const CARD_INFERRED = new Set(['lost_equip', 'team_lost_equip']);

  // One TEAM-subject metric's stored pair as the card's value line —
  // both teams or the honest dash (teamValues' half-present rule);
  // rendered through the metric's own format tag.
  function teamLine(name) {
    const t = teamValues(name);
    if (!t) return '—';
    const m = cardMetrics[name];
    const f = (v) => fmtMetric(v, m ? m.format : '');
    return `${names.ct} ${f(t.ct)} · ${names.t} ${f(t.t)}`;
  }

  // econCards — THE card list: the economy set in match-sequence
  // order, each card's value from ITS metric's stored row (the
  // matchRow/teamValues/fmtStored pattern; the one unioned read above).
  const econCards = $derived.by(() =>
    econDefs.map((d) => {
      const anchor = CARD_DRILL[d.name] ? summary[CARD_DRILL[d.name]] : 0;
      return {
        key: d.name,
        label: d.title || d.name,
        value: d.subject === 'team' ? teamLine(d.name) : fmtStored(matchRow(d.name)),
        sub: CARD_SUB[d.name] || '',
        title: d.doc || '',
        inferred: CARD_INFERRED.has(d.name),
        drill: anchor || 0,
      };
    }),
  );

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
      {#each econCards as c (c.key)}
        <StatCard
          label={c.label}
          value={c.value}
          sub={c.sub}
          cls={c.drill ? '' : 'no-drill'}
          title={c.title}
          onclick={c.drill ? () => drill(c.drill) : null}
        >
          {#snippet badge()}<span class="chip {c.inferred ? 'badge-inferred' : 'badge-computed'}">{c.inferred ? S.economy.badgeInferred : S.economy.badgeComputed}</span>{/snippet}
        </StatCard>
      {/each}
    </div>

    <section class="panel">
      <h2>{S.economy.buyTypesHeading}</h2>
      {#if rows.length === 0}
        <p class="muted" role="status">{S.economy.noBuyTypes}</p>
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
                <th scope="col" class="num" title={EQUIP_DEF}>{S.economy.thEquipCT}</th>
                <th scope="col" class="num" title={EQUIP_DEF}>{S.economy.thEquipT}</th>
                <th scope="col" class="num">
                  {S.economy.thLossCT}
                  {#if lossInferredCT}
                    <span
                      class="chip badge-inferred"
                      title={S.economy.inferredTitle}
                      >{S.economy.badgeInferred}</span
                    >
                  {/if}
                </th>
                <th scope="col" class="num">
                  {S.economy.thLossT}
                  {#if lossInferredT}
                    <span
                      class="chip badge-inferred"
                      title={S.economy.inferredTitle}
                      >{S.economy.badgeInferred}</span
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
                  <td class="num">{fmtMoney(r.equipCT)}</td>
                  <td class="num">{fmtMoney(r.equipT)}</td>
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
        <p class="econ-table-note muted">
          {S.economy.tableNote}
          <span class="chip badge-inferred">{S.economy.badgeInferred}</span>
          {S.economy.tableNoteTail}
        </p>
      {/if}
    </section>
  {/if}
</div>
