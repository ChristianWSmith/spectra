<script>
  // Combat · Clutches. The detected 1vN
  // situations of the match (size, player, outcome, bomb state, HP left).
  // The won / lost toggles select which outcomes are listed: won ON and lost
  // OFF by default. It reads the match from `context`; the loop-length pref
  // stays a plain pref (ruling 33).
  import * as S from '../../strings/index.js';
  import { getClutches, getPref, errText } from '../../services.js';
  import { onMount } from 'svelte';
  import { replayHash, entryLoopSpanAround, LOOP_SECS_DEFAULT, prefLoopSecs } from '../../nav.js';
  import { playerSideClassAt } from '../../teams.js';
  import { seed, remember, matchKey } from '../../viewstate.svelte.js';
  import EventPlay from '../../components/EventPlay.svelte';
  import ProfileLink from '../../components/ProfileLink.svelte';
  import StatusChip from '../../components/StatusChip.svelte';
  import { loadCombatSide } from './combatdata.js';
  import { clutchKillTicks } from './combatmodel.js';

  let { spectra, context } = $props();
  const id = $derived(context.matchId);

  let clutches = $state([]);
  let error = $state('');
  // Rung 3 of the loading ladder: transient, never seeded.
  let loading = $state(true);
  let players = $state([]);
  let sideSwitches = $state(0);
  let rounds = $state([]);
  let tickRate = $state(64);

  let loopSecs = LOOP_SECS_DEFAULT;
  onMount(() => {
    getPref('loop_secs')
      .then((v) => (loopSecs = prefLoopSecs(v)))
      .catch(() => {
        /* keep the default */
      });
  });

  function playerRoundCls(roundNumber, steamId, name) {
    return playerSideClassAt(players, sideSwitches, rounds, roundNumber, steamId, name);
  }

  // The outcome toggles restore per match through the same registry record
  // as the Engagements panel (remember merges, so each writes its own fields).
  const combDefaults = () => ({
    clutchWon: true,
    clutchLost: false,
  });
  const combKey = $derived(matchKey('combat', id));
  const combInit = () => ({ ...seed(combKey, combDefaults()), key: combKey });
  const combSeed = combInit();
  // Independent booleans (not one enum): both ON lists every clutch, both OFF
  // is the empty state.
  let clutchWon = $state(combSeed.clutchWon);
  let clutchLost = $state(combSeed.clutchLost);
  let combLastKey = combSeed.key;
  $effect(() => {
    const k = combKey;
    if (k !== combLastKey) {
      combLastKey = k;
      const s = seed(k, combDefaults());
      clutchWon = s.clutchWon;
      clutchLost = s.clutchLost;
      return;
    }
    remember(k, { clutchWon, clutchLost });
  });

  $effect(() => {
    const matchId = id;
    let live = true;
    Promise.all([getClutches(matchId), loadCombatSide(matchId)])
      .then(([cl, side]) => {
        if (!live) return;
        clutches = cl || [];
        players = side.players;
        sideSwitches = side.sideSwitches;
        rounds = side.rounds;
        tickRate = side.tickRate;
        error = '';
        loading = false;
      })
      .catch((e) => {
        if (live) {
          error = errText(e);
          loading = false;
        }
      });
    return () => (live = false);
  });

  // The listed clutches: the outcome toggles select them. A lost 1vN is listed
  // with its outcome chip rather than dropped.
  const shownClutches = $derived(clutches.filter((c) => (c.won ? clutchWon : clutchLost)));

  // Filter-aware empty state: names what the toggles asked for.
  const clutchEmptyText = $derived(
    !clutchWon && !clutchLost
      ? S.combat.clutchNoneSelected
      : clutchWon && !clutchLost
        ? S.combat.clutchNoneWon
        : !clutchWon && clutchLost
          ? S.combat.clutchNoneLost
          : S.combat.clutchNoneAny,
  );

  // The clutch row's ?loop=: the loop length before the FIRST kill of the
  // clutch to the same length after the LAST kill. A won clutch with no kill in
  // the span falls back to the raw clutch span, padded the same length.
  function clutchLoop(c) {
    const kills = clutchKillTicks(c.killTicks);
    if (kills.length > 0) {
      const first = Math.min(...kills);
      const last = Math.max(...kills);
      return entryLoopSpanAround(first, last, tickRate, loopSecs);
    }
    return entryLoopSpanAround(c.startTick, c.endTick, tickRate, loopSecs);
  }

  // Deep link into the replay at a tick. `follow` is the clutch's solo: never a
  // filter.
  function replay(tick, loop, follow) {
    spectra.navigate(replayHash(id, {}, { tick, loop, follow: follow || undefined, back: `match/${id}/combat` }));
  }
</script>

{#if error}
  <p class="error" role="alert">
    {error}
    <button class="btn small" aria-label={S.combat.dismissError} onclick={() => (error = '')}>
      <span class="codicon codicon-close"></span>
    </button>
  </p>
{/if}

{#if loading}
  <p class="muted" role="status"><StatusChip block detail={S.combat.loadingDetail} /></p>
{:else}
  <section class="panel comb-sec">
    <h2>{S.combat.clutchesHeading}</h2>
    <!-- Outcome TOGGLES: each flips its own boolean. Local state only, never
         route-query state. -->
    <div class="comb-kinds" role="group" aria-label={S.combat.filterClutchesLabel}>
      <button
        class="btn small comb-kind"
        class:active={clutchWon}
        aria-pressed={clutchWon}
        onclick={() => (clutchWon = !clutchWon)}
      >{S.combat.wonToggle}</button>
      <button
        class="btn small comb-kind"
        class:active={clutchLost}
        aria-pressed={clutchLost}
        onclick={() => (clutchLost = !clutchLost)}
      >{S.combat.lostToggle}</button>
    </div>
    {#if clutches.length === 0 && !error}
      <p class="muted" role="status">{S.combat.noClutches}</p>
    {:else if shownClutches.length === 0}
      <p class="muted" role="status">{clutchEmptyText}</p>
    {:else}
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th scope="col"><span class="sr-only">{S.combat.thReplay}</span></th>
              <th scope="col" class="num">{S.combat.thRound}</th>
              <th scope="col">{S.combat.thSize}</th>
              <th scope="col">{S.combat.thPlayer}</th>
              <th scope="col">{S.combat.thOutcome}</th>
              <th scope="col">{S.combat.thBomb}</th>
              <th scope="col" class="num def" title={S.combat.hpTitle}>{S.combat.thHpLeft}</th>
            </tr>
          </thead>
          <tbody>
            {#each shownClutches as c (c.id)}
              <tr>
                <td>
                  {#if c.replayAnchorTick > 0}
                    <!-- Row ▶ follows the CLUTCH's solo; the loop is the kill span. -->
                    <EventPlay
                      tick={c.replayAnchorTick}
                      title={c.steamId
                        ? S.fill(S.combat.watchClutchFollow, { name: c.name || c.steamId })
                        : S.combat.watchClutch}
                      label={c.steamId
                        ? S.fill(S.combat.watchClutchRoundFollow, { round: c.round, name: c.name || c.steamId })
                        : S.fill(S.combat.watchClutchRoundReplay, { round: c.round })}
                      onclick={() => replay(c.replayAnchorTick, clutchLoop(c), c.steamId)}
                    />
                  {/if}
                </td>
                <td class="num">{c.round}</td>
                <td><strong>{S.combat.clutchSize}{c.size}</strong></td>
                <td>
                  <ProfileLink
                    steam={c.steamId}
                    name={c.name || '—'}
                    nav={spectra.navigate}
                    cls={playerRoundCls(c.round, c.steamId, c.name)}
                    title={S.combat.openPlayerProfile}
                  />
                </td>
                <td>
                  <span class="chip status {c.won ? 'ok' : 'bad'}">{c.won ? S.combat.clutchWon : S.combat.clutchLost}</span>
                </td>
                <td>
                  {#if c.bombState && c.bombState !== 'none'}
                    <span class="chip">{S.combat.bombPrefix}{c.bombState}</span>
                  {:else}
                    <span class="muted">—</span>
                  {/if}
                </td>
                <td class="num">{c.hpLeft}</td>
              </tr>
            {:else}
              <tr><td colspan="7" class="muted">{clutchEmptyText}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
{/if}
