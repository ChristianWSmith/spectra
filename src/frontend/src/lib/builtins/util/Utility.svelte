<script>
  import * as S from '../../strings/index.js';
  import { teamNames } from '../../builtinhelpers.js';
  const SQL_UTIL =
    'SELECT seq, tick, throw_tick, round, thrower, thrower_name, kind, throw_x, throw_y, det_x, det_y, ' +
    'damage, flash_ms, affected, site, trajectory_ref FROM utility_events WHERE match_id = :match_id ORDER BY seq ASC';
  const SQL_ROUNDS = 'SELECT number, winner, start_tick, end_tick FROM rounds WHERE match_id = :match_id ORDER BY number';
  const SQL_MATCH = 'SELECT tick_rate, side_switches FROM matches WHERE id = :match_id';
  const SQL_TEAMS = 'SELECT side, name FROM teams WHERE match_id = :match_id';
  const SQL_ROSTER =
    'SELECT ps.steam_id, p.name, p.side, ps.score FROM player_stats ps ' +
    'JOIN players p ON p.match_id = ps.match_id AND p.steam_id = ps.steam_id ' +
    'WHERE ps.match_id = :match_id AND p.is_bot = 0 ' +
    'ORDER BY (SELECT COUNT(*) FROM events e WHERE e.match_id = ps.match_id AND e.kind = \'kill\' ' +
    'AND e.attacker = ps.steam_id AND e.attacker <> e.victim AND NOT EXISTS (SELECT 1 FROM round_player_sides a ' +
    'JOIN round_player_sides v ON v.match_id = a.match_id AND v.round = a.round AND v.steam_id = e.victim ' +
    'WHERE a.match_id = e.match_id AND a.round = e.round AND a.steam_id = e.attacker AND a.side = v.side)) DESC, p.name ASC';

  // Utility view: the grenades, rounds, roster and match facts, loaded once. The
  // log and the two bar charts mount with this frame's context and the same data;
  // the charts get the rows the filters leave.
  let { spectra, context, back = '', loopSecs = 5, filters = null, onfilters = null } = $props();
  const UTIL_SQL = SQL_UTIL;
  const ROUNDS_SQL = SQL_ROUNDS;
  const MATCH_SQL = SQL_MATCH;
  const TEAMS_SQL = SQL_TEAMS;
  const ROSTER_SQL = SQL_ROSTER;

  let data = $state(null);
  // The filters are seeded from the Match view's remembered copy once, at mount;
  // after that the panel owns them (setFilt writes back through onfilters).
  // svelte-ignore state_referenced_locally
  let filt = $state({
    kindF: (filters && filters.kindF) || '',
    throwerF: (filters && filters.throwerF) || '',
    roundSel: (filters && filters.roundSel) || '',
  });

  function setFilt(next) {
    filt = next;
    if (onfilters) onfilters(next);
  }

  async function load(matchId) {
    if (matchId == null) return null;
    const [u, roundRows, m, teamRows, roster] = await Promise.all([
      spectra.query(UTIL_SQL),
      spectra.query(ROUNDS_SQL),
      spectra.query(MATCH_SQL),
      spectra.query(TEAMS_SQL),
      spectra.query(ROSTER_SQL),
    ]);
    const head = m.rows[0] || [0, 0];
    const tickRate = Number(head[0]) > 0 ? Number(head[0]) : 64;
    const sideSwitches = Number(head[1]) || 0;
    const rows = u.rows.map((r) => ({
      seq: r[0],
      tick: Number(r[1]) || 0,
      throwTick: Number(r[2]) || 0,
      round: Number(r[3]) || 0,
      thrower: r[4] || '',
      throwerName: r[5] || '',
      kind: r[6] || '',
      throwX: r[7] == null ? null : Number(r[7]),
      throwY: r[8] == null ? null : Number(r[8]),
      damage: Number(r[11]) || 0,
      flashMsTotal: Number(r[12]) || 0,
      affected: r[13] || '',
    }));
    const rounds = roundRows.rows.map((r) => ({ number: Number(r[0]), winner: r[1] || '', startTick: Number(r[2]), endTick: Number(r[3]) }));
    const players = roster.rows.map((r) => ({ steamId: r[0], name: r[1], side: r[2] }));
    const clan = new Map(teamRows.rows.map((t) => [t[0], t[1]]));
    const names = teamNames(clan.get('ct') || '', clan.get('t') || '', players);
    return { rows, rounds, players, names, tickRate, sideSwitches };
  }

  $effect(() => {
    const matchId = context.matchId;
    let live = true;
    load(matchId).then(
      (d) => {
        if (live) data = d;
      },
      () => {
        // A failed read is reported into this frame by the read API; the view
        // stays up on an empty set, as before (the banner names the failure).
        if (live) data = { rows: [], rounds: [], players: [], names: { ct: S.match.sideCt, t: S.match.sideT }, tickRate: 64, sideSwitches: 0 };
      },
    );
    return () => {
      live = false;
    };
  });

  // The throws the kind and thrower filters leave: what the two charts draw.
  const filtered = $derived(
    data
      ? data.rows.filter((r) => (filt.kindF === '' || r.kind === filt.kindF) && (filt.throwerF === '' || r.thrower === filt.throwerF))
      : [],
  );
</script>

<div class="view util-view">
  {#if data}
      <spectra.Child name="builtin-utility-log" props={{ rows: data.rows, rounds: data.rounds, players: data.players, names: data.names, sideSwitches: data.sideSwitches, tickRate: data.tickRate, loopSecs, back, filt, setFilt }} />
      <div class="util-summary">
        <spectra.Child name="builtin-utility-damage" props={{ measure: 'damage', rows: filtered, rounds: data.rounds, players: data.players, names: data.names, sideSwitches: data.sideSwitches }} />
        <spectra.Child name="builtin-utility-blind" props={{ measure: 'blind', rows: filtered, rounds: data.rounds, players: data.players, names: data.names, sideSwitches: data.sideSwitches }} />
      </div>

  {:else}
    <p class="muted" role="status">{S.utility.loading}</p>
  {/if}
</div>

<style>
  /* A tab root sits in a display: contents frame, so it is a flex item of the
     Match view's column, where the shared .view auto margins would shrink it to
     its content. Full width, like the other tabs. */
  .util-view {
    margin-inline: 0;
  }
</style>
