<script>
  import {
    listMetrics,
    saveMetric,
    deleteMetric,
    previewMetric,
    validateExpr,
    listMatches,
    listPlugins,
    errText,
  } from '../services.js';
  import { fmtInt, fmtMetric } from '../fmt.js';
  import MatchPicker from '../components/MatchPicker.svelte';
  import ProfileLink from '../components/ProfileLink.svelte';
  import { seed, remember } from '../viewstate.svelte.js';

  let { nav = () => {} } = $props();

  // localStorage contract (M5 §2.1): 'spectra:pinned-metrics' is a JSON
  // array of metric ids. Builder owns every write (the pin toggles below);
  // Match.svelte reads it when a scoreboard renders and resolves the ids
  // through listMetrics() — ids that no longer resolve are ignored there,
  // and deleteMetric drops its own id here so the array stays canonical.
  const PINS_KEY = 'spectra:pinned-metrics';

  const PREVIEW_LIMIT = 200;
  const EXAMPLE = "from events: count(where kind='kill' and assisted_flash)";

  let metrics = $state([]);
  let pins = $state([]);
  let matches = $state([]);
  let disabledPlugins = $state(new Set());
  let listError = $state('');

  // The editor form (fields + the dirty-check baseline) is view-local
  // state: it restores across navigation through the process-scoped
  // registry (viewstate.svelte.js — flat key; both travel together so
  // the unsaved-changes flag reads exactly as it did on leave). Saving,
  // previews, errors and the pin list stay transient / their own store.
  const bldSeed = seed('builder', { form: newForm(), baseline: '' });
  let form = $state(bldSeed.form);
  let baseline = $state(bldSeed.baseline);
  $effect(() => remember('builder', { form, baseline }));
  let saveError = $state('');
  let saving = $state(false);

  // Live expression check: debounced 400 ms → validateExpr.
  // state: idle | pending | valid | error
  let exprCheck = $state({ state: 'idle' });
  let exprSeq = 0;

  let scope = $state(''); // '' = whole library, else match id (string)
  let preview = $state(null);
  let previewAdhoc = $state(false);
  let previewError = $state('');
  let previewBusy = $state(false);

  function newForm() {
    return {
      id: 0,
      name: '',
      title: '',
      expr: '',
      groupBy: '',
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
      expr: f.expr,
      groupBy: f.groupBy,
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

  const groups = $derived.by(() => ({
    builtins: metrics.filter((m) => m.origin === 'builtin'),
    yours: metrics.filter((m) => m.origin === 'user'),
    plugins: metrics.filter((m) => m.origin === 'plugin'),
  }));

  const dirty = $derived(snapshot(form) !== baseline);
  const readOnly = $derived(form.origin !== 'user');

  // The list read (mount AND listError's Retry): metrics + matches land
  // together, so the error clears only when BOTH reads do — a retry can
  // never clear the message while a read is still failing. pins stay
  // OUTSIDE this function: they are read from localStorage once per
  // mount (a retry must not re-derive them over the session's toggles).
  async function loadLists() {
    // Fired first, exactly as the mount effect did: the plugin states
    // never wait on the metrics/match reads (nor on their failure).
    listPlugins()
      .then((states) => {
        disabledPlugins = new Set(
          (states || []).filter((s) => !s.enabled).map((s) => s.manifest.id),
        );
      })
      .catch(() => {});
    try {
      const [defs, list] = await Promise.all([
        listMetrics(),
        listMatches('', 'extracted_at', false),
      ]);
      metrics = defs || [];
      matches = list || [];
      listError = '';
    } catch (e) {
      listError = errText(e);
    }
  }

  $effect(() => {
    pins = readPins();
    loadLists();
  });

  async function refreshMetrics() {
    try {
      metrics = (await listMetrics()) || [];
      listError = '';
    } catch (e) {
      listError = errText(e);
    }
  }

  $effect(() => {
    const expr = form.expr;
    const gb = form.groupBy;
    const seq = ++exprSeq;
    if (!expr.trim()) {
      exprCheck = { state: 'idle' };
      return;
    }
    exprCheck = { state: 'pending' };
    const t = setTimeout(() => {
      validateExpr(expr, gb)
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
    form = {
      id: m.id,
      name: m.name,
      title: m.title || '',
      expr: m.expr,
      groupBy: m.groupBy || '',
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

  function togglePin(m) {
    pins = pins.includes(m.id) ? pins.filter((x) => x !== m.id) : [...pins, m.id];
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
      await refreshMetrics();
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
      // Builtin/plugin rows are immutable through SaveMetric (the store
      // rejects updates on them) — saving one forks a user copy (id 0).
      const payload = {
        id: readOnly ? 0 : form.id,
        name,
        title: form.title.trim() || name,
        expr: form.expr,
        groupBy: form.groupBy,
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
      baseline = snapshot(form);
      await refreshMetrics();
    } catch (e) {
      saveError = errText(e);
    } finally {
      saving = false;
    }
  }

  async function runPreview() {
    previewError = '';
    if (!form.expr.trim()) {
      preview = null;
      previewError = 'Enter an expression to preview.';
      return;
    }
    previewBusy = true;
    // Saved-definition previews ride the id (expr "") so the denominator
    // applies; edited/unsaved expressions are ad-hoc (no denominator).
    const adhoc = dirty || form.id === 0;
    previewAdhoc = adhoc;
    try {
      preview = await previewMetric(
        form.id,
        adhoc ? form.expr : '',
        adhoc ? form.groupBy : '',
        scope ? `match:${scope}` : '',
        PREVIEW_LIMIT,
      );
    } catch (e) {
      preview = null;
      previewError = errText(e);
    } finally {
      previewBusy = false;
    }
  }
</script>

{#snippet metricRow(m)}
  <div class="bld-row" class:active={form.id === m.id}>
    <button class="bld-row-main" onclick={() => editMetric(m)}>
      <span class="bld-row-title">
        {m.title || m.name}
        {#if m.doc}
          <span class="m5-ib" title={m.doc}><span class="codicon codicon-info"></span></span>
        {/if}
      </span>
      <span class="bld-row-sub">
        <span class="mono">{m.name}</span>
        <span class="chip">{m.groupBy || 'none'}</span>
        <span class="chip">{m.format || 'raw'}</span>
        {#if m.origin === 'plugin'}
          <span class="chip bld-plugin">plugin</span>
          {#if disabledPlugins.has(m.pluginId)}
            <span class="chip bld-disabled">disabled</span>
          {/if}
        {/if}
      </span>
    </button>
    <span class="bld-row-acts">
      <button
        class="btn small ghost"
        title="Preview this metric"
        aria-label="Preview {m.name}"
        onclick={() => {
          editMetric(m);
          runPreview();
        }}><span class="codicon codicon-play"></span></button
      >
      <button
        class="btn small ghost"
        class:bld-pin-on={pins.includes(m.id)}
        title={pins.includes(m.id) ? 'Unpin from scoreboard' : 'Pin as scoreboard column'}
        aria-label="Toggle pin for {m.name}"
        onclick={() => togglePin(m)}><span class="codicon codicon-pin"></span></button
      >
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
    <div class="spacer"></div>
    <button class="btn" onclick={() => nav('/reports')}>Open in Reports</button>
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
      {#if groups.builtins.length}
        <div class="bld-group">
          <h3>Builtins</h3>
          {#each groups.builtins as m (m.id)}
            {@render metricRow(m)}
          {/each}
        </div>
      {/if}
      {#if groups.yours.length}
        <div class="bld-group">
          <h3>Yours</h3>
          {#each groups.yours as m (m.id)}
            {@render metricRow(m)}
          {/each}
        </div>
      {/if}
      {#if groups.plugins.length}
        <div class="bld-group">
          <h3>Plugins</h3>
          {#each groups.plugins as m (m.id)}
            {@render metricRow(m)}
          {/each}
        </div>
      {/if}
      {#if metrics.length === 0 && !listError}
        <p class="muted" role="status">Loading…</p>
      {/if}
    </section>

    <div class="bld-right">
      <section class="panel">
        <div class="row-between">
          <h2>{form.id ? 'Edit metric' : 'New metric'}</h2>
          {#if readOnly}
            <span class="chip bld-readonly" title="Builtins and plugin metrics are immutable — saving stores a copy of this definition as your own metric."
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
            <label class="field-label" for="bld-group">GroupBy</label>
            <select id="bld-group" class="input" bind:value={form.groupBy}>
              <option value="">none</option>
              <option value="player">player</option>
              <option value="round">round</option>
              <option value="team">team</option>
              <option value="weapon">weapon</option>
              <option value="side">side</option>
              <option value="map">map</option>
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
              <option value="player_rounds">player_rounds</option>
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
              from &lt;table&gt;: count() | sum(col) | avg(col) | ratio(a, b) | stddev(col) |
              percentile(p, col) — tables: events, engagements, rounds, player_stats,
              player_round_stats, round_economy, clutches, utility_events, chat
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
          <button class="btn" onclick={newMetric}>New</button>
          <button
            class="btn"
            class:bld-pin-on={form.id > 0 && pins.includes(form.id)}
            disabled={form.id === 0}
            onclick={() => {
              const m = metrics.find((x) => x.id === form.id);
              if (m) togglePin(m);
            }}
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
          <div class="toolbar bld-scope-bar">
            <label class="bld-lab field-label" for="bld-scope">Scope</label>
            <!-- Match scope picker: no selection = the whole library
                 (placeholder), the clear button returns to it. -->
            <MatchPicker
              {matches}
              value={Number(scope) || 0}
              id="bld-scope"
              placeholder="Whole library"
              onselect={(mid) => (scope = mid ? String(mid) : '')}
            />
            {#if scope}
              <button
                class="btn small"
                title="Preview across the whole library"
                onclick={() => (scope = '')}>Whole library</button
              >
            {/if}
            <button class="btn primary" onclick={runPreview} disabled={previewBusy}>
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
            <p class="muted" role="status">No groups for this scope — empty result.</p>
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
                      <td class="num">{fmtMetric(r.value, form.format)}</td>
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
            Nothing previewed yet — pick a scope and press Preview (or <span class="codicon codicon-play"></span> on a metric).
          </p>
        {/if}
      </section>
    </div>
  </div>
</div>
