<script>
  import { fillHeight } from '../fillheight.js';
  import * as S from '../strings/index.js';
  import SourceEditor from '../components/SourceEditor.svelte';
  import { expandable } from '../expandable.svelte.js';
  import PreviewOverlay from '../components/PreviewOverlay.svelte';
  // The Statement card expands to the window (the toggle in its header).
  const statementPanel = expandable();
  // The run's results open full screen (PreviewOverlay) when a run returns rows.
  let resultsOpen = $state(false);
  import { sqlItems } from '../editor/sqlCompletions.js';
  import { consoleTables } from '../editor/completionSources.js';
  import { createLoadState } from '../loadstate.svelte.js';
  import LoadBox from '../components/LoadBox.svelte';
  import {
    runQuery,
    getSchema,
    listSavedQueriesPage,
    saveQuery,
    updateQuery,
    deleteQuery,
    listQueryHistory,
    deleteQueryHistory,
    clearQueryHistory,
    errText,
  } from '../services.js';
  import { downloadText } from '../download.js';
  import { toCSV } from '../csv.js';
  import { seed, remember } from '../viewstate.svelte.js';
  import HelpButton from '../components/HelpButton.svelte';
  import Popover from '../components/Popover.svelte';

  let { nav = () => {}, openDocs = () => {} } = $props();

  // Server defaults echoed in the header (store.DefaultRowLimit / DefaultTimeoutMS).
  const DEFAULTS = 'rows cap 5,000 · timeout 5 s';
  // Results page size: the grid renders ONE page of returned rows at a
  // time and the footer walks every row (there is no render cap and no
  // "first N rows" note — exports already carry the whole result, and
  // the server cap is the only truncation). The page index is TRANSIENT
  // view-local state: never the registry, never the route query (State
  // placement) — it resets to page 1 on every run.
  const RESULT_PAGE = 10;
  // Tooltip cap for the list rows' title attributes: the full statement
  // loads into the editor on click, so a hover preview never puts a
  // multi-MB raw SQL string into a DOM attribute (cellTitle gates on
  // length, this bounds what survives the gate).
  const SQL_TITLE_CAP = 500;

  let schema = $state([]);
  let schemaError = $state('');
  let openTables = $state({});

  let editor = $state(null);
  // The draft query is view-local state: it survives leaving and coming
  // back through the process-scoped registry (viewstate.svelte.js — flat
  // key; results/errors/history stay transient and never restore).
  const sqlDraft = seed('sql', { sql: '' });
  let sql = $state(sqlDraft.sql);
  $effect(() => remember('sql', { sql }));

  let result = $state(null);
  // Which page of `result` the grid shows — transient view-local state
  // (never the registry, never the route query): reset to 1 on every run.
  let resultPage = $state(1);
  let runError = $state('');
  let running = $state(false);
  let slow = $state(false);

  let history = $state([]);
  let historyError = $state('');
  // Saved list: ONE keyset window per fetch (SAVED_PAGE) — the console's
  // "Load more" (store.ListSavedQueriesPage): savedHasNext is the
  // backend's limit+1 probe and the cursor is the last rendered row's
  // name. These are plain view-local $state like Library's window state:
  // every mount refetches the first window, so nothing here is seeded or
  // remembered (State placement — transient window state, never in the
  // registry or the URL).
  const SAVED_PAGE = 50;
  let saved = $state([]);
  let savedHasNext = $state(false);
  let loadingMore = $state(false);
  let savedError = $state('');
  let saveName = $state('');
  let saveDescription = $state('');
  let saveError = $state('');
  // saveTarget is the SAVE TIE: {id, name} of the saved row the editor
  // fields were loaded from (or last produced). Null = a fresh editor →
  // Save inserts. Loading a saved row sets it; editing its SQL keeps it
  // (no handler clears it on edit). Loading a HISTORY line clears it
  // (loadHistory — a history line starts a fresh save form, so a stale
  // tie can never turn Save into a silent UPDATE of another row).
  // Routing lives in saveCurrent.
  let saveTarget = $state(null);
  // savedGen tags the current window sequence so a Load-more reply that
  // lands after a (re)fetch restart is dropped instead of interleaved;
  // non-reactive on purpose — it is not state (Library's listGen pattern).
  let savedGen = 0;

  // The schema read (mount AND schemaError's Retry): the error clears
  // only when the read lands, so the sidebar never claims "Loading
  // schema…" while the previous failure still stands.
  // The schema is one load: the first read is busy (the table list shows under the shell's spinner); a Retry
  // or a refresh replaces the list in place.
  const schemaState = createLoadState();
  async function refreshSchema() {
    try {
      await schemaState.track(getSchema(), 'schema', (v) => {
        schema = v || [];
      });
      schemaError = '';
    } catch (e) {
      schemaError = errText(e);
    }
  }

  $effect(() => {
    refreshSchema();
    refreshHistory();
    refreshSaved();
  });

  async function refreshHistory() {
    try {
      history = (await listQueryHistory(50)) || [];
      historyError = '';
    } catch (e) {
      historyError = errText(e);
    }
  }

  async function refreshSaved() {
    // Any full (re)fetch restarts the window: first window, replace —
    // never append onto the previous window's rows (mount, save and
    // delete all land here). The gen tag drops a stale reply so a
    // Load-more racing a restart cannot interleave rows.
    const gen = ++savedGen;
    try {
      const page = await listSavedQueriesPage('', SAVED_PAGE);
      if (gen !== savedGen) return;
      saved = (page && page.rows) || [];
      savedHasNext = !!(page && page.hasNext);
      savedError = '';
    } catch (e) {
      if (gen === savedGen) savedError = errText(e);
    }
  }

  // loadMoreSaved appends the NEXT window: the cursor is the last
  // rendered row's name (unique — no tie-break, and a deleted row's name
  // still positions the window). Duplicate names are filtered out anyway
  // (a restart may have shifted the list), because a repeated keyed
  // {#each} id would throw.
  async function loadMoreSaved() {
    if (loadingMore || !savedHasNext || !saved.length) return;
    loadingMore = true;
    const gen = savedGen;
    try {
      const last = saved[saved.length - 1];
      const page = await listSavedQueriesPage(last.name, SAVED_PAGE);
      if (gen !== savedGen) return; // a refresh replaced the list meanwhile
      const seen = new Set(saved.map((sq) => sq.name));
      const add = ((page && page.rows) || []).filter((sq) => !seen.has(sq.name));
      saved = [...saved, ...add];
      savedHasNext = !!(page && page.hasNext);
      savedError = '';
    } catch (e) {
      savedError = errText(e);
    } finally {
      loadingMore = false;
    }
  }

  async function run() {
    if (running || !sql.trim()) return;
    running = true;
    slow = false;
    runError = '';
    resultPage = 1; // every run starts its grid at the first page
    const timer = setTimeout(() => (slow = true), 200);
    try {
      const r = await runQuery(sql, 0, 0);
      if (r && r.err) {
        result = null;
        runError = r.err;
        resultsOpen = false;
      } else {
        result = r;
        runError = '';
        resultsOpen = true;
      }
    } catch (e) {
      result = null;
      runError = errText(e);
      resultsOpen = false;
    } finally {
      clearTimeout(timer);
      running = false;
      slow = false;
      refreshHistory();
    }
  }

  function toggleTable(name) {
    openTables = { ...openTables, [name]: !openTables[name] };
  }

  function insertAtCursor(text) {
    if (editor) editor.insert(text);
    else sql += text;
  }

  // The console's completions: every table with its columns, the SQL keywords and
  // functions, and the bot filter.
  async function consoleCompletions() {
    return sqlItems({ tables: await consoleTables(), binds: [], metrics: [], botFilter: true });
  }

  function short(s, n) {
    const t = String(s || '');
    return t.length > n ? t.slice(0, n) + '…' : t;
  }

  function truncateSql(s) {
    return s.replace(/\s+/g, ' ').trim();
  }

  // loadSaved pulls a saved row into the editor AND ties Save to it:
  // name + description fill their fields, saveTarget records the row.
  // The tie is what makes the next Save an UPDATE of exactly this row.
  function loadSaved(sq) {
    sql = sq.sql;
    saveName = sq.name;
    saveDescription = sq.description || '';
    saveTarget = { id: sq.id, name: sq.name };
  }

  // loadHistory pulls a history line into the editor as a FRESH save
  // form: name and description empty, saveTarget null — the tie names a
  // saved ROW, so without this reset the next Save would silently UPDATE
  // whatever saved row was loaded before this line (the save-target
  // footgun). Name + description are required to save (form and
  // server-side), which is why a history line always goes through here.
  function loadHistory(h) {
    sql = h.sql;
    saveName = '';
    saveDescription = '';
    saveTarget = null;
    saveError = ''; // a fresh form never carries the previous one's error
  }

  // saveCurrent routes Save by the tie and the CURRENT name field:
  //   tied AND the name still names an existing saved row → UPDATE the
  //     tied row (its own name → rewrite SQL/description; a DIFFERENT
  //     row's name → the unique constraint rejects it with the friendly
  //     "already exists" error);
  //   any other name (no tie, or a genuinely new name) → INSERT (a name
  //     already taken lands on the same friendly uniqueness error).
  // Name + description are BOTH required here and server-side; Run never
  // sees either (it takes raw SQL only).
  async function saveCurrent() {
    saveError = '';
    const name = saveName.trim();
    const description = saveDescription.trim();
    if (!name) {
      saveError = 'Query name is required.';
      return;
    }
    if (!description) {
      saveError = 'Query description is required.';
      return;
    }
    if (!sql.trim()) {
      saveError = 'SQL is required.';
      return;
    }
    try {
      const named = saved.some((r) => r.name === name);
      const row =
        saveTarget && named
          ? await updateQuery(saveTarget.id, name, sql, description)
          : await saveQuery(name, sql, description);
      // Stay tied to what was just stored: a repeat Save with this name
      // updates it instead of colliding with itself.
      saveTarget = { id: row.id, name: row.name };
      await refreshSaved();
    } catch (e) {
      saveError = errText(e);
    }
  }

  async function removeSaved(sq) {
    saveError = '';
    try {
      await deleteQuery(sq.id);
      if (saveTarget && saveTarget.id === sq.id) saveTarget = null;
      await refreshSaved();
    } catch (e) {
      saveError = errText(e);
    }
  }

  // removeHistory deletes ONE line server-side (History is a persisted
  // FIFO — a frontend-only splice would resurrect on the next fetch) and
  // drops it from the list; failures land in the history slot.
  async function removeHistory(h) {
    historyError = '';
    try {
      await deleteQueryHistory(h.id);
      history = history.filter((r) => r.id !== h.id);
    } catch (e) {
      historyError = errText(e);
    }
  }

  async function clearHistory() {
    try {
      await clearQueryHistory();
      history = [];
    } catch (e) {
      historyError = errText(e);
    }
  }

  // --- Result grid page rendering -------------------------------------------

  // One page of the returned rows: pageCount walks EVERY returned row (no
  // render cap — the server's cap is the only truncation), pageRows
  // slices the current window, and the grid keys each row by its
  // ABSOLUTE index so a row never reuses its neighbour's identity when
  // the page moves.
  const pageCount = $derived(result ? Math.max(1, Math.ceil(result.rows.length / RESULT_PAGE)) : 1);
  const pageStart = $derived(result ? (resultPage - 1) * RESULT_PAGE + 1 : 0);
  const pageEnd = $derived(result ? Math.min(resultPage * RESULT_PAGE, result.rows.length) : 0);
  const pageRows = $derived(
    result ? result.rows.slice((resultPage - 1) * RESULT_PAGE, resultPage * RESULT_PAGE) : [],
  );

  // --- Result grid cell rendering --------------------------------------------

  function cellText(v) {
    if (v === null || v === undefined) return '∅';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  function cellClass(v) {
    if (v === null || v === undefined) return 'sql-null';
    if (typeof v === 'number') return 'num mono';
    if (typeof v === 'object') return 'mono sql-str';
    return 'sql-str';
  }

  function cellTitle(v) {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return s.length > 60 ? s : '';
  }

  // --- CSV / JSON export (acceptance walkthrough #2) ---------------------------
  // Native save dialog via lib/save.js: cancel resolves to "" silently.
  // Both formats ride ONE Export popover in the statement card's toolbar
  // (the canonical Popover idiom — anchor span, aria-haspopup/expanded/
  // controls, Escape returns focus to the trigger).

  // The popover's open state + its anchor/trigger nodes (the
  // bind:this pair Popover needs; the trigger keeps focus handling the
  // consumer's job, exactly like Builder's filter panel).
  let exportOpen = $state(false);
  let exportAnchor = $state(null);
  let exportTrigger = $state(null);

  function closeExport() {
    exportOpen = false;
    exportTrigger?.focus();
  }

  // A pointerdown outside closes WITHOUT stealing focus back: the click
  // that lands there must go where the user aimed it (Builder's
  // closeFiltersOutside contract).
  function closeExportOutside() {
    exportOpen = false;
  }

  function stamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
  }

  // CSV/JSON export through the native save dialog (lib/save.js): the
  // dialog's cancel resolves to "" — a cancel is NOT an error and stays
  // silent by contract; only a real failure (write error, backend
  // rejection) lands in the statement panel's error slot, right under the
  // Export control that produced it.
  async function download(text, mime, ext) {
    runError = ''; // clears-on-retry: a new export starts with a clean slot
    try {
      await downloadText(`query-${stamp()}.${ext}`, mime, text);
    } catch (e) {
      runError = `Export failed: ${errText(e)}`;
    }
  }

  function exportCSV() {
    if (!result) return;
    return download(
      toCSV([result.columns, ...result.rows]),
      'text/csv;charset=utf-8',
      'csv',
    );
  }

  function exportJSON() {
    if (!result) return;
    return download(
      JSON.stringify({ columns: result.columns, rows: result.rows }, null, 2),
      'application/json',
      'json',
    );
  }
</script>
<!-- Escape collapses whichever card is expanded (each key handler checks its own). -->
<svelte:window
  onkeydown={(e) => {
    statementPanel.key(e);
  }}
/>

<div class="view sql-view">
  <header class="view-header">
    <h1>SQL console</h1>
    <p class="muted sql-head-note">{DEFAULTS} · read-only</p>
    <!-- The header's own Run button was removed (N8, 2026-11-14): it was
         redundant with the editor card's Run below. The spacer stays —
         it still right-aligns the slow chip. -->
    <div class="spacer"></div>
    {#if slow}
      <span class="chip sql-running">running…</span>
    {/if}
    <!-- The view's help affordance (HelpButton.svelte): the header's
         LAST element, right of the running chip — one `?`, primary
         chrome only. -->
    <HelpButton section="sql-console" {openDocs} />
  </header>

  <div class="sql-grid">
    <aside class="panel sql-side" use:fillHeight>
      <div class="row-between">
        <h2>Schema</h2>
        <span class="chip" title="The console opens a separate connection: mode=ro + query_only, single statement only — multi-statement and writes are rejected before execution."
          >read-only connection · multi-statement and writes rejected</span
        >
      </div>
      {#if schemaError}
        <p class="error" role="alert">
          {schemaError}
          <button class="btn small" onclick={refreshSchema}>Retry</button>
        </p>
      {/if}
      <LoadBox tag="div" class="sql-tables" busy={schemaState.busy} key={schemaState.key} name="view:sql-schema">
        {#each schema as t (t.name)}
          <div class="sql-table" class:open={openTables[t.name]}>
            <button
              class="sql-table-head"
              title={t.note || t.name}
              onclick={() => toggleTable(t.name)}
            >
              <span class="sql-caret"><span class="codicon {openTables[t.name] ? 'codicon-chevron-down' : 'codicon-chevron-right'}"></span></span>
              <span class="mono">{t.name}</span>
              {#if t.note}
                <span class="m5-ib" title={t.note}><span class="codicon codicon-info"></span></span>
              {/if}
            </button>
            {#if openTables[t.name]}
              <div class="sql-cols">
                {#each t.columns as c (c.name)}
                  <button
                    class="sql-col"
                    title="{c.name} {c.type}{c.note ? ' — ' + c.note : ''} · click to insert"
                    onclick={() => insertAtCursor(c.name)}
                  >
                    <span class="mono">{c.name}</span>
                    <span class="chip sql-type">{c.type}</span>
                    {#if c.note}
                      <span class="m5-ib" title={c.note}><span class="codicon codicon-info"></span></span>
                    {/if}
                  </button>
                {:else}
                  <p class="muted sql-col-empty" role="status">No columns.</p>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </LoadBox>
    </aside>

    <div class="sql-main" use:fillHeight>
      <section class="panel" class:editor-expanded={statementPanel.on}>
        <div class="row-between">
          <h2>Statement</h2>
          <div class="toolbar">
            <button
              type="button"
              class="btn small card-expand"
              aria-label={statementPanel.on ? S.common.collapseEditor : S.common.expandEditor}
              title={statementPanel.on ? S.common.collapseEditor : S.common.expandEditor}
              aria-expanded={statementPanel.on}
              onclick={statementPanel.toggle}
            >
              <span class="codicon codicon-{statementPanel.on ? 'screen-normal' : 'screen-full'}"></span>
            </button>
          </div>
        </div>
        <SourceEditor
          bind:this={editor}
          bind:value={sql}
          cls="sql-editor"
          language="sql"
          rows={6}
          ariaLabel="SQL statement"
          completions={consoleCompletions}
          onrun={() => run()}
          expandable={false}
          fill
        />
        <!-- The save form lives in the STATEMENT card (owner,
             2026-11-15): name/description belong with the statement they
             name, and they share the card's ONE toolbar with Export and
             Run — the save group left-justified, the right cluster
             parking Export then Run, Run rightmost. `sql-save-bar`
             travels with the card; its CSS is card-agnostic. saveError
             stays this toolbar's nextElementSibling (the form's error
             slot). -->
        <div class="toolbar sql-save-bar">
          <input
            class="input"
            placeholder="name…"
            aria-label="Query name"
            bind:value={saveName}
            onkeydown={(e) => e.key === 'Enter' && saveCurrent()}
          />
          <input
            class="input sql-save-desc"
            placeholder="description…"
            aria-label="Query description"
            bind:value={saveDescription}
            onkeydown={(e) => e.key === 'Enter' && saveCurrent()}
          />
          <button class="btn small" onclick={saveCurrent} disabled={!sql.trim()}>Save</button>
          <span class="sql-actions-right">
            <!-- Export = ONE control offering both formats (JSON first),
                 as the canonical Popover (Replay's speed / Builder's
                 filters): the host span is the anchor, the trigger
                 carries the aria trio, Escape returns focus to it. -->
            <button
              class="btn primary"
              title="Ctrl/Cmd+Enter runs the statement."
              onclick={run}
              disabled={running || !sql.trim()}
            >
              {#if running}Running…{:else}<span class="codicon codicon-run" aria-hidden="true"></span> Run{/if}
            </button>
          </span>
        </div>
        {#if saveError}
          <p class="error" role="alert">{saveError}</p>
        {/if}
        {#if runError}
          <p class="error" role="alert">
            {runError}
            <button class="btn small" aria-label="Dismiss" onclick={() => (runError = '')}
              ><span class="codicon codicon-close"></span></button
            >
          </p>
        {/if}
      </section>

      <!-- The run's results: Run opens them full screen (PreviewOverlay); the X or Escape closes them. -->
      <PreviewOverlay open={resultsOpen} title="Results" onClose={() => (resultsOpen = false)}>
        {#snippet chips()}
          {#if result}
            <div class="sql-chips">
              <span class="chip">{result.ms} ms</span>
              <span class="chip">{result.rowCount} rows</span>
              {#if result.truncated}
                <span class="chip sql-trunc" title="Hit the row limit — narrow the query for more."
                  >showing first {result.rowCount} (truncated)</span
                >
              {/if}
            </div>
          {/if}
          <!-- Export moves with the results: it exports what is on screen here. -->
        <span class="sql-pop-host" bind:this={exportAnchor}>
          <button
            class="btn"
            bind:this={exportTrigger}
            disabled={!result}
            aria-haspopup="true"
            aria-expanded={exportOpen}
            aria-controls={exportOpen ? 'sql-export-pop' : null}
            title="Export every returned row as JSON or CSV"
            onclick={() => (exportOpen = !exportOpen)}
            >Export <span class="codicon codicon-chevron-down"></span></button
          >
          <Popover
            open={exportOpen}
            anchor={exportAnchor}
            onClose={closeExport}
            onOutside={closeExportOutside}
          >
            <div
              class="sql-pop"
              id="sql-export-pop"
              role="group"
              aria-label="Export format"
            >
              <button
                class="btn small"
                onclick={() => {
                  closeExport();
                  exportJSON();
                }}>JSON</button
              >
              <button
                class="btn small"
                onclick={() => {
                  closeExport();
                  exportCSV();
                }}>CSV</button
              >
            </div>
          </Popover>
        </span>
        {/snippet}
      {#if result}
        {#if result.rows.length === 0}
        <p class="muted" role="status">0 rows.</p>
      {:else}
        <div class="table-scroll sql-results">
          <table class="data-table">
            <thead>
              <tr>
                {#each result.columns as c (c)}
                  <th scope="col" title={c}>{c}</th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each pageRows as row, ri ((resultPage - 1) * RESULT_PAGE + ri)}
                <tr>
                  {#each row as v, ci (ci)}
                    <td class={cellClass(v)} title={cellTitle(v)}>{cellText(v)}</td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <!-- Pager footer — hidden while one page holds every row: the
             range is ABSOLUTE over the returned rows (the muted left
             slot), Prev/Next park right and each disables at its own
             end. -->
        {#if pageCount > 1}
          <div class="row-between">
            <span class="muted" role="status"
              >Rows {pageStart}–{pageEnd} of {result.rows.length}</span
            >
            <span class="toolbar">
              <button
                class="btn small"
                disabled={resultPage <= 1}
                onclick={() => (resultPage -= 1)}>Prev</button
              >
              <button
                class="btn small"
                disabled={resultPage >= pageCount}
                onclick={() => (resultPage += 1)}>Next</button
              >
            </span>
          </div>
        {/if}
      {/if}
    {:else if !running && !runError}
      <p class="muted" role="status">Run a statement to see rows here.</p>
    {/if}
      </PreviewOverlay>

      <!-- Saved queries above history: one column, never side by side — a
           long history row can only scroll inside its own list, so it can
           never squeeze the saved panel off the screen. -->
      <div class="sql-lower">
        <section class="panel">
          <!-- The save form moved to the Statement card (owner, 2026-11-15)
               — this card keeps its heading, list and footer. -->
          <h2>Saved queries</h2>
          {#if savedError}
            <p class="error" role="alert">
              {savedError}
              <button class="btn small" onclick={refreshSaved}>Retry</button>
            </p>
          {/if}
          <div class="sql-hist-list">
            {#each saved as sq (sq.id)}
              <div class="sql-hist as-row">
                <button
                  class="sql-hist-load"
                  title={short(cellTitle(sq.sql), SQL_TITLE_CAP)}
                  onclick={() => loadSaved(sq)}
                >
                  <span class="sql-saved-main">
                    <span class="sql-saved-name" title={sq.name}>{sq.name}</span>
                    {#if sq.description}
                      <span class="sql-saved-desc" title={sq.description}>{sq.description}</span>
                    {/if}
                  </span>
                  <span class="mono sql-hist-sql">{short(truncateSql(sq.sql), 100)}</span>
                </button>
                <button
                  class="btn small ghost"
                  title="Delete saved query"
                  aria-label="Delete {sq.name}"
                  onclick={() => removeSaved(sq)}><span class="codicon codicon-close"></span></button
                >
              </div>
            {:else}
              {#if !savedError}
                <p class="muted" role="status">Nothing saved yet — run a statement, name it, describe it, press Save.</p>
              {/if}
            {/each}
          </div>
          <!-- Keyset pagination footer: only while another window exists
               (backend hasNext). Appends the next SAVED_PAGE rows below
               the ones already shown. -->
          {#if savedHasNext}
            <div class="row-between">
              <span class="muted" role="status">Showing {saved.length} saved queries</span>
              <button class="btn" disabled={loadingMore} onclick={loadMoreSaved}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          {/if}
        </section>

        <section class="panel">
          <div class="row-between">
            <h2>History (last 50)</h2>
            <button class="btn small" onclick={clearHistory} disabled={!history.length}>Clear</button>
          </div>
          {#if historyError}
            <p class="error" role="alert">{historyError}</p>
          {/if}
          <div class="sql-hist-list">
            {#each history as h (h.id)}
              <!-- One history line = a ROW plus two buttons (the
                   saved-queries row pattern): nested <button> is invalid,
                   so the loadable body is the .sql-hist-load button and
                   Remove rides beside it as a ghost button. Loading the
                   line is a click on the body — it lands in the editor as
                   a FRESH save form (loadHistory), no Save button here. -->
              <div class="sql-hist as-row">
                <button
                  class="sql-hist-load"
                  title={short(cellTitle(h.sql), SQL_TITLE_CAP)}
                  onclick={() => loadHistory(h)}
                >
                  <span
                    class="sql-dot"
                    class:ok={h.ok}
                    class:bad={!h.ok}
                    title={h.ok ? 'ok' : 'error'}
                  ></span>
                  <span class="mono sql-hist-sql">{short(truncateSql(h.sql), 100)}</span>
                  <span class="sql-hist-meta num">{h.ms} ms · {h.rows} rows</span>
                </button>
                <button
                  class="btn small ghost"
                  title="Remove this line from history"
                  aria-label="Remove history line: {short(truncateSql(h.sql), 40)}"
                  onclick={() => removeHistory(h)}
                  ><span class="codicon codicon-close"></span></button
                >
              </div>
            {:else}
              {#if !historyError}
                <p class="muted" role="status">No runs yet.</p>
              {/if}
            {/each}
          </div>
        </section>
      </div>
    </div>
  </div>
</div>
