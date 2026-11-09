<script>
// Round progression strip: one cell per round, winner-tinted, click to
// open the round. `current` highlights the round being viewed
// (RoundDetail); 0 means "none" — round numbers are never 0, and knife /
// warmup rounds are negative (their cells show the canonical W/K display
// label from lib/rounds.js roundIndexLabel, never the raw index).
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
// dangling marker (the rule lives in ../rounds.js separatorAfter).
import { sideAtRound } from '../sideparity.js';
import { teamStartClass } from '../teams.js';
import { isCounted, roundIndexLabel, separatorAfter } from '../rounds.js';
import { buildHash } from '../router.js';
// Rounds visibility pref (key: show_knife_warmup_rounds, prefs.go).
// Read HERE rather than passed in, so both call sites obey the one
// setting — Match's header ribbon and RoundDetail's strip — without
// either host view wiring it up (Match.svelte reads the same key for its
// Rounds tab; see the comment there). Preference keys live in prefs.go
// and are read straight through the generated kvstore binding —
// services.js has no pref wrappers (Settings owns the writes). There is
// no cross-view change event, so the read happens on every mount —
// returning from Settings remounts the host view, which remounts this
// strip.
import { KVStoreService } from '../../../bindings/github.com/wailsapp/wails/v3/pkg/services/kvstore';

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

// false (the default) hides the warmup/knife cells. kvstore values
// round-trip as JSON — a bool stays a bool (Settings writes this key as a
// real boolean); anything else (unset, null, corrupt) falls back to
// false = hidden — the same coercion as Match.svelte's Rounds-tab read.
let showKnifeWarmup = $state(false);

$effect(() => {
  let live = true;
  KVStoreService.Get('show_knife_warmup_rounds')
    .then((v) => {
      if (live) showKnifeWarmup = v === true;
    })
    .catch(() => {
      // Unreadable store → conservative default: hidden.
      if (live) showKnifeWarmup = false;
    });
  return () => (live = false);
});

// Per-cell data: the separator marker after this cell (if any) + the
// side the team-above played in that round. Sides swap at every half,
// so each cell's side comes from the canonical side-parity helper
// shared with the backend (flip boundaries at
// floor((n*k + switches) / (switches + 1)) — see ../sideparity.js
// sideAtRound, which maps the round number through the counted rounds;
// the per-round name colors resolve through the same helper, so the strip
// and the names can never disagree).
const cells = $derived.by(() => {
  // Render filter behind the pref: warmup/knife cells drop out unless the
  // pref opts in, with ONE exception — the round being viewed stays, so
  // RoundDetail's `current` marker can still locate you on a knife /
  // warmup round page (current 0 = "none" never matches, so round-0 rows
  // can't sneak through either). The filter is for RENDERING only:
  // sideAtRound below still receives the FULL rounds array, so side
  // parity can never depend on this pref (sideAtRound counts counted
  // rounds itself — see ../sideparity.js).
  const visible = showKnifeWarmup
    ? rounds
    : rounds.filter((r) => isCounted(r) || (current !== 0 && r.number === current));
  // Trailing-marker suppression: a separator renders only when at least
  // one MORE counted round follows it — a match ending exactly on a
  // boundary cell (12, 24, 27, …) gets no dangling marker after its
  // last cell. Negative (knife/warmup) cells never increment the
  // counter, so they can never shift a marker's position; the boundary
  // rule itself is ../rounds.js separatorAfter (the ONE separator rule).
  const countedTotal = visible.filter(isCounted).length;
  let seen = 0;
  return visible.map((r) => {
    const isReal = isCounted(r);
    // The team above FINISHED CT, so its side in this round is the
    // canonical derivation (../sideparity.js sideAtRound → sideInEra —
    // the same one startSideFor feeds the team-identity name colors with).
    const aboveSide = sideAtRound(rounds, sideSwitches, r.number, 'ct');
    const after = isReal && ++seen < countedTotal && separatorAfter(seen);
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
        class:warmup={r.warmup || r.pregame || r.winner === ''}
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
