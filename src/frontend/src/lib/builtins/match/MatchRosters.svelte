<script>
  import * as S from '../../strings/index.js';
  import { SQL_ROSTER, SQL_TEAMS, SQL_SWITCHES, startClass, readUnit, cellText, isSteam, teamName, followRoute } from './panelhelpers.js';

  // Match rosters: each side's players with K/D/A and ADR. Players sit in the
  // default order (kills, then name). The "Other" table appears only when a
  // player has no recorded side.
  let { spectra, context, back = '' } = $props();

  let data = $state(null);

  async function load(matchId) {
    if (matchId == null) return null;
    const [roster, teamRows, switchRows, kills, deaths, assists, adr] = await Promise.all([
      spectra.query(SQL_ROSTER),
      spectra.query(SQL_TEAMS),
      spectra.query(SQL_SWITCHES),
      readUnit(spectra, 'kills'),
      readUnit(spectra, 'deaths'),
      readUnit(spectra, 'assists'),
      readUnit(spectra, 'adr'),
    ]);
    const rows = roster.rows;
    const side = (s) => rows.filter((r) => r[2] === s);
    const other = rows.filter((r) => r[2] !== 'ct' && r[2] !== 't');
    const cell = (steam) => ({
      kda: [cellText(kills, steam, 'int'), cellText(deaths, steam, 'int'), cellText(assists, steam, 'int')].join('/'),
      adr: cellText(adr, steam, 'float1'),
    });
    const mapRow = (r) => ({ steam: r[0], name: r[1], side: r[2], ...cell(r[0]) });
    return {
      switches: Number((switchRows.rows[0] || [0])[0]) || 0,
      ct: { name: teamName('ct', teamRows.rows, rows), players: side('ct').map(mapRow) },
      t: { name: teamName('t', teamRows.rows, rows), players: side('t').map(mapRow) },
      other: other.map(mapRow),
    };
  }

  $effect(() => {
    const matchId = context.matchId;
    let live = true;
    data = null;
    load(matchId).then(
      (d) => {
        if (live) data = d;
      },
      () => {
        // A failed read is reported into this frame by the read API.
      },
    );
    return () => {
      live = false;
    };
  });

  function follow(steam) {
    spectra.navigate(followRoute(context.matchId, back, steam));
  }
</script>

{#if data}
  <div class="roster-grid">
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
              <tr class="clickable" onclick={(e) => { if (e.target instanceof Element && e.target.closest('button')) return; follow(p.steam); }}>
                <td class={startClass(p.side, data.switches)}>
                  {#if isSteam(p.steam)}
                    <button class="btn ghost small name-link {startClass(p.side, data.switches)}" onclick={(e) => { e.stopPropagation(); spectra.navigate('/player/' + p.steam); }}>{p.name}</button>
                  {:else}
                    {p.name}
                  {/if}
                </td>
                <td class="num">{p.kda}</td>
                <td class="num">{p.adr}</td>
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
              <tr class="clickable" onclick={(e) => { if (e.target instanceof Element && e.target.closest('button')) return; follow(p.steam); }}>
                <td>{p.name}</td>
                <td class="num">{p.kda}</td>
                <td class="num">{p.adr}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </section>
    {/if}
  </div>
{/if}
