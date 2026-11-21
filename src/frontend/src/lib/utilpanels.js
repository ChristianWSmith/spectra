// The Utility view as builtin components (dogfood/PLAN.md C5c, C5a's nested
// mount, dogfood/04-COMPONENTS.md §3, §3.5, §7). The Utility builtin is a
// composer: it loads the match's grenades, rounds and roster once, holds the
// view's filters (kind, thrower, round), and mounts three panels with
// `spectra.Child`, each receiving the same read-only `context` from the Match
// view:
//
//   builtin-utility-log     the throw log: filters, count, round scope, one row per throw
//   builtin-utility-damage  utility damage per round, by team (bars)
//   builtin-utility-blind   blind time per round, by team (bars)
//
// The filters are the view's own state. The Match view passes the remembered
// filters of this match in (`filters`) and keeps what the user picks (`onfilters`),
// so they survive a tab switch while the match is open, as they did before.
// The loop length comes from the Match view too (the `loop_secs` preference,
// which a builtin cannot read); it arrives as `loopSecs`.
//
// The English copy is written here, as matchpanels.js does, and the helpers come
// from builtinhelpers.js. A missing value shows a dash (ruling 23).

import { FMT_HELPERS, TICK_HELPERS, TEAM_HELPERS, NAV_HELPERS } from './builtinhelpers.js';

export const UTIL_PANEL_IDS = Object.freeze({
  utility: 'builtin-utility',
  log: 'builtin-utility-log',
  damage: 'builtin-utility-damage',
  blind: 'builtin-utility-blind',
});

// The read-only SQL the utility builtins run (bound from the context). Each reads
// the same rows as the Go view it replaces (store.GetUtility, GetRounds, the
// scoreboard roster, GetTeamNames and the match row).
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

// The composer: loads the shared rows and holds the filters.
export const UTILITY_SOURCE = `<script>
  // Utility view: the grenades, rounds, roster and match facts, loaded once. The
  // log and the two bar charts mount with this frame's context and the same data;
  // the charts get the rows the filters leave.
  let { spectra, context, back = '', loopSecs = 5, filters = null, onfilters = null } = $props();
  ${FMT_HELPERS}
  ${TICK_HELPERS}
  ${TEAM_HELPERS}
  ${NAV_HELPERS}
  const UTIL_SQL = ${JSON.stringify(SQL_UTIL)};
  const ROUNDS_SQL = ${JSON.stringify(SQL_ROUNDS)};
  const MATCH_SQL = ${JSON.stringify(SQL_MATCH)};
  const TEAMS_SQL = ${JSON.stringify(SQL_TEAMS)};
  const ROSTER_SQL = ${JSON.stringify(SQL_ROSTER)};

  let data = $state(null);
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
    data = null;
    load(matchId).then(
      (d) => {
        if (live) data = d;
      },
      () => {
        // A failed read is reported into this frame by the read API; the view
        // stays up on an empty set, as before (the banner names the failure).
        if (live) data = { rows: [], rounds: [], players: [], names: { ct: 'CT', t: 'T' }, tickRate: 64, sideSwitches: 0 };
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

{#if data}
  <div class="view util-view">
    <spectra.Child name="${UTIL_PANEL_IDS.log}" props={{ rows: data.rows, rounds: data.rounds, players: data.players, names: data.names, sideSwitches: data.sideSwitches, tickRate: data.tickRate, loopSecs, back, filt, setFilt }} />
    <div class="util-summary">
      <spectra.Child name="${UTIL_PANEL_IDS.damage}" props={{ rows: filtered, rounds: data.rounds, players: data.players, names: data.names, sideSwitches: data.sideSwitches }} />
      <spectra.Child name="${UTIL_PANEL_IDS.blind}" props={{ rows: filtered, rounds: data.rounds, players: data.players, names: data.names, sideSwitches: data.sideSwitches }} />
    </div>
  </div>
{:else}
  <p class="muted" role="status">Loading utility events…</p>
{/if}
`;

// The throw log: one panel, the filters on top, one row per throw under the
// round scope. The row's play button leads, and it watches the throw with the
// thrower followed.
export const UTIL_LOG_SOURCE = `<script>
  // Utility throw log: the kind, thrower and round filters, the count, and one
  // row per throw. The filter state lives in the composer (filt / setFilt).
  let { spectra, context, rows = [], rounds = [], players = [], names = { ct: 'CT', t: 'T' }, sideSwitches = 0, tickRate = 64, loopSecs = 5, back = '', filt, setFilt } = $props();
  ${FMT_HELPERS}
  ${TICK_HELPERS}
  ${TEAM_HELPERS}
  ${NAV_HELPERS}

  const origin = () => back || 'match/' + context.matchId + '/utility';
  const rbn = $derived(roundsByNumber(rounds));
  const teamBySteam = $derived(new Map(players.map((p) => [p.steamId, p.side || ''])));
  const effTick = (r) => (r.throwTick > 0 ? r.throwTick : r.tick);

  const kindOptions = $derived([...new Set(rows.map((r) => r.kind).filter(Boolean))].sort());

  const filtered = $derived(rows.filter((r) => (filt.kindF === '' || r.kind === filt.kindF) && (filt.throwerF === '' || r.thrower === filt.throwerF)));

  const groups = $derived.by(() => {
    const m = new Map();
    for (const r of filtered) {
      if (!m.has(r.round)) m.set(r.round, []);
      m.get(r.round).push(r);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  });

  const roundOptions = $derived(groups.map(([round]) => round));

  // What the round select shows: the recorded choice while it still exists, else
  // the first round with throws, else "All rounds".
  const roundValue = $derived(
    filt.roundSel === 'all'
      ? 'all'
      : filt.roundSel !== '' && roundOptions.some((n) => String(n) === filt.roundSel)
        ? filt.roundSel
        : roundOptions.length
          ? String(roundOptions[0])
          : 'all',
  );

  const shownGroups = $derived(roundValue === 'all' ? groups : groups.filter(([round]) => String(round) === roundValue));

  function update(patch) {
    setFilt({ ...filt, ...patch });
  }

  function playerCls(roundNumber, steamId, name) {
    return playerSideClassAt(players, sideSwitches, rounds, roundNumber, steamId, name);
  }

  function affectedCount(json) {
    if (!json) return 0;
    try {
      const a = JSON.parse(json);
      return Array.isArray(a) ? a.length : 0;
    } catch {
      return 0;
    }
  }

  function coordCell(r) {
    const x = r.throwX;
    const y = r.throwY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return DASH;
    if (x === 0 && y === 0) return DASH;
    return '(' + Math.round(x) + ', ' + Math.round(y) + ')';
  }

  function openReplay(r) {
    const t = effTick(r);
    spectra.navigate(hashOf('/replay/' + context.matchId, { tick: t, loop: entryLoopAround(t, tickRate, loopSecs), follow: r.thrower || undefined, back: origin() }));
  }

  function openProfile(steam) {
    if (/^\\d{17}$/.test(steam || '')) spectra.navigate('/player/' + steam);
  }
</script>

<section class="panel util-throwlog">
  <h2>Throw log</h2>
  <div class="util-filters toolbar">
    <label class="util-field" for="util-kind">
      <span class="field-label">Kind</span>
      <select class="input" id="util-kind" value={filt.kindF} onchange={(e) => update({ kindF: e.currentTarget.value })}>
        <option value="">All kinds</option>
        {#each kindOptions as k (k)}
          <option value={k}>{k}</option>
        {/each}
      </select>
    </label>
    <label class="util-field" for="util-thrower">
      <span class="field-label">Thrower</span>
      <select class="input" id="util-thrower" value={filt.throwerF} onchange={(e) => update({ throwerF: e.currentTarget.value })}>
        <option value="">All players</option>
        {#each players as p (p.steamId)}
          <option value={p.steamId}>{p.name}</option>
        {/each}
      </select>
    </label>
    <label class="util-field" for="util-round">
      <span class="field-label">Round</span>
      <select class="input" id="util-round" value={roundValue} onchange={(e) => update({ roundSel: e.currentTarget.value })}>
        <option value="all">All rounds</option>
        {#each roundOptions as n (n)}
          <option value={String(n)}>{roundScoreLabel(rounds, n)}</option>
        {/each}
      </select>
    </label>
    <span class="muted">{filtered.length} of {rows.length} grenade{rows.length === 1 ? '' : 's'}</span>
  </div>
  {#if groups.length === 0}
    <p class="muted" role="status">No grenades match the current filters.</p>
  {:else}
    <div class="util-lists">
      {#each shownGroups as [round, list] (round)}
        <ul class="util-nades">
          {#each list as r, i (r.tick + ':' + i)}
            {@const name = r.throwerName || r.thrower}
            <li class="util-nade">
              <span class="util-actions">
                <button class="btn small ghost" title={r.thrower ? 'Watch this throw — follow ' + name : 'Watch this throw in the replay'} aria-label={r.thrower ? 'Watch this throw — follow ' + name : 'Watch this throw in the replay'} onclick={() => openReplay(r)}><span class="codicon codicon-play"></span></button>
              </span>
              <span class="chip util-kind {r.kind}">{r.kind}</span>
              {#if /^\\d{17}$/.test(r.thrower)}
                <button class="comb-name-btn util-thrower {playerCls(r.round, r.thrower, r.throwerName)}" title={'Open ' + name + ' profile'} onclick={() => openProfile(r.thrower)}>{name || DASH}</button>
              {:else}
                <span class="util-thrower {playerCls(r.round, r.thrower, r.throwerName)}">{name || DASH}</span>
              {/if}
              <span class="mono muted util-tick" title={'tick ' + effTick(r) + ' — time into round ' + roundIndexLabel(rbn.get(r.round) ?? r.round)}>{roundClock(effTick(r), rbn.get(r.round), tickRate)}</span>
              <span class="util-num" title="damage dealt">{fmtZeroDash(r.damage, 'dmg')}</span>
              <span class="util-num muted" title="total blind time">{r.flashMsTotal > 0 ? fmtMs(r.flashMsTotal) : DASH}</span>
              <span class="util-num muted" title="affected players (blinded or damaged by this throw)">{fmtZeroDash(affectedCount(r.affected), 'aff')}</span>
              <span class="util-coord muted mono" title="throw world coordinates">{coordCell(r)}</span>
            </li>
          {/each}
        </ul>
      {/each}
    </div>
  {/if}
</section>
`;

// The two bar charts share one source. The measure is baked in: damage counts
// the throw's damage, blind counts its blind milliseconds. A team's bar takes the
// side colour it held that round; one team is striped.
function barsSource(measure) {
  const copy =
    measure === 'damage'
      ? {
          heading: 'Utility damage per round',
          aria: 'Team utility damage per round',
          stripeId: 'util-stripe',
          panelClass: 'util-card-damage',
          unit: ' damage',
          maxSuffix: ' dmg/round · totals of recorded damage',
          maxTitle: 'total damage in the current filter, by thrower team',
        }
      : {
          heading: 'Blind time per round',
          aria: 'Team blind time per round',
          stripeId: 'util-stripe-blind',
          panelClass: 'util-card-blind',
          unit: ' blind time',
          maxSuffix: ' blind/round · totals of recorded blind time',
          maxTitle: "total blind time from this team's flashes, by thrower team",
        };
  return `<script>
  // Utility per-round bars (${measure}): one bar per team per round, its colour
  // the side that team held that round, one team striped. The card hides when the
  // filtered throws have nothing to draw.
  let { spectra, context, rows = [], rounds = [], players = [], names = { ct: 'CT', t: 'T' }, sideSwitches = 0 } = $props();
  ${FMT_HELPERS}
  ${TICK_HELPERS}
  ${TEAM_HELPERS}

  const MEASURE = ${JSON.stringify(measure)};
  const COPY = ${JSON.stringify(copy)};
  const STRIPED_KEY = 't';
  const barW = 1000;
  const barH = 90;

  const rbn = $derived(roundsByNumber(rounds));
  const teamBySteam = $derived(new Map(players.map((p) => [p.steamId, p.side || ''])));
  const clsCT = $derived(teamStartClass('ct', sideSwitches));
  const clsT = $derived(teamStartClass('t', sideSwitches));

  function amount(r) {
    return MEASURE === 'damage' ? r.damage || 0 : r.flashMsTotal || 0;
  }

  function valueText(v) {
    return MEASURE === 'damage' ? v + COPY.unit : fmtMs(v) + COPY.unit;
  }

  function barSide(roundNumber, finalSide) {
    const side = sideAtRound(rounds, sideSwitches, roundNumber, finalSide);
    return side === 'ct' ? 'side-ct' : side === 't' ? 'side-t' : '';
  }

  const groups = $derived.by(() => {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.round)) m.set(r.round, []);
      m.get(r.round).push(r);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  });

  const bars = $derived.by(() => {
    const per = groups.map(([round, list]) => {
      let ct = 0;
      let t = 0;
      for (const r of list) {
        const team = teamBySteam.get(r.thrower) || '';
        if (team === 'ct') ct += amount(r);
        else if (team === 't') t += amount(r);
      }
      return { round, ct, t };
    });
    let max = 0;
    for (const p of per) max = Math.max(max, p.ct, p.t);
    return { per, max: max || 1, any: max > 0 };
  });

  const maxText = $derived(MEASURE === 'damage' ? String(bars.max) : fmtMs(bars.max));
</script>

{#if bars.any}
  <section class="panel {COPY.panelClass}">
    <h2>{COPY.heading}</h2>
    <svg class="util-bars" viewBox="0 0 {barW} {barH}" preserveAspectRatio="none" aria-label={COPY.aria}>
      <defs>
        <pattern id={COPY.stripeId} patternUnits="userSpaceOnUse" width="7" height="7" patternTransform="rotate(45)">
          <rect x="0" y="0" width="3" height="7" class="util-stripe-line" />
        </pattern>
      </defs>
      {#each bars.per as p, i (p.round)}
        {@const slot = barW / bars.per.length}
        {@const x = i * slot}
        {@const bw = Math.max(2, slot * 0.32)}
        {@const hCt = (p.ct / bars.max) * (barH - 4)}
        {@const hT = (p.t / bars.max) * (barH - 4)}
        {@const ctX = x + slot * 0.08}
        {@const tX = x + slot * 0.08 + bw + 2}
        <rect class="util-bar {barSide(p.round, 'ct')}" x={ctX} y={barH - hCt} width={bw} height={hCt}>
          <title>Round {roundIndexLabel(rbn.get(p.round) ?? p.round)} — {names.ct}{' '}{valueText(p.ct)}</title>
        </rect>
        {#if STRIPED_KEY === 'ct'}
          <rect class="util-bar-stripe" x={ctX} y={barH - hCt} width={bw} height={hCt} fill={'url(#' + COPY.stripeId + ')'} pointer-events="none" />
        {/if}
        <rect class="util-bar {barSide(p.round, 't')}" x={tX} y={barH - hT} width={bw} height={hT}>
          <title>Round {roundIndexLabel(rbn.get(p.round) ?? p.round)} — {names.t}{' '}{valueText(p.t)}</title>
        </rect>
        {#if STRIPED_KEY === 't'}
          <rect class="util-bar-stripe" x={tX} y={barH - hT} width={bw} height={hT} fill={'url(#' + COPY.stripeId + ')'} pointer-events="none" />
        {/if}
      {/each}
    </svg>
    <div class="util-legend">
      <span><span class="util-dot {clsCT}" class:striped={STRIPED_KEY === 'ct'}></span>{names.ct}{#if MEASURE === 'damage'} <span class="chip badge-computed">computed</span>{:else} <span class="chip badge-inferred" title="calculated from the demo's blind events">inferred</span>{/if}</span>
      <span><span class="util-dot {clsT}" class:striped={STRIPED_KEY === 't'}></span>{names.t}</span>
      <span class="muted" title={COPY.maxTitle}>max {maxText}{COPY.maxSuffix}</span>
    </div>
  </section>
{/if}
`;
}

// The registry of the Utility builtins, in mount order.
export const UTIL_PANELS = Object.freeze([
  Object.freeze({ id: UTIL_PANEL_IDS.utility, label: 'Utility', source: UTILITY_SOURCE }),
  Object.freeze({ id: UTIL_PANEL_IDS.log, label: 'Utility throw log', source: UTIL_LOG_SOURCE }),
  Object.freeze({ id: UTIL_PANEL_IDS.damage, label: 'Utility damage per round', source: barsSource('damage') }),
  Object.freeze({ id: UTIL_PANEL_IDS.blind, label: 'Utility blind time per round', source: barsSource('blind') }),
]);
