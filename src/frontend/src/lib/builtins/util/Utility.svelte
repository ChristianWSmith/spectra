<script>
  import { SQL_ROSTER, SQL_TEAMS, SQL_ROUND_SPANS, roundsOf, rosterOf, namesOf, loadForMatch, S } from '../../builtinhelpers.js';
  const SQL_UTIL =
    'SELECT seq, tick, throw_tick, round, thrower, thrower_name, kind, throw_x, throw_y, det_x, det_y, ' +
    'damage, flash_ms, affected, site, trajectory_ref FROM utility_events WHERE match_id = :match_id ORDER BY seq ASC';
  const SQL_MATCH = 'SELECT tick_rate, side_switches FROM matches WHERE id = :match_id';

  // Utility view: the grenades, rounds, roster and match facts, loaded once. The
  // log and the two bar charts mount with this frame's context and the same data;
  // the charts get the rows the filters leave.
  let { spectra, context, back = '', loopSecs = 5, filters = null, onfilters = null } = $props();
  const UTIL_SQL = SQL_UTIL;
  const ROUNDS_SQL = SQL_ROUND_SPANS;
  const MATCH_SQL = SQL_MATCH;
  const TEAMS_SQL = SQL_TEAMS;
  const ROSTER_SQL = SQL_ROSTER;

  // The kinds checked in the kind multi-select: a list; [] is the no-filter default. An older
  // record that held one kind as a string reads as a one-kind list.
  function kindList(v) {
    return Array.isArray(v) ? v : v ? [v] : [];
  }

  let data = $state(null);
  // Empty until the data lands: the panels mount with it and reserve their space while it loads.
  const view = $derived(
    data ?? {
      rows: [],
      rounds: [],
      players: [],
      names: { ct: S.match.sideCt, t: S.match.sideT },
      tickRate: 64,
      sideSwitches: 0,
    },
  );
  // The filters are seeded from the Match view's remembered copy once, at mount;
  // after that the panel owns them (setFilt writes back through onfilters).
  // svelte-ignore state_referenced_locally
  let filt = $state({
    kindF: kindList(filters && filters.kindF),
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
    const rounds = roundsOf(roundRows.rows);
    const players = rosterOf(roster.rows);
    const names = namesOf(teamRows.rows, players);
    return { rows, rounds, players, names, tickRate, sideSwitches };
  }

  $effect(
    loadForMatch(
      () => context.matchId,
      load,
      (d) => (data = d),
      (e) => {
        spectra.report(e);
        data = {
          rows: [],
          rounds: [],
          players: [],
          names: { ct: S.match.sideCt, t: S.match.sideT },
          tickRate: 64,
          sideSwitches: 0,
        };
      },
    ),
  );

  // The throws the kind and thrower filters leave: what the two charts draw.
  const filtered = $derived(
    data
      ? data.rows.filter(
          (r) =>
            (filt.kindF.length === 0 || filt.kindF.includes(r.kind)) &&
            (filt.throwerF === '' || r.thrower === filt.throwerF),
        )
      : [],
  );
</script>

<div class="view util-view tab-root">
  <spectra.Child
    name="match-utility-log"
    props={{
      rows: view.rows,
      rounds: view.rounds,
      players: view.players,
      names: view.names,
      sideSwitches: view.sideSwitches,
      tickRate: view.tickRate,
      loopSecs,
      back,
      filt,
      setFilt,
    }}
  />
  <div class="util-summary">
    <spectra.Child
      name="match-utility-damage"
      props={{
        measure: 'damage',
        rows: filtered,
        rounds: view.rounds,
        players: view.players,
        names: view.names,
        sideSwitches: view.sideSwitches,
      }}
    />
    <spectra.Child
      name="match-utility-blind"
      props={{
        measure: 'blind',
        rows: filtered,
        rounds: view.rounds,
        players: view.players,
        names: view.names,
        sideSwitches: view.sideSwitches,
      }}
    />
  </div>
</div>
