<script>
  // ChildFrame — a named component mounted in a frame (dogfood/04-COMPONENTS.md
  // §3.5, owner ruling 36). Inside a component, `<spectra.Child>` mounts a
  // child: its own frame, its failures in its own frame, the parent's context
  // and read services inherited. At a surface (no parent frame, see
  // SurfaceView) it takes the surface's `context` and `nav` directly.
  //
  // `name` is a builtin id (builtin-…) or a user component's name; the
  // reference resolves through componentruntime/resolve.js, so an edited
  // builtin mounts its edit wherever it is mounted. A name that resolves to
  // nothing shows a refusal in this slot, dismissible.
  import { getContext } from 'svelte';
  import * as S from '../strings/index.js';
  import { errText } from '../services.js';
  import { resolveComponentRef } from '../componentruntime/resolve.js';
  import { FRAME_KEY, MAX_NEST_DEPTH } from '../componentruntime/frameContext.js';
  import ComponentFrame from './ComponentFrame.svelte';

  let { name = '', props = {}, context = null, nav = undefined } = $props();

  // The parent frame: null at a surface, set inside a component.
  const parent = getContext(FRAME_KEY) || null;
  const tooDeep = parent != null && parent.depth + 1 > MAX_NEST_DEPTH;

  // What the frame mounts: a compiled builtin panel (`component`), or a
  // source to compile (`source`: an edited builtin, a text builtin or a user
  // component).
  let source = $state(null);
  let component = $state(null);
  let builtinDir = $state(null); // a built-in's source directory (null for yours)
  let resolved = $state(false);
  let failure = $state('');
  let dismissed = $state(false);

  // A new name is a new mount: resolve it again.
  $effect(() => {
    const n = name;
    let live = true;
    source = null;
    component = null;
    resolved = false;
    failure = '';
    dismissed = false;
    resolveComponentRef(n).then(
      (hit) => {
        if (live) {
          source = hit ? hit.source : null;
          component = hit ? hit.component : null;
          builtinDir = hit ? hit.dir : null;
          resolved = true;
        }
      },
      (e) => {
        if (live) {
          failure = errText(e);
          resolved = true;
        }
      },
    );
    return () => {
      live = false;
    };
  });
</script>

{#if dismissed}
  <!-- dismissed: the slot stays empty until a new mount -->
{:else if tooDeep}
  <p class="error" role="alert">
    {S.fill(S.components.childDepth, { depth: MAX_NEST_DEPTH })}
    <button class="btn small" aria-label={S.components.frameDismiss} onclick={() => (dismissed = true)}>
      <span class="codicon codicon-close"></span>
    </button>
  </p>
{:else if failure}
  <p class="error" role="alert">
    {S.fill(S.components.frameFailed, { err: failure })}
    <button class="btn small" aria-label={S.components.frameDismiss} onclick={() => (dismissed = true)}>
      <span class="codicon codicon-close"></span>
    </button>
  </p>
{:else if !resolved}
  <p class="cframe-loading">{S.components.frameLoading}</p>
{:else if source == null && component == null}
  <p class="error" role="alert">
    {S.fill(S.components.childNotFound, { name })}
    <button class="btn small" aria-label={S.components.frameDismiss} onclick={() => (dismissed = true)}>
      <span class="codicon codicon-close"></span>
    </button>
  </p>
{:else}
  <ComponentFrame
    {source}
    {component}
    {builtinDir}
    {props}
    {name}
    reads={parent ? parent.reads : null}
    nav={parent ? parent.nav : nav}
    context={parent ? parent.context() : context}
  />
{/if}

<style>
  .cframe-loading {
    color: var(--muted);
  }
</style>
