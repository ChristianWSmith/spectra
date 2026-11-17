<script>
  // PluginBuildDialog — Settings' "Build plugin…" flow (w23): bundle your
  // OWN metrics and report templates into a single spectra-plugin.json to
  // share with others. Built on Dialog.svelte — Escape / outside-click /
  // focus-return come free; the busy gate (Save disabled while a build or
  // the native save dialog is in flight) is this component's.
  //
  // The two chip inputs are TokenSelect — the same type-to-search
  // multi-select the Reports appendix field uses — offering ONLY
  // user-origin content: a built-in or plugin item belongs to its source
  // (a bundled built-in name would replace it on the recipient's
  // install), so the pickers filter on origin === 'user'.
  //
  // The manifest is composed + validated SERVER-side (services
  // buildPluginBundle → PlatformService.BuildPluginBundle resolves the
  // picked ids against stored rows and runs the manifest validator and
  // the metrics engine), then save.js writes the returned text through
  // the native save dialog (w26): a non-empty path — a picked location
  // with the file written — CLOSES the dialog (the native dialog
  // closing is the confirmation, so there is no in-dialog success
  // state); a cancel resolves "" and is a silent no-op that leaves the
  // dialog open, as does any error.
  import Dialog from './Dialog.svelte';
  import TokenSelect from './TokenSelect.svelte';
  import { listMetrics, listReportTemplates, buildPluginBundle, errText } from '../services.js';
  import { saveText } from '../save.js';
  import * as S from '../strings/index.js';

  let { open = false, onClose = () => {} } = $props();

  // The dialog's working state — transient by the state-placement rule:
  // it resets on every open and never restores.
  let name = $state('');
  let version = $state('1.0.0');
  // The offered items, already origin-filtered: {id, label} for
  // TokenSelect, `row` kept so a save never re-reads the catalog.
  let tplItems = $state([]);
  let metricItems = $state([]);
  let tplSel = $state([]); // picked template ids (render order)
  let metricSel = $state([]); // picked metric ids (render order)
  let loadError = $state('');
  let error = $state('');
  let busy = $state(false);
  // One load sequence per open (the loadMore/refreshList pattern): a
  // reply from a previous open can never land on the fresh one.
  let loadGen = 0;

  // Reset + load on every open.
  $effect(() => {
    if (!open) return;
    name = '';
    version = '1.0.0';
    tplSel = [];
    metricSel = [];
    error = '';
    loadError = '';
    load();
  });

  // Both reads land together (the Reports loadTemplates pattern): the
  // error slot settles only when both do, while each fulfilled list still
  // applies on its own. A failed read is UNKNOWN, never "none yet" — the
  // alert carries it and the empty-state notes stay hidden.
  async function load() {
    const gen = ++loadGen;
    const [t, m] = await Promise.allSettled([listReportTemplates(), listMetrics()]);
    if (gen !== loadGen || !open) return; // superseded by a newer open
    if (t.status === 'fulfilled') {
      tplItems = (t.value || [])
        .filter((x) => x.origin === 'user')
        .map((x) => ({ id: x.id, label: x.title || x.id, row: x }));
    }
    if (m.status === 'fulfilled') {
      metricItems = (m.value || [])
        .filter((x) => x.origin === 'user')
        .map((x) => ({ id: x.id, label: x.title || x.name, row: x }));
    }
    const failed = [t, m].find((r) => r.status === 'rejected');
    loadError = failed ? errText(failed.reason) : '';
  }

  const itemText = (it) => it.label;
  // The picks RENDER as the picked items in list order (the chip order a
  // save then submits); TokenSelect filters its offer against the tokens,
  // so no duplicate can form.
  const tplTokens = $derived(tplItems.filter((it) => tplSel.includes(it.id)));
  const metricTokens = $derived(metricItems.filter((it) => metricSel.includes(it.id)));

  function addTpl(it) {
    if (!tplSel.includes(it.id)) tplSel = [...tplSel, it.id];
  }
  function removeTpl(id) {
    tplSel = tplSel.filter((x) => x !== id);
  }
  function addMetric(it) {
    if (!metricSel.includes(it.id)) metricSel = [...metricSel, it.id];
  }
  function removeMetric(id) {
    metricSel = metricSel.filter((x) => x !== id);
  }

  // Save gating: a name AND at least one pick. A nameless or empty
  // bundle has nothing to share — the server would still compose it, but
  // the dialog never offers a pointless file (owner asked for the choice:
  // name + content wins over name-only).
  const canSave = $derived(
    name.trim() !== '' && (tplSel.length > 0 || metricSel.length > 0) && !busy,
  );

  async function save() {
    if (!canSave) return;
    busy = true;
    error = '';
    try {
      const text = await buildPluginBundle(name.trim(), version.trim(), metricSel, tplSel);
      // The native save dialog: default spectra-plugin.json. A picked
      // location (a non-empty path) means the file was written — the
      // native dialog closing IS the confirmation, so the dialog closes
      // behind it via the canonical onClose (the same path the ✕ and
      // Escape take). "" (the user cancelled) is a silent no-op
      // (save.js's contract), never an error line, and stays open.
      const path = await saveText('spectra-plugin.json', 'json', text, 'application/json');
      if (path) onClose();
    } catch (e) {
      error = errText(e);
    } finally {
      busy = false;
    }
  }
</script>

<Dialog open={open} label={S.settings.buildDialogTitle} panelClass="bp-prompt" {onClose}>
  <!-- The visible title bar: the dialog's name plus an icon-only ✕ (the
       MetricOrderDialog idiom); dismissal stays Dialog-owned. -->
  <div class="row-between bp-head">
    <h2>{S.settings.buildDialogTitle}</h2>
    <button class="btn small" aria-label={S.settings.dismissAria} onclick={onClose}
      ><span class="codicon codicon-close"></span></button
    >
  </div>
  <p class="muted bp-note">{S.settings.buildPluginNote}</p>
  {#if loadError}
    <p class="error" role="alert">{loadError}</p>
  {/if}
  <!-- Name + version: the id auto-derives from the name server-side
       (a validated slug), version defaults to 1.0.0. -->
  <div class="bp-id-row">
    <div class="bp-field">
      <label class="field-label" for="bp-name">{S.settings.buildNameLabel}</label>
      <input
        class="input"
        id="bp-name"
        type="text"
        placeholder={S.settings.buildNamePlaceholder}
        bind:value={name}
      />
    </div>
    <div class="bp-field bp-version">
      <label class="field-label" for="bp-version">{S.settings.buildVersionLabel}</label>
      <input class="input" id="bp-version" type="text" bind:value={version} />
    </div>
  </div>
  <!-- The two chip inputs (the Reports appendix field's model): type to
       search, pick → a chip inside the field; ✕ or Backspace removes. -->
  <div class="bp-field">
    <label class="field-label" for="bp-tpls">{S.settings.buildTplsLabel}</label>
    <TokenSelect
      id="bp-tpls"
      items={tplItems}
      text={itemText}
      tokens={tplTokens}
      placeholder={S.settings.buildTplsPlaceholder}
      ariaLabel={S.settings.buildTplsAria}
      onselect={addTpl}
      onremove={removeTpl}
    />
    {#if !loadError && tplItems.length === 0}
      <span class="muted bp-empty" role="status">{S.settings.buildNoTpls}</span>
    {/if}
  </div>
  <div class="bp-field">
    <label class="field-label" for="bp-metrics">{S.settings.buildMetricsLabel}</label>
    <TokenSelect
      id="bp-metrics"
      items={metricItems}
      text={itemText}
      tokens={metricTokens}
      placeholder={S.settings.buildMetricsPlaceholder}
      ariaLabel={S.settings.buildMetricsAria}
      onselect={addMetric}
      onremove={removeMetric}
    />
    {#if !loadError && metricItems.length === 0}
      <span class="muted bp-empty" role="status">{S.settings.buildNoMetrics}</span>
    {/if}
  </div>
  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}
  <!-- Save right on its row (the Analysis-rules save row's shape):
       the busy shape stays plain text, the save icon LEADS the label.
       No status line: a successful save closes the dialog (the native
       save dialog closing is the confirmation), so only failure ever
       reports here — through the error slot above. -->
  <div class="toolbar bp-foot">
    <span class="spacer"></span>
    <button class="btn primary" disabled={!canSave} onclick={save}>
      {#if busy}
        {S.settings.buildSaving}
      {:else}
        <span class="codicon codicon-save" aria-hidden="true"></span>
        {S.settings.buildSave}
      {/if}
    </button>
  </div>
</Dialog>

<style>
  /* The panel element belongs to Dialog.svelte, so the dialog's size
     reaches it through a global selector (bp- = Build Plugin; the
     mo-prompt / cf-prompt idiom). The base .dlg-panel flex column and
     its 70vh cap stay; padding and width are this dialog's own. */
  :global(.dlg-panel.bp-prompt) {
    width: min(560px, 94vw);
    padding: 16px 18px;
    gap: 10px;
  }
  .bp-head {
    flex: 0 0 auto;
  }
  .bp-head h2 {
    margin: 0;
    font-size: 1.1em;
  }
  .bp-note {
    margin: 0;
    font-size: 0.9em;
  }
  .bp-id-row {
    display: flex;
    gap: 10px;
    align-items: flex-end;
  }
  .bp-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1 1 auto;
    min-width: 0;
  }
  .bp-version {
    flex: 0 0 10ch;
  }
  .bp-empty {
    font-size: 0.9em;
  }
  .bp-foot {
    flex: 0 0 auto;
  }
</style>
