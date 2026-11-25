<script>
  import { DASH } from '../../builtinhelpers.js';
  import EmptyTableRow from '../../components/EmptyTableRow.svelte';
  // Combat · Kill tags. The duels of
  // the match: round → time into round → killer vs victim → distance in
  // metres, ONE row per KILL (the kill's kind facts share the row, both chips
  // in its Kind cell). The kind filter is a MULTI-SELECT DROPDOWN whose
  // selections are independent/OR'd, NONE CHECKED by default = no filter; the
  // round <select> narrows the same list (round 1 by default, "All rounds"
  // on offer). It reads the match from `context` and nothing else but the
  // loop-length pref, which stays a plain pref (ruling 33).
  import * as S from '../../strings/index.js';
  import { getKillTags } from '../../services.js';
  import { roundClock } from '../../fmt.js';
  import { entryLoopAround } from '../../nav.js';
  import { roundScoreLabel } from '../../rounds.js';
  import { roundsByNumber } from '../../replay/landmarks.js';
  import { matchRecord } from '../../viewstate.svelte.js';
  import { KILL_TAG_DIST_DEF, KILL_TAG_KIND_TITLES } from '../../definitions.js';
  import EventPlay from '../../components/EventPlay.svelte';
  import ProfileLink from '../../components/ProfileLink.svelte';
  import Popover from '../../components/Popover.svelte';
  import { combatPanel } from './combatpanel.svelte.js';
  import { KILL_TAG_KINDS, groupKillTags } from './combatmodel.js';

  let { spectra, context } = $props();
  const id = $derived(context.matchId);

  let killTags = $state([]);
  // The match's kill tags, with its side data (the team-identity colours on names,
  // the per-round side colours, the row clock) and the error line.
  const combat = combatPanel(
    () => spectra,
    () => id,
    {
      read: (matchId) => getKillTags(matchId, ''),
      apply: (list) => {
        killTags = list;
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

  const rbn = $derived(roundsByNumber(rounds));

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
  const combSeed = matchRecord('combat', () => id, {
    defaults: combDefaults,
    read: () => ({ engKinds, engRound }),
    write: (s) => {
      engKinds = s.engKinds;
      engRound = s.engRound;
    },
  });
  let engKinds = $state(combSeed.engKinds);
  // The kind dropdown's OPEN state is transient, like every popover.
  let kindOpen = $state(false);
  let kindAnchor = $state(null);
  let kindTrigger = $state(null);
  let engRound = $state(combSeed.engRound);

  // One row per kill (see combatdata.js groupKillTags).
  const killTagRows = $derived(groupKillTags(killTags));

  // The round <select> shows the recorded choice while it still exists in the
  // option list, else the first round with a kill, else "All rounds".
  const engRoundOptions = $derived([...new Set(killTagRows.map((g) => g.round))].sort((a, b) => a - b));
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
  const replay = combat.replay;
</script>


<div class="comb-sec">
  <h2>{S.combat.killTagsHeading}</h2>
  <div class="comb-kinds" role="group" aria-label={S.combat.filterKillTagsLabel}>
    <span class="comb-kind-host" bind:this={kindAnchor}>
      <span class="comb-field">
        <span class="field-label">{S.combat.kindFilterLabel}</span>
        <button
          type="button"
          class="input multi-trigger"
          class:multi-open={kindOpen}
          bind:this={kindTrigger}
          aria-haspopup="true"
          aria-expanded={kindOpen}
          aria-controls={kindOpen ? 'comb-kind-pop' : null}
          onclick={() => (kindOpen = !kindOpen)}
        >
          {kindSummary}
        </button>
      </span>
      <Popover open={kindOpen} anchor={kindAnchor} onClose={closeKinds} onOutside={closeKindsOutside}>
        <div class="comb-kind-pop" id="comb-kind-pop" role="group" aria-label={S.combat.kindFilterLabel}>
          {#each KILL_TAG_KINDS as k (k)}
            <label class="filt-check">
              <input type="checkbox" checked={engKinds.includes(k)} onchange={() => toggleEngKind(k)} />
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
            <td class="num mono" title={S.fill(S.combat.tickTitle, { tick: g.tick })}>
              {roundClock(g.tick, rbn.get(g.round), tickRate)}
            </td>
            <td>
              <!-- ONE kill, up to FOUR kind facts; each chip keeps its own
                     perspective title, plus an sr-only combined line. -->
              {#each g.kinds as k, i (k)}{#if i > 0}{' · '}{/if}<span
                  class="chip comb-kind-chip {k}"
                  title={KILL_TAG_KIND_TITLES[k] || k}
                >
                  {k}
                </span>{/each}{#if g.kinds.length > 1}{' '}<span class="sr-only">
                  {S.combat.oneKillPrefix}{g.kinds.map((k) => KILL_TAG_KIND_TITLES[k] || k).join('; ')}
                </span>{/if}
            </td>
            <td>
              <ProfileLink
                steam={g.aSteam}
                name={g.aName || DASH}
                nav={spectra.navigate}
                cls={playerRoundCls(g.round, g.aSteam, g.aName)}
                title={S.fill(S.combat.openProfileName, { name: g.aName })}
              />
            </td>
            <td class="muted">{S.combat.versus}</td>
            <td>
              <ProfileLink
                steam={g.bSteam}
                name={g.bName || DASH}
                nav={spectra.navigate}
                cls={playerRoundCls(g.round, g.bSteam, g.bName)}
                title={S.fill(S.combat.openProfileName, { name: g.bName })}
              />
            </td>
            <td class="num" title={KILL_TAG_DIST_DEF}>{g.distance ? Math.round(g.distance) : DASH}</td>
          </tr>
        {:else}
          <EmptyTableRow colspan={8} text={error ? S.combat.killTagsUnavailable : S.combat.noKillTags} />
        {/each}
      </tbody>
    </table>
  </div>
</div>
