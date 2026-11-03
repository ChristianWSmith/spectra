<script>
  // Anchored popover dismissal. `anchor` is the element that owns the
  // popover — it contains both the trigger and the panel, so a pointerdown
  // outside it closes the popover; Escape closes from wherever focus is.
  //
  // Focus handling stays with the consumer: MatchPicker returns focus to
  // its trigger on close (and not when the pointer dismisses), which is
  // why the two reasons are separate callbacks.
  let {
    open = false,
    anchor = null,
    onClose = () => {},
    onOutside = null,
    children,
  } = $props();

  $effect(() => {
    if (!open || !anchor) return;
    const outside = onOutside || onClose;
    const onDown = (e) => {
      if (!anchor.contains(e.target)) outside();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  });
</script>

{#if open}
  {@render children()}
{/if}
