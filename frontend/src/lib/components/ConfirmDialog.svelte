<script>
  // The one confirmation modal — the replacement for window.confirm(),
  // whose dialog title is the page title ("JavaScript -
  // wails://localhost/#/library"). Built on Dialog.svelte, so it gets the
  // app's backdrop/panel, focus restore and Escape dismissal for free.
  //
  // Imperative usage (the same pattern as MapPackPrompt.maybePrompt):
  //   let confirm;  …  <ConfirmDialog bind:this={confirm} />
  //   if (!(await confirm?.ask({ title, message, confirmLabel }))) return;
  // The promise resolves true for the confirm button and false for
  // Cancel, Escape, a backdrop click or a superseding ask — dismissal is
  // always cancel, never confirm.
  import Dialog from './Dialog.svelte';

  let open = $state(false);
  let title = $state('');
  let message = $state('');
  let confirmLabel = $state('Confirm');
  let danger = $state(true); // destructive confirm → .btn danger, else .btn primary
  let settle = null; // resolve of the pending ask()

  // ask opens the prompt and returns its answer as a promise. A second
  // ask while one is open cancels the first (its promise resolves false)
  // — prompts never stack.
  export function ask({ title: t, message: m, confirmLabel: c = 'Confirm', danger: d = true } = {}) {
    if (settle) settle(false);
    title = t;
    message = m;
    confirmLabel = c;
    danger = d;
    return new Promise((resolve) => {
      settle = resolve;
      open = true;
    });
  }

  function done(result) {
    open = false;
    const resolve = settle;
    settle = null;
    if (resolve) resolve(result);
  }

  // Enter confirms while focus sits on the dialog panel itself (on a
  // button the browser already activates it natively, so BUTTON targets
  // are left alone). Scoped to the open dialog: mounted on open, removed
  // on close.
  $effect(() => {
    if (!open) return;
    const onKey = (e) => {
      const tag = e.target && e.target.tagName;
      if (e.key === 'Enter' && tag && tag !== 'BUTTON') {
        e.preventDefault();
        done(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });
</script>

<Dialog open={open} label={title} panelClass="cf-prompt" onClose={() => done(false)}>
  <div class="cf-body">
    <h2 class="cf-title">{title}</h2>
    <p class="muted cf-msg">{message}</p>
    <div class="toolbar cf-actions">
      <span class="spacer"></span>
      <button class="btn" onclick={() => done(false)}>Cancel</button>
      <button class="btn {danger ? 'danger' : 'primary'}" onclick={() => done(true)}>
        {confirmLabel}
      </button>
    </div>
  </div>
</Dialog>

<style>
  /* The panel element belongs to Dialog.svelte, so the confirm's size has
     to reach it through a global selector (cf- = ConfirmDialog). */
  :global(.dlg-panel.cf-prompt) {
    width: min(440px, 94vw);
    padding: 18px 20px;
  }
  .cf-title {
    margin: 0 0 8px;
    font-size: 1.1em;
  }
  .cf-msg {
    margin: 0;
    line-height: 1.45;
  }
  .cf-actions {
    margin-top: 16px;
  }
  .cf-actions .spacer {
    flex: 1;
  }
</style>
