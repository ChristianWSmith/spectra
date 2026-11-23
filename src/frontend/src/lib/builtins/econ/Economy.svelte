<script>
  import * as S from '../../strings/index.js';
  import { teamNames, buildEconRows } from '../../builtinhelpers.js';
  const SQL_MATCH = 'SELECT score_ct, score_t, side_switches FROM matches WHERE id = :match_id';
  const SQL_ROUNDS = 'SELECT number, winner, start_tick, end_tick FROM rounds WHERE match_id = :match_id ORDER BY number';
  const SQL_ECON =
    'SELECT r.number, r.winner, r.equip_ct, r.equip_t, ' +
    'COALESCE(ct.money_sampled_sum, 0), COALESCE(t.money_sampled_sum, 0), ' +
    'COALESCE(ct.spent, 0), COALESCE(t.spent, 0), ' +
    'COALESCE(ct.free_pistol_value, 0), COALESCE(t.free_pistol_value, 0), ' +
    "COALESCE(rc.label, ''), COALESCE(rc.explanation, ''), COALESCE(rc.rule_version, 0), " +
    "COALESCE(rsct.class, ''), COALESCE(rsct.why, ''), COALESCE(rst.class, ''), COALESCE(rst.why, '') " +
    'FROM rounds r ' +
    "LEFT JOIN round_economy ct ON ct.match_id = r.match_id AND ct.round = r.number AND ct.side = 'ct' " +
    "LEFT JOIN round_economy t ON t.match_id = r.match_id AND t.round = r.number AND t.side = 't' " +
    'LEFT JOIN round_classifications rc ON rc.match_id = r.match_id AND rc.round = r.number ' +
    "LEFT JOIN round_side_classes rsct ON rsct.match_id = r.match_id AND rsct.round = r.number AND rsct.side = 'ct' " +
    "LEFT JOIN round_side_classes rst ON rst.match_id = r.match_id AND rst.round = r.number AND rst.side = 't' " +
    'WHERE r.match_id = :match_id ORDER BY r.number ASC';
  const SQL_SIDES =
    'SELECT round, steam_id, side FROM round_player_sides WHERE match_id = :match_id ORDER BY round ASC, steam_id ASC';
  const SQL_TEAMS = 'SELECT side, name FROM teams WHERE match_id = :match_id';
  const SQL_ROSTER =
    'SELECT ps.steam_id, p.name, p.side, ps.score FROM player_stats ps ' +
    'JOIN players p ON p.match_id = ps.match_id AND p.steam_id = ps.steam_id ' +
    'WHERE ps.match_id = :match_id AND p.is_bot = 0 ' +
    'ORDER BY (SELECT COUNT(*) FROM events e WHERE e.match_id = ps.match_id AND e.kind = \'kill\' ' +
    'AND e.attacker = ps.steam_id AND e.attacker <> e.victim AND NOT EXISTS (SELECT 1 FROM round_player_sides a ' +
    'JOIN round_player_sides v ON v.match_id = a.match_id AND v.round = a.round AND v.steam_id = e.victim ' +
    'WHERE a.match_id = e.match_id AND a.round = e.round AND a.steam_id = e.attacker AND a.side = v.side)) DESC, p.name ASC';

  // Economy view: the rounds, the economy rows and the team names, loaded once
  // for the three panels below. Each panel mounts with this frame's context
  // (the match) and the Match view's back path.
  let { spectra, context, back = '' } = $props();
  const MATCH_SQL = SQL_MATCH;
  const ROUNDS_SQL = SQL_ROUNDS;
  const ECON_SQL = SQL_ECON;
  const SIDES_SQL = SQL_SIDES;
  const TEAMS_SQL = SQL_TEAMS;
  const ROSTER_SQL = SQL_ROSTER;

  let state = $state(null);

  async function load(matchId) {
    if (matchId == null) return null;
    const [m, roundRows, ecoRows, sideRows, teamRows, roster] = await Promise.all([
      spectra.query(MATCH_SQL),
      spectra.query(ROUNDS_SQL),
      spectra.query(ECON_SQL),
      spectra.query(SIDES_SQL),
      spectra.query(TEAMS_SQL),
      spectra.query(ROSTER_SQL),
    ]);
    const head = m.rows[0] || [0, 0, 0];
    const scoreCT = Number(head[0]) || 0;
    const scoreT = Number(head[1]) || 0;
    const sideSwitches = Number(head[2]) || 0;
    const rounds = roundRows.rows.map((r) => ({ number: Number(r[0]), winner: r[1] || '', startTick: Number(r[2]), endTick: Number(r[3]) }));
    const rows = buildEconRows(ecoRows.rows, sideRows.rows);
    const clan = new Map(teamRows.rows.map((t) => [t[0], t[1]]));
    const players = roster.rows.map((r) => ({ steamId: r[0], name: r[1], side: r[2] }));
    const names = teamNames(clan.get('ct') || '', clan.get('t') || '', players);
    const matchWinner = scoreCT === scoreT ? '' : scoreCT > scoreT ? 'ct' : 't';
    return { rows, rounds, names, sideSwitches, matchWinner };
  }

  $effect(() => {
    const matchId = context.matchId;
    let live = true;
    load(matchId).then(
      (d) => {
        if (live) state = d;
      },
      () => {
        // A failed read is reported into this frame by the read API; the view
        // stays up on an empty set, as before (the banner names the failure).
        if (live) state = { rows: [], rounds: [], names: { ct: S.match.sideCt, t: S.match.sideT }, sideSwitches: 0, matchWinner: '' };
      },
    );
    return () => {
      live = false;
    };
  });
</script>

<div class="view econ-view" class:builtin-busy={spectra.busy} aria-busy={spectra.busy}>
  <span class="builtin-throbber" aria-hidden="true"></span>
  {#if state}
      <div class="econ-head">
        <span class="muted">{state.rows.length}{state.rows.length === 1 ? ' round' : ' rounds'}</span>
        <span class="spacer"></span>
        <span class="muted econ-head-note">{S.economy.headNote}</span>
      </div>

      <spectra.Child name="builtin-economy-curve" props={{ rows: state.rows, names: state.names, sideSwitches: state.sideSwitches, matchWinner: state.matchWinner, back }} />
      <spectra.Child name="builtin-economy-cards" props={{ rows: state.rows, rounds: state.rounds, names: state.names, back }} />
      <spectra.Child name="builtin-economy-rounds" props={{ rows: state.rows, rounds: state.rounds, names: state.names, sideSwitches: state.sideSwitches, back }} />

  {:else}
    <p class="muted" role="status">{S.economy.loading}</p>
  {/if}
</div>

<style>
  /* A tab root sits in a display: contents frame, so it is a flex item of the
     Match view's column, where the shared .view auto margins would shrink it to
     its content. Full width, like the other tabs. */
  .econ-view {
    margin-inline: 0;
  }
</style>
