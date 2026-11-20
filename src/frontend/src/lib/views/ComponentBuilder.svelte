<script>
  // The Component builder (dogfood/04-COMPONENTS.md §6): the component
  // AUTHORING surface, beside the metric Builder and the Reports builder
  // and in their visual language. A list of components (the built-ins,
  // then yours), the source editor, and the live preview mounted in the
  // same frame every placed component sits in (ComponentFrame.svelte).
  //
  // Rules:
  //   * a BUILT-IN loads read-only (Save disabled, the source readonly);
  //     Duplicate saves a copy of its source as yours and opens it;
  //   * the live check is gateComponentSave (componentruntime/savegate.js),
  //     debounced. Save stays disabled until it passes, and the refusal
  //     shows with its line. services.js saveComponent runs the same gate
  //     before the write, so no caller can store a refused source;
  //   * the preview mounts the last source that passed the gate, so a
  //     half-typed edit never replaces a working preview (the editor shows
  //     the refusal). Runtime failures show in the preview's own frame;
  //   * the preview context is chosen, never defaulted: a match passes
  //     `match_id`, a player `steam_id`; nothing chosen passes neither;
  //   * delete is for your components only, and the service refuses it
  //     while a placement references the component, naming the places.
  import * as S from '../strings/index.js';
  import { listComponents, saveComponent, deleteComponent, listMatches, listPlayers, errText } from '../services.js';
  import { gateComponentSave, refusalText } from '../componentruntime/savegate.js';
  import { BUILTIN_COMPONENTS, builtinById } from '../componentbuiltins.js';
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

  // --- The list ---------------------------------------------------------------

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

  function editBuiltin(b) {
    load({ original: '', builtinId: b.id, name: b.label, source: b.source });
  }

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
      gateComponentSave(src).then(
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

  // Save needs a passing check, a name, and a change to a yours-component
  // (a built-in is never saved in place).
  const saveDisabled = $derived(
    saving || !!builtin || check.status !== 'ok' || form.name.trim() === '' || (!!form.original && !dirty),
  );
  const saveTitle = $derived(
    builtin
      ? S.componentbuilder.builtinReadOnly
      : check.status === 'error'
        ? S.componentbuilder.saveBlockedTitle
        : undefined,
  );

  async function save() {
    actionError = '';
    saving = true;
    try {
      const saved = await saveComponent(form.original, form.name, form.source);
      form.original = saved.name;
      form.name = saved.name;
      baseline = snapshot(form);
      await refreshList();
    } catch (e) {
      actionError = errText(e);
    } finally {
      saving = false;
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

  const previewProps = $derived.by(() => {
    if (contextKind === 'match' && matchId > 0) return { match_id: matchId };
    if (contextKind === 'player' && steamId) return { steam_id: steamId };
    return {};
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
            b.placeholder
              ? [
                  { text: S.componentbuilder.builtinChip },
                  { text: S.componentbuilder.placeholderChip, title: S.componentbuilder.placeholderTitle },
                ]
              : [{ text: S.componentbuilder.builtinChip }],
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
          readonly={!!builtin}
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
          {/if}
          <button
            class="btn cb-duplicate"
            onclick={duplicate}
            disabled={saving || check.status !== 'ok' || (!builtin && !form.original)}
            title={S.componentbuilder.duplicateTitle}
            ><span class="codicon codicon-copy" aria-hidden="true"></span>
            {S.componentbuilder.duplicate}</button
          >
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
          <ComponentFrame source={previewSource} props={previewProps} {nav} />
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
