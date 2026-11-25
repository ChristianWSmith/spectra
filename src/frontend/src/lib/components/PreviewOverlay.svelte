<script>
  // PreviewOverlay: a builder's preview results, shown full screen over the view.
  // The Preview control on the editor card opens it; the X in the top right
  // closes it, and so does Escape. It mounts only while open, so its contents
  // exist only for the preview that is on screen.
  import * as S from '../strings/index.js';

  let { open = false, title = '', onClose = () => {}, chips = null, children } = $props();

  function onKey(e) {
    if (open && e.key === S.common.keyEscape) {
      e.stopPropagation();
      onClose();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <div class="panel preview-overlay" role="dialog" aria-label={title}>
    <div class="row-between">
      <h2>{title}</h2>
      <div class="toolbar">
        {#if chips}{@render chips()}{/if}
        <button
          type="button"
          class="btn small preview-close"
          aria-label={S.common.closePreview}
          title={S.common.closePreview}
          onclick={onClose}
        >
          <span class="codicon codicon-close" aria-hidden="true"></span>
        </button>
      </div>
    </div>
    <div class="preview-overlay-body">
      {@render children()}
    </div>
  </div>
{/if}
