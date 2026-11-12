<script>
  import {
    getUtility,
    getRounds,
    getScoreboard,
    getMatch,
    getTeamNames,
    errText,
  } from '../services.js';
  import { fmtMs, roundClock, fmtZeroDash } from '../fmt.js';
  import { roundIndexLabel } from '../rounds.js';
  import { sideAtRound } from '../sideparity.js';
  import { replayHash, entryLoopAround } from '../nav.js';
  import { listedPlayers } from '../players.js';
  import { roundsByNumber } from '../replay/landmarks.js';
  import { playerSideClassAt, teamNames, teamStartClass } from '../teams.js';
  import { seed, remember, matchKey } from '../viewstate.svelte.js';
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

  // View-local filter/selection state (kind + thrower filters, collapsed
  // rounds) restores per match through the process-scoped registry
  // (viewstate.svelte.js): the key carries the match id (matchKey), so
  // match A's filters never seed into match B. App's {#if} chain reuses
  // Match's children across an id change (no remount), so ONE combined
  // effect both RE-SEEDS when the key changes and writes through
  // otherwise — self-ordering: the write branch runs only while the key
  // is unchanged, so the old match's values can never land under the
  // new key. Loading/error stay transient.
  const utilDefaults = () => ({ kindF: '', throwerF: '', closed: {} });
  const utilKey = $derived(matchKey('utility', id));
  // Deliberate ONE-TIME init capture: the derived is read inside a closure
  // (Svelte's documented state_referenced_locally fix); the snapshot carries
  // the key so lastKey matches without a second top-level derived read.
  // The combined reseed/write-through $effect below owns every later key
  // change — URL stays the sole durable record; registry semantics unchanged.
  const utilInit = () => ({ ...seed(utilKey, utilDefaults()), key: utilKey });
  const utilSeed = utilInit();
  let kindF = $state(utilSeed.kindF);
  let throwerF = $state(utilSeed.throwerF);
  let closed = $state(utilSeed.closed); // round -> true = collapsed
  let utilLastKey = utilSeed.key;
  $effect(() => {
    const k = utilKey;
    if (k !== utilLastKey) {
      // Another match without a remount: apply its record (defaults
      // when it has none) and do not write — the entry keeps exactly
      // what was applied, so the old match's values can never land
      // under the new key (the write-through re-arms on the next user
      // change, which reads the re-seeded values).
      utilLastKey = k;
      const s = seed(k, utilDefaults());
      kindF = s.kindF;
      throwerF = s.throwerF;
      closed = s.closed;
      return;
    }
    remember(k, { kindF, throwerF, closed });
  });
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
        players = listedPlayers(sb) || [];
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

  // Identity colors of the two teams (final-side keyed) — now only the
  // LEGEND dots and the flash-card labels (identity context, the
  // EconCurve legend precedent); the damage bars take their COLOR from
  // the side at that round (barSide below).
  const clsCT = $derived(teamStartClass('ct', sideSwitches));
  const clsT = $derived(teamStartClass('t', sideSwitches));

  // --- Damage bars: COLOR = side at that round, PATTERN = team identity ---
  // COLOR: a bar is one TEAM's damage (final-side keyed) but its hue is
  // the side that team held IN THAT round — resolved through the
  // canonical parity helper (lib/sideparity.js sideAtRound), so the hue
  // swaps at every side switch with the teams. An unresolvable round →
  // '' → the neutral .util-bar fill, never a guessed color.
  function barSide(roundNumber, finalSide) {
    const side = sideAtRound(rounds, sideSwitches, roundNumber, finalSide);
    return side === 'ct' ? 'side-ct' : side === 't' ? 'side-t' : '';
  }

  // PATTERN: exactly one of the two teams draws STRIPED bars (the
  // audit's first striped implementation), the other solid — a fixed
  // display convention: the team that FINISHED T (final-side key 't').
  // The final side never changes mid-match, so the assignment is stable
  // for the whole chart; it only says "these are two different teams"
  // (the hue already says which side each held when).
  const STRIPED_KEY = 't';

  // Coordinate cell — the owner's carve-out from the zero-dash rule: a
  // world position is identity/positional, so it dashes ONLY when BOTH
  // components are 0 (and when the detonation recorded no position at
  // all — DetX/DetY are omitempty, so a missing one would otherwise
  // render "(NaN, NaN)"). Any real coordinate renders as-is, including
  // a single zero: (5, 0).
  function coordCell(r) {
    const x = r.detX;
    const y = r.detY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return '—'; // no position recorded
    if (x === 0 && y === 0) return '—';
    return `(${Math.round(x)}, ${Math.round(y)})`;
  }

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

  // The throw's row ▶ — ICON-ONLY play (the one canonical tick-link
  // glyph; no label text). It stamps the throw's own tick with a ±10 s
  // entry loop around it (nav.entryLoopAround — the engine's default
  // loop width) AND the THROWER as the camera follow: entry context,
  // never a filter — an absent thrower stamps no follow (buildHash
  // drops it). The ONE way this view enters the replay: buttons SEEK,
  // never set a landmark filter (the retired round "events" filter
  // button stays gone).
  function openReplay(r) {
    // `|| undefined` — an absent thrower stamps NOTHING (buildHash keeps
    // an empty string as `follow=`, which is not "no stamp").
    go(replayHash(id, {}, { tick: r.tick, loop: entryLoopAround(r.tick, tickRate), follow: r.thrower || undefined, back }));
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
      <span class="muted util-hint">▶ seeks to the throw (±10 s loop) · camera follows the thrower</span>
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
            <defs>
              <!-- The identity STRIPE (the design language's first
                   striped implementation): a neutral diagonal overlay
                   painted ONLY over the STRIPED team's bars (STRIPED_KEY
                   in the script) — hue stays the side color on the bar
                   beneath (color = side at that round), the stripe
                   marks the team (pattern = identity). userSpaceOnUse
                   keeps the tile in bar units; preserveAspectRatio="none"
                   stretches the viewBox non-uniformly, so the 45° angle
                   skews a few degrees with the panel's aspect ratio —
                   accepted and documented, still unambiguously stripes.
                   The overlay color is the view's --util-stripe token
                   (style-m3a.css) so the SVG pattern and the legend
                   dot's CSS twin can never drift apart. -->
              <pattern
                id="util-stripe"
                patternUnits="userSpaceOnUse"
                width="7"
                height="7"
                patternTransform="rotate(45)"
              >
                <rect x="0" y="0" width="3" height="7" class="util-stripe-line" />
              </pattern>
            </defs>
            {#each damageBars.per as p, i (p.round)}
              {@const slot = barW / damageBars.per.length}
              {@const x = i * slot}
              {@const bw = Math.max(2, slot * 0.32)}
              {@const hCt = (p.ct / damageBars.max) * (barH - 4)}
              {@const hT = (p.t / damageBars.max) * (barH - 4)}
              {@const ctX = x + slot * 0.08}
              {@const tX = x + slot * 0.08 + bw + 2}
              <!-- COLOR = the side each team held IN THIS ROUND -->
              <rect
                class="util-bar {barSide(p.round, 'ct')}"
                x={ctX}
                y={barH - hCt}
                width={bw}
                height={hCt}
              >
                <title>Round {roundIndexLabel(rbn.get(p.round) ?? p.round)} — {names.ct} {p.ct} damage</title>
              </rect>
              {#if STRIPED_KEY === 'ct'}
                <rect
                  class="util-bar-stripe"
                  x={ctX}
                  y={barH - hCt}
                  width={bw}
                  height={hCt}
                  fill="url(#util-stripe)"
                  pointer-events="none"
                />
              {/if}
              <rect
                class="util-bar {barSide(p.round, 't')}"
                x={tX}
                y={barH - hT}
                width={bw}
                height={hT}
              >
                <title>Round {roundIndexLabel(rbn.get(p.round) ?? p.round)} — {names.t} {p.t} damage</title>
              </rect>
              {#if STRIPED_KEY === 't'}
                <rect
                  class="util-bar-stripe"
                  x={tX}
                  y={barH - hT}
                  width={bw}
                  height={hT}
                  fill="url(#util-stripe)"
                  pointer-events="none"
                />
              {/if}
            {/each}
          </svg>
          <div class="util-legend">
            <!-- The dots are the legend's identity context (named teams,
                 EconCurve's swatch precedent): they keep the team-
                 identity colors and carry the STRIPE as the CSS twin of
                 the bar pattern (style-m3a.css) for whichever team the
                 bars stripe — labels stay plain text (never patterned
                 text). -->
            <span
              ><span class="util-dot {clsCT}" class:striped={STRIPED_KEY === 'ct'}></span
              >{names.ct}
              <span class="chip badge-computed">computed</span></span
            >
            <span
              ><span class="util-dot {clsT}" class:striped={STRIPED_KEY === 't'}></span
              >{names.t}</span
            >
            <span class="muted"
              title="total damage in the current filter, by thrower team"
              >max {damageBars.max} dmg/round · totals of recorded damage</span
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
            title="calculated from the demo's blind events"
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
              <span class="muted mono">{names.ct} {fmtZeroDash(ctDmg)} · {names.t} {fmtZeroDash(tDmg)} dmg</span>
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
                      >{fmtZeroDash(r.damage, 'dmg')}</span
                    >
                    <span class="util-num muted" title="total blind time"
                      >{r.flashMsTotal > 0
                        ? fmtMs(r.flashMsTotal)
                        : '—'}</span
                    >
                    <span
                      class="util-num muted"
                      title="affected players (blinded or damaged by this throw)"
                      >{fmtZeroDash(affectedCount(r.affected), 'aff')}</span
                    >
                    <span class="util-actions">
                      <button
                        class="btn small ghost"
                        title={r.thrower
                          ? `Watch this throw — follow ${r.throwerName || r.thrower}`
                          : 'Watch this throw in the replay'}
                        aria-label={r.thrower
                          ? `Watch this throw at tick ${r.tick} — follow ${r.throwerName || r.thrower}`
                          : `Watch this throw at tick ${r.tick}`}
                        onclick={() => openReplay(r)}
                        ><span class="codicon codicon-play" aria-hidden="true"></span></button
                      >
                    </span>
                    <span
                      class="util-coord muted mono"
                      title="detonation world coordinates"
                      >{coordCell(r)}</span
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
