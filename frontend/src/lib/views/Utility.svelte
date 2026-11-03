<script>
  import {
    getUtility,
    getScoreboard,
    getMatch,
    setPendingTimelineFilter,
    setPendingSeek,
  } from '../services.js';
  import { fmtClock, tickSeconds } from '../fmt.js';

  // Match renders <Utility {id} /> — nav is optional, fall back to the hash
  // router directly so the drill-downs still work.
  let { id = 0, nav = null } = $props();

  const go = (hash) => (nav ? nav(hash) : (location.hash = hash));

  let rows = $state([]);
  let players = $state([]);
  let loading = $state(true);
  let error = $state('');
  let kindF = $state('');
  let throwerF = $state('');
  let closed = $state({}); // round -> true = collapsed
  // Match tickrate for the tick → clock conversion (unknown until the
  // match metadata lands; 64 is CS2's standard fallback).
  let tickRate = $state(64);

  $effect(() => {
    let live = true;
    Promise.all([
      getUtility(id),
      getScoreboard(id, 'kills', true).catch(() => []),
      getMatch(id).catch(() => null),
    ])
      .then(([u, sb, m]) => {
        if (!live) return;
        rows = u || [];
        players = sb || [];
        if (m && m.tickRate > 0) tickRate = m.tickRate;
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

  function errText(e) {
    if (e == null) return 'unknown error';
    if (typeof e === 'string') return e;
    return e.message || String(e);
  }

  const sideBySteam = $derived.by(() => {
    const m = new Map();
    for (const p of players) m.set(p.steamId, p.side || '');
    return m;
  });

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

  const damageBars = $derived.by(() => {
    const per = groups.map(([round, list]) => {
      let ct = 0;
      let t = 0;
      for (const r of list) {
        const s = sideBySteam.get(r.thrower) || '';
        if (s === 'ct') ct += r.damage || 0;
        else if (s === 't') t += r.damage || 0;
      }
      return { round, ct, t };
    });
    let max = 0;
    for (const p of per) max = Math.max(max, p.ct, p.t);
    return { per, max: max || 1 };
  });

  // Flash effectiveness per throwing team: total blind milliseconds + count
  // of affected players. Blinds are recorded events, but "effectiveness"
  // aggregates them → heuristic label per PRD §6.1.
  const flash = $derived.by(() => {
    let ctMs = 0;
    let tMs = 0;
    let ctAff = 0;
    let tAff = 0;
    for (const r of filtered) {
      if (r.kind !== 'flash') continue;
      const s = sideBySteam.get(r.thrower) || '';
      const aff = affectedCount(r.affected);
      if (s === 'ct') {
        ctMs += r.flashMsTotal || 0;
        ctAff += aff;
      } else if (s === 't') {
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

  function flashSec(ms) {
    return (ms / 1000).toFixed(1) + 's';
  }

  function toggleRound(round) {
    closed = { ...closed, [round]: !closed[round] };
  }

  function openTimeline(r) {
    setPendingTimelineFilter({ round: r.round, kind: 'grenade' });
    go(`/match/${id}/timeline`);
  }

  function openReplay(r) {
    setPendingSeek({ tick: r.tick });
    go(`/replay/${id}`);
  }

  const barW = 1000;
  const barH = 90;
</script>

<div class="util-view">
  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if loading}
    <p class="muted">Loading utility events…</p>
  {:else}
    <div class="util-filters toolbar">
      <label class="util-field" for="util-kind">
        <span class="util-field-label">Kind</span>
        <select class="input" id="util-kind" bind:value={kindF}>
          <option value="">All kinds</option>
          {#each kindOptions as k (k)}
            <option value={k}>{k}</option>
          {/each}
        </select>
      </label>
      <label class="util-field" for="util-thrower">
        <span class="util-field-label">Thrower</span>
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
        >timeline filters to the round's grenade events · replay seeks to the
        throw</span
      >
    </div>

    <div class="util-summary">
      <section class="panel">
        <h2>Utility damage per round</h2>
        {#if damageBars.per.length === 0}
          <p class="muted">No utility damage in this selection.</p>
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
                class="util-bar-ct"
                x={x + slot * 0.08}
                y={barH - (p.ct / damageBars.max) * (barH - 4)}
                width={bw}
                height={(p.ct / damageBars.max) * (barH - 4)}
              >
                <title>Round {p.round} — CT {p.ct} damage</title>
              </rect>
              <rect
                class="util-bar-t"
                x={x + slot * 0.08 + bw + 2}
                y={barH - (p.t / damageBars.max) * (barH - 4)}
                width={bw}
                height={(p.t / damageBars.max) * (barH - 4)}
              >
                <title>Round {p.round} — T {p.t} damage</title>
              </rect>
            {/each}
          </svg>
          <div class="util-legend">
            <span
              ><span class="util-dot ct"></span>CT
              <span class="chip util-badge-computed">computed</span></span
            >
            <span><span class="util-dot t"></span>T</span>
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
            <span class="stat-label ct">CT blinds</span>
            <span class="util-flash-value">{flashSec(flash.ctMs)}</span>
            <span class="muted">{flash.ctAff} affected</span>
          </div>
          <div class="util-flash-cell">
            <span class="stat-label t">T blinds</span>
            <span class="util-flash-value">{flashSec(flash.tMs)}</span>
            <span class="muted">{flash.tAff} affected</span>
          </div>
        </div>
        <p class="util-flash-note">
          <span
            class="chip util-badge-inferred"
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
      <p class="muted">No grenades match the current filters.</p>
    {:else}
      <div class="util-groups">
        {#each groups as [round, list] (round)}
          {@const ctDmg = list.reduce(
            (a, r) => a + (sideBySteam.get(r.thrower) === 'ct' ? r.damage || 0 : 0),
            0,
          )}
          {@const tDmg = list.reduce(
            (a, r) => a + (sideBySteam.get(r.thrower) === 't' ? r.damage || 0 : 0),
            0,
          )}
          <section class="util-group">
            <button
              class="util-group-head"
              aria-expanded={!closed[round]}
              onclick={() => toggleRound(round)}
            >
              <span class="util-group-title">Round {round}</span>
              <span class="chip round-chip">{list.length}</span>
              <span class="muted mono">CT {ctDmg} · T {tDmg} dmg</span>
              <span class="spacer"></span>
              <span class="muted"><span class="codicon {closed[round] ? 'codicon-chevron-right' : 'codicon-chevron-down'}"></span></span>
            </button>
            {#if !closed[round]}
              <ul class="util-nades">
                {#each list as r, i (r.tick + ':' + i)}
                  <li class="util-nade">
                    <span class="chip util-kind {r.kind}">{r.kind}</span>
                    <span class="util-thrower"
                      >{r.throwerName || r.thrower || '—'}</span
                    >
                    <span
                      class="mono muted util-tick"
                      title="tick {r.tick}"
                      >{fmtClock(tickSeconds(r.tick, tickRate))}</span
                    >
                    <span class="util-num" title="damage dealt"
                      >{r.damage || 0} dmg</span
                    >
                    <span class="util-num muted" title="total blind time"
                      >{r.flashMsTotal > 0
                        ? flashSec(r.flashMsTotal)
                        : '—'}</span
                    >
                    <span
                      class="util-num muted"
                      title="affected players (parsed from the event payload)"
                      >{affectedCount(r.affected)} aff</span
                    >
                    <span class="util-site muted" title="detonation site"
                      >{r.site || '—'}</span
                    >
                    <span class="util-actions">
                      <button
                        class="btn small ghost"
                        title="Open timeline filtered to round {r.round}'s grenade events"
                        onclick={() => openTimeline(r)}>timeline</button
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
