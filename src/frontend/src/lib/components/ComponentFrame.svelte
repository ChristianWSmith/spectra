<script>
  // ComponentFrame — the frame every mounted component sits in
  // (dogfood/04-COMPONENTS.md §4): one failing component shows a
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
  import * as S from '../strings/index.js';
  import { errText } from '../services.js';
  import { loadComponent } from '../componentruntime/compile.js';
  import { createReadApi } from '../componentruntime/readapi.js';
  import { serviceReads } from '../componentruntime/reads.js';
  import { attachFrame } from '../componentruntime/eventerrors.js';

  let { component = null, source = null, name = '', props = {}, reads = null, nav = undefined } = $props();

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
  const api = createReadApi({ reads: reads || serviceReads, report, nav });

  $effect(() => (el ? attachFrame(el, report) : undefined));

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
    loadComponent(src).then(
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
    <p class="cframe-loading">{S.components.frameLoading}</p>
  {:else}
    <svelte:boundary>
      <Comp {...props} spectra={api} />
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
  .cframe-loading {
    color: var(--muted);
  }
</style>
