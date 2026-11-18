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
  import { roundIndexLabel, roundScoreLabel } from '../rounds.js';
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
  import EventPlay from '../components/EventPlay.svelte';

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

  // View-local state (kind + thrower filters, the round scope) restores
  // per match through the process-scoped registry (viewstate.svelte.js):
  // the key carries the match id (matchKey), so match A's filters never
  // seed into match B. App's {#if} chain reuses Match's children across
  // an id change (no remount), so ONE combined effect both RE-SEEDS when
  // the key changes and writes through otherwise — self-ordering: the
  // write branch runs only while the key is unchanged, so the old match's
  // values can never land under the new key. Loading/error stay
  // transient.
  //
  // The round scope (owner answer Q1, 2026-11-16 — it SUPERSEDES C7's
  // all-rounds-OFF default, which the per-round toggle row embodied and
  // which this selector replaces): ONE round <select> in the filter row,
  // PRESELECTING the first round with throws (the log opens compact — the
  // C7 spirit kept) and offering an "All rounds" option. `roundSel`
  // records the USER's choice only: '' = untouched (auto → the first
  // round with throws, re-resolved whenever the filter changes the option
  // list), 'all' = every round, otherwise the round's own option value
  // (a round number as text — the same shape Combat's scope keeps). The registry is
  // process-scoped and never serialized, and seed() reads only the
  // defaults' own keys — the retired `shown` map (and the `closed` key
  // before it) can never surface here.
  const utilDefaults = () => ({ kindF: '', throwerF: '', roundSel: '' });
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
  // '' = untouched (auto → preselect the first round with throws),
  // 'all' = every round, otherwise the round's option value (see
  // utilDefaults).
  let roundSel = $state(utilSeed.roundSel);
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
      roundSel = s.roundSel;
      return;
    }
    remember(k, { kindF, throwerF, roundSel });
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
  // components are 0 (and when the row recorded no position at all —
  // ThrowX/ThrowY arrive as value floats, so a missing one would
  // otherwise render "(NaN, NaN)"). The cell shows the THROW origin (the
  // owner's throw-based ruling); an unpaired row (no throw origin) dashes
  // — the detonation coordinates are stored data (detX/detY) and are no
  // longer displayed. Any real coordinate renders as-is, including a
  // single zero: (5, 0).
  function coordCell(r) {
    const x = r.throwX;
    const y = r.throwY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return '—'; // no throw position recorded
    if (x === 0 && y === 0) return '—';
    return `(${Math.round(x)}, ${Math.round(y)})`;
  }

  // The row's EFFECTIVE tick — THE throw-based time: the paired throw's
  // own tick (throwTick > 0), the detonation tick otherwise (the
  // unpaired row's honest fallback — a known fact; a throw time that was
  // never observed is never invented). Drives the clock, the tick
  // tooltip, the ▶ stamp + loop and the play button's labels; the Go
  // twin is models.UtilityEvent.EffectiveTick.
  const effTick = (r) => (r.throwTick > 0 ? r.throwTick : r.tick);

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

  // The round options: only the rounds that carry throws in the CURRENT
  // kind/thrower filter — the selector never offers an empty round.
  const roundOptions = $derived(groups.map(([round]) => round));

  // What the <select> shows: the recorded choice while it still exists
  // in the option list, else the PRESELECT (the first round with throws —
  // owner answer Q1), else "All rounds" when the filter leaves no throws
  // at all. The stored choice is normalized here, never by an effect, so
  // one spelling decides what the control renders.
  const roundValue = $derived(
    roundSel === 'all'
      ? 'all'
      : roundSel !== '' && roundOptions.some((n) => String(n) === roundSel)
        ? roundSel
        : roundOptions.length
          ? String(roundOptions[0])
          : 'all',
  );

  // The rounds in scope: every group under "All rounds", the selected one
  // otherwise (its option exists only when it carries throws).
  const shownGroups = $derived(
    roundValue === 'all' ? groups : groups.filter(([round]) => String(round) === roundValue),
  );

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
    // `any` mirrors the blind chart's flag below (W17, owner
    // 2026-11-16): "empty" for BOTH cards means no DRAWABLE data, so
    // the card hides entirely instead of rendering its placeholder —
    // a filter with rounds but no damage among them (e.g. kind=flash)
    // hides the damage card too, rather than drawing zero-height bars.
    return { per, max: max || 1, any: max > 0 };
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
    // `any` is the blind card's drawability flag (W17, owner
    // 2026-11-16): no rounds at all in the current filter, or rounds
    // present but no blind time among them (a Kind filter with no
    // flashes) — both mean NO drawable data, so the card hides
    // entirely (it returns the moment a throw with blind time lands
    // in the filter) instead of a chart of zero-height bars. The
    // damage chart's twin flag is damageBars.any above.
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

  // The throw's row ▶ — ICON-ONLY play (EventPlay, the one canonical
  // tick-link glyph; no label text). It stamps the row's EFFECTIVE tick
  // (effTick: the paired throw's own tick, the detonation tick when
  // unpaired — never an interpolated throw time) with a loop-length
  // entry loop around it (nav.entryLoopAround — the `loop_secs` pref,
  // loopSecs above) AND the THROWER as the camera follow: entry
  // context, never a filter — an absent thrower stamps no follow
  // (buildHash drops it). The ONE way this view enters the replay:
  // buttons SEEK, never set a landmark filter (the retired round
  // "events" filter button stays gone).
  function openReplay(r) {
    // `|| undefined` — an absent thrower stamps NOTHING (buildHash keeps
    // an empty string as `follow=`, which is not "no stamp").
    const t = effTick(r);
    go(replayHash(id, {}, { tick: t, loop: entryLoopAround(t, tickRate, loopSecs), follow: r.thrower || undefined, back }));
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
    <!-- The consolidated throw log LEADS the view (owner, 2026-11-16 —
         this reverses the 2026-11-15 C7 bottom-card ruling): the card
         carrying the filters, the count and the round selector is the
         first card now. -->
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
        <!-- The ONE round scope (owner answer Q1): labels read the
             canonical `RD<n> | <ct>-<t>` (roundScoreLabel). The option
             list only ever carries rounds WITH throws, so the control
             can never sit on an empty round; the stored choice stays
             `''` until the user moves it (auto → first round). -->
        <label class="util-field" for="util-round">
          <span class="field-label">{S.utility.roundLabel}</span>
          <select
            class="input"
            id="util-round"
            value={roundValue}
            onchange={(e) => (roundSel = e.currentTarget.value)}
          >
            <option value="all">{S.utility.allRounds}</option>
            {#each roundOptions as n (n)}
              <option value={String(n)}>{roundScoreLabel(rounds, n)}</option>
            {/each}
          </select>
        </label>
        <span class="muted"
          >{filtered.length} of {rows.length}{S.utility.grenadeSuffix}{rows.length === 1
            ? ''
            : 's'}</span
        >
      </div>
      {#if groups.length === 0}
        <p class="muted" role="status">{S.utility.noGrenades}</p>
      {:else}
        <div class="util-lists">
          {#each shownGroups as [round, list] (round)}
            <ul class="util-nades">
              {#each list as r, i (r.tick + ':' + i)}
                <li class="util-nade">
                  <!-- The row's ONE ▶ LEADS the row (owner ruling): the
                       <li> has NO row-click handler — only the
                       error-dismiss ✕ and this button carry onclick —
                       so no stopPropagation is needed here. -->
                  <span class="util-actions">
                    <EventPlay
                      tick={effTick(r)}
                      title={r.thrower
                        ? `Watch this throw — follow ${r.throwerName || r.thrower}`
                        : S.utility.watchThrowFallback}
                      label={r.thrower
                        ? `Watch this throw — follow ${r.throwerName || r.thrower}`
                        : S.utility.watchThrowFallback}
                      onclick={() => openReplay(r)}
                    />
                  </span>
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
                    title={S.fill(S.utility.tickTitle, { tick: effTick(r), round: roundIndexLabel(rbn.get(r.round) ?? r.round) })}
                    >{roundClock(effTick(r), rbn.get(r.round), tickRate)}</span
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
                  <span
                    class="util-coord muted mono"
                    title={S.utility.coordTitle}
                    >{coordCell(r)}</span
                  >
                </li>
              {/each}
            </ul>
          {/each}
        </div>
      {/if}
    </section>
    <!-- The two summary charts FOLLOW the throw log (owner, 2026-11-16 —
         this reverses the 2026-11-15 C7 bottom-card ruling) and each
         card now HIDES ENTIRELY when it has nothing to draw
         (damageBars.any / flashBars.any — W17): no placeholder line,
         no chart of zero-height bars. The card returns the moment data
         appears under the current filter. -->
    <div class="util-summary">
      {#if damageBars.any}
      <section class="panel util-card-damage">
        <h2>{S.utility.damagePerRoundHeading}</h2>
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
      </section>
      {/if}

      <!-- C8: the flash-effectiveness totals card is replaced by the
           damage chart's comparative twin over blind time — same
           geometry, same COLOR = side-at-that-round rule, same stripe
           convention (its own pattern id: two SVGs in one document must
           never share one). The label is the honest semantics of the
           stored total: blind time from THIS TEAM's flashes, not an
           enemy-only figure. -->
      {#if flashBars.any}
      <section class="panel util-card-blind">
        <h2>{S.utility.flashPerRoundHeading}</h2>
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
      </section>
      {/if}
    </div>

  {/if}
</div>
