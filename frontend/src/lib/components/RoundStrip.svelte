<script>
// Round progression strip: one cell per round, winner-tinted, click to
// open the round. `current` highlights the round being viewed
// (RoundDetail); 0 means "none" — round numbers are never 0, and knife /
// warmup rounds are negative.
//
// The two teams are labelled ABOVE and BELOW the cells in the scoreline's
// order (the team that finished CT on top, the team that finished T
// below). Each cell points an arrow toward the team that WON that round —
// ▲ toward the team above, ▼ toward the team below — so the arrow follows
// the TEAM across the halftime side switch while the cell tint keeps
// following the SIDE. A marker splits the row after the 12th real round
// (the MR12 halftime).
import { flipIndexes, eraOf } from '../sideparity.js';
import { isCounted } from '../rounds.js';

let {
  rounds = [],
  current = 0,
  matchId = 0,
  teamAbove = '',
  teamBelow = '',
  sideSwitches = 0,
  nav = () => {},
} = $props();

// MR12: the first half is real rounds 1..12, so the split sits after the
// 12th real round (a match that never reaches 12 real rounds gets none).
const HALFTIME_AFTER = 12;

// Per-cell data: split marker + the side the team-above played in that
// round. Sides swap at every half, so an era index is derived from the
// counted rounds (pre-match rounds sit in the first era) using the
// canonical side-parity helper shared with the backend (flip boundaries at
// floor((n*k + switches) / (switches + 1)) — see ../sideparity.js and
// internal/rules). Regulation MR12 is exact; overtime's short halves get
// their per-boundary split instead of one uniform era length.
const cells = $derived.by(() => {
  const eras = Math.max(1, sideSwitches + 1);
  const counted = rounds.filter(isCounted);
  const flips = flipIndexes(counted.length, sideSwitches);
  let seen = 0;
  return rounds.map((r) => {
    const isReal = isCounted(r);
    const era = isReal ? Math.min(eras - 1, eraOf(seen, flips)) : 0;
    // The team above finished CT, so it plays CT in the LAST era; each
    // earlier era flips it.
    const aboveSide = (eras - 1 - era) % 2 === 0 ? 'ct' : 't';
    const after = isReal && ++seen === HALFTIME_AFTER;
    return { r, after, aboveSide };
  });
});
</script>

<div class="round-strip-wrap">
  {#if teamAbove}
    <div class="round-strip-team above ct">{teamAbove}</div>
  {/if}
  <div class="round-strip" aria-label="Round progression">
    {#each cells as { r, after, aboveSide } (r.number)}
      <button
        class="round-cell"
        class:ct={r.winner === 'ct'}
        class:t={r.winner === 't'}
        class:warmup={r.warmup || r.pregame || r.winner === ''}
        class:current={current === r.number}
        class:point-up={r.winner !== '' && r.winner === aboveSide}
        class:point-down={r.winner !== '' && r.winner !== aboveSide}
        title={`Round ${r.number} — ${r.winner ? r.winner.toUpperCase() : '—'}${r.reason ? ' · ' + r.reason : ''}`}
        aria-label="Round {r.number}"
        aria-current={current === r.number ? 'true' : undefined}
        onclick={() => nav(`/match/${matchId}/round/${r.number}`)}
      >
        {r.number}
      </button>
      {#if after}
        <span class="round-split" aria-hidden="true"></span>
      {/if}
    {/each}
  </div>
  {#if teamBelow}
    <div class="round-strip-team below t">{teamBelow}</div>
  {/if}
</div>
