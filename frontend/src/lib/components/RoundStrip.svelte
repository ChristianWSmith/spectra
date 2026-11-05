<script>
// Round progression strip: one cell per round, winner-tinted, click to
// open the round. `current` highlights the round being viewed
// (RoundDetail); 0 means "none" — round numbers are never 0, and knife /
// warmup rounds are negative.
//
// The two teams are labelled ABOVE and BELOW the cells in the scoreline's
// order (the team that finished CT on top, the team that finished T
// below); both labels are centered horizontally over the range of round
// buttons (the wrap hugs the strip — .round-strip-wrap / .round-strip-team
// in public/style.css) and colored by the side each team played in the
// FIRST half (the team-identity classes from lib/teams.js), while each
// cell points an arrow toward the team that WON that round — ▲ toward the
// team above, ▼ toward the team below — so the arrow
// follows the TEAM across the halftime side switch while the cell tint
// keeps following the SIDE. A marker splits the row after the 12th real
// round (the MR12 halftime).
import { sideAtRound } from '../sideparity.js';
import { teamStartClass } from '../teams.js';
import { isCounted } from '../rounds.js';
import { buildHash } from '../router.js';

let {
  rounds = [],
  current = 0,
  matchId = 0,
  teamAbove = '',
  teamBelow = '',
  sideSwitches = 0,
  back = '',
  nav = () => {},
} = $props();

// MR12: the first half is real rounds 1..12, so the split sits after the
// 12th real round (a match that never reaches 12 real rounds gets none).
const HALFTIME_AFTER = 12;

// Per-cell data: split marker + the side the team-above played in that
// round. Sides swap at every half, so each cell's side comes from the
// canonical side-parity helper shared with the backend (flip boundaries at
// floor((n*k + switches) / (switches + 1)) — see ../sideparity.js
// sideAtRound, which maps the round number through the counted rounds;
// the per-round name colors resolve through the same helper, so the strip
// and the names can never disagree).
const cells = $derived.by(() => {
  let seen = 0;
  return rounds.map((r) => {
    const isReal = isCounted(r);
    // The team above FINISHED CT, so its side in this round is the
    // canonical derivation (../sideparity.js sideAtRound → sideInEra —
    // the same one startSideFor feeds the team-identity name colors with).
    const aboveSide = sideAtRound(rounds, sideSwitches, r.number, 'ct');
    const after = isReal && ++seen === HALFTIME_AFTER;
    return { r, after, aboveSide };
  });
});
</script>

<div class="round-strip-wrap">
  {#if teamAbove}
    <!-- Label colors follow the FIRST-half side: both
         call sites (Match header, RoundDetail) pass teams.ct above and
         teams.t below — the teams' final sides — and teamStartClass
         flips them to their start sides. -->
    <div class="round-strip-team above {teamStartClass('ct', sideSwitches)}">{teamAbove}</div>
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
        onclick={() => nav(buildHash(`/match/${matchId}/round/${r.number}`, { back }))}
      >
        {r.number}
      </button>
      {#if after}
        <span class="round-split" aria-hidden="true"></span>
      {/if}
    {/each}
  </div>
  {#if teamBelow}
    <div class="round-strip-team below {teamStartClass('t', sideSwitches)}">{teamBelow}</div>
  {/if}
</div>
