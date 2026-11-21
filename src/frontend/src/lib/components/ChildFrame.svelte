<script>
  // ChildFrame — what a component's `<spectra.Child name={…} props={…} />`
  // mounts (dogfood/04-COMPONENTS.md §3.5, owner ruling 36). The child is a
  // ComponentFrame of its own: its failures show in its own frame, and the
  // parent keeps rendering. It inherits the parent frame's context (the
  // same read-only object) and reads through the parent's read services.
  //
  // `name` is a builtin id (builtin-…) or a user component's name. A name
  // that resolves to nothing shows a refusal in this slot, dismissible.
  import { getContext } from 'svelte';
  import * as S from '../strings/index.js';
  import { errText, listComponents } from '../services.js';
  import { builtinById, isBuiltinId } from '../componentbuiltins.js';
  import { FRAME_KEY, MAX_NEST_DEPTH } from '../componentruntime/frameContext.js';
  import ComponentFrame from './ComponentFrame.svelte';

  let { name = '', props = {} } = $props();

  // The parent frame: a child is always mounted by a component's frame.
  const parent = getContext(FRAME_KEY) || null;
  const tooDeep = parent != null && parent.depth + 1 > MAX_NEST_DEPTH;

  let source = $state(null);
  let resolved = $state(false);
  let failure = $state('');
  let dismissed = $state(false);

  async function resolveSource(n) {
    if (isBuiltinId(n)) {
      const b = builtinById(n);
      return b ? b.source : null;
    }
    const rows = (await listComponents()) || [];
    const hit = rows.find((c) => c && c.name === n);
    return hit ? hit.source : null;
  }

  // A new name is a new mount: resolve it again.
  $effect(() => {
    const n = name;
    let live = true;
    source = null;
    resolved = false;
    failure = '';
    dismissed = false;
    resolveSource(n).then(
      (src) => {
        if (live) {
          source = src;
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
{:else if source == null}
  <p class="error" role="alert">
    {S.fill(S.components.childNotFound, { name })}
    <button class="btn small" aria-label={S.components.frameDismiss} onclick={() => (dismissed = true)}>
      <span class="codicon codicon-close"></span>
    </button>
  </p>
{:else}
  <ComponentFrame
    {source}
    {props}
    {name}
    reads={parent.reads}
    nav={parent.nav}
    context={parent.context()}
  />
{/if}

<style>
  .cframe-loading {
    color: var(--muted);
  }
</style>
