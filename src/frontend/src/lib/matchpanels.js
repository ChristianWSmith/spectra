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
// the only ordering. The scoreboard keeps the old view's chained multi-key
// sort (click a header to sort on it; earlier clicks break its ties).

import * as S from './strings/index.js';

export const MATCH_PANEL_IDS = Object.freeze({
  overview: 'builtin-match-overview',
  rosters: 'builtin-match-rosters',
  scoreboard: 'builtin-match-scoreboard',
  rounds: 'builtin-match-rounds',
  details: 'builtin-match-details',
});

// The copy every panel shares, written once here and spliced into each
// source. It is part of each panel's own text, so a duplicate carries it.
// The component queries the panels read (read-only SQL, binds from context).
// They sit here as plain literals so the audit can exempt them by text: SQL
// the panel runs is not user copy.
const SQL_ROSTER =
  'SELECT ps.steam_id, p.name, p.side, ps.score FROM player_stats ps ' +
  'JOIN players p ON p.match_id = ps.match_id AND p.steam_id = ps.steam_id ' +
  'WHERE ps.match_id = :match_id AND p.is_bot = 0 ' +
  'ORDER BY (SELECT COUNT(*) FROM events e WHERE e.match_id = ps.match_id AND e.kind = \'kill\' ' +
  'AND e.attacker = ps.steam_id AND e.attacker <> e.victim AND NOT EXISTS (SELECT 1 FROM round_player_sides a ' +
  'JOIN round_player_sides v ON v.match_id = a.match_id AND v.round = a.round AND v.steam_id = e.victim ' +
  'WHERE a.match_id = e.match_id AND a.round = e.round AND a.steam_id = e.attacker AND a.side = v.side)) DESC, p.name ASC';
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
    return { state: m.state, error: m.error || '', doc: m.doc || '', map };
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

  // The chained sort (the old Match view's rule): each stack entry is applied
  // to the sequence the earlier entries produced, so the newest key is the
  // primary and the earlier keys break its ties. Every step breaks ties on
  // the incoming index, so a key whose values are all tied moves nothing. A
  // missing value sorts last in both directions; strings compare by locale,
  // numbers by value.
  function sortRows(rows, stack, valueOf) {
    let out = rows;
    for (const entry of stack) {
      const keyed = out.map((p, i) => ({ p, i, v: valueOf(entry.key, p) }));
      keyed.sort((a, b) => {
        if (a.v == null || b.v == null) {
          if (a.v == null && b.v == null) return a.i - b.i;
          return a.v == null ? 1 : -1;
        }
        let c = typeof a.v === 'string' || typeof b.v === 'string'
          ? String(a.v).localeCompare(String(b.v))
          : a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
        if (entry.desc) c = -c;
        return c !== 0 ? c : a.i - b.i;
      });
      out = keyed.map((x) => x.p);
    }
    return out;
  }

  // The humans of this match in the default order (kills DESC, name ASC):
  // [steamId, name, side, score]. Bots are filtered here, as the scoreboard
  // always did.
  const ROSTER_SQL = ${JSON.stringify(SQL_ROSTER)};
  const TEAMS_SQL = ${JSON.stringify(SQL_TEAMS)};
  const SWITCHES_SQL = ${JSON.stringify(SQL_SWITCHES)};

  // {placeholder} fill for catalog copy the panel carries (lib/strings).
  function fill(template, args) {
    return String(template).replace(/\\{(\\w+)\\}/g, (whole, key) => (key in args ? String(args[key]) : whole));
  }
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
  // header to sort on it: a new header sorts on top of the chain built so far
  // (the newest key is primary, earlier keys break its ties); a click on the
  // newest header reverses it. The chain starts at kills, highest first. A row
  // opens the replay following that player.
  let { spectra, context, back = '' } = $props();
  ${HELPERS}
  ${FOLLOW}

  const COLUMNS = ${JSON.stringify(SCOREBOARD_COLUMNS.map(([metric, label, format]) => ({ metric, label, format })))};

  let data = $state(null);
  let sortStack = $state([{ key: 'kills', desc: true }]);
  const sortKey = $derived(sortStack[sortStack.length - 1].key);
  const sortDesc = $derived(sortStack[sortStack.length - 1].desc);

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
    sortStack = [{ key: 'kills', desc: true }];
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
    return (u.doc || metric) + (u.error ? ' — couldn’t calculate: ' + u.error : '');
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
            <th scope="col" class="num" title={headerTitle(c.metric)} aria-sort={ariaSort(c.metric)}><button class="th-sort" onclick={() => toggleSort(c.metric)}>{c.label}</button></th>
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

// --- the rounds ----------------------------------------------------------------
// One row per round, in round order: the watch ▶, the compare box, the round
// number, the winner, the reason, the duration, the bomb site, the MVP, the
// first blood and the kill count. The rows come from the stored `rounds`
// table through query(); a NULL stored value shows a dash. The compare picks
// and the compare button belong to the surface (the Match view keeps them per
// match), so they arrive as props (`picks`, `onPick`, `onCompare`).
const SQL_ROUNDS =
  "SELECT r.number, r.winner, r.reason, (CAST(r.end_tick - r.start_tick AS REAL) / (SELECT m.tick_rate FROM matches m WHERE m.id = r.match_id)), r.bomb_site, r.mvp, COALESCE(mp.name, ''), " +
  "r.first_kill_steam, COALESCE(fp.name, ''), r.first_death_steam, COALESCE(dp.name, ''), " +
  "(SELECT COUNT(*) FROM events e WHERE e.match_id = r.match_id AND e.round = r.number AND e.kind = 'kill'), " +
  "r.start_tick, r.end_tick FROM rounds r " +
  "LEFT JOIN players mp ON mp.match_id = r.match_id AND r.mvp <> '' AND mp.steam_id = r.mvp " +
  "LEFT JOIN players fp ON fp.match_id = r.match_id AND r.first_kill_steam <> '' AND fp.steam_id = r.first_kill_steam " +
  "LEFT JOIN players dp ON dp.match_id = r.match_id AND r.first_death_steam <> '' AND dp.steam_id = r.first_death_steam " +
  "WHERE r.match_id = :match_id ORDER BY r.number ASC";

// The copy the rounds panel shows, spliced into its source (lib/strings).
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

// The round helpers the rounds panel carries: the counted-round rule, the
// round-group separator (lib/rounds.js separatorFlags), the side each team had
// in a round (lib/sideparity.js sideAtRound, winnerTeamKey) and the round's
// duration and label rules. They copy the app's own rules, so a duplicate
// carries them.
const ROUND_HELPERS = `
  const isCounted = (r) => !!r && r.number >= 1;

  // The cadence: after 12, after 24, then every 3 counted rounds (lib/rounds.js).
  function separatorAfter(n) {
    if (!Number.isFinite(n)) return false;
    if (n === 12) return true;
    return n >= 24 && (n - 24) % 3 === 0;
  }

  // A separator follows a counted row, except the last counted row.
  function separatorFlags(rows) {
    const counted = rows.filter(isCounted).length;
    let seen = 0;
    return rows.map((r) => (isCounted(r) ? ++seen < counted && separatorAfter(seen) : false));
  }

  function roundLabel(n) {
    if (n >= 1) return String(n);
    return n === -2 ? 'K' : 'W';
  }

  function fmtDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return DASH;
    const s = Math.round(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return h + 'h' + String(m).padStart(2, '0') + 'm' + String(sec).padStart(2, '0') + 's';
    if (m > 0) return m + 'm' + String(sec).padStart(2, '0') + 's';
    return sec + 's';
  }

  function flipIndexes(counted, switches) {
    if (counted <= 0 || switches <= 0) return [];
    const flips = [];
    for (let k = 1; k <= switches; k++) {
      const idx = k === 1 ? 12 : 27 + 3 * (k - 2);
      if (idx > 0 && idx < counted) flips.push(idx);
    }
    return flips;
  }

  function sideInEra(finalSide, switches, era) {
    if (finalSide !== 'ct' && finalSide !== 't') return null;
    const eras = Math.max(1, switches + 1);
    const flipped = Math.abs(eras - 1 - era) % 2;
    if (flipped === 0) return finalSide;
    return finalSide === 'ct' ? 't' : 'ct';
  }

  // The side a team (by its final side) played in a round.
  function sideAtRound(rounds, switches, number, finalSide) {
    if (finalSide !== 'ct' && finalSide !== 't') return null;
    if (!rounds.some((r) => r.number === number)) return null;
    const counted = rounds.filter(isCounted);
    const idx = counted.findIndex((r) => r.number === number);
    const flips = flipIndexes(counted.length, switches);
    const eras = Math.max(1, switches + 1);
    let era = 0;
    if (idx >= 0) {
      for (const f of flips) if (f <= idx) era++;
      era = Math.min(eras - 1, era);
    }
    return sideInEra(finalSide, switches, era);
  }

  // The team ('ct' or 't', by final side) that won a round, or null.
  function winnerTeamKey(rounds, switches, number, winnerSide) {
    if (winnerSide !== 'ct' && winnerSide !== 't') return null;
    const ctSide = sideAtRound(rounds, switches, number, 'ct');
    if (ctSide === null) return null;
    return ctSide === winnerSide ? 'ct' : 't';
  }

  // A player's final side: by SteamID first, then by exact name.
  function resolveSide(roster, steam, name) {
    let side = '';
    if (steam) {
      const hit = roster.find((r) => r[0] === steam);
      if (hit) side = hit[2] || '';
    }
    if (!side && name) {
      const hit = roster.find((r) => r[1] === name);
      if (hit) side = hit[2] || '';
    }
    return side;
  }

  // A player's colour in one round: the side they had in that round, else the
  // match's start-side colour for the player (never a guess).
  function playerRoundCls(d, number, steam, name) {
    const final = resolveSide(d.roster, steam, name);
    const at = sideAtRound(d.rounds, d.switches, number, final) || '';
    if (at === 'ct') return 'side-ct';
    if (at === 't') return 'side-t';
    return startClass(final, d.switches);
  }

  function roundOf(r) {
    return {
      number: Number(r[0]),
      winner: r[1] || '',
      reason: r[2] || '',
      durationS: r[3] == null ? NaN : Number(r[3]),
      bombSite: r[4] || '',
      mvp: r[5] || '',
      mvpName: r[6] || '',
      firstKillSteam: r[7] || '',
      firstKillName: r[8] || '',
      firstDeathSteam: r[9] || '',
      firstDeathName: r[10] || '',
      kills: Number(r[11]) || 0,
      startTick: r[12] == null ? NaN : Number(r[12]),
      endTick: r[13] == null ? NaN : Number(r[13]),
    };
  }
`;

export const ROUNDS_SOURCE = `<script>
  // Match rounds: one row per round, in round order. The ▶ watches the round
  // in the replay from its own start, its span looped, back to this tab. The
  // compare box picks up to four rounds (the surface keeps the picks); the
  // button under the table compares them. A click on the rest of the row
  // opens the round's page.
  let { spectra, context, back = '', picks = [], onPick, onCompare } = $props();
  ${HELPERS}
  ${ROUND_HELPERS}
  const COPY = ${JSON.stringify(ROUNDS_COPY)};
  const ROUNDS_SQL = ${JSON.stringify(SQL_ROUNDS)};
  const pick = (n) => (onPick ? onPick(n) : undefined);
  const compare = () => (onCompare ? onCompare() : undefined);

  let data = $state(null);

  async function load(matchId) {
    if (matchId == null) return null;
    const [rounds, roster, teamRows, switchRows] = await Promise.all([
      spectra.query(ROUNDS_SQL),
      spectra.query(ROSTER_SQL),
      spectra.query(TEAMS_SQL),
      spectra.query(SWITCHES_SQL),
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
    data = null;
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
    <button class="comb-name-btn {cls}" title={fill(COPY.openProfile, { name })} onclick={() => spectra.navigate('/player/' + steam)}>{name || DASH}</button>
  {:else}
    <span class={cls}>{name || DASH}</span>
  {/if}
{/snippet}

{#if data}
  <div class="table-scroll">
    <table class="data-table">
      <thead>
        <tr>
          <th scope="col"><span class="sr-only">{COPY.colWatch}</span></th>
          <th scope="col" class="num cmp-cmp-col" title={COPY.compareSelectTitle}>{COPY.colCmp}</th>
          <th scope="col" class="num">RD</th>
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
`;

// --- the details: key facts -------------------------------------------------------
// The stored facts of the match. Voice presence and the demo-copy state are NOT
// here: voice is kept out of the component reads (the query allowlist denies
// it) and the copy state is read from the filesystem, so the Match view keeps
// both beside this panel.
const SQL_FACTS =
  'SELECT server_name, tick_rate, frames, size, extracted_at, parser_version, path, warnings_count ' +
  'FROM matches WHERE id = :match_id';

const DETAILS_COPY = Object.freeze({
  keyFacts: S.match.keyFacts,
  factServer: S.match.factServer,
  factTickrate: S.match.factTickrate,
  factFrames: S.match.factFrames,
  factSize: S.match.factSize,
  factImported: S.match.factImported,
  factParser: S.match.factParser,
  factWarnings: S.match.factWarnings,
  factSource: S.match.factSource,
});

// The detail helpers: the app's formatting rules for these facts (lib/fmt.js),
// and the reader for the stored import time, which SQLite keeps as Go wrote it
// ("2026-11-18 21:00:15.014 +0000 UTC"), not as ISO text.
const DETAIL_HELPERS = `
  function numOf(v) {
    return v == null || v === '' ? NaN : Number(v);
  }

  function fmtBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return DASH;
    const mb = bytes / (1024 * 1024);
    if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
    if (mb >= 1) return mb.toFixed(1) + ' MB';
    return (bytes / 1024).toFixed(1) + ' KB';
  }

  function fmtInt(x) {
    if (!Number.isFinite(x)) return DASH;
    return Math.round(x).toLocaleString();
  }

  function fmt1(x) {
    if (!Number.isFinite(x)) return DASH;
    return (Math.round(x * 10) / 10).toFixed(1);
  }

  function parseStamp(s) {
    const t = String(s || '').trim();
    if (!t) return null;
    const m = /^(\\d{4}-\\d{2}-\\d{2})[ T](\\d{2}:\\d{2}:\\d{2})(\\.\\d+)?(?: ([+-]\\d{2})(\\d{2})(?: UTC)?)?$/.exec(t);
    if (!m) {
      const d = new Date(t);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const ms = m[3] ? '.' + m[3].slice(1, 4).padEnd(3, '0') : '';
    const off = m[4] ? m[4] + ':' + m[5] : 'Z';
    const d = new Date(m[1] + 'T' + m[2] + ms + off);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function fmtDate(d) {
    if (!d || d.getUTCFullYear() <= 1) return DASH;
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
`;

export const DETAILS_SOURCE = `<script>
  // Match details: the key facts of the match (server, tickrate, frames, size,
  // import time, parser, warnings, source file). A NULL or missing stored value
  // shows a dash.
  let { spectra, context } = $props();
  ${HELPERS}
  ${DETAIL_HELPERS}
  const COPY = ${JSON.stringify(DETAILS_COPY)};
  const FACTS_SQL = ${JSON.stringify(SQL_FACTS)};

  let facts = $state(null);

  async function load(matchId) {
    if (matchId == null) return null;
    const res = await spectra.query(FACTS_SQL);
    const r = res.rows[0];
    if (!r) return null;
    return {
      server: r[0] || '',
      tickRate: numOf(r[1]),
      frames: numOf(r[2]),
      size: numOf(r[3]),
      extractedAt: parseStamp(r[4]),
      parser: r[5] || '',
      path: r[6] || '',
      warnings: numOf(r[7]),
    };
  }

  $effect(() => {
    const matchId = context.matchId;
    let live = true;
    facts = null;
    load(matchId).then(
      (f) => {
        if (live) facts = f;
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
</script>

{#if facts}
  <section class="panel">
    <h2>{COPY.keyFacts}</h2>
    <dl class="facts">
      <div><dt>{COPY.factServer}</dt><dd>{facts.server || DASH}</dd></div>
      <div><dt>{COPY.factTickrate}</dt><dd>{Number.isFinite(facts.tickRate) ? fmt1(facts.tickRate) + ' Hz' : DASH}</dd></div>
      <div><dt>{COPY.factFrames}</dt><dd class="num">{fmtInt(facts.frames)}</dd></div>
      <div><dt>{COPY.factSize}</dt><dd>{fmtBytes(facts.size)}</dd></div>
      <div><dt>{COPY.factImported}</dt><dd>{fmtDate(facts.extractedAt)}</dd></div>
      <div><dt>{COPY.factParser}</dt><dd class="mono">{facts.parser || DASH}</dd></div>
      <div><dt>{COPY.factWarnings}</dt><dd>{Number.isFinite(facts.warnings) ? facts.warnings : DASH}</dd></div>
      <div class="fact-wide"><dt>{COPY.factSource}</dt><dd class="mono">{facts.path || DASH}</dd></div>
    </dl>
  </section>
{/if}
`;

// The builtin panels, in the order the Match view mounts them.
export const MATCH_PANELS = Object.freeze([
  Object.freeze({ id: MATCH_PANEL_IDS.overview, label: 'Match overview cards', source: OVERVIEW_SOURCE }),
  Object.freeze({ id: MATCH_PANEL_IDS.rosters, label: 'Match rosters', source: ROSTERS_SOURCE }),
  Object.freeze({ id: MATCH_PANEL_IDS.scoreboard, label: 'Match scoreboard', source: SCOREBOARD_SOURCE }),
  Object.freeze({ id: MATCH_PANEL_IDS.rounds, label: 'Match rounds', source: ROUNDS_SOURCE }),
  Object.freeze({ id: MATCH_PANEL_IDS.details, label: 'Match details', source: DETAILS_SOURCE }),
]);
