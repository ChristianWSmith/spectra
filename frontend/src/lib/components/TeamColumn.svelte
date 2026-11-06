<script>
  // TeamColumn — one team's card stack beside the replay render area:
  // the team name (colored by the side that team is ON AT THE PLAYHEAD)
  // with the per-team voice mute beside it, then five PlayerCards.
  //
  // Prop contract — the caller precomputes everything; this component
  // only lays it out:
  //   teamName        display name (teams.teamNames — demo clan name,
  //                   synthesized name, or the bare side)
  //   side            'ct' | 't' | '' — CURRENT side at the playhead →
  //                   the name's color and every card's tint; '' = //                   unknown → neutral, never a guessed color
  //   players         one entry per player = PlayerCard's props EXCEPT
  //                   `side` (the column owns it and overrides), e.g.
  //                   {player, playerColor, speaking, muted, dead, follow,
  //                   state, stats, icons, iconURLs, onToggleMute}; order
  //                   is the caller's (roster slot order by default)
  //   teamMuted       every player on the team voice-muted → the team
  //                   mute button's state
  //   onToggleTeamMute()  team mute click (caller applies setMutedMany
  //                   and re-derives each card's `muted`)
  //
  // Layout: the card stack carries a gutter (~10px past the card) as
  // padding so the player-color rings (box-shadow, 3px past the card)
  // paint fully inside the column instead of clipping at its edge, and a
  // 12px stack gap keeps a neighbour's ring from touching the next card;
  // when the parent gives the column a definite height the stack scrolls
  // instead of breaking the replay layout. scrollbar-gutter: stable
  // reserves the scrollbar's track up front, so a scrollbar
  // appearing/disappearing can never change the column's content width
  // (a rewrap cascade is exactly the card jitter this stack must not
  // have).
  import PlayerCard from './PlayerCard.svelte';

  let {
    teamName = '',
    side = '',
    players = [],
    teamMuted = false,
    onToggleTeamMute = () => {},
  } = $props();

  // Roster identity keys the each-block; a row without a steam id falls
  // back to its index (stable while the caller keeps roster order).
  const keyOf = (p, i) => (p && p.player && p.player.steamId ? p.player.steamId : i);
</script>

<div class="tc-col">
  <div class="tc-head">
    <span
      class="tc-name"
      class:side-ct={side === 'ct'}
      class:side-t={side === 't'}
      title={teamName}>{teamName}</span
    >
    <button
      type="button"
      class="btn small ghost tc-mute"
      class:warn={teamMuted}
      aria-pressed={teamMuted}
      aria-label="Mute {teamName} voice"
      title={teamMuted ? `Unmute ${teamName} voice` : `Mute ${teamName} voice`}
      onclick={onToggleTeamMute}
    ><span class="codicon {teamMuted ? 'codicon-mute' : 'codicon-unmute'}" aria-hidden="true"></span></button>
  </div>
  <div class="tc-cards">
    {#each players as p, i (keyOf(p, i))}
      <PlayerCard {...p} {side} />
    {/each}
  </div>
</div>

<style>
  /* tc- = TeamColumn's one prefix (AGENTS.md CSS rule). The team NAME
     takes the shared side classes (.side-ct/.side-t → --ct/--t) — the
     same vocabulary as the cards below it, so name and tint can never
     disagree. */
  .tc-col {
    display: flex;
    flex-direction: column;
    /* The ~200px card column from the spec (214px incl. gutters): a
       default width the parent may override (grid tracks stretch past
       it, flex rows shrink it) — never a hard floor. */
    width: 214px;
    min-width: 0;
    max-width: 240px;
    min-height: 0;
    max-height: 100%;
  }

  .tc-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 10px 4px;
  }

  .tc-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
    font-size: var(--fs-section);
  }

  .tc-mute {
    flex: none;
    padding: 0 5px;
    line-height: 1;
  }

  .tc-cards {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    gap: 12px;
    /* The gutter the player-color rings paint into (~10px past the
       card) — rings stay inside the column instead of clipping at its
       edge. Top padding keeps the first ring clear of the team name. */
    padding: 10px;
    overflow-y: auto;
    /* Reserve the scrollbar track whether or not it is showing: a
       scrollbar appearing mid-playback must not narrow the cards (a
       width change would rewrap their rows — the jitter the fixed card
       heights are there to prevent). */
    scrollbar-gutter: stable;
    min-height: 0;
  }
</style>
