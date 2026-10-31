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

let pct = $derived(progress != null ? Math.round(progress * 100) : null);
</script>

<span class="chip status {status}" {title}>
  {LABELS[status] || status || '—'}
  {#if pct != null && status !== 'ready' && status !== 'failed'}
    <span class="chip-bar" aria-hidden="true">
      <span class="chip-bar-fill" class:indeterminate={pct === 0} style="width:{pct || 100}%"></span>
    </span>
    {#if pct > 0 && pct < 100}<span class="chip-pct">{pct}%</span>{/if}
  {/if}
</span>
