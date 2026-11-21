// The Match view's panels as builtin components (dogfood/PLAN.md C5b,
// dogfood/04-COMPONENTS.md §3, §3.5, §7). Each panel is Svelte 5 source
// held here as text, so it can be mounted through ComponentFrame like a user
// component and duplicated as one. A panel is the unit of composition: it
// reads metrics through `spectra.metric()` and facts through
// `spectra.query()`, both binding to the read-only `context` it is mounted
// with (`matchId`), and mounts nothing else.
//
// Formatting lives in each panel (04 §3, "Formatting belongs to
// components"): the HELPERS block below copies lib/fmt.js's rules for the
// metric formats the panels show (int, float1, float2, percent). The shipped
// Match view mounts these with its own context (`{ matchId }`) and the
// back-path of its current tab as the `back` prop, so the replay a row opens
// returns to the tab it came from.
//
// A missing or NULL stored value shows a dash, never a zero (PRODUCT.md
// Facts, ruling 23). A metric that is not fresh shows its state word.
//
// Retired preferences (ruling 33) are not read here: the default ordering is
// the only ordering. The scoreboard sorts on one key at a time (click a
// header); the chained multi-key sort of the old view is not carried over.

export const MATCH_PANEL_IDS = Object.freeze({
  overview: 'builtin-match-overview',
  rosters: 'builtin-match-rosters',
  scoreboard: 'builtin-match-scoreboard',
});

// The copy every panel shares, written once here and spliced into each
// source. It is part of each panel's own text, so a duplicate carries it.
// The component queries the panels read (read-only SQL, binds from context).
// They sit here as plain literals so the audit can exempt them by text: SQL
// the panel runs is not user copy.
const SQL_ROSTER =
  'SELECT ps.steam_id, p.name, p.side, ps.score FROM player_stats ps ' +
  'JOIN players p ON p.match_id = ps.match_id AND p.steam_id = ps.steam_id ' +
  'WHERE ps.match_id = :match_id AND p.is_bot = 0 ORDER BY ps.kills DESC, p.name ASC';
const SQL_TEAMS = 'SELECT side, name FROM teams WHERE match_id = :match_id';
const SQL_SWITCHES = 'SELECT side_switches FROM matches WHERE id = :match_id';

const HELPERS = `
  const DASH = '—';
  const SIDE_FLIP = { ct: 't', t: 'ct' };

  // The team colour class: the team's START side (the side it began the
  // match on), after the match's side switches (lib/teams.js teamStartClass).
  function startClass(side, switches) {
    if (side !== 'ct' && side !== 't') return '';
    const start = switches % 2 ? SIDE_FLIP[side] : side;
    return start === 'ct' ? 'team-start-ct' : 'team-start-t';
  }

  // One stored value as its text (lib/fmt.js fmtMetric's rules).
  function fmtValue(v, format) {
    if (v == null || !Number.isFinite(v)) return DASH;
    if (format === 'percent') return Math.round(v * 1000) / 10 + '%';
    if (format === 'float1') return (Math.round(v * 10) / 10).toFixed(1);
    if (format === 'float2') return (Math.round(v * 100) / 100).toFixed(2);
    if (format === 'int') return Math.round(v).toLocaleString();
    return Number.isInteger(v) ? Math.round(v).toLocaleString() : (Math.round(v * 100) / 100).toFixed(2);
  }

  const STATE_WORD = { processing: 'Calculating', failed: 'Failed', behind: 'Out of date' };

  // A metric read for this match: its state and each player's value.
  async function unit(name) {
    const m = await spectra.metric(name);
    const map = new Map();
    for (const r of m.rows) map.set(r.subject, r.value);
    return { state: m.state, error: m.error || '', map };
  }

  // What a stored cell shows: the value, a dash for no value, or the state.
  function cellText(u, key, format) {
    if (u.state === 'no-data') return DASH;
    if (u.state !== 'fresh') return STATE_WORD[u.state] || u.state;
    return u.map.has(key) ? fmtValue(u.map.get(key), format) : DASH;
  }

  function cellValue(u, key) {
    return u.state === 'fresh' && u.map.has(key) ? u.map.get(key) : null;
  }

  function isSteam(s) {
    return /^\\d{17}$/.test(s || '');
  }

  // The team display name of a side: the demo's clan name, else the
  // synthesized team_<player> name (lowest SteamID on the side), else CT / T.
  function teamName(side, teamRows, roster) {
    const hit = teamRows.find((r) => r[0] === side);
    if (hit && hit[1]) return hit[1];
    let best = null;
    for (const r of roster) {
      if (r[2] !== side || !r[1]) continue;
      if (!best || r[0] < best[0] || (r[0] === best[0] && r[1] < best[1])) best = r;
    }
    return best ? 'team_' + best[1] : side.toUpperCase();
  }

  // Stable sort on one key: a missing value sorts last in both directions,
  // and ties keep the incoming order.
  function sortRows(rows, valueOf, desc) {
    const keyed = rows.map((p, i) => ({ p, i, v: valueOf(p) }));
    keyed.sort((a, b) => {
      if (a.v == null || b.v == null) {
        if (a.v == null && b.v == null) return a.i - b.i;
        return a.v == null ? 1 : -1;
      }
      let c = typeof a.v === 'string' ? a.v.localeCompare(b.v) : a.v - b.v;
      if (desc) c = -c;
      return c !== 0 ? c : a.i - b.i;
    });
    return keyed.map((x) => x.p);
  }

  // The humans of this match in the default order (kills DESC, name ASC):
  // [steamId, name, side, score]. Bots are filtered here, as the scoreboard
  // always did.
  const ROSTER_SQL = ${JSON.stringify(SQL_ROSTER)};
  const TEAMS_SQL = ${JSON.stringify(SQL_TEAMS)};
  const SWITCHES_SQL = ${JSON.stringify(SQL_SWITCHES)};
`;

// The replay route a row opens, following that player. `back` is the tab
// the panel sits on (the Match view passes it); `matchId` is the context's.
const FOLLOW = `
  function replayRoute(matchId, back, steam) {
    const to = back || 'match/' + matchId;
    return '/replay/' + matchId + '?back=' + encodeURIComponent(to).replace(/%2F/g, '/') + '&follow=' + steam;
  }
`;

// --- the overview cards -----------------------------------------------------
// The five identity cards: who (the stored valueKey) and the number, as the
// card's own metric row supplies them. Labels are the metric titles.
export const OVERVIEW_SOURCE = `<script>
  // Match overview cards: the five identity metrics of the match, one card
  // each, in their default order (top fragger, best ADR, most util, entry
  // opens, most MVPs). A card with no pool shows nothing (never a name).
  let { spectra, context, back = '' } = $props();
  ${HELPERS}
  ${FOLLOW}

  const CARDS = [
    { metric: 'top_fragger', label: 'Top fragger' },
    { metric: 'best_adr', label: 'Best ADR' },
    { metric: 'most_util', label: 'Most util' },
    { metric: 'entry_opens', label: 'Entry opens' },
    { metric: 'most_mvps', label: 'Most MVPs' },
  ];

  let cards = $state([]);
  let ready = $state(false);

  async function load(matchId) {
    if (matchId == null) return { cards: [], switches: 0 };
    const [roster, switchRows, kills, deaths, assists, adr, util, opens, mvps] = await Promise.all([
      spectra.query(ROSTER_SQL),
      spectra.query(SWITCHES_SQL),
      unit('kills'),
      unit('deaths'),
      unit('assists'),
      unit('adr'),
      unit('utility_damage'),
      unit('entry_kills'),
      unit('mvps'),
    ]);
    const switches = Number((switchRows.rows[0] || [0])[0]) || 0;
    const who = new Map(roster.rows.map((r) => [r[0], { name: r[1], side: r[2] }]));
    const out = [];
    for (const card of CARDS) {
      const m = await spectra.metric(card.metric);
      if (m.state === 'no-data') continue;
      let steam = null;
      let value = '';
      if (m.state === 'fresh') {
        const row = m.rows[0];
        if (!row || !who.has(row.valueKey)) continue;
        steam = row.valueKey;
        if (card.metric === 'top_fragger') {
          value = [cellText(kills, steam, 'int'), cellText(deaths, steam, 'int'), cellText(assists, steam, 'int')].join('/');
        } else if (card.metric === 'best_adr') {
          value = cellText(adr, steam, 'float1');
        } else if (card.metric === 'most_util') {
          value = cellText(util, steam, 'int');
        } else if (card.metric === 'entry_opens') {
          value = cellText(opens, steam, 'int');
        } else {
          value = cellText(mvps, steam, 'int');
        }
      } else {
        value = STATE_WORD[m.state] || m.state;
      }
      const person = steam ? who.get(steam) : null;
      out.push({ key: card.metric, label: card.label, value, steam, name: person ? person.name : '', side: person ? person.side : '', state: m.state, title: m.error || '' });
    }
    return { cards: out, switches };
  }

  $effect(() => {
    const matchId = context.matchId;
    let live = true;
    ready = false;
    load(matchId).then(
      (res) => {
        if (!live) return;
        cards = res.cards;
        ready = true;
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
    spectra.navigate(replayRoute(context.matchId, back, steam));
  }
</script>

<section class="match-overview">
  {#if ready}
    <div class="stat-grid">
      {#each cards as c (c.key)}
        <div class="stat-cell" role="button" tabindex="0" title={c.title || undefined}
          onclick={(e) => { if (e.target instanceof Element && e.target.closest('button')) return; if (c.steam) follow(c.steam); }}
          onkeydown={(e) => { if (e.key === 'Enter' && c.steam) follow(c.steam); }}
        >
          <span class="field-label">{c.label}</span>
          <span class="stat-value">{c.value}</span>
          <span class="stat-sub">
            {#if c.steam && isSteam(c.steam)}
              <button class="btn ghost small name-link" onclick={(e) => { e.stopPropagation(); spectra.navigate('/player/' + c.steam); }}>{c.name}</button>
            {:else}
              {c.name}
            {/if}
          </span>
        </div>
      {/each}
    </div>
  {/if}
</section>
`;

// --- the rosters --------------------------------------------------------------
export const ROSTERS_SOURCE = `<script>
  // Match rosters: each side's players with K/D/A and ADR. Players sit in the
  // default order (kills, then name). The "Other" table appears only when a
  // player has no recorded side.
  let { spectra, context, back = '' } = $props();
  ${HELPERS}
  ${FOLLOW}

  let data = $state(null);

  async function load(matchId) {
    if (matchId == null) return null;
    const [roster, teamRows, switchRows, kills, deaths, assists, adr] = await Promise.all([
      spectra.query(ROSTER_SQL),
      spectra.query(TEAMS_SQL),
      spectra.query(SWITCHES_SQL),
      unit('kills'),
      unit('deaths'),
      unit('assists'),
      unit('adr'),
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
    spectra.navigate(replayRoute(context.matchId, back, steam));
  }
</script>

{#if data}
  <div class="roster-grid">
    {#each [data.ct, data.t] as team, ti (ti)}
      <section class="panel">
        <h2 class={startClass(ti === 0 ? 'ct' : 't', data.switches)}>{team.name} roster</h2>
        <table class="data-table">
          <thead>
            <tr>
              <th scope="col">Player</th>
              <th scope="col" class="num">K/D/A</th>
              <th scope="col" class="num">ADR</th>
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
        <h2>Other</h2>
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
`;

// --- the scoreboard -----------------------------------------------------------
// The default layout: Name, Team and Score, then the stored columns in their
// default order. Each column: the metric it reads, its header, its format.
const SCOREBOARD_COLUMNS = [
  ['kills', 'K', 'int'],
  ['deaths', 'D', 'int'],
  ['total_damage', 'DMG', 'int'],
  ['utility_damage', 'Util', 'int'],
  ['mvps', 'MVPs', 'int'],
  ['assists', 'A', 'int'],
  ['adr', 'ADR', 'float1'],
  ['kast', 'KAST%', 'percent'],
  ['hs_pct', 'HS%', 'percent'],
  ['kd', 'K/D', 'float2'],
  ['kda', 'KDA', 'float2'],
  ['two_k', '2K', 'int'],
  ['three_k', '3K', 'int'],
  ['four_k', '4K', 'int'],
  ['five_k', '5K', 'int'],
  ['entry_kills', 'Open K', 'int'],
  ['entry_deaths', 'Open D', 'int'],
  ['trade_kills', 'Trade', 'int'],
  ['best_streak', 'Streak', 'int'],
];

export const SCOREBOARD_SOURCE = `<script>
  // Match scoreboard: one row per human player, the default layout. Click a
  // header to sort on it (a second click reverses it); the default is kills,
  // highest first. A row opens the replay following that player.
  let { spectra, context, back = '' } = $props();
  ${HELPERS}
  ${FOLLOW}

  const COLUMNS = ${JSON.stringify(SCOREBOARD_COLUMNS.map(([metric, label, format]) => ({ metric, label, format })))};

  let data = $state(null);
  let sortKey = $state('kills');
  let sortDesc = $state(true);

  async function load(matchId) {
    if (matchId == null) return null;
    const names = COLUMNS.map((c) => c.metric);
    const [roster, teamRows, switchRows, ...units] = await Promise.all([
      spectra.query(ROSTER_SQL),
      spectra.query(TEAMS_SQL),
      spectra.query(SWITCHES_SQL),
      ...names.map((n) => unit(n)),
    ]);
    const byMetric = new Map(names.map((n, i) => [n, units[i]]));
    const rows = roster.rows.map((r) => ({ steam: r[0], name: r[1], side: r[2], score: r[3] }));
    return {
      switches: Number((switchRows.rows[0] || [0])[0]) || 0,
      teams: { ct: teamName('ct', teamRows.rows, roster.rows), t: teamName('t', teamRows.rows, roster.rows) },
      rows,
      byMetric,
    };
  }

  $effect(() => {
    const matchId = context.matchId;
    let live = true;
    data = null;
    sortKey = 'kills';
    sortDesc = true;
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

  // The value a row sorts on: the name, the team, the score, or a stored value.
  function sortValueOf(p) {
    if (sortKey === 'name') return p.name;
    if (sortKey === 'side') return data.teams[p.side] || null;
    if (sortKey === 'score') return Number.isFinite(Number(p.score)) ? Number(p.score) : null;
    return cellValue(data.byMetric.get(sortKey), p.steam);
  }

  const sorted = $derived(data ? sortRows(data.rows, sortValueOf, sortDesc) : []);

  function toggleSort(key) {
    if (sortKey === key) sortDesc = !sortDesc;
    else {
      sortKey = key;
      sortDesc = true;
    }
  }

  function follow(steam) {
    spectra.navigate(replayRoute(context.matchId, back, steam));
  }

  function ariaSort(key) {
    if (sortKey !== key) return 'none';
    return sortDesc ? 'descending' : 'ascending';
  }
</script>

{#if data}
  <div class="table-scroll">
    <table class="data-table scoreboard">
      <thead>
        <tr>
          <th scope="col" class="num" aria-sort={ariaSort('name')}><button class="th-sort" onclick={() => toggleSort('name')}>Name</button></th>
          <th scope="col" class="num" aria-sort={ariaSort('side')}><button class="th-sort" onclick={() => toggleSort('side')}>Team</button></th>
          <th scope="col" class="num" aria-sort={ariaSort('score')}><button class="th-sort" onclick={() => toggleSort('score')}>Score</button></th>
          {#each COLUMNS as c (c.metric)}
            <th scope="col" class="num" aria-sort={ariaSort(c.metric)}><button class="th-sort" onclick={() => toggleSort(c.metric)}>{c.label}</button></th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each sorted as p (p.steam)}
          {@const cls = startClass(p.side, data.switches)}
          <tr class="clickable" tabindex="0"
            onclick={(e) => { if (e.target instanceof Element && e.target.closest('button, a')) return; follow(p.steam); }}
            onkeydown={(e) => { if (e.key === 'Enter') follow(p.steam); }}
          >
            <td class="num name-cell {cls}">
              {#if isSteam(p.steam)}
                <button class="btn ghost small name-link {cls}" onclick={(e) => { e.stopPropagation(); spectra.navigate('/player/' + p.steam); }}>{p.name}</button>
              {:else}
                {p.name}
              {/if}
            </td>
            <td class="num"><span class="chip {cls}">{p.side === 'ct' ? data.teams.ct : p.side === 't' ? data.teams.t : DASH}</span></td>
            <td class="num">{Number.isFinite(Number(p.score)) ? Math.round(Number(p.score)).toLocaleString() : DASH}</td>
            {#each COLUMNS as c (c.metric)}
              {@const u = data.byMetric.get(c.metric)}
              <td class="num" title={u.error || undefined}>{cellText(u, p.steam, c.format)}</td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
`;

// The builtin panels, in the order the Match view mounts them.
export const MATCH_PANELS = Object.freeze([
  Object.freeze({ id: MATCH_PANEL_IDS.overview, label: 'Match overview cards', source: OVERVIEW_SOURCE }),
  Object.freeze({ id: MATCH_PANEL_IDS.rosters, label: 'Match rosters', source: ROSTERS_SOURCE }),
  Object.freeze({ id: MATCH_PANEL_IDS.scoreboard, label: 'Match scoreboard', source: SCOREBOARD_SOURCE }),
]);
