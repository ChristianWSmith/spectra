<script>
  import EmptyNote from '../../components/EmptyNote.svelte';
  import { DASH, S, getClutches, entryLoopSpanAround, matchRecord } from '../../builtinhelpers.js';
  import EmptyTableRow from '../../components/EmptyTableRow.svelte';
  // Combat · Clutches. The detected 1vN
  // situations of the match (size, player, outcome, bomb state, HP left).
  // The won / lost toggles select which outcomes are listed: won ON and lost
  // OFF by default. It reads the match from `context`; the loop-length pref
  // stays a plain pref (ruling 33).
  import EventPlay from '../../components/EventPlay.svelte';
  import ProfileLink from '../../components/ProfileLink.svelte';
  import { combatPanel } from './combatpanel.svelte.js';
  import { clutchKillTicks } from './combatmodel.js';

  let { spectra, context } = $props();
  const id = $derived(context.matchId);

  let clutches = $state([]);
  // The match's clutches and its side data, with the error line and the loop length.
  const combat = combatPanel(
    () => spectra,
    () => id,
    {
      read: (matchId) => getClutches(matchId),
      apply: (list) => {
        clutches = list;
      },
    },
  );
  const error = $derived(combat.error);
  const players = $derived(combat.players);
  const sideSwitches = $derived(combat.sideSwitches);
  const rounds = $derived(combat.rounds);
  const tickRate = $derived(combat.tickRate);
  const loopSecs = $derived(combat.loopSecs);
  const playerRoundCls = combat.playerRoundCls;

  // The outcome toggles restore per match through the same registry record
  // as the Kill tags panel (remember merges, so each writes its own fields).
  const combDefaults = () => ({
    clutchWon: true,
    clutchLost: false,
  });
  const combSeed = matchRecord('combat', () => id, {
    defaults: combDefaults,
    read: () => ({ clutchWon, clutchLost }),
    write: (s) => {
      clutchWon = s.clutchWon;
      clutchLost = s.clutchLost;
    },
  });
  // Independent booleans (not one enum): both ON lists every clutch, both OFF
  // is the empty state.
  let clutchWon = $state(combSeed.clutchWon);
  let clutchLost = $state(combSeed.clutchLost);

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
  const replay = combat.replay;
</script>


<div class="comb-sec">
  <h2>{S.combat.clutchesHeading}</h2>
  <!-- Outcome TOGGLES: each flips its own boolean. Local state only, never
         route-query state. -->
  <div class="comb-kinds" role="group" aria-label={S.combat.filterClutchesLabel}>
    <button
      class="btn small comb-kind"
      class:active={clutchWon}
      aria-pressed={clutchWon}
      onclick={() => (clutchWon = !clutchWon)}
    >
      {S.combat.wonToggle}
    </button>
    <button
      class="btn small comb-kind"
      class:active={clutchLost}
      aria-pressed={clutchLost}
      onclick={() => (clutchLost = !clutchLost)}
    >
      {S.combat.lostToggle}
    </button>
  </div>
  {#if clutches.length === 0 && error}
    <EmptyNote>{S.combat.clutchesUnavailable}</EmptyNote>
  {:else if clutches.length === 0}
    <EmptyNote>{S.combat.noClutches}</EmptyNote>
  {:else if shownClutches.length === 0}
    <EmptyNote>{clutchEmptyText}</EmptyNote>
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
                  name={c.name || DASH}
                  nav={spectra.navigate}
                  variant="name-link"
                  cls={playerRoundCls(c.round, c.steamId, c.name)}
                  title={S.combat.openPlayerProfile}
                />
              </td>
              <td>
                <span class="chip status {c.won ? 'ok' : 'bad'}">
                  {c.won ? S.combat.clutchWon : S.combat.clutchLost}
                </span>
              </td>
              <td>
                {#if c.bombState && c.bombState !== 'none'}
                  <span class="chip">{S.combat.bombPrefix}{c.bombState}</span>
                {:else}
                  <span class="muted">{DASH}</span>
                {/if}
              </td>
              <td class="num">{c.hpLeft}</td>
            </tr>
          {:else}
            <EmptyTableRow colspan={7} text={clutchEmptyText} />
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
