<script>
  import ProfileLink from '../../components/ProfileLink.svelte';
  import { namesOf, rosterOf } from '../../builtinhelpers.js';
  import { sideSwitchesOf } from '../../builtinhelpers.js';
  import { loadForMatch } from '../../current.js';
  import * as S from '../../strings/index.js';
  import {
    readFrameBase,
    SQL_ROSTER,
    SQL_TEAMS,
    SQL_SWITCHES,
    startClass,
    readUnit,
    kdaText,
    matchPres,
    STATE_WORD,
  } from './panelhelpers.js';
  import MetricTd from '../../components/MetricTd.svelte';
  import { fmtMetric } from '../../fmt.js';
  import { isSteam, followPlayer } from '../../builtinhelpers.js';

  // Match rosters: each side's players with K/D/A and ADR. Players sit in the
  // default order (kills, then name). The "Other" table appears only when a
  // player has no recorded side.
  let { spectra, context, back = '' } = $props();

  let data = $state(null);

  async function load(matchId) {
    if (matchId == null) return null;
    const [roster, teamRows, switchRows, kills, deaths, assists, adr] = await Promise.all([
      ...readFrameBase(spectra),
      readUnit(spectra, 'kills'),
      readUnit(spectra, 'deaths'),
      readUnit(spectra, 'assists'),
      readUnit(spectra, 'adr'),
    ]);
    const rows = roster.rows;
    const side = (s) => rows.filter((r) => r[2] === s);
    const other = rows.filter((r) => r[2] !== 'ct' && r[2] !== 't');
    const cell = (steam) => ({
      kda: kdaText(kills, deaths, assists, steam),
      adr: matchPres(adr, steam),
    });
    const mapRow = (r) => ({ steam: r[0], name: r[1], side: r[2], ...cell(r[0]) });
    return {
      switches: sideSwitchesOf(switchRows),
      ct: { name: namesOf(teamRows.rows, rosterOf(rows)).ct, players: side('ct').map(mapRow) },
      t: { name: namesOf(teamRows.rows, rosterOf(rows)).t, players: side('t').map(mapRow) },
      other: other.map(mapRow),
    };
  }

  $effect(
    loadForMatch(
      () => context.matchId,
      load,
      (d) => (data = d),
      (e) => spectra.report(e),
    ),
  );

  const follow = (steam) => followPlayer(spectra, context.matchId, back, steam);
</script>

<div class="roster-grid">
  {#if data}
    {#each [data.ct, data.t] as team, ti (ti)}
      <section class="panel">
        <h2 class={startClass(ti === 0 ? 'ct' : 't', data.switches)}>{team.name} {S.match.rosterSuffix}</h2>
        <table class="data-table">
          <thead>
            <tr>
              <th scope="col">{S.match.colPlayer}</th>
              <th scope="col" class="num">{S.match.rosterKdaHead}</th>
              <th scope="col" class="num">{S.match.colAdr}</th>
            </tr>
          </thead>
          <tbody>
            {#each team.players as p (p.steam)}
              <tr
                class="clickable"
                onclick={(e) => {
                  if (e.target instanceof Element && e.target.closest('button')) return;
                  follow(p.steam);
                }}
              >
                <td class={startClass(p.side, data.switches)}>
                  {#if isSteam(p.steam)}
                    <ProfileLink steam={p.steam} name={p.name} nav={spectra.navigate} variant="name-link" stopRow cls={startClass(p.side, data.switches)} />
                  {:else}
                    {p.name}
                  {/if}
                </td>
                <td class="num">{p.kda}</td>
                <MetricTd pres={p.adr} format={(v) => fmtMetric(v, 'float1')} words={STATE_WORD} />
              </tr>
            {/each}
          </tbody>
        </table>
      </section>
    {/each}
    {#if data.other.length > 0}
      <section class="panel">
        <h2>{S.match.rosterOther}</h2>
        <table class="data-table">
          <tbody>
            {#each data.other as p (p.steam)}
              <tr
                class="clickable"
                onclick={(e) => {
                  if (e.target instanceof Element && e.target.closest('button')) return;
                  follow(p.steam);
                }}
              >
                <td>{p.name}</td>
                <td class="num">{p.kda}</td>
                <MetricTd pres={p.adr} format={(v) => fmtMetric(v, 'float1')} words={STATE_WORD} />
              </tr>
            {/each}
          </tbody>
        </table>
      </section>
    {/if}
  {/if}
</div>
