<script>
  // The Builder's running-metrics popup: every saved metric with a
  // statement running right now, each with its own Cancel. A run starts
  // and ends without a data event, so the list polls while the popup is
  // open and re-reads at once after a cancel. Built on Dialog.svelte, so
  // Escape and the backdrop dismiss it. Every error line can be cleared
  // in place (PRODUCT.md: errors are dismissible).
  import Dialog from './Dialog.svelte';
  import * as S from '../strings/index.js'; // chrome copy (strings-audit Check B)
  import { listRunningMetrics, cancelMetric, errText } from '../services.js';

  let { open = false, onClose = () => {} } = $props();

  const POLL_MS = 1000;

  let running = $state([]);
  let error = $state('');
  let cancellingId = $state(0); // the one cancel in flight (0 = none)

  function load() {
    return listRunningMetrics()
      .then((rows) => {
        running = rows || [];
      })
      .catch((e) => {
        error = errText(e) || S.builder.runningLoadError;
      });
  }

  $effect(() => {
    if (!open) return;
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  });

  function cancel(row) {
    cancellingId = row.metricId;
    cancelMetric(row.metricId)
      .then(() => load())
      .catch((e) => {
        error = errText(e) || S.fill(S.builder.runningCancelError, { name: row.name });
      })
      .finally(() => {
        cancellingId = 0;
      });
  }
</script>

<Dialog {open} label={S.builder.runningHeading} panelClass="rm-prompt" {onClose}>
  <div class="row-between rm-head">
    <h2>{S.builder.runningHeading}</h2>
    <button class="btn small" aria-label={S.builder.runningClose} onclick={onClose}
      ><span class="codicon codicon-close"></span></button
    >
  </div>
  <p class="muted rm-note">{S.builder.runningNote}</p>
  {#if error}
    <p class="error" role="alert">
      {error}
      <button class="btn small" onclick={() => (error = '')}>{S.builder.runningDismiss}</button>
    </p>
  {/if}
  {#if running.length === 0}
    <p class="muted rm-none">{S.builder.runningNone}</p>
  {:else}
    <ul class="rm-list">
      {#each running as row (row.metricId)}
        <li class="rm-row">
          <span class="rm-name">{row.name}</span>
          <button
            class="btn small danger"
            disabled={cancellingId !== 0}
            aria-label={S.fill(S.builder.runningCancelAria, { name: row.name })}
            onclick={() => cancel(row)}>{S.builder.runningCancel}</button
          >
        </li>
      {/each}
    </ul>
  {/if}
</Dialog>

<style>
  /* The panel element belongs to Dialog.svelte, so the popup's size has to
     reach it through a global selector (rm- = RunningMetricsDialog). */
  :global(.dlg-panel.rm-prompt) {
    width: min(440px, 94vw);
    padding: 18px 20px;
  }
  .rm-head h2 {
    margin: 0;
    font-size: 1.1em;
  }
  .rm-note {
    margin: 8px 0 12px;
    line-height: 1.45;
  }
  .rm-none {
    margin: 0;
  }
  .rm-list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 50vh;
    overflow-y: auto;
  }
  .rm-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0;
    border-bottom: 1px solid var(--border, rgba(127, 127, 127, 0.25));
  }
  .rm-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
