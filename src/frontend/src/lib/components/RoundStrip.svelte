<script>
// Round progression strip: one cell per round, winner-tinted, click to
// open the round. `current` highlights the round being viewed
// (RoundDetail); 0 means "none" — round numbers are never 0. Every
// STORED round is counted play (the extractor discards knife/warmup
// rounds at ingest), so all cells render; a legacy pre-reprocess row
// with a negative index still shows the canonical W/K display label from
// lib/rounds.js roundIndexLabel, never the raw index.
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
// keeps following the SIDE. Separators split the row after counted round
// 12 (the MR12 halftime), after 24 (the regulation/OT boundary) and
// every 3 OT rounds after that (27, 30, 33, …) — and only while another
// counted round follows, so a match ending on a boundary cell gets no
// dangling marker (the gating lives in ../rounds.js separatorFlags).
import { sideAtRound } from '../sideparity.js';
import { teamStartClass } from '../teams.js';
import { roundIndexLabel, separatorFlags } from '../rounds.js';
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
  // Optional IN-PLACE round picker (Replay's round ribbon): when set, a
  // cell click calls onselect(r.number) instead of navigating to the
  // round page — the host decides what "open round N" means there (a
  // seek, a filter, …). Null (Match header, RoundDetail) keeps the
  // canonical nav(buildHash('/match/…/round/…')) behavior.
  onselect = null,
} = $props();

// Per-cell data: the separator marker after this cell (if any) + the
// side the team-above played in that round. Sides swap at every half,
// so each cell's side comes from the canonical side-parity helper
// shared with the backend (flip boundaries on the CS2 cadence: after
// counted round 12, no switch at OT start, then 27 and every 3 rounds —
// see ../sideparity.js sideAtRound, which maps the round number through
// the counted rounds; the per-round name colors resolve through the same
// helper, so the strip and the names can never disagree). The separator
// flags come from the canonical gating helper (../rounds.js
// separatorFlags — cadence + counted-gating + trailing suppression).
const cells = $derived.by(() => {
  // Every STORED row renders — the extractor discards knife/warmup
  // rounds at ingest, so there is no visibility pref to read and no
  // render filter to apply (a legacy pre-reprocess row with a negative
  // index renders as a W/K cell below, never hidden half-state).
  // Separator gating over this rendered list — the ONE rule lives in
  // ../rounds.js separatorFlags (counted-gating keeps a legacy negative
  // row from shifting a marker's position, trailing suppression drops
  // the marker after the last counted row).
  const flags = separatorFlags(rounds);
  return rounds.map((r, i) => {
    // The team above FINISHED CT, so its side in this round is the
    // canonical derivation (../sideparity.js sideAtRound → sideInEra —
    // the same one startSideFor feeds the team-identity name colors with).
    const aboveSide = sideAtRound(rounds, sideSwitches, r.number, 'ct');
    const after = flags[i];
    // Display label from the ONE canonical formatter (../rounds.js
    // roundIndexLabel): counted rounds show their number, negative ingest
    // indices show "K" (knife) / "W" (warmup).
    const label = roundIndexLabel(r);
    // The cell's readable name for title/aria — "Round 12" vs "Warmup
    // round" / "Knife round" — decided by the label letters, never a
    // second formatter.
    const kind =
      label === 'K' ? 'Knife round' : label === 'W' ? 'Warmup round' : `Round ${label}`;
    return { r, after, aboveSide, label, kind };
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
    {#each cells as { r, after, aboveSide, label, kind } (r.number)}
      <button
        class="round-cell"
        class:ct={r.winner === 'ct'}
        class:t={r.winner === 't'}
        class:warmup={r.winner === ''}
        class:current={current === r.number}
        class:point-up={r.winner !== '' && r.winner === aboveSide}
        class:point-down={r.winner !== '' && r.winner !== aboveSide}
        title={`${kind} — ${r.winner ? r.winner.toUpperCase() : '—'}${r.reason ? ' · ' + r.reason : ''}`}
        aria-label={kind}
        aria-current={current === r.number ? 'true' : undefined}
        onclick={() =>
          onselect
            ? onselect(r.number)
            : nav(buildHash(`/match/${matchId}/round/${r.number}`, { back }))}
      >
        {label}
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
