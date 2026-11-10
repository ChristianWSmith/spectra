<script>
  // Test harness for StatCard: one clickable cell whose sub line carries a
  // ProfileLink — drill and profile navigation recorded globally.
  import StatCard from './components/StatCard.js';
  import ProfileLink from './components/ProfileLink.js';

  globalThis.__nav = [];
  globalThis.__drill = 0;
  const nav = (hash) => globalThis.__nav.push(hash);
</script>

<div id="slot">
  <StatCard
    label="Top fragger"
    value="20/10/3"
    sub="donk"
    subCls="team-start-t"
    title="Open Replay events filtered to donk"
    onclick={() => globalThis.__drill++}
  >
    {#snippet subSlot()}
      <ProfileLink
        steam="76561198012345678"
        name="donk"
        {nav}
        cls="team-start-t"
        title="Open donk profile"
      />
    {/snippet}
  </StatCard>
</div>
