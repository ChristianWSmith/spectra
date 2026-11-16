<script>
  import * as S from '../strings/index.js';
  import {
    getUtility,
    getRounds,
    getScoreboard,
    getMatch,
    getTeamNames,
    getPref,
    errText,
  } from '../services.js';
  import { onMount } from 'svelte';
  import { fmtMs, roundClock, fmtZeroDash } from '../fmt.js';
  import { roundIndexLabel } from '../rounds.js';
  import { sideAtRound } from '../sideparity.js';
  import {
    replayHash,
    entryLoopAround,
    LOOP_SECS_DEFAULT,
    prefLoopSecs,
  } from '../nav.js';
  import { listedPlayers } from '../players.js';
  import { roundsByNumber } from '../replay/landmarks.js';
  import { playerSideClassAt, teamNames, teamStartClass } from '../teams.js';
  import { seed, remember, matchKey } from '../viewstate.svelte.js';
  import ProfileLink from '../components/ProfileLink.svelte';
  import StatusChip from '../components/StatusChip.svelte';

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

  // Event-level loop length: the `loop_secs` pref (Settings → Replay),
  // read ONCE at mount — nav.prefLoopSecs coerces it (unset/corrupt →
  // LOOP_SECS_DEFAULT), so the throw ▶ stamps the same width the
  // replay's quick-range button arms.
  let loopSecs = LOOP_SECS_DEFAULT;
  onMount(() => {
    getPref('loop_secs')
      .then((v) => (loopSecs = prefLoopSecs(v)))
      .catch(() => {
        /* keep the default */
      });
  });

  // View-local state (kind + thrower filters, the per-round show/hide
  // map) restores per match through the process-scoped registry
  // (viewstate.svelte.js): the key carries the match id (matchKey), so
  // match A's filters never seed into match B. App's {#if} chain reuses
  // Match's children across an id change (no remount), so ONE combined
  // effect both RE-SEEDS when the key changes and writes through
  // otherwise — self-ordering: the write branch runs only while the key
  // is unchanged, so the old match's values can never land under the
  // new key. Loading/error stay transient.
  //
  // The round map is INVERTED from the retired `closed` key (round →
  // shown, default all OFF — the owner's C7 ruling): same registry key
  // slot, but the default flips and the field name says what it means.
  // The registry is process-scoped and never serialized, so no stale
  // `closed` record can survive into this shape — seed() reads only the
  // defaults' own keys, and an unknown field never reaches `shown`.
  const utilDefaults = () => ({ kindF: '', throwerF: '', shown: {} });
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
  let shown = $state(utilSeed.shown); // round -> true = its throws are listed
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
      shown = s.shown;
      return;
    }
    remember(k, { kindF, throwerF, shown });
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

  // Identity colors of the two teams (final-side keyed) — only the
  // LEGEND dots of both charts carry them (identity context, the
  // EconCurve legend precedent); the bars themselves take their COLOR
  // from the side at that round (barSide below).
  const clsCT = $derived(teamStartClass('ct', sideSwitches));
  const clsT = $derived(teamStartClass('t', sideSwitches));

  // --- Bars (damage + blind time): COLOR = side at that round, PATTERN = team identity ---
  // COLOR: a bar is one TEAM's total (final-side keyed) but its hue is
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

  // Any round turned on? The consolidated card has TWO empty states and
  // they say different things: no grenades in the filter at all vs
  // grenades present but every round still OFF (the C7 default).
  const anyShown = $derived(groups.some(([round]) => shown[round]));

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

  // Blind time per round by THROWER TEAM — the damage series' twin over
  // the stored per-throw blind milliseconds (r.flashMsTotal), so the two
  // charts share one geometry, one color rule and one stripe pattern
  // convention. HONESTY: the total is NOT enemy-gated — it is every
  // blind the throw applied (the enemy-only gate applies to the affected
  // COUNTS in the throw rows) — hence the chart's label below, worded
  // after the shipped blind-time metric.
  const flashBars = $derived.by(() => {
    const per = groups.map(([round, list]) => {
      let ct = 0;
      let t = 0;
      for (const r of list) {
        const team = teamBySteam.get(r.thrower) || '';
        if (team === 'ct') ct += r.flashMsTotal || 0;
        else if (team === 't') t += r.flashMsTotal || 0;
      }
      return { round, ct, t };
    });
    let max = 0;
    for (const p of per) max = Math.max(max, p.ct, p.t);
    // `any` separates the two empty states: no rounds at all in the
    // current filter, and rounds present but no blind time among them
    // (a Kind filter with no flashes) — both read the one honest
    // "no blind time" line instead of a chart of zero-height bars.
    return { per, max: max || 1, any: max > 0 };
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

  // The throw-log toggles: a round's throws list ONLY while the user has
  // turned that round on — every round starts OFF (the owner's C7
  // default), so the card opens as a single line of round buttons.
  function toggleRound(round) {
    shown = { ...shown, [round]: !shown[round] };
  }

  // The throw's row ▶ — ICON-ONLY play (the one canonical tick-link
  // glyph; no label text). It stamps the throw's own tick with a
  // loop-length entry loop around it (nav.entryLoopAround — the
  // `loop_secs` pref, loopSecs above) AND the THROWER as the camera
  // follow: entry context, never a filter — an absent thrower stamps no
  // follow (buildHash drops it). The ONE way this view enters the
  // replay: buttons SEEK, never set a landmark filter (the retired
  // round "events" filter button stays gone).
  function openReplay(r) {
    // `|| undefined` — an absent thrower stamps NOTHING (buildHash keeps
    // an empty string as `follow=`, which is not "no stamp").
    go(replayHash(id, {}, { tick: r.tick, loop: entryLoopAround(r.tick, tickRate, loopSecs), follow: r.thrower || undefined, back }));
  }

  const barW = 1000;
  const barH = 90;
</script>

<div class="view util-view">
  {#if error}
    <p class="error" role="alert">
      {error}
      <button class="btn small" aria-label={S.utility.dismissError} onclick={() => (error = '')}>
        <span class="codicon codicon-close"></span>
      </button>
    </p>
  {/if}

  {#if loading}
    <p class="muted" role="status"><StatusChip block detail={S.utility.loadingDetail} /></p>
  {:else}
    <!-- Summary charts first, the consolidated throw log LAST (the
         owner's C7 ruling: the card carrying the filters, the count and
         the round toggles is the bottom card). -->
    <div class="util-summary">
      <section class="panel util-card-damage">
        <h2>{S.utility.damagePerRoundHeading}</h2>
        {#if damageBars.per.length === 0}
          <p class="muted" role="status">{S.utility.noDamage}</p>
        {:else}
          <svg
            class="util-bars"
            viewBox="0 0 {barW} {barH}"
            preserveAspectRatio="none"
            aria-label={S.utility.barsLabel}
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
              <!-- COLOR = the side each team held IN THIS ROUND. The
                   {" "} between the team and its value is LOAD-BEARING:
                   Svelte drops a whitespace-only text node between two
                   expressions inside SVG, so a plain space would render
                   "Alpha40 damage". -->
              <rect
                class="util-bar {barSide(p.round, 'ct')}"
                x={ctX}
                y={barH - hCt}
                width={bw}
                height={hCt}
              >
                <title>{S.utility.roundTitlePrefix}{roundIndexLabel(rbn.get(p.round) ?? p.round)} — {names.ct}{" "}{p.ct}{S.utility.damageSuffix}</title>
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
                <title>{S.utility.roundTitlePrefix}{roundIndexLabel(rbn.get(p.round) ?? p.round)} — {names.t}{" "}{p.t}{S.utility.damageSuffix}</title>
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
              <span class="chip badge-computed">{S.utility.badgeComputed}</span></span
            >
            <span
              ><span class="util-dot {clsT}" class:striped={STRIPED_KEY === 't'}></span
              >{names.t}</span
            >
            <span class="muted"
              title={S.utility.damageTitle}
              >{S.utility.maxPrefix}{damageBars.max}{S.utility.maxSuffix}</span
            >
          </div>
        {/if}
      </section>

      <!-- C8: the flash-effectiveness totals card is replaced by the
           damage chart's comparative twin over blind time — same
           geometry, same COLOR = side-at-that-round rule, same stripe
           convention (its own pattern id: two SVGs in one document must
           never share one). The label is the honest semantics of the
           stored total: blind time from THIS TEAM's flashes, not an
           enemy-only figure. -->
      <section class="panel util-card-blind">
        <h2>{S.utility.flashPerRoundHeading}</h2>
        {#if !flashBars.any}
          <p class="muted" role="status">{S.utility.noFlashTime}</p>
        {:else}
          <svg
            class="util-bars"
            viewBox="0 0 {barW} {barH}"
            preserveAspectRatio="none"
            aria-label={S.utility.flashBarsLabel}
          >
            <defs>
              <pattern
                id="util-stripe-blind"
                patternUnits="userSpaceOnUse"
                width="7"
                height="7"
                patternTransform="rotate(45)"
              >
                <rect x="0" y="0" width="3" height="7" class="util-stripe-line" />
              </pattern>
            </defs>
            {#each flashBars.per as p, i (p.round)}
              {@const slot = barW / flashBars.per.length}
              {@const x = i * slot}
              {@const bw = Math.max(2, slot * 0.32)}
              {@const hCt = (p.ct / flashBars.max) * (barH - 4)}
              {@const hT = (p.t / flashBars.max) * (barH - 4)}
              {@const ctX = x + slot * 0.08}
              {@const tX = x + slot * 0.08 + bw + 2}
              <!-- COLOR = the side each team held IN THIS ROUND; the
                   {" "} is the load-bearing space noted above the
                   damage chart (Svelte drops a whitespace-only text node
                   between expressions inside SVG). -->
              <rect
                class="util-bar {barSide(p.round, 'ct')}"
                x={ctX}
                y={barH - hCt}
                width={bw}
                height={hCt}
              >
                <title>{S.utility.roundTitlePrefix}{roundIndexLabel(rbn.get(p.round) ?? p.round)} — {names.ct}{" "}{fmtMs(p.ct)}{S.utility.flashSuffix}</title>
              </rect>
              {#if STRIPED_KEY === 'ct'}
                <rect
                  class="util-bar-stripe"
                  x={ctX}
                  y={barH - hCt}
                  width={bw}
                  height={hCt}
                  fill="url(#util-stripe-blind)"
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
                <title>{S.utility.roundTitlePrefix}{roundIndexLabel(rbn.get(p.round) ?? p.round)} — {names.t}{" "}{fmtMs(p.t)}{S.utility.flashSuffix}</title>
              </rect>
              {#if STRIPED_KEY === 't'}
                <rect
                  class="util-bar-stripe"
                  x={tX}
                  y={barH - hT}
                  width={bw}
                  height={hT}
                  fill="url(#util-stripe-blind)"
                  pointer-events="none"
                />
              {/if}
            {/each}
          </svg>
          <div class="util-legend">
            <span
              ><span class="util-dot {clsCT}" class:striped={STRIPED_KEY === 'ct'}></span
              >{names.ct}</span
            >
            <span
              ><span class="util-dot {clsT}" class:striped={STRIPED_KEY === 't'}></span
              >{names.t}</span
            >
            <span class="chip badge-inferred" title={S.utility.inferredTitle}
              >{S.utility.badgeInferred}</span
            >
            <span class="muted"
              title={S.utility.flashTitle}
              >{S.utility.maxPrefix}{fmtMs(flashBars.max)}{S.utility.flashMaxSuffix}</span
            >
          </div>
        {/if}
      </section>
    </div>

    <!-- ONE consolidated card at the BOTTOM (C7, owner 2026-11-15): the
         kind/thrower filters and the live count moved in here, a single
         line of per-round show/hide toggles (every round starts OFF),
         and the throw list of only the rounds the user turns on. It
         replaces the per-round collapsible cards. -->
    <section class="panel util-throwlog">
      <h2>{S.utility.throwLogHeading}</h2>
      <div class="util-filters toolbar">
        <label class="util-field" for="util-kind">
          <span class="field-label">{S.utility.kindLabel}</span>
          <select class="input" id="util-kind" bind:value={kindF}>
            <option value="">{S.utility.allKinds}</option>
            {#each kindOptions as k (k)}
              <option value={k}>{k}</option>
            {/each}
          </select>
        </label>
        <label class="util-field" for="util-thrower">
          <span class="field-label">{S.utility.throwerLabel}</span>
          <select class="input" id="util-thrower" bind:value={throwerF}>
            <option value="">{S.utility.allPlayers}</option>
            {#each players as p (p.steamId)}
              <option value={p.steamId}>{p.name}</option>
            {/each}
          </select>
        </label>
        <span class="muted"
          >{filtered.length} of {rows.length}{S.utility.grenadeSuffix}{rows.length === 1
            ? ''
            : 's'}</span
        >
      </div>
      <div class="util-toggles">
        {#each groups as [round, list] (round)}
          <button
            class="btn small util-toggle"
            class:primary={!!shown[round]}
            aria-pressed={!!shown[round]}
            title={S.utility.toggleTitle}
            onclick={() => toggleRound(round)}
          >
            <span class="util-toggle-label"
              >{S.utility.roundTitlePrefix}{roundIndexLabel(rbn.get(round) ?? round)}</span
            >
            <span class="chip round-chip">{list.length}</span>
          </button>
        {/each}
      </div>
      {#if groups.length === 0}
        <p class="muted" role="status">{S.utility.noGrenades}</p>
      {:else if !anyShown}
        <p class="muted" role="status">{S.utility.noRoundShown}</p>
      {:else}
        <div class="util-lists">
          {#each groups as [round, list] (round)}
            {#if shown[round]}
              <ul class="util-nades">
                {#each list as r, i (r.tick + ':' + i)}
                  <li class="util-nade">
                    <span class="chip util-kind {r.kind}">{r.kind}</span>
                    <ProfileLink
                      steam={r.thrower}
                      name={r.throwerName || r.thrower}
                      nav={go}
                      cls="util-thrower {playerCls(r.round, r.thrower, r.throwerName)}"
                      title={S.fill(S.utility.openProfile, { name: r.throwerName || r.thrower })}
                    />
                    <span
                      class="mono muted util-tick"
                      title={S.fill(S.utility.tickTitle, { tick: r.tick, round: roundIndexLabel(rbn.get(r.round) ?? r.round) })}
                      >{roundClock(r.tick, rbn.get(r.round), tickRate)}</span
                    >
                    <span class="util-num" title={S.utility.damageDealtTitle}
                      >{fmtZeroDash(r.damage, 'dmg')}</span
                    >
                    <span class="util-num muted" title={S.utility.blindTimeTitle}
                      >{r.flashMsTotal > 0
                        ? fmtMs(r.flashMsTotal)
                        : '—'}</span
                    >
                    <span
                      class="util-num muted"
                      title={S.utility.affectedTitle}
                      >{fmtZeroDash(affectedCount(r.affected), 'aff')}</span
                    >
                    <span class="util-actions">
                      <button
                        class="btn small ghost"
                        title={r.thrower
                          ? `Watch this throw — follow ${r.throwerName || r.thrower}`
                          : S.utility.watchThrowFallback}
                        aria-label={r.thrower
                          ? `Watch this throw at tick ${r.tick} — follow ${r.throwerName || r.thrower}`
                          : `Watch this throw at tick ${r.tick}`}
                        onclick={() => openReplay(r)}
                        ><span class="codicon codicon-play" aria-hidden="true"></span></button
                      >
                    </span>
                    <span
                      class="util-coord muted mono"
                      title={S.utility.coordTitle}
                      >{coordCell(r)}</span
                    >
                  </li>
                {/each}
              </ul>
            {/if}
          {/each}
        </div>
      {/if}
    </section>
  {/if}
</div>
