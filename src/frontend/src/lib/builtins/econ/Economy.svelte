<script>
  import { economySource } from '../../economysource.svelte.js';
  import * as S from '../../strings/index.js';
  // Economy view: the rounds, the economy rows and the team names, loaded once
  // for the three panels below. Each panel mounts with this frame's context
  // (the match) and the Match view's back path.
  let { spectra, context, back = '' } = $props();
  // The composer loads the match's economy once for the three panels below. An empty set
  // shows until it lands: the panels mount with it and reserve their space while it loads.
  const src = economySource(() => ({ spectra, context, given: {} }));
  const view = $derived({ rows: src.rows, rounds: src.rounds, names: src.names, sideSwitches: src.sideSwitches, matchWinner: src.matchWinner });
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
