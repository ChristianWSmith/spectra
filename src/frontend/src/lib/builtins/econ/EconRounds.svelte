<script>
  import { bySide, openReplay, matchTab, openRoundsTab } from '../../builtinhelpers.js';
  import EmptyNote from '../../components/EmptyNote.svelte';
  import { economySource } from '../../economysource.svelte.js';
  import { whileCurrent } from '../../current.js';
  import * as S from '../../strings/index.js';
  import WinnerCell from '../../components/WinnerCell.svelte';
  import {
  DASH,
  fmtInt,
  fmtMoney,
  separatorFlags,
  roundStartTick,
  roundEndTick,
  roundWinnerName,
  lossPips,
  entryLoopSpan,
} from '../../builtinhelpers.js';

  // Economy rounds: one row per counted round. Deaths are the stored round-grain
  // metric raw_player_round_deaths, read per round and summed per side; a round
  // with no stored value shows a dash.
  // Mounted by a composer, the economy comes from it (the props below). Mounted alone (a component preview),
  // the panel loads the match's economy itself, so it shows the real data either way.
  let { spectra, context, back = '', ...given } = $props();
  const src = economySource(() => ({ spectra, context, given }));
  const rows = $derived(src.rows);
  const rounds = $derived(src.rounds);
  const names = $derived(src.names);
  const sideSwitches = $derived(src.sideSwitches);

  const PIP_SLOTS = [1, 2, 3, 4, 5];
  const origin = () => back || matchTab(context.matchId, 'economy');

  let whyOpen = $state('');
  let deaths = $state(new Map());

  $effect(() =>
    whileCurrent((isCurrent) => {
      const matchId = context.matchId;
      const list = rows.map((r) => r.round);
      deaths = new Map();
      if (matchId == null || list.length === 0) return;
      Promise.all(
        list.map((round) =>
          spectra.metric('raw_player_round_deaths', { match_id: matchId, round }).then(
            (m) => [round, m],
            (e) => {
              spectra.report(e);
              return [round, null];
            },
          ),
        ),
      ).then((pairs) => {
        if (!isCurrent()) return;
        const out = new Map();
        for (const [round, m] of pairs) {
          // One stored row per player per round, its dim the side sampled: the
          // side's deaths are the sum over its players (ruling 41).
          const by = {};
          if (m && m.state === 'fresh') {
            for (const v of m.rows) {
              const side = v.dim;
              if (side !== 'ct' && side !== 't') continue;
              if (by[side] === undefined) by[side] = 0;
              by[side] = v.value == null || by[side] === null ? null : by[side] + v.value;
            }
          }
          out.set(round, by);
        }
        deaths = out;
      });
    }),
  );

  function deathText(round, side) {
    const by = deaths.get(round);
    if (!by || by[side] == null || by[side] === null) return DASH;
    return fmtInt(by[side]);
  }

  const sepFlags = $derived(separatorFlags(rows.map((r) => ({ number: r.round }))));

  function winnerName(r) {
    return roundWinnerName(rounds, sideSwitches, r.round, r.winner, names);
  }

  function classChip(side, r) {
    const cls = bySide(side, r.classCT, r.classT);
    const why = bySide(side, r.classWhyCT, r.classWhyT);
    return { cls: cls || 'unknown', why: why || S.economy.noExplanation, rule: r.ruleVersion };
  }

  function toggleWhy(r, side) {
    const key = r.round + ':' + side;
    whyOpen = whyOpen === key ? '' : key;
  }

  const openRound = (round) => openRoundsTab(spectra, context.matchId, round);

  function watchRound(round) {
    if (!round) return;
    const start = roundStartTick(rounds, round);
    const end = roundEndTick(rounds, round);
    openReplay(spectra, context.matchId, { tick: start, loop: entryLoopSpan(start, end), back: origin() });
  }

  const whyText = $derived.by(() => {
    if (!whyOpen) return null;
    const [rs, side] = whyOpen.split(':');
    const r = rows.find((x) => String(x.round) === rs);
    if (!r) return null;
    return { side, why: bySide(side, r.classWhyCT, r.classWhyT), rule: r.ruleVersion };
  });
</script>

<div>
  <h2>{S.economy.colRounds}</h2>
  {#if rows.length === 0}
    <EmptyNote>{S.economy.noRounds}</EmptyNote>
  {:else}
    <div class="table-scroll">
      <table class="data-table econ-table">
        <thead>
          <tr>
            <th scope="col"><span class="sr-only">{S.match.colWatch}</span></th>
            <th scope="col" class="num">{S.match.colRd}</th>
            <th scope="col">{S.match.colWinner}</th>
            <th scope="col">{S.economy.colCtBuy}</th>
            <th scope="col">{S.economy.colTBuy}</th>
            <th scope="col" class="num" title={S.economy.titleDeaths}>{S.economy.colCtDeaths}</th>
            <th scope="col" class="num" title={S.economy.titleDeaths}>{S.economy.colTDeaths}</th>
            <th scope="col" class="num">{S.economy.colCtLoss}</th>
            <th scope="col" class="num">{S.economy.colTLoss}</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as r, ri (r.round)}
            {@const ctc = classChip('ct', r)}
            {@const tc = classChip('t', r)}
            <tr class:split-before={ri > 0 && sepFlags[ri - 1]}>
              <td>
                <button
                  class="btn small ghost"
                  title={S.economy.watchRoundPrefix + r.round + S.economy.watchRoundSuffix}
                  aria-label={S.economy.watchRoundPrefix + r.round}
                  onclick={() => watchRound(r.round)}
                >
                  <span class="codicon codicon-play"></span>
                </button>
              </td>
              <td class="num">
                <button
                  class="btn small ghost econ-rd"
                  title={S.economy.openRoundAria + r.round}
                  onclick={() => openRound(r.round)}
                >
                  {r.round}
                </button>
              </td>
              <td>
                <WinnerCell name={winnerName(r)} winner={r.winner} />
              </td>
              <td>
                <button
                  class="chip econ-cls {ctc.cls}"
                  title={ctc.why + S.economy.ruleOpen + ctc.rule + S.economy.ruleClose}
                  aria-expanded={whyOpen === r.round + ':ct'}
                  onclick={() => toggleWhy(r, 'ct')}
                >
                  {ctc.cls}
                </button>
              </td>
              <td>
                <button
                  class="chip econ-cls {tc.cls}"
                  title={tc.why + S.economy.ruleOpen + tc.rule + S.economy.ruleClose}
                  aria-expanded={whyOpen === r.round + ':t'}
                  onclick={() => toggleWhy(r, 't')}
                >
                  {tc.cls}
                </button>
              </td>
              <td class="num">{deathText(r.round, 'ct')}</td>
              <td class="num">{deathText(r.round, 't')}</td>
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
            {#if whyOpen.startsWith(r.round + ':')}
              <tr class="econ-why-row">
                <td colspan="9">
                  <div class="econ-why">
                    <span class="chip econ-cls {whyText?.side === 'ct' ? ctc.cls : tc.cls}">
                      {whyText?.side === 'ct' ? ctc.cls : tc.cls}
                    </span>
                    <span class="econ-why-text">{whyText?.why || S.economy.noExplanation}</span>
                    <span class="spacer"></span>
                    <span class="econ-why-rules mono">
                      {S.economy.rulesPrefix}{whyText?.rule ?? r.ruleVersion}
                    </span>
                    <button
                      class="btn small ghost"
                      aria-label={S.economy.closeExplanation}
                      onclick={() => (whyOpen = '')}
                    >
                      <span class="codicon codicon-close"></span>
                    </button>
                  </div>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
