<script>
// Status chip for match/job lifecycle states. progress (0..1) renders a
// mini bar inside the chip — used for "parsing" match rows. progress is
// the JOB-WIDE point (models.Job / JobProgressEvent), not a per-stage
// fraction: 0 means "indeterminate" (moving bar, no number — never
// "0%"), anything else renders the rounded percentage. stage (optional)
// names what the bar is measuring (hash/copy/parse/store/analyze): it
// always rides the tooltip and, while the bar shows a number, the text
// beside it — the ONE progress widget, no second bar anywhere.
let { status = '', progress = null, title = '', stage = '' } = $props();

// Stage constants are the Go data contract (models.StageHash …); they
// are translated to player language HERE, at the display layer, so the
// payload values (jobprogress.test.js) stay untouched. Unknown stages
// pass through raw.
const STAGE_LABELS = {
  hash: 'checking file',
  copy: 'copying',
  decompress: 'unpacking',
  parse: 'reading demo',
  store: 'saving',
  analyze: 'analyzing',
  queued: 'waiting',
};

let stageText = $derived(STAGE_LABELS[stage] || stage);

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
// unknown state falls back to `idle` — the base .chip look.
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
// Tooltip = the caller's title (a match's error text) + the stage + the
// determinate percentage, in that order; absent parts are dropped.
let tip = $derived.by(() => {
  const parts = [];
  if (title) parts.push(title);
  if (stage) parts.push(stageText);
  if (pct != null && pct > 0 && pct < 100) parts.push(pct + '%');
  return parts.join(' · ');
});
</script>

<span class="chip status {palette}" title={tip}>
  {LABELS[status] || status || '—'}
  {#if pct != null && status !== 'ready' && status !== 'failed'}
    <span class="chip-bar" aria-hidden="true">
      <span class="chip-bar-fill" class:indeterminate={pct === 0} style="width:{pct || 100}%"></span>
    </span>
    {#if pct > 0 && pct < 100}
      <span class="chip-pct">{stage ? stageText + ' ' : ''}{pct}%</span>
    {:else if pct === 0 && stage}
      <span class="chip-pct">{stageText}</span>
    {/if}
  {/if}
</span>
