<script>
  import * as S from '../../strings/index.js';
  import { SQL_ROSTER, SQL_TEAMS, SQL_SWITCHES, SQL_ROUNDS, teamName, fill, roundLabel, fmtDuration, playerRoundCls, roundOf } from './panelhelpers.js';
  import { DASH, isSteam, separatorFlags, winnerTeamKey, openPlayer } from '../../builtinhelpers.js';
  const ROUNDS_COPY = Object.freeze({
    colWatch: S.match.colWatch,
    colCmp: S.match.colCmp,
    compareSelectTitle: S.match.compareSelectTitle,
    colWinner: S.match.colWinner,
    colReason: S.match.colReason,
    colDuration: S.match.colDuration,
    colSite: S.match.colSite,
    colMvp: S.match.colMvp,
    firstBloodLabel: S.match.firstBloodLabel,
    colKills: S.match.colKills,
    watchRoundTitle: S.match.watchRoundTitle,
    watchRoundAria: S.match.watchRoundAria,
    compareRoundAria: S.match.compareRoundAria,
    roundsSelected: S.match.roundsSelected,
    compareBtn: S.match.compareBtn,
    openProfile: S.match.openProfile,
    killedVerb: S.match.killedVerb,
  });

  // Match rounds: one row per round, in round order. The ▶ watches the round
  // in the replay from its own start, its span looped, back to this tab. The
  // compare box picks up to four rounds, kept for this match in view state;
  // the button under the table compares them. A click on the rest of the row
  // opens the round's page.
  import { comparePicks, setComparePicks } from '../../viewstate.svelte.js';
  let { spectra, context, back = '' } = $props();
  const COPY = ROUNDS_COPY;

  // The picks are read when the match changes and written on every change.
  let picks = $state([]);
  let pickedFor = null;
  $effect(() => {
    const id = context.matchId;
    const cur = picks;
    if (id !== pickedFor) {
      pickedFor = id;
      picks = comparePicks(id);
      return;
    }
    setComparePicks(id, cur);
  });
  function pick(n) {
    if (picks.includes(n)) picks = picks.filter((x) => x !== n);
    else if (picks.length < 4) picks = [...picks, n];
  }
  function compare() {
    spectra.navigate({ path: '/compare/' + context.matchId, query: { rounds: picks.join(','), back } });
  }

  let data = $state(null);

  async function load(matchId) {
    if (matchId == null) return null;
    const [rounds, roster, teamRows, switchRows] = await Promise.all([
      spectra.query(SQL_ROUNDS),
      spectra.query(SQL_ROSTER),
      spectra.query(SQL_TEAMS),
      spectra.query(SQL_SWITCHES),
    ]);
    const list = rounds.rows.map(roundOf);
    return {
      id: matchId,
      rounds: list,
      seps: separatorFlags(list),
      roster: roster.rows,
      switches: Number((switchRows.rows[0] || [0])[0]) || 0,
      teams: { ct: teamName('ct', teamRows.rows, roster.rows), t: teamName('t', teamRows.rows, roster.rows) },
    };
  }

  $effect(() => {
    const matchId = context.matchId;
    let live = true;
    load(matchId).then(
      (d) => {
        if (live) data = d;
      },
      // A failed read is reported into this frame (guard routes the error to it).
      (e) => spectra.guard(() => {
        throw e;
      })(),
    );
    return () => {
      live = false;
    };
  });

  const backTo = () => back || 'match/' + (data ? data.id : context.matchId);

  function winnerName(d, r) {
    const key = winnerTeamKey(d.rounds, d.switches, r.number, r.winner);
    return key ? d.teams[key] : '';
  }

  function openRound(n) {
    spectra.navigate({ path: '/match/' + data.id + '/round/' + n, query: { back: backTo() } });
  }

  // The replay at the round's start, its span looped, back to this tab.
  function watchRound(n) {
    const r = data.rounds.find((x) => x.number === n);
    const start = r && Number.isFinite(r.startTick) ? r.startTick : null;
    const end = r && Number.isFinite(r.endTick) ? r.endTick : null;
    const loop = start != null && end != null && start >= 0 && start <= end ? start + ',' + end : undefined;
    spectra.navigate({ path: '/replay/' + data.id, query: { tick: start, loop, back: backTo() } });
  }
</script>

{#snippet playerLink(steam, name, cls)}
  {#if isSteam(steam)}
    <button class="comb-name-btn {cls}" title={fill(COPY.openProfile, { name })} onclick={() => openPlayer(spectra, steam)}>{name || DASH}</button>
  {:else}
    <span class={cls}>{name || DASH}</span>
  {/if}
{/snippet}

<div class="builtin-root" class:builtin-busy={spectra.busy} aria-busy={spectra.busy}>
{#if data}
  <div class="table-scroll">
    <table class="data-table">
      <thead>
        <tr>
          <th scope="col"><span class="sr-only">{COPY.colWatch}</span></th>
          <th scope="col" class="num cmp-cmp-col" title={COPY.compareSelectTitle}>{COPY.colCmp}</th>
          <th scope="col" class="num">{S.match.colRd}</th>
          <th scope="col">{COPY.colWinner}</th>
          <th scope="col">{COPY.colReason}</th>
          <th scope="col" class="num">{COPY.colDuration}</th>
          <th scope="col">{COPY.colSite}</th>
          <th scope="col">{COPY.colMvp}</th>
          <th scope="col">{COPY.firstBloodLabel}</th>
          <th scope="col" class="num">{COPY.colKills}</th>
        </tr>
      </thead>
      <tbody>
        {#each data.rounds as r, ri (r.number)}
          <tr class="clickable" class:split-before={ri > 0 && data.seps[ri - 1]} tabindex="0"
            onclick={(e) => { if (e.target instanceof Element && e.target.closest('input, button, a')) return; openRound(r.number); }}
            onkeydown={(e) => { if (e.key === 'Enter') openRound(r.number); }}
          >
            <td>
              <button class="btn small ghost" title={fill(COPY.watchRoundTitle, { round: r.number })} aria-label={fill(COPY.watchRoundAria, { round: r.number })} onclick={() => watchRound(r.number)}><span class="codicon codicon-play"></span></button>
            </td>
            <td class="num cmp-cmp-col" onclick={(e) => e.stopPropagation()}>
              <input
                type="checkbox"
                class="cmp-cb"
                checked={picks.includes(r.number)}
                disabled={picks.length >= 4 && !picks.includes(r.number)}
                aria-label={fill(COPY.compareRoundAria, { round: roundLabel(r.number) })}
                onchange={() => pick(r.number)}
              />
            </td>
            <td class="num">{roundLabel(r.number)}</td>
            <td><span class="chip side {r.winner || 'none'}">{winnerName(data, r) || (r.winner ? r.winner.toUpperCase() : DASH)}</span></td>
            <td>{r.reason || DASH}</td>
            <td class="num">{fmtDuration(r.durationS)}</td>
            <td>{r.bombSite || DASH}</td>
            <td>
              {#if r.mvpName}
                {@render playerLink(r.mvp, r.mvpName, playerRoundCls(data, r.number, r.mvp, r.mvpName))}
              {:else}
                {DASH}
              {/if}
            </td>
            <td>
              {#if r.firstKillName && r.firstDeathName}
                {@render playerLink(r.firstKillSteam, r.firstKillName, playerRoundCls(data, r.number, r.firstKillSteam, r.firstKillName))}
                {COPY.killedVerb}
                {@render playerLink(r.firstDeathSteam, r.firstDeathName, playerRoundCls(data, r.number, r.firstDeathSteam, r.firstDeathName))}
              {:else}
                {DASH}
              {/if}
            </td>
            <td class="num">{r.kills}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if picks.length > 0}
    <p class="cmp-hint">{fill(COPY.roundsSelected, { n: picks.length })}</p>
  {/if}
  {#if picks.length >= 2}
    <button class="btn primary cmp-float" onclick={() => compare()}>
      {fill(COPY.compareBtn, { n: picks.length })} <span class="codicon codicon-chevron-right"></span>
    </button>
  {/if}
{/if}
</div>
