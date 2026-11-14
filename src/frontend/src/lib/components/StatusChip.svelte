<script>
// Status chip for match/job lifecycle states. progress (0..1) renders a
// mini bar inside the chip — used for "parsing" match rows. progress is
// the JOB-WIDE point (models.Job / JobProgressEvent), not a per-stage
// fraction: 0 means "indeterminate" (moving bar, no number — never
// "0%"), anything else renders the rounded percentage. stage (optional)
// names what the bar is measuring (hash/copy/parse/store/analyze): it
// always rides the tooltip and, while the bar shows a number, the text
// beside it — the ONE progress widget, no second bar anywhere.
//
// BLOCK mode (`block: true`) is the presentation for a progress display
// OUTSIDE a table cell or row-shaped list item — THE rule lives in
// PRODUCT.md "### Defaults": a CENTERED column with the indicator on
// top and its details text underneath. The indicator is a RING when the
// work is quantified (progress > 0) and a SPINNER when it is not
// (progress 0 or absent — an unknown denominator is indeterminate, never
// a fabricated number). The details line is the caller's `detail` (what
// is actually happening), plus the stage label, plus the honest
// percentage — non-empty parts joined by " · ".
//
// Inline mode (the default) is untouched by any of this: table cells and
// row-shaped list items keep the compact pill + 44px bar, DOM and CSS
// byte for byte (the .lib-status-col reserved-width arithmetic in
// style.css and library.dom.mjs Section J depend on it). `status` means
// nothing in block mode (there is no chip label to paint) and is simply
// not rendered there.
let {
  status = '',
  progress = null,
  title = '',
  stage = '',
  block = false,
  detail = '',
} = $props();

// Stage constants are the Go data contract (models.StageHash … for jobs,
// heatmapStageLoad/heatmapStageRaster in analyticservice.go for
// spectra:heatmap-progress); they are translated to player language HERE,
// at the display layer, so the payload values (jobprogress.test.js)
// stay untouched. Unknown stages pass through raw.
const STAGE_LABELS = {
  hash: 'checking file',
  copy: 'copying',
  decompress: 'unpacking',
  parse: 'reading demo',
  store: 'saving',
  analyze: 'analyzing',
  queued: 'waiting',
  load: 'reading replay data',
  raster: 'building heatmap',
  // The metric sweep's per-metric phases (metrics.StageRemove /
  // StageCompute — stored-metrics design §4): translated here at the
  // display layer like every other payload stage.
  remove: 'clearing',
  compute: 'computing',
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
  // The metric compute-state vocabulary (stored-metrics design §5) —
  // the five words GetMetricComputeState serves, rendered through THIS
  // chip (never a second widget). 'fresh'/'no-data' appear on the
  // Builder's state surface; value slots render fresh as the number and
  // no-data as the '—'.
  processing: 'processing',
  fresh: 'fresh',
  'no-data': 'no-data',
  behind: 'behind',
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
  // Metric states: processing = .chip.busy (design §5 state 1),
  // failed = .chip.bad, behind/no-data = .chip.idle, fresh = .chip.ok.
  processing: 'busy',
  fresh: 'ok',
  'no-data': 'idle',
  behind: 'idle',
};

let pct = $derived(progress != null ? Math.round(progress * 100) : null);
let palette = $derived(PALETTE[status] || 'idle');

// Block-mode indicator rule: quantified (a real fraction > 0) draws the
// ring; 0 and null both mean "no honest denominator" → the spinner.
let quantified = $derived(pct != null && pct > 0);

// Ring geometry — same 12-o'clock start as PlayerCard's reload ring
// (the only other ring in the app): the arc is swept by stroke-dashoffset.
const RING_R = 12;
const RING_CIRC = 2 * Math.PI * RING_R;
let ringOffset = $derived(RING_CIRC * (1 - (pct || 0) / 100));

// The details line under the indicator: caller text + stage + percent,
// each only when it has something to say. The percentage follows the
// inline chip's honesty rule — shown only between 0 and 100 (never "0%",
// and a finished bar needs no number beside it).
let blockDetail = $derived.by(() => {
  const parts = [];
  if (detail) parts.push(detail.trim());
  if (stage) parts.push(stageText);
  if (pct != null && pct > 0 && pct < 100) parts.push(pct + '%');
  return parts.join(' · ');
});

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

{#if block}
  <span class="chip-block" title={tip}>
    {#if quantified}
      <svg
        class="chip-ring"
        viewBox="0 0 28 28"
        width="28"
        height="28"
        aria-hidden="true"
        focusable="false"
      >
        <circle class="chip-ring-track" cx="14" cy="14" r={RING_R} />
        <circle
          class="chip-ring-fill"
          cx="14"
          cy="14"
          r={RING_R}
          transform="rotate(-90 14 14)"
          stroke-dasharray="{RING_CIRC} {RING_CIRC}"
          stroke-dashoffset={ringOffset}
        />
      </svg>
    {:else}
      <span class="chip-spin" aria-hidden="true"></span>
    {/if}
    {#if blockDetail}
      <span class="chip-detail">{blockDetail}</span>
    {/if}
  </span>
{:else}
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
{/if}
