<script>
  import { whileCurrent } from '../../current.js';
  import ErrorBanner from '../../components/ErrorBanner.svelte';
  import { listReportTemplates, listPlayers, getRounds, listMetrics, getMetricComputeState, errText, getScoreboard, getMetricValuesForMatch, renderReport, getPlayerRefs } from '../../services.js';
  import { listedPlayers } from '../../players.js';
  import { seed, remember } from '../../viewstate.svelte.js';
  import PlayerPicker from '../../components/PlayerPicker.svelte';
  import * as S from '../../strings/index.js';
  import { findTemplate, reportFilename, targetReady, compositeText } from './shared.js';
  import { inSequence, composedSequence, rawItems, isRawId } from '../../metricorder.js';
  import { metricPresentation, metricStateTitle, liveMetricState } from '../../metricstate.js';
  import { liveMetrics } from '../../metricslive.svelte.js';
  import { downloadText } from '../../download.js';
  import TokenSelect from '../../components/TokenSelect.svelte';
  import StatusChip from '../../components/StatusChip.svelte';

  // The Reports builtin: the match
  // report's surface, composed from its panels. It owns the report's loads
  // and selection, and mounts two panels that share that model: the template
  // and target panel, and the stats appendix with the save button. The match
  // is the context's (read-only, ruling 34); the Match view mounts it with its
  // own id, and the standalone Reports route mounts it with the picked match.
  // The Reports Builder is a separate builder and does not use this.
  //
  // The selection (template, player, round, appendix stats) restores through
  // the view-state registry (viewstate.svelte.js, key 'reports'). The composed
  // document and busy/error stay transient and never restore.
    // (getScoreboard is read by the template panel's player picker, not here.)
    
  let { spectra, context, embedded = false } = $props();

  const repSeed = seed('reports', {
    tplId: '',
    steamId: '',
    roundNo: 1,
    // The appendix SELECTION, split by KIND: `stats` holds picked metric ids,
    // `rawStats` the recorded-value ids ('raw:<field>').
    stats: [],
    rawStats: [],
  });

  // The shared model the panels read and write. A panel never reads another
  // panel's state; it reads this object (passed as the `m` prop).
  const m = $state({
    templates: [],
    tplId: repSeed.tplId,
    tplError: '',
    players: [],
    steamId: repSeed.steamId,
    rounds: [],
    roundNo: repSeed.roundNo,
    metrics: [],
    metricsError: '',
    metricStates: new Map(),
    stats: repSeed.stats,
    rawStats: repSeed.rawStats,
    docError: '',
    rendering: false,
    // The statline seeds for the player picker (the templates block fills them).
    sbBySteam: {},
    seeds: new Map(),
  });

  // The match is the context's: the view follows it, and a context change
  // re-reads the rounds below.
  const matchId = $derived(context.matchId || 0);

  $effect(() => remember('reports', { tplId: m.tplId, steamId: m.steamId, roundNo: m.roundNo, stats: m.stats, rawStats: m.rawStats }));

  // The template list (mount AND tplError's Retry).
  async function loadTemplates() {
    try {
      const t = (await spectra.track(listReportTemplates())) || [];
      m.templates = t;
      if (t.length && !t.some((x) => x.id === m.tplId)) m.tplId = t[0].id;
      m.tplError = '';
    } catch (e) {
      m.tplError = errText(e);
    }
  }

  // The metrics and compute-state read (mount, metricsError's Retry and every
  // metric-done). Both land together, so the field and its readout settle
  // from one attempt.
  async function loadMetricsList() {
    try {
      const [rows, states] = await spectra.track(Promise.all([listMetrics(), getMetricComputeState()]));
      m.metrics = rows || [];
      m.metricStates = new Map((states || []).map((s) => [s.metricId, s]));
      m.metricsError = '';
    } catch (e) {
      m.metricsError = errText(e);
    }
  }
  m.actions = { loadTemplates, loadMetricsList };

  $effect(() => {
    loadTemplates();
    loadMetricsList();
    listPlayers('')
      .then((rows) => {
        m.players = listedPlayers(rows) || [];
        if (m.players.length && !m.players.some((p) => p.steamId === m.steamId)) {
          m.steamId = m.players[0].steamId;
        }
      })
      .catch(() => {
        /* the player picker stays hidden until it loads */
      });
  });

  // Completion is the refetch point: metric-done replaced the stored rows, so
  // the state map and the picked set reload, and the appendix re-reads.
  const sweep = liveMetrics({ onDone: () => loadMetricsList() });

  // The match's rounds: the round input's ceiling, and the clamp of a round
  // that the new match does not have.
  $effect(() => {
    const id = matchId;
    if (!id) return;
    getRounds(id)
      .then((rs) => {
        m.rounds = rs || [];
        const max = (rs || []).reduce((x, r) => Math.max(x, r.number), 0);
        if (m.roundNo > max) m.roundNo = Math.max(1, max);
      })
      .catch(() => (m.rounds = []));
  });


  // --- the templates and target block ---
  // The Reports template and target panel (builtin, composed by ReportsView):
  // the template grid, the target pickers (a player for a player template, a
  // round for a round template) and the one error slot for the template read
  // and the save. The match is the context's; the Match tab shows it as the
  // target, and the standalone route picks it above this panel.

  const tpl = $derived(findTemplate(m.templates, m.tplId));
  const maxRound = $derived(m.rounds.reduce((x, r) => Math.max(x, r.number), 0));

  // Player-scoped targets: the scoreboard of the match gives the picker each
  // candidate's side (identity only); every statline half is a stored seed row
  // (the match-scope seeds, fresh rows only), so a missing half is the dash.
  const STATLINE_SEEDS = ['kills', 'deaths', 'assists', 'adr', 'rounds_played'];

  $effect(() => whileCurrent((isCurrent) => {
    const id = matchId;
    const scope = tpl && tpl.scope;
    if (!id || scope !== 'player') {
      m.sbBySteam = {};
      m.seeds = new Map();
      return;
    }
    const catalog = new Map((m.metrics || []).filter((d) => d && d.name).map((d) => [d.name, d]));
    const matchDefs = STATLINE_SEEDS.map((n) => catalog.get(n)).filter((d) => d && (d.scope || 'match') === 'match');
    const out = new Map(matchDefs.map((d) => [d.name, { def: d, bySteam: new Map() }]));
    spectra.track(Promise.all([
      getScoreboard(id, '', false),
      matchDefs.length ? getMetricValuesForMatch(id, matchDefs.map((d) => d.id)) : Promise.resolve([]),
    ]))
      .then(([rows, values]) => {
        if (!isCurrent()) return;
        const sb = {};
        for (const r of listedPlayers(rows) || []) sb[r.steamId] = r;
        m.sbBySteam = sb;
        const nameById = new Map(matchDefs.map((d) => [d.id, d.name]));
        for (const v of values || []) {
          const name = nameById.get(v.metricId);
          const entry = name && out.get(name);
          if (entry) entry.bySteam.set(v.subjectKey, { value: v.value, format: entry.def.format });
        }
        m.seeds = out;
      })
      .catch(() => {
        if (isCurrent()) {
          m.sbBySteam = {};
          m.seeds = new Map();
        }
      });
  }));

  // --- the stats appendix ---
  // The Reports stats appendix (builtin, composed by ReportsView): the one
  // token field of picked stats (metrics and the recorded score), a readout
  // line for each pick, and the save button. A picked metric reads its STORED
  // rows for the match (a saved document is a snapshot the user saves again);
  // a picked metric with no fresh row shows its state, never a number.


  // The raw offer: the recorded-value counterparts of the fixed stats (Score
  // is the one; every other recorded stat offers through the metric catalog).
  const rawOffer = rawItems('match');

  // The sequence is the default (no saved order: the retired ordering pref is
  // not read, ruling 33), so the items are the default order.
  const matchMetrics = $derived(inSequence('match', m.metrics));
  const appendixItems = $derived.by(() => {
    const rawByLabel = new Map(rawOffer.map((r) => [r.label, r]));
    const out = [];
    for (const e of composedSequence('match', m.metrics)) {
      if (e.kind === 'fixed') {
        const raw = rawByLabel.get(e.label);
        if (raw) out.push(raw);
      } else {
        out.push(e.def);
      }
    }
    return out;
  });

  const itemText = (x) => (x.kind === 'raw' ? x.label : x.title || x.name);
  const picked = $derived(appendixItems.filter((it) => (isRawId(it.id) ? m.rawStats.includes(it.id) : m.stats.includes(it.id))));

  function addStat(x) {
    if (isRawId(x.id)) {
      if (!m.rawStats.includes(x.id)) m.rawStats = [...m.rawStats, x.id];
    } else if (!m.stats.includes(x.id)) {
      m.stats = [...m.stats, x.id];
    }
  }

  function removeStat(id) {
    if (isRawId(id)) m.rawStats = m.rawStats.filter((x) => x !== id);
    else m.stats = m.stats.filter((x) => x !== id);
  }

  // appendix: id -> { loading, rows?, error?, metric | raw, unitHasRows }. One
  // stored read for the whole picked set; a raw pick reads the scoreboard.
  let appendix = $state({});
  let appendixGen = 0;

  $effect(() => {
    const gen = ++appendixGen;
    const mid = matchId;
    sweep.reload; // metric-done: refetch the stored rows
    const rawSel = rawOffer.filter((r) => m.rawStats.includes(r.id));
    const defs = new Map(m.metrics.map((x) => [x.id, x]));
    const sel = m.stats.filter((id) => defs.has(id)).sort((a, b) => a - b);
    if (!sel.length && !rawSel.length) {
      appendix = {};
      return;
    }
    const pending = {};
    for (const id of sel) pending[id] = { loading: true, metric: defs.get(id) };
    for (const r of rawSel) pending[r.id] = { loading: true, raw: r };
    appendix = pending;
    spectra.track(Promise.all([
      sel.length ? getMetricValuesForMatch(mid, sel) : Promise.resolve([]),
      getPlayerRefs(mid),
      rawSel.length ? getScoreboard(mid, '', false) : Promise.resolve(null),
    ]))
      .then(([values, refs, board]) => {
        if (gen !== appendixGen) return;
        const bySteam = new Map((refs || []).map((r) => [r.steamId, r.name]));
        const byMetric = new Map();
        for (const v of values || []) {
          if (!byMetric.has(v.metricId)) byMetric.set(v.metricId, []);
          byMetric.get(v.metricId).push(v);
        }
        const next = {};
        for (const id of sel) {
          const def = defs.get(id);
          // Subject-aware labels: a player row keeps its roster name; a match
          // row's address is the match; a team row keys by its team; an
          // identity row's valueKey names the winner (an unresolvable key is the
          // dash, never a raw id).
          const subject = (def && def.subject) || 'player';
          const labelFor = (v) => {
            if (v.valueKey) return bySteam.get(v.valueKey) || '—';
            if (subject === 'match') return S.fill(S.reports.matchNumber, { id: mid });
            if (subject === 'team') return v.subjectKey;
            return bySteam.get(v.subjectKey) || v.subjectKey;
          };
          const valRows = (byMetric.get(id) || []).map((v) => ({ id: v.subjectKey, label: labelFor(v), value: v.value }));
          next[id] = { loading: false, rows: valRows, metric: def, unitHasRows: valRows.length > 0 };
        }
        // Raw rows: one per roster player (bots never listed), read off the field.
        for (const r of rawSel) {
          const rawRows = (listedPlayers(board || []) || []).map((p) => ({
            id: p.steamId,
            label: bySteam.get(p.steamId) || p.name || p.steamId,
            value: Number.isFinite(p[r.field]) ? p[r.field] : null,
          }));
          next[r.id] = { loading: false, rows: rawRows, raw: r, unitHasRows: rawRows.length > 0 };
        }
        appendix = next;
      })
      .catch((e) => {
        if (gen !== appendixGen) return;
        const next = {};
        for (const id of sel) next[id] = { loading: false, error: errText(e), metric: defs.get(id) };
        for (const r of rawSel) next[r.id] = { loading: false, error: errText(e), raw: r };
        appendix = next;
      });
  });

  // The state machine for one entry: the live progress feed wins, then value,
  // dash or chip. RAW entries answer their own kind first.
  function appendixPres(id) {
    const a = appendix[id];
    if (!a || a.loading || a.error) return null;
    if (a.raw) return { kind: 'raw', rows: a.rows || [] };
    const key = Number(id);
    const st = liveMetricState(sweep.progress, m.metricStates, key);
    const row = a.rows && a.rows.length ? a.rows[0] : null;
    return metricPresentation(st, row, a.unitHasRows);
  }

  function appendixChip(id) {
    const pres = appendixPres(id);
    if (!pres) return null;
    if (pres.kind === 'raw') return { kind: 'recorded' };
    if (pres.kind === 'value') return { kind: 'rows', n: appendix[id].rows.length };
    const state = pres.kind === 'nodata' ? 'no-data' : pres.state;
    const st = m.metricStates.get(id);
    return { kind: 'state', state, title: metricStateTitle(state, st && st.error) };
  }

  // The appendix entries the export walks, in the composed sequence's order.
  function appendixEntries() {
    const rank = new Map(appendixItems.map((it, i) => [String(it.id), i]));
    return Object.entries(appendix)
      .filter(([, a]) => !a.loading && !a.error && a.rows && (a.metric || a.raw))
      .sort(([a], [b]) => {
        const ra = rank.get(String(a));
        const rb = rank.get(String(b));
        if (ra === undefined && rb === undefined) return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
        if (ra === undefined) return 1;
        if (rb === undefined) return -1;
        return ra - rb;
      });
  }

  const entryTitle = (a) => (a.raw ? a.raw.label : a.metric.title || a.metric.name);
  const entryHasTable = (id) => ['value', 'raw'].includes((appendixPres(id) || {}).kind);

  // The per-entry line: fresh rows "per subject · N rows", a recorded value its
  // parallel line, any other state the honest "value not computed" line.
  function appendixLine(id, a) {
    if (a.raw) return S.fill(S.reports.rawRecorded, { n: a.rows.length });
    const pres = appendixPres(id);
    if (pres && pres.kind === 'value') {
      const subject = (a.metric && a.metric.subject) || 'player';
      const unit = subject === 'match' ? S.reports.unitPerMatch : subject === 'team' ? S.reports.unitPerTeam : S.reports.unitPerPlayer;
      return S.fill(S.reports.rowsMatch, { unit, n: a.rows.length, id: matchId });
    }
    const word = pres && pres.kind === 'chip' ? pres.state : 'no-data';
    return S.fill(S.reports.valueNotComputed, { word });
  }

  // The entries as the export and the readouts see them: the title, the
  // line, whether a table follows, and the rows.
  const exportEntries = $derived(
    appendixEntries().map(([id, a]) => ({
      title: entryTitle(a),
      line: appendixLine(id, a),
      hasTable: entryHasTable(id),
      rows: a.rows,
    })),
  );

  // Save (was "generate + preview"): render the Go template, compose the
  // appendix onto it, and land the document through the native save dialog.
  async function render() {
    m.rendering = true;
    m.docError = '';
    try {
      const text = await renderReport(
        m.tplId,
        matchId,
        tpl && tpl.scope === 'player' ? m.steamId : '',
        tpl && tpl.scope === 'round' ? m.roundNo : 0,
      );
      const html = (tpl.format || 'md') === 'html';
      await downloadText(
        reportFilename(tpl, { matchId, steamId: m.steamId, roundNo: m.roundNo }),
        html ? 'text/html' : 'text/markdown',
        compositeText(text || '', exportEntries, tpl.format),
      );
    } catch (e) {
      m.docError = errText(e);
    } finally {
      m.rendering = false;
    }
  }

  const canSave = $derived(targetReady(tpl, { matchId, steamId: m.steamId, roundNo: m.roundNo }));

</script>

<div>
  <h2>{S.reports.templateAndTarget}</h2>
  {#if m.docError}
    <!-- The one error slot for render + save (cancel stays silent). -->
    <ErrorBanner>{m.docError}</ErrorBanner>
  {/if}
  {#if m.tplError}
    <ErrorBanner>
      {m.tplError}
      <button class="btn small" onclick={() => m.actions.loadTemplates()}>{S.reports.retry}</button>
    </ErrorBanner>
  {/if}
  <div class="rep-tpl-grid">
    {#each m.templates as t (t.id)}
      <button
        class="rep-tpl"
        class:active={m.tplId === t.id}
        aria-pressed={m.tplId === t.id}
        onclick={() => {
          m.tplId = t.id;
          m.docError = '';
        }}
      >
        <span class="rep-tpl-title">{t.title}</span>
        <span class="rep-tpl-meta">
          <span class="chip">{t.scope}</span>
          <span class="chip">{t.format}</span>
          <span class="chip flag" title={S.reports.originTitle}>{t.origin || 'builtin'}</span>
        </span>
      </button>
    {:else}
      {#if !m.tplError}
        <!-- Gated on tplError: a failed template read is UNKNOWN, never "no templates". -->
        <p class="muted" role="status">{S.reports.noTemplates}</p>
      {/if}
    {/each}
  </div>
  {#if tpl}
    <div class="rep-targets">
      {#if embedded}
        <p class="muted" role="status">{S.reports.targetThisMatch}</p>
      {/if}
      {#if tpl.scope === 'player'}
        <div class="rep-field">
          <label class="field-label" for="rep-player">{S.reports.playerLabel}</label>
          <PlayerPicker
            players={m.players}
            stats={m.sbBySteam}
            seeds={m.seeds}
            states={m.metricStates}
            value={m.steamId}
            id="rep-player"
            onselect={(sid) => (m.steamId = sid)}
          />
        </div>
      {/if}
      {#if tpl.scope === 'round'}
        <div class="rep-field">
          <label class="field-label" for="rep-round">{S.reports.roundLabel}</label>
          <input class="input" id="rep-round" type="number" min="1" max={Math.max(1, maxRound)} bind:value={m.roundNo} />
          <span class="muted rep-hint">1..{Math.max(1, maxRound)}</span>
        </div>
      {/if}
    </div>
  {/if}
</div>
{#if m.metricsError}
  <ErrorBanner>
    {m.metricsError}
    <button class="btn small" onclick={() => m.actions.loadMetricsList()}>{S.reports.retry}</button>
  </ErrorBanner>
{/if}

<div>
{#if tpl}
  <h2>{S.reports.statsAppendix}</h2>
  <p class="muted">{S.reports.appendixHint}</p>
  {#if matchMetrics.length === 0 && !m.metricsError}
    <!-- A NOTE, not a gate: the recorded values are always on offer. -->
    <p class="muted" role="status">{m.metrics.length ? S.reports.noMatchScopedStats : S.reports.noCustomStats}</p>
  {/if}
  <div class="row-between">
    <TokenSelect
      id="rep-stats"
      items={appendixItems}
      text={itemText}
      tokens={picked.map((x) => ({ id: x.id, label: itemText(x) }))}
      placeholder={S.reports.metricHint}
      ariaLabel={S.reports.metricAria}
      removeAria={S.reports.removeStatAria}
      align="start"
      onselect={addStat}
      onremove={removeStat}
    />
    <button class="btn primary" disabled={m.rendering || !canSave} onclick={render}>
      {#if m.rendering}{S.reports.rendering}{:else}<span class="codicon codicon-save" aria-hidden="true"></span> {S.reports.generateReport}{/if}
    </button>
  </div>
  {#each picked as x (x.id)}
    <div class="rep-metric">
      <strong>{itemText(x)}</strong>
      {#if x.kind !== 'raw'}
        <span class="muted mono rep-metric-expr">{x.expr}</span>
      {/if}
      {#if appendix[x.id] && appendix[x.id].loading}
        <span class="muted">…</span>
      {:else if appendix[x.id] && appendix[x.id].error}
        <span class="error-text" title={appendix[x.id].error}>{S.reports.failedLabel}</span>
      {:else if x.kind === 'raw'}
        <span class="chip">{S.reports.recordedValue}</span>
      {:else}
        {@const chip = appendixChip(x.id)}
        {#if chip && chip.kind === 'rows'}
          <span class="chip">{chip.n}{S.reports.rowsSuffix}</span>
        {:else if chip}
          <StatusChip
            status={chip.state}
            title={chip.title}
            {...sweep.chip(x)}
          />
        {/if}
      {/if}
    </div>
  {/each}
{/if}
</div>

<style>
  .rep-metric {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 6px;
  }
</style>
