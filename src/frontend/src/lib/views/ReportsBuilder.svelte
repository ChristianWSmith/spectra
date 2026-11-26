<script>
  import SourceEditor from '../components/SourceEditor.svelte';
  import PreviewOverlay from '../components/PreviewOverlay.svelte';
  import Chip from '../components/Chip.svelte';
  import Popover from '../components/Popover.svelte';
  import { templateItems } from '../editor/templateCompletions.js';
  import { reportFields } from '../editor/completionSources.js';
  import { fillHeight } from '../fillheight.js';
  import { expandable } from '../expandable.svelte.js';
  const editorPanel = expandable();
  // The preview renders full screen (PreviewOverlay) from the Preview control on the editor card.
  let previewOpen = $state(false);
  // The Reports builder — the template AUTHORING surface (the sibling
  // Reports view only CONSUMES templates). Two panels over the Builder's
  // layout (views/Builder.svelte's .bld-grid): a plain list of every
  // template on the left, the editor + its live preview on the right.
  //
  // Ownership rules copied from the metric editor, not reinvented:
  //   * a BUILT-IN edits in place (owner ruling 44): only its text is
  //     editable, Save stores it as the built-in's override, and Restore to
  //     default deletes the override. Its title, scope and format stay as
  //     shipped. A PLUGIN row forks on save (payload id "" — Builder's
  //     `id: 0` payload), a USER row edits in place and is the only one
  //     with a delete;
  //   * validation is SERVER-side only (SaveReportTemplate re-checks
  //     scope/format/title/body) — one gate, never a second frontend
  //     copy that could drift from it;
  //   * the template list is fetched whole and narrowed HERE (client
  //     side): templates number in single digits, so the Builder's
  //     server-side windowing + cursor machinery would buy nothing.
  import * as S from '../strings/index.js';
  import {
    listReportTemplates,
    saveReportTemplate,
    deleteReportTemplate,
    saveBuiltinReport,
    restoreBuiltinReport,
    renderReportDraft,
    listMatches,
    listPlayers,
    getRounds,
    errText,
  } from '../services.js';
  import { listedPlayers } from '../players.js';
  import MatchPicker from '../components/MatchPicker.svelte';
  import LoadBox from '../components/LoadBox.svelte';
  import PlayerPicker from '../components/PlayerPicker.svelte';
  import HelpButton from '../components/HelpButton.svelte';
  import { seed, remember } from '../viewstate.svelte.js';

  let { openDocs = () => {} } = $props();

  // The editor form + dirty baseline, the list's search text and origin
  // checkboxes, and the preview TARGET are view-local working state:
  // they restore across navigation through the process-scoped registry
  // (viewstate.svelte.js — flat key, Builder's pattern at
  // `seed('builder', …)`). The URL is untouched (nothing here is
  // shareable or durable); dialogs and the composed preview document
  // stay transient and never restore.
  function newForm() {
    return { id: '', title: '', scope: 'match', format: 'md', body: '', origin: 'user', edited: false };
  }

  // The dirty check covers exactly the fields a save writes — id and
  // origin are the row's IDENTITY, never its content (Builder's
  // `snapshot`).
  function snapshot(f) {
    return JSON.stringify({ title: f.title, scope: f.scope, format: f.format, body: f.body });
  }

  const rbSeed = seed('reportbuilder', {
    form: newForm(),
    baseline: '',
    query: '',
    // The origin group starts UNFILTERED (every box on): the catalog is
    // single-digit, so the first render shows built-ins, yours and
    // plugins together — a filter narrows it from there.
    showBuiltin: true,
    showYours: true,
    showPlugin: true,
    // The format and scope filters start with every box on, like the origin group.
    showMd: true,
    showHtml: true,
    showMatch: true,
    showPlayer: true,
    showRound: true,
    showProfile: true,
    // The preview target is NEVER chosen for you (the owner's rule): it
    // starts empty and Preview stays disabled until the user picks one.
    matchId: 0,
    steamId: '',
    roundNo: 1,
  });
  let form = $state(rbSeed.form);
  let baseline = $state(rbSeed.baseline);
  let query = $state(rbSeed.query);
  let showBuiltin = $state(rbSeed.showBuiltin);
  let showYours = $state(rbSeed.showYours);
  let showPlugin = $state(rbSeed.showPlugin);
  let showMd = $state(rbSeed.showMd);
  let showHtml = $state(rbSeed.showHtml);
  let showMatch = $state(rbSeed.showMatch);
  let showPlayer = $state(rbSeed.showPlayer);
  let showRound = $state(rbSeed.showRound);
  let showProfile = $state(rbSeed.showProfile);
  // The filter dropdown (the metric builder's): open state and the popover's anchor and trigger.
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
  let matchId = $state(rbSeed.matchId);
  let steamId = $state(rbSeed.steamId);
  let roundNo = $state(rbSeed.roundNo);
  $effect(() =>
    remember('reportbuilder', {
      form,
      baseline,
      query,
      showBuiltin,
      showYours,
      showPlugin,
      showMd,
      showHtml,
      showMatch,
      showPlayer,
      showRound,
      showProfile,
      matchId,
      steamId,
      roundNo,
    }),
  );

  // Transient by State placement: the composed preview document, busy
  // flags and error slots never restore (a dialog-class value).
  let templates = $state([]);
  let loading = $state(true);
  let listError = $state('');
  let pickerError = $state('');
  let saveError = $state('');
  let saving = $state(false);
  let preview = $state(null); // rendered draft text, null = nothing run yet
  let previewError = $state('');
  let previewBusy = $state(false);

  // --- The list --------------------------------------------------------------

  async function refreshList() {
    loading = true;
    try {
      templates = (await listReportTemplates()) || [];
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

  // Self-heal: an editor pointing at a template that no longer exists
  // (deleted in another view, a plugin uninstalled) falls back to a fresh
  // editor instead of editing a phantom. Gated on a SUCCESSFUL read — a
  // failed or in-flight list never wipes what is on screen — and it
  // terminates because the fallback clears the id this effect reads.
  $effect(() => {
    const id = form.id;
    if (!id || form.origin !== 'user' || loading || listError) return;
    if (!templates.some((t) => t.id === id)) newTemplate();
  });

  // visibleTemplates — the whole catalog narrowed in render (see the
  // header note): the origin, format and scope filters + a title search, all client-side.
  const visibleTemplates = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return templates.filter((t) => {
      const o = t.origin || 'builtin';
      if (o === 'builtin' && !showBuiltin) return false;
      if (o === 'user' && !showYours) return false;
      if (o === 'plugin' && !showPlugin) return false;
      if (t.format === 'html' ? !showHtml : !showMd) return false;
      const sc = t.scope;
      if (sc === 'match' && !showMatch) return false;
      if (sc === 'player' && !showPlayer) return false;
      if (sc === 'round' && !showRound) return false;
      if (sc === 'profile' && !showProfile) return false;
      if (q && !String(t.title || '').toLowerCase().includes(q)) return false;
      return true;
    });
  });

  // --- The editor ------------------------------------------------------------

  const dirty = $derived(snapshot(form) !== baseline);
  // readOnly / builtinLoaded — the metric editor's rule verbatim
  // (Builder.svelte `readOnly` / `saveDisabled`): a plugin row forks on
  // save, a built-in is not savable at all, both wear the read-only chip
  // and neither ever shows a delete.
  const readOnly = $derived(form.origin !== 'user');
  const builtinLoaded = $derived(form.origin === 'builtin');
  // A built-in saves only an edit of its text (owner ruling 44): Save is
  // off until the body is dirty. A plugin row always saves (it forks).
  const saveDisabled = $derived(saving || (builtinLoaded && !dirty));

  function editTemplate(t) {
    form = {
      id: t.id,
      title: t.title || '',
      scope: t.scope || 'match',
      format: t.format || 'md',
      body: t.body || '',
      origin: t.origin || 'builtin',
      edited: !!t.edited,
    };
    baseline = snapshot(form);
    saveError = '';
  }

  function newTemplate() {
    form = newForm();
    baseline = snapshot(form);
    saveError = '';
  }

  async function save() {
    saveError = '';
    saving = true;
    try {
      // A BUILT-IN saves its edited text as its override (owner ruling 44);
      // the service refuses everything else about it, which stays shipped.
      if (builtinLoaded) {
        const edit = await saveBuiltinReport(form.id, form.body);
        form.edited = edit.edited;
        form.body = edit.body;
        baseline = snapshot(form);
        await refreshList();
        return;
      }
      // A PLUGIN row forks — an empty id tells the service to mint a new
      // user row, exactly the metric editor's `id: 0` payload rule. Every
      // field is re-validated server-side; the frontend sends, Go decides.
      const saved = await saveReportTemplate({
        id: readOnly ? '' : form.id,
        title: form.title,
        scope: form.scope,
        format: form.format,
        body: form.body,
        origin: 'user',
      });
      form.id = saved.id;
      form.origin = saved.origin;
      form.title = saved.title;
      baseline = snapshot(form);
      await refreshList();
    } catch (e) {
      saveError = errText(e);
    } finally {
      saving = false;
    }
  }

  // Delete is the USER-row control (the row's trash glyph and the
  // editor's bottom-left button — positive actions stay right): built-ins
  // are guarded server-side and plugins belong to their bundle, so
  // neither ever offers one (Builder's removeMetric precedent — no
  // confirm dialog on a template either).
  async function remove(t) {
    saveError = '';
    try {
      await deleteReportTemplate(t.id);
      if (form.id === t.id) newTemplate();
      await refreshList();
    } catch (e) {
      saveError = errText(e);
    }
  }

  // Restore to default (owner ruling 44): the built-in's override is deleted
  // and the editor shows the shipped text again.
  async function restoreBuiltin() {
    saveError = '';
    saving = true;
    try {
      const shipped = await restoreBuiltinReport(form.id);
      editTemplate(shipped);
      await refreshList();
    } catch (e) {
      saveError = errText(e);
    } finally {
      saving = false;
    }
  }

  // --- The preview -----------------------------------------------------------

  // targetReady — THE gate: the draft renders against a real target the
  // user picked, never a fabricated default (no newest-match fallback —
  // match for every scope, plus a player / a round where the scope
  // addresses one).
  const targetReady = $derived.by(() => {
    if (form.scope === 'profile') return steamId !== '';
    if (!(matchId > 0)) return false;
    if (form.scope === 'player') return steamId !== '';
    if (form.scope === 'round') return roundNo >= 1;
    return true;
  });
  const previewDisabled = $derived(previewBusy || !targetReady || form.body.trim() === '');

  // Any change to the draft or its target invalidates the composed
  // document: a stale preview must never sit on screen passing as the
  // current body (the button re-runs it). previewGen tags the sequence —
  // a draft edit while a render is in flight drops that reply instead of
  // letting it land on the newer body.
  let previewGen = 0;
  $effect(() => {
    form.body;
    form.scope;
    matchId;
    steamId;
    roundNo;
    previewGen += 1;
    preview = null;
    previewError = '';
  });

  async function runPreview() {
    const gen = previewGen;
    previewOpen = true;
    previewError = '';
    previewBusy = true;
    try {
      const text = await renderReportDraft(form.scope, form.body, matchId, steamId, roundNo);
      if (gen !== previewGen) return; // the draft changed while this ran
      preview = text;
    } catch (e) {
      if (gen === previewGen) {
        preview = null;
        previewError = errText(e);
      }
    } finally {
      previewBusy = false;
    }
  }

  // --- The preview target's reads -------------------------------------------

  // The match list, read the way Reports reads it (ready rows first, the
  // newest first) — but nothing is preselected: the target starts empty.
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

  // The player list for a player-scoped draft, bot-filtered through the
  // canonical selection helper (players.js listedPlayers — every roster
  // read routes through it).
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

  // The round bound for a round-scoped draft — read only while the scope
  // addresses one, so the field can state the counted range instead of
  // guessing it (knife/warmup rounds are negative, hence max(1, …)).
  let rounds = $state([]);
  $effect(() => {
    const id = matchId;
    if (id > 0 && form.scope === 'round') {
      getRounds(id)
        .then((rs) => {
          rounds = rs || [];
          const maxRound = (rs || []).reduce((m, r) => Math.max(m, r.number), 0);
          if (roundNo > maxRound) roundNo = Math.max(1, maxRound);
        })
        .catch(() => {
          rounds = [];
        });
      return;
    }
    rounds = [];
  });
  const maxRound = $derived(rounds.reduce((m, r) => Math.max(m, r.number), 0));
  // The body's completions: the template functions and keywords, and the fields of
  // the data the form's scope renders against.
  async function bodyCompletions() {
    return templateItems({ fields: await reportFields(form.scope) });
  }
</script>
<!-- Escape collapses whichever card is expanded (each key handler checks its own). -->
<svelte:window
  onkeydown={(e) => {
    editorPanel.key(e);
  }}
/>

{#snippet templateRow(t)}
  <div class="rb-row" class:active={form.id === t.id}>
    <!-- Every stored row loads into the editor: a user row edits, a
         plugin row forks, a BUILT-IN edits in place (owner ruling 44:
         its text is saved as an override, restore brings it back).
         Delete stays user-only. -->
    <button class="rb-row-main" onclick={() => editTemplate(t)}>
      <span class="rb-row-title">{t.title}</span>
      <span class="rb-row-sub">
        <Chip>{t.scope}</Chip>
        <Chip>{t.format}</Chip>
        <!-- The origin marker: a built-in and a plugin row say so; a user's own row carries none. -->
        {#if t.origin === 'builtin'}
          <Chip tone="accent">{S.common.chipBuiltin}</Chip>
        {:else if t.origin === 'plugin'}
          <Chip tone="plugin">{S.common.chipPlugin}</Chip>
        {/if}
        {#if t.edited}
          <Chip title={S.common.chipEditedTitle}>{S.common.chipEdited}</Chip>
        {/if}
      </span>
    </button>
    <span class="rb-row-acts">
      {#if t.origin === 'user'}
        <button
          class="btn small ghost"
          title={S.reportbuilder.deleteTemplate}
          aria-label={S.fill(S.reportbuilder.deleteAria, { name: t.title })}
          onclick={() => remove(t)}
          ><span class="codicon codicon-trash" aria-hidden="true"></span></button
        >
      {/if}
    </span>
  </div>
{/snippet}

<div class="view rb-view">
  <header class="view-header">
    <h1>{S.reportbuilder.heading}</h1>
    <p class="muted rb-head-note">{S.reportbuilder.headNote}</p>
    <div class="spacer"></div>
    <HelpButton section="reports-builder" {openDocs} />
  </header>

  {#if pickerError}
    <p class="error" role="alert">
      {pickerError}
      <button class="btn small ghost" aria-label={S.common.dismissErrorLine} title={S.common.dismissErrorLine} onclick={() => (pickerError = '')}><span class="codicon codicon-close" aria-hidden="true"></span></button>
    </p>
  {/if}
  {#if listError}
    <p class="error" role="alert">
      {listError}
      <button class="btn small" onclick={refreshList}>{S.reportbuilder.retry}</button>
    </p>
  {/if}
  {#if saveError}
    <p class="error" role="alert">{saveError}</p>
  {/if}

  <div class="rb-grid">
    <section class="panel rb-list" use:fillHeight>
      <div class="row-between">
        <h2>{S.reportbuilder.templatesHeading}</h2>
        <button class="btn small" onclick={newTemplate}
          ><span class="codicon codicon-add" aria-hidden="true"></span>
          {S.reportbuilder.newLabel}</button
        >
      </div>
      <div class="bld-search-row">
        <input
          class="input bld-search"
          type="search"
          aria-label={S.reportbuilder.searchAria}
          placeholder={S.reportbuilder.searchPlaceholder}
          bind:value={query}
        />
        <span class="bld-filter-host" bind:this={filterAnchor}>
          <button
            type="button"
            class="btn small bld-filter-btn"
            class:multi-open={filterOpen}
            bind:this={filterTrigger}
            aria-haspopup="true"
            aria-expanded={filterOpen}
            aria-controls={filterOpen ? 'rb-filter-pop' : null}
            aria-label={S.common.filtersLabel}
            title={S.common.filtersTitle}
            onclick={() => (filterOpen = !filterOpen)}
          >
            <span class="codicon codicon-filter" aria-hidden="true"></span>
            <span class="codicon codicon-chevron-{filterOpen ? 'up' : 'down'}" aria-hidden="true"></span>
          </button>
          <Popover open={filterOpen} anchor={filterAnchor} onClose={closeFilters} onOutside={closeFiltersOutside}>
            <div class="bld-filter-pop" id="rb-filter-pop" role="group" aria-label={S.common.filtersLabel}>
              <div class="bld-filter-group" role="group" aria-label={S.reportbuilder.originLabel}>
                <span class="filt-lab">{S.reportbuilder.originLabel}</span>
                <label class="filt-check"
                  ><input type="checkbox" checked={showBuiltin} onchange={(e) => (showBuiltin = e.currentTarget.checked)} />
                  {S.reportbuilder.filterBuiltIn}</label
                >
                <label class="filt-check"
                  ><input type="checkbox" checked={showYours} onchange={(e) => (showYours = e.currentTarget.checked)} />
                  {S.reportbuilder.filterCustom}</label
                >
                <label class="filt-check"
                  ><input type="checkbox" checked={showPlugin} onchange={(e) => (showPlugin = e.currentTarget.checked)} />
                  {S.reportbuilder.filterPlugin}</label
                >
              </div>
              <div class="bld-filter-group" role="group" aria-label={S.reportbuilder.fieldFormat}>
                <span class="filt-lab">{S.reportbuilder.fieldFormat}</span>
                <label class="filt-check"
                  ><input type="checkbox" checked={showMd} onchange={(e) => (showMd = e.currentTarget.checked)} />
                  {S.reportbuilder.filterFormatMd}</label
                >
                <label class="filt-check"
                  ><input type="checkbox" checked={showHtml} onchange={(e) => (showHtml = e.currentTarget.checked)} />
                  {S.reportbuilder.filterFormatHtml}</label
                >
              </div>
              <div class="bld-filter-group" role="group" aria-label={S.reportbuilder.fieldScope}>
                <span class="filt-lab">{S.reportbuilder.fieldScope}</span>
                <label class="filt-check"
                  ><input type="checkbox" checked={showMatch} onchange={(e) => (showMatch = e.currentTarget.checked)} />
                  {S.reportbuilder.filterScopeMatch}</label
                >
                <label class="filt-check"
                  ><input type="checkbox" checked={showPlayer} onchange={(e) => (showPlayer = e.currentTarget.checked)} />
                  {S.reportbuilder.filterScopePlayer}</label
                >
                <label class="filt-check"
                  ><input type="checkbox" checked={showRound} onchange={(e) => (showRound = e.currentTarget.checked)} />
                  {S.reportbuilder.filterScopeRound}</label
                >
                <label class="filt-check"
                  ><input type="checkbox" checked={showProfile} onchange={(e) => (showProfile = e.currentTarget.checked)} />
                  {S.reportbuilder.filterScopeProfile}</label
                >
              </div>
            </div>
          </Popover>
        </span>
      </div>

      {#if visibleTemplates.length === 0}
        {#if loading && templates.length === 0}
          <LoadBox tag="div" class="rb-hold" busy name="reports-templates" key=""></LoadBox>
        {:else if query.trim()}
          <!-- A search that matches nothing names the query — the only
               empty state that has one to name. -->
          <p class="muted" role="status">
            {S.fill(S.reportbuilder.noTemplatesMatch, { q: query })}
          </p>
        {:else}
          <!-- The catalog is empty OR the origin group hides every row:
               the same honest "nothing to show", never a blank panel. -->
          <p class="muted" role="status">{S.reportbuilder.noTemplatesToShow}</p>
        {/if}
      {:else}
        <div class="rb-rows">
          {#each visibleTemplates as t (t.id)}
            {@render templateRow(t)}
          {/each}
        </div>
      {/if}
    </section>

    <div class="rb-right" use:fillHeight>
      <section class="panel rb-editor" class:editor-expanded={editorPanel.on}>
        <div class="row-between">
          <h2>{form.id ? S.reportbuilder.editTemplate : S.reportbuilder.newTemplate}</h2>
          <div class="toolbar">
          {#if builtinLoaded}
            <!-- A built-in edits in place (owner ruling 44): the chip names
                 it in the user's words, and an edit shows beside it. -->
            <Chip tone="accent" title={S.reportbuilder.builtinEditNote}>{S.common.chipBuiltin}</Chip>
            {#if form.edited}
              <Chip title={S.common.chipEditedTitle}>{S.common.chipEdited}</Chip>
            {/if}
          {:else if readOnly}
            <!-- Plugin rows: immutable through Save — saving stores a
                 copy of this template as your own. -->
            <Chip tone="accent" title={S.reportbuilder.pluginImmutable}>{S.common.chipReadOnly}</Chip>
          {/if}
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

        <!-- readonly, never disabled, on the text fields — a read-only
             source stays selectable and copyable while editing is
             blocked (the metric editor's WebKit rule); the selects take
             disabled instead: a dropdown is not a copy surface. -->
        <div class="rb-fields">
          <div class="rb-field">
            <label class="field-label" for="rb-title">{S.reportbuilder.fieldTitle}</label>
            <input
              id="rb-title"
              class="input"
              bind:value={form.title}
              placeholder={S.reportbuilder.titlePlaceholder}
              readonly={builtinLoaded}
            />
          </div>
          <div class="rb-field">
            <label class="field-label" for="rb-scope">{S.reportbuilder.fieldScope}</label>
            <select id="rb-scope" class="input" bind:value={form.scope} disabled={builtinLoaded}>
              <option value="match">{S.reportbuilder.scopeMatchOption}</option>
              <option value="player">{S.reportbuilder.scopePlayerOption}</option>
              <option value="round">{S.reportbuilder.scopeRoundOption}</option>
              <option value="profile">{S.reportbuilder.scopeProfileOption}</option>
            </select>
          </div>
          <div class="rb-field">
            <label class="field-label" for="rb-format">{S.reportbuilder.fieldFormat}</label>
            <select id="rb-format" class="input" bind:value={form.format} disabled={builtinLoaded}>
              <option value="md">md</option>
              <option value="html">html</option>
            </select>
          </div>
          <!-- The body is a POWER surface (template source), so it takes
               no chrome placeholder and is exempt from the copy tiers —
               monospace, spellcheck off, never a hint over its grammar. -->
          <div class="rb-field wide">
            <label class="field-label" for="rb-body">{S.reportbuilder.fieldBody}</label>
            <SourceEditor
              id="rb-body"
              cls="rb-body"
              language="gotemplate"
              rows={10}
              expandable={false}
              fill
              ariaLabel={S.reportbuilder.fieldBody}
              bind:value={form.body}
              completions={bodyCompletions}
            />
          </div>
        </div>

        <!-- ONE actions line: the destructive control sits LEFT, Save
             right. The preview's target and its Preview button live in
             the preview card — they only drive the preview. -->
        <div class="row-between rb-actions">
          <span class="rb-left">
            <span class="rb-destructive">
            {#if builtinLoaded && form.edited}
              <button class="btn" onclick={restoreBuiltin} title={S.reportbuilder.restoreTitle}
                >{S.reportbuilder.restoreDefault}</button
              >
            {/if}
            {#if form.origin === 'user' && form.id}
              <button
                class="btn danger"
                onclick={() => remove({ id: form.id, title: form.title })}
                title={S.reportbuilder.deleteTemplate}
                aria-label={S.fill(S.reportbuilder.deleteAria, { name: form.title })}
                ><span class="codicon codicon-trash" aria-hidden="true"></span>
                {S.reportbuilder.deleteTemplate}</button
              >
            {/if}
          </span>
          </span>
          <span class="toolbar rb-bottom">
            <!-- The preview target: the match, and the player or round the scope needs. -->
    <span class="rb-targets" role="group" aria-label={S.reportbuilder.targetHeading}>
      <span class="rb-target-row">
        <!-- The controls name themselves: the match picker says "Select match…", the player
             picker "Select player…", and the round box carries its label and range. -->
        {#if form.scope !== 'profile'}
          <MatchPicker
            {matches}
            value={matchId}
            id="rb-match"
            onselect={(mid) => (matchId = mid)}
          />
        {/if}
        {#if form.scope === 'player' || form.scope === 'profile'}
          <PlayerPicker
            onerror={(e) => (pickerError = errText(e))}
            {players}
            value={steamId}
            id="rb-player"
            onselect={(sid) => (steamId = sid)}
          />
        {/if}
        {#if form.scope === 'round'}
          <input
            class="input rb-round"
            id="rb-round"
            type="number"
            min="1"
            max={Math.max(1, maxRound)}
            aria-label={S.reportbuilder.roundLabel}
            placeholder={maxRound > 0 ? S.fill(S.reportbuilder.roundPlaceholder, { max: maxRound }) : S.reportbuilder.roundPlaceholderNone}
            bind:value={roundNo}
          />
        {/if}
      </span>
    </span>
            <button class="btn" onclick={runPreview} disabled={previewDisabled}
              ><span class="codicon codicon-play" aria-hidden="true"></span>
              {previewBusy ? S.reportbuilder.running : S.reportbuilder.preview}</button
            >
            <button
              class="btn primary"
              onclick={save}
              disabled={saveDisabled}
            >
              <span class="codicon codicon-save" aria-hidden="true"></span>
              {saving
                ? S.reportbuilder.saving
                : (!readOnly || builtinLoaded) && form.id && !dirty
                  ? S.reportbuilder.saved
                  : S.reportbuilder.saveTemplate}
            </button>
          </span>
        </div>
      </section>

      <PreviewOverlay open={previewOpen} title={S.reportbuilder.previewHeading} onClose={() => (previewOpen = false)}>
      {#if previewError}
        <p class="error" role="alert">{previewError}</p>
      {:else if preview !== null}
        <!-- The composed document exactly as it renders — md or html
             source, the same bytes Save + Reports would write. -->
        <pre class="mono rb-doc">{preview}</pre>
      {:else if !targetReady}
        <p class="muted" role="status">{S.reportbuilder.targetNeeded}</p>
      {:else}
        <p class="muted" role="status">{S.reportbuilder.noPreviewYet}</p>
      {/if}
      </PreviewOverlay>
    </div>
  </div>
</div>
