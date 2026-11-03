<script>
// Status chip for match/job lifecycle states. progress (0..1) renders a
// mini bar inside the chip — used for "parsing" match rows.
let { status = '', progress = null, title = '' } = $props();

const LABELS = {
  ready: 'ready',
  queued: 'queued',
  parsing: 'parsing',
  failed: 'failed',
  running: 'running',
  done: 'done',
  cancelled: 'cancelled',
};

// Lifecycle state → the shared .chip palette modifier (style.css). An
// unknown state falls back to `idle`, which is exactly the base .chip
// look an unmatched status colour rule used to leave behind.
const PALETTE = {
  ready: 'ok',
  done: 'ok',
  failed: 'bad',
  queued: 'busy',
  parsing: 'busy',
  running: 'busy',
  cancelled: 'idle',
};

let pct = $derived(progress != null ? Math.round(progress * 100) : null);
let palette = $derived(PALETTE[status] || 'idle');
</script>

<span class="chip status {palette}" {title}>
  {LABELS[status] || status || '—'}
  {#if pct != null && status !== 'ready' && status !== 'failed'}
    <span class="chip-bar" aria-hidden="true">
      <span class="chip-bar-fill" class:indeterminate={pct === 0} style="width:{pct || 100}%"></span>
    </span>
    {#if pct > 0 && pct < 100}<span class="chip-pct">{pct}%</span>{/if}
  {/if}
</span>
