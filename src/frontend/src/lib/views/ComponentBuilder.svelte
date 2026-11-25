<script>
  import SourceEditor from '../components/SourceEditor.svelte';
  import { componentCompletions } from '../editor/helperCatalog.js';
  import { fillHeight } from '../fillheight.js';
  import { expandable } from '../expandable.svelte.js';
  import PreviewOverlay from '../components/PreviewOverlay.svelte';
  import Chip from '../components/Chip.svelte';
  import { formatComponentSource } from '../format/format.js';
  import { MATCH_TABS_ID, PROFILE_VIEW_ID } from '../builtins/panels.js';
  const editorPanel = expandable();
  // The preview renders full screen (PreviewOverlay) from the Preview control on the editor card.
  let previewOpen = $state(false);
  import { createLoadState } from '../loadstate.svelte.js';
  import LoadBox from '../components/LoadBox.svelte';
  import { notifyPlacementsChanged } from '../warm.js';
  // The Component builder: the component
  // AUTHORING surface, beside the metric Builder and the Reports builder
  // and in their visual language. A list of components (the built-ins,
  // then yours), the source editor, and the live preview mounted in the
  // same frame every placed component sits in (ComponentFrame.svelte).
  //
  // Rules:
  //   * a BUILT-IN is edited in place (owner ruling 43): its source is
  //     editable, Save stores the edit as that builtin's override (wherever
  //     it is mounted), and Restore to default deletes the override and
  //     loads the shipped source. Its name is fixed;
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

  import Popover from '../components/Popover.svelte';

  let { nav = undefined, openDocs = () => {} } = $props();

  // The live check's debounce: long enough not to check on every key,
  // short enough to feel live.
  const CHECK_DEBOUNCE_MS = 250;
  const MAX_NAME = 60; // componentservice.go maxComponentName

  // `original` is the stored name the form replaces ('' = not saved yet);
  // `builtinId` is set while a built-in is loaded (read-only).
  // `pluginOf` is set while a plugin's component is loaded: read-only, saved only as your own copy.
  function newForm() {
    return { original: '', builtinId: '', name: '', source: '', pluginOf: '', pluginName: '' };
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
  // The list's first read is busy; a refresh replaces the rows in place (no spinner over them).
  const listState = createLoadState();
  let listError = $state('');
  // The list filter: a case-insensitive match on the name a view references.
  let listQuery = $state('');
  const listNeedle = $derived(listQuery.trim().toLowerCase());
  // The origin filter, as the report templates have it: built-in, custom, plugin.
  // Components have no plugin origin yet, so that box narrows nothing.
  let showBuiltin = $state(true);
  let showCustom = $state(true);
  // The view filter: a component on a view shows while that view's box is on; a component on
  // no view shows while "no view" is on. Every box starts on.
  let showMatchView = $state(true);
  let showProfileView = $state(true);
  let showNoView = $state(true);
  let filterOpen = $state(false);
  let filterAnchor = $state(null);
  let filterTrigger = $state(null);
  function closeFilters() {
    filterOpen = false;
    filterTrigger?.focus();
  }
  function closeFiltersOutside() {
    filterOpen = false;
  }
  // The view filter (see showMatchView): the views a component shows on decide whether it lists.
  function passesViewFilter(name) {
    const onViews = VIEW_SURFACES.filter((v) => surfaceComponents(v.surface).includes(name));
    if (!onViews.length) return showNoView;
    return onViews.some((v) => (v.surface === 'match-view' ? showMatchView : showProfileView));
  }
  const shownBuiltins = $derived(
    !showBuiltin
      ? []
      : BUILTIN_COMPONENTS.filter(
          (b) => (!listNeedle || b.id.toLowerCase().includes(listNeedle)) && passesViewFilter(b.id),
        ),
  );
  // Your components, and the plugins' components (origin 'plugin', grouped by the plugin that supplies them).
  const userComponents = $derived(components.filter((c) => c.origin !== 'plugin'));
  const pluginComponents = $derived(components.filter((c) => c.origin === 'plugin'));
  const pluginIds = $derived([...new Set(pluginComponents.map((c) => c.pluginId))].sort());
  // The Origin filter's per-plugin boxes: a plugin's components are hidden while its box is off.
  let hiddenPlugins = $state({});
  const shownComponents = $derived(
    !showCustom
      ? []
      : userComponents.filter(
          (c) => (!listNeedle || c.name.toLowerCase().includes(listNeedle)) && passesViewFilter(c.name),
        ),
  );
  const shownPluginComponents = $derived(
    pluginComponents.filter(
      (c) =>
        !hiddenPlugins[c.pluginId] &&
        (!listNeedle || c.name.toLowerCase().includes(listNeedle)) &&
        passesViewFilter(c.name),
    ),
  );

  // The component a surface shows right now: its placed rows, or, with none placed, its shipped default
  // (the match view's tabs, the profile view). The chip follows that, so it is there before anything is set.
  const SURFACE_DEFAULT = { 'match-view': MATCH_TABS_ID, 'profile-view': PROFILE_VIEW_ID };
  function surfaceComponents(surface) {
    const rows = placements[surface];
    return rows.length ? rows.map((p) => p.component) : [SURFACE_DEFAULT[surface]];
  }

  // The views a component shows on (see surfaceComponents).
  function placedChips(name) {
    if (!name) return [];
    return VIEW_SURFACES.filter((v) => surfaceComponents(v.surface).includes(name)).map((v) => ({
      text: v.chip,
      tone: 'view',
      title: S.componentbuilder.useAsView,
    }));
  }

  // The Use-as popover: a click on the view the component already shows gives it back to the default.
  let viewMenuOpen = $state(false);
  let viewWrap = $state(null);
  function closeViewMenu() {
    viewMenuOpen = false;
  }
  async function chooseView(surface) {
    closeViewMenu();
    if (placements[surface][0]?.component === viewTarget) await resetView(surface);
    else await useAsView(surface);
  }
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
  // label: the Use-as menu's wording; chip: the chip a placed component wears (lib/strings/common.js).
  const VIEW_SURFACES = [
    { surface: 'match-view', label: S.componentbuilder.surfaceMatch, chip: S.common.chipViewMatch },
    { surface: 'profile-view', label: S.componentbuilder.surfaceProfile, chip: S.common.chipViewProfile },
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
    try {
      await listState.track(listComponents(), 'list', (v) => {
        components = v || [];
      });
      listError = '';
    } catch (e) {
      listError = errText(e);
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
    if (!original || listState.pending > 0 || listError) return;
    if (!components.some((c) => c.name === original)) newComponent();
  });

  // --- The editor ---------------------------------------------------------------

  const builtin = $derived(form.builtinId ? builtinById(form.builtinId) : null);
  const dirty = $derived(snapshot(form) !== baseline);

  // load opens a component in the editor, in its canonical layout. The baseline is the formatted
  // text, so opening alone does not make the editor dirty.
  async function load(next) {
    const opened = { ...next, source: await formatSource(next.source) };
    form = opened;
    baseline = snapshot(opened);
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

  // A plugin's component opens read-only: Save stores a copy under a name of your own (the name must be new).
  function editPluginComponent(c) {
    load({ original: '', builtinId: '', name: c.name, source: c.source, pluginOf: c.pluginId, pluginName: c.name });
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
      gateComponentSave(src, builtinSourceDir(form.builtinId), { quiet: true }).then(
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

  // The canonical layout, applied when a component opens in the editor and again before it is saved.
  // A source the formatter cannot read is kept as typed (the save gate refuses it with its line).
  async function formatSource(src) {
    try {
      return await formatComponentSource(src);
    } catch {
      return src;
    }
  }

  async function save() {
    actionError = '';
    saving = true;
    try {
      form.source = await formatSource(form.source);
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
        form.pluginOf = ''; // a plugin's copy is yours from here on
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
  // The open component (a built-in, a saved yours-component, or a plugin's component, which places by its
  // name without a copy) is the target.
  const viewTarget = $derived(builtin ? builtin.id : form.original || form.pluginName || '');

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
      notifyPlacementsChanged(); // re-warm the match and profile views (lib/warm.js)
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
      notifyPlacementsChanged(); // re-warm the match and profile views (lib/warm.js)
    } catch (e) {
      actionError = errText(e);
    } finally {
      viewBusy = false;
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
<!-- Escape collapses whichever card is expanded (each key handler checks its own). -->
<svelte:window
  onkeydown={(e) => {
    editorPanel.key(e);
  }}
/>

{#snippet row(label, active, chips, onopen, onremove)}
  <div class="cb-row" class:active>
    <button class="cb-row-main" onclick={onopen}>
      <span class="cb-row-title">{label}</span>
      {#if chips.length}
        <span class="cb-row-sub">
          {#each chips as c (c.text)}
            <Chip tone={c.tone} title={c.title}>{c.text}</Chip>
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
    <h1>{S.componentbuilder.heading}</h1>
    <p class="muted cb-head-note">{S.componentbuilder.headNote}</p>
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
    <section class="panel cb-list" use:fillHeight>
      <div class="row-between">
        <h2>{S.componentbuilder.componentsHeading}</h2>
        <button class="btn small" onclick={newComponent}
          ><span class="codicon codicon-add" aria-hidden="true"></span>
          {S.componentbuilder.newLabel}</button
        >
      </div>
      <div class="bld-search-row">
        <input
          class="input bld-search"
          type="search"
          aria-label={S.componentbuilder.listFilterAria}
          placeholder={S.componentbuilder.listFilterPlaceholder}
          bind:value={listQuery}
        />
        <span class="bld-filter-host" bind:this={filterAnchor}>
          <button
            type="button"
            class="btn small bld-filter-btn"
            class:multi-open={filterOpen}
            bind:this={filterTrigger}
            aria-haspopup="true"
            aria-expanded={filterOpen}
            aria-controls={filterOpen ? 'cb-filter-pop' : null}
            aria-label={S.common.filtersLabel}
            title={S.common.filtersTitle}
            onclick={() => (filterOpen = !filterOpen)}
          >
            <span class="codicon codicon-filter" aria-hidden="true"></span>
            <span class="codicon codicon-chevron-{filterOpen ? 'up' : 'down'}" aria-hidden="true"></span>
          </button>
          <Popover open={filterOpen} anchor={filterAnchor} onClose={closeFilters} onOutside={closeFiltersOutside}>
            <div class="bld-filter-pop" id="cb-filter-pop" role="group" aria-label={S.common.filtersLabel}>
              <div class="bld-filter-group" role="group" aria-label={S.componentbuilder.originLabel}>
                <span class="filt-lab">{S.componentbuilder.originLabel}</span>
                <label class="filt-check"
                  ><input type="checkbox" checked={showBuiltin} onchange={(e) => (showBuiltin = e.currentTarget.checked)} />
                  {S.componentbuilder.filterBuiltIn}</label
                >
                {#each pluginIds as pid (pid)}
                  <label class="filt-check"
                    ><input
                      type="checkbox"
                      checked={!hiddenPlugins[pid]}
                      onchange={(e) => (hiddenPlugins = { ...hiddenPlugins, [pid]: !e.currentTarget.checked })}
                    />
                    {S.common.chipPlugin} · {pid}</label
                  >
                {/each}
                <label class="filt-check"
                  ><input type="checkbox" checked={showCustom} onchange={(e) => (showCustom = e.currentTarget.checked)} />
                  {S.componentbuilder.filterCustom}</label
                >
              </div>
              <div class="bld-filter-group" role="group" aria-label={S.componentbuilder.viewLabel}>
                <span class="filt-lab">{S.componentbuilder.viewLabel}</span>
                <label class="filt-check"
                  ><input type="checkbox" checked={showMatchView} onchange={(e) => (showMatchView = e.currentTarget.checked)} />
                  {S.common.chipViewMatch}</label
                >
                <label class="filt-check"
                  ><input type="checkbox" checked={showProfileView} onchange={(e) => (showProfileView = e.currentTarget.checked)} />
                  {S.common.chipViewProfile}</label
                >
                <label class="filt-check"
                  ><input type="checkbox" checked={showNoView} onchange={(e) => (showNoView = e.currentTarget.checked)} />
                  {S.componentbuilder.filterNoView}</label
                >
              </div>
            </div>
          </Popover>
        </span>
      </div>
      <div class="cb-scroll">
      <span class="field-label">{S.componentbuilder.builtinGroup}</span>
      <div class="cb-rows cb-builtins">
        {#each shownBuiltins as b (b.id)}
          {@render row(
            b.label,
            form.builtinId === b.id,
            [
              { text: S.common.chipBuiltin, tone: 'accent', title: S.componentbuilder.builtinReadOnly },
              ...placedChips(b.id),
              ...(Object.hasOwn(overrides, b.id)
                ? [{ text: S.common.chipEdited, title: S.common.chipEditedTitle }]
                : []),
            ],
            () => editBuiltin(b),
            null,
          )}
        {/each}
      </div>
      <span class="field-label">{S.componentbuilder.yoursGroup}</span>
      <LoadBox tag="div" class="cb-yours-body" busy={listState.busy} key={listState.key} name="view:componentbuilder">
      {#if userComponents.length === 0}
        {#if listState.pending > 0}
          <p class="muted" role="status">{S.componentbuilder.loadingList}</p>
        {:else}
          <p class="muted" role="status">{S.componentbuilder.noUserComponents}</p>
        {/if}
      {:else}
        <div class="cb-rows cb-yours">
          {#each shownComponents as c (c.name)}
            {@render row(c.name, form.original === c.name, placedChips(c.name), () => editComponent(c), () => remove(c.name))}
          {/each}
        </div>
      {/if}
      {#if pluginComponents.length > 0}
        <span class="field-label">{S.componentbuilder.pluginsGroup}</span>
        <div class="cb-rows cb-plugins">
          {#each shownPluginComponents as c (c.name)}
            {@render row(
              c.name,
              form.pluginOf === c.pluginId && form.name === c.name,
              [{ text: S.common.chipPlugin, tone: 'plugin', title: c.pluginId }, ...placedChips(c.name)],
              () => editPluginComponent(c),
              null,
            )}
          {/each}
        </div>
      {/if}
      </LoadBox>
      </div>
    </section>

    <div class="cb-main" use:fillHeight>
    <section class="panel cb-editor" class:editor-expanded={editorPanel.on}>
      <div class="row-between">
        <h2>{form.original || builtin ? S.componentbuilder.editComponent : S.componentbuilder.newComponent}</h2>
        <div class="toolbar">
          {#if builtin}
            <Chip tone="accent" title={S.componentbuilder.builtinReadOnly}>{S.common.chipBuiltin}</Chip>
          {/if}
          {#if form.pluginOf}
            <Chip tone="accent" title={S.componentbuilder.pluginReadOnly}>{S.common.chipReadOnly}</Chip>
          {/if}
          {#each placedChips(viewTarget) as c (c.text)}
            <Chip tone={c.tone} title={c.title}>{c.text}</Chip>
          {/each}
          <!-- The expand toggle belongs to the card: the whole editor takes the window. -->
          <button
            type="button"
            class="btn small card-expand"
            aria-label={editorPanel.on ? S.common.collapseEditor : S.common.expandEditor}
            title={editorPanel.on ? S.common.collapseEditor : S.common.expandEditor}
            aria-expanded={editorPanel.on}
            onclick={editorPanel.toggle}
          >
            <span class="codicon codicon-{editorPanel.on ? 'screen-normal' : 'screen-full'}"></span>
          </button>
        </div>
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
        <SourceEditor
          id="cb-source"
          cls="cb-source"
          language="javascript"
          rows={22}
          expandable={false}
          fill
          readonly={!!form.pluginOf}
          ariaLabel={S.componentbuilder.fieldSource}
          bind:value={form.source}
          completions={componentCompletions}
        />
      </div>
      <div class="cb-check">
        {#if check.status === 'pending'}
          <span class="validity muted" role="status">{S.componentbuilder.checking}</span>
        {:else if check.status === 'ok'}
          <span class="validity ok" role="status"><span class="codicon codicon-check" aria-hidden="true"></span> {S.componentbuilder.checkOk}</span>
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
        <span class="toolbar">
          {#if viewTarget}
            <span class="cb-use-wrap" bind:this={viewWrap}>
              <button
                class="btn cb-use-view"
                onclick={() => (viewMenuOpen = !viewMenuOpen)}
                disabled={viewBusy}
                aria-haspopup="menu"
                aria-expanded={viewMenuOpen}>{S.componentbuilder.useAsView}</button
              >
              <Popover open={viewMenuOpen} anchor={viewWrap} onClose={closeViewMenu}>
                <div class="cb-use-pop" role="menu">
                  {#each VIEW_SURFACES as v (v.surface)}
                    <button class="btn small" role="menuitem" disabled={viewBusy} onclick={() => chooseView(v.surface)}
                      >{v.label}{placements[v.surface][0]?.component === viewTarget ? ' ✓' : ''}</button
                    >
                  {/each}
                </div>
              </Popover>
            </span>
          {/if}
          {#if builtin}
            <button
              class="btn cb-restore"
              onclick={restoreDefault}
              disabled={saving || !overridden}
              title={S.componentbuilder.restoreTitle}
              >{S.componentbuilder.restoreDefault}</button
            >
          {/if}
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
          {#if compiling}
            <button
              class="btn cb-cancel"
              onclick={() => cancelCompiles()}
              title={S.componentbuilder.cancelCompileTitle}>{S.componentbuilder.cancelCompile}</button
            >
          {/if}
          <!-- The preview target: the context Preview renders against. -->
  <div class="cb-context" role="group" aria-label={S.componentbuilder.contextLabel}>
    <!-- The controls name themselves: "A match" / "A player" in the select, and the picker's own "Select …" text. -->
    <select id="cb-context" class="input" aria-label={S.componentbuilder.contextLabel} bind:value={contextKind}>
      <option value="match">{S.componentbuilder.contextMatch}</option>
      <option value="player">{S.componentbuilder.contextPlayer}</option>
    </select>
    {#if contextKind === 'match'}
      <MatchPicker {matches} value={matchId} id="cb-match" onselect={(mid) => (matchId = mid)} />
    {:else}
      <PlayerPicker {players} value={steamId} id="cb-player" onselect={(sid) => (steamId = sid)} />
    {/if}
  </div>
                    <button
            class="btn"
            onclick={() => (previewOpen = true)}
            disabled={previewSource == null}
            title={S.componentbuilder.previewHeading}
          >
            <span class="codicon codicon-play" aria-hidden="true"></span>
            {S.componentbuilder.previewHeading}
          </button>
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

    <PreviewOverlay open={previewOpen} title={S.componentbuilder.previewHeading} onClose={() => (previewOpen = false)}>
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
    </PreviewOverlay>
    </div>
  </div>
</div>

<style>
  /* The builders share one list column width; the list fills the view height and its rows scroll. */
  .cb-grid {
    display: grid;
    grid-template-columns: minmax(250px, 330px) minmax(0, 1fr);
    gap: 16px;
    align-items: start;
  }
  .cb-list,
  .cb-editor {
    min-width: 0;
  }
  /* The list fills the view height (the fillHeight action); its rows scroll inside it. */
  .cb-list {
    display: flex;
    flex-direction: column;
  }
  /* The list body scrolls; the filter and the list header stay put above it. */
  .cb-scroll {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }
  /* The editor card is the whole column; Preview opens full screen (PreviewOverlay). */
  .cb-main {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
  }
  /* The main column fills the content height (fillHeight): the editor card takes it all, and its
     source fills the card (.source-wrap.fill). */
  .cb-main > .cb-editor {
    flex: 1 1 auto;
    min-height: 0;
    overflow: visible; /* the use-as-view menu and the pickers' lists float over the card */
  }
  .cb-source-field {
    flex: 1 1 auto;
    min-height: 0;
  }
  @media (max-width: 1000px) {
    .cb-main > .cb-editor {
      flex: none;
      overflow: visible;
    }
  }
  .cb-use-wrap {
    position: relative;
    display: inline-block;
  }
  /* The menu floats below the button (the Popover only shows or hides its children, so the
     panel is positioned here, the same way the combat kind popover floats). */
  .cb-use-pop {
    position: absolute;
    top: auto;
    bottom: calc(100% + 4px);
    left: 0;
    z-index: 30;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px;
    min-width: 180px;
    background: var(--widget-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
  }
  .cb-rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .cb-row-title {
    overflow-wrap: anywhere;
  }
  /* A component that is the user's current match or profile view: an accent chip in the list. */
  .cb-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .cb-actions {
    flex-wrap: wrap;
    gap: 8px;
  }
  /* The context kind and its target picker sit on one line (wrapping only when the panel is narrow). */
  .cb-context {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  /* The context controls take only the room their text needs. */
  .cb-context > select.input {
    width: auto;
    flex: 0 0 auto;
  }
  .cb-context > :global(.mp),
  .cb-context > :global(.pp) {
    flex: 0 0 auto;
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
