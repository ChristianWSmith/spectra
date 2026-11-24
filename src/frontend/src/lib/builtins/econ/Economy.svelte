<script>
  import * as S from '../../strings/index.js';
  import { loadEconomy } from '../../builtinhelpers.js';
  // Economy view: the rounds, the economy rows and the team names, loaded once
  // for the three panels below. Each panel mounts with this frame's context
  // (the match) and the Match view's back path.
  let { spectra, context, back = '' } = $props();
  let state = $state(null);
  // Empty until the data lands: the panels mount with it and reserve their space while it loads.
  const view = $derived(state ?? { rows: [], rounds: [], names: { ct: S.match.sideCt, t: S.match.sideT }, sideSwitches: 0, matchWinner: '' });

  const load = (matchId) => loadEconomy(spectra, matchId);

  $effect(() => {
    const matchId = context.matchId;
    let live = true;
    load(matchId).then(
      (d) => {
        if (live) state = d;
      },
      () => {
        // A failed read is reported into this frame by the read API; the view
        // stays up on an empty set, as before (the banner names the failure).
        if (live) state = { rows: [], rounds: [], names: { ct: S.match.sideCt, t: S.match.sideT }, sideSwitches: 0, matchWinner: '' };
      },
    );
    return () => {
      live = false;
    };
  });
</script>

<div class="view econ-view">
      <div class="econ-head">
        <span class="muted">{view.rows.length}{view.rows.length === 1 ? ' round' : ' rounds'}</span>
        <span class="spacer"></span>
        <span class="muted econ-head-note">{S.economy.headNote}</span>
      </div>

      <spectra.Child name="match-economy-curve" props={{ rows: view.rows, names: view.names, sideSwitches: view.sideSwitches, matchWinner: view.matchWinner, back }} />
      <spectra.Child name="match-economy-cards" props={{ rows: view.rows, rounds: view.rounds, names: view.names, back }} />
      <spectra.Child name="match-economy-rounds" props={{ rows: view.rows, rounds: view.rounds, names: view.names, sideSwitches: view.sideSwitches, back }} />

</div>

<style>
  /* A tab root sits in a display: contents frame, so it is a flex item of the
     Match view's column, where the shared .view auto margins would shrink it to
     its content. Full width, like the other tabs. */
  .econ-view {
    margin-inline: 0;
  }
</style>
