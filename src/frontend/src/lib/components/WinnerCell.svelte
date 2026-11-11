<script>
  // Winner cell — the shared "who won this round" chip for the match
  // details tables (Match's Rounds tab, Economy's buy-types table). The
  // markup is the EXISTING side chip (`.chip.side {winner}` — already
  // side-colored by public/style.css); only the TEXT differs: the
  // resolved TEAM name when the caller could resolve one, otherwise the
  // bare side label exactly as before.
  //
  // Resolution happens in the CALLER through the canonical helper
  // (../sideparity.js winnerTeamKey → lib/teams.js teamNames), because
  // only the caller holds the match's rounds, side switches and name map.
  // This component deliberately does no parity arithmetic: an empty
  // `name` (unknown winner side, unresolved round) falls back to the
  // bare chip — never a guessed team name.
  //
  //   name    — resolved team display name ('' → fall back to the side)
  //   winner  — 'ct' | 't' | '' (the round's winner side, for the chip
  //             color/class; '' → the neutral 'none' chip with '—')
  //   title   — optional hover title on the chip
  let { name = '', winner = '', title = undefined } = $props();
</script>

<span class="chip side {winner || 'none'}" {title}>
  {name || (winner ? winner.toUpperCase() : '—')}
</span>
