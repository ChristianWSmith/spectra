<script>
  import {
    getUtility,
    getRounds,
    getScoreboard,
    getMatch,
    getTeamNames,
    errText,
  } from '../services.js';
  import { fmtMs, roundClock } from '../fmt.js';
  import { roundIndexLabel } from '../rounds.js';
  import { replayHash, entryLoopAround } from '../nav.js';
  import { roundsByNumber } from '../replay/landmarks.js';
  import { playerSideClassAt, teamNames, teamStartClass } from '../teams.js';
  import ProfileLink from '../components/ProfileLink.svelte';

  // Match renders <Utility {id} /> — nav is optional, fall back to the hash
  // router directly so the drill-downs still work. `go` is what the
  // ProfileLinks below navigate through for the same reason.
  let { id = 0, nav = null } = $props();

  const go = (hash) => (nav ? nav(hash) : (location.hash = hash));
  const back = $derived(`match/${id}/utility`);

  let rows = $state([]);
  let players = $state([]);
  let rounds = $state([]); // round rows: the counted index behind per-round colors
  let names = $state({ ct: 'CT', t: 'T' }); // team names, final-side keyed
  let loading = $state(true);
  let error = $state('');
  let kindF = $state('');
  let throwerF = $state('');
  let closed = $state({}); // round -> true = collapsed
  // Match tickrate for the tick → clock conversion (unknown until the
  // match metadata lands; 64 is CS2's standard fallback). sideSwitches is
  // the other half of the per-round name colors.
  let tickRate = $state(64);
  let sideSwitches = $state(0);

  // Per-round SIDE color class for a thrower row — every name in the
  // per-round groups belongs to that round, so the color follows the side
  // the thrower had in it (lib/teams.js playerSideClassAt); '' when the
  // player or round can't be resolved (never a guessed color).
  function playerCls(roundNumber, steamId, name) {
    return playerSideClassAt(players, sideSwitches, rounds, roundNumber, steamId, name);
  }

  $effect(() => {
    let live = true;
    Promise.all([
      getUtility(id),
      getRounds(id),
      getScoreboard(id, 'kills', true).catch(() => []),
      getMatch(id).catch(() => null),
      getTeamNames(id).catch(() => null),
    ])
      .then(([u, rd, sb, m, tn]) => {
        if (!live) return;
        rows = u || [];
        rounds = rd || [];
        players = sb || [];
        if (m && m.tickRate > 0) tickRate = m.tickRate;
        if (m) sideSwitches = m.sideSwitches || 0;
        // Team display names, keyed by each team's FINAL side — demo clan
        // name → synthesized team_<player> → bare side (lib/teams.js).
        names = teamNames({
          ctName: tn?.ct || '',
          tName: tn?.t || '',
          players: sb || [],
        });
        loading = false;
        error = '';
      })
      .catch((e) => {
        if (live) {
          error = errText(e);
          loading = false;
        }
      });
    return () => (live = false);
  });

  // A player's TEAM never changes — only its side does at halftime — so a
  // thrower's final side (the scoreboard's `side`, keyed the way
  // lib/teams.js names and colors teams) identifies the team behind every
  // rollup here: tabulated per TEAM, never per side. An unresolvable
  // thrower maps to '' and contributes to neither team (no guessed team).
  const teamBySteam = $derived.by(() => {
    const m = new Map();
    for (const p of players) m.set(p.steamId, p.side || '');
    return m;
  });

  // Identity colors of the two teams (final-side keyed), for the bars,
  // the legend dots and the flash cells.
  const clsCT = $derived(teamStartClass('ct', sideSwitches));
  const clsT = $derived(teamStartClass('t', sideSwitches));

  const kindOptions = $derived(
    [...new Set(rows.map((r) => r.kind).filter(Boolean))].sort(),
  );

  const filtered = $derived(
    rows.filter(
      (r) =>
        (kindF === '' || r.kind === kindF) &&
        (throwerF === '' || r.thrower === throwerF),
    ),
  );

  const groups = $derived.by(() => {
    const m = new Map();
    for (const r of filtered) {
      if (!m.has(r.round)) m.set(r.round, []);
      m.get(r.round).push(r);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  });

  // Round lookup behind the row clock: each row's time is how far INTO
  // that round the throw happened (roundClock + the canonical
  // number→row map builder, lib/replay/landmarks.js roundsByNumber) —
  // never time into the overall game.
  const rbn = $derived(roundsByNumber(rounds));

  // Per-round utility damage by THROWER TEAM (team_XYZ's damage in round
  // N) — pure sums over the filtered rows, keyed by the teams' final
  // sides, so the two bars stay the same two teams after halftime.
  const damageBars = $derived.by(() => {
    const per = groups.map(([round, list]) => {
      let ct = 0;
      let t = 0;
      for (const r of list) {
        const team = teamBySteam.get(r.thrower) || '';
        if (team === 'ct') ct += r.damage || 0;
        else if (team === 't') t += r.damage || 0;
      }
      return { round, ct, t };
    });
    let max = 0;
    for (const p of per) max = Math.max(max, p.ct, p.t);
    return { per, max: max || 1 };
  });

  // Flash effectiveness per throwing TEAM: total blind milliseconds + count
  // of affected players. Blinds are recorded events, but "effectiveness"
  // aggregates them → heuristic label per PRD §6.1.
  const flash = $derived.by(() => {
    let ctMs = 0;
    let tMs = 0;
    let ctAff = 0;
    let tAff = 0;
    for (const r of filtered) {
      if (r.kind !== 'flash') continue;
      const team = teamBySteam.get(r.thrower) || '';
      const aff = affectedCount(r.affected);
      if (team === 'ct') {
        ctMs += r.flashMsTotal || 0;
        ctAff += aff;
      } else if (team === 't') {
        tMs += r.flashMsTotal || 0;
        tAff += aff;
      }
    }
    return { ctMs, tMs, ctAff, tAff };
  });

  function affectedCount(json) {
    if (!json) return 0;
    try {
      const a = JSON.parse(json);
      return Array.isArray(a) ? a.length : 0;
    } catch {
      return 0;
    }
  }

  function toggleRound(round) {
    closed = { ...closed, [round]: !closed[round] };
  }

  // Round drill → THE event browser with the grenade categories enabled
  // (the round range pins BOTH bounds to the same number: inclusive,
  // exactly that round).
  function openEvents(r) {
    go(
      replayHash(
        id,
        { roundFrom: r.round, roundTo: r.round, cats: ['grenade_throws', 'grenade_dets'] },
        { back },
      ),
    );
  }

  // "replay ▶" → the throw's own tick, with a ±10 s entry loop around it
  // (nav.entryLoopAround — the engine's default loop width).
  function openReplay(r) {
    go(replayHash(id, {}, { tick: r.tick, loop: entryLoopAround(r.tick, tickRate), back }));
  }

  const barW = 1000;
  const barH = 90;
</script>

<div class="view util-view">
  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if loading}
    <p class="muted" role="status">Loading utility events…</p>
  {:else}
    <div class="util-filters toolbar">
      <label class="util-field" for="util-kind">
        <span class="field-label">Kind</span>
        <select class="input" id="util-kind" bind:value={kindF}>
          <option value="">All kinds</option>
          {#each kindOptions as k (k)}
            <option value={k}>{k}</option>
          {/each}
        </select>
      </label>
      <label class="util-field" for="util-thrower">
        <span class="field-label">Thrower</span>
        <select class="input" id="util-thrower" bind:value={throwerF}>
          <option value="">All players</option>
          {#each players as p (p.steamId)}
            <option value={p.steamId}>{p.name}</option>
          {/each}
        </select>
      </label>
      <span class="muted"
        >{filtered.length} of {rows.length} grenade{rows.length === 1
          ? ''
          : 's'}</span
      >
      <span class="spacer"></span>
      <span class="muted util-hint"
        >events opens the replay at the round's start with its feed scoped
        to the round · replay seeks to the throw</span
      >
    </div>

    <div class="util-summary">
      <section class="panel">
        <h2>Utility damage per round</h2>
        {#if damageBars.per.length === 0}
          <p class="muted" role="status">No utility damage in this selection.</p>
        {:else}
          <svg
            class="util-bars"
            viewBox="0 0 {barW} {barH}"
            preserveAspectRatio="none"
            aria-label="Team utility damage per round"
          >
            {#each damageBars.per as p, i (p.round)}
              {@const slot = barW / damageBars.per.length}
              {@const x = i * slot}
              {@const bw = Math.max(2, slot * 0.32)}
              <rect
                class="util-bar {clsCT}"
                x={x + slot * 0.08}
                y={barH - (p.ct / damageBars.max) * (barH - 4)}
                width={bw}
                height={(p.ct / damageBars.max) * (barH - 4)}
              >
                <title>Round {roundIndexLabel(rbn.get(p.round) ?? p.round)} — {names.ct} {p.ct} damage</title>
              </rect>
              <rect
                class="util-bar {clsT}"
                x={x + slot * 0.08 + bw + 2}
                y={barH - (p.t / damageBars.max) * (barH - 4)}
                width={bw}
                height={(p.t / damageBars.max) * (barH - 4)}
              >
                <title>Round {roundIndexLabel(rbn.get(p.round) ?? p.round)} — {names.t} {p.t} damage</title>
              </rect>
            {/each}
          </svg>
          <div class="util-legend">
            <span
              ><span class="util-dot {clsCT}"></span>{names.ct}
              <span class="chip badge-computed">computed</span></span
            >
            <span><span class="util-dot {clsT}"></span>{names.t}</span>
            <span class="muted"
              title="sum of damage rows in the current filter, grouped by thrower team"
              >max {damageBars.max} dmg/round · sums of recorded damage</span
            >
          </div>
        {/if}
      </section>

      <section class="panel">
        <h2>Flash effectiveness</h2>
        <div class="util-flash-grid">
          <div class="util-flash-cell">
            <span class="field-label {clsCT}">{names.ct} blinds</span>
            <span class="util-flash-value">{fmtMs(flash.ctMs)}</span>
            <span class="muted">{flash.ctAff} affected</span>
          </div>
          <div class="util-flash-cell">
            <span class="field-label {clsT}">{names.t} blinds</span>
            <span class="util-flash-value">{fmtMs(flash.tMs)}</span>
            <span class="muted">{flash.tAff} affected</span>
          </div>
        </div>
        <p class="util-flash-note">
          <span
            class="chip badge-inferred"
            title="derived from blind events — inferred"
            >inferred</span
          >
          <span class="muted"
            >total blind time + affected players, by thrower team</span
          >
        </p>
      </section>
    </div>

    {#if groups.length === 0}
      <p class="muted" role="status">No grenades match the current filters.</p>
    {:else}
      <div class="util-groups">
        {#each groups as [round, list] (round)}
          {@const ctDmg = list.reduce(
            (a, r) => a + (teamBySteam.get(r.thrower) === 'ct' ? r.damage || 0 : 0),
            0,
          )}
          {@const tDmg = list.reduce(
            (a, r) => a + (teamBySteam.get(r.thrower) === 't' ? r.damage || 0 : 0),
            0,
          )}
          <section class="util-group">
            <button
              class="util-group-head"
              aria-expanded={!closed[round]}
              onclick={() => toggleRound(round)}
            >
              <span class="util-group-title">Round {roundIndexLabel(rbn.get(round) ?? round)}</span>
              <span class="chip round-chip">{list.length}</span>
              <span class="muted mono">{names.ct} {ctDmg} · {names.t} {tDmg} dmg</span>
              <span class="spacer"></span>
              <span class="muted"><span class="codicon {closed[round] ? 'codicon-chevron-right' : 'codicon-chevron-down'}"></span></span>
            </button>
            {#if !closed[round]}
              <ul class="util-nades">
                {#each list as r, i (r.tick + ':' + i)}
                  <li class="util-nade">
                    <span class="chip util-kind {r.kind}">{r.kind}</span>
                    <ProfileLink
                      steam={r.thrower}
                      name={r.throwerName || r.thrower}
                      nav={go}
                      cls="util-thrower {playerCls(r.round, r.thrower, r.throwerName)}"
                      title="Open {r.throwerName || r.thrower} profile"
                    />
                    <span
                      class="mono muted util-tick"
                      title="tick {r.tick} — time into round {roundIndexLabel(rbn.get(r.round) ?? r.round)}"
                      >{roundClock(r.tick, rbn.get(r.round), tickRate)}</span
                    >
                    <span class="util-num" title="damage dealt"
                      >{r.damage || 0} dmg</span
                    >
                    <span class="util-num muted" title="total blind time"
                      >{r.flashMsTotal > 0
                        ? fmtMs(r.flashMsTotal)
                        : '—'}</span
                    >
                    <span
                      class="util-num muted"
                      title="affected players (blinded or damaged by this throw)"
                      >{affectedCount(r.affected)} aff</span
                    >
                    <span class="util-site muted" title="detonation site"
                      >{r.site || '—'}</span
                    >
                    <span class="util-actions">
                      <button
                        class="btn small ghost"
                        title="Open this round's grenade events in the replay landmark feed"
                        onclick={() => openEvents(r)}>events</button
                      >
                      <button
                        class="btn small ghost"
                        title="Watch this throw in the replay (seek to tick {r.tick})"
                        onclick={() => openReplay(r)}>replay <span class="codicon codicon-play"></span></button
                      >
                    </span>
                    <span
                      class="util-coord muted mono"
                      title="detonation world coordinates"
                      >({Math.round(r.detX)}, {Math.round(r.detY)})</span
                    >
                  </li>
                {/each}
              </ul>
            {/if}
          </section>
        {/each}
      </div>
    {/if}
  {/if}
</div>
