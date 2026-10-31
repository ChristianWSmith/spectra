<script>
// Round progression strip: one cell per round, winner-tinted, click to
// open the round. current highlights the round being viewed (RoundDetail).
let { rounds = [], current = -1, matchId = 0, nav = () => {} } = $props();
</script>

<div class="round-strip" aria-label="Round progression">
  {#each rounds as r (r.number)}
    <button
      class="round-cell"
      class:ct={r.winner === 'ct'}
      class:t={r.winner === 't'}
      class:warmup={r.warmup || r.winner === ''}
      class:current={current === r.number}
      title={`Round ${r.number} — ${r.winner ? r.winner.toUpperCase() : '—'}${r.reason ? ' · ' + r.reason : ''}`}
      aria-label="Round {r.number}"
      aria-current={current === r.number ? 'true' : undefined}
      onclick={() => nav(`/match/${matchId}/round/${r.number}`)}
    >
      {r.number}
    </button>
  {/each}
</div>
