<script>
  import {
    listMetricsPage,
    saveMetric,
    deleteMetric,
    previewMetric,
    validateExpr,
    listPlugins,
    errText,
  } from '../services.js';
  import { fmtInt, fmtMetric } from '../fmt.js';
  import ProfileLink from '../components/ProfileLink.svelte';
  import StatusChip from '../components/StatusChip.svelte';
  import { seed, remember } from '../viewstate.svelte.js';

  let { nav = () => {} } = $props();

  // localStorage contract (M5 §2.1): 'spectra:pinned-metrics' is a JSON
  // array of metric ids. Builder owns every write (the pin toggles below);
  // Match.svelte reads it when a scoreboard renders and resolves the ids
  // through listMetrics() — ids that no longer resolve are ignored there,
  // and deleteMetric drops its own id here so the array stays canonical.
  const PINS_KEY = 'spectra:pinned-metrics';

  const PREVIEW_LIMIT = 200;
  // Placeholder shows the current grammar: a single source, or a comma
  // list the engine joins (doc.go — the join extension).
  const EXAMPLE = 'from player_stats, match_trade_opps: ratio(sum(trade_kills), sum(opps))';

  // Window size for the metric list: one page per fetch, one more per
  // Load-more click (backend default store.ListMetricsPageSize is the
  // same 100 — the button's row counts and the store's window agree).
  const PAGE_SIZE = 100;

  // metrics is the ACCUMULATED keyset windows (never a whole-library
  // fetch) in the store's canonical builtin → user → plugin / name
  // order — the group headers below are derived from those contiguous
  // origin runs. hasNext is the backend's limit+1 probe.
  let metrics = $state([]);
  let hasNext = $state(false);
  // First-window gate for the empty state — transient by the
  // State-placement rule: never seeded, never remembered, never in the
  // URL (it re-arms on every refresh, but only shows while the list is
  // still empty).
  let loading = $state(true);
  let loadingMore = $state(false);
  let pins = $state([]);
  let disabledPlugins = $state(new Set());
  let listError = $state('');

  // The editor form (fields + the dirty-check baseline), the list's
  // search text and the two source toggles are view-local state: they
  // restore across navigation through the process-scoped registry
  // (viewstate.svelte.js — flat key; they travel together so the
  // unsaved-changes flag, the search and the toggles read exactly as
  // they did on leave; the search is the Profiles precedent).
  // Saving, previews, errors, the window cursor and the pin list stay
  // transient / their own store.
  const bldSeed = seed('builder', {
    form: newForm(),
    baseline: '',
    query: '',
    // Built-in / My metrics toggles: built-in OFF, My metrics ON — the
    // initial view lists the user's own metrics (user + plugin).
    builtin: false,
    mine: true,
  });
  let form = $state(bldSeed.form);
  let baseline = $state(bldSeed.baseline);
  let query = $state(bldSeed.query);
  let builtin = $state(bldSeed.builtin);
  let mine = $state(bldSeed.mine);
  $effect(() => remember('builder', { form, baseline, query, builtin, mine }));
  let saveError = $state('');
  let saving = $state(false);

  // Live expression check: debounced 400 ms → validateExpr.
  // state: idle | pending | valid | error
  let exprCheck = $state({ state: 'idle' });
  let exprSeq = 0;

  let preview = $state(null);
  let previewAdhoc = $state(false);
  let previewError = $state('');
  let previewBusy = $state(false);
  // The format the preview's value column renders with: an AD-HOC
  // preview echoes no stored row (its format is the form's — the
  // definition being edited), a SAVED preview formats from the echoed
  // stored row (preview.metric). The distinction matters because the
  // row play can preview a BUILT-IN without loading it, so the form may
  // hold a different metric (or none) than the one on screen.
  const previewFormat = $derived(previewAdhoc ? form.format : preview?.metric?.format || '');

  function newForm() {
    return {
      id: 0,
      name: '',
      title: '',
      shortName: '',
      expr: '',
      scope: 'match',
      format: '',
      denominator: '',
      doc: '',
      origin: 'user',
      pluginId: '',
    };
  }

  function snapshot(f) {
    return JSON.stringify({
      name: f.name,
      title: f.title,
      shortName: f.shortName,
      expr: f.expr,
      scope: f.scope,
      format: f.format,
      denominator: f.denominator,
      doc: f.doc,
    });
  }

  function readPins() {
    try {
      const raw = localStorage.getItem(PINS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return [];
      return [...new Set(arr.map(Number).filter((n) => Number.isFinite(n)))];
    } catch {
      return [];
    }
  }

  function writePins(ids) {
    try {
      localStorage.setItem(PINS_KEY, JSON.stringify(ids));
    } catch {
      /* storage unavailable — pins stay session-local */
    }
  }

  // The left list's group runs: the paged read is origin-contiguous
  // (store metricOrder — builtin → user → plugin, name ASC), so the
  // accumulated windows form one run per origin present. The markup
  // renders ONE header per run, so a window boundary inside a group
  // never repeats a header — the final look matches the unpaginated
  // grouped list.
  const GROUP_LABEL = { builtin: 'Builtins', user: 'Yours', plugin: 'Plugins' };
  const runs = $derived.by(() => {
    const out = [];
    for (const m of metrics) {
      const last = out[out.length - 1];
      if (last && last.origin === m.origin) last.rows.push(m);
      else out.push({ origin: m.origin, rows: [m] });
    }
    return out;
  });

  const dirty = $derived(snapshot(form) !== baseline);
  const readOnly = $derived(form.origin !== 'user');

  // originFilter — THE one toggle → server-filter derivation: both on =
  // the whole catalog (''), Built-in only / My metrics only = the
  // store's partition words, both off = 'none' (an empty list — legal,
  // it falls out of the same read path). "mine" is the store's
  // complement (origin <> 'builtin': user + plugin), so the toggles can
  // never disagree with the store about what "mine" means. It rides the
  // list read's args — see refreshList — so it restarts the window
  // exactly like a search change does (the effect below reads it) and
  // joins listMetricsPage's cache key for free (services.js).
  const originFilter = $derived.by(() => {
    if (builtin && mine) return '';
    if (builtin) return 'builtin';
    if (mine) return 'mine';
    return 'none';
  });

  // The search text AND origin filter the current window sequence
  // serves: refreshList writes them, loadMore reads them (the cursor's
  // query + filter) and the empty-result copy below names the query —
  // $state because the template references them.
  let appliedQuery = $state('');
  let appliedFilter = $state('');
  // listGen distinguishes the current window sequence from stale replies
  // (see refreshList/loadMore); non-reactive on purpose — it is not state.
  let listGen = 0;

  // The plugin states fire-and-forget on mount AND on Retry: they never
  // wait on the metric read (nor on its failure).
  function loadPluginStates() {
    listPlugins()
      .then((states) => {
        disabledPlugins = new Set(
          (states || []).filter((s) => !s.enabled).map((s) => s.manifest.id),
        );
      })
      .catch(() => {});
  }

  // Mount (runs once — it reads no reactive value): pins from
  // localStorage once per mount (a retry must not re-derive them over the
  // session's toggles) plus the plugin states.
  $effect(() => {
    pins = readPins();
    loadPluginStates();
  });

  // The list read (mount AND listError's Retry): the first run is
  // immediate (the list loads without the debounce delay), later runs
  // fire 250 ms after a query OR toggle change (the Library's debounce)
  // so typing doesn't hammer the store — and a source-toggle flip lands
  // on this SAME path, which restarts the window at cursor 0 (a filter
  // change never appends onto the previous filter's windows).
  let firstList = true;
  $effect(() => {
    const q = query;
    const f = originFilter;
    if (firstList) {
      firstList = false;
      refreshList(q, f);
      return;
    }
    const t = setTimeout(() => refreshList(q, f), 250);
    return () => clearTimeout(t);
  });

  // Retry: the error slot's button — plugin states + a fresh first
  // window for the query/filter currently in play.
  async function loadLists() {
    loadPluginStates();
    await refreshList(query, originFilter);
  }

  // refreshList RESTARTS the window sequence: cursor 0, replace — a
  // search change, a source-toggle change, a save/delete refresh or a
  // Retry must never APPEND onto the previous window's rows. listGen
  // tags the sequence so a Load-more reply landing after a restart is
  // dropped instead of appended (the Library's refreshList/loadMore
  // shape). Both narrowings are SERVER-side (query LIKE + originFilter
  // — store.ListMetricsPage), never a client-side slice of a window.
  async function refreshList(q = '', f = '') {
    appliedQuery = q;
    appliedFilter = f;
    const gen = ++listGen;
    loading = true;
    try {
      const page = await listMetricsPage(q, f, 0, PAGE_SIZE);
      if (gen !== listGen) return;
      metrics = (page && page.rows) || [];
      hasNext = !!(page && page.hasNext);
      listError = '';
      loading = false; // gen-guarded: only a CURRENT reply ends the wait
    } catch (e) {
      if (gen === listGen) {
        listError = errText(e);
        loading = false; // a failed first read shows the error, not a hang
      }
    }
  }

  // loadMore appends the NEXT window: the cursor is the last rendered
  // row's id (the store resolves it to its stored origin-rank/name key,
  // so windows never skip or duplicate a row). Duplicate ids are filtered
  // out anyway — a repeated keyed {#each} id would throw.
  async function loadMore() {
    if (loadingMore || !hasNext || !metrics.length) return;
    loadingMore = true;
    const gen = listGen;
    try {
      const last = metrics[metrics.length - 1];
      const page = await listMetricsPage(appliedQuery, appliedFilter, last.id, PAGE_SIZE);
      if (gen !== listGen) return; // a refresh replaced the list meanwhile
      const seen = new Set(metrics.map((m) => m.id));
      const add = ((page && page.rows) || []).filter((m) => !seen.has(m.id));
      metrics = [...metrics, ...add];
      hasNext = !!(page && page.hasNext);
      listError = '';
    } catch (e) {
      if (gen === listGen) listError = errText(e);
    } finally {
      loadingMore = false;
    }
  }

  $effect(() => {
    const expr = form.expr;
    const seq = ++exprSeq;
    if (!expr.trim()) {
      exprCheck = { state: 'idle' };
      return;
    }
    exprCheck = { state: 'pending' };
    const t = setTimeout(() => {
      validateExpr(expr)
        .then(([ok, e]) => {
          if (seq !== exprSeq) return;
          exprCheck = ok
            ? { state: 'valid' }
            : { state: 'error', msg: e.message || 'invalid', pos: Number(e.pos) || 0 };
        })
        .catch((err) => {
          if (seq !== exprSeq) return;
          exprCheck = { state: 'error', msg: errText(err), pos: -1 };
        });
    }, 400);
    return () => clearTimeout(t);
  });

  function editMetric(m) {
    // A built-in NEVER loads into the form (Feature B: built-ins have no
    // edit affordance — the row's main area renders without a button for
    // them, so this is the backstop for every load path). Plugin rows
    // still load (read-only chip + fork-on-save).
    if (m.origin === 'builtin') return;
    form = {
      id: m.id,
      name: m.name,
      title: m.title || '',
      shortName: m.shortName || '',
      expr: m.expr,
      scope: m.scope || 'match',
      format: m.format || '',
      denominator: m.denominator || '',
      doc: m.doc || '',
      origin: m.origin,
      pluginId: m.pluginId || '',
    };
    baseline = snapshot(form);
    saveError = '';
  }

  function newMetric() {
    form = newForm();
    baseline = snapshot(form);
    saveError = '';
  }

  // Id-based (not row-based): the edit card's Pin acts on form.id, which
  // may sit beyond the windows fetched so far — a paged list must not
  // make the toggle silently no-op.
  function togglePin(id) {
    pins = pins.includes(id) ? pins.filter((x) => x !== id) : [...pins, id];
    writePins(pins);
  }

  async function removeMetric(m) {
    saveError = '';
    try {
      await deleteMetric(m.id);
      if (pins.includes(m.id)) {
        pins = pins.filter((x) => x !== m.id);
        writePins(pins);
      }
      if (form.id === m.id) newMetric();
      if (preview && preview.metric && preview.metric.id === m.id) preview = null;
      await refreshList(appliedQuery, appliedFilter);
    } catch (e) {
      saveError = errText(e);
    }
  }

  async function save() {
    saveError = '';
    const name = form.name.trim();
    if (!name) {
      saveError = 'Name is required.';
      return;
    }
    if (!form.expr.trim()) {
      saveError = 'Expression is required.';
      return;
    }
    if (!form.doc.trim()) {
      saveError = 'Doc is required for user metrics — document the formula.';
      return;
    }
    if (exprCheck.state === 'error') {
      saveError = `Fix the expression error first: ${exprCheck.msg}`;
      return;
    }
    saving = true;
    try {
      // A plugin row is immutable through SaveMetric (the service and
      // store reject updates on it) — saving one forks a user copy
      // (id 0). Built-ins never reach the form at all (editMetric
      // refuses them), so they cannot be saved from here either.
      const payload = {
        id: readOnly ? 0 : form.id,
        name,
        title: form.title.trim() || name,
        shortName: form.shortName.trim(),
        expr: form.expr,
        scope: form.scope,
        format: form.format,
        doc: form.doc.trim(),
        denominator: form.denominator,
        origin: 'user',
        pluginId: '',
      };
      const saved = await saveMetric(payload);
      form.id = saved.id;
      form.origin = saved.origin;
      form.name = saved.name;
      form.title = saved.title;
      form.shortName = saved.shortName;
      baseline = snapshot(form);
      await refreshList(appliedQuery, appliedFilter);
    } catch (e) {
      saveError = errText(e);
    } finally {
      saving = false;
    }
  }

  // runPreview() previews the FORM (the panel's Preview button);
  // runPreview(row) previews that STORED definition straight off its id
  // — the row play's path for a BUILT-IN, which never loads into the
  // form. Saved-definition previews ride the id (expr "") so the
  // denominator applies; edited/unsaved expressions are ad-hoc (no
  // denominator).
  async function runPreview(target) {
    previewError = '';
    const id = target ? target.id : form.id;
    const expr = target ? '' : form.expr;
    if (!target && !expr.trim()) {
      preview = null;
      previewError = 'Enter an expression to preview.';
      return;
    }
    previewBusy = true;
    const adhoc = !target && (dirty || form.id === 0);
    previewAdhoc = adhoc;
    try {
      preview = await previewMetric(
        id,
        adhoc ? expr : '',
        '', // whole library: the builder has no scope selector
        PREVIEW_LIMIT,
      );
    } catch (e) {
      preview = null;
      previewError = errText(e);
    } finally {
      previewBusy = false;
    }
  }

  // The row play control: preview THIS row. Non-builtin rows load into
  // the form first (existing behaviour — the panel then reads that
  // definition); a built-in never loads (editMetric refuses it) and
  // previews off its stored id, so a builtin still previews while the
  // form stays untouched.
  function previewRow(m) {
    if (m.origin === 'builtin') {
      runPreview(m);
      return;
    }
    editMetric(m);
    runPreview();
  }
</script>

{#snippet rowMain(m)}
  <span class="bld-row-title">
    {m.title || m.name}
    {#if m.doc}
      <span class="m5-ib" title={m.doc}><span class="codicon codicon-info"></span></span>
    {/if}
  </span>
  <span class="bld-row-sub">
    <span class="mono">{m.name}</span>
    <span class="chip">{m.scope || 'match'}</span>
    <span class="chip">{m.format || 'raw'}</span>
    {#if m.origin === 'plugin'}
      <span class="chip bld-plugin">plugin</span>
      {#if disabledPlugins.has(m.pluginId)}
        <span class="chip bld-disabled">disabled</span>
      {/if}
    {/if}
  </span>
{/snippet}

{#snippet metricRow(m)}
  <div class="bld-row" class:active={form.id === m.id}>
    <!-- Built-ins expose NO edit affordance: their main area is plain
         content (no button, no click-to-edit) — user/plugin rows keep
         the button. Pin and preview stay live on every row. -->
    {#if m.origin === 'builtin'}
      <div class="bld-row-main bld-row-static">{@render rowMain(m)}</div>
    {:else}
      <button class="bld-row-main" onclick={() => editMetric(m)}>{@render rowMain(m)}</button>
    {/if}
    <span class="bld-row-acts">
      <button
        class="btn small ghost"
        title="Preview this metric"
        aria-label="Preview {m.name}"
        onclick={() => previewRow(m)}><span class="codicon codicon-play"></span></button
      >
      <button
        class="btn small ghost"
        class:bld-pin-on={pins.includes(m.id)}
        title={pins.includes(m.id) ? 'Unpin from scoreboard' : 'Pin as scoreboard column'}
        aria-label="Toggle pin for {m.name}"
        onclick={() => togglePin(m.id)}><span class="codicon codicon-pin"></span></button
      >
      <!-- Delete is the user-row control: built-ins are guarded
           server-side (SaveMetric/DeleteMetric) and plugins are the
           loader's territory, so neither ever shows one. -->
      {#if m.origin === 'user'}
        <button
          class="btn small ghost"
          title="Delete metric"
          aria-label="Delete {m.name}"
          onclick={() => removeMetric(m)}><span class="codicon codicon-close"></span></button
        >
      {/if}
    </span>
  </div>
{/snippet}

<div class="view bld-view">
  <header class="view-header">
    <div>
      <h1>Metric builder</h1>
      <p class="muted bld-head-note">
        Saved metrics are appended to match reports in Reports · pinned (<span class="codicon codicon-pin"></span>)
        metrics show as scoreboard columns on every match.
      </p>
    </div>
  </header>

  {#if listError}
    <p class="error" role="alert">
      {listError}
      <button class="btn small" onclick={loadLists}>Retry</button>
    </p>
  {/if}
  {#if saveError}
    <p class="error" role="alert">{saveError}</p>
  {/if}

  <div class="bld-grid">
    <section class="panel bld-list">
      <div class="row-between">
        <h2>Metrics</h2>
        <button class="btn small" onclick={newMetric}
          ><span class="codicon codicon-add"></span> New</button
        >
      </div>
      <!-- Server-side search: the debounced query reaches the store
           (LIKE over name/title) and restarts the window at cursor 0. -->
      <input
        class="input"
        type="search"
        aria-label="Search metrics"
        placeholder="Search metrics…"
        bind:value={query}
      />
      <!-- Source toggles: the same debounced restart as the search (one
           effect reads query + originFilter), server-side partition
           (store.ListMetricsPage — never a client-side slice of a page
           window). Built-in defaults OFF, My metrics ON; both off is
           legal and leaves the empty list below. -->
      <div class="toolbar" role="group" aria-label="Metric sources">
        <label class="filt-check">
          <input type="checkbox" bind:checked={builtin} />
          <span>Built-in</span>
        </label>
        <label class="filt-check">
          <input type="checkbox" bind:checked={mine} />
          <span>My metrics</span>
        </label>
      </div>
      {#if metrics.length === 0 && !listError}
        {#if loading}
          <p class="muted" role="status"><StatusChip block detail="Loading…" /></p>
        {:else if appliedQuery}
          <p class="muted" role="status">No metrics match “{appliedQuery}”.</p>
        {:else}
          <!-- Query-less empty: an empty My-metrics side (nothing built
               yet) or both source toggles off — both legal, both say so
               here instead of leaving a blank panel. -->
          <p class="muted" role="status">No metrics to show.</p>
        {/if}
      {:else}
        <!-- One header per contiguous origin run (runs above): a window
             boundary inside a group never repeats the header. -->
        {#each runs as run (run.origin + ':' + run.rows[0].id)}
          <div class="bld-group">
            <h3>{GROUP_LABEL[run.origin] || run.origin}</h3>
            {#each run.rows as m (m.id)}
              {@render metricRow(m)}
            {/each}
          </div>
        {/each}
        {#if hasNext}
          <div class="row-between">
            <span class="muted" role="status">Showing {metrics.length} metrics</span>
            <button class="btn" disabled={loadingMore} onclick={loadMore}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          </div>
        {/if}
      {/if}
    </section>

    <div class="bld-right">
      <section class="panel">
        <div class="row-between">
          <h2>{form.id ? 'Edit metric' : 'New metric'}</h2>
          {#if readOnly}
            <!-- readOnly is plugin-only now: built-ins never load into
                 the form (editMetric refuses them). -->
            <span class="chip bld-readonly" title="Plugin metrics are immutable — saving stores a copy of this definition as your own metric."
              >read-only source</span
            >
          {/if}
        </div>

        <div class="bld-fields">
          <div class="bld-field">
            <label class="field-label" for="bld-name">Name</label>
            <input id="bld-name" class="input mono" bind:value={form.name} placeholder="slug_name" />
          </div>
          <div class="bld-field">
            <label class="field-label" for="bld-title">Title</label>
            <input id="bld-title" class="input" bind:value={form.title} placeholder="Display label" />
          </div>
          <div class="bld-field">
            <label class="field-label" for="bld-short">Short name (optional)</label>
            <input
              id="bld-short"
              class="input"
              bind:value={form.shortName}
              placeholder="Short label for narrow column headers"
            />
          </div>
          <div class="bld-field">
            <label class="field-label" for="bld-scope">Scope</label>
            <select id="bld-scope" class="input" bind:value={form.scope}>
              <option value="match">match — this player in this match</option>
              <option value="profile">profile — this player's career</option>
            </select>
          </div>
          <div class="bld-field">
            <label class="field-label" for="bld-format">Format</label>
            <select id="bld-format" class="input" bind:value={form.format}>
              <option value="">auto</option>
              <option value="int">int</option>
              <option value="float1">float1</option>
              <option value="percent">percent</option>
              <option value="currency">currency</option>
            </select>
          </div>
          <div class="bld-field">
            <label class="field-label" for="bld-denom">Denominator</label>
            <select id="bld-denom" class="input" bind:value={form.denominator}>
              <option value="">none</option>
              <option value="rounds">rounds</option>
              <option value="matches">matches</option>
            </select>
          </div>
          <div class="bld-field wide">
            <label class="field-label" for="bld-doc">Doc (formula, required)</label>
            <textarea id="bld-doc" class="input" rows="3" bind:value={form.doc} placeholder="Formula: … — what this counts, over what, and any proxy/deviation."></textarea>
          </div>
          <div class="bld-field wide">
            <label class="field-label" for="bld-expr">Expression</label>
            <textarea
              id="bld-expr"
              class="input mono bld-expr"
              rows="4"
              spellcheck="false"
              bind:value={form.expr}
              placeholder={EXAMPLE}
            ></textarea>
            <p class="bld-hint mono">
              from &lt;table&gt;[, &lt;table&gt;…]: count() | sum(col) | avg(col) | ratio(a, b) | stddev(col) |
              percentile(p, col) — tables: events, engagements, rounds, player_stats, player_round_stats,
              round_economy, clutches, utility_events, chat, match_trade_opps — a comma list LEFT JOINs the
              sources engine-side (no user ON/join syntax); denominator: rounds | matches
            </p>
            {#if exprCheck.state === 'pending'}
              <p class="bld-expr-state muted">checking…</p>
            {:else if exprCheck.state === 'valid'}
              <p class="bld-expr-state ok"><span class="codicon codicon-check"></span> valid</p>
            {:else if exprCheck.state === 'error'}
              <p class="bld-expr-state bad">
                <span class="codicon codicon-error"></span> {exprCheck.msg}{exprCheck.pos >= 0 ? ` · byte ${exprCheck.pos}` : ''}
              </p>
            {/if}
          </div>
        </div>

        <div class="toolbar bld-actions">
          <button class="btn primary" onclick={save} disabled={saving}>
            {saving ? 'Saving…' : form.id && !dirty ? 'Saved' : 'Save metric'}
          </button>
          <button
            class="btn"
            class:bld-pin-on={form.id > 0 && pins.includes(form.id)}
            disabled={form.id === 0}
            onclick={() => togglePin(form.id)}
          >
            <span class="codicon codicon-pin"></span>
            {form.id > 0 && pins.includes(form.id) ? 'Pinned' : 'Pin'}
          </button>
          <span class="muted bld-note">
            Saved metrics are appended to match reports in Reports.
          </span>
        </div>
      </section>

      <section class="panel bld-preview">
        <div class="row-between">
          <h2>Preview</h2>
          <div class="toolbar">
            <button class="btn primary" onclick={() => runPreview()} disabled={previewBusy}>
              {previewBusy ? 'Running…' : 'Preview'}
            </button>
            {#if preview}
              <span class="chip">{preview.ms} ms</span>
            {/if}
            {#if preview && preview.truncated}
              <span class="chip">truncated</span>
            {/if}
          </div>
        </div>

        {#if previewError}
          <p class="error" role="alert">{previewError}</p>
        {:else if preview}
          {#if previewAdhoc && form.denominator}
            <p class="muted bld-note">
              Ad-hoc preview — the denominator ({form.denominator}) applies after save.
            </p>
          {/if}
          {#if preview.rows.length === 0}
            <p class="muted" role="status">No groups — empty result.</p>
          {:else}
            <div class="table-scroll">
              <table class="data-table">
                <thead>
                  <tr>
                    <th scope="col">Group</th>
                    <th scope="col">Label</th>
                    <th scope="col" class="num">Value</th>
                    <th scope="col" class="num" title="Sample size behind the value">N</th>
                  </tr>
                </thead>
                <tbody>
                  {#each preview.rows as r, i (i)}
                    <tr
                      class:bld-missing={r.n === 0}
                      class:bld-egroup={!r.group}
                      title={r.n === 0 ? 'no data behind this value' : ''}
                    >
                      <td class="mono">{r.group || '—'}</td>
                      <td>
                        <!-- A player grouping carries the Steam id in r.group
                             (ProfileLink's own isSteam guard makes that a
                             link); every other grouping — side, weapon, … —
                             stays plain text. -->
                        <ProfileLink steam={r.group} name={r.label || '—'} {nav} />
                      </td>
                      <td class="num">{fmtMetric(r.value, previewFormat)}</td>
                      <td class="num">{fmtInt(r.n)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
          <details class="bld-sql">
            <summary>compiled SQL (provenance)</summary>
            <pre class="mono">{preview.sql}</pre>
          </details>
        {:else}
          <p class="muted" role="status">
            Nothing previewed yet — press Preview (or <span class="codicon codicon-play"></span> on a metric).
          </p>
        {/if}
      </section>
    </div>
  </div>
</div>
