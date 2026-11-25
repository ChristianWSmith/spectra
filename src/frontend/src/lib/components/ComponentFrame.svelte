<script>
  import { createLoadState } from '../loadstate.svelte.js';
  import { liveMetrics } from '../metricslive.svelte.js';
  import { readMetrics } from '../metricreads.js';
  import { metricPresentation } from '../metricstate.js';
  import { fmtMetric, fmtDate, fmtDuration } from '../fmt.js';
  import { activateOnKey } from '../keys.js';
  import { whileCurrent, loadForMatch } from '../current.js';
  import { DASH, openMatch, openPlayer, followPlayer } from '../builtinhelpers.js';
  import ErrorBanner from './ErrorBanner.svelte';
  import EmptyNote from './EmptyNote.svelte';
  import EmptyTableRow from './EmptyTableRow.svelte';
  import MetricCell from './MetricCell.svelte';
  import RetryButton from './RetryButton.svelte';
  import WinnerCell from './WinnerCell.svelte';
  import StatCard from './StatCard.svelte';
  import StatusChip from './StatusChip.svelte';
  // ComponentFrame — the frame every mounted component sits in
  // A failing component shows a dismissible error inside its own frame, and the
  // rest of the surface keeps rendering.
  //
  // What reaches the frame:
  //   render / $effect errors   <svelte:boundary> → the failed snippet
  //                             replaces the component; Try again
  //                             re-renders it, Dismiss empties the slot
  //   event-handler errors      componentruntime/eventerrors.js
  //   read API failures, guard  componentruntime/readapi.js
  //                             → the banner above the still-running
  //                             component; Dismiss hides the banner
  //   source refusals           compile.js (line + message) → in the slot
  //   a missing component       `name` given, no component, no source
  // Every error shown is dismissible in place (PRODUCT.md Defaults).
  //
  // Exactly one of `component` (a builtin: app source the bundler already
  // compiled) or `source` (a user component: compiled lazily here, the
  // compiler loaded on first use) is given. `props` are the component's
  // own; the read API rides beside them as the reserved `spectra` prop.
  //
  // `context` (04 §3, ruling 34) is the surface's read-only context
  // { matchId, steamId, round }. It reaches the component as the `context`
  // prop, frozen, and the read API's binds default from it. A component
  // that does not read it ignores it.
  //
  // Nested mount (04 §3.5, ruling 36): `spectra.Child` mounts a child
  // component inside this frame (components/ChildFrame.svelte), which gets
  // this frame's context and its own frame for its own failures.
  import { getContext, setContext, untrack } from 'svelte';
  import * as S from '../strings/index.js';
  import { errText } from '../services.js';
  import { loadComponent } from '../componentruntime/compile.js';
  import { createReadApi } from '../componentruntime/readapi.js';
  import LoadBox from './LoadBox.svelte';
  import { serviceReads } from '../componentruntime/reads.js';
  import { attachFrame } from '../componentruntime/eventerrors.js';
  import { FRAME_KEY, frozenContext } from '../componentruntime/frameContext.js';
  import ChildFrame from './ChildFrame.svelte';

  let {
    component = null,
    source = null,
    name = '',
    props = {},
    reads = null,
    nav = undefined,
    context = null,
    builtinDir = null,
  } = $props();

  const ctx = $derived(frozenContext(context));
  // The frames above this one (null at the top of a surface).
  const parent = getContext(FRAME_KEY) || null;
  const depth = parent ? parent.depth + 1 : 0;
  // A child panel follows its parent's data: while the parent loads, it holds its space and spins too.
  const parentLoading = () => (parent ? parent.loading() : false);
  // What the nested frames below this one inherit (see ChildFrame).
  // svelte-ignore state_referenced_locally
  setContext(FRAME_KEY, {
    reads: reads || serviceReads,
    nav,
    depth,
    context: () => ctx,
    // A nested frame registers here on mount and leaves on unmount.
    adopt: (delta) => untrack(() => (childCount += delta)),
    // This frame's own reads, and its parent's: what the nested panels show is loading with it.
    loading: () => load.busy || parentLoading(),
  });

  let el = $state(null);
  let routed = $state(''); // banner: handler / async / read failures
  let dismissed = $state(false); // the slot's own failure was dismissed
  let loaded = $state(null); // the compiled user component
  let loadError = $state('');

  const report = (e) => {
    routed = errText(e);
  };
  // One read API per mounted frame (its failures belong to this frame).
  // svelte-ignore state_referenced_locally
  const api = createReadApi({ reads: reads || serviceReads, report, nav, context: () => ctx });
  // Reads in flight for this frame. While they run, the panel holds its space under its spinner
  // (spectra.busy), and the old values stay hidden until the new ones arrive.
  const load = createLoadState();
  // Reads this frame has started, and nested frames mounted in it (the layout class reads childCount).
  let readCount = $state(0);
  let childCount = $state(0);
  // The frame is busy while its own reads run, or its parent's do. Only a box that holds no boxes
  // shows it (LoadBox): a container of panels leaves the hider and spinner to the panels inside.
  const busy = $derived(load.busy || parentLoading());
  // What the panel shows, by identity: a new match or player is new content (its own held height).
  const contentKey = $derived(
    [ctx.matchId, ctx.steamId, ctx.round].map((v) => (v == null ? '' : String(v))).join('|'),
  );

  $effect(() => {
    if (!parent) return;
    parent.adopt(1);
    return () => parent.adopt(-1);
  });
  // untrack: a read started inside an effect must not make that effect depend on
  // the counter it moves.
  // A read belongs to the content it asks for (this frame’s context): a refresh of that content is
  // not busy, a new context is.
  const tracked = (read) => (...args) => {
    untrack(() => readCount++);
    return load.track(read(...args), contentKey);
  };
  const trackedLoad = (promise) => {
    untrack(() => readCount++);
    return load.track(promise, contentKey);
  };
  // The `spectra` value a component receives: the read API plus the
  // nested mount component, and whether a read is in flight.
  // liveMetrics: the progress and reload wiring a panel mounts (metricslive.svelte.js).
  const spectra = Object.freeze({
    ...api,
    liveMetrics,
    // The shared helpers a component may use (the same modules the builtins import):
    // readMetrics for several reads, metricPresentation for a cell's value, dash
    // or state, fmtMetric for a stored value's text, activateOnKey for a clickable
    // row's keyboard, whileCurrent for a load that must not apply late.
    // readMetrics(names): several stored reads at once, a failed one its own
    // state. Bound here to this frame's read API and error text, so a component
    // never passes them.
    readMetrics: (names) => readMetrics(spectra, names, errText),
    metricPresentation,
    fmtMetric,
    activateOnKey,
    whileCurrent,
    // The one dash a missing cell shows, and the shared display pieces (the same
    // components the builtins use): <spectra.ui.ErrorBanner>…</spectra.ui.ErrorBanner>.
    dash: DASH,
    ui: { ErrorBanner, EmptyNote, EmptyTableRow, LoadBox, MetricCell, RetryButton, WinnerCell, StatCard, StatusChip },
    // Navigation and formatting the built-ins share: openMatch(id) and openPlayer(steamId) open a view
    // (through this frame's navigate); the formatters are the ones the built-ins use.
    openMatch: (matchId) => openMatch(spectra, matchId),
    openPlayer: (steamId) => openPlayer(spectra, steamId),
    // followPlayer(steamId, back?): the replay of the context's match, following this player. `back`
    // is the route the replay returns to; without it the replay returns to the match.
    followPlayer: (steamId, back = '') => followPlayer(spectra, ctx.matchId, back, steamId),
    // report(error): shows a failure in this frame's banner (a failed load a panel has no banner for).
    report: (e) => report(e),
    // loadForMatch(getMatchId, load, apply, failed?): the effect body of a load for the match, applied
    // only while current. A failure goes to the frame banner unless `failed` takes it.
    loadForMatch: (getMatchId, load, apply, failed = (e) => report(e)) => loadForMatch(getMatchId, load, apply, failed),
    fmtDate,
    fmtDuration,
    metric: tracked(api.metric),
    query: tracked(api.query),
    metricsByMatch: tracked(api.metricsByMatch),
    // track(promise): a load the component runs through its own services counts
    // as a read in flight, the same as spectra.metric/query.
    track: trackedLoad,
    get busy() {
      return load.busy;
    },
    Child: ChildFrame,
  });

  $effect(() => (el ? attachFrame(el, report) : undefined));

  // A new source (or component) is a new mount: earlier failures go. The first run is the
  // mount itself, which a child may already have reported into (spectra.report in its own
  // mount effect runs first), so the first run keeps the banner.
  let sourceArmed = false;
  $effect(() => {
    const src = source;
    void component;
    dismissed = false;
    if (sourceArmed) routed = '';
    sourceArmed = true;
    loaded = null;
    loadError = '';
    if (src == null) return;
    let live = true;
    loadComponent(src, 'Component.svelte', builtinDir).then(
      (c) => {
        if (live) loaded = c;
      },
      (e) => {
        if (live) loadError = errText(e);
      },
    );
    return () => {
      live = false;
    };
  });

  const Comp = $derived(component || loaded);
  const missing = $derived(!component && source == null);
</script>

<div class="cframe" bind:this={el}>
  {#if routed}
    <p class="error" role="alert">
      {S.fill(S.components.frameFailed, { err: routed })}
      <button class="btn small" aria-label={S.components.frameDismiss} onclick={() => (routed = '')}>
        <span class="codicon codicon-close"></span>
      </button>
    </p>
  {/if}
  {#if dismissed}
    <!-- dismissed: the slot stays empty until a new mount -->
  {:else if missing}
    <p class="error" role="alert">
      {S.fill(S.components.frameMissing, { name })}
      <button class="btn small" aria-label={S.components.frameDismiss} onclick={() => (dismissed = true)}>
        <span class="codicon codicon-close"></span>
      </button>
    </p>
  {:else if loadError}
    <p class="error" role="alert">
      {S.fill(S.components.frameFailed, { err: loadError })}
      <button class="btn small" aria-label={S.components.frameDismiss} onclick={() => (dismissed = true)}>
        <span class="codicon codicon-close"></span>
      </button>
    </p>
  {:else if !Comp}
    <!-- Compiling: the placeholder holds the component's remembered height (its whole block, a composer's
         panels included), with the spinner over it, so the real content replaces it in the same space. -->
    <LoadBox tag="section" class="panel frame-panel" busy name={name} key=""></LoadBox>
  {:else}
    <LoadBox tag="section" class={'panel frame-panel' + (childCount > 0 ? ' frame-composer' : '')} busy={busy} name={name} key={contentKey}>
      <svelte:boundary>
        <Comp {...props} {spectra} context={ctx} />
        {#snippet failed(error, reset)}
          <p class="error" role="alert">
            {S.fill(S.components.frameFailed, { err: errText(error) })}
            <button class="btn small" onclick={reset}>{S.components.frameRetry}</button>
            <button class="btn small" aria-label={S.components.frameDismiss} onclick={() => (dismissed = true)}>
              <span class="codicon codicon-close"></span>
            </button>
          </p>
        {/snippet}
      </svelte:boundary>
    </LoadBox>
  {/if}
</div>

<style>
  .cframe {
    display: contents;
  }
</style>
