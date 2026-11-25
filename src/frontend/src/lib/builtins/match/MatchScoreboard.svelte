<script>
  import ProfileLink from '../../components/ProfileLink.svelte';
  import SortTh from '../../components/SortTh.svelte';
  import { namesOf, rosterOf } from '../../builtinhelpers.js';
  import { sideSwitchesOf } from '../../builtinhelpers.js';
  import { openRow } from '../../keys.js';
  import { whileCurrent } from '../../current.js';
  import * as S from '../../strings/index.js';
  import {
    readFrameBase,
    SQL_ROSTER,
    SQL_TEAMS,
    SQL_SWITCHES,
    startClass,
    readUnit,
    cellValue,
    matchPres,
    STATE_WORD,
    sortRows,
  } from './panelhelpers.js';
  import { fmtMetric, fmtInt } from '../../fmt.js';
  import MetricTd from '../../components/MetricTd.svelte';
  import { DASH, isSteam } from '../../builtinhelpers.js';
  const SCOREBOARD_COLUMNS = [
    ['kills', S.match.scoreK, 'int'],
    ['deaths', S.match.scoreD, 'int'],
    ['total_damage', S.match.scoreDmg, 'int'],
    ['utility_damage', S.match.scoreUtil, 'int'],
    ['mvps', S.match.scoreMvps, 'int'],
    ['assists', S.match.scoreA, 'int'],
    ['adr', S.match.colAdr, 'float1'],
    ['kast', S.match.scoreKast, 'percent'],
    ['hs_pct', S.match.scoreHs, 'percent'],
    ['kd', S.match.scoreKd, 'float2'],
    ['kda', S.match.scoreKda, 'float2'],
    ['two_k', S.match.score2k, 'int'],
    ['three_k', S.match.score3k, 'int'],
    ['four_k', S.match.score4k, 'int'],
    ['five_k', S.match.score5k, 'int'],
    ['entry_kills', S.match.scoreOpenK, 'int'],
    ['entry_deaths', S.match.scoreOpenD, 'int'],
    ['trade_kills', S.match.scoreTrade, 'int'],
    ['best_streak', S.match.scoreStreak, 'int'],
  ];

  // Match scoreboard: one row per human player, the default layout. Click a
  // header to sort on it: a new header sorts on top of the chain built so far
  // (the newest key is primary, earlier keys break its ties); a click on the
  // newest header reverses it. The chain starts at kills, highest first. A row
  // opens the replay following that player.
  let { spectra, context, back = '' } = $props();

  const COLUMNS = SCOREBOARD_COLUMNS.map(([metric, label, format]) => ({ metric, label, format }));

  let data = $state(null);
  let sortStack = $state([{ key: 'kills', desc: true }]);
  const sortKey = $derived(sortStack[sortStack.length - 1].key);
  const sortDesc = $derived(sortStack[sortStack.length - 1].desc);

  async function load(matchId) {
    if (matchId == null) return null;
    const names = COLUMNS.map((c) => c.metric);
    const [roster, teamRows, switchRows, ...units] = await Promise.all([
      ...readFrameBase(spectra),
      ...names.map((n) => readUnit(spectra, n)),
    ]);
    const byMetric = new Map(names.map((n, i) => [n, units[i]]));
    const rows = roster.rows.map((r) => ({ steam: r[0], name: r[1], side: r[2], score: r[3] }));
    return {
      switches: sideSwitchesOf(switchRows),
      teams: namesOf(teamRows.rows, rosterOf(roster.rows)),
      rows,
      byMetric,
    };
  }

  $effect(() =>
    whileCurrent((isCurrent) => {
      const matchId = context.matchId;
      sortStack = [{ key: 'kills', desc: true }];
      load(matchId).then(
        (d) => {
          if (isCurrent()) data = d;
        },
        () => {
          // A failed read is reported into this frame by the read API.
        },
      );
    }),
  );

  // The value a row sorts on for one key: the name, the side code, the score,
  // or a stored value (the same keys the old view's chain sorted on).
  function sortValueOf(key, p) {
    if (key === 'name') return p.name;
    if (key === 'side') return p.side;
    if (key === 'score') return p.score;
    return cellValue(data.byMetric.get(key), p.steam);
  }

  const sorted = $derived(data ? sortRows(data.rows, sortStack, sortValueOf) : []);

  // A click on the newest key reverses it; a click on any other key pushes it
  // on top of the chain, so the keys already sorted keep ordering its ties.
  function toggleSort(key) {
    const last = sortStack[sortStack.length - 1];
    if (last.key === key) sortStack = [...sortStack.slice(0, -1), { key, desc: !last.desc }];
    else sortStack = [...sortStack, { key, desc: true }];
  }

  // A metric header's tooltip: its formula, as the old view showed it (the
  // catalog's doc, else the metric name), plus the engine's error when it failed.
  function headerTitle(metric) {
    const u = data.byMetric.get(metric);
    return (u.doc || metric) + (u.error ? S.builtins.couldntCalculate + u.error : '');
  }

  const follow = (steam) => spectra.followPlayer(steam, back);

  function ariaSort(key) {
    if (sortKey !== key) return 'none';
    return sortDesc ? 'descending' : 'ascending';
  }
</script>

<div class="table-scroll">
  {#if data}
    <table class="data-table scoreboard">
      <thead>
        <tr>
          <SortTh label={S.match.colName} cls="num" ariaSort={ariaSort('name')} active={sortKey === 'name'} desc={sortDesc} onclick={() => toggleSort('name')} />
          <SortTh label={S.match.colTeam} cls="num" ariaSort={ariaSort('side')} active={sortKey === 'side'} desc={sortDesc} onclick={() => toggleSort('side')} />
          <SortTh label={S.match.colScore} cls="num" ariaSort={ariaSort('score')} active={sortKey === 'score'} desc={sortDesc} onclick={() => toggleSort('score')} />
          {#each COLUMNS as c (c.metric)}
            <SortTh label={c.label} cls="num" title={headerTitle(c.metric)} ariaSort={ariaSort(c.metric)} active={sortKey === c.metric} desc={sortDesc} onclick={() => toggleSort(c.metric)} />
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each sorted as p (p.steam)}
          {@const cls = startClass(p.side, data.switches)}
          <tr
            class="clickable"
            tabindex="0"
            {...openRow(() => follow(p.steam), { ignore: 'button, a', enterOnly: true })}
          >
            <td class="num name-cell {cls}">
              {#if isSteam(p.steam)}
                <ProfileLink steam={p.steam} name={p.name} nav={spectra.navigate} variant="name-link" stopRow cls={cls} />
              {:else}
                {p.name}
              {/if}
            </td>
            <td class="num">
              <span class="chip {cls}">
                {p.side === 'ct' ? data.teams.ct : p.side === 't' ? data.teams.t : DASH}
              </span>
            </td>
            <td class="num">
              {fmtInt(Number(p.score))}
            </td>
            {#each COLUMNS as c (c.metric)}
              {@const u = data.byMetric.get(c.metric)}
              <MetricTd
                pres={matchPres(u, p.steam)}
                format={(v) => fmtMetric(v, c.format)}
                words={STATE_WORD}
                title={u.error}
              />
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
