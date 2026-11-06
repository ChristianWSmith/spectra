<script>
  // Test harness for PlayerCard / TeamColumn: fixture props come from
  // globals the driver sets per scenario (each scenario re-mounts into a
  // fresh target, exactly like the round-strip harness).
  import PlayerCard from './components/PlayerCard.js';
  import TeamColumn from './components/TeamColumn.js';

  const card = globalThis.__card;
  const team = globalThis.__team;
</script>

{#if card}
  <PlayerCard {...card} />
{/if}
{#if team}
  <TeamColumn {...team} />
{/if}
