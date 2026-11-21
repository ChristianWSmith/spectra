<script>
  // The Component builder (dogfood/04-COMPONENTS.md §6): the component
  // AUTHORING surface, beside the metric Builder and the Reports builder
  // and in their visual language. A list of components (the built-ins,
  // then yours), the source editor, and the live preview mounted in the
  // same frame every placed component sits in (ComponentFrame.svelte).
  //
  // Rules:
  //   * a BUILT-IN is edited in place (owner ruling 43): its source is
  //     editable, Save stores the edit as that builtin's override (wherever
  //     it is mounted), and Restore to default deletes the override and
  //     loads the shipped source. Its name is fixed. Duplicate is for yours;
  //   * "Use as my view" writes one placement for a surface (match-view,
  //     profile-view) that points at the open component; Reset removes it;
  //   * the live check is gateComponentSave (componentruntime/savegate.js),
  //     debounced. Save stays disabled until it passes, and the refusal
  //     shows with its line. services.js saveComponent runs the same gate
  //     before the write, so no caller can store a refused source;
  //   * every compile runs in a Web Worker (ruling 47), so a large source
  //     never blocks the screen. While one runs, its progress shows in the
  //     background-work indicator and Cancel sits beside Save; Cancel stops
  //     it and nothing is written;
  //   * the preview mounts the last source that passed the gate, so a
  //     half-typed edit never replaces a working preview (the editor shows
  //     the refusal). Runtime failures show in the preview's own frame;
  //   * the preview context is chosen, never defaulted (04 §6): a chosen
  //     match sets `context.matchId`, a chosen player `context.steamId`;
  //     nothing chosen leaves both null;
  //   * delete is for your components only, and the service refuses it
  //     while a placement references the component, naming the places.
  import * as S from '../strings/index.js';
  import {
    listComponents,
    saveComponent,
    deleteComponent,
    listMatches,
    listPlayers,
    listBuiltinOverrides,
    saveBuiltinOverride,
    deleteBuiltinOverride,
    listPlacements,
    setPlacements,
    resetPlacements,
    errText,
  } from '../services.js';
  import { gateComponentSave, refusalText } from '../componentruntime/savegate.js';
  import { subscribeCompiles, cancelCompiles } from '../componentruntime/compileclient.js';
  import { BUILTIN_COMPONENTS, builtinById, builtinShippedSource, builtinSourceDir } from '../componentbuiltins.js';
  import { placedEntries } from '../componentruntime/placementrows.js';
  import { listedPlayers } from '../players.js';
  import MatchPicker from '../components/MatchPicker.svelte';
  import PlayerPicker from '../components/PlayerPicker.svelte';
  import HelpButton from '../components/HelpButton.svelte';
  import ComponentFrame from '../components/ComponentFrame.svelte';
  import { seed, remember } from '../viewstate.svelte.js';

  let { nav = undefined, openDocs = () => {} } = $props();

  // The live check's debounce: long enough not to check on every key,
  // short enough to feel live.
  const CHECK_DEBOUNCE_MS = 250;
  const MAX_NAME = 60; // componentservice.go maxComponentName

  // `original` is the stored name the form replaces ('' = not saved yet);
  // `builtinId` is set while a built-in is loaded (read-only).
  function newForm() {
    return { original: '', builtinId: '', name: '', source: '' };
  }
  function snapshot(f) {
    return JSON.stringify({ name: f.name, source: f.source });
  }

  // View-local working state restores across navigation through the
  // process-scoped registry (the Reports builder's pattern); busy flags,
  // errors and the check result stay transient.
  const cbSeed = seed('componentbuilder', {
    form: newForm(),
    baseline: snapshot(newForm()),
    contextKind: 'match',
    matchId: 0,
    steamId: '',
  });
  let form = $state(cbSeed.form);
  let baseline = $state(cbSeed.baseline);
  let contextKind = $state(cbSeed.contextKind);
  let matchId = $state(cbSeed.matchId);
  let steamId = $state(cbSeed.steamId);
  $effect(() => remember('componentbuilder', { form, baseline, contextKind, matchId, steamId }));

  let components = $state([]);
  let loading = $state(true);
  let listError = $state('');
  let actionError = $state('');
  let saving = $state(false);
  // True while any compile runs (the live check, a save, a preview's load):
  // the Cancel button beside Save shows exactly then (ruling 47).
  let compiling = $state(false);
  $effect(() =>
    subscribeCompiles((on) => {
      compiling = on;
    }),
  );

  // --- The list ---------------------------------------------------------------

  // Built-ins edited in place (builtin id → the edited source) and the two
  // surfaces' placements (surface → its entries, empty = the default).
  let overrides = $state({});
  const VIEW_SURFACES = [
    { surface: 'match-view', label: S.componentbuilder.surfaceMatch },
    { surface: 'profile-view', label: S.componentbuilder.surfaceProfile },
  ];
  let placements = $state({ 'match-view': [], 'profile-view': [] });
  let viewBusy = $state(false);

  async function refreshOverrides() {
    try {
      const rows = (await listBuiltinOverrides()) || [];
      overrides = Object.fromEntries(rows.map((o) => [o.id, o.source]));
    } catch (e) {
      listError = errText(e);
    }
  }
  async function refreshPlacements() {
    try {
      const next = {};
      for (const v of VIEW_SURFACES) next[v.surface] = placedEntries(await listPlacements(v.surface));
      placements = next;
    } catch (e) {
      listError = errText(e);
    }
  }

  async function refreshList() {
    loading = true;
    try {
      components = (await listComponents()) || [];
      listError = '';
    } catch (e) {
      listError = errText(e);
    } finally {
      loading = false;
    }
    await refreshOverrides();
    await refreshPlacements();
  }
  $effect(() => {
    refreshList();
  });

  // Self-heal: an editor pointing at one of your components that no longer
  // exists falls back to a fresh editor. Gated on a successful read.
  $effect(() => {
    const original = form.original;
    if (!original || loading || listError) return;
    if (!components.some((c) => c.name === original)) newComponent();
  });

  // --- The editor ---------------------------------------------------------------

  const builtin = $derived(form.builtinId ? builtinById(form.builtinId) : null);
  const dirty = $derived(snapshot(form) !== baseline);

  function load(next) {
    form = next;
    baseline = snapshot(next);
    actionError = '';
    previewSource = null;
    check = { status: 'idle', line: 0, message: '' };
  }

  // A built-in opens at its edit when it has one, else at its shipped source.
  function editBuiltin(b) {
    const source = Object.hasOwn(overrides, b.id) ? overrides[b.id] : builtinShippedSource(b.id);
    load({ original: '', builtinId: b.id, name: b.label, source });
  }

  // The built-in has an edit stored (its override is in place).
  const overridden = $derived(!!builtin && Object.hasOwn(overrides, builtin.id));

  function editComponent(c) {
    load({ original: c.name, builtinId: '', name: c.name, source: c.source });
  }

  function newComponent() {
    load(newForm());
  }

  // --- The live check -------------------------------------------------------------
  // status: idle (no source) | pending | ok | error {line, message}.
  let check = $state({ status: 'idle', line: 0, message: '' });
  let checkHidden = $state(false); // the refusal's dismiss (until the next edit)
  let previewSource = $state(null); // the last source that passed the gate
  let checkGen = 0;
  $effect(() => {
    const src = form.source;
    const gen = ++checkGen;
    checkHidden = false;
    if (src.trim() === '') {
      check = { status: 'idle', line: 0, message: '' };
      return;
    }
    check = { status: 'pending', line: 0, message: '' };
    const timer = setTimeout(() => {
      gateComponentSave(src, builtinSourceDir(form.builtinId)).then(
        (r) => {
          if (gen !== checkGen) return;
          if (r.ok) {
            check = { status: 'ok', line: 0, message: '' };
            previewSource = src;
          } else {
            check = { status: 'error', line: r.line, message: r.message };
          }
        },
        (e) => {
          if (gen === checkGen) check = { status: 'error', line: 0, message: errText(e) };
        },
      );
    }, CHECK_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  const checkText = $derived(
    check.status !== 'error' ? '' : refusalText({ ok: false, line: check.line, message: check.message }),
  );

  // Save needs a passing check, a name, and a change. A built-in's change is
  // its edit (an override); a yours-component's change is its new text.
  const saveDisabled = $derived(
    saving ||
      check.status !== 'ok' ||
      form.name.trim() === '' ||
      (builtin ? !dirty : !!form.original && !dirty),
  );
  const saveTitle = $derived(check.status === 'error' ? S.componentbuilder.saveBlockedTitle : undefined);

  async function save() {
    actionError = '';
    saving = true;
    try {
      if (builtin) {
        // The save gate runs inside saveBuiltinOverride; a refused source
        // never reaches the write.
        await saveBuiltinOverride(builtin.id, form.source);
        baseline = snapshot(form);
        await refreshOverrides();
      } else {
        const saved = await saveComponent(form.original, form.name, form.source);
        form.original = saved.name;
        form.name = saved.name;
        baseline = snapshot(form);
        await refreshList();
      }
    } catch (e) {
      actionError = errText(e);
    } finally {
      saving = false;
    }
  }

  // Restore to default: the built-in's edit is deleted and the editor shows
  // the shipped source again.
  async function restoreDefault() {
    if (!builtin) return;
    actionError = '';
    saving = true;
    try {
      await deleteBuiltinOverride(builtin.id);
      await refreshOverrides();
      editBuiltin(builtin);
    } catch (e) {
      actionError = errText(e);
    } finally {
      saving = false;
    }
  }

  // --- Use as my view ----------------------------------------------------------
  // The open component (a built-in, or a saved yours-component) is the target.
  const viewTarget = $derived(builtin ? builtin.id : form.original || '');

  function viewState(surface) {
    const rows = placements[surface];
    if (!rows.length) return S.componentbuilder.viewDefault;
    return rows[0].component === viewTarget ? S.componentbuilder.viewUsingThis : S.componentbuilder.viewUsingOther;
  }

  // One placement per surface: the open component, replacing whatever the
  // surface showed.
  async function useAsView(surface) {
    if (!viewTarget) return;
    actionError = '';
    viewBusy = true;
    try {
      await setPlacements(surface, [{ component: viewTarget, props: '{}', hidden: false }]);
      await refreshPlacements();
    } catch (e) {
      actionError = errText(e);
    } finally {
      viewBusy = false;
    }
  }

  // Reset removes the surface's placement, so it renders its default again.
  async function resetView(surface) {
    actionError = '';
    viewBusy = true;
    try {
      await resetPlacements(surface);
      await refreshPlacements();
    } catch (e) {
      actionError = errText(e);
    } finally {
      viewBusy = false;
    }
  }

  // copyName mints "<name> copy", then "<name> copy 2", … — unique among
  // your components and within the name limit.
  function copyName(base) {
    const taken = new Set(components.map((c) => c.name));
    const cut = (s) => s.slice(0, MAX_NAME);
    let name = cut(S.fill(S.componentbuilder.copyName, { name: base }));
    for (let n = 2; taken.has(name); n++) name = cut(S.fill(S.componentbuilder.copyNameN, { name: base, n }));
    return name;
  }

  // Duplicate SAVES a copy (of a built-in, or of one of yours) as a new
  // component and opens it, so the copy exists before it is edited.
  async function duplicate() {
    actionError = '';
    saving = true;
    try {
      const saved = await saveComponent('', copyName(form.name.trim() || form.original), form.source);
      await refreshList();
      editComponent(saved);
    } catch (e) {
      actionError = errText(e);
    } finally {
      saving = false;
    }
  }

  async function remove(name) {
    actionError = '';
    try {
      await deleteComponent(name);
      if (form.original === name) newComponent();
      await refreshList();
    } catch (e) {
      actionError = errText(e);
    }
  }

  // --- The preview context ---------------------------------------------------------

  let matches = $state([]);
  $effect(() => {
    listMatches('', 'extracted_at', true)
      .then((rows) => {
        const ready = (rows || []).filter((r) => r.status === 'ready' || r.status === '');
        matches = ready.length ? ready : rows || [];
      })
      .catch(() => {
        matches = [];
      });
  });

  // Bot-filtered through the canonical selection helper (players.js).
  let players = $state([]);
  $effect(() => {
    listPlayers('')
      .then((rows) => {
        players = listedPlayers(rows) || [];
        if (players.length && !players.some((p) => p.steamId === steamId)) steamId = '';
      })
      .catch(() => {
        players = [];
      });
  });

  // The preview's read-only context (04 §3, ruling 34): only what is chosen.
  const previewContext = $derived.by(() => {
    if (contextKind === 'match' && matchId > 0) return { matchId, steamId: null, round: null };
    if (contextKind === 'player' && steamId) return { matchId: null, steamId, round: null };
    return { matchId: null, steamId: null, round: null };
  });
</script>

{#snippet row(label, active, chips, onopen, onremove)}
  <div class="cb-row" class:active>
    <button class="cb-row-main" onclick={onopen}>
      <span class="cb-row-title">{label}</span>
      {#if chips.length}
        <span class="cb-row-sub">
          {#each chips as c (c.text)}
            <span class="chip" title={c.title}>{c.text}</span>
          {/each}
        </span>
      {/if}
    </button>
    {#if onremove}
      <span class="cb-row-acts">
        <button
          class="btn small ghost"
          title={S.componentbuilder.deleteComponent}
          aria-label={S.fill(S.componentbuilder.deleteAria, { name: label })}
          onclick={onremove}><span class="codicon codicon-trash" aria-hidden="true"></span></button
        >
      </span>
    {/if}
  </div>
{/snippet}

<div class="view cb-view">
  <header class="view-header">
    <div>
      <h1>{S.componentbuilder.heading}</h1>
      <p class="muted cb-head-note">{S.componentbuilder.headNote}</p>
    </div>
    <div class="spacer"></div>
    <HelpButton section="component-builder" {openDocs} />
  </header>

  {#if listError}
    <p class="error" role="alert">
      {listError}
      <button class="btn small" onclick={refreshList}>{S.componentbuilder.retry}</button>
    </p>
  {/if}
  {#if actionError}
    <p class="error cb-action-error" role="alert">
      {actionError}
      <button class="btn small" aria-label={S.componentbuilder.dismissError} onclick={() => (actionError = '')}>
        <span class="codicon codicon-close" aria-hidden="true"></span>
      </button>
    </p>
  {/if}

  <div class="cb-grid">
    <section class="panel cb-list">
      <div class="row-between">
        <h2>{S.componentbuilder.componentsHeading}</h2>
        <button class="btn small" onclick={newComponent}
          ><span class="codicon codicon-add" aria-hidden="true"></span>
          {S.componentbuilder.newLabel}</button
        >
      </div>
      <span class="field-label">{S.componentbuilder.builtinGroup}</span>
      <div class="cb-rows cb-builtins">
        {#each BUILTIN_COMPONENTS as b (b.id)}
          {@render row(
            b.label,
            form.builtinId === b.id,
            [
              { text: S.componentbuilder.builtinChip },
              ...(b.placeholder
                ? [{ text: S.componentbuilder.placeholderChip, title: S.componentbuilder.placeholderTitle }]
                : []),
              ...(Object.hasOwn(overrides, b.id)
                ? [{ text: S.componentbuilder.editedChip, title: S.componentbuilder.editedTitle }]
                : []),
            ],
            () => editBuiltin(b),
            null,
          )}
        {/each}
      </div>
      <span class="field-label">{S.componentbuilder.yoursGroup}</span>
      {#if components.length === 0}
        {#if loading}
          <p class="muted" role="status">{S.componentbuilder.loadingList}</p>
        {:else}
          <p class="muted" role="status">{S.componentbuilder.noUserComponents}</p>
        {/if}
      {:else}
        <div class="cb-rows cb-yours">
          {#each components as c (c.name)}
            {@render row(c.name, form.original === c.name, [], () => editComponent(c), () => remove(c.name))}
          {/each}
        </div>
      {/if}
    </section>

    <section class="panel cb-editor">
      <div class="row-between">
        <h2>{form.original || builtin ? S.componentbuilder.editComponent : S.componentbuilder.newComponent}</h2>
        {#if builtin}
          <span class="chip cb-readonly" title={S.componentbuilder.builtinReadOnly}>{S.componentbuilder.builtinChip}</span>
        {/if}
      </div>
      <div class="cb-field">
        <label class="field-label" for="cb-name">{S.componentbuilder.fieldName}</label>
        <input
          id="cb-name"
          class="input"
          maxlength={MAX_NAME}
          bind:value={form.name}
          placeholder={S.componentbuilder.namePlaceholder}
          readonly={!!builtin}
        />
      </div>
      <!-- The source is a POWER surface (component code): monospace,
           spellcheck off, no chrome placeholder. readonly, never disabled,
           so a built-in's source stays selectable and copyable. -->
      <div class="cb-field cb-source-field">
        <label class="field-label" for="cb-source">{S.componentbuilder.fieldSource}</label>
        <textarea
          id="cb-source"
          class="input mono cb-source"
          rows="22"
          spellcheck="false"
          bind:value={form.source}
        ></textarea>
      </div>
      <div class="cb-check">
        {#if check.status === 'pending'}
          <span class="muted" role="status">{S.componentbuilder.checking}</span>
        {:else if check.status === 'ok'}
          <span class="muted" role="status">{S.componentbuilder.checkOk}</span>
        {:else if check.status === 'error' && !checkHidden}
          <p class="error cb-check-error" role="alert">
            {checkText}
            <button class="btn small" aria-label={S.componentbuilder.dismissError} onclick={() => (checkHidden = true)}>
              <span class="codicon codicon-close" aria-hidden="true"></span>
            </button>
          </p>
        {/if}
      </div>

      <!-- ONE actions line: the destructive control LEFT, the positive
           actions right (the other builders' layout). -->
      <div class="row-between cb-actions">
        <span>
          {#if form.original}
            <button
              class="btn danger cb-delete"
              onclick={() => remove(form.original)}
              title={S.componentbuilder.deleteComponent}
              aria-label={S.fill(S.componentbuilder.deleteAria, { name: form.original })}
              ><span class="codicon codicon-trash" aria-hidden="true"></span>
              {S.componentbuilder.deleteComponent}</button
            >
          {/if}
        </span>
        <span class="toolbar">
          {#if builtin}
            <span class="muted cb-note">{S.componentbuilder.builtinReadOnly}</span>
            <button
              class="btn cb-restore"
              onclick={restoreDefault}
              disabled={saving || !overridden}
              title={S.componentbuilder.restoreTitle}
              >{S.componentbuilder.restoreDefault}</button
            >
          {:else}
            <button
              class="btn cb-duplicate"
              onclick={duplicate}
              disabled={saving || check.status !== 'ok' || !form.original}
              title={S.componentbuilder.duplicateTitle}
              ><span class="codicon codicon-copy" aria-hidden="true"></span>
              {S.componentbuilder.duplicate}</button
            >
          {/if}
          {#if compiling}
            <button
              class="btn cb-cancel"
              onclick={() => cancelCompiles()}
              title={S.componentbuilder.cancelCompileTitle}>{S.componentbuilder.cancelCompile}</button
            >
          {/if}
          <button class="btn primary cb-save" onclick={save} disabled={saveDisabled} title={saveTitle}>
            <span class="codicon codicon-save" aria-hidden="true"></span>
            {saving
              ? S.componentbuilder.saving
              : form.original && !dirty
                ? S.componentbuilder.saved
                : S.componentbuilder.saveComponent}
          </button>
        </span>
      </div>

      <!-- Use as my view: one placement per surface, pointing at the open
           component (dogfood/04 §2; owner ruling 43). -->
      {#if viewTarget}
        <div class="cb-views">
          <span class="field-label">{S.componentbuilder.viewsHeading}</span>
          {#each VIEW_SURFACES as v (v.surface)}
            <div class="cb-view-row">
              <span class="cb-view-name">{v.label}</span>
              <span class="muted cb-view-state">{viewState(v.surface)}</span>
              <span class="toolbar">
                <button
                  class="btn small cb-use-view"
                  onclick={() => useAsView(v.surface)}
                  disabled={viewBusy || viewState(v.surface) === S.componentbuilder.viewUsingThis}
                  >{S.componentbuilder.useAsView}</button
                >
                {#if placements[v.surface].length}
                  <button class="btn small cb-reset-view" onclick={() => resetView(v.surface)} disabled={viewBusy}
                    >{S.componentbuilder.resetView}</button
                  >
                {/if}
              </span>
            </div>
          {/each}
        </div>
      {:else}
        <p class="muted cb-views-note">{S.componentbuilder.viewsNeedSave}</p>
      {/if}
    </section>

    <section class="panel cb-preview">
      <div class="row-between">
        <h2>{S.componentbuilder.previewHeading}</h2>
      </div>
      <div class="cb-context" role="group" aria-label={S.componentbuilder.contextLabel}>
        <div class="cb-field">
          <label class="field-label" for="cb-context">{S.componentbuilder.contextLabel}</label>
          <select id="cb-context" class="input" bind:value={contextKind}>
            <option value="match">{S.componentbuilder.contextMatch}</option>
            <option value="player">{S.componentbuilder.contextPlayer}</option>
          </select>
        </div>
        {#if contextKind === 'match'}
          <div class="cb-field">
            <label class="field-label" for="cb-match">{S.componentbuilder.matchLabel}</label>
            <MatchPicker {matches} value={matchId} id="cb-match" onselect={(mid) => (matchId = mid)} />
          </div>
        {:else}
          <div class="cb-field">
            <label class="field-label" for="cb-player">{S.componentbuilder.playerLabel}</label>
            <PlayerPicker {players} value={steamId} id="cb-player" onselect={(sid) => (steamId = sid)} />
          </div>
        {/if}
      </div>
      <div class="cb-stage">
        {#if previewSource == null}
          <p class="muted" role="status">{S.componentbuilder.noPreviewYet}</p>
        {:else}
          <ComponentFrame
            source={previewSource}
            builtinDir={builtinSourceDir(form.builtinId)}
            context={previewContext}
            {nav}
          />
        {/if}
      </div>
    </section>
  </div>
</div>

<style>
  .cb-grid {
    display: grid;
    grid-template-columns: minmax(220px, 280px) minmax(0, 1fr) minmax(0, 1fr);
    gap: 16px;
    align-items: start;
  }
  .cb-list,
  .cb-editor,
  .cb-preview {
    min-width: 0;
  }
  .cb-rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .cb-row {
    display: flex;
    align-items: stretch;
    gap: 2px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .cb-row.active {
    border-color: var(--accent);
  }
  .cb-row-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: 6px 8px;
    background: none;
    border: 0;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .cb-row-title {
    overflow-wrap: anywhere;
  }
  .cb-row-sub {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .cb-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .cb-source {
    min-height: 22em;
    width: 100%;
    resize: vertical;
    white-space: pre;
    overflow: auto;
  }
  .cb-actions {
    flex-wrap: wrap;
    gap: 8px;
  }
  .cb-views {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 12px;
  }
  .cb-view-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .cb-view-name {
    font-weight: 600;
  }
  .cb-view-state {
    flex: 1;
    min-width: 0;
  }
  .cb-context {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .cb-stage {
    margin-top: 12px;
    min-width: 0;
  }
  @media (max-width: 1100px) {
    .cb-grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
