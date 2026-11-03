<script>
  import {
    runQuery,
    getSchema,
    listSavedQueries,
    saveQuery,
    deleteQuery,
    listQueryHistory,
    clearQueryHistory,
    errText,
  } from '../services.js';
  import { downloadText } from '../download.js';
  import { toCSV } from '../csv.js';

  let { nav = () => {} } = $props();

  // Server defaults echoed in the header (query.DefaultLimit / DefaultTimeoutMS).
  const DEFAULTS = 'rows cap 5,000 · timeout 5 s';
  const GRID_CAP = 2000; // render cap for very wide results; exports always carry every row

  let schema = $state([]);
  let schemaError = $state('');
  let openTables = $state({});

  let editor = $state(null);
  let sql = $state('');

  let result = $state(null);
  let runError = $state('');
  let running = $state(false);
  let slow = $state(false);

  let history = $state([]);
  let historyError = $state('');
  let saved = $state([]);
  let savedError = $state('');
  let saveName = $state('');
  let saveError = $state('');

  $effect(() => {
    let live = true;
    getSchema()
      .then((t) => {
        if (live) schema = t || [];
      })
      .catch((e) => {
        if (live) schemaError = errText(e);
      });
    refreshHistory();
    refreshSaved();
    return () => (live = false);
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
    try {
      saved = (await listSavedQueries()) || [];
      savedError = '';
    } catch (e) {
      savedError = errText(e);
    }
  }

  async function run() {
    if (running || !sql.trim()) return;
    running = true;
    slow = false;
    runError = '';
    const timer = setTimeout(() => (slow = true), 200);
    try {
      const r = await runQuery(sql, 0, 0);
      if (r && r.err) {
        result = null;
        runError = r.err;
      } else {
        result = r;
        runError = '';
      }
    } catch (e) {
      result = null;
      runError = errText(e);
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
    const el = editor;
    if (!el) {
      sql += text;
      return;
    }
    const start = el.selectionStart ?? sql.length;
    const end = el.selectionEnd ?? start;
    sql = sql.slice(0, start) + text + sql.slice(end);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + text.length;
      el.setSelectionRange(pos, pos);
    });
  }

  function short(s, n) {
    const t = String(s || '');
    return t.length > n ? t.slice(0, n) + '…' : t;
  }

  function truncateSql(s) {
    return s.replace(/\s+/g, ' ').trim();
  }

  async function saveCurrent() {
    saveError = '';
    if (!saveName.trim()) {
      saveError = 'Query name is required.';
      return;
    }
    if (!sql.trim()) {
      saveError = 'SQL is required.';
      return;
    }
    try {
      await saveQuery(saveName.trim(), sql);
      saveName = '';
      await refreshSaved();
    } catch (e) {
      saveError = errText(e);
    }
  }

  async function removeSaved(sq) {
    saveError = '';
    try {
      await deleteQuery(sq.id);
      await refreshSaved();
    } catch (e) {
      saveError = errText(e);
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

  // --- Result grid cell rendering --------------------------------------------

  const gridRows = $derived(result ? result.rows.slice(0, GRID_CAP) : []);
  const gridOverflow = $derived(result ? Math.max(0, result.rows.length - GRID_CAP) : 0);

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
  // Native save dialog via lib/save.js: cancel resolves to "" silently;
  // this view has no export status strip, so failures log to the console.

  function stamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
  }

  async function download(text, mime, ext) {
    try {
      await downloadText(`query-${stamp()}.${ext}`, mime, text);
    } catch (e) {
      console.error('SQL export failed:', e);
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

<div class="view sql-view">
  <header class="view-header">
    <div>
      <h1>SQL console</h1>
      <p class="muted sql-head-note">{DEFAULTS} · read-only</p>
    </div>
    <div class="spacer"></div>
    <button class="btn primary" onclick={run} disabled={running || !sql.trim()}>
      Run <span class="codicon codicon-play"></span> Ctrl+Enter
    </button>
    {#if slow}
      <span class="chip sql-running">running…</span>
    {/if}
  </header>

  <div class="sql-grid">
    <aside class="panel sql-side">
      <div class="row-between">
        <h2>Schema</h2>
        <span class="chip" title="The console opens a separate connection: mode=ro + query_only, single statement only — multi-statement and writes are rejected before execution."
          >read-only connection · multi-statement and writes rejected</span
        >
      </div>
      {#if schemaError}
        <p class="error" role="alert">{schemaError}</p>
      {/if}
      <div class="sql-tables">
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
        {:else}
          {#if !schemaError}
            <p class="muted" role="status">Loading schema…</p>
          {/if}
        {/each}
      </div>
    </aside>

    <div class="sql-main">
      <section class="panel">
        <div class="row-between">
          <h2>Statement</h2>
          <span class="muted sql-defaults">{DEFAULTS}</span>
        </div>
        <textarea
          class="input mono sql-editor"
          rows="6"
          spellcheck="false"
          placeholder="SELECT * FROM matches LIMIT 20"
          bind:value={sql}
          bind:this={editor}
          onkeydown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              run();
            }
          }}
        ></textarea>
        <div class="toolbar">
          <button class="btn primary" onclick={run} disabled={running || !sql.trim()}>
            {#if running}Running…{:else}Run <span class="codicon codicon-play"></span>{/if}
          </button>
          <button class="btn" disabled={!result} onclick={exportCSV}>Export CSV</button>
          <button class="btn" disabled={!result} onclick={exportJSON}>Export JSON</button>
          <span class="muted sql-hint">Ctrl/Cmd+Enter runs the statement.</span>
        </div>
        {#if runError}
          <p class="error" role="alert">{runError}</p>
        {/if}
      </section>

      <section class="panel sql-results-panel">
        <div class="row-between">
          <h2>Results</h2>
          {#if result}
            <div class="sql-chips">
              <span class="chip">{result.ms} ms</span>
              <span class="chip">{result.rowCount} rows</span>
              {#if result.truncated}
                <span class="chip sql-trunc" title="Hit the server-side row cap — narrow the query for more."
                  >showing first {result.rowCount} (truncated)</span
                >
              {/if}
            </div>
          {/if}
        </div>
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
                  {#each gridRows as row, ri (ri)}
                    <tr>
                      {#each row as v, ci (ci)}
                        <td class={cellClass(v)} title={cellTitle(v)}>{cellText(v)}</td>
                      {/each}
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
            {#if gridOverflow > 0}
              <p class="muted sql-note">
                Showing the first {GRID_CAP} rows in the grid ({result.rowCount} returned) —
                exports include every returned row.
              </p>
            {/if}
          {/if}
        {:else if !running && !runError}
          <p class="muted" role="status">Run a statement to see rows here.</p>
        {/if}
      </section>

      <div class="sql-lower">
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
              <button class="sql-hist" title={h.sql} onclick={() => (sql = h.sql)}>
                <span
                  class="sql-dot"
                  class:ok={h.ok}
                  class:bad={!h.ok}
                  title={h.ok ? 'ok' : 'error'}
                ></span>
                <span class="mono sql-hist-sql">{short(truncateSql(h.sql), 100)}</span>
                <span class="sql-hist-meta num">{h.ms} ms · {h.rows} rows</span>
              </button>
            {:else}
              {#if !historyError}
                <p class="muted" role="status">No runs yet.</p>
              {/if}
            {/each}
          </div>
        </section>

        <section class="panel">
          <div class="row-between">
            <h2>Saved queries</h2>
            <div class="toolbar sql-save-bar">
              <input
                class="input"
                placeholder="name…"
                bind:value={saveName}
                onkeydown={(e) => e.key === 'Enter' && saveCurrent()}
              />
              <button class="btn small" onclick={saveCurrent} disabled={!sql.trim()}>Save</button>
            </div>
          </div>
          {#if saveError}
            <p class="error" role="alert">{saveError}</p>
          {/if}
          {#if savedError}
            <p class="error" role="alert">{savedError}</p>
          {/if}
          <div class="sql-hist-list">
            {#each saved as sq (sq.id)}
              <div class="sql-hist as-row">
                <button
                  class="sql-hist-load"
                  title={sq.sql}
                  onclick={() => (sql = sq.sql)}
                >
                  <span class="sql-saved-name">{sq.name}</span>
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
                <p class="muted" role="status">Nothing saved yet — run a statement, name it, press Save.</p>
              {/if}
            {/each}
          </div>
        </section>
      </div>
    </div>
  </div>
</div>
