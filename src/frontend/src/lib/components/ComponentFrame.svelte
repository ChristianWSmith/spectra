<script>
  import StatusChip from './StatusChip.svelte';
  // ComponentFrame — the frame every mounted component sits in
  // one failing component shows a
  // dismissible error inside its own frame and the rest of the surface
  // keeps rendering.
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
  import { rememberHeight, recalledHeight } from '../componentruntime/sizememory.js';
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
  // What the nested frames below this one inherit (see ChildFrame).
  // svelte-ignore state_referenced_locally
  setContext(FRAME_KEY, {
    reads: reads || serviceReads,
    nav,
    depth,
    context: () => ctx,
    // A nested frame registers here on mount and leaves on unmount.
    adopt: (delta) => untrack(() => (childCount += delta)),
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
  // Reads in flight for this frame. A builtin shows its throbber over its
  // content while they run (spectra.busy), so a swap of data keeps the space
  // and hides the old values until the new ones arrive.
  let pending = $state(0);
  // Reads this frame has started, and nested frames mounted in it. A pure composer
  // (nested frames, no reads of its own) never shows the busy state: its children
  // show their own.
  let readCount = $state(0);
  let childCount = $state(0);
  const isComposer = $derived(childCount > 0 && readCount === 0);
  const busy = $derived(pending > 0 && !isComposer);

  $effect(() => {
    if (!parent) return;
    parent.adopt(1);
    return () => parent.adopt(-1);
  });
  // untrack: a read started inside an effect must not make that effect depend on
  // the counter it moves.
  const tracked = (read) => (...args) => {
    untrack(() => {
      pending++;
      readCount++;
    });
    return read(...args).finally(() => {
      untrack(() => pending--);
    });
  };
  const trackedLoad = (promise) => {
    untrack(() => {
      pending++;
      readCount++;
    });
    return promise.finally(() => {
      untrack(() => pending--);
    });
  };
  // The `spectra` value a component receives: the read API plus the
  // nested mount component, and whether a read is in flight.
  const spectra = Object.freeze({
    ...api,
    metric: tracked(api.metric),
    query: tracked(api.query),
    metricsByMatch: tracked(api.metricsByMatch),
    // track(promise): a load the component runs through its own services counts
    // as a read in flight, the same as spectra.metric/query.
    track: trackedLoad,
    get busy() {
      return pending > 0;
    },
    Child: ChildFrame,
  });

  $effect(() => (el ? attachFrame(el, report) : undefined));

  // The component's root: the first element the component renders (an error
  // line the frame shows above it is skipped). The frame owns the busy state on
  // it: the .builtin-busy class and aria-busy while reads are in flight, and the
  // height held at the last remembered render (componentruntime/sizememory.js).
  const frameRoot = () => {
    if (!el || !Comp) return null;
    return [...el.children].find((e) => !e.matches('p.error')) ?? null;
  };
  $effect(() => {
    void Comp;
    const root = frameRoot();
    if (!root) return;
    const on = busy;
    root.classList.toggle('builtin-busy', on);
    root.setAttribute('aria-busy', String(on));
    const h = on ? recalledHeight(name) : null;
    root.style.minHeight = h ? h + 'px' : '';
    return () => {
      root.classList.remove('builtin-busy');
      root.removeAttribute('aria-busy');
      root.style.minHeight = '';
    };
  });
  $effect(() => {
    void Comp;
    const root = frameRoot();
    if (!root || !name || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (!busy) rememberHeight(name, root.offsetHeight);
    });
    ro.observe(root);
    return () => ro.disconnect();
  });

  // A new source (or component) is a new mount: earlier failures go.
  $effect(() => {
    const src = source;
    void component;
    dismissed = false;
    routed = '';
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
    <p class="muted" role="status"><StatusChip block /></p>
  {:else}
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
  {/if}
</div>

<style>
  .cframe {
    display: contents;
  }
</style>
