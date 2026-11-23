<script>
  // Combat · Kill tags. The duels of
  // the match: round → time into round → killer vs victim → distance in
  // metres, ONE row per KILL (the kill's kind facts share the row, both chips
  // in its Kind cell). The kind filter is a MULTI-SELECT DROPDOWN whose
  // selections are independent/OR'd, NONE CHECKED by default = no filter; the
  // round <select> narrows the same list (round 1 by default, "All rounds"
  // on offer). It reads the match from `context` and nothing else but the
  // loop-length pref, which stays a plain pref (ruling 33).
  import * as S from '../../strings/index.js';
  import { getKillTags, getPref, errText } from '../../services.js';
  import { onMount } from 'svelte';
  import { roundClock } from '../../fmt.js';
  import { replayHash, entryLoopAround, LOOP_SECS_DEFAULT, prefLoopSecs } from '../../nav.js';
  import { roundScoreLabel } from '../../rounds.js';
  import { roundsByNumber } from '../../replay/landmarks.js';
  import { playerSideClassAt } from '../../teams.js';
  import { seed, remember, matchKey } from '../../viewstate.svelte.js';
  import { KILL_TAG_DIST_DEF, KILL_TAG_KIND_TITLES } from '../../definitions.js';
  import EventPlay from '../../components/EventPlay.svelte';
  import ProfileLink from '../../components/ProfileLink.svelte';
  import Popover from '../../components/Popover.svelte';
  import { loadCombatSide } from './combatdata.js';
  import { KILL_TAG_KINDS, groupKillTags } from './combatmodel.js';

  let { spectra, context } = $props();
  const id = $derived(context.matchId);

  let killTags = $state([]);
  let error = $state('');
  // Final side per player and the side-switch count: the inputs for the
  // team-identity colours on names. Round list: the per-round side colours
  // and the row clock (roundClock: time INTO the round).
  let players = $state([]);
  let sideSwitches = $state(0);
  let rounds = $state([]);
  let tickRate = $state(64);

  // Event-level loop length: the `loop_secs` pref, read ONCE at mount
  // (prefLoopSecs coerces unset/corrupt to LOOP_SECS_DEFAULT).
  let loopSecs = LOOP_SECS_DEFAULT;
  onMount(() => {
    getPref('loop_secs')
      .then((v) => (loopSecs = prefLoopSecs(v)))
      .catch(() => {
        /* keep the default */
      });
  });

  const rbn = $derived(roundsByNumber(rounds));

  function playerRoundCls(roundNumber, steamId, name) {
    return playerSideClassAt(players, sideSwitches, rounds, roundNumber, steamId, name);
  }

  // View-local filter state restores per match through the process-scoped
  // registry (viewstate.svelte.js). The record is shared with the Clutches
  // panel under the same key; remember merges, so each panel writes only its
  // own fields.
  const combDefaults = () => ({
    // An ARRAY of checked kinds: [] (none checked) is the no-filter default.
    engKinds: [],
    // The round scope: 'all' or a round number as text. Defaults to round 1.
    engRound: '1',
  });
  const combKey = $derived(matchKey('combat', id));
  // Deliberate ONE-TIME init capture (Svelte's state_referenced_locally fix);
  // the effect below owns every later key change.
  const combInit = () => ({ ...seed(combKey, combDefaults()), key: combKey });
  const combSeed = combInit();
  let engKinds = $state(combSeed.engKinds);
  // The kind dropdown's OPEN state is transient, like every popover.
  let kindOpen = $state(false);
  let kindAnchor = $state(null);
  let kindTrigger = $state(null);
  let engRound = $state(combSeed.engRound);
  let combLastKey = combSeed.key;
  $effect(() => {
    const k = combKey;
    if (k !== combLastKey) {
      // Another match without a remount: apply its record and do not write.
      combLastKey = k;
      const s = seed(k, combDefaults());
      engKinds = s.engKinds;
      engRound = s.engRound;
      return;
    }
    remember(k, { engKinds, engRound });
  });

  $effect(() => {
    const matchId = id;
    let live = true;
    spectra.track(Promise.all([getKillTags(matchId, ''), loadCombatSide(matchId)]))
      .then(([en, side]) => {
        if (!live) return;
        killTags = en || [];
        players = side.players;
        sideSwitches = side.sideSwitches;
        rounds = side.rounds;
        tickRate = side.tickRate;
        error = '';
      })
      .catch((e) => {
        if (live) {
          error = errText(e);
        }
      });
    return () => (live = false);
  });

  // One row per kill (see combatdata.js groupKillTags).
  const killTagRows = $derived(groupKillTags(killTags));

  // The round <select> shows the recorded choice while it still exists in the
  // option list, else the first round with a kill, else "All rounds".
  const engRoundOptions = $derived(
    [...new Set(killTagRows.map((g) => g.round))].sort((a, b) => a - b),
  );
  const engRoundValue = $derived(
    engRound === 'all'
      ? 'all'
      : engRound !== '' && engRoundOptions.some((n) => String(n) === engRound)
        ? engRound
        : engRoundOptions.length
          ? String(engRoundOptions[0])
          : 'all',
  );
  const visibleKillTags = $derived(
    killTagRows.filter(
      (g) =>
        (engKinds.length === 0 || g.kinds.some((k) => engKinds.includes(k))) &&
        (engRoundValue === 'all' || String(g.round) === engRoundValue),
    ),
  );

  // Each check adds its kind to the selection or removes it; unchecking
  // everything lands back on the no-filter default.
  function toggleEngKind(k) {
    engKinds = engKinds.includes(k) ? engKinds.filter((x) => x !== k) : [...engKinds, k];
  }

  // The kind dropdown's dismissal: Escape closes and returns focus to the
  // trigger; an outside pointerdown closes without stealing it.
  function closeKinds() {
    kindOpen = false;
    kindTrigger?.focus();
  }
  function closeKindsOutside() {
    kindOpen = false;
  }

  // The closed state's wording: the EFFECTIVE filter. No checked kind and all
  // four checked both read "All kinds".
  const kindSummary = $derived(
    engKinds.length === 0 || engKinds.length === KILL_TAG_KINDS.length
      ? S.combat.allKinds
      : KILL_TAG_KINDS.filter((k) => engKinds.includes(k)).join(', '),
  );

  // Deep link into the replay at a tick, with an optional entry-only loop.
  // `follow` is the row's killer: never a filter.
  function replay(tick, loop, follow) {
    spectra.navigate(replayHash(id, {}, { tick, loop, follow: follow || undefined, back: `match/${id}/combat` }));
  }
</script>
<div class="builtin-root">

{#if error}
  <p class="error" role="alert">
    {error}
    <button class="btn small" aria-label={S.combat.dismissError} onclick={() => (error = '')}>
      <span class="codicon codicon-close"></span>
    </button>
  </p>
{/if}

  <section class="panel comb-sec">
    <h2>{S.combat.killTagsHeading}</h2>
    <div class="comb-kinds" role="group" aria-label={S.combat.filterKillTagsLabel}>
      <span class="comb-kind-host" bind:this={kindAnchor}>
        <span class="comb-field">
          <span class="field-label">{S.combat.kindFilterLabel}</span>
          <button
            type="button"
            class="btn small"
            class:primary={kindOpen}
            bind:this={kindTrigger}
            aria-haspopup="true"
            aria-expanded={kindOpen}
            aria-controls={kindOpen ? 'comb-kind-pop' : null}
            onclick={() => (kindOpen = !kindOpen)}
          >
            {kindSummary}
            <span class="codicon codicon-chevron-down" aria-hidden="true"></span>
          </button>
        </span>
        <Popover
          open={kindOpen}
          anchor={kindAnchor}
          onClose={closeKinds}
          onOutside={closeKindsOutside}
        >
          <div
            class="comb-kind-pop"
            id="comb-kind-pop"
            role="group"
            aria-label={S.combat.kindFilterLabel}
          >
            {#each KILL_TAG_KINDS as k (k)}
              <label class="filt-check">
                <input
                  type="checkbox"
                  checked={engKinds.includes(k)}
                  onchange={() => toggleEngKind(k)}
                />
                {k}
              </label>
            {/each}
          </div>
        </Popover>
      </span>
      <div class="comb-round-filter">
        <label class="comb-field" for="comb-round-filter">
          <span class="field-label">{S.combat.roundFilterLabel}</span>
          <select
            class="input"
            id="comb-round-filter"
            value={engRoundValue}
            onchange={(e) => (engRound = e.currentTarget.value)}
          >
            <option value="all">{S.combat.allRounds}</option>
            {#each engRoundOptions as n (n)}
              <option value={String(n)}>{roundScoreLabel(rounds, n)}</option>
            {/each}
          </select>
        </label>
      </div>
    </div>
    <div class="table-scroll">
      <table class="data-table">
        <thead>
          <tr>
            <th scope="col"><span class="sr-only">{S.combat.thReplay}</span></th>
            <th scope="col" class="num">{S.combat.thRound}</th>
            <th scope="col" class="num def" title={S.combat.timeTitle}>{S.combat.thTime}</th>
            <th scope="col">{S.combat.thKind}</th>
            <th scope="col">{S.combat.thKiller}</th>
            <th scope="col"><span class="sr-only">{S.combat.thVersus}</span></th>
            <th scope="col">{S.combat.thVictim}</th>
            <th scope="col" class="num def" title={KILL_TAG_DIST_DEF}>{S.combat.thDist}</th>
          </tr>
        </thead>
        <tbody>
          {#each visibleKillTags as g (g.key)}
            <tr>
              <td>
                <!-- Row ▶ follows the KILL TAG's KILLER. -->
                <EventPlay
                  tick={g.tick}
                  title={g.aSteam
                    ? S.fill(S.combat.watchKillFollow, { name: g.aName || g.aSteam }) + S.combat.killerSuffix
                    : S.combat.watchKillTag}
                  label={g.aSteam
                    ? S.fill(S.combat.watchKillFollow, { name: g.aName || g.aSteam })
                    : S.combat.watchKillTag}
                  onclick={() => replay(g.tick, entryLoopAround(g.tick, tickRate, loopSecs), g.aSteam)}
                />
              </td>
              <!-- The Round cell is TEXT, not a control: the row's ONE ▶ is the
                   event/follow play above. -->
              <td class="num">{g.round}</td>
              <td class="num mono" title={S.fill(S.combat.tickTitle, { tick: g.tick })}>{roundClock(g.tick, rbn.get(g.round), tickRate)}</td>
              <td>
                <!-- ONE kill, up to FOUR kind facts; each chip keeps its own
                     perspective title, plus an sr-only combined line. -->
                {#each g.kinds as k, i (k)}{#if i > 0}{' · '}{/if}<span class="chip comb-kind-chip {k}" title={KILL_TAG_KIND_TITLES[k] || k}>{k}</span>{/each}{#if g.kinds.length > 1}{' '}<span class="sr-only">{S.combat.oneKillPrefix}{g.kinds.map((k) => KILL_TAG_KIND_TITLES[k] || k).join('; ')}</span>{/if}
              </td>
              <td>
                <ProfileLink
                  steam={g.aSteam}
                  name={g.aName || '—'}
                  nav={spectra.navigate}
                  cls={playerRoundCls(g.round, g.aSteam, g.aName)}
                  title={S.fill(S.combat.openProfileName, { name: g.aName })}
                />
              </td>
              <td class="muted">{S.combat.versus}</td>
              <td>
                <ProfileLink
                  steam={g.bSteam}
                  name={g.bName || '—'}
                  nav={spectra.navigate}
                  cls={playerRoundCls(g.round, g.bSteam, g.bName)}
                  title={S.fill(S.combat.openProfileName, { name: g.bName })}
                />
              </td>
              <td class="num" title={KILL_TAG_DIST_DEF}>{g.distance ? Math.round(g.distance) : '—'}</td>
            </tr>
          {:else}
            <tr>
              <td colspan="8" class="muted">
                {error ? S.combat.killTagsUnavailable : S.combat.noKillTags}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>
</div>
