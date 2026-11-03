<script>
  // Modal dialog: fixed backdrop + panel with role="dialog"/aria-modal.
  // Dismissal: Escape while focus is inside, and a click that lands on the
  // bare backdrop — both gated by `dismissable` (MapPackPrompt passes
  // false while extracting). Focus moves into the panel on open and
  // returns to whatever held it before on close.
  //
  // Variants are Dialog-owned classes passed by name:
  //   backClass="top"   — panel hangs under the top edge instead of centred
  //   panelClass="wide" — modal-width scrolling body (KAST grid), or a
  //                       component's own prefix class for its panel size.
  let {
    open = false,
    label = '',
    backClass = '',
    panelClass = '',
    dismissable = true,
    onClose = () => {},
    children,
  } = $props();

  let panelEl = $state(null);
  let restoreTo = null;

  $effect(() => {
    if (!open) return;
    restoreTo = document.activeElement;
    const panel = panelEl;
    if (panel) panel.focus();
    return () => {
      const prev = restoreTo;
      restoreTo = null;
      // Only hand focus back if it was lost with the dialog — never yank
      // it away from somewhere the user moved it to in the meantime.
      if (
        prev &&
        prev !== document.body &&
        prev !== document.documentElement &&
        typeof prev.focus === 'function' &&
        prev !== document.activeElement
      ) {
        prev.focus();
      }
    };
  });

  function dismiss() {
    if (dismissable) onClose();
  }

  function onBackdropKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      dismiss();
    }
  }
</script>

{#if open}
  <div
    class="dlg-back{backClass ? ' ' + backClass : ''}"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) dismiss();
    }}
    onkeydown={onBackdropKey}
  >
    <div
      class="dlg-panel{panelClass ? ' ' + panelClass : ''}"
      bind:this={panelEl}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabindex="-1"
    >
      {@render children()}
    </div>
  </div>
{/if}
