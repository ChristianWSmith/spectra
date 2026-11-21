<script>
  // The Reports stats appendix (builtin, composed by ReportsView): the one
  // token field of picked stats (metrics and the recorded score), a readout
  // line for each pick, and the save button. A picked metric reads its STORED
  // rows for the match (a saved document is a snapshot the user saves again);
  // a picked metric with no fresh row shows its state, never a number.
  import { renderReport, getMetricValuesForMatch, getPlayerRefs, getScoreboard, errText } from '../../services.js';
  import { inSequence, composedSequence, rawItems, isRawId } from '../../metricorder.js';
  import {
    metricPresentation,
    metricStateTitle,
    liveMetricState,
    metricProgressFrac,
    metricProgressStage,
  } from '../../metricstate.js';
  import { listedPlayers } from '../../players.js';
  import { downloadText } from '../../download.js';
  import TokenSelect from '../../components/TokenSelect.svelte';
  import StatusChip from '../../components/StatusChip.svelte';
  import * as S from '../../strings/index.js';
  import { findTemplate, reportFilename, targetReady, compositeText } from './shared.js';

  let { context, m } = $props();

  const matchId = $derived(context.matchId || 0);
  const tpl = $derived(findTemplate(m.templates, m.tplId));

  // The raw offer: the recorded-value counterparts of the fixed stats (Score
  // is the one; every other recorded stat offers through the metric catalog).
  const rawOffer = rawItems('match');

  // The sequence is the default (no saved order: the retired ordering pref is
  // not read, ruling 33), so the items are the default order.
  const matchMetrics = $derived(inSequence('match', null, m.metrics));
  const appendixItems = $derived.by(() => {
    const rawByLabel = new Map(rawOffer.map((r) => [r.label, r]));
    const out = [];
    for (const e of composedSequence('match', null, m.metrics)) {
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
    m.reload; // metric-done: refetch the stored rows
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
    Promise.all([
      sel.length ? getMetricValuesForMatch(mid, sel) : Promise.resolve([]),
      getPlayerRefs(mid),
      rawSel.length ? getScoreboard(mid, '', false) : Promise.resolve(null),
    ])
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
            if (subject === 'match') return `match #${mid}`;
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
    const st = liveMetricState(m.metricProgress, m.metricStates, key);
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
    if (a.raw) return `recorded value · per player · ${a.rows.length} players`;
    const pres = appendixPres(id);
    if (pres && pres.kind === 'value') {
      const subject = (a.metric && a.metric.subject) || 'player';
      const unit = subject === 'match' ? 'per match' : subject === 'team' ? 'per team' : 'per player';
      return `${unit} · ${a.rows.length} rows · match #${matchId}`;
    }
    const word = pres && pres.kind === 'chip' ? pres.state : 'no-data';
    return `value not computed — ${word}`;
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

{#if m.metricsError}
  <p class="error" role="alert">
    {m.metricsError}
    <button class="btn small" onclick={() => m.actions.loadMetricsList()}>{S.reports.retry}</button>
  </p>
{/if}

<section class="panel">
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
      {#if m.rendering}Generating…{:else}<span class="codicon codicon-save" aria-hidden="true"></span> {S.reports.generateReport}{/if}
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
            progress={metricProgressFrac(m.metricProgress, x.id)}
            stage={metricProgressStage(m.metricProgress, x.id)}
          />
        {/if}
      {/if}
    </div>
  {/each}
{/if}
</section>

<style>
  .rep-metric {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 6px;
  }
</style>
